import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchAuthoritativeGhosted,
  parseAuthoritativeGhosted,
  stripInvalidGhosted,
  type GhostedEntry,
} from "../src/ghosted-filter.js";
import { localScanTimestamp } from "../src/outgoing-dms-cache.js";

describe("parseAuthoritativeGhosted", () => {
  it("parses the pipe-delimited output of `imessage-scan --ghosted --resolve-names`", () => {
    const raw = [
      "2026-04-22 06:28:03|+14793883842|Please accept our apologies",
      "2026-04-21 13:43:54|+15014708008|No pickleball tn?",
      "2026-04-21 17:13:28|+15017338844|👍",
    ].join("\n");
    const entries = parseAuthoritativeGhosted(raw);
    assert.equal(entries.length, 3);
    assert.equal(entries[0].phone, "+14793883842");
    assert.equal(entries[1].phone, "+15014708008");
  });

  it("extracts the PersonName prefix when --resolve-names injected one", () => {
    const raw = "2026-04-21 22:15:54|+15012695797|Miguel Thorpe — Might need to cop one";
    const entries = parseAuthoritativeGhosted(raw);
    assert.equal(entries[0].name, "Miguel Thorpe");
    assert.equal(entries[0].phone, "+15012695797");
  });

  it("handles lines without name prefix gracefully", () => {
    const raw = "2026-04-21 13:43:54|+15014708008|No pickleball tn?";
    const entries = parseAuthoritativeGhosted(raw);
    assert.equal(entries[0].name, undefined);
    assert.equal(entries[0].phone, "+15014708008");
  });

  it("returns empty array for empty / malformed input", () => {
    assert.deepEqual(parseAuthoritativeGhosted(""), []);
    assert.deepEqual(parseAuthoritativeGhosted("garbage"), []);
    assert.deepEqual(parseAuthoritativeGhosted("one|only"), []);
  });
});

describe("stripInvalidGhosted", () => {
  const output = `# Morning Brief

## 🪨 Top priority: Fix X

## 👻 Ghosted:
• Miguel — last text 10pm was casual but 4:08pm Matt Carpenter ask unanswered
• +15014708008 — pickleball confirm
• Mike Salem — acquisition MNDA, new loop
• Nathaniel Watts — reel link shared

## 📍 First presence: Alex at 8am

## 🚨 Overnight: Lane Long forwarded request`;

  it("strips bullets whose name/phone doesn't appear in the authoritative list", () => {
    const authoritative: GhostedEntry[] = [
      { timestamp: "2026-04-21", phone: "+15014708008", name: undefined, text: "pickleball" },
    ];
    const filtered = stripInvalidGhosted(output, authoritative);
    const ghostedSection = filtered.split("## 👻")[1]?.split("##")[0] ?? "";
    assert.ok(ghostedSection.includes("15014708008"), "authoritative phone must survive");
    assert.ok(!ghostedSection.toLowerCase().includes("miguel"), "Miguel not in authoritative — strip");
    assert.ok(!ghostedSection.toLowerCase().includes("nathaniel"), "Nathaniel not authoritative — strip");
    assert.ok(!ghostedSection.toLowerCase().includes("mike salem"), "Mike Salem not authoritative — strip");
  });

  it("keeps bullets that match by name OR by phone", () => {
    const authoritative: GhostedEntry[] = [
      { timestamp: "2026-04-21", phone: "+15012695797", name: "Miguel Thorpe", text: "..." },
    ];
    const filtered = stripInvalidGhosted(output, authoritative);
    const ghostedSection = filtered.split("## 👻")[1]?.split("##")[0] ?? "";
    assert.ok(ghostedSection.toLowerCase().includes("miguel"), "name match — keep");
  });

  it("strips ALL bullets when authoritative list is empty", () => {
    const filtered = stripInvalidGhosted(output, []);
    const ghostedSection = filtered.split("## 👻")[1]?.split("##")[0] ?? "";
    // Section header + separator survive, but every bullet is gone
    assert.ok(!ghostedSection.includes("Miguel"));
    assert.ok(!ghostedSection.includes("+15014708008"));
    assert.ok(!ghostedSection.includes("Nathaniel"));
  });

  it("leaves non-Ghosted sections alone", () => {
    const authoritative: GhostedEntry[] = [];
    const filtered = stripInvalidGhosted(output, authoritative);
    assert.ok(filtered.includes("Top priority"));
    assert.ok(filtered.includes("First presence"));
    assert.ok(filtered.includes("Lane Long"));
  });

  it("preserves the Ghosted section header even when every bullet is stripped", () => {
    const filtered = stripInvalidGhosted(output, []);
    assert.ok(filtered.includes("## 👻 Ghosted"));
  });

  it("handles nested continuation lines (prose under a bullet)", () => {
    const nested = `## 👻 Ghosted:
• Miguel — first line
  additional context on second line
  more context on third
• +15014708008 — pickleball

## Next Section`;
    const authoritative: GhostedEntry[] = [
      { timestamp: "x", phone: "+15014708008", text: "" },
    ];
    const filtered = stripInvalidGhosted(nested, authoritative);
    assert.ok(!filtered.includes("additional context on second line"));
    assert.ok(filtered.includes("15014708008"));
  });
});

