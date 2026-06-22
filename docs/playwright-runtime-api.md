# Playwright Runtime API

本文档记录 Link2Chrome Playwright Node.js Runtime 的 API 变更与使用指引。完整 API 参考请见 [`runtime/docs/api.md`](../runtime/docs/api.md)。

## 快速开始

```js
const browser = await agent.browsers.get("extension");
const tab = await browser.tabs.new("https://example.com");
console.log(await browser.documentation());
```

`agent` 与 `browser` 已预注入 `browser_code_run` 的全局作用域，变量跨调用通过 `globalThis` 持久化。通过 MCP `browser_code_run(session="...")` 执行时，运行时已经绑定到该 session；代码内部不要使用另一个名字重新 `browser.nameSession(...)`。`browser.tabs.list()`、`browser.tabs.new()`、`browser.user.claimTab()` 和 `browser.tabs.finalize()` 都会绑定到当前 session。

## Breaking Changes

### 1. `tab.url` / `tab.title` 已方法化

| 旧写法 | 新写法 |
|--------|--------|
| `tab.url`（数据属性） | `await tab.url()`（异步方法） |
| `tab.title`（数据属性） | `await tab.title()`（异步方法） |

这两个方法内部通过 `browser_tab_info` 取实时值，不再依赖构造时的快照。

### 2. CUA 签名对齐 Codex

CUA 方法现在以 **options 对象 + snake_case** 为主签名：

| 旧写法 | 新写法（推荐） |
|--------|--------------|
| `tab.cua.click(x, y)` | `tab.cua.click({ x, y })` |
| `tab.cua.doubleClick(x, y)` | `tab.cua.double_click({ x, y })` |
| `tab.cua.key(combo)` | `tab.cua.keypress({ keys: ["Control", "a"] })` |
| `tab.cua.scroll(dx, dy)` | `tab.cua.scroll({ scrollX, scrollY })` |
| `tab.cua.drag(x1, y1, x2, y2)` | `tab.cua.drag({ path: [{x,y}, {x,y}] })` |

旧位置参数在运行时仍兼容（自动检测首参是否为对象），但文档与示例均使用新签名。

### 3. `waitForLoadState` 状态名修正

| 旧值 | 新值 |
|------|------|
| `"dom-ready"` | `"domcontentloaded"` |

兼容对象入参：`await tab.playwright.waitForLoadState({ state: "domcontentloaded", timeoutMs: 100 })`。

## 新增 API 速查

以下 API 为本次 Codex 对齐新增或补齐：

- **Browser**: `documentation()`, `nameSession()`, `capabilities`
- **Tab**: `back()`, `forward()`, `screenshot()`, `clipboard`, `dev`, `capabilities`
- **PlaywrightSurface**: `evaluate()`, `waitForTimeout()`, `waitForURL()`, `expectNavigation()`, `waitForEvent("download")`, `frameLocator()`
- **PlaywrightLocator**: `all()`, `innerText()`, `type()`, `locator()`（后代链式）, `getByText/getByRole/getByLabel/getByPlaceholder/getByTestId`（Locator 作用域内）, `downloadMedia()`, `waitFor()`
- **CUA**: `double_click()`, `keypress()`, `move()`
- **DomCUA**: `get_visible_dom()`, `double_click()`, `keypress()`, `scroll()`, `type()`
- **Clipboard**: `read()`, `write()`, `readText()`, `writeText()`
- **Dev**: `logs()`
- **Documentation**: `agent.documentation.get(name)` — `api`, `playwright`, `screenshots`, `confirmations`, `file-management`, `api-troubleshooting`

## Node.js Runtime 强制优先

`playwright_run` 强制优先使用 Node.js Runtime。当 Node.js 不可用时，返回明确错误信息（含安装指引），不再默默降级到 Extension Service Worker。

```bash
# 诊断命令
node scripts/check-node-env.mjs
node scripts/setup-playwright-runtime.mjs
```

## Session-First Runtime

- `await browser.nameSession("任务名")` 可在纯 runtime 场景创建 session；通过 MCP `browser_code_run(session="...")` 进入时，外层 session 是权威边界。
- `await browser.tabs.list()` 只返回当前 session 内的标签页。
- `await browser.user.openTabs()` 返回用户标签页候选和 `claimToken`；只能把返回对象原样传给 `browser.user.claimTab(tab)`。
- `await browser.tabs.finalize({ keep })` 会关闭未保留的 agent-created 标签页，并释放 claimed 用户标签页。
- 未命名 session 时，启动摘要返回 `sessionRequired: true`，不会自动绑定用户当前 active tab。

## 旧签名兼容

以下旧签名在运行时仍可用，但不再出现在文档示例中：

- `tab.goBack()` → 等价于 `tab.back()`
- `tab.goForward()` → 等价于 `tab.forward()`
- `link2chrome.browsers` → 等价于 `agent.browsers`
- `cua.click(x, y)` → 等价于 `cua.click({ x, y })`
- `dom_cua.visibleDom()` → 等价于 `dom_cua.get_visible_dom()`
