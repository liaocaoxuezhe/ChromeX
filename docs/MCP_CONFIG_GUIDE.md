# Link2Chrome MCP 配置指南

## 🎯 配置概览

Link2Chrome 通过 MCP (Model Context Protocol) 与 Claude Code 通信。配置需要指定 Python 解释器路径、启动脚本和工作目录。

### ✅ 正确的配置

```json
{
  "mcpServers": {
    "local-browser": {
      "command": "/Users/zhangyu/PycharmProjects/Link2Chrome/server/venv/bin/python",
      "args": ["/Users/zhangyu/PycharmProjects/Link2Chrome/server/main.py"],
      "cwd": "/Users/zhangyu/PycharmProjects/Link2Chrome",
      "env": {
        "LOG_LEVEL": "INFO",
        "LOG_CONSOLE": "false"
      }
    }
  }
}
```

---

## 📝 各编辑器配置

### Claude Code (~/.claude.json)

```json
{
  "mcpServers": {
    "local-browser": {
      "command": "/Users/zhangyu/PycharmProjects/Link2Chrome/server/venv/bin/python",
      "args": ["/Users/zhangyu/PycharmProjects/Link2Chrome/server/main.py"],
      "cwd": "/Users/zhangyu/PycharmProjects/Link2Chrome",
      "env": {
        "LOG_LEVEL": "INFO",
        "LOG_CONSOLE": "false"
      }
    }
  }
}
```

**配置文件位置：** `~/.claude.json`

### Cursor (~/.cursor/mcp.json)

```json
{
  "mcpServers": {
    "local-browser": {
      "command": "/Users/zhangyu/PycharmProjects/Link2Chrome/server/venv/bin/python",
      "args": ["/Users/zhangyu/PycharmProjects/Link2Chrome/server/main.py"],
      "cwd": "/Users/zhangyu/PycharmProjects/Link2Chrome",
      "env": {
        "LOG_LEVEL": "INFO",
        "LOG_CONSOLE": "false"
      }
    }
  }
}
```

**配置文件位置：** `~/.cursor/mcp.json`

### VS Code with Cline Extension

在 VS Code 设置中搜索 "Cline: MCP Settings"，或编辑：

**macOS/Linux:** `~/.vscode/extensions/saoudrizwan.claude-dev-*/settings/cline_mcp_settings.json`
**Windows:** `%APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json`

```json
{
  "mcpServers": {
    "local-browser": {
      "command": "/Users/zhangyu/PycharmProjects/Link2Chrome/server/venv/bin/python",
      "args": ["/Users/zhangyu/PycharmProjects/Link2Chrome/server/main.py"],
      "cwd": "/Users/zhangyu/PycharmProjects/Link2Chrome",
      "env": {
        "LOG_LEVEL": "INFO",
        "LOG_CONSOLE": "false"
      }
    }
  }
}
```

---

## 🔧 配置字段说明

| 字段 | 必需 | 说明 |
|------|------|------|
| `command` | ✅ 是 | Python 虚拟环境的完整路径 |
| `args` | ✅ 是 | 启动参数：`["/path/to/Link2Chrome/server/main.py"]` |
| `cwd` | ✅ 是 | 项目根目录的完整路径 |
| `env` | ❌ 否 | 环境变量（可选） |
| `env.LOG_LEVEL` | ❌ 否 | 日志级别：`INFO`、`WARNING`、`ERROR` |
| `env.LOG_CONSOLE` | ❌ 否 | 是否输出控制台日志（默认 `false`，避免干扰 MCP 通信）|

---

## ✅ 验证配置

### 1. 检查配置格式

**Claude Code:**
```bash
cat ~/.claude.json | jq '.mcpServers."local-browser"'
```

**Cursor:**
```bash
cat ~/.cursor/mcp.json | jq '.mcpServers."local-browser"'
```

应该看到：
```json
{
  "command": "/Users/zhangyu/PycharmProjects/Link2Chrome/server/venv/bin/python",
  "args": ["/Users/zhangyu/PycharmProjects/Link2Chrome/server/main.py"],
  "cwd": "/Users/zhangyu/PycharmProjects/Link2Chrome",
  "env": {
    "LOG_LEVEL": "INFO",
    "LOG_CONSOLE": "false"
  }
}
```

### 2. 测试 MCP Server

```bash
cd /Users/zhangyu/PycharmProjects/Link2Chrome
server/venv/bin/python server/main.py < /dev/null
```

或使用 echo 测试：
```bash
echo '{"jsonrpc":"2.0","method":"initialize","id":1,"params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' | \
server/venv/bin/python server/main.py
```

应该看到：
```json
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{...},"serverInfo":{"name":"local-browser","version":"1.26.0"}}}
```

### 3. 完全重启编辑器

**Claude Code (macOS):**
```
Cmd + Q (完全退出)
然后重新打开
```

