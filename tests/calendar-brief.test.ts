import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  extractNameTokens,
  loadDossiers,
  matchDossier,
  resolveEvent,
  type Dossier,
  type CalendarEvent,
} from "../src/calendar-brief.js";

describe("extractNameTokens", () => {
  it("splits on + separator", () => {
    assert.deepEqual(extractNameTokens("Miguel + Mark"), ["Miguel", "Mark"]);
    assert.deepEqual(extractNameTokens("Adam + Chris + Mark"), ["Adam", "Chris", "Mark"]);
  });

  it("splits on y (Spanish 'and')", () => {
    assert.deepEqual(extractNameTokens("Mark y Mark"), ["Mark", "Mark"]);
  });

  it("splits on and", () => {
    assert.deepEqual(extractNameTokens("Miguel and Mark"), ["Miguel", "Mark"]);
  });

  it("splits on slash", () => {
    assert.deepEqual(extractNameTokens("Mark / Jessica"), ["Mark", "Jessica"]);
  });

  it("strips common noise words and venues", () => {
    assert.deepEqual(extractNameTokens("Miguel + Mark @ Level Ground"), ["Miguel", "Mark"]);
    assert.deepEqual(extractNameTokens("Mark @ AIC"), ["Mark"]);
  });

  it("handles single name", () => {
    assert.deepEqual(extractNameTokens("Alfonso"), ["Alfonso"]);
  });

  it("preserves full names with spaces", () => {
    assert.deepEqual(extractNameTokens("Mark Stubblefield + Alfonso"), ["Mark Stubblefield", "Alfonso"]);
  });

  it("returns empty array for non-name events", () => {
    assert.deepEqual(extractNameTokens("Pickleball"), []);
    assert.deepEqual(extractNameTokens("Community Group"), []);
    assert.deepEqual(extractNameTokens("Workout"), []);
  });

  it("handles commas as separator", () => {
    assert.deepEqual(extractNameTokens("Adam, Chris, Mark"), ["Adam", "Chris", "Mark"]);
  });
});

describe("loadDossiers", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "dossiers-"));
    mkdirSync(join(vault, "Relationships", "The Chosen"), { recursive: true });
    mkdirSync(join(vault, "Relationships", "Inner Core"), { recursive: true });

    writeFileSync(
      join(vault, "Relationships", "The Chosen", "Miguel Thorpe.md"),
      `---
name: Miguel Thorpe
orbit: The Chosen
phone: 501-269-5797
---

# Miguel Thorpe

Coffee buddy. Grew up in Conway.`,
    );

    writeFileSync(
      join(vault, "Relationships", "The Chosen", "Mark Stubblefield.md"),
      `---
name: Mark Stubblefield
orbit: The Chosen
phone: 555-1111
---

# Mark Stubblefield`,
    );

    writeFileSync(
      join(vault, "Relationships", "Inner Core", "Jessica Hayes McNair.md"),
      `---
name: Jessica Hayes McNair
orbit: Inner Core
phone: 555-9999
---

# Jessica`,
    );
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it("loads all dossier files with parsed frontmatter", () => {
    const dossiers = loadDossiers(vault);
    assert.equal(dossiers.length, 3);
    const miguel = dossiers.find((d) => d.name === "Miguel Thorpe");
    assert.ok(miguel);
    assert.equal(miguel.orbit, "The Chosen");
    assert.equal(miguel.phone, "501-269-5797");
  });

  it("handles missing vault gracefully (returns empty array)", () => {
    const dossiers = loadDossiers("/nonexistent/path");
    assert.deepEqual(dossiers, []);
  });

  it("captures first-name index for quick lookup", () => {
    const dossiers = loadDossiers(vault);
    const miguel = dossiers.find((d) => d.name === "Miguel Thorpe");
    assert.ok(miguel);
    assert.equal(miguel.firstName, "Miguel");
  });
});

