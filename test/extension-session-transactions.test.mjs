import assert from "node:assert/strict";
import test from "node:test";

import sessionContextApi from "../extension/session-context.js";
import transactionApi from "../extension/session-transactions.js";

const { SessionContextStore } = sessionContextApi;
const { SessionTransactionError, SessionTransactionManager } = transactionApi;

function createChromeMock({ failGroup = false, wrongGroup = false } = {}) {
  const calls = [];
  const tabs = new Map([
    [1, { id: 1, windowId: 1, index: 0, active: true, groupId: -1, url: "https://user.test" }],
  ]);
  let nextTabId = 100;
  let nextGroupId = 10;

  const chromeApi = {
    windows: {
      async getLastFocused() {
        calls.push(["windows.getLastFocused"]);
        return { id: 1, type: "normal", focused: true };
      },
      async getAll() {
        calls.push(["windows.getAll"]);
        return [{
          id: 1,
          type: "normal",
          focused: true,
          tabs: [...tabs.values()].filter((tab) => tab.windowId === 1),
        }];
      },
      async update() {
        throw new Error("windows.update must never be called");
      },
    },
    tabs: {
      async create(properties) {
        calls.push(["tabs.create", { ...properties }]);
        assert.equal(properties.active, false);
        const tab = {
          id: nextTabId++,
          windowId: properties.windowId,
          index: tabs.size,
          active: false,
          groupId: -1,
          url: properties.url,
        };
        tabs.set(tab.id, tab);
        return { ...tab };
      },
      async group(options) {
        calls.push(["tabs.group", { ...options }]);
        if (failGroup) throw new Error("group failed");
        const groupId = options.groupId ?? nextGroupId++;
        for (const tabId of Array.isArray(options.tabIds) ? options.tabIds : [options.tabIds]) {
          tabs.get(tabId).groupId = wrongGroup ? groupId + 999 : groupId;
        }
        return groupId;
      },
      async get(tabId) {
        calls.push(["tabs.get", tabId]);
        const tab = tabs.get(tabId);
        if (!tab) throw new Error(`missing tab ${tabId}`);
        return { ...tab };
      },
      async remove(tabId) {
        calls.push(["tabs.remove", tabId]);
        tabs.delete(tabId);
      },
      async update() {
        throw new Error("tabs.update must never be called");
      },
      async highlight() {
        throw new Error("tabs.highlight must never be called");
      },
    },
    tabGroups: {
      async update(groupId, properties) {
        calls.push(["tabGroups.update", groupId, { ...properties }]);
        return { id: groupId, windowId: 1, ...properties };
      },
      async get(groupId) {
        calls.push(["tabGroups.get", groupId]);
        return { id: groupId, windowId: 1, title: "Research", color: "blue" };
      },
    },
  };

  return { chromeApi, calls, tabs };
}

function createManager(options = {}) {
  const mock = createChromeMock(options);
  const contextStore = new SessionContextStore();
  const manager = new SessionTransactionManager({
    chromeApi: mock.chromeApi,
    contextStore,
    createBackgroundTab: (properties) => mock.chromeApi.tabs.create({ ...properties, active: false }),
  });
  return { ...mock, contextStore, manager };
}

test("createGroup creates inactive seed, groups, verifies, and commits context", async () => {
  const { manager, contextStore, calls } = createManager();

  const result = await manager.createGroup({
    sessionId: "session-a",
    ownerId: "owner-a",
    alias: "research",
    title: "Research",
    expectedRevision: 0,
    revision: 1,
  });

  assert.deepEqual(result, {
    sessionId: "session-a",
    groupId: 10,
    windowId: 1,
    tabId: 100,
    focusPreserved: true,
  });
  assert.deepEqual(calls[2], ["tabs.create", { url: "about:blank", windowId: 1, active: false }]);
  assert.deepEqual(calls[3], ["tabs.group", { tabIds: [100], createProperties: { windowId: 1 } }]);
  assert.equal(contextStore.ownerOfGroup(10), "session-a");
  assert.equal(contextStore.ownerOfTab(100), "session-a");
  assert.equal(contextStore.getTab(100).state, "ACTIVE");
});

test("createGroup rolls back seed and context when grouping fails", async () => {
  const { manager, contextStore, calls, tabs } = createManager({ failGroup: true });

  await assert.rejects(
    manager.createGroup({
      sessionId: "session-a", ownerId: "owner-a", alias: "research",
      title: "Research", expectedRevision: 0, revision: 1,
    }),
    /group failed/,
  );

  assert.equal(tabs.has(100), false);
  assert.equal(contextStore.ownerOfTab(100), null);
  assert.throws(() => contextStore.getSession("session-a"), /not registered/);
  assert.ok(calls.some(([name, tabId]) => name === "tabs.remove" && tabId === 100));
});

test("createGroup rolls back when actual Chrome group does not match", async () => {
  const { manager, contextStore, tabs } = createManager({ wrongGroup: true });

  await assert.rejects(
    manager.createGroup({
      sessionId: "session-a", ownerId: "owner-a", alias: "research",
      title: "Research", expectedRevision: 0, revision: 1,
    }),
    (error) => error instanceof SessionTransactionError && error.code === "GROUP_VERIFICATION_FAILED",
  );

  assert.equal(tabs.has(100), false);
  assert.equal(contextStore.ownerOfGroup(10), null);
});

test("createTab stays pending until real group verification succeeds", async () => {
  const { manager, contextStore, calls } = createManager();
  await manager.createGroup({
    sessionId: "session-a", ownerId: "owner-a", alias: "research",
    title: "Research", expectedRevision: 0, revision: 1,
  });

  const result = await manager.createTab({
    sessionId: "session-a",
    url: "https://example.com",
    expectedRevision: 1,
    revision: 2,
  });

  assert.deepEqual(result, {
    sessionId: "session-a", groupId: 10, windowId: 1, tabId: 101,
    focusPreserved: true,
  });
  assert.equal(contextStore.getTab(101).state, "ACTIVE");
  assert.equal(contextStore.getSession("session-a").targetTabId, 101);
  assert.ok(calls.some(([name, options]) =>
    name === "tabs.group" && options.groupId === 10 && options.tabIds[0] === 101));
});

test("createTab failure closes only the new tab and keeps existing session", async () => {
  const { manager, contextStore, chromeApi, tabs } = createManager();
  await manager.createGroup({
    sessionId: "session-a", ownerId: "owner-a", alias: "research",
    title: "Research", expectedRevision: 0, revision: 1,
  });
  chromeApi.tabs.group = async () => { throw new Error("add failed"); };

  await assert.rejects(
    manager.createTab({ sessionId: "session-a", url: "https://example.com", expectedRevision: 1, revision: 2 }),
    /add failed/,
  );

  assert.equal(tabs.has(100), true);
  assert.equal(tabs.has(101), false);
  assert.equal(contextStore.ownerOfTab(100), "session-a");
  assert.equal(contextStore.ownerOfTab(101), null);
});

test("background exposes atomic V2 commands without activation APIs", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");

  assert.match(source, /importScripts\("session-transactions\.js"\)/);
  assert.match(source, /case "session_create_group"/);
  assert.match(source, /case "session_create_tab"/);
  assert.doesNotMatch(source, /chrome\.tabs\.highlight\(/);
});
