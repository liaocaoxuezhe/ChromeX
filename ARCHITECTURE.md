# Link2Chrome 项目架构与方案

## 项目概述

Link2Chrome 是一个**本地优先的浏览器自动化系统**，它创建了一个桥梁，让 Claude Code 能够控制用户当前正在使用的 Chrome 浏览器，而无需启动新的浏览器实例。

核心特点：
- **本地优先**: 所有组件运行在本机，无需云服务
- **轻量连接**: 使用 WebSocket 实现低延迟通信
- **AI 驱动**: 集成视觉模型（豆包/Seed）实现智能页面交互
- **MCP 协议**: 基于 Model Context Protocol 标准化工具接口

---

## 系统架构

### 整体数据流

```
┌─────────────────┐     MCP StdIO      ┌──────────────────┐     WebSocket     ┌──────────────────┐     CDP Protocol     ┌──────────────┐
│                 │  (Claude Code ↔)   │                  │  (Server ↔)      │                  │  (Extension ↔)     │              │
│   Claude Code   │ ◄────────────────► │   MCP Server     │ ◄────────────────► │ Chrome Extension │ ◄────────────────► │  Chrome Tab  │
│   (AI Agent)    │   JSON-RPC 2.0     │   (Python)       │   ws://localhost:│   (Manifest V3)  │   chrome.debugger  │   (User's    │
│                 │                    │   Port: 8765     │   8765           │                  │   API              │   Browser)   │
└─────────────────┘                    └──────────────────┘                  └──────────────────┘                    └──────────────┘
                                              │                                        │
                                              ▼                                        ▼
                                        ┌──────────────┐                       ┌──────────────┐
                                        │ Vision Model │                       │ Readability  │
                                        │ (豆包/Seed)  │                       │   Library    │
                                        └──────────────┘                       └──────────────┘
```

### 三大核心组件

#### 1. MCP Server (`/server/`)

**职责**: 作为 Claude Code 与 Chrome 扩展之间的中间层

**核心模块**:

| 文件 | 职责 | 关键技术 |
|------|------|----------|
| `main.py` | MCP 服务入口，定义 20+ 个 browser_* 工具 | `mcp.server`, `stdio_server` |
| `ws_manager.py` | WebSocket 服务端，管理 Extension 连接 | `websockets>=12.0` |
| `vision.py` | 视觉模型客户端（豆包/Seed）| `openai` 兼容 API |
| `dom_compressor.py` | DOM 压缩算法，减少 Token 消耗 | 自定义剪枝算法 |
| `tool_descriptions.py` | 集中管理所有工具定义和描述 | JSON Schema |
| `debugger_manager.py` | Debugger 生命周期管理 | 异步锁、延迟策略 |
| `logger.py` | 多级别日志系统 | 旋转日志、操作追踪 |

**MCP Tools 列表 (20+ 个)**:

```
页面状态获取:
  - browser_get_state           # 获取 URL、标题、压缩 DOM
  - browser_get_screenshot      # 获取页面截图
  - browser_get_tabs            # 获取所有标签页
  - browser_diagnose            # 诊断连接状态

导航与标签管理:
  - browser_action_navigate     # 导航到 URL
  - browser_go_back             # 后退/前进
  - browser_manage_tab          # 新建/关闭/切换标签页

直接交互操作:
  - browser_click               # 点击元素（支持 selector/坐标）
  - browser_type                # 输入文本
  - browser_type_at_coord       # 在指定坐标输入
  - browser_drag                # 拖拽操作
  - browser_send_keys           # 发送快捷键
  - browser_find_text           # 查找页面文本

滚动操作:
  - browser_action_scroll       # 滚动指定像素
  - browser_scroll_until        # 智能滚动直到满足条件

等待与条件:
  - browser_wait                # 等待时间/元素/文本
  - browser_wait_for_condition  # 高级等待（可见性/网络空闲/自定义）

内容提取:
  - browser_extract_content     # Readability 提取正文
  - browser_execute_script      # 执行任意 JS
  - browser_scrape_with_scroll  # 批量滚动爬取

调试维护:
  - browser_detach_debugger     # 解除 debugger 附加
```

---

#### 2. Chrome Extension (`/extension/`)

**职责**: 作为浏览器端代理，执行来自 MCP Server 的命令

**核心文件**:

| 文件 | 职责 | 关键技术 |
|------|------|----------|
| `manifest.json` | 扩展配置，声明权限 | Manifest V3 |
| `background.js` | Service Worker，WebSocket 客户端 + CDP 操作 | `chrome.debugger` API |
| `content.js` | 内容脚本，高亮显示操作位置 | DOM 操作 |
| `popup.js` | 弹出 UI，显示连接状态 | Chrome Messaging |
| `lib/Readability.js` | Mozilla Readability 算法 | 正文提取 |

**关键权限**:
```json
{
  "permissions": [
    "debugger",        // 核心：使用 Chrome DevTools Protocol
    "activeTab",       // 访问当前标签页
    "scripting",       // 注入脚本
    "tabs"             // 管理标签页
  ]
}
```

