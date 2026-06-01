# Link2Chrome 方案 C 改造设计（通用浏览器网关）

> 版本：v1（设计稿）
> 日期：2026-06-01
> 目标：把 Link2Chrome 从「单浏览器 + 单 Agent（Claude Code）的 MCP 浏览器自动化」改造成
> **「一个真实浏览器（Tabbit/Chrome）+ 所有 Agent 共享」的通用浏览器网关**，对标 Codex Chrome Extension，
> 同时支持 **playwright / cua / dom-cdp** 三种控制模式，并以 **MCP + Skills** 的形式开放给所有 Agent。

---

## 一、背景与现状

### 1.1 现有能力（已实现，复用）

Link2Chrome 现有架构：

```
Claude Code ──MCP stdio──► MCP Server(Python, :8765) ──WebSocket──► Chrome Extension(MV3) ──chrome.debugger CDP──► Chrome Tab
```

已经实现了「方案 C」的**最难部分**：一个 MV3 扩展用 `chrome.debugger` 从内部把 CDP 挂到**用户正在使用、已登录**的浏览器标签页上，并通过本地 WebSocket 桥接到 Python 服务端。具体已有资产：

- **扩展（`extension/`）**：MV3，`chrome.debugger` 调 CDP，`background.js` 中 `handleCommand` 已支持约 40 个命令（screenshot / click / type / scroll / navigate / DOM 查询族 / action 族 / network capture-replay / console capture / script_evaluate / dialog / upload 等）。
- **MCP Server（`server/`）**：`main.py` 用 `@app.list_tools()` / `@app.call_tool()` 暴露工具，工具定义集中在 `tool_descriptions.py`（`TOOL_DEFINITIONS`）。
- **WebSocket 桥（`ws_manager.py`）**：自定义 JSON 协议 `{request_id, command, params}` ↔ `{request_id, success, data}`，**单一活跃连接**，含心跳、自动重连、端口占用保护。
- **视觉交互（`vision.py`）**：截图 + 兼容 OpenAI SDK 的视觉模型（豆包/Seed）→ 坐标 → CDP 派发，含 DPR 坐标校准。**这就是 cua 模式的雏形。**
- **DOM 压缩（`dom_compressor.py`）**：两层压缩，token 预算意识。
- **Skills 脚手架（已起步）**：`.claude/skills/link2chrome-browser-mcp/`、`.codex/skills/link2chrome-browser-mcp/`（含 `agents/openai.yaml`）、通用 `skills/`。

### 1.2 关键发现：相对 Codex 的传输差异

Codex Chrome Extension 用 **Native Messaging**（`chrome.runtime.connectNative` → `extension-host` 二进制 → WebSocket 到 Codex CLI），其中 native messaging 的一个隐性收益是**让 MV3 service worker 常驻**。

Link2Chrome 用 **扩展主动外连 `ws://localhost:8765`**，更简单、天然跨 Chromium、零额外二进制；代价是 **MV3 service worker 空闲会被回收**，可能杀掉 WebSocket。本方案用 **MV3 keepalive** 解决该问题，从而在不引入 native messaging 的前提下达到同等稳健性。

### 1.3 待补齐的差距（本方案范围）

1. **Playwright 不支持**：扩展走 `chrome.debugger`，只暴露 per-tab CDP 会话，不暴露 Target/Browser 域与浏览器级端点；而 Playwright `connectOverCDP` 需要完整 CDP 端点。
2. **三模式未形式化**：dom-cdp 与 cua 已混在一套工具里，缺少清晰的模式边界与 playwright 模式。
3. **仅 Claude Code**：MCP 仅配了 Claude Code，缺 Codex / Cursor 的注册与可用 Skills。
4. **仅 Chrome**：未对 Tabbit 做支持与打包；连接稳健性受 MV3 SW 回收影响。

---

## 二、设计决策（已与用户确认）

| 决策点 | 选择 | 理由 |
|---|---|---|
| Playwright 接入 | **双模式**（不走扩展，直连真实调试端口） | 最稳、工程量可控；扩展平面专注「活浏览器」控制 |
| 目标浏览器 | **Tabbit + Chrome/Chromium 通用** | 一套代码 + 少量 per-browser 适配 |
| 连接传输 | **WebSocket + MV3 keepalive** | 简单、跨浏览器、零额外二进制；keepalive 补齐常驻稳健性 |
| Skills 覆盖 | **Claude Code / Codex / Cursor(通用 MCP)** | browser-use 走 CDP 端点直连，不做 skill |
| 模式区分 | **工具命名空间**（`browser.dom.*` / `browser.cua.*` / `browser.pw.*`） | 对 Agent 语义清晰，便于按模式裁剪上下文 |

