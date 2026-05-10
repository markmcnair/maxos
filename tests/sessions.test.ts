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

  it("recordActivity increments messageCount and bumps lastActivity", async () => {
    const mgr = new SessionManager(routing, identityLinks);
    mgr.register("main", "claude-1");
    const initial = mgr.getAll()["main"];
    const t0 = initial.lastActivity;
    await new Promise((r) => setTimeout(r, 5));
    mgr.recordActivity("main");
    mgr.recordActivity("main");
    const after = mgr.getAll()["main"];
    assert.equal(after.messageCount, 2);
    assert.ok(after.lastActivity > t0);
  });

  it("recordActivity is a no-op for unknown sessions", () => {
    const mgr = new SessionManager(routing, identityLinks);
    assert.doesNotThrow(() => mgr.recordActivity("nope"));
    assert.equal(mgr.getClaudeSessionId("nope"), undefined);
  });

  it("clear removes a single session", () => {
    const mgr = new SessionManager(routing, identityLinks);
    mgr.register("main", "claude-1");
    mgr.register("work", "claude-2");
    mgr.clear("main");
    assert.equal(mgr.getClaudeSessionId("main"), undefined);
    assert.equal(mgr.getClaudeSessionId("work"), "claude-2");
  });

  it("clearAll wipes every session", () => {
    const mgr = new SessionManager(routing, identityLinks);
    mgr.register("main", "claude-1");
    mgr.register("work", "claude-2");
    mgr.clearAll();
    assert.deepEqual(mgr.getAll(), {});
  });

  it("loadFromState rehydrates sessions from persisted state", () => {
    const mgr = new SessionManager(routing, identityLinks);
    mgr.loadFromState({
      main: { claudeSessionId: "loaded-id", lastActivity: 1000, messageCount: 7 },
    });
    assert.equal(mgr.getClaudeSessionId("main"), "loaded-id");
    assert.equal(mgr.getAll()["main"].messageCount, 7);
  });

  it("handles a 'group' type routing rule", () => {
    const groupRouting = [
      { match: { channel: "telegram", type: "group" }, session: "groups" },
      { default: true, session: "main" },
    ];
    const mgr = new SessionManager(groupRouting, {});
    const grp = mgr.route({ channelName: "telegram", conversationId: "topic:family", senderId: "1" });
    const dm = mgr.route({ channelName: "telegram", conversationId: "dm:1", senderId: "1" });
    assert.equal(grp, "groups");
    assert.equal(dm, "main");
  });

  it("supports multiple aliases mapping to the same identity", () => {
    const links = { mark: ["telegram:1", "discord:2", "imessage:+15001112222"] };
    const mgr = new SessionManager([{ default: true, session: "main" }], links);
    assert.equal(mgr.resolveIdentity("telegram", "1"), "mark");
    assert.equal(mgr.resolveIdentity("discord", "2"), "mark");
    assert.equal(mgr.resolveIdentity("imessage", "+15001112222"), "mark");
  });

  it("falls back to 'main' default when routing has no rules at all", () => {
    const mgr = new SessionManager([], {});
    const result = mgr.route({ channelName: "telegram", conversationId: "dm:99", senderId: "99" });
    assert.equal(result, "main");
  });
});
