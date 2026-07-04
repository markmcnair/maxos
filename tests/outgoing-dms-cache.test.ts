import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadOutgoingDmsCache,
  localScanTimestamp,
  outgoingDmsCachePath,
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