---

## 三、目标架构

### 3.1 双控制平面

```
        ┌─────────────────────────── Agents ────────────────────────────┐
        │  Claude Code / Codex / Cursor (MCP stdio)  │  browser-use /     │
        │                                            │  Playwright (CDP)  │
        └───────────────┬─────────────────────────────────────┬──────────┘
                        │ MCP                                   │ connectOverCDP
                        ▼                                       ▼
        ┌───────────────────────────────────────────────────────────────┐
        │  Link2Chrome Gateway (Python)                                   │
        │   ┌──────────────────────┐   ┌──────────────────────────────┐  │
        │   │ MCP Server(3 modes)  │   │ Playwright/CDP Launcher       │  │
        │   └──────────┬───────────┘   │ (dual-mode)                   │  │
        │              │ WebSocket(自定义协议)   └───────────┬──────────┘  │
        └──────────────┼────────────────────────────────────┼────────────┘
                       ▼                                      ▼
        ┌──────────────────────────┐        ┌────────────────────────────┐
        │ Extension 平面            │        │ CDP 平面                    │
        │ MV3 + chrome.debugger     │        │ Tabbit/Chrome 带           │
        │ 活的、已登录的浏览器       │        │ --remote-debugging-port    │
        │ → dom-cdp + cua 模式      │        │ → playwright 模式           │
        └──────────────────────────┘        └────────────────────────────┘
```

- **扩展平面**：控制用户**正在使用、已登录**的浏览器，无需带 flag 重启。承载 **dom-cdp** 与 **cua** 模式。
- **CDP 平面**：给 Playwright / browser-use 一个**完整 CDP 端点**。双模式：
  - *attach 模式*：连接一个已用 `--remote-debugging-port` 启动的 Tabbit/Chrome；
  - *launch 模式*：由网关用独立 user-data-dir 启动一个持久化 context（`launchPersistentContext`）。

> **边界说明**：扩展平面与 CDP 平面是**两个不同的浏览器进程/上下文**（前者是用户日常浏览器，后者是带调试端口的实例）。本方案不试图让二者指向同一进程（那需要 CDP 中继，已被用户否决）。「所有 Agent 共享」在 MCP 层（dom-cdp/cua）天然成立；Playwright/browser-use 共享的是 CDP 平面那个实例。

### 3.2 单元划分（隔离与边界）

| 单元 | 职责 | 接口 | 依赖 |
|---|---|---|---|
| `transport/ws_manager.py`（既有，增强） | 扩展 ↔ server 的 WebSocket 单连接 | `send_command(cmd, params)` | websockets |
| `extension/`（既有，增强） | 浏览器端 CDP 执行 + keepalive + 浏览器检测 | WS 自定义协议 | chrome.debugger |
| `modes/dom_cdp.py`（重构自既有工具） | dom-cdp 模式工具实现 | MCP 工具族 `browser.dom.*` | ws_manager |
| `modes/cua.py`（重构自 vision.py） | cua 模式：截图→模型→坐标→派发 | MCP 工具族 `browser.cua.*` | ws_manager, vision provider |
| `modes/playwright_plane.py`（新增） | CDP 平面：launch/attach + Playwright 会话 | MCP 工具族 `browser.pw.*` + 暴露 CDP endpoint | playwright |
| `vision/provider.py`（新增，抽象层） | 可插拔视觉/CUA 模型 | `analyze(screenshot, instruction) -> action` | 豆包/Seed、OpenAI/Anthropic computer-use（可选） |
| `browsers/registry.py`（新增） | 浏览器检测与可执行路径/用户目录解析 | `resolve(browser) -> BrowserSpec` | - |
| `session/mode.py`（新增） | 会话级默认模式与切换 | `get/set_mode()` | - |
| `skills/`（新增内容） | 各 Agent 的 Skill 包 + 通用 MCP 片段 | 文件产物 | - |
| `cli/setup`（增强 setup.sh） | 安装、注册 MCP、打包扩展、生成配置 | CLI | - |

