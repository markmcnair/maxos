import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stripEarlyDelivered } from "../src/gateway.js";

describe("stripEarlyDelivered", () => {
  it("strips matching prefix from accumulated response", () => {
    const early = "Good catch — let me check that.";
    const response = "Good catch — let me check that.\n\nHere's what I found: the auth is broken.";
    const result = stripEarlyDelivered(response, early);
    assert.equal(result, "Here's what I found: the auth is broken.");
  });

  it("returns full response when early text does not match (result event case)", () => {
    // This is the bug case: result event has only the final turn,
    // not the early ack text. Must deliver full response, not truncate.
    const early = "Checking your calendar, one sec.";
    const response = "No headless/device flow available — auth login opens a browser, period. The refresh token is fully revoked.";
    const result = stripEarlyDelivered(response, early);
    assert.equal(result, response);
  });

  it("returns full response when earlyText is empty", () => {
    const response = "Here's the full response.";
    assert.equal(stripEarlyDelivered(response, ""), response);
  });

  it("returns empty string when response equals early text exactly", () => {
    const text = "On it — give me a minute.";
    const result = stripEarlyDelivered(text, text);
    assert.equal(result, "");
  });

  it("trims whitespace after stripping prefix", () => {
    const early = "Looking into it.";
    const response = "Looking into it.\n\n\n  Here's what I found.";
    const result = stripEarlyDelivered(response, early);
    assert.equal(result, "Here's what I found.");
  });

  it("handles response shorter than early text gracefully", () => {
    const early = "This is a longer early text that was sent.";
    const response = "Short.";
    const result = stripEarlyDelivered(response, early);
    assert.equal(result, "Short.");
  });
});
