这份文档是为你准备的**技术需求规格说明书 (PRD) 与 架构设计文档**。你可以直接将这份文档发给你的程序员或外包团队。

这份设计旨在构建一个 **Local-First (本地优先)** 的自动化架构，核心在于“**不启动新浏览器，而是通过插件接管当前浏览器**”，并利用 **Claude Code** 作为大脑，**MCP (Model Context Protocol)** 作为神经，**Chrome Extension (CDP)** 作为手眼。

---

# 项目名称：Local-Browser-MCP (基于 Claude Code 的浏览器中继系统)

## 1. 系统架构概览 (System Architecture)

### 核心设计理念

通过 **MCP Server** 作为中转站，将 **Claude Code (CLI)** 的指令转化为 **WebSocket** 消息，发送给安装在 Chrome 中的 **扩展程序**。扩展程序利用 `chrome.debugger` API (即 Chrome DevTools Protocol, CDP) 实现像素级的操作（点击、输入、截图）。

### 架构图 (Mermaid)

```mermaid
graph TD
    subgraph "Terminal Environment (User Space)"
        A[Claude Code CLI] -- "MCP Protocol (StdIO)" --> B[MCP Relay Server]
        B -- "Vision API Request" --> E[Vision Model Service]
        E -- "Coordinates (x,y)" --> B
    end

    subgraph "Chrome Browser (Local App)"
        B -- "WebSocket (ws://localhost:port)" --> C[Chrome Extension (Background Service)]
        C -- "chrome.debugger / CDP" --> D[Active Browser Tab]
        D -- "Events / Screenshots" --> C
    end
    
    subgraph "Model Layer"
        E[Seed-1.8 / VLM Agent] 
    end

    %% Flow descriptions
    A -.->|1. "Check Google"| B
    B -.->|2. {action: navigate}| C
    C -.->|3. Execute| D
    D -.->|4. Page Load| C
    C -.->|5. Screenshot| B
    B -.->|6. {screenshot}| E
    E -.->|7. {x, y}| B
    B -.->|8. {action: click, x, y}| C

```

---

## 2. 模块详细需求 (Module Requirements)

### 模块 A: MCP Relay Server (Python/Node.js)

**职责**：作为 Claude Code 和 浏览器插件之间的“桥梁”。
**运行方式**：本地后台服务 (Localhost Server)。

#### 功能列表：

1. **MCP 接口实现**：实现 MCP Protocol，暴露 Tools 给 Claude Code。
2. **WebSocket Server**：启动一个 WS 服务（如 `ws://localhost:8888`），等待 Chrome 插件连接。
3. **连接管理**：确保只有一个活跃的 Chrome 连接，处理断连重连。
4. **视觉处理 (Vision Logic)**：
* 接收插件发来的 `Base64` 截图。
* 调用 **Seed-1.8** (或其他 VLM) API。
* 将自然语言指令（如“点击搜索框”）转换为坐标 `(x, y)`。



#### 核心数据结构 (State):

```json
{
  "connection_status": "connected",
  "current_page_info": {
    "url": "https://...",
    "title": "...",
    "screenshot_cache": "base64..."
  }
}

```

---

### 模块 B: Chrome Extension (The Hand)

**职责**：执行具体操作。
**关键权限**：`debugger` (核心), `activeTab`, `scripting`, `tabs`。

#### 1. Background Service Worker (`background.js`)

* **WebSocket Client**：插件启动时自动连接 `ws://localhost:8888`。
* **指令分发器**：接收 Server 的 JSON 指令，分发给 CDP 执行。

#### 2. CDP 操作层 (核心能力)

程序员需使用 `chrome.debugger` API 实现以下原子操作：

| 动作 (Action) | 实现方式 (Technical Path) | 备注 |
| --- | --- | --- |
| **鼠标点击 (Click)** | `Input.dispatchMouseEvent` (type: mousePressed/mouseReleased) | **必须支持 (x, y) 坐标点击**，而非仅 DOM 点击。 |
| **键盘输入 (Type)** | `Input.dispatchKeyEvent` | 模拟真实键盘敲击，支持特殊键 (Enter, Tab)。 |
| **截图 (Screenshot)** | `Page.captureScreenshot` (format: jpeg, quality: 80) | 压缩传输，保证速度。 |
| **滚动 (Scroll)** | `Input.dispatchMouseEvent` (wheel) | 模拟滚轮。 |
| **高亮 (Highlight)** | `Runtime.evaluate` (Inject JS) | 在页面上绘制红框，用于调试 Agent 看着哪。 |
| **获取 DOM** | `Runtime.evaluate` (HTML serializer) | 将 DOM 压缩为简化的 Markdown 或 HTML 树。 |

