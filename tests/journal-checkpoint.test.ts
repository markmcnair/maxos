import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  twelveTo24,
  twentyFourTo12,
  parseJournalHeaders,
  parseClosures,
  lastCheckpointTime,
  closuresSince,
  formatCheckpoint,
  runJournalCheckpoint,
} from "../src/journal-checkpoint.js";

describe("twelveTo24", () => {
  it("converts noon-ish PM correctly", () => {
    assert.equal(twelveTo24("12:00 PM"), "12:00");
    assert.equal(twelveTo24("12:30 PM"), "12:30");
  });
  it("converts midnight AM correctly", () => {
    assert.equal(twelveTo24("12:00 AM"), "00:00");
    assert.equal(twelveTo24("12:30 AM"), "00:30");
  });
  it("converts evening PM", () => {
    assert.equal(twelveTo24("10:04 PM"), "22:04");
    assert.equal(twelveTo24("6:02 AM"), "06:02");
    assert.equal(twelveTo24("1:00 PM"), "13:00");
  });
  it("accepts lowercase am/pm", () => {
    assert.equal(twelveTo24("6:02 am"), "06:02");
    assert.equal(twelveTo24("3:15 pm"), "15:15");
  });
  it("returns null on malformed input", () => {
    assert.equal(twelveTo24("25:00 PM"), null);
    assert.equal(twelveTo24("6:60 AM"), null);
    assert.equal(twelveTo24("not a time"), null);
    assert.equal(twelveTo24("13:00 PM"), null);
  });
});

describe("twentyFourTo12 round-trip", () => {
  it("preserves time across conversion", () => {
    for (const t of ["00:00", "06:02", "12:00", "12:30", "13:00", "22:04", "23:59"]) {
      const twelve = twentyFourTo12(t);
      assert.equal(twelveTo24(twelve), t, `round-trip failed for ${t} → ${twelve}`);
    }
  });
});

describe("parseJournalHeaders", () => {
  it("extracts headers in file order", () => {
    const md = [
      "### maxos-digest (9:25 PM)",
      "body",
      "### Morning brief (6:02 AM)",
      "more body",
      "### Mid-day checkpoint (2:55 PM)",
    ].join("\n");
    const headers = parseJournalHeaders(md);
    assert.equal(headers.length, 3);
    assert.equal(headers[0].iso, "21:25");
    assert.equal(headers[0].title, "maxos-digest");
    assert.equal(headers[1].iso, "06:02");
    assert.equal(headers[2].iso, "14:55");
  });
  it("returns empty for journal with no headers yet", () => {
    assert.deepEqual(parseJournalHeaders(""), []);
    assert.deepEqual(parseJournalHeaders("just some prose"), []);
  });
  it("skips malformed headers silently", () => {
    const md = "### bad (99:99 PM)\n### good (3:00 PM)";
    const headers = parseJournalHeaders(md);
    assert.equal(headers.length, 1);
    assert.equal(headers[0].iso, "15:00");
  });
  it("ignores h2 and h4 headers", () => {
    const md = "## not me (1:00 PM)\n#### nope (2:00 PM)\n### yes (3:00 PM)";
    const headers = parseJournalHeaders(md);
    assert.equal(headers.length, 1);
    assert.equal(headers[0].title, "yes");
  });
});

