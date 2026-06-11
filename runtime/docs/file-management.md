## 文件管理指南

本文档说明如何在 Link2Chrome 中处理文件上传和下载。

### 文件上传

Link2Chrome 支持通过 Playwright Locator 向文件输入框设置本地文件路径：

```js
const locator = tab.playwright.locator('input[type="file"]');
await locator.setFiles("/path/to/file.pdf");
```

也支持批量上传：

```js
await locator.setFiles(["/path/to/a.png", "/path/to/b.png"]);
```

上传操作会触发安全确认（若配置了 `confirmAction`）。

### 文件下载

#### 等待下载事件

使用 Playwright 的 `waitForEvent` 捕获由点击触发的下载：

```js
const [download] = await Promise.all([
  tab.playwright.waitForEvent("download"),
  tab.playwright.getByText("下载报告").click(),
]);
```

`waitForEvent("download")` 会等待 Extension 发出的下载事件，并返回下载信息。

#### 触发媒体下载

对于页面上的媒体元素（`img`、`video`、`a`），可使用 Locator 的 `downloadMedia` 方法：

```js
const locator = tab.playwright.locator('img#chart');
const { url, suggestedFilename } = await locator.downloadMedia({
  suggestedFilename: "chart.png",
});
```

该方法通过创建临时 `<a download>` 元素触发浏览器下载。返回的 `url` 是元素解析后的 `src` 或 `href`。

### 注意事项

- 下载事件依赖 Chrome Extension 的监听能力，仅对通过常规点击或 `downloadMedia` 触发的下载有效。
- 文件路径必须使用绝对路径，或相对于 Node.js Runtime 工作目录的相对路径。
- 上传前请确认文件存在，否则 Extension 会返回错误。
