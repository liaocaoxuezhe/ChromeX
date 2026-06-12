## API 排错指南

本文档列出使用 Link2Chrome API 时的常见错误及解决方法。

### Client 初始化失败

**错误**：`createLink2ChromeClient requires a transport with command(name, args)`

- 原因：未传入有效的 transport，或 transport 缺少 `command` 方法。
- 解决：使用 `createWebSocketTransport({ url })` 或自定义符合接口的 transport。

**错误**：`Link2Chrome command timed out: <command>`

- 原因：Chrome Extension 未运行，或 WebSocket Hub 未启动。
- 解决：确认 Chrome 已启动且 Extension 已安装并启用。检查 Hub 是否在 `ws://localhost:8766` 监听。

### Tab 操作失败

**错误**：`unsupported browser kind: <kind>`

- 原因：`agent.browsers.get()` 传入了非 `"extension"` 的 kind。
- 解决：当前仅支持 `await agent.browsers.get("extension")`。

**错误**：`Locator did not match any element: <selector>`

- 原因：定位器未匹配到任何元素。
- 解决：先使用 `await tab.playwright.domSnapshot()` 查看页面结构，确认选择器或文本正确。若页面是动态加载的，先 `await tab.playwright.waitForLoadState("networkidle")`。

**错误**：`Strict mode violation: locator resolved to N elements: <selector>`

- 原因：定位器匹配到多个元素，而操作要求唯一匹配。
- 解决：使用 `.first()`、`.last()` 或 `.nth(index)` 缩小范围；或改用更具体的选择器。

### iframe 相关

**错误**：`frame_evaluate` 命令超时或返回空结果

- 原因：目标 iframe 可能是跨源的，或选择器未匹配到 iframe。
- 解决：Link2Chrome 的 `frameLocator` 仅支持同源 iframe。确认 iframe 与主页面同协议、同域名、同端口。

### 下载相关

**错误**：`waitForEvent("download")` 超时

- 原因：点击未触发下载，或 Extension 未捕获到下载事件。
- 解决：确认点击的元素确实是下载链接。可改用 `locator.downloadMedia()` 直接触发下载。

### 剪贴板相关

**错误**：`clipboard_read` 或 `clipboard_write` 失败

- 原因：浏览器剪贴板 API 需要用户手势或 HTTPS 上下文。
- 解决：确保操作是在用户激活的页面上执行的。对于本地 HTTP 页面，部分浏览器会限制剪贴板访问。

### 通用建议

1. **始终等待页面稳定后再操作**：导航后使用 `waitForLoadState("networkidle")`。
2. **使用 DOM 快照调试**：不确定页面结构时，先 `console.log(await tab.playwright.domSnapshot())`。
3. **检查 readiness**：在脚本开头调用 `await client.diagnostics.readiness()`，确认 Extension 已连接且选中标签页可用。
