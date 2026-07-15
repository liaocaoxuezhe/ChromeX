import test from "node:test";
import assert from "node:assert/strict";

await import("../extension/session-context.js");
await import("../extension/claim-manager.js");
const { SessionContextStore, TAB_STATE } = globalThis.Link2ChromeSessionContext;
const { SessionClaimManager } = globalThis.Link2ChromeClaimManager;

function fixture({ claimedWindow = 1, active = false, focusedWindowId = 1 } = {}) {
  const store = new SessionContextStore();
  store.registerSession({ sessionId: "s1", groupId: 10, windowId: 1, revision: 1, state: "ACTIVE" });
  store.registerTab("s1", 101, { state: TAB_STATE.ACTIVE });
  const tabs = new Map([
    [101, { id: 101, windowId: 1, groupId: 10, index: 0, active: false }],
    [300, { id: 300, windowId: claimedWindow, groupId: -1, index: 2, active }],
  ]);
  const calls = [];
  const chromeApi = {
    tabs: {
      get: async (id) => ({ ...tabs.get(id) }),
      group: async ({ groupId, tabIds }) => { calls.push(["group", groupId, tabIds]); Object.assign(tabs.get(tabIds[0]), { groupId, windowId: 1 }); return groupId; },
      ungroup: async (ids) => { calls.push(["ungroup", ids]); for (const id of ids) tabs.get(id).groupId = -1; },
      move: async (id, options) => { calls.push(["move", id, options]); Object.assign(tabs.get(id), { windowId: options.windowId, index: options.index }); },
    },
    windows: {
      getLastFocused: async () => ({ id: focusedWindowId }),
      get: async (id) => ({ id }),
    },
    tabGroups: { get: async (id) => ({ id, windowId: tabs.get(300).windowId }) },
  };
  return { store, tabs, calls, manager: new SessionClaimManager({ chromeApi, contextStore: store }) };
}

test("same-window inactive tab can be claimed and restored without activation APIs", async () => {
  const f = fixture();
  const claimed = await f.manager.claim({ sessionId: "s1", tabId: 300, expectedRevision: 1, revision: 2 });
  assert.equal(f.store.ownerOfTab(300), "s1");
  assert.equal(f.store.getTab(300).state, TAB_STATE.ACTIVE);
  assert.equal(claimed.restore.groupId, -1);
  await f.manager.release({ sessionId: "s1", tabId: 300, expectedRevision: 2, revision: 3 });
  assert.equal(f.store.ownerOfTab(300), null);
  assert.equal(f.tabs.get(300).groupId, -1);
  assert.equal(f.calls.some(([name]) => name === "update"), false);
});

test("focused active cross-window tab is rejected before mutation", async () => {
  const f = fixture({ claimedWindow: 2, active: true, focusedWindowId: 2 });
  await assert.rejects(() => f.manager.claim({ sessionId: "s1", tabId: 300, expectedRevision: 1, revision: 2 }), (error) => error.code === "CLAIM_WOULD_CHANGE_FOCUS");
  assert.deepEqual(f.calls, []);
  assert.equal(f.store.ownerOfTab(300), null);
});

test("foreign-owned tab is rejected", async () => {
  const f = fixture();
  f.store.registerSession({ sessionId: "s2", groupId: 20, windowId: 1, revision: 1, state: "ACTIVE" });
  f.store.registerTab("s2", 300, { state: TAB_STATE.ACTIVE });
  await assert.rejects(() => f.manager.claim({ sessionId: "s1", tabId: 300, expectedRevision: 1, revision: 2 }), (error) => error.code === "TAB_ALREADY_OWNED");
});

test("inactive cross-window tab is rejected to guarantee no focus or active-tab changes", async () => {
  const f = fixture({ claimedWindow: 2, active: false, focusedWindowId: 1 });
  await assert.rejects(
    () => f.manager.claim({ sessionId: "s1", tabId: 300, expectedRevision: 1, revision: 2 }),
    (error) => error.code === "CLAIM_WOULD_CHANGE_FOCUS",
  );
  assert.deepEqual(f.calls, []);
});

test("claim rejects a stale Extension revision before Chrome mutation", async () => {
  const f = fixture();
  await assert.rejects(
    () => f.manager.claim({ sessionId: "s1", tabId: 300, expectedRevision: 0, revision: 1 }),
    (error) => error.code === "STALE_SESSION_REVISION",
  );
  assert.deepEqual(f.calls, []);
});

test("claim abort restores Chrome ownership and the previous revision", async () => {
  const f = fixture();
  await f.manager.claim({ sessionId: "s1", tabId: 300, expectedRevision: 1, revision: 2 });
  await f.manager.abortClaim({ sessionId: "s1", tabId: 300, expectedRevision: 2, revision: 1 });
  assert.equal(f.store.ownerOfTab(300), null);
  assert.equal(f.store.getSession("s1").revision, 1);
  assert.equal(f.tabs.get(300).groupId, -1);
});

test("release abort reclaims the tab and restores the previous revision", async () => {
  const f = fixture();
  await f.manager.claim({ sessionId: "s1", tabId: 300, expectedRevision: 1, revision: 2 });
  const released = await f.manager.release({ sessionId: "s1", tabId: 300, expectedRevision: 2, revision: 3 });
  await f.manager.abortRelease({
    sessionId: "s1", tabId: 300, restore: released.restored,
    expectedRevision: 3, revision: 2,
  });
  assert.equal(f.store.ownerOfTab(300), "s1");
  assert.equal(f.store.getTab(300).ownershipType, "claimed");
  assert.equal(f.store.getSession("s1").revision, 2);
  assert.equal(f.tabs.get(300).groupId, 10);
});