---

## 四、三种控制模式详细设计

### 4.1 dom-cdp 模式（`browser.dom.*`）

- **机制**：压缩 DOM 提供结构 + 选择器/坐标 → CDP `Input.*` 派发。确定性、省 token。
- **来源**：基本是现有工具的重命名归类（get_state / dom_* / action_* / network_* / console_* / script_evaluate / navigate / tabs 等）。
- **改造**：统一命名空间前缀 `browser.dom.`；输出保持结构化 JSON、token 预算意识。

### 4.2 cua 模式（`browser.cua.*`）

- **机制**：截图 → 视觉/CUA 模型出动作（坐标/类型/文本）→ DPR 校准 → CDP 派发。
- **来源**：现有 `vision.py` + `tool_action_vision`。
- **改造**：
  - 抽出 `vision/provider.py` 抽象层，默认豆包/Seed，**可插拔** OpenAI computer-use / Anthropic computer use（输出统一为 `{action, x, y, text, key}`）。
  - 工具：`browser.cua.act(instruction)`、`browser.cua.locate(target)`（只定位不操作）、`browser.cua.verify(goal)`（视觉校验）。

### 4.3 playwright 模式（`browser.pw.*`）

- **机制**：网关在 CDP 平面 launch/attach 一个实例，建立 Playwright 连接；MCP 工具把常用 Playwright 能力暴露给 Agent；同时把 **CDP endpoint URL** 输出，供 browser-use / 外部 Playwright `connectOverCDP` 直连。
- **双模式**：
  - *attach*：`PLAYWRIGHT_CDP_URL` 或自动发现 `--remote-debugging-port`；
  - *launch*：`launchPersistentContext(userDataDir, channel/executablePath=Tabbit)`。
- **工具（MCP 侧最小集）**：`browser.pw.start(mode, browser)`、`browser.pw.goto(url)`、`browser.pw.click(selector)`、`browser.pw.fill(selector, text)`、`browser.pw.eval(expr)`、`browser.pw.screenshot()`、`browser.pw.endpoint()`（返回 CDP URL）、`browser.pw.stop()`。
- **browser-use 集成**：文档化「拿到 `browser.pw.endpoint()` 返回的 CDP URL → `BrowserSession(cdp_url=...)`」。

### 4.4 模式选择

- 会话级默认模式：`browser.set_mode(dom|cua|pw)`，默认 `dom`。
- 工具命名空间始终可用（即使非默认模式也能显式调某模式的工具）。
- Skill 文档给出选择决策树（见第六节）。

---

## 五、Tabbit + Chrome 通用 与 连接稳健性

### 5.1 浏览器通用

- 扩展：MV3 在 Tabbit（Chromium 套壳）与 Chrome 均可加载；`background.js` 中按需做浏览器检测（`navigator.userAgent` / runtime id）。
- `browsers/registry.py`：解析各浏览器的可执行路径与默认 user-data-dir（macOS 优先）：
  - Tabbit：`/Applications/Tabbit*.app/...`，app support：`~/Library/Application Support/Tabbit Browser`；
  - Chrome：标准路径。
- Playwright launch 用 `executablePath` 指向 Tabbit 二进制。

### 5.2 MV3 keepalive（替代 native messaging 常驻）

- `chrome.alarms` 周期唤醒（≤30s）维持 SW 活性；
- offscreen document 持有长连接（备选/加强）；
- 断线指数退避重连（既有逻辑保留并强化）；
- popup 显示连接/模式状态（既有 popup 增强）。

### 5.3 「对标 Codex」能力对照（验收用）

写入 `docs/COMPARISON_CODEX.md`，逐项核对：tabs、导航、DOM 读取、输入派发、截图、网络抓取/回放、console、dialog、文件上传、脚本执行、多模式、连接常驻。
- **Link2Chrome 优势**：开放、MCP 原生、多 Agent、三模式可选。
- **需补齐**：连接常驻稳健性（keepalive 解决）、Playwright 兼容（CDP 平面解决）。

---

## 六、多 Agent 暴露（MCP + Skills）

### 6.1 MCP

