## 截图指南

本文档说明如何在 Link2Chrome 中获取截图，以及不同截图 API 的适用场景。

### 两种截图入口

1. **Tab 级别截图**：`await tab.screenshot(options)`
   - 返回 `Uint8Array`（二进制图像数据）。
   - 默认截取当前视口。
   - 可传入 `raw: true` 获取原始响应对象（含 base64 字符串和元数据）。

2. **Playwright 级别截图**：`await tab.playwright.screenshot(options)`
   - 行为与 `tab.screenshot()` 一致，提供统一的 Playwright 风格调用点。

### CUA 截图

`await tab.cua.screenshot()` 返回结构化对象，包含：

```js
{
  ok: true,
  format: "png",
  data: "<base64>",
  metadata: {
    coordinateSpace: "screenshot",
    devicePixelRatio: 2,
    cssViewport: { width: 1280, height: 720 },
    screenshotSize: { width: 2560, height: 1440 },
  },
}
```

CUA 截图的数据包含 `devicePixelRatio`，可用于将截图坐标换算为 CSS 坐标。

### 截图使用建议

- 在每次点击、滚动、输入之后，若视觉状态对下一步决策至关重要，优先截图确认。
- 若只需确认元素是否存在或文本内容，优先使用 `domSnapshot()` 或 Locator 查询，截图成本更高。
- 避免在同一轮对话中同时请求截图和 DOM 快照，除非两者各自提供不可替代的信息。
