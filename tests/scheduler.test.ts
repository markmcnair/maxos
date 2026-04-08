import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseHeartbeat, isInProtectedWindow } from "../src/scheduler.js";

describe("parseHeartbeat", () => {
  it("parses 'Every N minutes' format", () => {
    const md = "## Every 30 minutes\n- Check for new messages";
    const tasks = parseHeartbeat(md);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].name, "check-for-new-messages");
    assert.equal(tasks[0].cron, "*/30 * * * *");
    assert.equal(tasks[0].prompt, "Check for new messages");
  });

  it("parses 'Every N hours' format", () => {
    const md = "## Every 2 hours\n- Run health check";
    const tasks = parseHeartbeat(md);
    assert.equal(tasks[0].cron, "0 */2 * * *");
  });

  it("parses raw cron expression", () => {
    const md = "## 0 6 * * 0-5 (Morning brief)\n- Run morning brief: read tasks/morning-brief.md";
    const tasks = parseHeartbeat(md);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].cron, "0 6 * * 0-5");
    assert.equal(tasks[0].prompt, "Run morning brief: read tasks/morning-brief.md");
  });

  it("parses multiple tasks", () => {
    const md = [
      "# Heartbeat Tasks",
      "",
      "## Every 30 minutes",
      "- Task one",
      "",
      "## 0 9 * * 1 (Monday check)",
      "- Task two",
    ].join("\n");
    const tasks = parseHeartbeat(md);
    assert.equal(tasks.length, 2);
  });

  it("handles multi-line bullet points under one heading", () => {
    const md = "## Every 45 minutes\n- First task\n- Second task";
    const tasks = parseHeartbeat(md);
    assert.equal(tasks.length, 2);
  });

  it("parses [silent] tag on headings", () => {
    const md = "## Every 45 minutes [silent]\n- Write a checkpoint to today's journal";
    const tasks = parseHeartbeat(md);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].cron, "*/45 * * * *");
    assert.equal(tasks[0].silent, true);
  });

  it("non-silent tasks have silent as false", () => {
    const md = "## 0 6 * * 0-5 (Morning brief)\n- Run morning brief";
    const tasks = parseHeartbeat(md);
    assert.equal(tasks[0].silent, false);
  });

  it("parses [timeout:Nm] tag on headings", () => {
    const md = "## 55 15 * * 0-5 [timeout:20m]\n- Run email triage";
    const tasks = parseHeartbeat(md);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].cron, "55 15 * * 0-5");
    assert.equal(tasks[0].timeout, 1_200_000);
  });

  it("parses both [silent] and [timeout:Nm] tags together", () => {
    const md = "## Every 45 minutes [silent] [timeout:5m]\n- Quick checkpoint";
    const tasks = parseHeartbeat(md);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].silent, true);
    assert.equal(tasks[0].timeout, 300_000);
    assert.equal(tasks[0].cron, "*/45 * * * *");
  });

  it("tasks without [timeout:Nm] have undefined timeout", () => {
    const md = "## 0 6 * * 0-5\n- Run morning brief";
    const tasks = parseHeartbeat(md);
    assert.equal(tasks[0].timeout, undefined);
  });
});

describe("isInProtectedWindow", () => {
  it("detects time within start-end range", () => {
    const windows = [{ name: "sleep", start: "22:00", end: "06:00" }];
    const date = new Date("2026-03-27T23:00:00");
    assert.equal(isInProtectedWindow(date, windows), true);
  });

  it("detects time outside start-end range", () => {
    const windows = [{ name: "sleep", start: "22:00", end: "06:00" }];
    const date = new Date("2026-03-27T12:00:00");
    assert.equal(isInProtectedWindow(date, windows), false);
  });

  it("detects day-based window", () => {
    const windows = [{ name: "family-time", day: "saturday" }];
    const date = new Date("2026-03-28T12:00:00");
    assert.equal(isInProtectedWindow(date, windows), true);
  });

  it("detects day+time window", () => {
    const windows = [{ name: "focus-block", day: "thursday", start: "17:30" }];
    const date = new Date("2026-03-26T18:00:00");
    assert.equal(isInProtectedWindow(date, windows), true);
  });

  it("returns false when no windows match", () => {
    const windows = [{ name: "family-time", day: "saturday" }];
    const date = new Date("2026-03-25T12:00:00");
    assert.equal(isInProtectedWindow(date, windows), false);
  });
});
