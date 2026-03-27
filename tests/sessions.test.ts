import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "../src/sessions.js";

const routing = [
  { match: { conversationId: "topic:work" }, session: "work" },
  { match: { channel: "telegram", type: "dm" }, session: "main" },
  { default: true, session: "main" },
];

const identityLinks = {
  mark: ["telegram:123", "discord:456"],
};

describe("SessionManager", () => {
  it("routes exact conversationId match", () => {
    const mgr = new SessionManager(routing, identityLinks);
    const session = mgr.route({ channelName: "telegram", conversationId: "topic:work", senderId: "123" });
    assert.equal(session, "work");
  });

  it("routes channel+type match", () => {
    const mgr = new SessionManager(routing, identityLinks);
    const session = mgr.route({ channelName: "telegram", conversationId: "dm:123", senderId: "123" });
    assert.equal(session, "main");
  });

  it("falls back to default", () => {
    const mgr = new SessionManager(routing, identityLinks);
    const session = mgr.route({ channelName: "discord", conversationId: "guild:789", senderId: "999" });
    assert.equal(session, "main");
  });

  it("resolves identity links", () => {
    const mgr = new SessionManager(routing, identityLinks);
    const id1 = mgr.resolveIdentity("telegram", "123");
    const id2 = mgr.resolveIdentity("discord", "456");
    assert.equal(id1, "mark");
    assert.equal(id2, "mark");
  });

  it("returns raw ID when no identity link", () => {
    const mgr = new SessionManager(routing, identityLinks);
    const id = mgr.resolveIdentity("telegram", "999");
    assert.equal(id, "telegram:999");
  });

  it("tracks session Claude IDs", () => {
    const mgr = new SessionManager(routing, identityLinks);
    mgr.register("main", "claude-abc-123");
    assert.equal(mgr.getClaudeSessionId("main"), "claude-abc-123");
  });
});
