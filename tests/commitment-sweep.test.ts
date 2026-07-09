import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepOutbound } from "../src/commitment-sweep.js";
import { localScanTimestamp } from "../src/outgoing-dms-cache.js";

describe("sweepOutbound", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sweep-"));
    mkdirSync(join(home, "workspace", "memory"), { recursive: true });
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("scans messages from injected fetchers, records new commitments + cancellations", async () => {
    const r = await sweepOutbound(home, {
      hoursBack: 6,
      deps: {
        fetchSent: async () => [
          {
            messageId: "e1",
            recipient: "lane@example.com",
            sentAt: "2026-05-07T16:00:00Z",
            body: "I'll send the keys by Friday.",
            account: "personal" as const,
          },
        ],
        fetchIMessages: async () => [
          {
            messageId: "im1",
            recipient: "+15015551234",
            sentAt: "2026-05-07T17:00:00Z",
            body: "Have to cancel our 7pm tonight, sorry!",
          },
        ],
      },
    });
    // fetchSent runs for both personal+emprise (2 emails total), plus 1 imsg = 3 scanned
    assert.equal(r.scanned, 3);
    assert.ok(r.newCommitments >= 1);
    assert.ok(r.newCancellations >= 1);
    const commitsFile = join(home, "workspace", "memory", "commitments.jsonl");
    const cancelsFile = join(home, "workspace", "memory", "cancellations.jsonl");
    assert.ok(existsSync(commitsFile));
    assert.ok(existsSync(cancelsFile));
    assert.match(readFileSync(commitsFile, "utf-8"), /send the keys/);
    assert.match(readFileSync(cancelsFile, "utf-8"), /tonight|7pm/);
  });

  it("is idempotent — second run with same input adds zero records", async () => {
    const deps = {
      fetchSent: async () => [
        {
          messageId: "e1",
          recipient: "x@y.com",
          sentAt: "2026-05-07T16:00:00Z",
          body: "I'll send the keys by Friday.",
          account: "personal" as const,
        },
      ],
      fetchIMessages: async () => [],
    };
    const r1 = await sweepOutbound(home, { deps });
    const r2 = await sweepOutbound(home, { deps });
    assert.ok(r1.newCommitments >= 1);
    assert.equal(r2.newCommitments, 0);
    assert.equal(r2.newCancellations, 0);
  });

  it("tolerates fetcher errors and keeps going", async () => {
    const r = await sweepOutbound(home, {
      deps: {
        fetchSent: async (account) => {
          if (account === "emprise") throw new Error("emprise gws blew up");
          return [
            {
              messageId: "e1",
              recipient: "x@y.com",
              sentAt: "2026-05-07T16:00:00Z",
              body: "I'll send by Friday.",
              account: "personal" as const,
            },
          ];
        },
        fetchIMessages: async () => [],
      },
    });
    assert.ok(r.errors.length >= 1);
    assert.match(r.errors[0], /emprise/);
    // Personal account commitments still captured
    assert.ok(r.newCommitments >= 1);
  });

  it("returns scanned=0 + no errors when fetchers return nothing", async () => {
    const r = await sweepOutbound(home, {
      deps: {
        fetchSent: async () => [],
        fetchIMessages: async () => [],
      },
    });
    assert.equal(r.scanned, 0);
    assert.equal(r.newCommitments, 0);
    assert.equal(r.newCancellations, 0);
    assert.equal(r.errors.length, 0);
  });
});

