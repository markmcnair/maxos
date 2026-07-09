import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  normalizePhone,
  buildDossierPhoneIndex,
  matchDossierByPhone,
  parseOutgoingDmLine,
  isReactionText,
  formatClosureLine,
  filterNewEntries,
  appendClosures,
  runClosureWatcher,
  type OutgoingMessage,
  type ClosureMatch,
} from "../src/closure-watcher.js";
import type { Dossier } from "../src/calendar-brief.js";

describe("normalizePhone", () => {
  it("strips all non-digits", () => {
    assert.equal(normalizePhone("(501) 269-5797"), "5012695797");
    assert.equal(normalizePhone("+1-501-269-5797"), "15012695797");
    assert.equal(normalizePhone("501.269.5797"), "5012695797");
  });

  it("strips leading US country code for comparison consistency", () => {
    // Both should normalize to comparable forms
    const a = normalizePhone("+15012695797");
    const b = normalizePhone("5012695797");
    assert.equal(a.slice(-10), b.slice(-10), "last 10 digits must match");
  });

  it("returns empty string for empty input", () => {
    assert.equal(normalizePhone(""), "");
    assert.equal(normalizePhone(undefined as any), "");
  });

  it("handles email addresses gracefully (returns empty)", () => {
    assert.equal(normalizePhone("user@example.com"), "");
  });
});

describe("buildDossierPhoneIndex / matchDossierByPhone", () => {
  const dossiers: Dossier[] = [
    { name: "Miguel Thorpe", firstName: "Miguel", orbit: "The Chosen", phone: "501-269-5797", path: "x.md", excerpt: "" },
    { name: "Daniel McNair", firstName: "Daniel", orbit: "The Chosen", phone: "+1-501-764-6415", path: "y.md", excerpt: "" },
    { name: "No Phone Person", firstName: "NoPhone", orbit: "Network", phone: undefined, path: "z.md", excerpt: "" },
  ];

  it("indexes only dossiers with phone numbers", () => {
    const idx = buildDossierPhoneIndex(dossiers);
    assert.equal(idx.size, 2);
  });

  it("matches by various formats — canonical last-10-digits lookup", () => {
    const idx = buildDossierPhoneIndex(dossiers);
    assert.equal(matchDossierByPhone("+15012695797", idx)?.name, "Miguel Thorpe");
    assert.equal(matchDossierByPhone("501-269-5797", idx)?.name, "Miguel Thorpe");
    assert.equal(matchDossierByPhone("5012695797", idx)?.name, "Miguel Thorpe");
    assert.equal(matchDossierByPhone("(501) 269-5797", idx)?.name, "Miguel Thorpe");
  });

  it("returns null when phone is not in the index", () => {
    const idx = buildDossierPhoneIndex(dossiers);
    assert.equal(matchDossierByPhone("+15551234567", idx), null);
  });

  it("ignores empty / undefined phone inputs", () => {
    const idx = buildDossierPhoneIndex(dossiers);
    assert.equal(matchDossierByPhone("", idx), null);
  });
});

describe("parseOutgoingDmLine", () => {
  it("parses timestamp|recipient|text format", () => {
    const msg = parseOutgoingDmLine("2026-04-21 13:03:22|+19014973230|You close?");
    assert.ok(msg);
    assert.equal(msg.timestamp, "2026-04-21 13:03:22");
    assert.equal(msg.recipient, "+19014973230");
    assert.equal(msg.text, "You close?");
  });

  it("preserves pipes inside the message text", () => {
    const msg = parseOutgoingDmLine("2026-04-21 13:03:22|+19014973230|a | b | c");
    assert.ok(msg);
    assert.equal(msg.text, "a | b | c");
  });

  it("returns null for malformed lines", () => {
    assert.equal(parseOutgoingDmLine(""), null);
    assert.equal(parseOutgoingDmLine("no pipes here"), null);
    assert.equal(parseOutgoingDmLine("one|only"), null);
  });
});

describe("isReactionText", () => {
  it("detects iMessage tapback reactions", () => {
    assert.ok(isReactionText('Liked "photo"'));
    assert.ok(isReactionText("Loved an image"));
    assert.ok(isReactionText("Laughed at an image"));
    assert.ok(isReactionText("Emphasized \u201csomething\u201d"));
  });

  it("does not flag regular messages", () => {
    assert.ok(!isReactionText("You close?"));
    assert.ok(!isReactionText("Thanks for the update!"));
    assert.ok(!isReactionText("I liked that a lot"));
  });
});

