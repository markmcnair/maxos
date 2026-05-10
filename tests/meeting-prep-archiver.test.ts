import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  selectPrepFilesToArchive,
  archiveOldMeetingPreps,
} from "../src/meeting-prep-archiver.js";

describe("selectPrepFilesToArchive", () => {
  const fixedNow = new Date("2026-04-29T18:00:00");

  it("selects dated prep files older than ageDays", () => {
    const out = selectPrepFilesToArchive(
      [
        "2026-04-15-mark-squared-call.md",
        "2026-04-17-mark-squared-mike-salem.md",
        "2026-04-21-mark-squared-mike-salem.md",
        "2026-04-28-something-recent.md",
        "2026-04-29-today.md",
      ],
      fixedNow,
      7,
    );
    // Apr 15, 17, 21 are >7d old → archive. Apr 28, 29 are recent → keep.
    assert.deepEqual(
      out.sort(),
      [
        "2026-04-15-mark-squared-call.md",
        "2026-04-17-mark-squared-mike-salem.md",
        "2026-04-21-mark-squared-mike-salem.md",
      ].sort(),
    );
  });

  it("ignores files without YYYY-MM-DD prefix", () => {
    const out = selectPrepFilesToArchive(
      ["random-notes.md", "TODO.md", "2026-04-15-real.md"],
      fixedNow,
      7,
    );
    assert.deepEqual(out, ["2026-04-15-real.md"]);
  });

  it("ignores non-md files", () => {
    const out = selectPrepFilesToArchive(
      ["2026-04-15-photo.jpg", "2026-04-15-real.md"],
      fixedNow,
      7,
    );
    assert.deepEqual(out, ["2026-04-15-real.md"]);
  });

  it("returns empty when nothing is old enough", () => {
    const out = selectPrepFilesToArchive(
      ["2026-04-28-yesterday.md", "2026-04-29-today.md"],
      fixedNow,
      7,
    );
    assert.deepEqual(out, []);
  });

  it("respects ageDays threshold", () => {
    const old = ["2026-04-22-old.md"]; // 7 days exactly
    assert.deepEqual(selectPrepFilesToArchive(old, fixedNow, 7), []);
    assert.deepEqual(selectPrepFilesToArchive(old, fixedNow, 6), ["2026-04-22-old.md"]);
  });
});

describe("archiveOldMeetingPreps (with file system)", () => {
  let tmp: string;
  let prepDir: string;
  let archiveDir: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "meeting-prep-arch-"));
    prepDir = join(tmp, "Work", "Meeting Prep");
    archiveDir = join(prepDir, "archive");
    mkdirSync(prepDir, { recursive: true });
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  const fixedNow = new Date("2026-04-29T18:00:00");

  it("regression: 2026-04-17 + 2026-04-21 mark-squared-mike-salem files get archived", () => {
    writeFileSync(join(prepDir, "2026-04-17-mark-squared-mike-salem.md"), "old prep");
    writeFileSync(join(prepDir, "2026-04-21-mark-squared-mike-salem.md"), "old prep");
    writeFileSync(join(prepDir, "2026-04-29-mark-squared-call.md"), "today");

    const r = archiveOldMeetingPreps(tmp, fixedNow, 7);
    assert.equal(r.movedCount, 2);
    assert.ok(r.movedFiles.includes("2026-04-17-mark-squared-mike-salem.md"));
    assert.ok(r.movedFiles.includes("2026-04-21-mark-squared-mike-salem.md"));
    assert.ok(existsSync(join(archiveDir, "2026-04-17-mark-squared-mike-salem.md")));
    assert.ok(existsSync(join(archiveDir, "2026-04-21-mark-squared-mike-salem.md")));
    // Today's file is preserved
    assert.ok(existsSync(join(prepDir, "2026-04-29-mark-squared-call.md")));
  });

  it("creates archive/ if it doesn't exist", () => {
    writeFileSync(join(prepDir, "2026-01-01-old.md"), "ancient");
    rmSync(archiveDir, { recursive: true, force: true });
    const r = archiveOldMeetingPreps(tmp, fixedNow, 7);
    assert.equal(r.movedCount, 1);
    assert.ok(existsSync(archiveDir));
  });

  it("returns 0 when prep dir doesn't exist", () => {
    rmSync(prepDir, { recursive: true, force: true });
    const r = archiveOldMeetingPreps(tmp, fixedNow, 7);
    assert.equal(r.movedCount, 0);
  });

  it("is idempotent — running twice doesn't re-move", () => {
    writeFileSync(join(prepDir, "2026-01-01-old.md"), "ancient");
    const r1 = archiveOldMeetingPreps(tmp, fixedNow, 7);
    const r2 = archiveOldMeetingPreps(tmp, fixedNow, 7);
    assert.equal(r1.movedCount, 1);
    assert.equal(r2.movedCount, 0);
  });

  it("does not touch the archive/ subdirectory itself (it's a dir, not a .md)", () => {
    writeFileSync(join(prepDir, "2026-01-01-old.md"), "ancient");
    archiveOldMeetingPreps(tmp, fixedNow, 7);
    // archive/ dir should still be a dir (not moved into itself)
    assert.ok(existsSync(archiveDir));
  });
});
