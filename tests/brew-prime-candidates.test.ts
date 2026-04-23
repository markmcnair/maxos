import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scorePrime, passesConfidenceGate } from "../src/brew-prime-candidates.js";

describe("scorePrime", () => {
  it("weights Create Value heaviest (0.35)", () => {
    const s = scorePrime({ createValue: 5, removeToil: 1, automate: 1, activeFit: 1 });
    assert.equal(s, 2.4);
  });

  it("rounds to 2 decimals", () => {
    const s = scorePrime({ createValue: 4, removeToil: 4, automate: 4, activeFit: 4 });
    assert.equal(s, 4);
  });
});

describe("passesConfidenceGate", () => {
  it("passes at 4.2", () => {
    assert.equal(passesConfidenceGate(4.2), true);
    assert.equal(passesConfidenceGate(4.19), false);
  });
});
