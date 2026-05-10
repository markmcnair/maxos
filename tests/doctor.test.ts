import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseLoglineForAuthFailure,
  findRecentAuthFailures,
  checkClaudeAuthFromRecentFailures,
  parseClaudeKeychainExpiry,
  classifyKeychainExpiry,
} from "../src/doctor.js";

describe("parseLoglineForAuthFailure", () => {
  it("matches a task_failed line whose error contains '401'", () => {
    // The literal failure mode from 2026-05-04: claude CLI returned 401
    // when the subscription rate-limited; the daemon dutifully logged it
    // 50+ times across the day. Pattern match is loose so we catch
    // variants like "API Error: 401", "status 401", etc.
    const line = JSON.stringify({
      level: "error",
      message: "scheduler:task_failed",
      task: "morning-brief",
      failures: 1,
      error: 'oneShot exited with code 1: Failed to authenticate. API Error: 401 {"type":"error"}',
      timestamp: "2026-05-04T11:00:07.355Z",
    });
    const r = parseLoglineForAuthFailure(line);
    assert.equal(r?.task, "morning-brief");
    assert.match(r?.errorSnippet ?? "", /401/);
    assert.equal(typeof r?.timestampMs, "number");
  });

  it("matches the word 'authentication' even without 401", () => {
    const line = JSON.stringify({
      level: "error",
      message: "scheduler:task_failed",
      task: "morning-brew",
      failures: 1,
      error: "oneShot exited with code 1: Authentication credentials missing.",
      timestamp: "2026-05-04T12:00:00.000Z",
    });
    assert.ok(parseLoglineForAuthFailure(line));
  });

  it("matches the post-logout 'Not logged in' message (Round R+ regression)", () => {
    // Round R discovered: after `claude auth logout`, the CLI exits 1 with
    // stdout="Not logged in · Please run /login". My AUTH_PATTERN didn't
    // match — meaning the doctor wouldn't surface this state. Now it does.
    const line = JSON.stringify({
      level: "error",
      message: "scheduler:task_failed",
      task: "morning-brief",
      failures: 1,
      error: "oneShot exited with code 1: Not logged in · Please run /login",
      timestamp: "2026-05-05T12:00:00.000Z",
    });
    assert.ok(parseLoglineForAuthFailure(line));
  });

  it("returns null for task_failed lines that aren't auth-related", () => {
    const line = JSON.stringify({
      level: "error",
      message: "scheduler:task_failed",
      task: "x",
      failures: 1,
      error: "oneShot exited with code 1: SyntaxError: Unexpected token",
      timestamp: "2026-05-04T11:00:07.355Z",
    });
    assert.equal(parseLoglineForAuthFailure(line), null);
  });

  it("returns null for non-scheduler errors", () => {
    const line = JSON.stringify({
      level: "info",
      message: "gateway:oneshot",
      task: "x",
      timestamp: "2026-05-04T11:00:07.355Z",
    });
    assert.equal(parseLoglineForAuthFailure(line), null);
  });

  it("returns null for malformed lines", () => {
    assert.equal(parseLoglineForAuthFailure(""), null);
    assert.equal(parseLoglineForAuthFailure("not json"), null);
    assert.equal(parseLoglineForAuthFailure("{bad json"), null);
  });
});

describe("findRecentAuthFailures", () => {
  it("counts only auth failures within the lookback window", () => {
    const now = Date.parse("2026-05-04T22:00:00.000Z");
    const cutoff = now - 24 * 3600_000;
    const content = [
      // Old (outside window) — ignored
      JSON.stringify({
        message: "scheduler:task_failed",
        task: "old",
        failures: 1,
        error: "API Error: 401",
        timestamp: "2026-05-02T11:00:00.000Z",
      }),
      // In-window auth failure — counted
      JSON.stringify({
        message: "scheduler:task_failed",
        task: "morning-brief",
        failures: 1,
        error: "API Error: 401",
        timestamp: "2026-05-04T11:00:00.000Z",
      }),
      // In-window non-auth failure — ignored
      JSON.stringify({
        message: "scheduler:task_failed",
        task: "x",
        failures: 1,
        error: "SyntaxError",
        timestamp: "2026-05-04T12:00:00.000Z",
      }),
      // Two more in-window auth failures, different tasks
      JSON.stringify({
        message: "scheduler:task_failed",
        task: "morning-brew",
        failures: 1,
        error: "Failed to authenticate",
        timestamp: "2026-05-04T11:15:00.000Z",
      }),
      JSON.stringify({
        message: "scheduler:task_failed",
        task: "shutdown-debrief",
        failures: 1,
        error: "401 invalid credentials",
        timestamp: "2026-05-04T21:35:00.000Z",
      }),
    ].join("\n");

    const r = findRecentAuthFailures(content, cutoff);
    assert.equal(r.count, 3);
    assert.deepEqual(r.tasks.sort(), ["morning-brew", "morning-brief", "shutdown-debrief"]);
    assert.match(r.lastErrorSnippet, /credentials/i);
  });

  it("returns empty result for content with no auth failures", () => {
    const r = findRecentAuthFailures("", Date.now() - 86400_000);
    assert.equal(r.count, 0);
    assert.deepEqual(r.tasks, []);
  });
});