describe("sweepOutbound — outgoing-dms cache-first iMessage fetch (FDA-safe)", () => {
  let home: string;

  // Emails stubbed empty so only the iMessage path is exercised.
  const noEmails = { fetchSent: async () => [] };

  const writeCache = (obj: unknown) => {
    writeFileSync(
      join(home, "workspace", "memory", "outgoing-dms-cache.json"),
      JSON.stringify(obj),
    );
  };

  const hoursAgoTs = (h: number) => localScanTimestamp(new Date(Date.now() - h * 3_600_000));

  // A fake imessage-scan the spawn fallback will hit; the distinctive
  // "spawn-marker" body proves which path produced a record.
  const installFakeScan = (): string => {
    const toolsDir = join(home, "workspace", "tools");
    mkdirSync(toolsDir, { recursive: true });
    const path = join(toolsDir, "imessage-scan");
    writeFileSync(
      path,
      `#!/bin/sh\necho "${hoursAgoTs(1)}|+15015551234|I'll send the spawn-marker doc by Friday."\n`,
      { mode: 0o755 },
    );
    return path;
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sweep-cache-"));
    mkdirSync(join(home, "workspace", "memory"), { recursive: true });
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("cache hit: extracts commitments from a fresh cache without spawning", async () => {
    writeCache({
      generated_at: new Date().toISOString(),
      ok: true,
      hours: 168,
      lines: [
        `${hoursAgoTs(1)}|+15015551234|I'll send the cache-marker doc by Friday.`,
        "a continuation | line with pipes | that must be skipped, not crash the parse",
        `${hoursAgoTs(24)}|+15015551234|I'll send the too-old doc by Friday.`,  // outside 6h window
      ],
    });
    const r = await sweepOutbound(home, {
      hoursBack: 6,
      deps: noEmails,
      imessageScan: "/nonexistent/imessage-scan",  // spawn would fail — cache must serve
    });
    assert.equal(r.scanned, 1, "one in-window, ts-valid line");
    assert.equal(r.errors.length, 0, "no spawn attempted, no error recorded");
    assert.ok(r.newCommitments >= 1);
    const commits = readFileSync(join(home, "workspace", "memory", "commitments.jsonl"), "utf-8");
    assert.match(commits, /cache-marker/);
    assert.doesNotMatch(commits, /too-old/);
  });

  it("stale cache falls back to the spawn", async () => {
    const fake = installFakeScan();
    writeCache({
      generated_at: new Date(Date.now() - 46 * 60 * 1000).toISOString(),  // 46 min → stale
      ok: true,
      hours: 168,
      lines: [`${hoursAgoTs(1)}|+15015551234|I'll send the cache-marker doc by Friday.`],
    });
    const r = await sweepOutbound(home, { hoursBack: 6, deps: noEmails, imessageScan: fake });
    assert.equal(r.scanned, 1);
    const commits = readFileSync(join(home, "workspace", "memory", "commitments.jsonl"), "utf-8");
    assert.match(commits, /spawn-marker/, "record must come from the spawned scan");
    assert.doesNotMatch(commits, /cache-marker/);
  });

  it("hoursBack beyond the cache window falls back to the spawn", async () => {
    const fake = installFakeScan();
    writeCache({
      generated_at: new Date().toISOString(),
      ok: true,
      hours: 168,
      lines: [`${hoursAgoTs(1)}|+15015551234|I'll send the cache-marker doc by Friday.`],
    });
    const r = await sweepOutbound(home, { hoursBack: 200, deps: noEmails, imessageScan: fake });
    assert.equal(r.scanned, 1);
    const commits = readFileSync(join(home, "workspace", "memory", "commitments.jsonl"), "utf-8");
    assert.match(commits, /spawn-marker/);
  });

  it("spawn failure is LOUD: lands in SweepResult.errors instead of being swallowed", async () => {
    // No cache, nonexistent binary — this is the FDA-denial shape that used
    // to vanish (fetchOutgoingIMessages caught the error and returned []).
    const r = await sweepOutbound(home, {
      hoursBack: 6,
      deps: noEmails,
      imessageScan: "/nonexistent/imessage-scan",
    });
    assert.equal(r.scanned, 0);
    assert.ok(
      r.errors.some((e) => e.startsWith("fetchIMessages:")),
      `spawn failure must surface in errors[], got: ${JSON.stringify(r.errors)}`,
    );
  });

  it("regression: pipe-containing continuation line on spawn stdout no longer nukes the fetch", async () => {
    // Old parser called toISOString() on an unvalidated timestamp; a body
    // continuation line with two pipes threw RangeError and the catch
    // discarded EVERY message from the batch.
    const toolsDir = join(home, "workspace", "tools");
    mkdirSync(toolsDir, { recursive: true });
    const fake = join(toolsDir, "imessage-scan");
    writeFileSync(
      fake,
      `#!/bin/sh\necho "${hoursAgoTs(1)}|+15015551234|I'll send the spawn-marker doc by Friday."\necho "garbage | continuation | line"\n`,
      { mode: 0o755 },
    );
    const r = await sweepOutbound(home, { hoursBack: 6, deps: noEmails, imessageScan: fake });
    assert.equal(r.scanned, 1, "valid line survives, garbage line is skipped");
    assert.ok(r.newCommitments >= 1);
  });

  it("stores sentAt as the correct UTC instant for a LOCAL scan timestamp (5-6h skew fix)", async () => {
    // Scan/cache timestamps are local naive "YYYY-MM-DD HH:MM:SS". The old
    // parser appended "Z" — stamping local wall-clock as UTC, skewing
    // sentAt/ts by the UTC offset (5-6h in Central Time).
    const localTs = hoursAgoTs(1);
    writeCache({
      generated_at: new Date().toISOString(),
      ok: true,
      hours: 168,
      lines: [`${localTs}|+15015551234|I'll send the tz-marker doc by Friday.`],
    });
    const r = await sweepOutbound(home, {
      hoursBack: 6,
      deps: noEmails,
      imessageScan: "/nonexistent/imessage-scan",
    });
    assert.ok(r.newCommitments >= 1);
    const line = readFileSync(join(home, "workspace", "memory", "commitments.jsonl"), "utf-8")
      .trim().split("\n").map((l) => JSON.parse(l))
      .find((rec) => /tz-marker/.test(rec.commitment));
    assert.ok(line, "tz-marker record must exist");
    // new Date("YYYY-MM-DDTHH:MM:SS") parses as LOCAL time — the correct instant.
    const expected = new Date(localTs.replace(" ", "T")).toISOString();
    assert.equal(line.ts, expected, `local ${localTs} must convert to UTC instant ${expected}, got ${line.ts}`);
  });
});

describe("sweepOutbound — gws email fetch failure is LOUD (was silently swallowed)", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sweep-gws-"));
    mkdirSync(join(home, "workspace", "memory"), { recursive: true });
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("records a spawn-failed gws wrapper in errors[] for both accounts", async () => {
    const r = await sweepOutbound(home, {
      hoursBack: 6,
      deps: { fetchIMessages: async () => [] },
      gwsWrappers: {
        personal: "/nonexistent/gws-personal",
        emprise: "/nonexistent/gws-emprise",
      },
    });
    assert.ok(
      r.errors.some((e) => e.startsWith("fetchSent personal:")),
      `personal gws failure must land in errors[], got: ${JSON.stringify(r.errors)}`,
    );
    assert.ok(
      r.errors.some((e) => e.startsWith("fetchSent emprise:")),
      `emprise gws failure must land in errors[], got: ${JSON.stringify(r.errors)}`,
    );
  });

  it("keeps errors[] entries single-line (no traceback vomit)", async () => {
    const r = await sweepOutbound(home, {
      hoursBack: 6,
      deps: { fetchIMessages: async () => [] },
      gwsWrappers: {
        personal: "/nonexistent/gws-personal",
        emprise: "/nonexistent/gws-emprise",
      },
    });
    for (const e of r.errors) {
      assert.ok(!e.includes("\n"), `errors[] entry must be one line, got: ${JSON.stringify(e)}`);
    }
  });
});

