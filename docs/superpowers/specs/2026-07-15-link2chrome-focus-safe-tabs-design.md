# Link2Chrome Focus-Safe Tabs 设计

日期：2026-07-15

## 目标

彻底分离“自动化正在操作的标签页”和“用户正在查看的标签页”。Link2Chrome 的自动化命令可以在后台标签中创建页面、切换目标、执行 CDP/Playwright 操作和跟踪点击产生的新页面，但不得因此激活标签页或把 Chrome 窗口拉到操作系统前台。

## 核心不变量

对所有自动化路径，必须同时满足以下不变量：

1. 自动化命令不调用 `chrome.tabs.update(tabId, { active: true })`。
2. 自动化命令不调用 `chrome.windows.update(windowId, { focused: true })`。
3. 自动化创建的标签固定使用 `active: false`。
4. 自动化目标由内部 `targetTabId` 或命令携带的 `tabId` 决定，不由浏览器 UI 的 active 状态决定。
5. CDP 命令实际连接的标签必须与解析后的目标标签一致；不能因为已有 debugger attachment 仍有效就复用错误标签。
6. 兼容字段 `active` 和 `focusWindow` 可以继续被调用方传入，但运行时不得据此改变用户界面。

`active: false` 只约束扩展主动创建的标签。网页自身脚本或 Chrome 策略造成的 UI 变化不属于扩展可完全控制的范围；但扩展检测到这类变化后不得再补一次主动激活或窗口聚焦。

## 范围

- session 种子标签创建和普通新标签创建。
- MCP `browser_tab`、`browser_session` 和点击动作的焦点语义。
- Node runtime `browser.tabs.new()`、标签切换和启动绑定。
- 扩展内部 `tab_manage`、agent-first tab 命令和点击后标签变化检测。
- debugger/CDP 对目标 `tabId` 的绑定正确性。
- 工具描述、技能文档和相关测试。

## 非目标

- 本次不新增人工接管、登录、验证码或视觉检查专用的 handoff API。
- 不尝试阻止网页自身调用 `window.open()` 时 Chrome 决定激活新标签。
- 不重构 Browser Hub 的租约或 session 生命周期。
- 不改变标签组的关闭、保留和 deliverable 语义。
- 不改变用户主动在 Chrome 中切换标签页的行为。

## 架构

### 1. 统一后台建页

扩展增加 `createBackgroundTab(options)`，成为自动化创建标签页的唯一入口。该函数：

- 始终覆盖调用方的 `active` 值并传递 `active: false`。
- 接受 `url`、`windowId`、`index` 和 `openerTabId` 等非焦点属性。
- 在可以确定当前自动化目标位置时，优先把新标签放到目标标签旁边。
- 返回 Chrome 的 `Tab` 对象，但不改变用户当前活动标签和窗口焦点。

以下路径统一改用该函数：

- session 的 `tab_group_create` 种子标签。
- `cmdAgentBrowserTabNew()`。
- `cmdTabManage(action="new")`。
- `navigateWithTabs()` 无目标标签时的兜底建页。

### 2. 目标选择不再等于 UI 切换

`cmdAgentBrowserTabSwitch()` 和旧的 `cmdTabManage(action="switch")` 只执行以下内部状态变化：

- 验证目标标签存在并且属于 session scope。
- 更新 `targetTabId`。
- 在目标发生变化时使旧的 `attachedTabId` 失效或让 debugger 层重新绑定。
- 返回新的自动化目标信息。

它们不得调用 tabs/windows 的激活或聚焦 API。对外保留 `switch` 名称以兼容现有客户端，但工具描述改成“选择自动化目标”，不再描述为用户界面切换。

### 3. 点击产生的新标签只更新工作指针

`detectActionTabChange()` 继续识别点击前后新增的标签页，并把新增标签记录为 `targetTabId`。检测逻辑不得激活该标签，也不得聚焦其窗口。

如果网页或 Chrome 已经自行激活了新标签，扩展只观测并记录，不额外执行焦点操作。返回值继续包含 `openedTabId`，供上层 session 和后续命令使用。

### 4. CDP 严格绑定目标标签

debugger 层改为显式验证目标：

- `ensureDebuggerAttached(expectedTabId)` 接收解析后的目标标签。
- 只有 `attachedTabId === expectedTabId` 且标签仍可调试时才允许复用 attachment。
- attachment 指向其他标签时，先 detach，再 attach 到 `expectedTabId`。
- `sendCDP()` 使用命令解析出的 `tabId`；旧命令未显式携带时才回退到内部 `targetTabId`。
- 直接调用 `chrome.debugger.sendCommand()` 的 Playwright helper 同样使用其显式 `tabId`。

