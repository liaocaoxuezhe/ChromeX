---
name: link2chrome-browser-mcp
description: Use when controlling Chrome or Tabbit through the Link2Chrome MCP gateway, inspecting live webpages, extracting DOM/content, navigating tabs, or combining DOM/CDP, CUA, and Playwright endpoint control surfaces.
---

# Link2Chrome Browser MCP

## Playwright Node.js Runtime

`playwright_run` 是**首选的多步自动化方式**。代码在真实的 Node.js 子进程中执行，通过 `link2chrome-client.mjs` 的 WebSocket transport 连接 Browser Hub，而非在 Extension Service Worker 内运行。

### 运行环境

- **Node.js 子进程**：Python MCP Server spawn Node.js 子进程，通过 stdio（每行一个 JSON）进行 IPC
- **预注入对象**：`link2chrome` 和 `agent` 对象已预注入全局作用域
- **变量持久化**：使用 `globalThis` 的 REPL 上下文，跨 tool call 的变量自动保持。第一次调用 `const tab = ...`，第二次调用可直接使用 `tab`

### 代码示例

```js
// 第一次调用：获取 browser 和 tab，存入 globalThis
const browser = await link2chrome.browsers.get("extension");
const tab = await browser.tabs.selected();
const snapshot = await tab.playwright.domSnapshot();
return { title: snapshot.title, url: snapshot.url };
```

```js
// 第二次调用：直接使用已保存的 tab 变量
// 前提：snapshot 仍有效，无需重新获取
await tab.playwright.getByRole("button", { name: "提交" }).click();
await tab.playwright.waitForLoadState("networkidle");
return { ok: true };
```

```js
// 完整流程：导航 → 填表 → 提交
const browser = await link2chrome.browsers.get("extension");
const tab = await browser.tabs.selected();
await tab.goto("https://example.com/form");
await tab.playwright.waitForLoadState("dom-ready");

const pw = tab.playwright;
await pw.getByLabel("用户名").fill("alice");
await pw.getByPlaceholder("请输入密码").fill("secret123");
await pw.getByRole("button", { name: "登录" }).click();

return { ok: true };
```

### 支持的 API

**Tab 导航**
- `tab.goto(url)`、`tab.reload()`、`tab.goBack()`、`tab.goForward()`、`tab.close()`

**Browser / Tabs**
- `browser.tabs.list()`、`browser.tabs.selected()`、`browser.tabs.new(url)`、`browser.tabs.finalize({ keep })`

**Playwright Surface**
- `tab.playwright.domSnapshot()` — 获取页面结构化 DOM 快照
- `tab.playwright.waitForLoadState(state)` — 等待 load / dom-ready / networkidle
- `tab.playwright.locator(selector)` — CSS 选择器定位器
- `tab.playwright.getByText(text)` — 文本匹配定位器
- `tab.playwright.getByRole(role, { name })` — ARIA role + name 定位器
- `tab.playwright.getByLabel(label)` — label 文本定位器
- `tab.playwright.getByPlaceholder(placeholder)` — placeholder 定位器
- `tab.playwright.getByTestId(testId)` — data-testid 定位器

**Locator 操作**
- `locator.count()`、`locator.click()`、`locator.fill(text)`、`locator.hover()`、`locator.press(key)`
- `locator.first()`、`locator.nth(index)`、`locator.last()`、`locator.filter({ hasText })`

## Snapshot Discipline

在使用 Playwright Node.js Runtime 进行自动化时，必须遵循以下三条核心纪律：

### 1. 先观察再行动

构造任何 locator 前，**必须先调用 `tab.playwright.domSnapshot()`** 获取页面当前状态。禁止在没见过 snapshot 的情况下盲猜选择器。

```js
// ✅ 正确：先观察
const snapshot = await tab.playwright.domSnapshot();
const submitBtn = tab.playwright.getByRole("button", { name: "提交" });
await submitBtn.click();

// ❌ 错误：盲猜选择器
await tab.playwright.locator(".btn").click(); // 不知道页面是否有 .btn
```

### 2. 复用 snapshot

获取一次 snapshot 后，在**证明过期前**复用它来判断元素存在性、构造 locator。不要每次操作前都重新获取。

```js
// ✅ 正确：一次 snapshot，多次使用
const snapshot = await tab.playwright.domSnapshot();
await tab.playwright.getByRole("textbox", { name: "用户名" }).fill("alice");
await tab.playwright.getByRole("textbox", { name: "密码" }).fill("secret");
await tab.playwright.getByRole("button", { name: "登录" }).click();
```

### 3. 失败即重取

如果操作抛出 `LocatorNotFoundError`、`StrictModeError` 或任何与 DOM 不匹配的错误，**立即重新获取 snapshot**，不要重试同一选择器。

```js
// ✅ 正确：失败后重新观察
let snapshot = await tab.playwright.domSnapshot();
const btn = tab.playwright.getByText("确认");
try {
  await btn.click();
} catch (e) {
  // 页面可能已变化，重新获取 snapshot
  snapshot = await tab.playwright.domSnapshot();
  // 基于新 snapshot 重新构造 locator
  await tab.playwright.getByRole("button", { name: "确认" }).click();
}
```

## Locator 策略

构造 locator 时按以下**6 级优先级**选择策略，越靠前越稳定：