---

## 3. MCP Tools 定义 (暴露给 Claude Code 的接口)

这是 Claude Code 能够看到的“工具箱”。你需要让程序员严格实现这些 Schema。

#### Tool 1: `browser_get_state`

* **描述**：获取当前浏览器的状态（URL、标题、截图、简化 DOM）。
* **用途**：Claude 用它来“看”现在的页面。
* **返回**：
```json
{
  "url": "string",
  "title": "string",
  "screenshot": "image/jpeg (base64)", // Claude Code 支持直接查看图片
  "dom_tree": "string (simplified)"
}

```



#### Tool 2: `browser_action_vision` (核心 AI 动作)

* **描述**：基于视觉的智能操作。
* **参数**：
* `instruction` (string): "点击那个蓝色的登录按钮" 或 "在搜索框输入 Hello"。


* **内部逻辑**：
1. Server 获取当前截图。
2. Server 调用 Seed-1.8 获取目标坐标 `(x, y)`。
3. Server 通过 WS 发送 `Input.dispatchMouseEvent` 到插件。



#### Tool 3: `browser_action_navigate`

* **参数**：`url` (string)
* **逻辑**：控制当前 Tab 跳转。

#### Tool 4: `browser_action_scroll`

* **参数**：`direction` ("up" | "down"), `amount` (pixels)

#### Tool 5: `browser_manage_tab`

* **参数**：`action` ("new" | "close" | "switch"), `tab_index` (optional)

---

## 4. 关键交互流程 (Sequence)

当你在 Claude Code 输入：**“帮我把这个页面上的所有 PDF 下载下来”**

1. **Claude Code** 调用 `browser_get_state`。
2. **MCP Server** -> WS -> **Plugin** -> 截图 & DOM -> 返回给 Claude。
3. **Claude Code** 分析 DOM，发现有 PDF 链接，决定点击。
4. **Claude Code** 调用 `browser_action_vision` (参数: "点击第一个 PDF 下载链接")。
5. **MCP Server** 截取最新屏幕，发给 **Seed-1.8**。
6. **Seed-1.8** 返回坐标 `(500, 300)`。
7. **MCP Server** -> WS -> **Plugin** 执行 `chrome.debugger` 点击 `(500, 300)`。
8. **Plugin** 返回 "Clicked success"。
9. 任务完成。

---

## 5. 技术难点与验收标准 (Acceptance Criteria)

给程序员的特别提示（避坑指南）：

### 1. 坐标系对齐 (Coordinate Calibration)

* **问题**：网页 CSS 像素与屏幕物理像素 (Retina Display) 不一致。模型看到的截图分辨率可能与 `window.innerWidth` 不匹配。
* **要求**：插件必须在发送截图时，同时发送 `window.devicePixelRatio` 和 `window.innerWidth/Height`。Server 端必须进行坐标换算。
* `Click_X = Model_X * (Client_Width / Screenshot_Width)`



### 2. 调试模式横条 (Infobar)

* **问题**：使用 `chrome.debugger` 时，Chrome 顶部会出现 "Browser is being controlled by..." 的提示条，会挤压页面高度，导致坐标偏移。
* **要求**：计算坐标时需考虑 viewport 的 `offest`，或者接受这个提示条的存在并适配。

### 3. 连接保活

* **要求**：WebSocket 需要有心跳机制 (Ping/Pong)。如果浏览器关闭或插件崩溃，MCP Server 应该通知 Claude Code "Browser disconnected"，而不是挂起。

### 4. DOM 压缩算法

* **要求**：不要直接把 `document.body.innerHTML` 扔给 Claude，Token 会爆炸。
* **方案**：实现一个轻量级算法，只提取 `a, button, input, text` 等交互元素，并去除 `<style>, <script>, <svg>`。

---

## 6. 交付物清单

1. **`/server`**: Python/Node.js 项目，包含 MCP Server 实现和 Vision Model 接口封装。
2. **`/extension`**: Chrome 扩展源码 (Manifest V3)，包含 `background.js` 和 `content.js`。
3. **`claude_config_snippet.json`**: 方便你直接复制到 Claude 配置中的代码段。
4. **`setup.sh`**: 一键启动脚本。