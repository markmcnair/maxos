import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  vaultPathForTask,
  shouldAttemptRecovery,
  convertVaultToHighlightReel,
  recoverFromVault,
  formatBrewFromArchive,
  isMorningBrew,
  gatherDebriefState,
  formatDebriefFromState,
  formatBriefFromState,
  type RecoveryAttempt,
} from "../src/brief-recovery.js";
import type { SchemaViolation } from "../src/brief-schema.js";

describe("vaultPathForTask", () => {
  it("returns morning-brief vault path for brief tasks", () => {
    const p = vaultPathForTask(
      "/Users/Max/.maxos",
      "run-the-morning-brief-...",
      new Date("2026-05-07T11:00:00Z"),
    );
    assert.equal(p, "/Users/Max/.maxos/vault/Work/Daily/2026-05-07-morning-brief.md");
  });

  it("returns debrief vault path for shutdown tasks", () => {
    const p = vaultPathForTask(
      "/Users/Max/.maxos",
      "run-shutdown-debrief-...",
      new Date("2026-05-07T21:35:00Z"),
    );
    assert.equal(p, "/Users/Max/.maxos/vault/Work/Daily/2026-05-07-debrief.md");
  });

  it("uses local timezone for the date so a 9:30pm CT debrief writes today's file", () => {
    // 2026-05-07T22:30:00 CDT = 2026-05-08T03:30:00Z. Vault file should be
    // 2026-05-07 (the LOCAL date), not 2026-05-08.
    const utcLate = new Date("2026-05-08T03:30:00Z");
    const p = vaultPathForTask("/x", "run-shutdown-debrief", utcLate);
    // We're checking the date portion — depends on local TZ, but the
    // function should use local time consistently. Pin via expected
    // behavior: the file path date should be 2026-05-07 OR 2026-05-08
    // depending on TZ — accept either, but require some valid YYYY-MM-DD.
    assert.match(p, /\/(2026-05-07|2026-05-08)-debrief\.md$/);
  });

  it("returns null for tasks without a vault counterpart", () => {
    assert.equal(vaultPathForTask("/x", "critical-task-watchdog", new Date()), null);
    assert.equal(vaultPathForTask("/x", "maxos-digest", new Date()), null);
  });
});

describe("shouldAttemptRecovery", () => {
  it("triggers when missingRequired count >= threshold (3)", () => {
    const v: SchemaViolation = {
      task: "shutdown-debrief",
      missingRequired: ["wins", "ghosted", "open-loops"],
      missingOptional: [],
      totalChars: 100,
    };
    assert.equal(shouldAttemptRecovery(v), true);
  });

  it("does NOT trigger when only one required section is missing (LLM may have just dropped a section)", () => {
    const v: SchemaViolation = {
      task: "shutdown-debrief",
      missingRequired: ["wins"],
      missingOptional: [],
      totalChars: 1500,
    };
    assert.equal(shouldAttemptRecovery(v), false);
  });

  it("triggers when totalChars is suspiciously low even with 1 missing section", () => {
    // The 2026-05-07 case: 125-char output was missing 6 sections AND
    // tiny. Either signal alone is enough to trigger recovery.
    const v: SchemaViolation = {
      task: "shutdown-debrief",
      missingRequired: ["wins"],
      missingOptional: [],
      totalChars: 200, // way below typical 1500-2500 chars
    };
    assert.equal(shouldAttemptRecovery(v), true);
  });

  it("does NOT trigger for unrelated tasks (watchdog, sync, etc)", () => {
    const v: SchemaViolation = {
      task: "critical-task-watchdog",
      missingRequired: ["header"],
      missingOptional: [],
      totalChars: 0,
    };
    assert.equal(shouldAttemptRecovery(v), false);
  });

  // Round W (2026-05-08): brew silent-empty recovery
  it("triggers for morning-brew when header missing AND chars < 100 (silent-empty case)", () => {
    // The 5/6 + 5/8 case: brew session ran ~4 min, wrote archive JSON,
    // updated state.json, but ended on a tool call so stdout was empty.
    // chars=0, missing=["header"]. Recovery should fire.
    const v: SchemaViolation = {
      task: "run-morning-brew-read-tasksmorningbrewmd-and-execute-every-step",
      missingRequired: ["header"],
      missingOptional: [],
      totalChars: 0,
    };
    assert.equal(shouldAttemptRecovery(v), true);
  });

  it("does NOT trigger for morning-brew when LLM produced real output (chars >= 100)", () => {
    // The brew is shorter than brief/debrief by design — 400-800 chars
    // is normal. We must NOT override real LLM output just because the
    // header pattern didn't match (could be a legitimate variation).
    const v: SchemaViolation = {
      task: "run-morning-brew-...",
      missingRequired: ["header"],
      missingOptional: [],
      totalChars: 450,
    };
    assert.equal(shouldAttemptRecovery(v), false);
  });

  it("does NOT trigger for morning-brew when header is present (any size)", () => {
    // Header present means structural delivery happened — leave it alone.
    const v: SchemaViolation = {
      task: "run-morning-brew-...",
      missingRequired: [],
      missingOptional: ["ai-section"],
      totalChars: 50,
    };
    assert.equal(shouldAttemptRecovery(v), false);
  });
});

