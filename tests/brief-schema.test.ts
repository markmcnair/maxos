import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  validateAgainstSchema,
  schemaForTask,
  logSchemaViolation,
  isSchemaFailure,
  MORNING_BRIEF_SCHEMA,
  SHUTDOWN_DEBRIEF_SCHEMA,
} from "../src/brief-schema.js";

const VALID_BRIEF = `☀️ Morning Brief — Wednesday, April 29

🪨 Top priority: Glenn Crockett MNDA prep
Rock — needs to ship today.
⏰ 9-11am at Level Ground

📈 Since yesterday: +1 loop, calendar quieter (3 vs 6 events).

👻 Ghosted: Nobody waiting on you.

📍 First presence: 7:00am Workout
- 7:00am Workout
- 11:00am Learn with the bigs
- 4:30pm Shutdown Debrief

🚨 Overnight: Clean.

— END BRIEF —`;

const VALID_DEBRIEF = `🌅 Shutdown Debrief — Wednesday, April 29

✅ Wins
- KR board meeting closed.

👻 Ghosted
- Nobody waiting on you.

🔄 Open Loops (captured — let them go)
- Joey Cook reply.

🎯 Top 3 for Tomorrow
1. Mike (not Salem) MNDA — context
2. Foo — context
3. Bar — context

📅 Tomorrow
- 7:00am Workout

🧠 Everything's captured. Brain off. Family on.`;

describe("validateAgainstSchema", () => {
  it("returns no missing for a valid morning brief", () => {
    const v = validateAgainstSchema(VALID_BRIEF, MORNING_BRIEF_SCHEMA, "morning-brief");
    assert.deepEqual(v.missingRequired, []);
    assert.deepEqual(v.missingOptional, []);
  });

  it("flags missing required sections", () => {
    const truncated = VALID_BRIEF.replace("— END BRIEF —", "");
    const v = validateAgainstSchema(truncated, MORNING_BRIEF_SCHEMA, "morning-brief");
    assert.deepEqual(v.missingRequired, ["end-sentinel"]);
  });

  it("flags multiple missing sections", () => {
    const broken = "☀️ Morning Brief\n\nJust a header, nothing else.";
    const v = validateAgainstSchema(broken, MORNING_BRIEF_SCHEMA, "morning-brief");
    assert.ok(v.missingRequired.length >= 5);
    assert.ok(v.missingRequired.includes("top-priority"));
    assert.ok(v.missingRequired.includes("ghosted"));
    assert.ok(v.missingRequired.includes("end-sentinel"));
  });

  it("treats since-yesterday as optional (Sundays skip it)", () => {
    const noSinceYesterday = VALID_BRIEF.replace(/📈[^\n]+\n\n/, "");
    const v = validateAgainstSchema(noSinceYesterday, MORNING_BRIEF_SCHEMA, "morning-brief");
    assert.deepEqual(v.missingRequired, []);
    assert.deepEqual(v.missingOptional, ["since-yesterday"]);
  });

  it("validates shutdown-debrief schema", () => {
    const v = validateAgainstSchema(VALID_DEBRIEF, SHUTDOWN_DEBRIEF_SCHEMA, "shutdown-debrief");
    assert.deepEqual(v.missingRequired, []);
  });

  it("regression: catches a brief that's missing the Ghosted section", () => {
    const noGhosted = VALID_BRIEF.replace(/👻 Ghosted[\s\S]*?\n\n/, "");
    const v = validateAgainstSchema(noGhosted, MORNING_BRIEF_SCHEMA, "morning-brief");
    assert.ok(v.missingRequired.includes("ghosted"));
  });
});

describe("schemaForTask", () => {
  it("recognizes morning-brief variants", () => {
    assert.ok(schemaForTask("run-the-morning-brief-read-tasks") === MORNING_BRIEF_SCHEMA);
    assert.ok(schemaForTask("morningbrief") === MORNING_BRIEF_SCHEMA);
  });

  it("recognizes shutdown-debrief variants", () => {
    assert.ok(schemaForTask("run-shutdown-debrief-read-tasks") === SHUTDOWN_DEBRIEF_SCHEMA);
  });

  it("returns null for tasks without a schema", () => {
    assert.equal(schemaForTask("notion-sync"), null);
    assert.equal(schemaForTask("granola-sync"), null);
    assert.equal(schemaForTask("closure-watcher"), null);
  });
});

describe("isSchemaFailure", () => {
  it("returns true when required sections missing", () => {
    assert.equal(
      isSchemaFailure({ task: "morning-brief", missingRequired: ["end-sentinel"], missingOptional: [], totalChars: 500 }),
      true,
    );
  });

  it("returns false when only optional sections missing", () => {
    assert.equal(
      isSchemaFailure({ task: "morning-brief", missingRequired: [], missingOptional: ["since-yesterday"], totalChars: 500 }),
      false,
    );
  });
});

describe("logSchemaViolation", () => {
  let tmp: string;
  let path: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "schema-vio-"));
    path = join(tmp, "brief-issues.jsonl");
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("appends a JSONL entry when there are missing sections", () => {
    logSchemaViolation(
      path,
      { task: "morning-brief", missingRequired: ["end-sentinel"], missingOptional: [], totalChars: 500 },
      1714400000000,
    );
    const lines = readFileSync(path, "utf-8").trim().split("\n");
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.task, "morning-brief");
    assert.deepEqual(parsed.missingRequired, ["end-sentinel"]);
  });

  it("skips writing when there's nothing to flag", () => {
    logSchemaViolation(
      path,
      { task: "morning-brief", missingRequired: [], missingOptional: [], totalChars: 500 },
    );
    assert.ok(!existsSync(path));
  });

  it("never throws on bad path", () => {
    assert.doesNotThrow(() => {
      logSchemaViolation(
        "/nonexistent/dir/file.jsonl",
        { task: "x", missingRequired: ["a"], missingOptional: [], totalChars: 0 },
      );
    });
  });
});