这样后台标签不需要成为 active tab，就能执行 DOM、输入、截图、脚本和 Playwright 操作，同时避免多标签操作打到旧页面。

### 5. API 兼容字段降级

以下字段继续保留在输入 schema 和客户端方法签名中，避免旧调用因参数校验失败：

- `active`
- `focusWindow`

工具描述必须明确它们是 deprecated compatibility no-op。server 和 runtime 不再向扩展转发这些字段；扩展即使收到旧客户端直接发送的字段也必须忽略。

### 6. runtime 使用内部目标绑定

Node runtime 启动或绑定 session 时：

- 通过 session scope 和 `browser.tabs.selected()` 获取扩展当前内部目标。
- 不再搜索 `raw.active === true` 的标签。
- 如果内部目标不可用，才回退到 session 列表中的第一个允许标签；该回退不激活标签。
- 同一 session 中已绑定且仍在 scope 内的 `globalThis.tab` 继续保留。

## 数据流

1. 上层创建 session。
2. 扩展在后台创建种子标签并分组，用户当前标签保持不变。
3. 上层新建或选择工作标签时，扩展只更新 `targetTabId`。
4. session scope guard 解析命令目标 `tabId`。
5. debugger 层核对 `attachedTabId` 与目标；不一致则重新绑定，但不激活标签。
6. CDP/Playwright 在后台目标执行操作。
7. 点击产生新标签时，检测器只记录新标签为后续目标。
8. runtime 从内部目标恢复 `globalThis.tab`，不读取 UI active 状态。

## 错误处理

- 目标标签不存在、超出 session scope 或 URL 不可调试时，命令明确失败，不回退到用户当前活动标签。
- debugger 重绑失败时返回目标 `tabId` 和原始错误，不能静默改用其他可调试标签。
- 兼容字段被忽略不应产生错误；返回结果不承诺标签已激活或窗口已聚焦。
- 后台标签被用户关闭时清理 `targetTabId` 和 `attachedTabId`，后续命令要求上层重新选择或创建目标。

## 测试策略

所有新增测试文件继续放在项目 `test/` 目录，并按 TDD 先失败后实现。

### 静态策略测试

- 所有自动化建页入口都调用 `createBackgroundTab()`。
- `createBackgroundTab()` 固定 `active: false`。
- tab switch 和新标签检测函数中不存在 `{ active: true }` 或 `{ focused: true }`。
- server/runtime 不再透传 `active`、`focusWindow`。
- runtime 启动绑定不再读取 `raw.active`。

### debugger 路由测试

- 已 attach 到 A、目标切换到 B 时必须 detach A 并 attach B。
- 已 attach 到 B 且 B 仍可调试时允许复用。
- B 不存在或不可调试时不得回退到用户 active tab。
- 对两个后台 Tab 对象连续执行脚本时，CDP 调用分别命中各自的 `tabId`。

### 行为与回归测试

- 创建 session 不激活空白种子标签。
- `browser.tabs.new({ active: true, focusWindow: true })` 仍创建后台标签，证明兼容字段为 no-op。
- 选择另一个自动化目标不改变 Chrome active tab。
- 点击打开新标签后能继续在新目标执行脚本，但扩展没有激活或聚焦调用。
- 现有 session scope、tab group、关闭/finalize、截图、DOM 和 runtime page facade 测试继续通过。

### 真实 Chrome 验证

在已安装开发版扩展的真实 Chrome 中，对每个场景记录操作前后的：

- `activeTabId`
- `lastFocusedWindowId`
- 自动化 `targetTabId`

覆盖 session create、new tab、switch、点击打开新页和跨两个后台标签执行脚本。验收要求前两个用户可见状态保持不变，`targetTabId` 按预期变化，脚本结果来自正确页面。

## 验收标准

- 自动化代码中不存在主动激活标签或聚焦窗口的可达路径。
- 所有扩展主动创建的自动化标签均为后台标签。
- `active`、`focusWindow` 无论取值为何都不会改变浏览器 UI。
- 自动化切换目标和点击产生新页后，后续操作命中正确标签。
- runtime 启动绑定完全独立于 `raw.active`。
- 静态、单元、集成和真实 Chrome 焦点验证全部通过。
