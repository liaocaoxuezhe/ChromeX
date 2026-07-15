# Link2Chrome Focus-Safe Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让所有 Link2Chrome 自动化标签在后台创建和运行，自动化目标切换、点击开页、CDP 执行及 runtime 启动均不改变用户当前标签或窗口焦点。

**Architecture:** 用 `extension/focus-policy.js` 提供可离线单测的纯焦点策略，`background.js` 只通过统一 `createBackgroundTab()` 建页，并把“选择目标”与 Chrome UI 激活彻底分开。debugger 必须核对期望 `tabId` 后才能复用 attachment；server/runtime 保留旧参数签名但不再透传聚焦字段，Node runtime 从扩展内部目标而不是 `raw.active` 恢复页面绑定。

**Tech Stack:** Chrome Extension Manifest V3、JavaScript、Node.js `node:test`、Python 3.9/pytest、MCP server。

## Global Constraints

- 写入和编辑文件必须保持 UTF-8 中文兼容。
- 新增测试文件必须放在 `/Users/zhangyu/PycharmProjects/Link2Chrome/test`。
- 用户本地 Python 基线是 3.9；如果测试依赖不支持 Python 3.9，使用项目内虚拟环境，不向全局 Python 安装依赖。
- 自动化路径不得调用 `chrome.tabs.update(..., { active: true })` 或 `chrome.windows.update(..., { focused: true })`。
- 所有扩展主动创建的自动化标签固定 `active: false`。
- `active`、`focusWindow` 保留为 deprecated compatibility no-op，不新增 handoff API。
- 生产代码改动必须先有失败测试，并观察到与目标行为对应的失败原因。

---

### Task 1: 可测试的焦点策略与统一后台建页

**Files:**
- Create: `extension/focus-policy.js`
- Create: `test/extension-focus-policy.test.mjs`
- Modify: `extension/background.js`

**Interfaces:**
- Produces: `Link2ChromeFocusPolicy.buildBackgroundTabCreateProperties(options, anchorTab)`，返回强制 `active:false` 的 Chrome `tabs.create` 参数。
- Produces: `createBackgroundTab(options)`，返回 `Promise<chrome.tabs.Tab>`，是生产代码唯一允许调用 `chrome.tabs.create()` 的入口。

- [ ] **Step 1: 写后台建页失败测试**

```javascript
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

function loadPolicy() {
  const context = vm.createContext({});
  context.globalThis = context;
  vm.runInContext(readFileSync(new URL("../extension/focus-policy.js", import.meta.url), "utf8"), context);
  return context.Link2ChromeFocusPolicy;
}

test("background tab properties ignore active and selected requests", () => {
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

test("background.js creates tabs only through createBackgroundTab", () => {
  const source = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
  assert.match(source, /async function createBackgroundTab/);
  assert.equal((source.match(/chrome\.tabs\.create\(/g) || []).length, 1);
  assert.match(source, /chrome\.tabs\.create\(buildBackgroundTabCreateProperties/);
});
```

- [ ] **Step 2: 运行测试并确认 RED**

Run: `node --test test/extension-focus-policy.test.mjs`

Expected: FAIL，因为 `extension/focus-policy.js` 和 `createBackgroundTab()` 尚不存在，且 `background.js` 有多个直接 `chrome.tabs.create()`。

- [ ] **Step 3: 实现纯策略和统一建页函数**

```javascript
// extension/focus-policy.js
(function installFocusPolicy(root) {
  function buildBackgroundTabCreateProperties(options = {}, anchorTab = null) {
    const { active: _active, selected: _selected, ...properties } = options || {};
    if (anchorTab) {
      if (properties.windowId == null && anchorTab.windowId != null) properties.windowId = anchorTab.windowId;
      if (properties.index == null && Number.isInteger(anchorTab.index)) properties.index = anchorTab.index + 1;
      if (properties.openerTabId == null && anchorTab.id != null) properties.openerTabId = anchorTab.id;
    }
    return { ...properties, active: false };
  }

  root.Link2ChromeFocusPolicy = Object.freeze({ buildBackgroundTabCreateProperties });
})(globalThis);
```

在 `background.js` 顶部加载策略，并将四个建页入口统一改成：

```javascript
importScripts("focus-policy.js");
const { buildBackgroundTabCreateProperties } = globalThis.Link2ChromeFocusPolicy;

async function createBackgroundTab(options = {}) {
  let anchorTab = null;
  if (targetTabId != null) anchorTab = await chrome.tabs.get(targetTabId).catch(() => null);
  return chrome.tabs.create(buildBackgroundTabCreateProperties(options, anchorTab));
}
```

- [ ] **Step 4: 运行测试并确认 GREEN**

Run: `node --test test/extension-focus-policy.test.mjs`