describe("sweepOutbound — graceful spawn fallback (FDA-denied traceback stays out of the log)", () => {
  let home: string;
  let stderrWrites: string[];
  let origWrite: typeof process.stderr.write;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sweep-fallback-"));
    mkdirSync(join(home, "workspace", "memory"), { recursive: true });
    stderrWrites = [];
    origWrite = process.stderr.write;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = (chunk: unknown) => {
      stderrWrites.push(String(chunk));
      return true;
    };
  });
  afterEach(() => {
    process.stderr.write = origWrite;
    rmSync(home, { recursive: true, force: true });
  });

  it("stale cache + traceback-vomiting scan → ONE concise line, cycle skips cleanly", async () => {
    // Fake imessage-scan that reproduces the FDA-denied failure mode: a full
    // python traceback on stderr, nonzero exit. Cron log used to get the
    // whole traceback; healthcheck then alarmed for hours.
    const toolsDir = join(home, "workspace", "tools");
    mkdirSync(toolsDir, { recursive: true });
    const fake = join(toolsDir, "imessage-scan");
    writeFileSync(
      fake,
      `#!/bin/sh
cat >&2 <<'EOF'
Traceback (most recent call last):
  File "/x/imessage-scan", line 464, in <module>
    main()
sqlite3.OperationalError: sqlite-open(rc=23): authorization denied
EOF
exit 1
`,
      { mode: 0o755 },
    );
    // No cache file — the missing/stale path — so the fallback spawns `fake`.
    const r = await sweepOutbound(home, {
      hoursBack: 6,
      deps: { fetchSent: async () => [] },
      imessageScan: fake,
    });
    assert.equal(r.scanned, 0, "cycle skips cleanly");
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /outgoing-dms unavailable this cycle/);
    assert.match(r.errors[0], /skipping/);
    assert.ok(!r.errors[0].includes("\n"), "errors[] entry must be one line");
    const log = stderrWrites.join("");
    assert.match(log, /outgoing-dms unavailable this cycle/);
    assert.doesNotMatch(log, /Traceback/, "python traceback must not reach the log");
    const failureLines = stderrWrites.filter((l) => l.includes("spawn failed"));
    assert.equal(failureLines.length, 1, "exactly one concise failure line");
  });
});
