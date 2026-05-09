# Cursor MCP 配置指南

## 🎯 问题与解决方案

### 问题
Cursor 启动 MCP Server 时没有正确应用 `cwd`（工作目录）参数，导致：
```
ModuleNotFoundError: No module named 'server'
```

### 解决方案
使用启动脚本替代直接运行 Python 命令，脚本会自动切换到正确的工作目录。

---

## ✅ 正确的 Cursor 配置

### 配置文件位置
`~/.cursor/mcp.json`

### 配置内容

```json
{
  "mcpServers": {
    "local-browser": {
      "type": "stdio",
      "command": "/Users/zhangyu/PycharmProjects/Link2Chrome/start_mcp_server.sh",
      "args": []
    }
  }
}
```

### 启动脚本 (start_mcp_server.sh)

已自动创建在项目根目录：
```bash
#!/bin/bash
# MCP Server 启动脚本（兼容 Cursor）

cd "$(dirname "$0")"
exec server/venv/bin/python -m server.main
```

---

## 🔄 部署步骤

### 1. 配置已就绪
- ✅ `~/.cursor/mcp.json` 已更新
- ✅ `start_mcp_server.sh` 已创建并设置为可执行
- ✅ 启动脚本已验证工作正常

### 2. 完全重启 Cursor

**macOS:**
```
Cmd + Q (完全退出 Cursor)
重新打开 Cursor
打开 Link2Chrome 项目
等待 10 秒让 MCP Server 连接
```

### 3. 验证连接

在 Cursor 的 Composer 中输入：
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

### 4. 查看 MCP 状态

在 Cursor 中：
1. 打开 **Settings** (Cmd + ,)
2. 搜索 "MCP"
3. 查看 "local-browser" 的状态

应该显示：
- ✅ **Connected** (绿色)
- Server Name: local-browser
- Version: 1.26.0

---

## 🔍 对比：两种配置方式

### ❌ 方式 1：直接运行 Python（Cursor 不支持）

```json
{
  "local-browser": {
    "type": "stdio",
    "command": "/path/to/python",
    "args": ["-m", "server.main"],
    "cwd": "/path/to/Link2Chrome"  // Cursor 可能不正确应用
  }
}
```

**问题：** Cursor 不能正确设置工作目录，导致 Python 找不到模块。

### ✅ 方式 2：使用启动脚本（推荐）

```json
{
  "local-browser": {
    "type": "stdio",
    "command": "/path/to/start_mcp_server.sh",
    "args": []
  }
}
```

**优点：**
- ✅ 脚本自动切换到正确的工作目录
- ✅ 不依赖客户端的 `cwd` 参数
- ✅ 兼容所有 MCP 客户端（Cursor、Claude Code、VS Code）

---

## 🐛 故障排除

### 问题 1: "Permission denied"

**症状：**
```
/bin/bash: /path/to/start_mcp_server.sh: Permission denied
```

**解决：**
```bash
chmod +x /Users/zhangyu/PycharmProjects/Link2Chrome/start_mcp_server.sh
```

### 问题 2: "command not found: python"

**症状：**
```
server/venv/bin/python: command not found
```

**解决：**
虚拟环境不存在，运行：
```bash
cd /Users/zhangyu/PycharmProjects/Link2Chrome
./setup.sh
```

### 问题 3: "Address already in use"

**症状：**
```
OSError: [Errno 48] address already in use
```

**解决：**
端口 8765 被占用，清理进程：
```bash
lsof -ti :8765 | xargs kill -9
pkill -f "python.*server.main"
```

### 问题 4: Cursor 中看不到 MCP 工具

**检查步骤：**

1. **查看 MCP 日志（Cursor）：**
   - Settings > MCP Servers
   - 点击 "local-browser"
   - 查看日志输出

2. **检查配置文件：**
   ```bash
   cat ~/.cursor/mcp.json | jq .
   ```

3. **手动测试启动脚本：**
   ```bash
   echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' | /Users/zhangyu/PycharmProjects/Link2Chrome/start_mcp_server.sh
   ```
   应该看到 JSON 响应。

4. **清理缓存：**
   ```bash
   rm -rf ~/.cursor/projects/Users-zhangyu-PycharmProjects-Link2Chrome/mcps/user-local-browser/*
   ```
   然后重启 Cursor。

---

## 📊 与其他编辑器的对比

### Claude Code

Claude Code **正确支持** `cwd` 参数，可以直接使用：

```json
{
  "local-browser": {
    "type": "stdio",
    "command": "/path/to/python",
    "args": ["-m", "server.main"],
    "cwd": "/path/to/Link2Chrome"
  }
}
```

**但建议也使用启动脚本以保持一致性。**

### VS Code with Cline

Cline 也可能有类似问题，推荐使用启动脚本。

---

## 🎉 验证成功

完全重启 Cursor 后，运行：

```bash
cd /Users/zhangyu/PycharmProjects/Link2Chrome
python test/quick_test.py
```

应该看到：
```
✅ 测试 1/4: 基础诊断
✅ 测试 2/4: 导航功能
✅ 测试 3/4: 页面状态获取
✅ 测试 4/4: 内容提取

🎉 所有测试通过！Link2Chrome 运行正常。
```

---

## 📚 相关文档

- [MCP 配置指南](./MCP_CONFIG_GUIDE.md) - 详细的多编辑器配置
- [故障排除](./TROUBLESHOOTING.md) - 完整的故障排除指南
- [项目 README](./README.md) - 项目概述和快速开始

---

## 🔧 技术细节

### 为什么 Cursor 需要特殊处理？

Cursor 的 MCP 实现可能在以下方面与标准有差异：
1. `cwd` 参数的处理
2. 环境变量的继承
3. 子进程的启动方式

使用启动脚本可以绕过这些差异，确保在所有环境下都能正确启动。

### 启动脚本的工作原理

```bash
cd "$(dirname "$0")"  # 切换到脚本所在目录（项目根目录）
exec server/venv/bin/python -m server.main  # 替换当前进程
```

- `cd "$(dirname "$0")"`: 确保总是在项目根目录运行
- `exec`: 用 Python 进程替换 bash 进程，避免多余的进程层级
- 相对路径 `server/venv/bin/python`: 从项目根目录开始

---

**配置完成后，请完全重启 Cursor，然后测试连接！** 🚀
