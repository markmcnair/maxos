import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { waitForHealthyChannel } from "../src/gateway.js";
import type { ChannelAdapter } from "../src/channels/adapter.js";

function fakeChannel(healthyFn: () => boolean): ChannelAdapter {
  return { isHealthy: healthyFn } as unknown as ChannelAdapter;
}

describe("waitForHealthyChannel", () => {
  it("returns immediately when a channel is already healthy", async () => {
    const ch = fakeChannel(() => true);
    const start = Date.now();
    const result = await waitForHealthyChannel([ch], 1000);
    const elapsed = Date.now() - start;
    assert.equal(result, ch);
    assert.ok(elapsed < 50, `expected immediate return, took ${elapsed}ms`);
  });

  it("returns the first channel that becomes healthy within the timeout", async () => {
    let ready = false;
    const ch = fakeChannel(() => ready);
    setTimeout(() => { ready = true; }, 80);
    const start = Date.now();
    const result = await waitForHealthyChannel([ch], 2000);
    const elapsed = Date.now() - start;
    assert.equal(result, ch);
    assert.ok(elapsed >= 80, `expected to wait for readiness, got ${elapsed}ms`);
    assert.ok(elapsed < 500, `expected to not poll slowly, got ${elapsed}ms`);
  });

  it("returns null if no channel becomes healthy within the timeout", async () => {
    const ch = fakeChannel(() => false);
    const start = Date.now();
    const result = await waitForHealthyChannel([ch], 150);
    const elapsed = Date.now() - start;
    assert.equal(result, null);
    assert.ok(elapsed >= 150, `expected to wait at least the timeout, got ${elapsed}ms`);
    assert.ok(elapsed < 400, `expected to stop near the timeout, got ${elapsed}ms`);
  });

  it("returns null when there are no channels at all", async () => {
    const result = await waitForHealthyChannel([], 50);
    assert.equal(result, null);
  });

  it("prefers the first healthy channel when multiple are healthy", async () => {
    const a = fakeChannel(() => true);
    const b = fakeChannel(() => true);
    const result = await waitForHealthyChannel([a, b], 1000);
    assert.equal(result, a);
  });
});
