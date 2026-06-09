---
name: link2chrome-browser-mcp
description: Use when controlling Chrome or Tabbit through the Link2Chrome MCP gateway, inspecting live webpages, extracting DOM/content, navigating tabs, or combining DOM/CDP, CUA, and Playwright endpoint control surfaces.
---

# Link2Chrome Browser MCP

## Code-first Runtime

多步浏览器自动化优先写 JavaScript 调 `runtime/link2chrome-client.mjs`，用 Browser、Tab、Locator 和 CUA 对象组织流程。一次性的小操作再直接调用 MCP tools。

```js
const browser = await link2chrome.browsers.get("extension");
const tab = await browser.tabs.selected();
await tab.playwright.getByRole("button", { name: "提交" }).click();
```

## 控制面组合

任务是健壮自动化、测试、需要 Playwright API，或由 browser-use 驱动：
使用 `browser.pw.start`，再用 `browser.pw.endpoint` 取得 CDP URL。

否则要控制用户正在使用、已登录的真实浏览器：
有稳定选择器、结构化交互、需要省 token 时，用 `browser.dom.*`。
页面偏视觉、canvas、图片内容、表格坐标或选择器不稳定时，用 `browser.cua.*`。

三组控制面是并行能力，不是三选一开关。`browser.pw.*` 是 endpoint 控制面，不代表 Link2Chrome 引入本地 Playwright 包。

## 工具地图

- **连接诊断**：`browser_diagnose`
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
