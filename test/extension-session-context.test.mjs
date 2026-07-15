import assert from "node:assert/strict";
import test from "node:test";

import sessionContextApi from "../extension/session-context.js";

const {
  SessionContextError,
  SessionContextStore,
  TAB_STATE,
} = sessionContextApi;

function activeSession(store, {
  sessionId = "session-a",
  alias = "research",
  groupId = 11,
  windowId = 1,
  tabId = 101,
} = {}) {
  store.registerSession({
    sessionId,
    ownerId: `owner-${sessionId}`,
    alias,
    groupId,
    windowId,
    targetTabId: tabId,
    revision: 1,
    state: "ACTIVE",
  });
  store.registerTab(sessionId, tabId, {
    state: TAB_STATE.ACTIVE,
    ownershipType: "agent",
  });
}

test("same alias can belong to different opaque sessions", () => {
  const store = new SessionContextStore();
  activeSession(store, { sessionId: "session-a", alias: "research", groupId: 11, tabId: 101 });
  activeSession(store, { sessionId: "session-b", alias: "research", groupId: 22, tabId: 202 });

  assert.equal(store.getSession("session-a").groupId, 11);
  assert.equal(store.getSession("session-b").groupId, 22);
});

test("one group cannot be registered to two active sessions", () => {
  const store = new SessionContextStore();
  activeSession(store, { sessionId: "session-a", groupId: 11, tabId: 101 });

  assert.throws(
    () => activeSession(store, { sessionId: "session-b", groupId: 11, tabId: 202 }),
    (error) => error instanceof SessionContextError && error.code === "GROUP_ALREADY_OWNED",
  );
  assert.equal(store.ownerOfTab(202), null);
});

test("one tab cannot be registered to two sessions", () => {
  const store = new SessionContextStore();
  activeSession(store, { sessionId: "session-a", groupId: 11, tabId: 101 });
  store.registerSession({
    sessionId: "session-b",
    ownerId: "owner-b",
    alias: "build",
    groupId: 22,
    windowId: 1,
    targetTabId: 202,
    revision: 1,
    state: "ACTIVE",
  });

  assert.throws(
    () => store.registerTab("session-b", 101, { state: TAB_STATE.ACTIVE }),
    (error) => error.code === "TAB_ALREADY_OWNED",
  );
  assert.equal(store.ownerOfTab(101), "session-a");
});

test("pending group tab is denied before Chrome mutation", () => {
  const store = new SessionContextStore();
  store.registerSession({
    sessionId: "session-a",
    ownerId: "owner-a",
    alias: "research",
    groupId: 11,
    windowId: 1,
    targetTabId: 101,
    revision: 1,
    state: "ACTIVE",
  });
  store.registerTab("session-a", 101, { state: TAB_STATE.PENDING_GROUP });

  assert.throws(
    () => store.assertSessionTab({
      sessionId: "session-a", revision: 1, groupId: 11, tabId: 101,
    }, { id: 101, groupId: 11, windowId: 1 }),
    (error) => error.code === "TAB_PENDING_GROUP",
  );
});

test("actual Chrome group and window must match registered session", () => {
  const store = new SessionContextStore();
  activeSession(store);

  assert.throws(
    () => store.assertSessionTab({
      sessionId: "session-a", revision: 1, groupId: 11, tabId: 101,
    }, { id: 101, groupId: 99, windowId: 1 }),
    (error) => error.code === "GROUP_MISMATCH",
  );
  assert.throws(
    () => store.assertSessionTab({
      sessionId: "session-a", revision: 1, groupId: 11, tabId: 101,
    }, { id: 101, groupId: 11, windowId: 2 }),
    (error) => error.code === "WINDOW_MISMATCH",
  );
});

test("stale revision and foreign tab fail closed", () => {
  const store = new SessionContextStore();
  activeSession(store);

  assert.throws(
    () => store.assertSessionTab({
      sessionId: "session-a", revision: 0, groupId: 11, tabId: 101,
    }, { id: 101, groupId: 11, windowId: 1 }),
    (error) => error.code === "STALE_SESSION_REVISION",
  );
  assert.throws(
    () => store.assertSessionTab({
      sessionId: "session-a", revision: 1, groupId: 11, tabId: 999,
    }, { id: 999, groupId: 11, windowId: 1 }),
    (error) => error.code === "TAB_OUTSIDE_SESSION",
  );
});

test("target can only switch to an owned active tab", () => {
  const store = new SessionContextStore();
  activeSession(store);
  store.registerTab("session-a", 102, { state: TAB_STATE.ACTIVE });

  store.setTarget("session-a", 102);

  assert.equal(store.getSession("session-a").targetTabId, 102);
  assert.throws(
    () => store.setTarget("session-a", 999),
    (error) => error.code === "TAB_OUTSIDE_SESSION",
  );
});

test("closing session removes group and tab reverse indexes", () => {
  const store = new SessionContextStore();
  activeSession(store);
  store.registerTab("session-a", 102, { state: TAB_STATE.ACTIVE });

  store.closeSession("session-a");

  assert.equal(store.ownerOfGroup(11), null);
  assert.equal(store.ownerOfTab(101), null);
  assert.equal(store.ownerOfTab(102), null);
  assert.throws(
    () => store.getSession("session-a"),
    (error) => error.code === "SESSION_NOT_FOUND",
  );
});

test("background imports the Session context module before handling commands", async () => {
  const { readFile } = await import("node:fs/promises");
  const background = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");

  assert.match(background, /importScripts\("session-context\.js"\)/);
  assert.match(background, /Link2ChromeSessionContext/);
});