Run: `node --check extension/background.js`

Expected: PASS，且 `background.js` 中只有 helper 内的一次 `chrome.tabs.create()`。

- [ ] **Step 5: 提交 Task 1**

```bash
git add extension/focus-policy.js extension/background.js test/extension-focus-policy.test.mjs
git commit -m "fix: create automation tabs in background"
```

### Task 2: 目标切换和点击开页不改变 UI

**Files:**
- Modify: `test/extension-focus-policy.test.mjs`
- Modify: `extension/background.js`
- Modify: `test/test_focus_policy_static.py`

**Interfaces:**
- Consumes: `createBackgroundTab(options)`。
- Produces: `cmdAgentBrowserTabSwitch(params)` 和 `cmdTabManage({action:"switch"})` 仅更新内部目标。
- Produces: `detectActionTabChange(before)` 只返回并记录 `openedTabId`。

- [ ] **Step 1: 写切换和点击失败测试**

在 `test/extension-focus-policy.test.mjs` 增加函数块提取和断言：

```javascript
function between(source, start, end) {
  return source.split(start, 2)[1].split(end, 1)[0];
}

test("automation target changes never activate tabs or focus windows", () => {
  const source = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
  const switchBody = between(source, "async function cmdAgentBrowserTabSwitch", "async function cmdAgentBrowserTabNew");
  const legacySwitchBody = between(source, 'case "switch": {', 'case "list": {');
  const detectorBody = between(source, "async function detectActionTabChange", "// -- type --");
  for (const body of [switchBody, legacySwitchBody, detectorBody]) {
    assert.doesNotMatch(body, /active\s*:\s*true/);
    assert.doesNotMatch(body, /focused\s*:\s*true/);
  }
  assert.match(switchBody, /targetTabId = tabId/);
  assert.match(detectorBody, /targetTabId = openedTabId/);
});
```

把 `test/test_focus_policy_static.py` 的旧 opt-in 断言替换为 no-op 契约：

```python
def test_tab_switch_and_click_detection_never_change_browser_focus():
    background = _background()
    switch_body = background.split("async function cmdAgentBrowserTabSwitch", 1)[1].split("async function cmdAgentBrowserTabNew", 1)[0]
    detector_body = background.split("async function detectActionTabChange", 1)[1].split("// -- type --", 1)[0]
    for body in (switch_body, detector_body):
        assert "active: true" not in body
        assert "focused: true" not in body
```

- [ ] **Step 2: 运行测试并确认 RED**

Run: `node --test test/extension-focus-policy.test.mjs`

Expected: FAIL，指出 switch/detector 仍包含 `active:true` 或 `focused:true`。

- [ ] **Step 3: 删除 UI 焦点操作并保留内部目标更新**

```javascript
async function cmdAgentBrowserTabSwitch(params) {
  const tabId = params.tabId;
  if (!tabId) throw new Error("tabId is required");
  const tab = await chrome.tabs.get(tabId);
  targetTabId = tabId;
  if (attachedTabId !== tabId) attachedTabId = null;
  return { ok: true, tabId, url: tab.url };
}
```

`cmdTabManage(action="switch")` 删除 `chrome.tabs.update(...active:true)`；`detectActionTabChange()` 删除 `focusWindow`、`tabs.update` 和 `windows.update`；`cmdActionClick()` 调用检测器时不再传 `focusWindow`。

- [ ] **Step 4: 运行焦点策略测试**

Run: `node --test test/extension-focus-policy.test.mjs`

Run: `/opt/homebrew/bin/python3.9 -c "import runpy; ns=runpy.run_path('test/test_focus_policy_static.py'); [(ns[n](), print('PASS', n)) for n in sorted(k for k in ns if k.startswith('test_'))]"`

Expected: PASS。

- [ ] **Step 5: 提交 Task 2**

```bash
git add extension/background.js test/extension-focus-policy.test.mjs test/test_focus_policy_static.py
git commit -m "fix: separate automation targets from browser focus"
```

### Task 3: debugger 严格绑定期望 tabId

**Files:**
- Modify: `extension/focus-policy.js`
- Modify: `test/extension-focus-policy.test.mjs`
- Modify: `extension/background.js`

**Interfaces:**
- Produces: `Link2ChromeFocusPolicy.canReuseDebuggerAttachment(attachedTabId, expectedTabId)`。
- Produces: `ensureDebuggerAttached(expectedTabId = targetTabId)`。
- Produces: `sendCDP(method, params = {}, expectedTabId = targetTabId)`。

- [ ] **Step 1: 写 attachment 路由失败测试**

