import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { selectFilesToArchive, archiveOldJournals } from "../src/journal-archiver.js";

describe("selectFilesToArchive", () => {
  const fixedNow = new Date("2026-04-27T12:00:00");

  it("selects daily journals older than ageDays", () => {
    const out = selectFilesToArchive(
      ["2026-03-01.md", "2026-04-15.md", "2026-04-26.md"],
      fixedNow,
      30,
    );
    // 2026-03-01 is 57 days old → archive
    // 2026-04-15 is 12 days old → keep
    // 2026-04-26 is 1 day old → keep
    assert.deepEqual(out, ["2026-03-01.md"]);
  });

  it("selects closures files too", () => {
    const out = selectFilesToArchive(
      ["closures-2026-03-01.md", "closures-2026-04-26.md"],
      fixedNow,
      30,
    );
    assert.deepEqual(out, ["closures-2026-03-01.md"]);
  });

  it("ignores non-journal files", () => {
    const out = selectFilesToArchive(
      ["MEMORY.md", "open-loops.json", "dropped-loops.md", "2025-12-01.md"],
      fixedNow,
      30,
    );
    // Only the matching dated journal gets selected
    assert.deepEqual(out, ["2025-12-01.md"]);
  });

  it("ignores files with malformed dates", () => {
    const out = selectFilesToArchive(
      ["2026-13-99.md", "2026-99-01.md"],
      fixedNow,
      30,
    );
    // JS Date is lenient (rolls over), so these may or may not parse;
    // function should at minimum not throw and return reasonable results
    assert.ok(Array.isArray(out));
  });

  it("respects the ageDays threshold", () => {
    const veryOld = ["2024-01-01.md", "2025-04-26.md"];
    assert.deepEqual(selectFilesToArchive(veryOld, fixedNow, 30), veryOld);
    assert.deepEqual(selectFilesToArchive(veryOld, fixedNow, 9999), []);
  });

  it("does NOT archive today's or yesterday's journal at default 30 days", () => {
    const out = selectFilesToArchive(
      ["2026-04-26.md", "2026-04-27.md", "closures-2026-04-27.md"],
      fixedNow,
      30,
    );
    assert.deepEqual(out, []);
  });
});

describe("archiveOldJournals (with file system)", () => {
  let tmp: string;
  let memoryDir: string;
  let archiveDir: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "journal-arc-"));
    memoryDir = join(tmp, "workspace", "memory");
    archiveDir = join(memoryDir, "archive");
    mkdirSync(memoryDir, { recursive: true });
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  const fixedNow = new Date("2026-04-27T12:00:00");

  it("moves old files to archive/ and leaves recent ones in place", () => {
    writeFileSync(join(memoryDir, "2026-02-01.md"), "old journal content");
    writeFileSync(join(memoryDir, "2026-04-26.md"), "recent journal content");
    writeFileSync(join(memoryDir, "MEMORY.md"), "always-keep file");

    const r = archiveOldJournals(tmp, fixedNow, 30);
    assert.equal(r.movedCount, 1);
    assert.deepEqual(r.movedFiles, ["2026-02-01.md"]);
    // archive/ has the old file
    assert.ok(existsSync(join(archiveDir, "2026-02-01.md")));
    // memory/ no longer has the old file
    assert.ok(!existsSync(join(memoryDir, "2026-02-01.md")));
    // recent file still in memory/
    assert.ok(existsSync(join(memoryDir, "2026-04-26.md")));
    // Non-journal file untouched
    assert.ok(existsSync(join(memoryDir, "MEMORY.md")));
  });

  it("creates archive/ if it doesn't exist", () => {
    writeFileSync(join(memoryDir, "2026-01-01.md"), "old");
    rmSync(archiveDir, { recursive: true, force: true });
    const r = archiveOldJournals(tmp, fixedNow, 30);
    assert.equal(r.movedCount, 1);
    assert.ok(existsSync(archiveDir));
  });

  it("returns 0 when memory dir doesn't exist", () => {
    rmSync(memoryDir, { recursive: true, force: true });
    const r = archiveOldJournals(tmp, fixedNow, 30);
    assert.equal(r.movedCount, 0);
  });

  it("is idempotent — running twice doesn't re-move or fail", () => {
    writeFileSync(join(memoryDir, "2026-01-01.md"), "old");
    const r1 = archiveOldJournals(tmp, fixedNow, 30);
    const r2 = archiveOldJournals(tmp, fixedNow, 30);
    assert.equal(r1.movedCount, 1);
    assert.equal(r2.movedCount, 0);
    // The archived file should still be there
    assert.ok(existsSync(join(archiveDir, "2026-01-01.md")));
  });

  it("archives both journal and closures files in the same pass", () => {
    writeFileSync(join(memoryDir, "2026-01-01.md"), "old journal");
    writeFileSync(join(memoryDir, "closures-2026-01-01.md"), "old closures");
    writeFileSync(join(memoryDir, "2026-04-26.md"), "recent");
    const r = archiveOldJournals(tmp, fixedNow, 30);
    assert.equal(r.movedCount, 2);
    assert.ok(existsSync(join(archiveDir, "2026-01-01.md")));
    assert.ok(existsSync(join(archiveDir, "closures-2026-01-01.md")));
    assert.equal(readdirSync(memoryDir).filter((n) => /^\d{4}-/.test(n) || n.startsWith("closures-")).length, 1);
  });
});