describe("formatClosureLine", () => {
  it("produces `- [HH:MM] [CLOSURE] texted PersonName — text`", () => {
    const match: ClosureMatch = {
      message: { timestamp: "2026-04-21 13:03:22", recipient: "+19014973230", text: "You close?" },
      dossier: { name: "Josh Croom", firstName: "Josh", orbit: "The Network", phone: "+19014973230", path: "", excerpt: "" },
    };
    const line = formatClosureLine(match);
    assert.equal(line, "- [13:03] [CLOSURE] texted Josh Croom — You close?");
  });

  it("truncates long message text to ~100 chars", () => {
    const longText = "x".repeat(500);
    const match: ClosureMatch = {
      message: { timestamp: "2026-04-21 13:03:22", recipient: "+19014973230", text: longText },
      dossier: { name: "Josh", firstName: "Josh", orbit: "Network", phone: "+19014973230", path: "", excerpt: "" },
    };
    const line = formatClosureLine(match);
    assert.ok(line.length < 200);
    assert.ok(line.endsWith("…"));
  });

  it("replaces newlines with spaces so the line stays single-line", () => {
    const match: ClosureMatch = {
      message: { timestamp: "2026-04-21 13:03:22", recipient: "+19014973230", text: "line 1\nline 2\nline 3" },
      dossier: { name: "Josh", firstName: "Josh", orbit: "Network", phone: "+19014973230", path: "", excerpt: "" },
    };
    const line = formatClosureLine(match);
    assert.ok(!line.includes("\n"));
  });
});

describe("filterNewEntries", () => {
  it("returns all entries when the existing log is empty", () => {
    const entries = ["- [13:03] [CLOSURE] texted Josh Croom — hi"];
    assert.deepEqual(filterNewEntries(entries, ""), entries);
  });

  it("skips entries whose exact line already exists", () => {
    const existing = "- [13:03] [CLOSURE] texted Josh Croom — hi\n";
    const entries = [
      "- [13:03] [CLOSURE] texted Josh Croom — hi",
      "- [14:00] [CLOSURE] texted Daniel — ok",
    ];
    assert.deepEqual(filterNewEntries(entries, existing), [entries[1]]);
  });

  it("compares on trimmed content", () => {
    const existing = "- [13:03] [CLOSURE] texted Josh Croom — hi\n";
    const entries = ["  - [13:03] [CLOSURE] texted Josh Croom — hi  "];
    assert.deepEqual(filterNewEntries(entries, existing), []);
  });
});

describe("appendClosures", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "closure-watcher-"));
    mkdirSync(join(home, "workspace", "memory"), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("creates today's closures file when it doesn't exist", () => {
    const date = new Date(2026, 3, 21);
    appendClosures(home, date, ["- [13:03] [CLOSURE] texted Josh Croom — hi"]);
    const path = join(home, "workspace", "memory", "closures-2026-04-21.md");
    assert.ok(existsSync(path));
    const content = readFileSync(path, "utf-8");
    assert.ok(content.includes("Josh Croom"));
  });

  it("appends to existing file without dup", () => {
    const date = new Date(2026, 3, 21);
    const path = join(home, "workspace", "memory", "closures-2026-04-21.md");
    writeFileSync(path, "- [10:00] [CLOSURE] earlier entry\n");
    appendClosures(home, date, [
      "- [10:00] [CLOSURE] earlier entry",  // dup — should skip
      "- [13:03] [CLOSURE] texted Josh — hi",
    ]);
    const content = readFileSync(path, "utf-8");
    assert.equal(content.match(/earlier entry/g)?.length, 1, "should not duplicate");
    assert.ok(content.includes("Josh"));
  });

  it("no-ops when given empty entry list", () => {
    const date = new Date(2026, 3, 21);
    appendClosures(home, date, []);
    const path = join(home, "workspace", "memory", "closures-2026-04-21.md");
    assert.equal(existsSync(path), false);
  });
});