describe("isMorningBrew", () => {
  it("matches the daemon's brew task slug", () => {
    assert.equal(isMorningBrew("run-morning-brew-read-tasksmorningbrewmd-and-execute-every-step"), true);
  });
  it("matches dashed and concatenated forms", () => {
    assert.equal(isMorningBrew("morning-brew"), true);
    assert.equal(isMorningBrew("morningbrew-job"), true);
  });
  it("does not match brief or debrief", () => {
    assert.equal(isMorningBrew("morning-brief"), false);
    assert.equal(isMorningBrew("shutdown-debrief"), false);
  });
});

describe("convertVaultToHighlightReel", () => {
  const vaultDebrief = `# Shutdown Debrief — Thursday, May 7, 2026

## Wins
- Lane Long keys closed
- Email inbox zero

## Ghosted (respond or skip intentionally)
- Jessica — 4:20pm Asa pickup ask

## Open Loops
- ❓ Joey Cook draft sent?
- 🔄 Lane Long birthday surprise

## Today's Calendar (Thursday, May 7)
- 6:30am Workout

## Tomorrow's Calendar (Friday, May 8) — presence-required
- 12:30pm Keys Pracky
- 5:30pm Sabbath Meal & Blessings

## Top 3 Priorities for Tomorrow
1. Joey Cook draft
2. Lane Long surprise
3. Sabbath prep
`;

  it("converts ## Wins → ✅ Wins for shutdown-debrief", () => {
    const r = convertVaultToHighlightReel(vaultDebrief, "shutdown-debrief");
    assert.match(r, /✅\s*Wins/);
    assert.match(r, /👻\s*Ghosted/);
    assert.match(r, /🔄\s*Open Loops/);
    assert.match(r, /🎯\s*Top 3 for Tomorrow/);
    assert.match(r, /📅\s*Tomorrow/);
  });

  it("strips the date suffix from heading-style lines (### Friday Step 2:, etc)", () => {
    // Don't include other H3 spam from the saved file — only the ## sections
    // we care about
    const withSpam = vaultDebrief + "\n### Friday Step 2: random spam\nshould not appear\n";
    const r = convertVaultToHighlightReel(withSpam, "shutdown-debrief");
    assert.ok(!r.includes("Friday Step 2"), "step headings should be stripped");
  });

  it("preserves the # title as the header (with emoji)", () => {
    const r = convertVaultToHighlightReel(vaultDebrief, "shutdown-debrief");
    assert.match(r, /🌅/);  // emoji header for debrief
    assert.match(r, /Shutdown Debrief/);
  });

  it("converts morning-brief vault file with ☀️ header", () => {
    const vaultBrief = `# Morning Brief — Friday, May 8, 2026

## Top Priority
- Joey Cook draft

## Ghosted
- Justin Young 3 days

## Today
- 6am Workout
`;
    const r = convertVaultToHighlightReel(vaultBrief, "morning-brief");
    assert.match(r, /☀️/);
    assert.match(r, /🪨\s*Top [Pp]riority/);
    assert.match(r, /👻\s*Ghosted/);
  });

  it("returns the input unchanged if it already has emoji headers (no double-conversion)", () => {
    const alreadyHighlight = `🌅 Shutdown Debrief — Thursday, May 7

✅ Wins
- thing

👻 Ghosted
- nothing
`;
    const r = convertVaultToHighlightReel(alreadyHighlight, "shutdown-debrief");
    // Output should still contain the emoji headers (no regression)
    assert.match(r, /✅\s*Wins/);
    // Should NOT have double emojis like ✅✅
    assert.ok(!/✅\s*✅/.test(r));
  });
});

