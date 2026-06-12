## Chrome 故障排查

当 `browser_code_run` 或浏览器控制出现连接、扩展或通信失败时，**先完整读本文档再重试**。不要在没有定位根因前反复重试同一操作、切换浏览器选择器或猜测其它路径。

## 通用原则

- Link2Chrome 的链路是：`Claude Code ↔ MCP Server (Python) ↔ WebSocket Hub (ws://localhost:8766) ↔ Chrome Extension ↔ CDP ↔ 浏览器标签页`。任一环断开都会导致命令超时或失败。
- 排查顺序由近及远：先确认 Node.js Runtime 就绪 → 再确认 WebSocket Hub 在监听 → 再确认 Extension 已安装并启用 → 最后确认 Chrome 正在运行。
- 优先使用 MCP 工具 `browser_diagnose` 做一次性体检，它会返回 Hub、Extension、WebSocket、目标标签页和 debugger 的状态。

## 故障场景

### 1. Node.js Runtime 不可用
- 症状：`browser_code_run` 返回明确错误，提示需要 Node.js (>=18)。
- 处理：运行 `node scripts/check-node-env.mjs` 检查 Node 版本、ESM 支持与 WebSocket 可用性；必要时运行 `node scripts/setup-playwright-runtime.mjs` 做完整诊断与自动修复。

### 2. WebSocket 命令超时
- 症状：`Link2Chrome command timed out: <command>`。
- 处理：说明 Hub 未在 `ws://localhost:8766` 监听，或 Extension 未连接。重启 MCP Server，确认 Chrome 已启动且 Extension 已启用，再用 `browser_diagnose` 复查。

### 3. Chrome 未运行
- 症状：无法连接，标签页列表为空。
- 处理：运行 `node scripts/diagnostics/chrome-is-running.mjs` 确认 Chrome 进程是否存在。若未运行，请用户启动 Chrome。

### 4. Chrome 未安装 / 浏览器选择错误
- 症状：找不到可用浏览器。
- 处理：运行 `node scripts/diagnostics/installed-browsers.mjs` 列出系统默认浏览器与已安装浏览器，确认目标浏览器存在。

### 5. Extension 未安装或未启用
- 症状：Chrome 在运行但命令无响应。
- 处理：运行 `node scripts/diagnostics/check-extension-installed.mjs`。若未安装，引导用户在 `chrome://extensions/` 打开「开发者模式」并「加载已解压的扩展程序」，选择项目的 `extension/` 目录；若已安装但未启用，请用户启用它。

### 6. Native Host Manifest 缺失或无效（仅 native messaging 模式）
- 症状：使用 native messaging 通道时握手失败。
- 处理：运行 `node scripts/diagnostics/check-native-host-manifest.mjs` 校验 manifest；必要时运行 `node scripts/native-host/installManifest.mjs` 重新安装。WebSocket 主链路不依赖此项。

### 7. 已安装且已启用，但通信仍失败
- 处理：依次确认——MCP Server 进程存活、`browser_diagnose` 中 WebSocket 状态为已连接、目标标签页未被其它 debugger 占用（同一标签页不能同时被多个 debugger 附加）。仍失败时重启 MCP Server 与 Chrome Extension 后重试一次。

## 诊断命令速查

| 命令 | 用途 |
|---|---|
| `browser_diagnose`（MCP 工具） | 一次性体检：Hub / Extension / WebSocket / 标签页 / debugger 状态 |
| `node scripts/check-node-env.mjs` | 检查 Node 版本、ESM、WebSocket 可用性 |
| `node scripts/setup-playwright-runtime.mjs` | 完整诊断 + 常见问题自动修复 |
| `node scripts/diagnostics/chrome-is-running.mjs` | 检测 Chrome 是否运行 |
| `node scripts/diagnostics/installed-browsers.mjs` | 列出默认与已安装浏览器 |
| `node scripts/diagnostics/check-extension-installed.mjs` | 检查 Extension 是否安装并启用 |
| `node scripts/diagnostics/check-native-host-manifest.mjs` | 校验 native host manifest（native messaging 模式）|

## 给用户的表述

向用户汇报时使用自然语言描述「正在连接浏览器 / 正在重试浏览器连接」，不要暴露 Hub、CDP、WebSocket、debugger 等内部术语，除非用户明确要求这些细节。
