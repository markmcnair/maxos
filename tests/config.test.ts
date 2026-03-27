import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, resolveEnvVars, DEFAULT_CONFIG } from "../src/config.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("resolveEnvVars", () => {
  it("replaces ${VAR} with environment value", () => {
    process.env.TEST_TOKEN = "abc123";
    const result = resolveEnvVars("token: ${TEST_TOKEN}");
    assert.equal(result, "token: abc123");
    delete process.env.TEST_TOKEN;
  });

  it("leaves unmatched vars as empty string", () => {
    const result = resolveEnvVars("${NONEXISTENT_VAR_XYZ}");
    assert.equal(result, "");
  });
});

describe("loadConfig", () => {
  it("returns defaults when no config file exists", () => {
    const config = loadConfig("/nonexistent/path/maxos.json");
    assert.equal(config.engine.model, DEFAULT_CONFIG.engine.model);
    assert.equal(config.reliability.stateSnapshotInterval, 30000);
  });

  it("merges user config over defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "maxos-test-"));
    const configPath = join(dir, "maxos.json");
    writeFileSync(configPath, JSON.stringify({
      identity: { name: "Jarvis", timezone: "America/New_York" },
      engine: { model: "opus" }
    }));
    const config = loadConfig(configPath);
    assert.equal(config.identity.name, "Jarvis");
    assert.equal(config.engine.model, "opus");
    assert.equal(config.engine.permissionMode, "bypassPermissions"); // default preserved
    rmSync(dir, { recursive: true });
  });

  it("resolves env vars in string values", () => {
    process.env.TEST_BOT_TOKEN = "mytoken";
    const dir = mkdtempSync(join(tmpdir(), "maxos-test-"));
    const configPath = join(dir, "maxos.json");
    writeFileSync(configPath, JSON.stringify({
      channels: { telegram: { botToken: "${TEST_BOT_TOKEN}" } }
    }));
    const config = loadConfig(configPath);
    assert.equal(config.channels.telegram?.botToken, "mytoken");
    delete process.env.TEST_BOT_TOKEN;
    rmSync(dir, { recursive: true });
  });
});