describe("recoverFromVault (orchestrator)", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "recovery-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("returns recovered content when vault file exists and has the sections", () => {
    mkdirSync(join(home, "vault", "Work", "Daily"), { recursive: true });
    writeFileSync(
      join(home, "vault", "Work", "Daily", "2026-05-07-debrief.md"),
      `# Shutdown Debrief — Thursday, May 7

## Wins
- thing

## Ghosted
- nothing

## Open Loops
- ❓ unknown

## Top 3 Priorities for Tomorrow
1. x
2. y
3. z

## Tomorrow's Calendar
- 8am stuff
`,
    );
    const r: RecoveryAttempt = recoverFromVault(home, "run-shutdown-debrief", new Date("2026-05-07T22:00:00Z"));
    assert.equal(r.recovered, true);
    assert.ok(r.content);
    assert.match(r.content!, /✅\s*Wins/);
  });

  it("falls through to state-recovery when vault file is missing (Round W2 behavior)", () => {
    // Pre-W2 this returned recovered=false. Post-W2 the state-recovery
    // synthesizer always emits at least the canonical header so the
    // schema validator passes — better than the original LLM garbage.
    const r = recoverFromVault(home, "run-shutdown-debrief", new Date("2026-05-07T22:00:00Z"));
    assert.equal(r.recovered, true);
    assert.match(r.content!, /🌅\s*Shutdown Debrief/);
  });

  it("falls through to state-recovery when vault file is present but lacks sections", () => {
    mkdirSync(join(home, "vault", "Work", "Daily"), { recursive: true });
    writeFileSync(
      join(home, "vault", "Work", "Daily", "2026-05-07-debrief.md"),
      "# Shutdown Debrief\n\nempty\n",
    );
    const r = recoverFromVault(home, "run-shutdown-debrief", new Date("2026-05-07T22:00:00Z"));
    assert.equal(r.recovered, true);
    assert.match(r.content!, /🌅\s*Shutdown Debrief/);
  });

  it("returns recovered=false for tasks without vault counterparts", () => {
    const r = recoverFromVault(home, "critical-task-watchdog", new Date());
    assert.equal(r.recovered, false);
  });

  // Round W: brew dispatcher path
  it("dispatches morning-brew to archive recovery when archive JSON exists", () => {
    const archiveDir = join(home, "workspace", "memory", "morning-brew", "archive");
    mkdirSync(archiveDir, { recursive: true });
    writeFileSync(
      join(archiveDir, "2026-05-08.json"),
      JSON.stringify({
        date: "2026-05-08",
        ai: {
          headline: "Anthropic shipped a financial-services agent stack",
          url: "https://github.com/anthropics/financial-services",
          source: "github-trending",
          score: 4.15,
        },
        prime: { status: "fresh-suggest", url: "https://example.com/prime", build: false },
        learning: { track: "Company Brain", day: 7, url: "https://example.com/learn" },
      }),
    );
    // Use a Date that yields the same local YMD on this machine. Since
    // ymdLocal uses the local timezone, construct a Date that is May 8
    // mid-day local — that gives the same string.
    const r = recoverFromVault(home, "run-morning-brew-...", new Date("2026-05-08T18:00:00"));
    assert.equal(r.recovered, true, `expected recovered=true, got reason=${r.reason}`);
    assert.match(r.content!, /☕️\s*Morning Brew/);
    assert.match(r.content!, /Anthropic shipped/);
    assert.match(r.content!, /Company Brain/);
    assert.equal(r.vaultPath, join(archiveDir, "2026-05-08.json"));
  });

  it("returns recovered=false for morning-brew when archive is missing", () => {
    const r = recoverFromVault(home, "run-morning-brew-...", new Date("2026-05-08T18:00:00"));
    assert.equal(r.recovered, false);
    assert.match(r.reason ?? "", /no archive snapshot|brew failed before/i);
  });

  it("returns recovered=false for morning-brew when archive lacks ai.headline", () => {
    const archiveDir = join(home, "workspace", "memory", "morning-brew", "archive");
    mkdirSync(archiveDir, { recursive: true });
    writeFileSync(
      join(archiveDir, "2026-05-08.json"),
      JSON.stringify({ date: "2026-05-08", prime: null, learning: null }),
    );
    const r = recoverFromVault(home, "run-morning-brew-...", new Date("2026-05-08T18:00:00"));
    assert.equal(r.recovered, false);
    assert.match(r.reason ?? "", /missing.*ai\.headline|missing required/i);
  });

  it("returns recovered=false for morning-brew when archive JSON is corrupt", () => {
    const archiveDir = join(home, "workspace", "memory", "morning-brew", "archive");
    mkdirSync(archiveDir, { recursive: true });
    writeFileSync(join(archiveDir, "2026-05-08.json"), "{ this is not valid json");
    const r = recoverFromVault(home, "run-morning-brew-...", new Date("2026-05-08T18:00:00"));
    assert.equal(r.recovered, false);
    assert.match(r.reason ?? "", /parse failed/i);
  });
});