```javascript
test("debugger attachment is reusable only for the expected tab", () => {
  const policy = loadPolicy();
  assert.equal(policy.canReuseDebuggerAttachment(7, 7), true);
  assert.equal(policy.canReuseDebuggerAttachment(7, 8), false);
  assert.equal(policy.canReuseDebuggerAttachment(null, 8), false);
});

test("background debugger path validates the expected tab", () => {
  const source = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
  const ensureBody = between(source, "async function ensureDebuggerAttached", "async function sendCDP");
  const sendBody = between(source, "async function sendCDP", "async function sleep");
  assert.match(source, /ensureDebuggerAttached\(expectedTabId = targetTabId\)/);
  assert.match(ensureBody, /canReuseDebuggerAttachment\(attachedTabId, expectedTabId\)/);
  assert.match(sendBody, /ensureDebuggerAttached\(expectedTabId\)/);
});
```

- [ ] **Step 2: 运行测试并确认 RED**

Run: `node --test test/extension-focus-policy.test.mjs`

Expected: FAIL，因为 attachment 仍会无条件复用任意有效 `attachedTabId`。

- [ ] **Step 3: 实现显式目标核对**

策略模块增加：

```javascript
function canReuseDebuggerAttachment(attachedTabId, expectedTabId) {
  return expectedTabId != null && attachedTabId === expectedTabId;
}
```

`ensureDebuggerAttached()` 改为接收 `expectedTabId`。只有策略函数返回 true 时才验证并复用；不一致时 detach 旧 attachment，再只尝试 attach 到 `expectedTabId`。目标缺失、已关闭或不可调试时直接报错，不查询用户 active tab 作为降级目标。

`sendCDP()` 改为：

```javascript
async function sendCDP(method, params = {}, expectedTabId = targetTabId) {
  const timeout = params.timeout || CDP_COMMAND_TIMEOUT;
  const tabId = await withTimeout(
    ensureDebuggerAttached(expectedTabId),
    timeout,
    `Debugger attach timeout: ${method}`
  );
  return withTimeout(
    chrome.debugger.sendCommand({ tabId }, method, params),
    timeout,
    `CDP command timeout: ${method}`
  );
}
```

- [ ] **Step 4: 运行策略、语法和 session 测试**

Run: `node --test test/extension-focus-policy.test.mjs test/extension-session-scope.test.mjs test/session-scope-runtime.test.mjs`

Run: `node --check extension/background.js`

Expected: PASS。

- [ ] **Step 5: 提交 Task 3**

```bash
git add extension/focus-policy.js extension/background.js test/extension-focus-policy.test.mjs
git commit -m "fix: bind debugger commands to target tabs"
```

### Task 4: API 聚焦字段降级为 no-op

**Files:**
- Modify: `test/test_focus_policy_static.py`
- Modify: `test/runtime-client.test.mjs`
- Modify: `test/test_session_scope.py`
- Modify: `server/main.py`
- Modify: `server/tool_descriptions.py`
- Modify: `runtime/link2chrome-client.mjs`
- Modify: `plugins/chromex/skills/control-chromex/SKILL.md`

**Interfaces:**
- Consumes: 扩展后台建页和内部目标切换语义。
- Produces: 旧 `active`、`focusWindow` 输入继续通过 schema，但 server/runtime 下行消息不包含这些字段。

- [ ] **Step 1: 写兼容 no-op 失败测试**

Python 静态测试增加：

```python
def test_focus_compatibility_fields_are_not_forwarded():
    server_main = Path("server/main.py").read_text(encoding="utf-8")
    runtime = Path("runtime/link2chrome-client.mjs").read_text(encoding="utf-8")
    descriptions = Path("server/tool_descriptions.py").read_text(encoding="utf-8")
    assert '"focusWindow": args.get(' not in server_main
    assert '"active": args.get(' not in server_main
    assert "focusWindow: args.focusWindow" not in runtime
    assert "active: args.active" not in runtime
    assert "compatibility no-op" in descriptions
```

Node runtime client 测试把 `browser.tabs.new({active:true, focusWindow:true})` 的期望下行参数改为仅包含 `action/session/url/group_title`。Python session 测试把 seed switch 的期望参数改为仅包含 `tabId` 和 `scope`。

- [ ] **Step 2: 运行测试并确认 RED**

Run: `node --test test/runtime-client.test.mjs`

Expected: FAIL，显示 runtime 仍透传 `active` 和 `focusWindow`。

- [ ] **Step 3: 删除下行透传并更新描述**

server/runtime 继续接受调用参数，但构造 extension 命令时不包含 `active` 和 `focusWindow`。工具 schema 描述统一改为：

```text
Deprecated compatibility no-op. Automation tabs always stay in the background and Chrome windows are never focused.
```

插件技能文档删除 `focusWindow:true` 示例，声明需要人工接管时当前版本没有自动聚焦能力。

- [ ] **Step 4: 运行客户端与 Python 静态测试**

