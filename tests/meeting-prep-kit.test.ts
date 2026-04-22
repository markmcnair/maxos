import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseMeetingContext,
  matchAttendeeToDossier,
  formatMeetingPrepKit,
  type MeetingContext,
} from "../src/meeting-prep-kit.js";
import type { Dossier } from "../src/calendar-brief.js";

describe("parseMeetingContext", () => {
  it("extracts title/time/location/attendees/purpose from a standard prompt", () => {
    const prompt = `Read tasks/meeting-prep.md and execute every step. MEETING CONTEXT: Title: Alex + Mark, Time: 8:00am, Location: Level Ground Coffee, Attendees: Alex Van Velte (vanvelte@gmail.com), Purpose: First intro meeting — discussing Dave Creek Media`;
    const ctx = parseMeetingContext(prompt);
    assert.ok(ctx);
    assert.equal(ctx.title, "Alex + Mark");
    assert.equal(ctx.time, "8:00am");
    assert.equal(ctx.location, "Level Ground Coffee");
    assert.ok(ctx.attendees.includes("Alex Van Velte (vanvelte@gmail.com)"));
    assert.ok(ctx.purpose?.includes("Dave Creek Media"));
  });

  it("returns null when the prompt has no MEETING CONTEXT section", () => {
    const prompt = "Some unrelated task prompt.";
    assert.equal(parseMeetingContext(prompt), null);
  });

  it("handles multiple attendees separated by commas or semicolons", () => {
    const prompt = "MEETING CONTEXT: Title: Team sync, Time: 2pm, Attendees: Alice, Bob Smith, Charlie (charlie@x.com), Purpose: Review";
    const ctx = parseMeetingContext(prompt);
    assert.ok(ctx);
    assert.equal(ctx.attendees.length, 3);
  });

  it("is tolerant of missing optional fields (location, purpose)", () => {
    const prompt = "MEETING CONTEXT: Title: Sync, Time: 9am, Attendees: Bob";
    const ctx = parseMeetingContext(prompt);
    assert.ok(ctx);
    assert.equal(ctx.title, "Sync");
    assert.equal(ctx.location, undefined);
    assert.equal(ctx.purpose, undefined);
  });
});

describe("matchAttendeeToDossier", () => {
  const dossiers: Dossier[] = [
    { name: "Miguel Thorpe", firstName: "Miguel", orbit: "The Chosen", phone: "501-269-5797", path: "x.md", excerpt: "Trading buddy" },
    { name: "Alex Van Velte", firstName: "Alex", orbit: "The Network", phone: "555-1234", path: "y.md", excerpt: "Dave Creek Media" },
    { name: "Mark Stubblefield", firstName: "Mark", orbit: "The Chosen", phone: "210-240-6328", path: "z.md", excerpt: "" },
  ];

  it("matches full name exactly", () => {
    const result = matchAttendeeToDossier("Alex Van Velte", dossiers);
    assert.equal(result?.name, "Alex Van Velte");
  });

  it("matches first name when unambiguous", () => {
    const result = matchAttendeeToDossier("Miguel", dossiers);
    assert.equal(result?.name, "Miguel Thorpe");
  });

  it("strips trailing parenthesized email/phone before matching", () => {
    const result = matchAttendeeToDossier("Alex Van Velte (vanvelte@gmail.com)", dossiers);
    assert.equal(result?.name, "Alex Van Velte");
  });

  it("returns null when no dossier matches", () => {
    assert.equal(matchAttendeeToDossier("Totally Unknown Person", dossiers), null);
    assert.equal(matchAttendeeToDossier("Mike Salem", dossiers), null);
  });

  it("does NOT match across ambiguous first names — returns null to force user clarification", () => {
    // "Mark" alone is ambiguous (only Stubblefield in fixtures, but this
    // could match multiple Marks in reality). Multi-match → null.
    const multiMark: Dossier[] = [
      ...dossiers,
      { name: "Mark Johnson", firstName: "Mark", orbit: "The Network", phone: "555-9999", path: "q.md", excerpt: "" },
    ];
    const result = matchAttendeeToDossier("Mark", multiMark);
    assert.equal(result, null);
  });
});

describe("formatMeetingPrepKit", () => {
  const ctx: MeetingContext = {
    title: "Alex + Mark",
    time: "8:00am",
    location: "Level Ground Coffee",
    attendees: ["Alex Van Velte (vanvelte@gmail.com)"],
    purpose: "First intro meeting",
  };
  const known: Dossier[] = [
    { name: "Alex Van Velte", firstName: "Alex", orbit: "The Network", phone: "555-1234", path: "y.md", excerpt: "Dave Creek Media — Conway. Former coworker of X." },
  ];

  it("emits the deterministic directive and event metadata", () => {
    const kit = formatMeetingPrepKit(ctx, known, []);
    assert.ok(kit.includes("## Meeting Prep Kit"));
    assert.ok(kit.toLowerCase().includes("deterministic"));
    assert.ok(kit.includes("Alex + Mark"));
    assert.ok(kit.includes("8:00am"));
    assert.ok(kit.includes("Level Ground"));
  });

  it("lists known attendees with dossier context", () => {
    const kit = formatMeetingPrepKit(ctx, known, []);
    assert.ok(kit.includes("Alex Van Velte"));
    assert.ok(kit.includes("The Network"));
    assert.ok(kit.includes("Dave Creek Media"));
  });

  it("flags unknown attendees with ❓ and DO NOT invent directive", () => {
    const kit = formatMeetingPrepKit(ctx, [], ["Some Stranger"]);
    assert.ok(kit.includes("Some Stranger"));
    assert.ok(kit.includes("❓"));
    assert.ok(kit.toLowerCase().includes("do not invent"));
  });

  it("handles empty attendee list without crashing", () => {
    const emptyCtx = { ...ctx, attendees: [] };
    const kit = formatMeetingPrepKit(emptyCtx, [], []);
    assert.ok(kit.includes("Alex + Mark"));
  });
});