describe("runClosureWatcher — outgoing-dms cache (FDA-safe path)", () => {
  let home: string;

  // The dossier phone matches the cache lines below (last-10-digits key).
  const writeDossier = () => {
    mkdirSync(join(home, "vault", "Relationships"), { recursive: true });
    writeFileSync(
      join(home, "vault", "Relationships", "miguel-thorpe.md"),
      "---\nname: Miguel Thorpe\norbit: The Chosen\nphone: 501-269-5797\n---\n\nBody.\n",
    );
  };

  const writeCache = (obj: unknown) => {
    writeFileSync(
      join(home, "workspace", "memory", "outgoing-dms-cache.json"),
      JSON.stringify(obj),
    );
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "watcher-cache-"));
    mkdirSync(join(home, "workspace", "memory"), { recursive: true });
    writeDossier();
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("cache hit: derives closures from a fresh cache without spawning imessage-scan", async () => {
    const now = new Date("2026-05-01T12:00:00");  // local
    writeCache({
      generated_at: now.toISOString(),
      ok: true,
      exit: 0,
      hours: 168,
      lines: [
        "2026-05-01 11:50:00|+15012695797|Deposit sent, we're square",
        "and thanks again for waiting",  // continuation line — no ts|recipient| prefix
        "2026-05-01 11:51:00|+15012695797|Loved “ok”",  // tapback — must be filtered
        "2026-04-28 09:00:00|+15012695797|old message outside the 15-min window",
      ],
    });

    const result = await runClosureWatcher({
      maxosHome: home,
      vaultRoot: join(home, "vault"),
      hours: 0.25,
      imessageScan: "/nonexistent/imessage-scan",  // spawn would fail — cache must serve
      now,
    });

    assert.equal(result.written, 1);
    const content = readFileSync(
      join(home, "workspace", "memory", "closures-2026-05-01.md"),
      "utf-8",
    );
    assert.ok(content.includes("- [11:50] [CLOSURE] texted Miguel Thorpe — Deposit sent, we're square"));
    assert.ok(!content.includes("Loved"), "tapback reactions from cache must be filtered");
    assert.ok(!content.includes("old message"), "messages outside the window must be filtered");
  });

  it("anchors the window at generated_at, not now — a lagging cache still yields recent closures", async () => {
    // Cache generated 30 min ago (fresh, < 45 min). Message sent 35 min ago:
    // inside [generated_at - 15 min, generated_at], but a now-anchored 15-min
    // window would slide past it and silently drop the closure.
    const now = new Date("2026-05-01T12:00:00");
    const gen = new Date("2026-05-01T11:30:00");
    writeCache({
      generated_at: gen.toISOString(),
      ok: true,
      hours: 168,
      lines: ["2026-05-01 11:25:00|+15012695797|Confirmed for Friday"],
    });

    const result = await runClosureWatcher({
      maxosHome: home,
      vaultRoot: join(home, "vault"),
      hours: 0.25,
      imessageScan: "/nonexistent/imessage-scan",
      now,
    });

    assert.equal(result.written, 1);
  });

  it("stale cache falls back to spawn (here: failing spawn → no closures)", async () => {
    const now = new Date("2026-05-01T12:00:00");
    const gen = new Date(now.getTime() - 46 * 60 * 1000);  // 46 min old → stale
    writeCache({
      generated_at: gen.toISOString(),
      ok: true,
      hours: 168,
      lines: ["2026-05-01 11:50:00|+15012695797|Would match if the cache were fresh"],
    });

    const result = await runClosureWatcher({
      maxosHome: home,
      vaultRoot: join(home, "vault"),
      hours: 0.25,
      imessageScan: "/nonexistent/imessage-scan",
      now,
    });

    assert.equal(result.written, 0, "stale cache must not be used");
  });

  it("requested window older than the cache window falls back to spawn", async () => {
    const now = new Date("2026-05-01T12:00:00");
    writeCache({
      generated_at: now.toISOString(),
      ok: true,
      hours: 168,  // cache covers 7 days
      lines: ["2026-05-01 11:50:00|+15012695797|Recent message"],
    });

    const result = await runClosureWatcher({
      maxosHome: home,
      vaultRoot: join(home, "vault"),
      hours: 200,  // > 168 — cache can't cover this lookback
      imessageScan: "/nonexistent/imessage-scan",
      now,
    });

    assert.equal(result.written, 0, "out-of-window request must not be served from cache");
  });

  it("ok:false cache (agent's scan failed) falls back to spawn", async () => {
    const now = new Date("2026-05-01T12:00:00");
    writeCache({
      generated_at: now.toISOString(),
      ok: false,
      hours: 168,
      lines: ["2026-05-01 11:50:00|+15012695797|Should be ignored"],
      error: "sqlite-open(rc=23): authorization denied",
    });

    const result = await runClosureWatcher({
      maxosHome: home,
      vaultRoot: join(home, "vault"),
      hours: 0.25,
      imessageScan: "/nonexistent/imessage-scan",
      now,
    });

    assert.equal(result.written, 0, "ok:false cache must not be trusted");
  });
});

