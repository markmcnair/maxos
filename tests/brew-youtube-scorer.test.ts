import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scoreVideo, parseDuration, meetsQualityBar } from "../src/brew-youtube-scorer.js";

describe("parseDuration", () => {
  it("parses HH:MM:SS and MM:SS", () => {
    assert.equal(parseDuration("10:30"), 630);
    assert.equal(parseDuration("1:05:00"), 3900);
    assert.equal(parseDuration("45"), 45);
  });
});

describe("scoreVideo", () => {
  it("scores high on good views:subs ratio and like ratio", () => {
    const s = scoreVideo({
      views: 1_000_000,
      likes: 50_000,
      subscribers: 100_000,
      durationSec: 600,
      uploadDate: "20260101",
      title: "RAG explained",
    });
    assert.ok(s.score >= 4.0, `expected >= 4.0, got ${s.score}`);
    assert.ok(s.viewToSubRatio >= 5);
  });

  it("scores low when views:subs < 1 (subscriber echo chamber)", () => {
    const s = scoreVideo({
      views: 50_000,
      likes: 3_000,
      subscribers: 200_000,
      durationSec: 600,
      uploadDate: "20260101",
      title: "Foo",
    });
    assert.ok(s.score < 3.5);
  });
});

describe("meetsQualityBar", () => {
  it("rejects videos older than 6 months", () => {
    const oldUpload = "20250101";
    const pass = meetsQualityBar(
      { views: 10_000_000, likes: 500_000, subscribers: 1_000_000, durationSec: 600, uploadDate: oldUpload, title: "x" },
      new Date("2026-04-22"),
    );
    assert.equal(pass, false);
  });

  it("accepts videos with good metrics and recent upload", () => {
    const pass = meetsQualityBar(
      { views: 5_000_000, likes: 300_000, subscribers: 500_000, durationSec: 600, uploadDate: "20260301", title: "x" },
      new Date("2026-04-22"),
    );
    assert.equal(pass, true);
  });

  it("rejects videos outside 5–15 min window", () => {
    const pass = meetsQualityBar(
      { views: 5_000_000, likes: 300_000, subscribers: 500_000, durationSec: 60, uploadDate: "20260301", title: "x" },
      new Date("2026-04-22"),
    );
    assert.equal(pass, false);
  });

  it("rejects videos with like ratio below 0.9%", () => {
    const pass = meetsQualityBar(
      {
        views: 10_000_000,
        likes: 50_000,         // 0.5% — below the 0.9% threshold
        subscribers: 500_000,  // 20× view:sub — clears that bar
        durationSec: 600,
        uploadDate: "20260301",
        title: "x",
      },
      new Date("2026-04-22"),
    );
    assert.equal(pass, false);
  });
});