describe("checkClaudeAuthFromRecentFailures", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "doctor-auth-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("returns PASS when no daemon.log exists yet", async () => {
    const r = await checkClaudeAuthFromRecentFailures(home);
    assert.equal(r.status, "PASS");
    assert.match(r.detail, /no daemon\.log/i);
  });

  it("returns PASS when no auth failures in the window", async () => {
    writeFileSync(
      join(home, "daemon.log"),
      JSON.stringify({
        message: "scheduler:task_failed",
        task: "x",
        failures: 1,
        error: "SyntaxError unrelated",
        timestamp: new Date().toISOString(),
      }) + "\n",
    );
    const r = await checkClaudeAuthFromRecentFailures(home);
    assert.equal(r.status, "PASS");
  });

  it("returns FAIL when post-logout 'Not logged in' messages appear", async () => {
    writeFileSync(
      join(home, "daemon.log"),
      JSON.stringify({
        message: "scheduler:task_failed",
        task: "morning-brief",
        failures: 1,
        error: "oneShot exited with code 1: Not logged in · Please run /login",
        timestamp: new Date().toISOString(),
      }) + "\n",
    );
    const r = await checkClaudeAuthFromRecentFailures(home);
    assert.equal(r.status, "FAIL");
  });

  it("returns FAIL when recent auth failures are present", async () => {
    writeFileSync(
      join(home, "daemon.log"),
      [
        JSON.stringify({
          message: "scheduler:task_failed",
          task: "morning-brief",
          failures: 1,
          error: "API Error: 401 invalid credentials",
          timestamp: new Date().toISOString(),
        }),
        JSON.stringify({
          message: "scheduler:task_failed",
          task: "morning-brew",
          failures: 1,
          error: "401 unauthorized",
          timestamp: new Date().toISOString(),
        }),
      ].join("\n") + "\n",
    );
    const r = await checkClaudeAuthFromRecentFailures(home);
    assert.equal(r.status, "FAIL");
    assert.match(r.detail, /2/);  // count
    assert.match(r.detail, /(re-?auth|claude.*login|tokens)/i);  // actionable
  });

  it("returns PASS when an LLM task SUCCEEDED after the most recent auth failure (recovery signal)", async () => {
    // After Mark re-auths, the next scheduled LLM task will succeed and
    // emit `gateway:deliver_task`. Treat that as proof the auth is now
    // working, even if older failures are still in the 24h window.
    const oldFailure = new Date(Date.now() - 12 * 3600_000).toISOString();
    const recentSuccess = new Date(Date.now() - 5 * 60_000).toISOString();
    writeFileSync(
      join(home, "daemon.log"),
      [
        JSON.stringify({
          message: "scheduler:task_failed",
          task: "run-the-morning-brief-read-tasksmorningbriefmd-and-execute-every-step",
          failures: 1,
          error: "API Error: 401 invalid credentials",
          timestamp: oldFailure,
        }),
        JSON.stringify({
          message: "gateway:deliver_task",
          task: "run-some-llm-task",  // run- prefix → LLM
          length: 200,
          timestamp: recentSuccess,
        }),
      ].join("\n") + "\n",
    );
    const r = await checkClaudeAuthFromRecentFailures(home);
    assert.equal(r.status, "PASS");
    assert.match(r.detail, /(succeed|recovered|since)/i);
  });

  it("treats scheduler:silent_complete (LLM, non-zero result) as recovery signal", async () => {
    // Silent tasks (notion-sync, journal-checkpoint) don't emit
    // gateway:deliver_task. Their success path is silent_complete with
    // resultLength > 0. Without this case, the recovery signal misses
    // every silent LLM success.
    const oldFailure = new Date(Date.now() - 12 * 3600_000).toISOString();
    const recentSilentSuccess = new Date(Date.now() - 5 * 60_000).toISOString();
    writeFileSync(
      join(home, "daemon.log"),
      [
        JSON.stringify({
          message: "scheduler:task_failed",
          task: "if-there-has-been-...",
          failures: 1,
          error: "API Error: 401",
          timestamp: oldFailure,
        }),
        JSON.stringify({
          message: "scheduler:silent_complete",
          task: "run-notion-sync-...",  // run- prefix
          resultLength: 245,
          timestamp: recentSilentSuccess,
        }),
      ].join("\n") + "\n",
    );
    const r = await checkClaudeAuthFromRecentFailures(home);
    assert.equal(r.status, "PASS");
  });

  it("ignores silent_complete with resultLength=0 (not a real success)", async () => {
    const oldFailure = new Date(Date.now() - 12 * 3600_000).toISOString();
    const recentEmpty = new Date(Date.now() - 5 * 60_000).toISOString();
    writeFileSync(
      join(home, "daemon.log"),
      [
        JSON.stringify({
          message: "scheduler:task_failed",
          task: "run-x",
          failures: 1,
          error: "API Error: 401",
          timestamp: oldFailure,
        }),
        JSON.stringify({
          message: "scheduler:silent_complete",
          task: "run-x",
          resultLength: 0,  // empty result — not real success
          timestamp: recentEmpty,
        }),
      ].join("\n") + "\n",
    );
    const r = await checkClaudeAuthFromRecentFailures(home);
    assert.equal(r.status, "FAIL");
  });

  it("does NOT treat script-task delivery as recovery signal", async () => {
    // Critical-task-watchdog and maxos-digest emit gateway:deliver_task
    // but they're scripts. They don't prove LLM auth works.
    const oldFailure = new Date(Date.now() - 12 * 3600_000).toISOString();
    const recentScriptSuccess = new Date(Date.now() - 5 * 60_000).toISOString();
    writeFileSync(
      join(home, "daemon.log"),
      [
        JSON.stringify({
          message: "scheduler:task_failed",
          task: "run-the-morning-brief-...",
          failures: 1,
          error: "API Error: 401 invalid credentials",
          timestamp: oldFailure,
        }),
        JSON.stringify({
          message: "gateway:deliver_task",
          task: "critical-task-watchdog",  // SCRIPT, not LLM
          length: 100,
          timestamp: recentScriptSuccess,
        }),
        JSON.stringify({
          message: "gateway:deliver_task",
          task: "maxos-digest",  // SCRIPT
          length: 100,
          timestamp: recentScriptSuccess,
        }),
      ].join("\n") + "\n",
    );
    const r = await checkClaudeAuthFromRecentFailures(home);
    assert.equal(r.status, "FAIL");  // still FAIL because no LLM success
  });
});

