import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createWebSocketTransport } from "../runtime/link2chrome-client.mjs";

test("runtime transport emits a complete V2 envelope from its bound Session handle", async () => {
  const sent = [];
  class FakeWebSocket {
    constructor() {
      this.listeners = new Map();
      queueMicrotask(() => this.listeners.get("open")?.());
    }
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    send(raw) {
      const message = JSON.parse(raw);
      sent.push(message);
      queueMicrotask(() => this.listeners.get("message")?.({
        data: JSON.stringify({ request_id: message.request_id || message.requestId, success: true, data: { ok: true } }),
      }));
    }
    close() {}
  }
  const transport = createWebSocketTransport({ url: "ws://test", WebSocketImpl: FakeWebSocket });
  transport.setSessionHandle({
    session: "research", sessionId: "session-a", ownerId: "owner-a", adapterId: "adapter-a",
    revision: 4, groupId: 11, windowId: 1, targetTabId: 101, tabIds: [101],
  });
  await transport.command("navigate", { tabId: 101, url: "https://example.test" });
  assert.equal(sent[0].command, "__hub_register_adapter__");
  assert.equal(sent[1].protocolVersion, 2);
  assert.equal(sent[1].sessionId, "session-a");
  assert.equal(sent[1].sessionRevision, 4);
  assert.equal(sent[1].groupId, 11);
  assert.equal(sent[1].tabId, 101);
  assert.equal(sent[1].command, "navigate");
});

test("runtime browser_session new_tab uses the Hub transaction command", async () => {
  const sent = [];
  class FakeWebSocket {
    constructor() { this.listeners = new Map(); queueMicrotask(() => this.listeners.get("open")?.()); }
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    send(raw) {
      const message = JSON.parse(raw);
      sent.push(message);
      const data = message.command === "__session_create_tab__"
        ? { session: "research", sessionId: "session-a", ownerId: "owner-a", adapterId: "adapter-a", revision: 5, groupId: 11, windowId: 1, targetTabId: 102, tabIds: [101, 102] }
        : { ok: true };
      queueMicrotask(() => this.listeners.get("message")?.({ data: JSON.stringify({ request_id: message.request_id, success: true, data }) }));
    }
    close() {}
  }
  const transport = createWebSocketTransport({ url: "ws://test", WebSocketImpl: FakeWebSocket });
  transport.setSessionHandle({
    session: "research", sessionId: "session-a", ownerId: "owner-a", adapterId: "adapter-a",
    revision: 4, groupId: 11, windowId: 1, targetTabId: 101, tabIds: [101],
  });
  const result = await transport.command("browser_session", { action: "new_tab", url: "https://example.test" });
  assert.equal(sent[0].command, "__hub_register_adapter__");
  assert.equal(sent[1].command, "__session_create_tab__");
  assert.equal(sent[1].params.expectedRevision, 4);
  assert.equal(result.targetTabId, 102);
});

test("runtime preserves Hub-issued single-use claim tokens", async () => {
  const sent = [];
  class FakeWebSocket {
    constructor() { this.listeners = new Map(); queueMicrotask(() => this.listeners.get("open")?.()); }
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    send(raw) {
      const message = JSON.parse(raw);
      sent.push(message);
      const data = message.command === "__session_user_tabs__"
        ? { windows: { "1": [{ id: 900, windowId: 1, groupId: -1, claimToken: "hub-token" }] } }
        : { ok: true };
      queueMicrotask(() => this.listeners.get("message")?.({ data: JSON.stringify({ request_id: message.request_id, success: true, data }) }));
    }
    close() {}
  }
  const transport = createWebSocketTransport({ url: "ws://test", WebSocketImpl: FakeWebSocket });
  transport.setSessionHandle({
    session: "research", sessionId: "session-a", ownerId: "owner-a", adapterId: "adapter-a",
    revision: 4, groupId: 11, windowId: 1, targetTabId: 101, tabIds: [101],
  });
  const listed = await transport.command("browser_tabs_list", { open: true });
  assert.equal(sent[1].command, "__session_user_tabs__");
  assert.equal(listed.tabs[0].claimToken, "hub-token");
});

test("one runtime transport cannot be rebound to another Session identity", () => {
  class NeverSocket {}
  const transport = createWebSocketTransport({ WebSocketImpl: NeverSocket });
  transport.setSessionHandle({ session: "a", sessionId: "session-a", tabIds: [] });
  assert.throws(
    () => transport.setSessionHandle({ session: "b", sessionId: "session-b", tabIds: [] }),
    /already bound/,
  );
});

test("runtime entry validates immutable Session identity before execution", () => {
  const source = readFileSync(new URL("../runtime/nodejs-playwright-runtime.mjs", import.meta.url), "utf8");
  assert.match(source, /let immutableSessionId = null/);
  assert.match(source, /if \(immutableSessionId && immutableSessionId !== handle\.sessionId\)/);
  assert.match(source, /transport\?\.setSessionHandle\?\.\(handle\)/);
});