Run: `node --test test/runtime-client.test.mjs`

Run: `/opt/homebrew/bin/python3.9 -c "import runpy; ns=runpy.run_path('test/test_focus_policy_static.py'); [(ns[n](), print('PASS', n)) for n in sorted(k for k in ns if k.startswith('test_'))]"`

Expected: PASS。

- [ ] **Step 5: 提交 Task 4**

```bash
git add server/main.py server/tool_descriptions.py runtime/link2chrome-client.mjs plugins/chromex/skills/control-chromex/SKILL.md test/test_focus_policy_static.py test/runtime-client.test.mjs test/test_session_scope.py
git commit -m "fix: make focus options compatibility no-ops"
```

### Task 5: runtime 从内部目标绑定并完成全量验收

**Files:**
- Modify: `test/runtime-session-binding.test.mjs`
- Modify: `runtime/nodejs-playwright-runtime.mjs`
- Modify: `skills/link2chrome-browser-mcp/SKILL.md`
- Modify: `test/e2e/runtime-real-chrome.test.mjs`

**Interfaces:**
- Consumes: `browser.tabs.selected()` 返回扩展内部目标。
- Produces: `collectStartupSummary()` 不读取 `raw.active`，优先绑定内部目标，失败时回退到 scope 首个标签。

- [ ] **Step 1: 写 runtime 绑定失败测试**

```javascript
test("startup binds the extension target without reading browser active state", () => {
  assert.doesNotMatch(runtimeSource, /raw\?\.active/);
  assert.match(runtimeSource, /await browser\.tabs\.selected\(\)/);
  assert.match(runtimeSource, /globalThis\.tab = selected/);
});
```

- [ ] **Step 2: 运行测试并确认 RED**

Run: `node --test test/runtime-session-binding.test.mjs`

Expected: FAIL，因为 `collectStartupSummary()` 仍使用 `scopedTabs.find(tab => tab.raw?.active)`。

- [ ] **Step 3: 改为内部目标优先绑定**

```javascript
const scopedTabs = await browser.tabs.list();
summary.tabs = await Promise.all(scopedTabs.map((tab) => summarizeTab(tab)));
let selected = null;
try {
  selected = await browser.tabs.selected();
} catch {
  selected = scopedTabs[0] || null;
}
if (selected) {
  globalThis.tab = selected;
  summary.boundTab = await summarizeTab(selected);
  summary.group = summary.boundTab?.group ?? null;
  summary.source = "browser.tabs.selected";
  return summary;
}
```

技能文档同步声明 `page`/`globalThis.tab` 表示自动化内部目标，不表示 Chrome 当前可见标签。

- [ ] **Step 4: 运行 Node 全量测试**

Run: `node --test test/*.test.mjs`

Expected: 所有 Node 测试通过，0 fail。

- [ ] **Step 5: 创建隔离 Python 测试环境并运行全量 Python 测试**

先验证 3.9 兼容性：`/opt/homebrew/bin/python3.9 -m pip install --dry-run -r server/requirements.txt pytest pytest-asyncio`

如果依赖拒绝 Python 3.9，则使用独立环境：

```bash
python3 -m venv .venv-focus
.venv-focus/bin/python -m pip install -r server/requirements.txt pytest pytest-asyncio
.venv-focus/bin/python -m pytest test -q
```

Expected: pytest 0 fail；`.venv-focus` 保持未跟踪且不提交。

- [ ] **Step 6: 运行静态焦点审计**

Run: `rg -n "chrome\.tabs\.create\(|active\s*:\s*true|focused\s*:\s*true|focusWindow|raw\?\.active" extension server runtime plugins/chromex/skills skills/link2chrome-browser-mcp`

Expected: `chrome.tabs.create()` 只在 `createBackgroundTab()` 内出现；`active:true`/`focused:true` 在自动化生产路径中为 0；`focusWindow` 只存在于 schema/兼容说明或测试；runtime 不包含 `raw?.active`。

- [ ] **Step 7: 真实 Chrome 验证**

使用开发版扩展记录基线 `activeTabId` 和 `lastFocusedWindowId`，依次执行 session create、后台 new、目标 switch、点击打开新页、A/B 两个后台标签 `document.title` 读取。每一步重新读取 UI 状态并断言与基线一致，同时断言 `targetTabId` 和脚本结果来自期望后台标签。

Expected: 用户可见 active tab/window 始终不变；内部目标按命令变化；A/B 脚本结果无串页。

- [ ] **Step 8: 提交 Task 5**

```bash
git add runtime/nodejs-playwright-runtime.mjs skills/link2chrome-browser-mcp/SKILL.md test/runtime-session-binding.test.mjs test/e2e/runtime-real-chrome.test.mjs
git commit -m "fix: bind runtime to automation target"
```
