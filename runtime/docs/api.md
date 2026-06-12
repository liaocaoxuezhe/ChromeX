## API Reference

本文档是 Link2Chrome Browser MCP 的完整 API 参考。所有接口均基于 `agent.browsers.*` 表面暴露，与 Codex Chrome Extension Plugin 的 API 签名保持一致。

```ts
// 通过 Node.js Runtime 注入的全局 agent 使用
const browser = await agent.browsers.get("extension");

interface Agent {
  browsers: Browsers;
  documentation: Documentation; // 通过 agent.documentation.get(name) 读取打包文档
}
```

---

## Browsers

浏览器发现与选择入口。

```ts
interface Browsers {
  get(id: string): Promise<Browser>;
  list(): Promise<Array<BrowserInfo>>;
}
```

- `await agent.browsers.list()` — 列出可用浏览器。当前仅返回 Link2Chrome Extension。
- `await agent.browsers.get("extension")` — 获取 Browser 实例。id 目前仅支持 `"extension"`。

---

## Browser

代表一个已连接的浏览器会话。

```ts
interface Browser {
  kind: string;
  tabs: Tabs;
  user: BrowserUser;
  capabilities: BrowserCapabilityCollection;
  documentation(): Promise<string>; // 返回本文档（api.md）的完整内容
  nameSession(name: string): Promise<{ ok: boolean; name: string }>;
}
```

- `browser.tabs` — Tab 管理表面。
- `browser.user` — 用户上下文表面（已打开标签页、历史记录）。
- `browser.capabilities` — 浏览器级别能力发现。使用 `await browser.capabilities.list()` 查看可用能力，再用 `await browser.capabilities.get(id)` 获取能力实例。
- `await browser.documentation()` — 返回核心 API 参考文档的 Markdown 字符串。
- `await browser.nameSession(name)` — 为当前浏览器自动化会话命名。

---

## BrowserUser

提供用户浏览器窗口的只读上下文。

```ts
interface BrowserUser {
  openTabs(): Promise<Array<Tab>>;
  claimTab(options: { tabId?: string | number }): Promise<Tab>;
  history(options?: { limit?: number; query?: string }): Promise<Array<BrowserHistoryEntry>>;
}
```

- `await browser.user.openTabs()` — 列出用户所有窗口中已打开的标签页，按最近打开排序。
- `await browser.user.claimTab({ tabId })` — 接管一个用户已打开的标签页，返回可控的 Tab 对象。
- `await browser.user.history(options)` — 列出最近的浏览历史，按访问时间降序排列。

---

## Tabs

标签页管理表面。

```ts
interface Tabs {
  list(): Promise<Array<Tab>>;
  selected(): Promise<Tab | null>;
  get(id: string | number): Promise<Tab | null>;
  new(url?: string, options?: object): Promise<Tab>;
  finalize(options?: { keep?: Array<{ tab: Tab; status: "handoff" | "deliverable" }> }): Promise<object>;
}
```

- `await browser.tabs.list()` — 获取所有打开的标签页列表。
- `await browser.tabs.selected()` — 获取当前选中的标签页。
- `await browser.tabs.get(id)` — 根据 id 获取特定标签页。
- `await browser.tabs.new(url)` — 新建标签页并可选导航到指定 URL。
- `await browser.tabs.finalize({ keep })` — 结束会话时清理标签页。未在 `keep` 中声明的标签页将被关闭。

---

## Tab

单个可控标签页。

```ts
interface Tab {
  id: string | number;
  active?: boolean;
  raw?: object;
  browser: Browser;

  url(): Promise<string | undefined>;
  title(): Promise<string | undefined>;
  goto(url: string): Promise<void>;
  reload(): Promise<void>;
  back(): Promise<void>;
  forward(): Promise<void>;
  goBack(): Promise<void>;
  goForward(): Promise<void>;
  info(): Promise<object>;
  screenshot(options?: ScreenshotOptions): Promise<Uint8Array>;
  waitFor(options?: { condition?: string; timeoutMs?: number }): Promise<void>;
  close(): Promise<void>;

  playwright: PlaywrightAPI;
  cua: CUAAPI;
  dom_cua: DomCUAAPI;
  dev: TabDevAPI;
  clipboard: TabClipboardAPI;
  dialog: TabDialogAPI;
  capabilities: TabCapabilityCollection;
}
```

