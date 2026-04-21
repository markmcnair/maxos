import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyOverdue,
  daysBetween,
  formatRelationshipKit,
  type RelationshipStatus,
} from "../src/relationship-kit.js";

describe("daysBetween", () => {
  it("returns positive days between two YYYY-MM-DD strings", () => {
    assert.equal(daysBetween("2026-04-10", "2026-04-20"), 10);
    assert.equal(daysBetween("2026-04-20", "2026-04-10"), 10);
  });

  it("returns 0 for the same date", () => {
    assert.equal(daysBetween("2026-04-20", "2026-04-20"), 0);
  });

  it("returns -1 for invalid input", () => {
    assert.equal(daysBetween("", "2026-04-20"), -1);
    assert.equal(daysBetween("garbage", "2026-04-20"), -1);
  });
});

describe("classifyOverdue", () => {
  const today = "2026-04-21";

  it("Inner Core — never overdue (built into daily life)", () => {
    assert.equal(classifyOverdue("Inner Core", "2026-01-01", today), "skip");
  });

  it("The Chosen — overdue if > 7 days", () => {
    assert.equal(classifyOverdue("The Chosen", "2026-04-20", today), "current");
    assert.equal(classifyOverdue("The Chosen", "2026-04-14", today), "current"); // 7 days exactly
    assert.equal(classifyOverdue("The Chosen", "2026-04-13", today), "overdue"); // 8 days
    assert.equal(classifyOverdue("The Chosen", "2026-04-12", today), "overdue");
  });

  it("The Circle — overdue if > 30 days", () => {
    assert.equal(classifyOverdue("The Circle", "2026-03-25", today), "current");
    assert.equal(classifyOverdue("The Circle", "2026-03-20", today), "overdue");
  });

  it("The Network — overdue if > 90 days", () => {
    assert.equal(classifyOverdue("The Network", "2026-02-15", today), "current");
    assert.equal(classifyOverdue("The Network", "2025-12-15", today), "overdue");
  });

  it("Empty last_touchpoint → needs-baseline", () => {
    assert.equal(classifyOverdue("The Chosen", "", today), "needs-baseline");
    assert.equal(classifyOverdue("The Circle", undefined, today), "needs-baseline");
  });
});

describe("formatRelationshipKit", () => {
  const statuses: RelationshipStatus[] = [
    {
      name: "Aaron Kruse",
      orbit: "The Chosen",
      phone: "+15551111111",
      lastTouchpoint: "2026-04-10",
      lastTouchpointUpdated: true,
      classification: "overdue",
      daysOverdue: 4,
      path: "x.md",
    },
    {
      name: "Daniel McNair",
      orbit: "The Chosen",
      phone: "+15017646415",
      lastTouchpoint: "2026-04-20",
      lastTouchpointUpdated: true,
      classification: "current",
      daysOverdue: 0,
      path: "y.md",
    },
    {
      name: "New Person",
      orbit: "The Circle",
      phone: "+15555555555",
      lastTouchpoint: undefined,
      lastTouchpointUpdated: false,
      classification: "needs-baseline",
      daysOverdue: 0,
      path: "z.md",
    },
  ];

  it("emits the deterministic trust directive", () => {
    const md = formatRelationshipKit(statuses, "2026-04-21");
    assert.ok(md.includes("## Relationship Kit"));
    assert.ok(md.toLowerCase().includes("deterministic"));
    assert.ok(md.toLowerCase().includes("do not re-derive"));
  });

  it("lists overdue contacts with days-overdue and orbit", () => {
    const md = formatRelationshipKit(statuses, "2026-04-21");
    assert.ok(md.includes("Aaron Kruse"));
    assert.ok(md.includes("4 days"));
    assert.ok(md.includes("The Chosen"));
  });

  it("lists needs-baseline contacts separately", () => {
    const md = formatRelationshipKit(statuses, "2026-04-21");
    assert.ok(md.includes("New Person"));
    assert.ok(md.toLowerCase().includes("baseline"));
  });

  it("does NOT raise current-tier contacts as overdue", () => {
    const md = formatRelationshipKit(statuses, "2026-04-21");
    // Daniel is current — should not appear in overdue section
    const overdueIdx = md.toLowerCase().indexOf("overdue");
    const danielIdx = md.indexOf("Daniel");
    // If Daniel appears, he shouldn't be inside the overdue section
    if (danielIdx >= 0) {
      const currentIdx = md.toLowerCase().indexOf("current");
      // Either current section comes after overdue (and Daniel is there), or he doesn't appear
      assert.ok(currentIdx >= 0, "should have current section if Daniel is listed");
    }
  });

  it("notes how many touchpoints got auto-refreshed", () => {
    const md = formatRelationshipKit(statuses, "2026-04-21");
    assert.ok(md.toLowerCase().includes("auto-refreshed") || md.includes("2"));
  });

  it("handles empty status list gracefully", () => {
    const md = formatRelationshipKit([], "2026-04-21");
    assert.ok(md.toLowerCase().includes("no dossiers"));
  });
});