describe("fetchAuthoritativeGhosted — cache-first (FDA-safe)", () => {
  let home: string;
  let stderrWrites: string[];
  let origWrite: typeof process.stderr.write;

  const hoursAgoTs = (h: number) => localScanTimestamp(new Date(Date.now() - h * 3_600_000));

  const writeCache = (obj: unknown) => {
    writeFileSync(
      join(home, "workspace", "memory", "ghosted-cache.json"),
      JSON.stringify(obj),
    );
  };

  const installFakeScan = (script: string): string => {
    const toolsDir = join(home, "workspace", "tools");
    mkdirSync(toolsDir, { recursive: true });
    const path = join(toolsDir, "imessage-scan");
    writeFileSync(path, script, { mode: 0o755 });
    return path;
  };

  const failingScanWithTraceback = () => installFakeScan(
    `#!/bin/sh
cat >&2 <<'EOF'
Traceback (most recent call last):
  File "/x/imessage-scan", line 464, in <module>
    main()
sqlite3.OperationalError: sqlite-open(rc=23): authorization denied
EOF
exit 1
`,
  );

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ghosted-fetch-"));
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

  it("serves a fresh ghosted-cache.json (rows shape) without spawning", async () => {
    writeCache({
      generated_at: new Date().toISOString(),
      ok: true,
      exit: 0,
      rows: [
        `${hoursAgoTs(2)}|+15012695797|Miguel Thorpe — Might need to cop one`,
        `${hoursAgoTs(5)}|+15014708008|No pickleball tn?`,
      ],
      error: "",
    });
    // No imessage-scan installed — a spawn attempt would fail.
    const entries = await fetchAuthoritativeGhosted({ maxosHome: home, hours: 24 });
    assert.ok(entries, "fresh cache must yield a non-null list");
    assert.equal(entries.length, 2);
    assert.equal(entries[0].name, "Miguel Thorpe");
    assert.equal(entries[1].phone, "+15014708008");
    const log = stderrWrites.join("");
    assert.match(log, /via cache/, "cache hit must be logged loudly");
  });

  it("stale cache falls back to spawn, loudly", async () => {
    installFakeScan(
      `#!/bin/sh\necho "${hoursAgoTs(1)}|+15015551234|spawn-marker text"\n`,
    );
    writeCache({
      generated_at: new Date(Date.now() - 46 * 60 * 1000).toISOString(),  // 46 min → stale
      ok: true,
      rows: [`${hoursAgoTs(1)}|+15012695797|cache-marker text`],
    });
    const entries = await fetchAuthoritativeGhosted({ maxosHome: home, hours: 24 });
    assert.ok(entries);
    assert.equal(entries.length, 1);
    assert.match(entries[0].text, /spawn-marker/);
    const log = stderrWrites.join("");
    assert.match(log, /via spawn \(cache missing\/stale\)/);
  });

  it("hours beyond the cache window falls back to spawn", async () => {
    installFakeScan(
      `#!/bin/sh\necho "${hoursAgoTs(1)}|+15015551234|spawn-marker text"\n`,
    );
    writeCache({
      generated_at: new Date().toISOString(),
      ok: true,
      rows: [`${hoursAgoTs(1)}|+15012695797|cache-marker text`],
    });
    const entries = await fetchAuthoritativeGhosted({ maxosHome: home, hours: 72 });
    assert.ok(entries);
    assert.match(entries[0].text, /spawn-marker/);
  });

  it("--since queries bypass the cache (cache can't answer arbitrary since)", async () => {
    installFakeScan(
      `#!/bin/sh\necho "${hoursAgoTs(1)}|+15015551234|spawn-marker text"\n`,
    );
    writeCache({
      generated_at: new Date().toISOString(),
      ok: true,
      rows: [`${hoursAgoTs(1)}|+15012695797|cache-marker text`],
    });
    const entries = await fetchAuthoritativeGhosted({ maxosHome: home, since: "2026-01-01" });
    assert.ok(entries);
    assert.match(entries[0].text, /spawn-marker/);
  });

  it("cache stale AND spawn failed → null sentinel + ONE concise line, no traceback", async () => {
    failingScanWithTraceback();
    // No cache file at all — the missing/stale path.
    const entries = await fetchAuthoritativeGhosted({ maxosHome: home, hours: 24 });
    assert.equal(entries, null, "total failure must be a null sentinel, not [] (which wipes the section)");
    const log = stderrWrites.join("");
    assert.match(log, /ghosted unavailable this cycle/);
    assert.doesNotMatch(log, /Traceback/, "python traceback must not reach the log");
    const failureLines = stderrWrites.filter((l) => l.includes("spawn failed"));
    assert.equal(failureLines.length, 1, "exactly one concise failure line");
  });
});
