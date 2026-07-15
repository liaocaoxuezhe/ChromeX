import test from "node:test";
import assert from "node:assert/strict";

await import("../extension/session-context.js");
await import("../extension/popup-ownership.js");

const { SessionContextStore, TAB_STATE } = globalThis.Link2ChromeSessionContext;
const { PopupOwnershipManager } = globalThis.Link2ChromePopupOwnership;

function fixture() {
  const store = new SessionContextStore();
  store.registerSession({ sessionId: "s-a", ownerId: "a", groupId: 10, windowId: 1, revision: 1, state: "ACTIVE" });
  store.registerTab("s-a", 101, { state: TAB_STATE.ACTIVE });
  store.registerSession({ sessionId: "s-b", ownerId: "b", groupId: 20, windowId: 2, revision: 1, state: "ACTIVE" });
  store.registerTab("s-b", 202, { state: TAB_STATE.ACTIVE });
  const tabs = new Map([
    [101, { id: 101, openerTabId: null, groupId: 10, windowId: 1, active: false }],
    [202, { id: 202, openerTabId: null, groupId: 20, windowId: 2, active: false }],
  ]);
  const groups = [];
  const events = [];
  const chromeApi = {
    tabs: {
      group: async ({ groupId, tabIds }) => {
        groups.push({ groupId, tabIds });
        const tab = tabs.get(tabIds[0]);
        tab.groupId = groupId;
        return groupId;
      },
      get: async (tabId) => {
        const tab = tabs.get(tabId);
        if (!tab) throw new Error("missing tab");
        return { ...tab };
      },
      ungroup: async (tabIds) => {
        for (const tabId of Array.isArray(tabIds) ? tabIds : [tabIds]) tabs.get(tabId).groupId = -1;
      },
    },
  };
  const manager = new PopupOwnershipManager({ chromeApi, contextStore: store, emitEvent: (event) => events.push(event) });
  return { store, tabs, groups, events, manager };
}

test("concurrent popups correlate only by their opener owner", async () => {
  const f = fixture();
  f.tabs.set(301, { id: 301, openerTabId: 101, groupId: -1, windowId: 1, active: true });
  f.tabs.set(302, { id: 302, openerTabId: 202, groupId: -1, windowId: 2, active: true });
  await Promise.all([f.manager.handleCreated(f.tabs.get(301)), f.manager.handleCreated(f.tabs.get(302))]);
  assert.equal(f.store.ownerOfTab(301), "s-a");
  assert.equal(f.store.ownerOfTab(302), "s-b");
  assert.equal(f.store.getTab(301).state, TAB_STATE.ACTIVE);
  assert.equal(f.store.getTab(302).state, TAB_STATE.ACTIVE);
  assert.deepEqual(f.groups, [{ groupId: 10, tabIds: [301] }, { groupId: 20, tabIds: [302] }]);
  assert.equal(f.events.length, 2);
});

test("concurrent popups in one Session receive distinct monotonic revisions", async () => {
  const f = fixture();
  f.tabs.set(306, { id: 306, openerTabId: 101, groupId: -1, windowId: 1, active: false });
  f.tabs.set(307, { id: 307, openerTabId: 101, groupId: -1, windowId: 1, active: false });
  await Promise.all([f.manager.handleCreated(f.tabs.get(306)), f.manager.handleCreated(f.tabs.get(307))]);
  assert.deepEqual(f.events.map((event) => event.revision).sort((a, b) => a - b), [2, 3]);
  assert.equal(f.store.getSession("s-a").revision, 3);
});

test("missing opener and cross-window popup are quarantined without grouping", async () => {
  const f = fixture();
  f.tabs.set(303, { id: 303, groupId: -1, windowId: 1, active: false });
  f.tabs.set(304, { id: 304, openerTabId: 101, groupId: -1, windowId: 9, active: false });
  const missing = await f.manager.handleCreated(f.tabs.get(303));
  const crossWindow = await f.manager.handleCreated(f.tabs.get(304));
  assert.equal(missing.state, TAB_STATE.QUARANTINED);
  assert.equal(crossWindow.state, TAB_STATE.QUARANTINED);
  assert.equal(f.store.ownerOfTab(303), null);
  assert.equal(f.store.ownerOfTab(304), null);
  assert.deepEqual(f.groups, []);
});

test("opener disappearing during grouping quarantines and undoes the group", async () => {
  const f = fixture();
  f.tabs.set(305, { id: 305, openerTabId: 101, groupId: -1, windowId: 1, active: false });
  const originalGroup = f.manager.chrome.tabs.group;
  f.manager.chrome.tabs.group = async (args) => {
    const result = await originalGroup(args);
    f.store.removeTab("s-a", 101);
    return result;
  };
  const result = await f.manager.handleCreated(f.tabs.get(305));
  assert.equal(result.state, TAB_STATE.QUARANTINED);
  assert.equal(f.store.ownerOfTab(305), null);
  assert.equal(f.tabs.get(305).groupId, -1);
});
