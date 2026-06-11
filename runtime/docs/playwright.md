## Playwright 使用指南

本文档介绍如何高效使用 `tab.playwright` API 进行浏览器自动化。

### 核心原则：先快照、后行动

在每次点击、输入或滚动之后，优先获取一次新的 DOM 快照或截图，确认页面状态再执行下一步。这能避免在元素尚未加载完成时就进行操作。

```js
const tab = await browser.tabs.selected();
await tab.goto("https://example.com");
await tab.playwright.waitForLoadState("networkidle");
console.log(await tab.playwright.domSnapshot());
```

### Locator 策略

优先使用语义化定位器，而非原始 CSS 选择器。语义化定位器对页面结构变化的鲁棒性更强。

| 场景 | 推荐方式 |
|------|----------|
| 按可见文本查找 | `tab.playwright.getByText("提交")` |
| 按按钮/链接角色查找 | `tab.playwright.getByRole("button", { name: "保存" })` |
| 按输入框标签查找 | `tab.playwright.getByLabel("用户名")` |
| 按占位符查找 | `tab.playwright.getByPlaceholder("请输入邮箱")` |
| 按测试 ID 查找 | `tab.playwright.getByTestId("login-btn")` |
| 复杂层级 | `tab.playwright.locator("#form").getByText("提交")` |

### iframe 支持

对于同源 iframe，使用 `frameLocator` 进入帧上下文：

```js
const frame = tab.playwright.frameLocator("iframe#content");
await frame.locator("button").click();
```

支持链式进入嵌套 iframe：`tab.playwright.frameLocator("#a").frameLocator("#b").locator("button")`。

### 等待策略

- 页面刚导航完：先 `await tab.playwright.waitForLoadState("networkidle")`。
- 等待某个元素出现：`await locator.waitFor({ state: "visible", timeoutMs: 10000 })`。
- 等待 URL 变化：`await tab.playwright.waitForURL("**/success")`。
- 等待下载：`const download = await tab.playwright.waitForEvent("download")`。

### 严格模式

默认情况下，Playwright Locator 要求唯一匹配。若定位器匹配到 0 个元素会抛出 `LocatorNotFoundError`；匹配到多个会抛出 `StrictModeError`。如需允许多个匹配，先用 `.first()`、`.last()` 或 `.nth(index)` 缩小范围。

```js
// 错误：若有多个按钮会抛 StrictModeError
await tab.playwright.getByRole("button").click();

// 正确：先缩小到第一个
await tab.playwright.getByRole("button").first().click();
```

### 表单填写

对于简单表单，可直接使用 `fill`：

```js
await tab.playwright.getByLabel("用户名").fill("admin");
await tab.playwright.getByLabel("密码").fill("secret");
await tab.playwright.getByRole("button", { name: "登录" }).click();
```

对于多字段表单，可使用 `fillForm`：

```js
await tab.playwright.fillForm([
  { selector: "#user", value: "admin" },
  { selector: "#pass", value: "secret" },
]);
```