- 单一 MCP server（stdio），任意 MCP 客户端共用。
- 生成各 Agent 的注册配置：
  - Claude Code：`.claude/mcp.json`（既有，更新）；
  - Codex：Codex 的 MCP/插件配置片段；
  - Cursor / 通用：`docs/MCP_CONFIG_GUIDE.md` + 通用片段 `claude_config_snippet.json` 泛化。

### 6.2 Skills（对标 codex figma plugin 结构）

每个 Skill 包：`SKILL.md`（触发条件、模式选择决策树、连接/排错、工具速查）+（Codex 额外）`agents/openai.yaml`、`commands/`。

- `.claude/skills/link2chrome-browser/`
- `.codex/skills/link2chrome-browser/`（+ `agents/openai.yaml` + commands：如 `/browser-dom`、`/browser-cua`、`/browser-pw`）
- 通用 `skills/link2chrome-browser/`（模型无关）

**模式选择决策树（写入 SKILL.md）**：

```
任务是健壮自动化/测试/需要 Playwright API/由 browser-use 驱动？
  → pw 模式（CDP 平面）
否则要控制「我正在用的、已登录的浏览器」？
  → 有稳定选择器/结构化交互/省 token？  → dom-cdp
  → 无稳定选择器/纯视觉/canvas 类页面？  → cua
```

### 6.3 browser-use

不做 Skill。文档化：`browser.pw.start` → `browser.pw.endpoint()` 取 CDP URL → `BrowserSession(cdp_url=...)`。

---

## 七、分阶段实施

- **P0 — 跨浏览器 + 连接稳健**：Tabbit 支持（加载/检测/路径解析）+ MV3 keepalive + 重连强化。验收：Tabbit 与 Chrome 下扩展长时间稳定连接。
- **P1 — 模式形式化**：工具拆分为 `browser.dom.*` / `browser.cua.*` 命名空间 + `set_mode` 会话状态 + cua provider 抽象。验收：两模式工具清晰、互不耦合，回归既有用例。
- **P2 — Playwright 双模式**：`modes/playwright_plane.py` + `browsers/registry.py`，`browser.pw.*` 工具 + `endpoint()`。验收：Playwright 与 browser-use 能经 endpoint 控制 Tabbit。
- **P3 — 多 Agent Skills**：Claude/Codex/Cursor 的 Skill 包 + MCP 配置 + setup CLI 一键安装。验收：三类 Agent 都能按 Skill 正确选模式并调用。
- **P4 — 对标 Codex 审计 + 文档 + 测试**：`COMPARISON_CODEX.md`、端到端测试（每模式至少 1 条 happy path + 连接掉线恢复）。

---

## 八、错误处理与可靠性

- **扩展未连接**：MCP 工具自动等待（既有 10s），超时返回明确指引（加载扩展/启用/检查端口）。
- **debugger 冲突**：既有 `debugger_manager` 的 detach+延迟策略保留；Playwright 平面与扩展平面用不同实例，避免单 tab 双 debugger 冲突。
- **端口占用**：既有保护保留（不强杀），并对 Playwright CDP 端口做同样保护。
- **模式不可用**：pw 模式未安装 Playwright / 找不到浏览器二进制时，返回安装指引并建议降级到 dom-cdp。
- **视觉模型超时**：既有 fallback 保留，cua 失败可提示切 dom-cdp。

## 九、测试策略

- 单元：`browsers/registry.py` 路径解析、`vision/provider.py` 动作解析、模式路由。
- 集成（`test/`，遵循项目「测试文件放 test/」约定）：每模式一条端到端、连接掉线重连、Tabbit 与 Chrome 各跑一遍冒烟。
- 对照核对：`COMPARISON_CODEX.md` 勾选表作为人工验收清单。

## 十、非目标（YAGNI）

- 不做扩展平面 ↔ CDP 平面的 CDP 中继合一（用户已否决）。
- 不做 Firefox（非 Chromium）支持。
- 不把 browser-use 包装成 Skill。
- 不引入 native messaging（keepalive 已够）。

## 十一、开放项 / 风险

- Tabbit 是否允许 `--remote-debugging-port`（部分隐私向 fork 会禁）——P2 第一步需实测；若禁用，pw 模式仅支持 launch 模式（独立 user-data-dir）。
- MV3 keepalive 在 Tabbit 上的实际表现需实测（alarms 最小间隔、offscreen 支持）。
- cua 可插拔模型的动作 schema 需在 P1 固化，避免各 provider 漂移。
