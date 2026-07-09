import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  firstErrorLine,
  ghostedCachePath,
  loadGhostedCache,
  loadOutgoingDmsCache,
  loadRecentMessagesCache,
  localScanTimestamp,
  outgoingDmsCachePath,
  recentMessagesCachePath,
  OUTGOING_DMS_CACHE_MAX_AGE_MS,
} from "../src/outgoing-dms-cache.js";

describe("localScanTimestamp", () => {
  it("formats a Date as local 'YYYY-MM-DD HH:MM:SS' (imessage-scan line format)", () => {
    // new Date(y, m, d, ...) constructs in LOCAL time — matches scan output.
    const d = new Date(2026, 6, 3, 9, 5, 7);
    assert.equal(localScanTimestamp(d), "2026-07-03 09:05:07");
  });

  it("is lexicographically comparable across day boundaries", () => {
    const a = localScanTimestamp(new Date(2026, 6, 2, 23, 59, 59));
    const b = localScanTimestamp(new Date(2026, 6, 3, 0, 0, 0));
    assert.ok(a < b);
  });
});

describe("loadOutgoingDmsCache", () => {
  let home: string;
  const now = new Date("2026-07-03T19:10:00Z");

  const writeCache = (obj: unknown) => {
    writeFileSync(outgoingDmsCachePath(home), JSON.stringify(obj));
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "dms-cache-"));
    mkdirSync(join(home, "workspace", "memory"), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("loads a fresh cache: ok, generatedAt, hours, lines", () => {
    writeCache({
      generated_at: "2026-07-03T19:06:16Z",
      ok: true,
      exit: 0,
      hours: 168,
      lines: ["2026-07-03 13:54:22|+15012695797|Niiiiice lol"],
      error: "",
    });
    const cache = loadOutgoingDmsCache(home, now);
    assert.ok(cache);
    assert.equal(cache.ok, true);
    assert.equal(cache.hours, 168);
    assert.equal(cache.generatedAt.toISOString(), "2026-07-03T19:06:16.000Z");
    assert.deepEqual(cache.lines, ["2026-07-03 13:54:22|+15012695797|Niiiiice lol"]);
  });

  it("returns null when the cache file is missing", () => {
    assert.equal(loadOutgoingDmsCache(home, now), null);
  });

  it("returns null when the cache file is unparseable", () => {
    writeFileSync(outgoingDmsCachePath(home), "{ not json");
    assert.equal(loadOutgoingDmsCache(home, now), null);
  });

  it("returns null when generated_at is older than 45 minutes (stale)", () => {
    // 46 minutes before `now`
    writeCache({ generated_at: "2026-07-03T18:24:00Z", ok: true, hours: 168, lines: [] });
    assert.equal(loadOutgoingDmsCache(home, now), null);
  });

  it("accepts a cache just inside the 45-minute freshness window", () => {
    // 44 minutes before `now`
    writeCache({ generated_at: "2026-07-03T18:26:00Z", ok: true, hours: 168, lines: [] });
    const cache = loadOutgoingDmsCache(home, now);
    assert.ok(cache);
    assert.equal(cache.ok, true);
  });

  it("returns null when generated_at is missing or invalid", () => {
    writeCache({ ok: true, hours: 168, lines: [] });
    assert.equal(loadOutgoingDmsCache(home, now), null);
    writeCache({ generated_at: "not a date", ok: true, hours: 168, lines: [] });
    assert.equal(loadOutgoingDmsCache(home, now), null);
  });

  it("preserves ok:false (scan failed inside the agent) so callers can fall back", () => {
    writeCache({ generated_at: "2026-07-03T19:06:00Z", ok: false, hours: 168, lines: [], error: "boom" });
    const cache = loadOutgoingDmsCache(home, now);
    assert.ok(cache);
    assert.equal(cache.ok, false);
  });

  it("defaults hours to 168 and drops non-string line entries", () => {
    writeCache({
      generated_at: "2026-07-03T19:06:00Z",
      ok: true,
      lines: ["2026-07-03 13:00:00|+15551234567|hi", 42, null],
    });
    const cache = loadOutgoingDmsCache(home, now);
    assert.ok(cache);
    assert.equal(cache.hours, 168);
    assert.deepEqual(cache.lines, ["2026-07-03 13:00:00|+15551234567|hi"]);
  });

  it("exposes the 45-minute constant used for staleness", () => {
    assert.equal(OUTGOING_DMS_CACHE_MAX_AGE_MS, 45 * 60 * 1000);
  });
});