**Cursor (macOS):**
```
Cmd + Q (完全退出)
然后重新打开
```

**VS Code:**
```
完全关闭所有窗口
重新启动 VS Code
```

### 4. 测试连接

重启后，在编辑器中执行：
```
请执行 browser_diagnose 工具
```

应该看到：
```
=== Link2Chrome 诊断 ===
WebSocket 连接: 已连接
Extension 版本: 2025-02-03-v4
当前标签页: [URL]
```

---

## 🐛 常见问题

### Q1: "Failed to reconnect to local-browser"

**原因：**
- 配置文件格式错误
- Python 路径不正确
- 端口 8765 被占用（服务器会自动清理，但可能需要重启）

**解决：**
1. 检查配置文件格式是否正确（使用 `jq` 验证）
2. 验证 Python 路径是否存在
3. 检查端口占用：`lsof -i :8765`
4. 完全重启编辑器（不只是关闭窗口）

### Q2: "Module 'server' not found" 或 "No module named 'server'"

**原因：** 使用了 `-m server.main` 模块启动方式，Python 找不到模块

**解决：**
使用直接运行脚本的方式：
```json
{
  "args": ["/Users/zhangyu/PycharmProjects/Link2Chrome/server/main.py"]
}
```

### Q3: "Address already in use" (端口 8765 被占用)

**原因：** 之前的 MCP 服务器实例没有正确关闭

**解决：**
服务器会自动清理占用端口的进程。如果问题持续：
```bash
# 手动清理
lsof -t -i :8765 | xargs kill -9
```

### Q4: "Connection timeout"

**原因：** Python 路径错误或虚拟环境未创建

**解决：**
1. 验证 Python 路径：
   ```bash
   ls -la /Users/zhangyu/PycharmProjects/Link2Chrome/server/venv/bin/python
   ```
2. 如果不存在，运行 `./setup.sh` 重新创建虚拟环境

### Q5: Cursor 找不到配置文件

**原因：** Cursor 的配置文件位置可能不同

**解决：**
尝试以下位置（按优先级）：
1. `~/.cursor/mcp.json`
2. `~/.config/cursor/mcp.json`
3. 在 Cursor 设置中查找 MCP 配置选项

---

## 🔄 更新配置的快速命令

### 更新 Claude Code 配置

```bash
# 备份配置
cp ~/.claude.json ~/.claude.json.backup

# 更新配置（使用 Python 脚本）
python3 << 'EOF'
import json

config_path = "~/.claude.json"
with open(config_path, "r") as f:
    config = json.load(f)

config["mcpServers"]["local-browser"] = {
    "command": "/Users/zhangyu/PycharmProjects/Link2Chrome/server/venv/bin/python",
    "args": ["/Users/zhangyu/PycharmProjects/Link2Chrome/server/main.py"],
    "cwd": "/Users/zhangyu/PycharmProjects/Link2Chrome",
    "env": {
        "LOG_LEVEL": "INFO",
        "LOG_CONSOLE": "false"
    }
}

with open(config_path, "w") as f:
    json.dump(config, f, indent=2)
EOF
```

### 更新 Cursor 配置

```bash
mkdir -p ~/.cursor
cat > ~/.cursor/mcp.json << 'EOF'
{
  "mcpServers": {
    "local-browser": {
      "command": "/Users/zhangyu/PycharmProjects/Link2Chrome/server/venv/bin/python",
      "args": ["/Users/zhangyu/PycharmProjects/Link2Chrome/server/main.py"],
      "cwd": "/Users/zhangyu/PycharmProjects/Link2Chrome",
      "env": {
        "LOG_LEVEL": "INFO",
        "LOG_CONSOLE": "false"
      }
    }
  }
}
EOF
```

---

## 📚 参考资料