---

#### 3. 通信协议

**MCP ↔ Server** (StdIO):
- 格式: JSON-RPC 2.0
- 编码: UTF-8
- 示例:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "browser_click",
    "arguments": {"selector": "#submit"}
  }
}
```

**Server ↔ Extension** (WebSocket):
- 地址: `ws://localhost:8765`
- 心跳: 30 秒间隔 ping/pong
- 消息格式:
```json
// Request
{
  "request_id": "abc123",
  "command": "click",
  "params": {"x": 100, "y": 200}
}

// Response
{
  "request_id": "abc123",
  "success": true,
  "data": {"x": 100, "y": 200}
}
```

**Extension ↔ Chrome Tab** (CDP):
- 通过 `chrome.debugger` API 发送 Chrome DevTools Protocol 命令
- 关键命令: `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`, `Page.captureScreenshot`

---

## 核心技术细节

### 1. AI 视觉交互流程 (Vision Action)

这是系统的核心创新点：AI 通过"看图操作"控制浏览器。

```
┌─────────────┐     1. 获取截图      ┌─────────────┐
│  MCP Server │ ◄────────────────── │   Browser   │
│             │                     │             │
│             │     2. 发送给 AI     │             │
│             │ ─────────────────►  │ Vision Model│
│             │                     │ (豆包/Seed) │
│             │     3. 返回坐标      │             │
│             │ ◄────────────────── │             │
│             │                     └─────────────┘
│             │     4. 坐标校准
│             │        (考虑 DPR)
│             │
│             │     5. 执行操作
│             │ ─────────────────►  │   Browser   │
└─────────────┘                     └─────────────┘
```

**坐标校准**:
- 截图尺寸 = CSS 像素 × devicePixelRatio (DPR)
- 视觉模型返回的是截图像素坐标
- 需要除以 DPR 转换为 CSS 像素，再发送给 CDP

```python
# 校准示例
screenshot_w = int(client_w * dpr)  # 实际截图宽度
action = await vision.analyze(screenshot_b64, instruction, screenshot_w, screenshot_h)
css_x = action.x / dpr  # 转换为 CSS 像素
```

---

### 2. DOM 压缩算法

为了减少 Token 消耗，系统实现了两层压缩：

**第一层 (Extension 端)**: 提取可交互元素
```javascript
// 只保留这些标签
const INTERACTIVE_TAGS = ['a', 'button', 'input', 'textarea', 'select', 'form'];
// 提取属性: id, class, href, src, alt, placeholder, etc.
```

**第二层 (Server 端)**: `dom_compressor.py`
- 深度裁剪 (默认最大 10 层)
- 合并连续文本节点
- 截断超长文本 (150 字符)
- 限制总输出 (50K 字符)

---

### 3. Debugger 生命周期管理

**问题**: Chrome 只允许一个 debugger 附加到标签页。如果 DevTools 已打开，或前一个会话未清理，会导致 "Another debugger is already attached" 错误。

**解决方案** (`debugger_manager.py`):
```python
class DebuggerManager:
    async def ensure_clean_attach(self, target_tab_id):
        # 1. 如果已 attach 到其他 tab，先 detach
        if self.attached_tab_id and self.attached_tab_id != target_tab_id:
            await self._detach_with_delay(self.attached_tab_id)
            await asyncio.sleep(0.3)  # 关键：等待浏览器清理

        # 2. 再 attach 到新 tab
        self.attached_tab_id = target_tab_id
```

---

### 4. 连接可靠性设计

**心跳机制**:
- Extension → Server: 每 30 秒发送 `ping`
- Server → Extension: 回复 `pong`
- 超时 60 秒未收到心跳则断开

**自动重连**:
- Extension 端指数退避重连 (最多 10 次)
- 重连间隔: 1s, 2s, 4s, 8s, ... 最大 30s

**连接等待**:
- MCP Tool 调用时如果 Extension 未连接，自动等待最多 10 秒

---

## 数据流示例：点击操作

```
用户指令: "点击搜索按钮"

Claude Code
    │
    ▼
调用 browser_click(selector="搜索")
    │
    ▼
MCP Server (main.py)
    │
    ▼
发送 command="click", params={"selector": "搜索"}
    │
    ▼
WebSocket Server (ws_manager.py)
    │
    ▼
WebSocket Message → Chrome Extension (background.js)
    │
    ▼
解析命令 → 在页面中查找包含"搜索"的元素
    │
    ▼
chrome.debugger.sendCommand({
    method: "Input.dispatchMouseEvent",
    params: {
        type: "mousePressed",
        x: elementX,
        y: elementY,
        button: "left",
        clickCount: 1
    }
})
    │
    ▼
Chrome 执行点击
    │
    ▼
返回执行结果 (坐标信息)
    │
    ▼
逐层返回给 Claude Code
```

---

## 项目结构

