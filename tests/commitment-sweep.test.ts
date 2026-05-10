import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepOutbound } from "../src/commitment-sweep.js";

describe("sweepOutbound", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sweep-"));
    mkdirSync(join(home, "workspace", "memory"), { recursive: true });
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("scans messages from injected fetchers, records new commitments + cancellations", async () => {
    const r = await sweepOutbound(home, {
      hoursBack: 6,
      deps: {
        fetchSent: async () => [
          {
            messageId: "e1",
            recipient: "lane@example.com",
            sentAt: "2026-05-07T16:00:00Z",
            body: "I'll send the keys by Friday.",
            account: "personal" as const,
          },
        ],
        fetchIMessages: async () => [
          {
            messageId: "im1",
            recipient: "+15015551234",
            sentAt: "2026-05-07T17:00:00Z",
            body: "Have to cancel our 7pm tonight, sorry!",
          },
        ],
      },
    });
    // fetchSent runs for both personal+emprise (2 emails total), plus 1 imsg = 3 scanned
    assert.equal(r.scanned, 3);
    assert.ok(r.newCommitments >= 1);
    assert.ok(r.newCancellations >= 1);
    const commitsFile = join(home, "workspace", "memory", "commitments.jsonl");
    const cancelsFile = join(home, "workspace", "memory", "cancellations.jsonl");
    assert.ok(existsSync(commitsFile));
    assert.ok(existsSync(cancelsFile));
    assert.match(readFileSync(commitsFile, "utf-8"), /send the keys/);
    assert.match(readFileSync(cancelsFile, "utf-8"), /tonight|7pm/);
  });

  it("is idempotent — second run with same input adds zero records", async () => {
    const deps = {
      fetchSent: async () => [
        {
          messageId: "e1",
          recipient: "x@y.com",
          sentAt: "2026-05-07T16:00:00Z",
          body: "I'll send the keys by Friday.",
          account: "personal" as const,
        },
      ],
      fetchIMessages: async () => [],
    };
    const r1 = await sweepOutbound(home, { deps });
    const r2 = await sweepOutbound(home, { deps });
    assert.ok(r1.newCommitments >= 1);
    assert.equal(r2.newCommitments, 0);
    assert.equal(r2.newCancellations, 0);
  });

  it("tolerates fetcher errors and keeps going", async () => {
    const r = await sweepOutbound(home, {
      deps: {
        fetchSent: async (account) => {
          if (account === "emprise") throw new Error("emprise gws blew up");
          return [
            {
              messageId: "e1",
              recipient: "x@y.com",
              sentAt: "2026-05-07T16:00:00Z",
              body: "I'll send by Friday.",
              account: "personal" as const,
            },
          ];
        },
        fetchIMessages: async () => [],
      },
    });
    assert.ok(r.errors.length >= 1);
    assert.match(r.errors[0], /emprise/);
    // Personal account commitments still captured
    assert.ok(r.newCommitments >= 1);
  });

  it("returns scanned=0 + no errors when fetchers return nothing", async () => {
    const r = await sweepOutbound(home, {
      deps: {
        fetchSent: async () => [],
        fetchIMessages: async () => [],
      },
    });
    assert.equal(r.scanned, 0);
    assert.equal(r.newCommitments, 0);
    assert.equal(r.newCancellations, 0);
    assert.equal(r.errors.length, 0);
  });
});