describe("matchDossier", () => {
  const dossiers: Dossier[] = [
    { name: "Miguel Thorpe", firstName: "Miguel", orbit: "The Chosen", phone: "501-269-5797", path: "x.md", excerpt: "" },
    { name: "Mark Stubblefield", firstName: "Mark", orbit: "The Chosen", phone: "555-1111", path: "y.md", excerpt: "" },
    { name: "Jessica Hayes McNair", firstName: "Jessica", orbit: "Inner Core", phone: "555-9999", path: "z.md", excerpt: "" },
    { name: "Mark Johnson", firstName: "Mark", orbit: "The Network", phone: "555-2222", path: "w.md", excerpt: "" },
  ];

  it("matches exact first name when unique", () => {
    const result = matchDossier("Miguel", dossiers);
    assert.equal(result.kind, "single");
    if (result.kind === "single") {
      assert.equal(result.dossier.name, "Miguel Thorpe");
    }
  });

  it("returns ambiguous when multiple dossiers share the first name", () => {
    const result = matchDossier("Mark", dossiers);
    assert.equal(result.kind, "ambiguous");
    if (result.kind === "ambiguous") {
      assert.equal(result.candidates.length, 2);
    }
  });

  it("matches full name when query is a full name", () => {
    const result = matchDossier("Mark Stubblefield", dossiers);
    assert.equal(result.kind, "single");
    if (result.kind === "single") {
      assert.equal(result.dossier.name, "Mark Stubblefield");
    }
  });

  it("returns none when no dossier matches", () => {
    const result = matchDossier("Mike Salem", dossiers);
    assert.equal(result.kind, "none");
  });

  it("is case-insensitive", () => {
    const result = matchDossier("miguel", dossiers);
    assert.equal(result.kind, "single");
  });

  it("does NOT fabricate matches from phonetic similarity", () => {
    // "Mike Salem" sounds vaguely like "Mark Stubblefield" — must not match
    const result = matchDossier("Mike Salem", dossiers);
    assert.equal(result.kind, "none");
  });
});

describe("resolveEvent", () => {
  const dossiers: Dossier[] = [
    { name: "Miguel Thorpe", firstName: "Miguel", orbit: "The Chosen", phone: "501-269-5797", path: "x.md", excerpt: "Coffee buddy, Conway" },
    { name: "Mark Stubblefield", firstName: "Mark", orbit: "The Chosen", phone: "555-1111", path: "y.md", excerpt: "" },
    { name: "Mark Johnson", firstName: "Mark", orbit: "The Network", phone: "555-2222", path: "w.md", excerpt: "" },
    { name: "Jessica Hayes McNair", firstName: "Jessica", orbit: "Inner Core", phone: "555-9999", path: "z.md", excerpt: "" },
  ];

  const USER_FIRST_NAME = "Mark";

  it("resolves known attendee from title (Miguel Thorpe found)", () => {
    const event: CalendarEvent = { summary: "Miguel + Mark @ Level Ground", start: "2026-04-21T09:30:00-05:00" };
    const resolved = resolveEvent(event, dossiers, USER_FIRST_NAME);
    assert.equal(resolved.knownAttendees.length, 1);
    assert.equal(resolved.knownAttendees[0].name, "Miguel Thorpe");
    assert.equal(resolved.ambiguousAttendees.length, 0);
    assert.equal(resolved.unknownAttendees.length, 0);
  });

  it("skips the user's own first name when resolving", () => {
    // "Mark" here is the user, not Mark Stubblefield
    const event: CalendarEvent = { summary: "Miguel + Mark", start: "2026-04-21T09:30:00-05:00" };
    const resolved = resolveEvent(event, dossiers, USER_FIRST_NAME);
    assert.equal(resolved.knownAttendees.length, 1);
    assert.equal(resolved.knownAttendees[0].name, "Miguel Thorpe");
  });

  it("flags 'Mark y Mark' as ambiguous when user + multiple Mark dossiers exist", () => {
    const event: CalendarEvent = { summary: "Mark y Mark @ AIC", start: "2026-04-21T14:00:00-05:00" };
    const resolved = resolveEvent(event, dossiers, USER_FIRST_NAME);
    assert.equal(resolved.ambiguousAttendees.length, 1, "should have one ambiguous name");
    assert.equal(resolved.ambiguousAttendees[0].query, "Mark");
    assert.equal(resolved.ambiguousAttendees[0].candidates.length, 2, "2 candidate Marks");
  });

  it("flags unknown attendee — no dossier match means UNKNOWN, never guess", () => {
    const event: CalendarEvent = { summary: "Random Person + Mark", start: "2026-04-21T09:30:00-05:00" };
    const resolved = resolveEvent(event, dossiers, USER_FIRST_NAME);
    assert.equal(resolved.unknownAttendees.length, 1);
    assert.equal(resolved.unknownAttendees[0], "Random Person");
  });

  it("prefers calendar attendee emails over title parsing when present", () => {
    const event: CalendarEvent = {
      summary: "Meeting",
      start: "2026-04-21T09:30:00-05:00",
      attendees: [{ email: "miguel@example.com", displayName: "Miguel Thorpe" }],
    };
    const resolved = resolveEvent(event, dossiers, USER_FIRST_NAME);
    assert.equal(resolved.knownAttendees.length, 1);
    assert.equal(resolved.knownAttendees[0].name, "Miguel Thorpe");
  });

  it("returns empty arrays for events with no recognizable attendees", () => {
    const event: CalendarEvent = { summary: "Pickleball", start: "2026-04-21T19:15:00-05:00" };
    const resolved = resolveEvent(event, dossiers, USER_FIRST_NAME);
    assert.equal(resolved.knownAttendees.length, 0);
    assert.equal(resolved.unknownAttendees.length, 0);
    assert.equal(resolved.ambiguousAttendees.length, 0);
  });
});