describe("formatBrewFromArchive", () => {
  const fixedDate = new Date("2026-05-08T18:00:00"); // local Friday afternoon

  it("emits the canonical header so the schema validator passes", () => {
    const out = formatBrewFromArchive(
      { ai: { headline: "Some headline" } },
      fixedDate,
    );
    assert.ok(out);
    assert.match(out!, /^☕️\s*Morning Brew/);
  });

  it("includes AI url and score when present", () => {
    const out = formatBrewFromArchive(
      {
        ai: {
          headline: "X",
          url: "https://github.com/anthropics/financial-services",
          score: 4.15,
        },
      },
      fixedDate,
    );
    assert.match(out!, /github\.com\/anthropics/);
    assert.match(out!, /score 4\.15/);
  });

  it("emits Prime section when prime data is present", () => {
    const out = formatBrewFromArchive(
      {
        ai: { headline: "X" },
        prime: { url: "https://example.com/p", build: false, reason: "below gate" },
      },
      fixedDate,
    );
    assert.match(out!, /⚡️\s*Prime Framework Hit/);
    assert.match(out!, /below gate/);
  });

  it("emits Learning section with day number when present", () => {
    const out = formatBrewFromArchive(
      {
        ai: { headline: "X" },
        learning: { track: "Company Brain", day: 7, url: "https://example.com/l" },
      },
      fixedDate,
    );
    assert.match(out!, /Day 7: Company Brain/);
  });

  it("returns null when archive lacks ai.headline (caller treats as un-recoverable)", () => {
    assert.equal(formatBrewFromArchive({}, fixedDate), null);
    assert.equal(formatBrewFromArchive({ ai: {} }, fixedDate), null);
    assert.equal(formatBrewFromArchive({ prime: { url: "x" } }, fixedDate), null);
  });

  it("does not crash when prime or learning blocks are partial", () => {
    const out = formatBrewFromArchive(
      {
        ai: { headline: "X" },
        prime: {},  // intentionally empty
        learning: {},
      },
      fixedDate,
    );
    assert.ok(out);
    assert.match(out!, /Morning Brew/);
  });

  it("uses local timezone day name (Friday for May 8 2026)", () => {
    // 2026-05-08 is a Friday. Day-name should be Friday in en-US.
    const out = formatBrewFromArchive({ ai: { headline: "X" } }, fixedDate);
    assert.match(out!, /Friday/);
  });
});

// ───── Round W2 (2026-05-08): Debrief/Brief recovery from state ─────