describe("runClosureWatcher — periodic prune against dropped-loops.md (Round O)", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "watcher-prune-"));
    mkdirSync(join(home, "workspace", "memory"), { recursive: true });
    mkdirSync(join(home, "vault"), { recursive: true });  // empty vault for loadDossiers
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("prunes open-loops.json against dropped-loops.md on every cycle (catches LLM re-adds within 15 min)", async () => {
    // Bug scenario: Mark deletes the KCR Google Task on Tuesday. Reconciler
    // writes to dropped-loops.md. On Wednesday afternoon, the granola sync
    // surfaces a meeting where KCR comes up; the LLM-driven debrief
    // re-extracts the loop with a slightly-different id and writes it back
    // to open-loops.json. Without periodic prune, that loop survives until
    // daemon restart. With periodic prune, the next 15-minute cycle kills
    // it before the morning brief sees it.
    writeFileSync(
      join(home, "workspace", "memory", "dropped-loops.md"),
      `# Dropped Loops

## Active Drops

- **KCR wholesale ordering system v1** (Mark) — dropped 2026-04-30 via Google Task deletion. Reason: deleted. (loop:kcr-wholesale-ordering-v1)
`,
    );
    writeFileSync(
      join(home, "workspace", "memory", "open-loops.json"),
      JSON.stringify(
        [
          {
            id: "kcr-wholesale-rebuild-v2",  // different id, same topic family
            topic: "KCR wholesale ordering rebuild",
            person: "Mark",
            firstSeen: "2026-05-01",
            lastUpdated: "2026-05-01",
          },
          {
            id: "unrelated-loop",
            topic: "Unrelated topic",
            firstSeen: "2026-05-01",
            lastUpdated: "2026-05-01",
          },
        ],
        null,
        2,
      ),
    );

    await runClosureWatcher({
      maxosHome: home,
      vaultRoot: join(home, "vault"),
      hours: 0.25,
      imessageScan: "/nonexistent/imessage-scan",  // forces fetchOutgoingDms to return []
      now: new Date("2026-05-01T12:00:00"),
    });

    const after = JSON.parse(
      readFileSync(join(home, "workspace", "memory", "open-loops.json"), "utf-8"),
    );
    assert.equal(after.length, 1, "KCR re-add should be pruned, leaving only the unrelated loop");
    assert.equal(after[0].id, "unrelated-loop");
  });

  it("does not touch open-loops.json when dropped-loops.md is missing", async () => {
    // Defensive: if there's no dropped-loops.md, the prune is a no-op.
    writeFileSync(
      join(home, "workspace", "memory", "open-loops.json"),
      JSON.stringify(
        [{ id: "x", topic: "X", firstSeen: "2026-05-01", lastUpdated: "2026-05-01" }],
        null,
        2,
      ),
    );

    await runClosureWatcher({
      maxosHome: home,
      vaultRoot: join(home, "vault"),
      hours: 0.25,
      imessageScan: "/nonexistent/imessage-scan",
      now: new Date("2026-05-01T12:00:00"),
    });

    const after = JSON.parse(
      readFileSync(join(home, "workspace", "memory", "open-loops.json"), "utf-8"),
    );
    assert.equal(after.length, 1);
    assert.equal(after[0].id, "x");
  });
});

describe("runClosureWatcher — graceful spawn fallback (FDA-denied traceback stays out of the log)", () => {
  let home: string;
  let stderrWrites: string[];
  let origWrite: typeof process.stderr.write;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "watcher-fallback-"));
    mkdirSync(join(home, "workspace", "memory"), { recursive: true });
    mkdirSync(join(home, "vault"), { recursive: true });
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
    // Fake imessage-scan reproducing the FDA-denied failure inside the
    // gateway: full python traceback on stderr, nonzero exit. The cron log
    // used to receive the whole traceback and healthcheck alarmed for hours.
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
    const result = await runClosureWatcher({
      maxosHome: home,
      vaultRoot: join(home, "vault"),
      hours: 0.25,
      imessageScan: fake,
    });
    assert.equal(result.written, 0, "cycle skips cleanly, no throw");
    const log = stderrWrites.join("");
    assert.match(log, /outgoing-dms unavailable this cycle/);
    assert.match(log, /skipping/);
    assert.doesNotMatch(log, /Traceback/, "python traceback must not reach the log");
    const failureLines = stderrWrites.filter((l) => l.includes("spawn failed"));
    assert.equal(failureLines.length, 1, "exactly one concise failure line");
  });
});
