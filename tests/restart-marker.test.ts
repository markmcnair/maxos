import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeRestartMarker, consumeRestartMarker } from "../src/restart-marker.js";

describe("restart marker", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "maxos-restart-marker-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("consumeRestartMarker returns null when no marker file exists", () => {
    assert.equal(consumeRestartMarker(dir), null);
  });

  it("write then consume returns the marker with reason and timestamp", () => {
    writeRestartMarker(dir, "user-requested");
    const marker = consumeRestartMarker(dir);
    assert.ok(marker, "marker should be present after write");
    assert.equal(marker.reason, "user-requested");
    assert.ok(typeof marker.ts === "number");
    assert.ok(marker.ts <= Date.now());
    assert.ok(marker.ts > Date.now() - 5000);
  });

  it("consume deletes the marker so a second consume returns null", () => {
    writeRestartMarker(dir, "user-requested");
    const first = consumeRestartMarker(dir);
    assert.ok(first);
    const second = consumeRestartMarker(dir);
    assert.equal(second, null);
  });

  it("write creates the parent directory if it does not exist", () => {
    const nested = join(dir, "does", "not", "exist");
    assert.equal(existsSync(nested), false);
    writeRestartMarker(nested, "user-requested");
    const marker = consumeRestartMarker(nested);
    assert.ok(marker);
  });

  it("consume returns null when marker file contains invalid JSON (corrupt)", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "restart.marker"), "not-valid-json{{{");
    const marker = consumeRestartMarker(dir);
    assert.equal(marker, null);
    // And the corrupt file is cleaned up so it doesn't stick around
    assert.equal(existsSync(join(dir, "restart.marker")), false);
  });
});