- `await tab.url()` — 获取当前标签页的 URL（异步方法）。
- `await tab.title()` — 获取当前标签页的标题（异步方法）。
- `await tab.goto(url)` — 导航到指定 URL。
- `await tab.reload()` — 重新加载当前页面。
- `await tab.back()` / `await tab.goBack()` — 后退到历史记录中的上一页。
- `await tab.forward()` / `await tab.goForward()` — 前进到历史记录中的下一页。
- `await tab.info()` — 获取标签页的完整元数据。
- `await tab.screenshot(options)` — 截取当前标签页的屏幕截图，返回 `Uint8Array`。支持 `raw: true` 返回原始对象。
- `await tab.waitFor(options)` — 等待指定条件成立（如 `"dom-ready"`、`"network-idle"`）。
- `await tab.close()` — 关闭当前标签页。

---

## PlaywrightAPI

通过 `tab.playwright` 访问的 Playwright 风格操控表面。

```ts
interface PlaywrightAPI {
  domSnapshot(options?: object): Promise<string>;
  screenshot(options?: object): Promise<Uint8Array>;
  evaluate<TResult, TArg>(pageFunction: string | ((arg: TArg) => TResult | Promise<TResult>), arg?: TArg, options?: { timeoutMs?: number }): Promise<TResult>;
  expectNavigation<T>(action: () => Promise<T>, options?: { timeoutMs?: number }): Promise<{ from?: string; to?: string }>;
  waitForLoadState(stateOrOptions?: string | object, options?: object): Promise<void>;
  waitForURL(pattern: string, options?: { timeoutMs?: number }): Promise<void>;
  waitForTimeout(timeoutMs: number): Promise<void>;
  waitForEvent(event: "download" | "filechooser", options?: { timeoutMs?: number }): Promise<object>;

  locator(selector: string): PlaywrightLocator;
  frameLocator(selector: string): PlaywrightFrameLocator;
  getByText(text: string | RegExp, options?: { exact?: boolean }): PlaywrightLocator;
  getByRole(role: string, options?: { name?: string | RegExp; exact?: boolean }): PlaywrightLocator;
  getByLabel(text: string | RegExp, options?: { exact?: boolean }): PlaywrightLocator;
  getByPlaceholder(text: string | RegExp, options?: { exact?: boolean }): PlaywrightLocator;
  getByTestId(testId: string): PlaywrightLocator;

  fillForm(fields: Array<{ selector: string; value: string }>, options?: object): Promise<void>;
}
```

- `await tab.playwright.domSnapshot()` — 返回当前页面的 DOM 快照字符串，包含标题、按钮、输入框、链接等结构化摘要。
- `await tab.playwright.evaluate(script, arg)` — 在页面上下文中执行 JavaScript。支持传入字符串或函数。
- `await tab.playwright.expectNavigation(action)` — 执行一个可能触发导航的动作，等待 URL 发生变化。
- `await tab.playwright.waitForLoadState(state)` — 等待页面到达特定加载状态：`"load"`、`"domcontentloaded"`、`"networkidle"`。
- `await tab.playwright.waitForURL(pattern)` — 轮询等待当前 URL 匹配给定 glob 模式。
- `await tab.playwright.waitForTimeout(ms)` — 固定休眠指定毫秒数。
- `await tab.playwright.waitForEvent("download")` — 等待下一次下载事件。返回下载信息对象。
- `tab.playwright.locator(selector)` — 创建 CSS 选择器定位器。
- `tab.playwright.frameLocator(selector)` — 创建 iframe 作用域定位器（仅支持同源 iframe）。
- `tab.playwright.getByText(text)` — 按可见文本定位元素。
- `tab.playwright.getByRole(role, { name })` — 按 ARIA role 定位元素，可附加名称过滤。
- `tab.playwright.getByLabel(label)` — 按 aria-label 属性定位元素。
- `tab.playwright.getByPlaceholder(placeholder)` — 按 placeholder 属性定位元素。
- `tab.playwright.getByTestId(testId)` — 按 data-testid / data-test-id / data-test 定位元素。

---

## PlaywrightFrameLocator

iframe 作用域定位器（同源）。

