import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  deduplicateEvents,
  formatCalendarBrief,
  type CalendarEvent,
  type ResolvedEvent,
  type Dossier,
} from "../src/calendar-brief.js";

describe("deduplicateEvents", () => {
  it("removes events with the same title and start time", () => {
    const events: CalendarEvent[] = [
      { summary: "Miguel + Mark", start: "2026-04-21T09:30:00-05:00" },
      { summary: "Miguel + Mark", start: "2026-04-21T09:30:00-05:00" },
      { summary: "Different event", start: "2026-04-21T10:00:00-05:00" },
    ];
    const deduped = deduplicateEvents(events);
    assert.equal(deduped.length, 2);
  });

  it("keeps events with same title but different times", () => {
    const events: CalendarEvent[] = [
      { summary: "Stand-up", start: "2026-04-21T09:00:00-05:00" },
      { summary: "Stand-up", start: "2026-04-22T09:00:00-05:00" },
    ];
    const deduped = deduplicateEvents(events);
    assert.equal(deduped.length, 2);
  });

  it("handles empty array", () => {
    assert.deepEqual(deduplicateEvents([]), []);
  });
});

describe("formatCalendarBrief", () => {
  const dossiers: Dossier[] = [
    { name: "Miguel Thorpe", firstName: "Miguel", orbit: "The Chosen", phone: "501-269-5797", path: "x.md", excerpt: "Coffee buddy, Conway local" },
    { name: "Mark Stubblefield", firstName: "Mark", orbit: "The Chosen", phone: "555-1111", path: "y.md", excerpt: "" },
    { name: "Mark Johnson", firstName: "Mark", orbit: "The Network", phone: "555-2222", path: "w.md", excerpt: "" },
  ];

  const resolved: ResolvedEvent[] = [
    {
      time: "9:30am",
      title: "Miguel + Mark @ Level Ground",
      location: "Level Ground Coffee",
      knownAttendees: [dossiers[0]],
      unknownAttendees: [],
      ambiguousAttendees: [],
    },
    {
      time: "2:00pm",
      title: "Mark y Mark @ AIC",
      location: "AIC",
      knownAttendees: [],
      unknownAttendees: [],
      ambiguousAttendees: [{ query: "Mark", candidates: [dossiers[1], dossiers[2]] }],
    },
    {
      time: "3:00pm",
      title: "Glenn + Mark",
      knownAttendees: [],
      unknownAttendees: ["Glenn"],
      ambiguousAttendees: [],
    },
  ];

  it("includes the strong anti-hallucination directive", () => {
    const brief = formatCalendarBrief("2026-04-21", resolved);
    const lowered = brief.toLowerCase();
    assert.ok(lowered.includes("do not invent"));
    assert.ok(lowered.includes("❓") || lowered.includes("unknown"));
  });

  it("labels known attendees with name + orbit", () => {
    const brief = formatCalendarBrief("2026-04-21", resolved);
    assert.ok(brief.includes("Miguel Thorpe"));
    assert.ok(brief.includes("The Chosen"));
  });

  it("flags ambiguous attendees with all candidates, never picks one", () => {
    const brief = formatCalendarBrief("2026-04-21", resolved);
    // Must list BOTH candidates, not pick one
    assert.ok(brief.includes("Mark Stubblefield"), "should list first candidate");
    assert.ok(brief.includes("Mark Johnson"), "should list second candidate");
    assert.ok(brief.toLowerCase().includes("ambiguous"));
  });

  it("flags unknown attendees as ❓, forbids invention", () => {
    const brief = formatCalendarBrief("2026-04-21", resolved);
    assert.ok(brief.includes("Glenn"));
    assert.ok(brief.includes("❓") || brief.toLowerCase().includes("unknown"));
  });

  it("handles an empty event list without crashing", () => {
    const brief = formatCalendarBrief("2026-04-21", []);
    assert.ok(brief.includes("2026-04-21"));
    assert.ok(brief.toLowerCase().includes("no events") || brief.length > 0);
  });
});