```
Link2Chrome/
├── server/                      # Python MCP 服务器
│   ├── __init__.py
│   ├── main.py                  # MCP Server 主入口，工具实现
│   ├── ws_manager.py            # WebSocket 服务端管理
│   ├── vision.py                # 视觉模型客户端
│   ├── dom_compressor.py        # DOM 压缩算法
│   ├── tool_descriptions.py     # 工具定义配置
│   ├── debugger_manager.py      # Debugger 生命周期管理
│   ├── retry_manager.py         # 重试和降级策略
│   ├── script_library.py        # JS 脚本库
│   ├── logger.py                # 日志系统
│   ├── view_logs.py             # 日志查看工具
│   ├── __main__.py              # 模块入口
│   ├── requirements.txt         # Python 依赖
│   └── venv/                    # 虚拟环境
│
├── extension/                   # Chrome 扩展 (Manifest V3)
│   ├── manifest.json            # 扩展配置
│   ├── background.js            # Service Worker (核心)
│   ├── content.js               # 内容脚本
│   ├── popup.html               # 弹出界面
│   ├── popup.js                 # 弹出逻辑
│   └── lib/
│       └── Readability.js       # Mozilla Readability 库
│
├── logs/                        # 日志目录
│   ├── link2chrome_YYYY-MM-DD.log
│   ├── link2chrome_error_YYYY-MM-DD.log
│   └── operations/
│       └── operations_YYYY-MM-DD.log
│
├── test/                        # 测试文件
│   ├── test_mcp_connection.py
│   ├── test_phase1_features.py
│   ├── test_phase2_features.py
│   └── scripts/
│
├── docs/                        # 文档
├── setup.sh                     # 安装脚本
├── .env                         # 环境变量配置
├── claude_config_snippet.json   # Claude Code 配置模板
├── README.md                    # 项目说明
├── CLAUDE.md                    # Claude Code 上下文指南
└── ARCHITECTURE.md              # 本文件
```

---

## 关键技术栈

### 后端 (Python)
- **mcp**: Model Context Protocol 实现
- **websockets**: WebSocket 服务端
- **openai**: OpenAI 兼容 API 客户端（用于调用豆包）
- **markdownify**: HTML 转 Markdown
- **Pillow**: 图像处理

### 前端 (Chrome Extension)
- **Manifest V3**: Chrome 扩展格式
- **Chrome DevTools Protocol**: 浏览器控制协议
- **chrome.debugger API**: CDP 的 Chrome 封装
- **Readability.js**: 正文提取算法

### 通信协议
- **MCP (Model Context Protocol)**: AI 工具标准协议
- **WebSocket**: 实时双向通信
- **CDP (Chrome DevTools Protocol)**: 浏览器控制协议

---

## 配置与启动

### 1. 环境变量 (.env)
```bash
DOUBAO_API_KEY=your-api-key
DOUBAO_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
DOUBAO_MODEL=doubao-seed-1.8-thinking-250528
LOG_LEVEL=INFO
```

### 2. Claude Code 配置 (~/.claude.json)
```json
{
  "mcpServers": {
    "local-browser": {
      "command": "/Users/zhangyu/PycharmProjects/Link2Chrome/server/venv/bin/python",
      "args": ["-m", "server.main"],
      "cwd": "/Users/zhangyu/PycharmProjects/Link2Chrome"
    }
  }
}
```

### 3. 启动流程
```bash
# 1. 安装依赖
./setup.sh

# 2. 加载 Chrome 扩展
# 打开 chrome://extensions/ → 启用开发者模式 → 加载已解压的扩展 → 选择 extension/ 目录

# 3. 启动 MCP Server (由 Claude Code 自动调用)
cd server && python -m server.main
```

---

## 扩展性设计

### 添加新工具
1. 在 `tool_descriptions.py` 中定义工具描述和参数 Schema
2. 在 `main.py` 中添加工具处理逻辑
3. 如需新的浏览器操作，在 `background.js` 中实现对应的 CDP 命令

### 更换视觉模型
修改 `vision.py` 中的 API 配置即可支持其他兼容 OpenAI 接口的视觉模型（如 GPT-4V）。

### 多浏览器支持
当前仅支持 Chrome。要支持 Firefox 或 Edge，需要：
1. 创建对应的浏览器扩展
2. 实现相同的 WebSocket 消息协议
3. 使用对应浏览器的远程调试协议

---

## 总结

Link2Chrome 通过三层架构实现了 AI 对浏览器的精细控制：

1. **MCP 层**: 标准化 AI 工具接口，让 Claude Code 可以像调用函数一样控制浏览器
2. **WebSocket 层**: 实时双向通信，连接 AI 服务端与浏览器扩展
3. **CDP 层**: 直接操作浏览器内核，实现点击、输入、截图等底层能力

这种设计使得 AI Agent 能够：
- **看见** 页面（截图 + 视觉模型）
- **理解** 结构（DOM 压缩提取）
- **操作** 元素（精确的坐标交互）
- **提取** 内容（正文提取 + 自定义脚本）

同时保持本地优先、低延迟、高可靠的特点。