```ts
interface PlaywrightFrameLocator {
  frameLocator(selector: string): PlaywrightFrameLocator;
  locator(selector: string): PlaywrightLocator;
  getByText(text: string | RegExp, options?: { exact?: boolean }): PlaywrightLocator;
  getByRole(role: string, options?: { name?: string | RegExp; exact?: boolean }): PlaywrightLocator;
  getByLabel(text: string | RegExp, options?: { exact?: boolean }): PlaywrightLocator;
  getByPlaceholder(text: string | RegExp, options?: { exact?: boolean }): PlaywrightLocator;
  getByTestId(testId: string): PlaywrightLocator;
}
```

- `frame.frameLocator(selector)` — 进入嵌套 iframe。
- `frame.locator(selector)` — 在 iframe 内创建 CSS 定位器。
- 其余 `getBy*` 方法与 PlaywrightAPI 语义一致，但作用域限定在 iframe 内。

---

## PlaywrightLocator

元素定位器。所有定位器方法均支持链式调用和 iframe 上下文（`frameContext`）。

```ts
interface PlaywrightLocator {
  all(): Promise<Array<PlaywrightLocator>>;
  allTextContents(options?: { timeoutMs?: number }): Promise<Array<string>>;
  and(other: PlaywrightLocator): PlaywrightLocator;
  or(other: PlaywrightLocator): PlaywrightLocator;
  first(): PlaywrightLocator;
  last(): PlaywrightLocator;
  nth(index: number): PlaywrightLocator;
  filter(options: { hasText?: string | RegExp; hasNotText?: string | RegExp; has?: PlaywrightLocator; hasNot?: PlaywrightLocator; visible?: boolean }): PlaywrightLocator;
  locator(selector: string, options?: { hasText?: string | RegExp; hasNotText?: string | RegExp; has?: PlaywrightLocator; hasNot?: PlaywrightLocator }): PlaywrightLocator;

  count(): Promise<number>;
  click(options?: { force?: boolean; timeoutMs?: number }): Promise<void>;
  dblclick(options?: object): Promise<void>;
  fill(value: string, options?: { timeoutMs?: number }): Promise<void>;
  type(value: string, options?: { timeoutMs?: number }): Promise<void>;
  hover(options?: object): Promise<void>;
  press(key: string, options?: object): Promise<void>;
  selectOption(value: string | Array<string>, options?: object): Promise<void>;
  check(options?: object): Promise<void>;
  uncheck(options?: object): Promise<void>;
  setChecked(checked: boolean, options?: object): Promise<void>;
  setFiles(paths: string | Array<string>, options?: object): Promise<void>;
  waitFor(options?: { state?: "attached" | "detached" | "visible" | "hidden"; timeoutMs?: number }): Promise<void>;

  textContent(options?: { timeoutMs?: number }): Promise<string | null>;
  allTextContents(options?: { timeoutMs?: number }): Promise<Array<string>>;
  innerText(options?: { timeoutMs?: number }): Promise<string>;
  getAttribute(name: string, options?: { timeoutMs?: number }): Promise<string | null>;
  inputValue(options?: object): Promise<string | null>;
  isVisible(): Promise<boolean>;
  isEnabled(): Promise<boolean>;
  boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null>;
  downloadMedia(options?: { timeoutMs?: number; suggestedFilename?: string }): Promise<{ url: string; suggestedFilename: string | null }>;

  getByText(text: string | RegExp, options?: { exact?: boolean }): PlaywrightLocator;
  getByRole(role: string, options?: { name?: string | RegExp; exact?: boolean }): PlaywrightLocator;
  getByLabel(text: string | RegExp, options?: { exact?: boolean }): PlaywrightLocator;
  getByPlaceholder(text: string | RegExp, options?: { exact?: boolean }): PlaywrightLocator;
  getByTestId(testId: string): PlaywrightLocator;
}
```