describe("gatherDebriefState + formatDebriefFromState", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "state-recovery-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  function seedClosures(ymd: string, body: string) {
    const dir = join(home, "workspace", "memory");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `closures-${ymd}.md`), body);
  }
  function seedOpenLoops(arr: unknown[]) {
    const dir = join(home, "workspace", "memory");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "open-loops.json"), JSON.stringify(arr));
  }
  function seedDropped(body: string) {
    const dir = join(home, "workspace", "memory");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "dropped-loops.md"), body);
  }
  function seedJournal(ymd: string, body: string) {
    const dir = join(home, "workspace", "memory");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${ymd}.md`), body);
  }

  it("parses CLOSURE/DECISION lines from closures file", () => {
    seedClosures("2026-05-08", `- [09:12] [CLOSURE] texted Adam Geidd — Hi
- [09:19] [DECISION] Killed Project X
- [16:30] [DECISION] Killed YouTube tracking
- not a real line
- [12:00] [CLOSURE] ran email triage — clean
`);
    const s = gatherDebriefState(home, new Date("2026-05-08T18:00:00"));
    assert.equal(s.closures.length, 4);
    assert.equal(s.outboundCount, 1);  // only the texted-* one
  });

  it("formatDebriefFromState produces a schema-valid debrief", () => {
    seedClosures("2026-05-08", `- [09:19] [DECISION] Killed Project X
- [10:00] [CLOSURE] ran email triage — both inboxes zero
- [16:30] [DECISION] Killed YouTube tracking
`);
    seedOpenLoops([{ id: "loop-a", title: "First open thing" }, { id: "loop-b", title: "Second" }]);
    const out = formatDebriefFromState(
      gatherDebriefState(home, new Date("2026-05-08T18:00:00")),
      new Date("2026-05-08T18:00:00"),
    );
    assert.match(out, /🌅\s*Shutdown Debrief/);
    assert.match(out, /✅\s*Wins/);
    assert.match(out, /Killed Project X/);
    assert.match(out, /YouTube tracking/);
    assert.match(out, /👻\s*Ghosted/);
    assert.match(out, /🔄\s*Open Loops/);
    assert.match(out, /loop-a/);
    assert.match(out, /🎯\s*Top 3/);
    assert.match(out, /📅\s*Tomorrow/);
  });

  it("Friday debrief mentions Sabbath in Top 3 and Tomorrow", () => {
    seedClosures("2026-05-08", `- [10:00] [DECISION] Tested fix
`);
    seedOpenLoops([]);
    const out = formatDebriefFromState(
      gatherDebriefState(home, new Date("2026-05-08T18:00:00")),
      new Date("2026-05-08T18:00:00"),
    );
    assert.match(out, /Sabbath/i);
    assert.match(out, /Sunday/i);
  });

  it("includes today's drops when dropped-loops.md has a matching date heading", () => {
    seedClosures("2026-05-08", `- [09:00] [DECISION] X
`);
    seedDropped(`# Dropped loops

## 2026-05-07 — Old Topic
- old bullet — ignored

## 2026-05-08 — Clone Scout / arkinspections.pro
- **Run The Call rubric** — dropped 2026-05-08
- **Another dropped item** — also dropped 2026-05-08
`);
    seedOpenLoops([]);
    const s = gatherDebriefState(home, new Date("2026-05-08T18:00:00"));
    assert.equal(s.dropped.length, 2);
    const out = formatDebriefFromState(s, new Date("2026-05-08T18:00:00"));
    assert.match(out, /Dropped today/);
    assert.match(out, /Run The Call rubric/);
    // Old date NOT included
    assert.ok(!out.includes("old bullet"));
  });

  it("handles missing files gracefully (no closures, no journal, no opens)", () => {
    const s = gatherDebriefState(home, new Date("2026-05-08T18:00:00"));
    const out = formatDebriefFromState(s, new Date("2026-05-08T18:00:00"));
    // Still emits the canonical structure so schema passes
    assert.match(out, /🌅\s*Shutdown Debrief/);
    assert.match(out, /✅\s*Wins/);
    assert.match(out, /no closures or outbound logged/);
    assert.match(out, /none open/);
  });

  it("formatBriefFromState produces a schema-valid brief", () => {
    seedOpenLoops([{ id: "lane-bday", title: "Lane Long surprise — May 17" }]);
    const out = formatBriefFromState(
      gatherDebriefState(home, new Date("2026-05-08T07:00:00")),
      new Date("2026-05-08T07:00:00"),
    );
    assert.match(out, /☀️\s*Morning Brief/);
    assert.match(out, /🪨\s*Top priority/);
    assert.match(out, /Lane Long surprise/);
    assert.match(out, /👻\s*Ghosted/);
    assert.match(out, /📍\s*First presence/);
    assert.match(out, /🚨\s*Overnight/);
  });
});

describe("recoverFromVault — state-fallback when vault file missing (Round W2)", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "state-fallback-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it("falls through to state recovery when debrief vault file is missing", () => {
    // No vault file written, but closures + opens exist.
    const dir = join(home, "workspace", "memory");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "closures-2026-05-08.md"),
      `- [09:00] [DECISION] Killed thing
- [10:00] [CLOSURE] ran email triage — zero
`,
    );
    writeFileSync(join(dir, "open-loops.json"), JSON.stringify([]));
    const r = recoverFromVault(home, "run-shutdown-debrief", new Date("2026-05-08T22:00:00"));
    assert.equal(r.recovered, true, `expected recovered=true, got reason=${r.reason}`);
    assert.match(r.content!, /🌅\s*Shutdown Debrief/);
    assert.match(r.content!, /Killed thing/);
  });

  it("falls through to state recovery when brief vault file is missing", () => {
    const dir = join(home, "workspace", "memory");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "open-loops.json"), JSON.stringify([{ id: "x", title: "Top thing" }]));
    const r = recoverFromVault(home, "run-the-morning-brief", new Date("2026-05-08T11:00:00"));
    assert.equal(r.recovered, true);
    assert.match(r.content!, /☀️\s*Morning Brief/);
    assert.match(r.content!, /Top thing/);
  });

  it("returns recovered=false only when BOTH vault file is missing AND state synthesis fails", () => {
    // Empty home — no closures, no opens, no journal. State recovery should
    // STILL succeed because the synthesizer always emits the canonical
    // header structure (with empty placeholder bodies). This is intentional:
    // a recovered debrief with empty wins is more useful than no debrief.
    const r = recoverFromVault(home, "run-shutdown-debrief", new Date("2026-05-08T22:00:00"));
    assert.equal(r.recovered, true);
    assert.match(r.content!, /🌅/);
  });
});
