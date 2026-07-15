import assert from "node:assert/strict";
import test from "node:test";

import sessionContextApi from "../extension/session-context.js";
import debuggerApi from "../extension/debugger-context.js";

const { SessionContextStore } = sessionContextApi;
const { MultiTargetDebuggerManager } = debuggerApi;

function setup() {
  const calls = [];
  const chromeApi = {
    debugger: {
      async attach(target, version) {
        calls.push(["attach", { ...target }, version]);
      },
      async detach(target) {
        calls.push(["detach", { ...target }]);
      },
      async sendCommand(target, method, params) {
        calls.push(["send", { ...target }, method, { ...params }]);
        return { tabId: target.tabId, method };
      },
    },
  };
  const contexts = new SessionContextStore();
  for (const [sessionId, groupId, tabId] of [
    ["session-a", 11, 101],
    ["session-b", 22, 202],
  ]) {
    contexts.registerSession({
      sessionId,
      ownerId: `owner-${sessionId}`,
      alias: "research",
      groupId,
      windowId: 1,
      targetTabId: tabId,
      revision: 1,
      state: "ACTIVE",
    });
    contexts.registerTab(sessionId, tabId, { state: "ACTIVE" });
  }
  const manager = new MultiTargetDebuggerManager({
    chromeApi,
    sessionContextStore: contexts,
  });
  return { calls, chromeApi, contexts, manager };
}

test("attaching a second session tab does not detach the first", async () => {
  const { manager, calls } = setup();

  await Promise.all([
    manager.ensureAttached(101, "session-a"),
    manager.ensureAttached(202, "session-b"),
  ]);

  assert.deepEqual(
    calls.filter(([name]) => name === "attach").map(([, target]) => target.tabId).sort(),
    [101, 202],
  );
  assert.equal(calls.some(([name]) => name === "detach"), false);
  assert.equal(manager.getContext(101).attached, true);
  assert.equal(manager.getContext(202).attached, true);
});

test("concurrent ensureAttached for one tab shares one attach promise", async () => {
  const { manager, calls } = setup();

  await Promise.all([
    manager.ensureAttached(101, "session-a"),
    manager.ensureAttached(101, "session-a"),
    manager.ensureAttached(101, "session-a"),
  ]);

  assert.equal(calls.filter(([name]) => name === "attach").length, 1);
});

test("send always preserves explicit tab identity", async () => {
  const { manager, calls } = setup();

  const [resultA, resultB] = await Promise.all([
    manager.send(101, "session-a", "Runtime.evaluate", { expression: "'a'" }),
    manager.send(202, "session-b", "Runtime.evaluate", { expression: "'b'" }),
  ]);

  assert.equal(resultA.tabId, 101);
  assert.equal(resultB.tabId, 202);
  const sends = calls.filter(([name]) => name === "send");
  assert.deepEqual(sends.map(([, target]) => target.tabId), [101, 202]);
});

test("foreign Session cannot attach or send to another Session tab", async () => {
  const { manager, calls } = setup();

  await assert.rejects(
    manager.ensureAttached(202, "session-a"),
    (error) => error.code === "TAB_OUTSIDE_SESSION",
  );

  assert.equal(calls.length, 0);
});

test("events route only to matching per-tab capture context", async () => {
  const { manager } = setup();
  const routed = [];
  manager.onEvent((context, method, params) => {
    context.consoleCapture.entries.push(params.value);
    routed.push([context.tabId, method]);
  });

  manager.routeEvent({ tabId: 101 }, "Runtime.consoleAPICalled", { value: "a" });
  manager.routeEvent({ tabId: 202 }, "Runtime.consoleAPICalled", { value: "b" });

  assert.deepEqual(routed, [
    [101, "Runtime.consoleAPICalled"],
    [202, "Runtime.consoleAPICalled"],
  ]);
  assert.deepEqual(manager.getContext(101).consoleCapture.entries, ["a"]);
  assert.deepEqual(manager.getContext(202).consoleCapture.entries, ["b"]);
});

test("detaching or closing one tab leaves other contexts attached", async () => {
  const { manager, calls } = setup();
  await manager.ensureAttached(101, "session-a");
  await manager.ensureAttached(202, "session-b");

  await manager.detach(101);

  assert.equal(manager.getContext(101).attached, false);
  assert.equal(manager.getContext(202).attached, true);
  assert.deepEqual(
    calls.filter(([name]) => name === "detach").map(([, target]) => target.tabId),
    [101],
  );

  manager.remove(101);
  assert.equal(manager.getContext(101), null);
  assert.equal(manager.getContext(202).attached, true);
});

test("background imports multi-target debugger and never detaches previous target on switch", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");
  const ensureBody = source.split("async function ensureDebuggerAttached", 2)[1]
    .split("async function sendCDP", 1)[0];

  assert.match(source, /importScripts\("debugger-context\.js"\)/);
  assert.match(ensureBody, /multiTargetDebuggerManager\.ensureAttached/);
  assert.doesNotMatch(ensureBody, /detachDebuggerTab\(previousTabId\)/);
  assert.doesNotMatch(source, /const networkCaptureState\s*=/);
  assert.doesNotMatch(source, /const consoleCaptureState\s*=/);
  assert.doesNotMatch(source, /let currentDialog\s*=/);
  assert.match(source, /getTabAutomationState\(params\.tabId\)/);
});

test("every background sendCDP call carries an explicit tab identity", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");
  const calls = [];
  let cursor = 0;

  while ((cursor = source.indexOf("sendCDP(", cursor)) !== -1) {
    if (source.slice(Math.max(0, cursor - 20), cursor).includes("function ")) {
      cursor += 8;
      continue;
    }
    let depth = 1;
    let objectDepth = 0;
    let commas = 0;
    let quote = null;
    let escaped = false;
    let index = cursor + "sendCDP(".length;
    for (; index < source.length && depth > 0; index += 1) {
      const char = source[index];
      if (quote) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === quote) quote = null;
        continue;
      }
      if (char === '"' || char === "'" || char === "`") {
        quote = char;
      } else if (char === "(" ) {
        depth += 1;
      } else if (char === ")") {
        depth -= 1;
      } else if (char === "{" || char === "[") {
        objectDepth += 1;
      } else if (char === "}" || char === "]") {
        objectDepth -= 1;
      } else if (char === "," && depth === 1 && objectDepth === 0) {
        commas += 1;
      }
    }
    const line = source.slice(0, cursor).split("\n").length;
    calls.push({ line, commas, text: source.slice(cursor, Math.min(index, cursor + 120)) });
    cursor = index;
  }

  const implicitCalls = calls.filter((call) => call.commas < 2);
  assert.deepEqual(implicitCalls, []);
  assert.doesNotMatch(source, /expectedTabId\s*=\s*targetTabId/);
});