- `await locator.count()` — 返回匹配元素的数量。
- `await locator.click()` — 点击匹配的元素（默认严格模式：必须唯一匹配）。
- `await locator.fill(text)` — 清空并输入文本。
- `await locator.type(text)` — 输入文本但不清空原有内容。
- `await locator.hover()` — 悬停在元素上。
- `await locator.press(key)` — 在聚焦元素上按下键盘按键。
- `await locator.selectOption(value)` — 选择 `<select>` 元素的选项。
- `await locator.check()` / `await locator.uncheck()` — 勾选 / 取消勾选复选框。
- `await locator.setChecked(true | false)` — 设置复选框状态。
- `await locator.setFiles(paths)` — 为文件输入框设置上传文件路径。
- `await locator.waitFor(options)` — 等待元素进入指定状态（`attached`/`detached`/`visible`/`hidden`）。
- `await locator.textContent()` — 返回第一个匹配元素的原始 `textContent`。
- `await locator.innerText()` — 返回第一个匹配元素的渲染后可见文本（`innerText`）。
- `await locator.allTextContents()` — 返回所有匹配元素的文本内容数组。
- `await locator.getAttribute(name)` — 获取属性值。
- `await locator.inputValue()` — 获取输入框的当前值（等同于 `getAttribute("value")`）。
- `await locator.isVisible()` — 判断元素是否可见。
- `await locator.isEnabled()` — 判断元素是否可用（可见且可聚焦）。
- `await locator.boundingBox()` — 获取元素在页面中的边界框坐标。
- `await locator.downloadMedia(options)` — 触发媒体元素（`img`、`video`、`a`）的下载。
- `locator.filter(options)` — 通过文本、子元素或可见性进一步过滤定位器。
- `locator.and(other)` / `locator.or(other)` — 逻辑与 / 或组合定位器。

---

## CUAAPI

Computer Use Agent 表面，通过视口坐标进行交互。

```ts
interface CUAAPI {
  screenshot(options?: object): Promise<object>;
  click(x: number, y: number, options?: object): Promise<void>;
  click(options: { x: number; y: number; button?: number; keypress?: string[] }): Promise<void>;
  double_click(options: { x: number; y: number; keypress?: string[] }): Promise<void>;
  move(x: number, y: number, options?: object): Promise<void>;
  move(options: { x: number; y: number; keys?: string[] }): Promise<void>;
  type(text: string, options?: object): Promise<void>;
  type(options: { text: string }): Promise<void>;
  keypress(options: { keys: string[] }): Promise<void>;
  key(combo: string, options?: object): Promise<void>;
  scroll(dx?: number, dy?: number, options?: object): Promise<void>;
  scroll(options: { x?: number; y?: number; scrollX?: number; scrollY?: number; keypress?: string[] }): Promise<void>;
  drag(x1: number, y1: number, x2: number, y2: number, options?: object): Promise<void>;
  drag(options: { path: Array<{ x: number; y: number }>; keys?: string[] }): Promise<void>;
}
```

- `await tab.cua.screenshot()` — 截取视口截图，返回含 base64 数据和元数据的对象。
- `await tab.cua.click({ x, y })` — 在视口坐标处点击。`button` 支持数值映射（1-left, 2-middle, 3-right, 4-back, 5-forward）。
- `await tab.cua.double_click({ x, y })` — 双击。
- `await tab.cua.move({ x, y })` — 移动鼠标到指定坐标。
- `await tab.cua.type({ text })` — 在当前焦点处输入文本。
- `await tab.cua.keypress({ keys: ["Control", "a"] })` — 发送组合键。
- `await tab.cua.key(combo)` — 发送按键组合字符串（如 `"Control+a"`）。
- `await tab.cua.scroll({ scrollX, scrollY })` — 在指定坐标处滚动。
- `await tab.cua.drag({ path: [{x,y}, {x,y}] })` — 沿路径拖拽。支持旧签名 `drag(x1, y1, x2, y2)`。

---

## DomCUAAPI

基于 DOM 的 CUA 表面，通过 `get_visible_dom()` 获取的 node_id 进行交互。

```ts
interface DomCUAAPI {
  get_visible_dom(options?: object): Promise<object>;
  query(selector: string, options?: object): Promise<object>;
  click(options: { node_id: string }): Promise<void>;
  double_click(options: { node_id: string }): Promise<void>;
  keypress(options: { keys: string[] }): Promise<void>;
  scroll(options: { node_id?: string; x: number; y: number }): Promise<void>;
  type(options: { text: string }): Promise<void>;
}
```