describe("loadRecentMessagesCache", () => {
  let home: string;
  const now = new Date("2026-07-03T19:10:00Z");

  const writeCache = (obj: unknown) => {
    writeFileSync(recentMessagesCachePath(home), JSON.stringify(obj));
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "recent-cache-"));
    mkdirSync(join(home, "workspace", "memory"), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("reads recent-messages-cache.json (both directions, plain scan format)", () => {
    writeCache({
      generated_at: "2026-07-03T19:06:16Z",
      ok: true,
      exit: 0,
      hours: 48,
      lines: [
        "2026-07-03 14:02:48|+15017338253|Just checking while I'm here.",  // incoming
        "2026-07-03 13:54:22|Mark|Niiiiice lol",  // outgoing
      ],
      error: "",
    });
    const cache = loadRecentMessagesCache(home, now);
    assert.ok(cache);
    assert.equal(cache.ok, true);
    assert.equal(cache.hours, 48);
    assert.equal(cache.lines.length, 2);
  });

  it("has its own path, distinct from the outgoing-dms cache", () => {
    assert.notEqual(recentMessagesCachePath(home), outgoingDmsCachePath(home));
    assert.ok(recentMessagesCachePath(home).endsWith("workspace/memory/recent-messages-cache.json"));
    // Writing only the outgoing-dms cache must not satisfy this loader.
    writeFileSync(
      outgoingDmsCachePath(home),
      JSON.stringify({ generated_at: "2026-07-03T19:06:16Z", ok: true, hours: 168, lines: [] }),
    );
    assert.equal(loadRecentMessagesCache(home, now), null);
  });

  it("applies the same 45-minute staleness rule", () => {
    writeCache({ generated_at: "2026-07-03T18:24:00Z", ok: true, hours: 48, lines: [] });  // 46 min old
    assert.equal(loadRecentMessagesCache(home, now), null);
  });

  it("defaults hours to 48 when the field is absent", () => {
    writeCache({ generated_at: "2026-07-03T19:06:00Z", ok: true, lines: [] });
    const cache = loadRecentMessagesCache(home, now);
    assert.ok(cache);
    assert.equal(cache.hours, 48);
  });
});

describe("loadGhostedCache", () => {
  let home: string;
  const now = new Date("2026-07-09T21:00:00Z");

  const writeCache = (obj: unknown) => {
    writeFileSync(ghostedCachePath(home), JSON.stringify(obj));
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ghosted-cache-"));
    mkdirSync(join(home, "workspace", "memory"), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("reads ghosted-cache.json — `rows` key (imsg-ghosted-cache.py shape), not `lines`", () => {
    writeCache({
      generated_at: "2026-07-09T20:46:18Z",
      ok: true,
      exit: 0,
      rows: [
        "2026-07-09 15:45:26|+15016252146|Oh I see! We can do that.",
        "2026-07-09 13:52:14|+15012690608|Michael Goss — mgoss@leader.one",
      ],
      error: "",
    });
    const cache = loadGhostedCache(home, now);
    assert.ok(cache);
    assert.equal(cache.ok, true);
    assert.equal(cache.lines.length, 2);
    assert.match(cache.lines[1], /Michael Goss/);
  });

  it("applies the same 45-minute staleness rule as the other scan caches", () => {
    writeCache({
      generated_at: new Date(now.getTime() - 46 * 60 * 1000).toISOString(),
      ok: true,
      rows: ["2026-07-09 15:45:26|+15016252146|hi"],
    });
    assert.equal(loadGhostedCache(home, now), null);
  });

  it("defaults hours to 24 (the agent scans --ghosted --hours 24)", () => {
    writeCache({
      generated_at: now.toISOString(),
      ok: true,
      rows: [],
    });
    const cache = loadGhostedCache(home, now);
    assert.ok(cache);
    assert.equal(cache.hours, 24);
  });

  it("returns null when missing", () => {
    assert.equal(loadGhostedCache(home, now), null);
  });
});

describe("firstErrorLine", () => {
  it("returns the first non-empty line of a multi-line error (traceback stays out of logs)", () => {
    const err = new Error(
      "Command failed: /x/imessage-scan --outgoing-dms\nTraceback (most recent call last):\n  File \"x\", line 1\nsqlite3.OperationalError: authorization denied",
    );
    assert.equal(firstErrorLine(err), "Command failed: /x/imessage-scan --outgoing-dms");
  });

  it("skips leading blank lines", () => {
    assert.equal(firstErrorLine(new Error("\n\n  real cause here\nmore")), "real cause here");
  });

  it("stringifies non-Error values", () => {
    assert.equal(firstErrorLine("plain string failure"), "plain string failure");
  });

  it("falls back for empty messages", () => {
    assert.equal(firstErrorLine(new Error("")), "unknown error");
  });
});