describe("parseClosures", () => {
  it("extracts all closure lines with tag + iso + description", () => {
    const md = [
      "- [07:44] [CLOSURE] texted Jessica re: cinnamon rolls",
      "- [11:42] [DECISION] dropped the Robert Scott loop",
      "- [15:29] [FACT] Ruth admitted to ER",
    ].join("\n");
    const closures = parseClosures(md);
    assert.equal(closures.length, 3);
    assert.equal(closures[0].iso, "07:44");
    assert.equal(closures[0].tag, "CLOSURE");
    assert.equal(closures[0].description, "texted Jessica re: cinnamon rolls");
    assert.equal(closures[1].tag, "DECISION");
    assert.equal(closures[2].tag, "FACT");
  });
  it("handles multi-word tags like 'FACT new-loop' as a single grouped tag", () => {
    // The closures grammar puts the JSON after the tag, so "FACT" is the bracket
    // tag and " new-loop {json}" is part of the description. Stays grouped under FACT.
    const md = `- [16:42] [FACT] new-loop {"id":"send-glenn-mnda","topic":"Send Glenn the MNDA"}`;
    const closures = parseClosures(md);
    assert.equal(closures.length, 1);
    assert.equal(closures[0].tag, "FACT");
    assert.ok(closures[0].description.startsWith("new-loop {"));
  });
  it("returns empty for non-closure content", () => {
    assert.deepEqual(parseClosures(""), []);
    assert.deepEqual(parseClosures("# random markdown\nno closures"), []);
  });
  it("does not match malformed timestamps or missing tags", () => {
    const md = [
      "- [7:44] [CLOSURE] missing zero-pad",   // 5-char iso required
      "- [07:44] CLOSURE no brackets",         // tag must be bracketed
      "- [07:44] [closure] lowercase tag",     // tag must be uppercase
      "- [07:44] [CLOSURE] valid one",
    ].join("\n");
    const closures = parseClosures(md);
    assert.equal(closures.length, 1);
    assert.equal(closures[0].description, "valid one");
  });
});

describe("lastCheckpointTime", () => {
  it("returns null for empty header list (day just started)", () => {
    assert.equal(lastCheckpointTime([]), null);
  });
  it("returns the maximum iso, not the file-order last", () => {
    const headers = [
      { iso: "06:02", title: "morning" },
      { iso: "22:04", title: "evening" },
      { iso: "14:55", title: "midday" },
    ];
    assert.equal(lastCheckpointTime(headers), "22:04");
  });
});

describe("closuresSince", () => {
  const closures = [
    { iso: "07:44", tag: "CLOSURE", description: "early" },
    { iso: "14:55", tag: "CLOSURE", description: "midday" },
    { iso: "22:04", tag: "DECISION", description: "late" },
  ];
  it("since=null returns all (every closure is fresh)", () => {
    assert.equal(closuresSince(closures, null).length, 3);
  });
  it("strict greater-than excludes equal timestamps", () => {
    // The journal header at 14:55 should NOT re-include the 14:55 closure that
    // was already captured in that header's checkpoint.
    const fresh = closuresSince(closures, "14:55");
    assert.equal(fresh.length, 1);
    assert.equal(fresh[0].iso, "22:04");
  });
  it("filters out everything when since is after the last closure", () => {
    assert.equal(closuresSince(closures, "23:00").length, 0);
  });
});

describe("formatCheckpoint", () => {
  it("returns empty string for no closures", () => {
    assert.equal(formatCheckpoint([], new Date()), "");
  });
  it("groups closures by tag with CLOSURE → DECISION → FACT ordering", () => {
    const closures = [
      { iso: "10:00", tag: "FACT", description: "fact-a" },
      { iso: "11:00", tag: "CLOSURE", description: "closure-a" },
      { iso: "12:00", tag: "DECISION", description: "decision-a" },
      { iso: "13:00", tag: "CLOSURE", description: "closure-b" },
    ];
    const block = formatCheckpoint(closures, new Date("2026-05-10T14:25:00"));
    const lines = block.split("\n").filter((l) => l.startsWith("- "));
    assert.equal(lines[0].includes("closure-a"), true);
    assert.equal(lines[1].includes("closure-b"), true);
    assert.equal(lines[2].includes("decision-a"), true);
    assert.equal(lines[3].includes("fact-a"), true);
  });
  it("renders an unrecognized tag after the canonical ones, alpha-sorted", () => {
    const closures = [
      { iso: "10:00", tag: "ZULU", description: "z" },
      { iso: "11:00", tag: "ALPHA", description: "a" },
      { iso: "12:00", tag: "DECISION", description: "d" },
    ];
    const block = formatCheckpoint(closures, new Date("2026-05-10T14:25:00"));
    // The second bracketed token on each closure line is the tag.
    const tagOrder = block
      .split("\n")
      .filter((l) => l.startsWith("- "))
      .map((l) => {
        const matches = [...l.matchAll(/\[([^\]]+)\]/g)];
        return matches[1]?.[1];
      })
      .filter(Boolean);
    // DECISION first (canonical), then ALPHA, then ZULU (alpha sort).
    assert.deepEqual(tagOrder, ["DECISION", "ALPHA", "ZULU"]);
  });
  it("includes a properly formatted Checkpoint header", () => {
    const closures = [{ iso: "10:00", tag: "CLOSURE", description: "x" }];
    const block = formatCheckpoint(closures, new Date("2026-05-10T22:04:00"));
    assert.ok(block.includes("### Checkpoint (10:04 PM)"), `header missing: ${block}`);
  });
});