- [MCP Protocol Specification](https://spec.modelcontextprotocol.io/)
- [MCP Server Configuration](https://modelcontextprotocol.io/docs/servers/configuration)
- [Link2Chrome Documentation](./README.md)
- [故障排除指南](./TROUBLESHOOTING.md)

---

## 💡 技术说明

### 直接运行脚本 vs 模块启动

**推荐方式（直接运行脚本）：**
```json
{
  "args": ["/path/to/Link2Chrome/server/main.py"]
}
```

**原因：**
1. 避免模块查找问题
2. 更可靠的路径解析
3. 与虚拟环境兼容性更好

**旧方式（不推荐）：**
```json
{
  "args": ["-m", "server.main"]  // 可能导致模块查找失败
}
```

### stdio 通信类型

MCP 支持多种传输类型：

| 类型 | 说明 | 使用场景 |
|------|------|----------|
| `stdio` | 通过标准输入/输出通信 | 本地命令行工具（如本项目） |
| `http` | HTTP REST API | 远程服务（如 web-search-prime） |
| `sse` | Server-Sent Events | 实时流式响应 |

Link2Chrome 使用 **stdio** 类型，因为：
1. 本地运行，无需网络通信
2. 低延迟
3. 安全（不暴露网络端口）

### WebSocket vs stdio

- **stdio**：MCP 客户端（Claude Code/Cursor）与 MCP Server 之间的通信
- **WebSocket**：MCP Server 与 Chrome Extension 之间的通信

```
[编辑器] <--stdio--> [MCP Server] <--WebSocket--> [Chrome Extension] <--CDP--> [浏览器]
```

两者是独立的通信通道，互不影响。

---

## 🎉 配置成功后

运行完整测试验证所有功能：

```bash
cd /Users/zhangyu/PycharmProjects/Link2Chrome
python test/quick_test.py
```

应该通过所有 4 个测试：

```
✅ 测试 1/4: 基础诊断
✅ 测试 2/4: 导航功能
✅ 测试 3/4: 页面状态获取
✅ 测试 4/4: 内容提取

🎉 所有测试通过！Link2Chrome 运行正常。
```

---

如有问题，请查看 [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) 或运行 `./diagnose.sh` 进行自动诊断。

---

## 方案 C：多 Agent 与三控制面补充

Link2Chrome 现在暴露三组同时存在的命名空间工具，任意 MCP 客户端都可以共享同一个 MCP server：

- `browser.dom.*`：复用扩展平面，适合稳定选择器、结构化页面和省 token 自动化。
- `browser.cua.*`：复用扩展平面，适合视觉页面、canvas、表格坐标和选择器不稳定的场景。先调用 `browser.cua.screenshot`，由调用方多模态模型判断截图坐标，再调用坐标原语。
- `browser.pw.*`：Playwright/CDP 平面，适合 browser-use 或需要 Playwright API 的任务。先 `browser.pw.start`，再 `browser.pw.endpoint` 取得 CDP URL。

`browser.set_mode` 只记录会话默认偏好；显式调用某个命名空间工具时，不会被这个偏好限制。

### 通用 MCP 片段

```json
{
  "mcpServers": {
    "link2chrome": {
      "command": "/Users/zhangyu/PycharmProjects/Link2Chrome/server/venv/bin/python",
      "args": ["/Users/zhangyu/PycharmProjects/Link2Chrome/server/main.py"],
      "cwd": "/Users/zhangyu/PycharmProjects/Link2Chrome",
      "env": {
        "LOG_LEVEL": "INFO",
        "LOG_CONSOLE": "false"
      }
    }
  }
}
```

### browser-use / Playwright

如果要让 browser-use 或外部 Playwright 直连：

1. 用 `--remote-debugging-port=9222` 启动 Tabbit/Chrome，或设置 `PLAYWRIGHT_CDP_URL`。
2. 调用 `browser.pw.start{"mode":"attach","browser":"tabbit"}` 或 `browser.pw.start{"mode":"attach","browser":"chrome"}`。
3. 调用 `browser.pw.endpoint`，把返回的 URL 传给 `connectOverCDP` 或 browser-use 的 CDP session 配置。

### 真实 Chrome E2E

普通单测不会强制连接真实浏览器。要验证 WebSocket、Extension 和 runtime 三个能力面，请先确认 Chrome/Tabbit 已加载 Link2Chrome extension，然后运行：

```bash
LINK2CHROME_REAL_CHROME_E2E=1 node --test test/e2e/runtime-real-chrome.test.mjs
```

该测试会使用 `python3 server/main.py` 拉起 MCP adapter/Browser Hub；本机 Python 3.9 可直接运行。如果你已经手动启动了 server，可加：

```bash
LINK2CHROME_REAL_CHROME_E2E=1 LINK2CHROME_E2E_START_SERVER=0 node --test test/e2e/runtime-real-chrome.test.mjs
```

失败时测试会记录 Chrome 是否运行、Extension 是否安装/连接、WebSocket readiness、当前 tab 和 server stderr，便于定位 profile、extension 或 hub 连接问题。

### 开发者模式直接可用

如果目标是“只在 `chrome://extensions` 加载 `extension/` 后就能用”，先执行一次：

```bash
node scripts/dev-extension/install.mjs
```

它会安装：

- 固定扩展 ID 对应的 Native Messaging Host manifest。
- Host 路径：`scripts/native-host/native-host.mjs`。
- 允许来源：当前 `extension/manifest.json` 的固定 key 推导出的 extension id。

完成后重新加载 unpacked extension。扩展 background 会先调用 `chrome.runtime.connectNative("com.link2chrome.nativehost")`，Native Host 会拉起 `server/browser_hub.py`，然后扩展继续连接 `ws://localhost:8765`。popup 会显示 Native Host 与 WebSocket/Hub 的连接状态。