- `await tab.dom_cua.get_visible_dom()` — 返回带 node_id 的可交互元素过滤 DOM 快照。
- `await tab.dom_cua.query(selector)` — 查询 DOM 元素。
- `await tab.dom_cua.click({ node_id })` — 点击指定 node_id 的元素。
- `await tab.dom_cua.double_click({ node_id })` — 双击指定 node_id 的元素。
- `await tab.dom_cua.scroll({ x, y, node_id? })` — 滚动页面或指定节点。
- `await tab.dom_cua.type({ text })` — 在焦点元素输入文本。
- `await tab.dom_cua.keypress({ keys })` — 发送组合键。

---

## TabClipboardAPI

剪贴板操作表面。

```ts
interface TabClipboardAPI {
  readText(options?: object): Promise<string>;
  writeText(text: string, options?: object): Promise<void>;
  read(): Promise<Array<TabClipboardItem>>;
  write(items: Array<TabClipboardItem>): Promise<void>;
}
```

- `await tab.clipboard.readText()` — 读取剪贴板纯文本。
- `await tab.clipboard.writeText(text)` — 写入纯文本到剪贴板。
- `await tab.clipboard.read()` — 读取完整剪贴板条目（含二进制）。
- `await tab.clipboard.write(items)` — 写入多条剪贴板条目。

---

## TabDialogAPI

浏览器对话框（alert / confirm / prompt）处理表面。

```ts
interface TabDialogAPI {
  accept(options?: { promptText?: string }): Promise<void>;
  dismiss(options?: object): Promise<void>;
}
```

- `await tab.dialog.accept()` — 接受当前对话框。
- `await tab.dialog.dismiss()` — 取消当前对话框。

---

## TabDevAPI

开发者工具表面，包含 Console 和 Network 子表面。

```ts
interface TabDevAPI {
  console: ConsoleDevSurface;
  network: NetworkDevSurface;
}

interface ConsoleDevSurface {
  start(options?: object): Promise<object>;
  stop(options?: object): Promise<object>;
  status(options?: object): Promise<object>;
  list(options?: object): Promise<object>;
  get(id: string): Promise<object>;
  clear(): Promise<object>;
}

interface NetworkDevSurface {
  start(options?: object): Promise<object>;
  stop(options?: object): Promise<object>;
  status(options?: object): Promise<object>;
  clear(options?: object): Promise<object>;
  list(options?: object): Promise<object>;
  query(options?: object): Promise<object>;
  fetch(options?: object): Promise<object>;
  replay(options?: object): Promise<object>;
}
```

---

## CapabilityCollection

能力发现集合，同时存在于 `browser.capabilities`（浏览器级别）和 `tab.capabilities`（标签页级别）。

```ts
interface CapabilityCollection {
  list(): Promise<Array<{ id: string; description: string }>>;
  get(id: string): Promise<unknown>;
}
```

- `await capabilities.list()` — 列出已注册的能力 ID 和描述。
- `await capabilities.get(id)` — 获取能力实例。若 ID 不存在则抛出错误并列出可用能力。

当前已注册的标签页级别能力：
- `pageAssets` — 列举并打包当前页面已加载的资源。提供 `list()`、`bundle({ outputDir })` 和 `documentation()` 方法。

---

## Documentation

文档读取表面。

```ts
interface Documentation {
  get(name: string): Promise<string>;
}
```

- `await agent.documentation.get("api")` — 返回本文档。
- `await agent.documentation.get("playwright")` — 返回 Playwright 使用指南。
- `await agent.documentation.get("screenshots")` — 返回截图相关指南。
- `await agent.documentation.get("confirmations")` — 返回用户确认策略指南。
- `await agent.documentation.get("file-management")` — 返回文件上传下载指南。
- `await agent.documentation.get("api-troubleshooting")` — 返回 API 排错指南。

若传入未知名称，会抛出包含可用名称列表的错误。

---

## 类型别名速查

```ts
type TextMatcher = string | RegExp;
type LoadState = "load" | "domcontentloaded" | "networkidle";
type WaitForState = "attached" | "detached" | "visible" | "hidden";
type MouseButton = "left" | "right" | "middle";
type KeyboardModifier = "Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift";

type ScreenshotOptions = {
  clip?: { x: number; y: number; width: number; height: number };
  fullPage?: boolean;
};

type TabClipboardItem = {
  entries: Array<{ mimeType: string; text?: string; base64?: string }>;
  presentationStyle?: "unspecified" | "inline" | "attachment";
};
```