| 优先级 | 策略 | 示例 |
|---|---|---|
| 1 | `data-testid` | `tab.playwright.getByTestId("submit-btn")` |
| 2 | 其他 `data-*` 属性 | `tab.playwright.locator("[data-action='submit']")` |
| 3 | `href` / `src` | `tab.playwright.locator("a[href='/login']")` |
| 4 | `role + name` | `tab.playwright.getByRole("button", { name: "提交" })` |
| 5 | 可见文本 | `tab.playwright.getByText("提交订单")` |
| 6 | CSS / XPath | `tab.playwright.locator("form > button.primary")` |

### 规则

- **模糊标签必须 scope 到容器**：如果页面有多个 "确定" 按钮，必须用容器限定范围。优先使用 `getByRole` + name，而非纯文本。
- **禁止 `.first()` 绕过 `count() > 1`**：如果 `locator.count()` 返回大于 1，说明选择器不够精确。应当缩小选择器范围，而不是用 `.first()` 强行选取第一个。

```js
// ❌ 错误：多个匹配时用 .first() 掩盖问题
await tab.playwright.getByText("确定").first().click();

// ✅ 正确：缩小范围到具体区域
const form = tab.playwright.locator("#payment-form");
await form.locator("button").filter({ hasText: "确定" }).click();
// 或者更精确：
await tab.playwright.getByRole("button", { name: "确认支付" }).click();
```

## 控制面组合

Link2Chrome 提供三组**并行控制面**，不是三选一开关：

| 场景 | 推荐控制面 | 原因 |
|---|---|---|
| 多步自动化、表单填写、循环提取 | **`playwright_run`** | 代码优先，变量持久化，最少往返 |
| 需要 Playwright 完整 API 或 browser-use 集成 | **`browser.pw.*`** | 取得 CDP endpoint，连接外部 Playwright |
| 稳定选择器、结构化交互、省 token | **`browser.dom.*`** | 确定性 DOM 操作，精确可靠 |
| 视觉页面、canvas、图片、表格、选择器不稳定 | **`browser.cua.*`** | 截图 + 坐标，视觉驱动 |

- `playwright_run` 是 Node.js 进程中执行的**代码优先运行时**，适合 3 步以上的连续自动化。
- `browser.pw.*`（`browser.pw.start`、`browser.pw.endpoint`、`browser.pw.stop`）是**CDP endpoint 控制面**，用于连接本地 Playwright 或 browser-use，不代表 Link2Chrome 引入本地 Playwright 包。
- 三组控制面可以混用：先用 `playwright_run` 完成大部分自动化，再用 `browser.cua.screenshot` 做视觉验证。

## 工具地图

- **连接诊断**：`browser_diagnose`
- **Playwright Runtime（首选）**：`playwright_run` — 在 Node.js 子进程中执行 Playwright 风格代码
- **标签/导航**：`browser_tabs_list`、`browser_tab_switch`、`browser_tab_new`、`browser_tab_info`、`browser_navigate`
- **DOM/CDP**：`browser.dom.overview`、`browser.dom.query`、`browser.dom.search`、`browser.dom.click`、`browser.dom.type`、`browser.dom.scroll`
- **CUA**：先 `browser.cua.screenshot`，由主模型看图决定坐标，再用 `browser.cua.click`、`browser.cua.drag`、`browser.cua.type`、`browser.cua.key`、`browser.cua.scroll`
- **Playwright endpoint**：`browser.pw.start`、`browser.pw.endpoint`、`browser.pw.stop`
- **网络/控制台**：`network_capture`、`network_query`、`network_replay`、`console_capture`、`console_list`
- **提取/脚本**：`browser_dom_get_text`、`browser_scrape_with_scroll`、`script_evaluate`

## CUA 坐标契约

`browser.cua.screenshot` 返回截图、CSS viewport、DPR 和截图尺寸。`browser.cua.*` 的 x/y 输入是截图像素；服务端会按 DPR 转成 CSS 像素再派发 CDP 事件。非多模态模型优先用 DOM/CDP 或 Playwright endpoint 控制面。

## 操作纪律

先观察，再做一个最小动作，然后验证。DOM 控制面优先等待具体后置条件；CUA 控制面先截图、小步点击或拖拽、再截图/DOM 验证；Playwright endpoint 控制面先确认 endpoint 可用。

## 错误恢复

| 错误类型 | 典型原因 | 恢复策略 |
|---|---|---|
| **StrictModeError** | locator 匹配到多个元素 | 缩小选择器范围，使用更精确的 role+name 或 data-testid |
| **LocatorNotFoundError** | 元素不存在或选择器错误 | 重新调用 `domSnapshot()` 观察页面当前状态，再构造新 locator |
| **TimeoutError** | 等待超时（网络慢、元素未出现） | 增加 timeout；检查页面是否加载完成；必要时重新获取 snapshot |
| **NodeJSRuntimeError** | Node.js 子进程未启动或崩溃 | 运行诊断脚本 `node scripts/check-node-env.mjs` 检查环境；检查 `setup-playwright-runtime.mjs` 输出 |

## 环境检测

当 `playwright_run` 报 Node.js 相关错误时，按以下顺序诊断：

```bash
# 1. 检查 Node.js 环境和依赖
node scripts/check-node-env.mjs

# 2. 运行完整诊断和自动修复
node scripts/setup-playwright-runtime.mjs
```

- `check-node-env.mjs` 检查 Node.js 版本（≥18）、ESM 支持、WebSocket 可用性
- `setup-playwright-runtime.mjs` 提供完整诊断输出，并尝试自动修复常见问题
- 如果 Node.js Runtime 不可用，`playwright_run` 会自动**降级**到 Extension Service Worker 内的原有执行路径
