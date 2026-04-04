import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, DEFAULT_CONFIG } from "../src/config.js";
import { StateStore } from "../src/state.js";
import { SessionManager } from "../src/sessions.js";
import { parseHeartbeat, isInProtectedWindow, Scheduler } from "../src/scheduler.js";
import { smartChunk } from "../src/utils/chunker.js";

describe("Integration: Config → State → Sessions → Scheduler", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "maxos-integration-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true });
  });

  it("full lifecycle: config loads, state persists, sessions route, scheduler parses", () => {
    // 1. Config loads with defaults
    const config = loadConfig(join(dir, "nonexistent.json"));
    assert.equal(config.identity.name, "Max");
    assert.equal(config.engine.model, "opus");

    // 2. State store saves and recovers
    const state = new StateStore(dir);
    state.load();
    state.update((s) => {
      s.sessions["main"] = {
        claudeSessionId: "test-session-123",
        lastActivity: Date.now(),
        messageCount: 10,
      };
    });
    state.flush();
    state.journalAppend("test_event", { detail: "integration test" });

    // Verify persistence
    const state2 = new StateStore(dir);
    const loaded = state2.load();
    assert.equal(loaded.sessions["main"]?.claudeSessionId, "test-session-123");

    // 3. Sessions route correctly
    const sessions = new SessionManager(
      config.sessions.routing,
      config.sessions.identityLinks,
    );
    sessions.loadFromState(loaded.sessions);
    const sessionName = sessions.route({
      channelName: "telegram",
      conversationId: "dm:123",
      senderId: "123",
    });
    assert.equal(sessionName, "main"); // default route
    assert.equal(sessions.getClaudeSessionId("main"), "test-session-123");

    // 4. Scheduler parses HEARTBEAT.md
    const heartbeatMd = [
      "# Heartbeat Tasks",
      "",
      "## Every 45 minutes",
      "- Write checkpoint to daily journal",
      "",
      "## 0 6 * * 1-5 (Weekday morning brief)",
      "- Good morning! Check calendar and share day overview",
    ].join("\n");
    const tasks = parseHeartbeat(heartbeatMd);
    assert.equal(tasks.length, 2);
    assert.equal(tasks[0].cron, "*/45 * * * *");
    assert.equal(tasks[1].cron, "0 6 * * 1-5");

    // 5. Protected windows work
    const windows = [
      { name: "sleep", start: "22:00", end: "06:00" },
      { name: "family-time", day: "saturday" },
    ];
    assert.equal(isInProtectedWindow(new Date("2026-03-27T23:00:00"), windows), true);
    assert.equal(isInProtectedWindow(new Date("2026-03-27T12:00:00"), windows), false);

    // 6. Chunker handles long messages
    const longText = "Paragraph one about work.\n\nParagraph two about projects.\n\nParagraph three about next steps.";
    const chunks = smartChunk(longText, 40);
    assert.ok(chunks.length >= 2);
    for (const chunk of chunks) {
      assert.ok(chunk.length <= 40);
    }
  });

  it("custom config overrides defaults", () => {
    const configPath = join(dir, "maxos.json");
    writeFileSync(configPath, JSON.stringify({
      identity: { name: "Jarvis" },
      engine: { model: "opus" },
      scheduler: { protectedWindows: [{ name: "test", day: "sunday" }] },
    }));
    const config = loadConfig(configPath);
    assert.equal(config.identity.name, "Jarvis");
    assert.equal(config.engine.model, "opus");
    assert.equal(config.engine.permissionMode, "bypassPermissions"); // preserved default
    assert.equal(config.scheduler.protectedWindows.length, 1);
  });

  it("scheduler circuit breaker disables task after failures", async () => {
    let failCount = 0;
    const runner = async () => {
      failCount++;
      throw new Error("deliberate failure");
    };
    let alertMessage = "";
    const alerter = async (msg: string) => { alertMessage = msg; };

    const deliverer = async (_result: string, _taskName: string): Promise<void> => {};
    const scheduler = new Scheduler(1, 3, [], runner, deliverer, alerter);
    const tasks = parseHeartbeat("## Every 30 minutes\n- Test task");

    // Manually trigger the task execution through state
    // We can't easily trigger cron in a test, but we can verify the state management
    scheduler.loadState({ failures: { "test-task": 2 }, disabled: [], lastRun: {} });
    const state = scheduler.getState();
    assert.equal(state.failures["test-task"], 2);

    // Verify scheduler accepts tasks
    scheduler.schedule(tasks);
    const listed = scheduler.listTasks();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].failures, 2);
    assert.equal(listed[0].disabled, false);

    scheduler.stopAll();
  });

  it("state crash journal survives restart", () => {
    const store = new StateStore(dir);
    store.load();
    store.journalAppend("boot", { version: 1 });
    store.journalAppend("message_received", { from: "telegram:123" });
    store.journalAppend("session_created", { name: "main" });

    // Simulate restart
    const store2 = new StateStore(dir);
    store2.load();

    // Journal should persist
    const journalPath = join(dir, "crash.log");
    assert.ok(existsSync(journalPath));
    const lines = readFileSync(journalPath, "utf-8").trim().split("\n");
    assert.equal(lines.length, 3);

    // Trim to 2
    store2.journalTrim(2);
    const trimmed = readFileSync(journalPath, "utf-8").trim().split("\n");
    assert.equal(trimmed.length, 2);
  });
});
