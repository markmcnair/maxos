import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildHeartbeatDoc } from "../src/heartbeat-doc.js";
import type { HeartbeatTask } from "../src/scheduler.js";

describe("buildHeartbeatDoc", () => {
  const fixedNow = new Date("2026-04-28T20:00:00Z"); // 3pm CT

  const tasks: HeartbeatTask[] = [
    {
      name: "run-the-morning-brief-read-tasksmorningbriefmd-and-execute-every-step",
      cron: "0 6 * * 0-5",
      prompt: "Run the morning brief: read tasks/morning-brief.md and execute every step",
      silent: false,
    },
    {
      name: "cd-usersmaxprojectsmaxos-node-distsrcclosurewatcherjs-hours-03",
      cron: "*/15 * * * *",
      prompt: "cd /Users/Max/Projects/maxos && node dist/src/closure-watcher.js --hours 0.3",
      silent: true,
      script: true,
      timeout: 120_000,
    },
    {
      name: "cd-usersmaxprojectsmaxos-node-distsrcgoogletasksreconcilerjs",
      cron: "7-59/15 * * * *",
      prompt: "cd /Users/Max/Projects/maxos && node dist/src/google-tasks-reconciler.js",
      silent: true,
      script: true,
      timeout: 120_000,
    },
  ];

  it("includes a header with task count", () => {
    const doc = buildHeartbeatDoc(tasks, fixedNow);
    assert.match(doc, /^# MaxOS scheduled tasks/m);
    assert.match(doc, /\*\*3 tasks scheduled\.\*\*/);
  });

  it("uses prettyTaskName for slug-style names", () => {
    const doc = buildHeartbeatDoc(tasks, fixedNow);
    assert.match(doc, /\*\*morning-brief\*\*/);
    assert.match(doc, /\*\*closure-watcher\*\*/);
    assert.match(doc, /\*\*google-tasks-reconciler\*\*/);
  });

  it("renders type as LLM one-shot or shell script", () => {
    const doc = buildHeartbeatDoc(tasks, fixedNow);
    assert.match(doc, /LLM one-shot/);
    assert.match(doc, /script, silent/);
  });

  it("includes a Cron column with the literal expression", () => {
    const doc = buildHeartbeatDoc(tasks, fixedNow);
    assert.match(doc, /`0 6 \* \* 0-5`/);
    assert.match(doc, /`\*\/15 \* \* \* \*`/);
    assert.match(doc, /`7-59\/15 \* \* \* \*`/);
  });

  it("renders task prompts under task-prompts section", () => {
    const doc = buildHeartbeatDoc(tasks, fixedNow);
    assert.match(doc, /## Task prompts/);
    assert.match(doc, /Run the morning brief/);
  });

  it("trims long prompts on word boundary", () => {
    const longTask: HeartbeatTask[] = [{
      name: "x",
      cron: "0 0 * * *",
      prompt: "This is a very long prompt that goes on and on and on and contains many many words so we can verify the truncation logic actually trims it sensibly and adds an ellipsis at the end",
      silent: false,
    }];
    const doc = buildHeartbeatDoc(longTask, fixedNow);
    assert.match(doc, /…/);
  });

  it("handles empty task list gracefully", () => {
    const doc = buildHeartbeatDoc([], fixedNow);
    assert.match(doc, /\*\*0 tasks scheduled\.\*\*/);
  });
});