describe("runJournalCheckpoint integration", () => {
  function setup(): string {
    const tmp = mkdtempSync(join(tmpdir(), "journal-checkpoint-"));
    mkdirSync(join(tmp, "memory"));
    return tmp;
  }

  it("returns wrote=false when no closures file exists today", () => {
    const ws = setup();
    const result = runJournalCheckpoint(ws, new Date("2026-05-10T14:25:00"));
    assert.equal(result.wrote, false);
    assert.equal(result.closureCount, 0);
    assert.match(result.reason!, /no closures file/);
  });

  it("returns wrote=false when closures file exists but is empty", () => {
    const ws = setup();
    writeFileSync(join(ws, "memory", "closures-2026-05-10.md"), "");
    const result = runJournalCheckpoint(ws, new Date("2026-05-10T14:25:00"));
    assert.equal(result.wrote, false);
    assert.match(result.reason!, /empty/);
  });

  it("returns wrote=false when all closures predate the last journal header", () => {
    const ws = setup();
    writeFileSync(
      join(ws, "memory", "closures-2026-05-10.md"),
      "- [07:44] [CLOSURE] early one\n",
    );
    writeFileSync(
      join(ws, "memory", "2026-05-10.md"),
      "### morning brief (8:00 AM)\nbody\n",
    );
    const result = runJournalCheckpoint(ws, new Date("2026-05-10T14:25:00"));
    assert.equal(result.wrote, false);
    assert.match(result.reason!, /no closures since/);
  });

  it("appends a checkpoint block when new closures exist since the last header", () => {
    const ws = setup();
    writeFileSync(
      join(ws, "memory", "closures-2026-05-10.md"),
      [
        "- [07:44] [CLOSURE] morning text",
        "- [10:00] [DECISION] picked option B",
        "- [12:30] [FACT] new-loop {\"id\":\"x\",\"topic\":\"y\"}",
      ].join("\n") + "\n",
    );
    writeFileSync(
      join(ws, "memory", "2026-05-10.md"),
      "### morning brief (8:00 AM)\nbody\n",
    );
    const result = runJournalCheckpoint(ws, new Date("2026-05-10T14:25:00"));
    assert.equal(result.wrote, true);
    // 07:44 closure is before the 8:00 AM header → excluded. 10:00 + 12:30 fresh.
    assert.equal(result.closureCount, 2);
    const journal = readFileSync(join(ws, "memory", "2026-05-10.md"), "utf-8");
    assert.ok(journal.includes("### Checkpoint (2:25 PM)"));
    assert.ok(journal.includes("picked option B"));
    assert.ok(journal.includes("new-loop"));
    assert.ok(!journal.includes("morning text"), "07:44 closure should be excluded as pre-checkpoint");
  });

  it("treats a journal with zero headers as 'every closure is new'", () => {
    const ws = setup();
    writeFileSync(
      join(ws, "memory", "closures-2026-05-10.md"),
      "- [07:44] [CLOSURE] very early\n",
    );
    // No journal file at all → all closures count as new.
    const result = runJournalCheckpoint(ws, new Date("2026-05-10T08:00:00"));
    assert.equal(result.wrote, true);
    assert.equal(result.closureCount, 1);
  });
});
