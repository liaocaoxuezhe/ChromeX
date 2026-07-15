import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

function loadPolicy() {
  const context = vm.createContext({});
  context.globalThis = context;
  vm.runInContext(
    readFileSync(new URL("../extension/focus-policy.js", import.meta.url), "utf8"),
    context
  );
  return context.Link2ChromeFocusPolicy;
}

function between(source, start, end) {
  return source.split(start, 2)[1].split(end, 1)[0];
}

test("后台标签参数忽略 active 和 selected 请求", () => {
  const policy = loadPolicy();
  const props = policy.buildBackgroundTabCreateProperties(
    { url: "https://example.com", active: true, selected: true },
    { id: 7, windowId: 3, index: 4 }
  );

  assert.deepEqual(JSON.parse(JSON.stringify(props)), {
    url: "https://example.com",
    windowId: 3,
    index: 5,
    openerTabId: 7,
    active: false,
  });
});

test("background.js 只通过 createBackgroundTab 创建标签", () => {
  const source = readFileSync(
    new URL("../extension/background.js", import.meta.url),
    "utf8"
  );

  assert.match(source, /async function createBackgroundTab/);
  assert.equal((source.match(/chrome\.tabs\.create\(/g) || []).length, 1);
  assert.match(source, /chrome\.tabs\.create\(buildBackgroundTabCreateProperties/);
});

test("自动化目标变化不会激活标签或聚焦窗口", () => {
  const source = readFileSync(
    new URL("../extension/background.js", import.meta.url),
    "utf8"
  );
  const switchBody = between(
    source,
    "async function cmdAgentBrowserTabSwitch",
    "async function cmdAgentBrowserTabNew"
  );
  const legacySwitchBody = between(source, 'case "switch": {', 'case "list": {');
  const detectorBody = between(
    source,
    "async function detectActionTabChange",
    "// -- type --"
  );

  for (const body of [switchBody, legacySwitchBody, detectorBody]) {
    assert.doesNotMatch(body, /chrome\.tabs\.update\([^\n]*active\s*:\s*true/);
    assert.doesNotMatch(body, /chrome\.windows\.update\([^\n]*focused\s*:\s*true/);
  }
  assert.match(switchBody, /targetTabId = tabId/);
  assert.match(detectorBody, /targetTabId = openedTabId/);
});

test("debugger attachment 只可复用于期望标签", () => {
  const policy = loadPolicy();

  assert.equal(policy.canReuseDebuggerAttachment(7, 7), true);
  assert.equal(policy.canReuseDebuggerAttachment(7, 8), false);
  assert.equal(policy.canReuseDebuggerAttachment(null, 8), false);
  assert.equal(policy.canReuseDebuggerAttachment(7, null), false);
});

test("background debugger 路径显式校验期望标签", () => {
  const source = readFileSync(
    new URL("../extension/background.js", import.meta.url),
    "utf8"
  );
  const ensureBody = between(
    source,
    "async function ensureDebuggerAttached",
    "async function sendCDP"
  );
  const sendBody = between(source, "async function sendCDP", "async function sleep");

  assert.match(source, /ensureDebuggerAttached\(expectedTabId = targetTabId\)/);
  assert.match(ensureBody, /canReuseDebuggerAttachment\(attachedTabId, expectedTabId\)/);
  assert.doesNotMatch(ensureBody, /findUsableTabId/);
  assert.match(sendBody, /ensureDebuggerAttached\(expectedTabId\)/);
});

test("目标变化保留旧 attachment 身份供 debugger 重绑", () => {
  const source = readFileSync(
    new URL("../extension/background.js", import.meta.url),
    "utf8"
  );
  const detectorBody = between(
    source,
    "async function detectActionTabChange",
    "// -- type --"
  );
  const legacyNewBody = between(source, 'case "new": {', 'case "close": {');
  const agentNewBody = between(
    source,
    "async function cmdAgentBrowserTabNew",
    "async function cmdAgentBrowserTabClose"
  );
  const groupCreateBody = between(
    source,
    "async function cmdTabGroupCreate",
    "async function cmdTabGroupAdd"
  );

  for (const body of [detectorBody, legacyNewBody, agentNewBody, groupCreateBody]) {
    assert.doesNotMatch(body, /attachedTabId = null/);
  }
});