describe("parseClaudeKeychainExpiry", () => {
  it("extracts expiresAt + hasRefreshToken from the keychain JSON payload", () => {
    const raw = '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-X","refreshToken":"sk-ant-ort01-Y","expiresAt":1777891802908,"scopes":["user:profile"],"subscriptionType":"max"}}';
    const r = parseClaudeKeychainExpiry(raw);
    assert.equal(r?.expiresAtMs, 1777891802908);
    assert.equal(r?.subscriptionType, "max");
    assert.equal(r?.hasRefreshToken, true);
  });

  it("flags hasRefreshToken=false when refreshToken is missing/empty", () => {
    const raw = '{"claudeAiOauth":{"accessToken":"sk-ant-X","expiresAt":123}}';
    const r = parseClaudeKeychainExpiry(raw);
    assert.equal(r?.hasRefreshToken, false);
  });

  it("returns null for empty / non-JSON input", () => {
    assert.equal(parseClaudeKeychainExpiry(""), null);
    assert.equal(parseClaudeKeychainExpiry("garbage"), null);
  });

  it("returns null when payload shape is wrong", () => {
    assert.equal(parseClaudeKeychainExpiry('{"other":"shape"}'), null);
    assert.equal(parseClaudeKeychainExpiry('{"claudeAiOauth":{}}'), null);
    assert.equal(parseClaudeKeychainExpiry('{"claudeAiOauth":{"expiresAt":"not a number"}}'), null);
  });
});

describe("classifyKeychainExpiry", () => {
  const ms_per_hour = 3600_000;
  const ms_per_day = 86400_000;

  // Claude Code uses short-lived access tokens (~8h) with a long-lived
  // refresh token. The CLI auto-refreshes — so an "expired" access token
  // with a present refresh token isn't a user-actionable problem. The
  // classifier needs to factor in `hasRefreshToken` to avoid false alarms.

  it("returns PASS when refresh token is present, regardless of access expiry", () => {
    const now = Date.now();
    // Even an "expired 8h ago" access token is fine if refresh works
    const r = classifyKeychainExpiry(
      { expiresAtMs: now - 8 * ms_per_hour, hasRefreshToken: true },
      now,
    );
    assert.equal(r.status, "PASS");
  });

  it("returns FAIL when no refresh token AND access token is expired", () => {
    const now = Date.now();
    const r = classifyKeychainExpiry(
      { expiresAtMs: now - 1000, hasRefreshToken: false },
      now,
    );
    assert.equal(r.status, "FAIL");
    assert.match(r.detail, /expired/i);
  });

  it("returns WARN when no refresh token AND access token expires within 1 day", () => {
    const now = Date.parse("2026-05-05T12:00:00Z");
    const r = classifyKeychainExpiry(
      { expiresAtMs: now + 6 * ms_per_hour, hasRefreshToken: false },
      now,
    );
    assert.equal(r.status, "WARN");
    assert.match(r.detail, /hour/i);
  });

  it("returns PASS when no refresh token but access has plenty of time", () => {
    const now = Date.now();
    const r = classifyKeychainExpiry(
      { expiresAtMs: now + 60 * ms_per_day, hasRefreshToken: false },
      now,
    );
    assert.equal(r.status, "PASS");
  });

  it("returns PASS when there's no keychain data (post-logout / fresh install)", () => {
    const r = classifyKeychainExpiry(null, Date.now());
    assert.equal(r.status, "PASS");
    assert.match(r.detail, /not logged in|no keychain/i);
  });
});
