# Link2Chrome MCP 服务器连接问题诊断报告

## 问题描述
运行 `claude mcp list` 时,`local-browser` 服务器显示 "✗ Failed to connect"

## 根本原因
**端口冲突**: 端口 8765 被之前的 WebSocket 服务器进程占用,导致新的 MCP 服务器实例无法启动。

## 详细诊断

### 1. 问题表现
```bash
$ claude mcp list
local-browser: ... - ✗ Failed to connect
```

### 2. 日志分析
- MCP 服务器尝试启动
- 报错: `OSError: [Errno 48] address already in use` (端口 8765)
- 服务器启动失败,进程立即退出

### 3. 原因分析
之前运行的 MCP 服务器进程(PID 68795)占用了端口 8765,导致:
- 新的 MCP 实例无法绑定该端口
- Claude Code 连接检查失败
- Chrome Extension 无法连接到 WebSocket 服务器

## 已执行的修复步骤

### 1. 清理占用的端口
```bash
kill -9 68795
```

### 2. 重新启动 MCP 服务器
```bash
/Users/zhangyu/PycharmProjects/Link2Chrome/server/venv/bin/python -m server.main &
```

### 3. 当前状态
- ✓ MCP 服务器已启动 (PID: 71185)
- ✓ WebSocket Server 正在监听 ws://localhost:8765
- ⏳ 等待 Chrome Extension 连接

## 下一步操作

### 选项 A: 等待 Claude Code 自动重连
1. 运行 `claude mcp list` 再次检查连接状态
2. 如果仍然失败,继续执行选项 B

### 选项 B: 手动触发 Chrome Extension 连接
Chrome Extension 可能需要刷新才能连接到新的 WebSocket 服务器:

1. **刷新 Extension**:
   - 打开 `chrome://extensions/`
   - 找到 "Link2Chrome" 扩展
   - 点击刷新按钮 (🔄)

2. **检查连接日志**:
   ```bash
   tail -f /Users/zhangyu/PycharmProjects/Link2Chrome/logs/link2chrome_2026-02-06.log
   ```
   应该看到: `Chrome Extension 已连接: ('::1', ...)`

3. **再次测试连接**:
   ```bash
   claude mcp list
   ```

### 选项 C: 完全重启系统 (推荐)
为确保干净的状态,建议:

1. **停止所有相关进程**:
   ```bash
   pkill -f "python -m server.main"
   ```

2. **重启 Claude Code**:
   - 退出 Claude Code
   - 重新启动
   - Claude Code 会自动启动 MCP 服务器

3. **刷新 Chrome Extension** (如上)

4. **验证连接**:
   ```bash
   claude mcp list
   ```

## 预防措施

### 1. 创建启动脚本
创建 `/Users/zhangyu/PycharmProjects/Link2Chrome/start_mcp_server.sh`:

```bash
#!/bin/bash
# 停止旧进程
pkill -f "python -m server.main" 2>/dev/null

# 等待端口释放
sleep 1

# 启动新进程
cd /Users/zhangyu/PycharmProjects/Link2Chrome
/Users/zhangyu/PycharmProjects/Link2Chrome/server/venv/bin/python -m server.main
```

### 2. 修改 MCP 配置以处理端口冲突
在 `server/ws_manager.py` 的 `start()` 方法中添加端口检查和清理逻辑。

### 3. 添加健康检查端点
扩展 MCP 服务器以提供健康检查 API,便于诊断。

## 技术细节

### 端口占用检查
```bash
# 查看占用 8765 端口的进程
lsof -i :8765

# 输出示例:
# COMMAND   PID    USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
# Python  68795 zhangyu   10u  IPv6  0x87a917... TCP localhost:8765 (LISTEN)
```

### MCP 服务器启动流程
1. 初始化日志系统
2. 启动 WebSocket Server (端口 8765)
3. 等待 Chrome Extension 连接
4. 通过 stdio 与 Claude Code 通信
5. 在 Claude Code 和 Chrome Extension 之间转发命令

### 连接架构
```
Claude Code (MCP Client)
    ↕ stdio (JSON-RPC)
MCP Server (Python)
    ↕ WebSocket (ws://localhost:8765)
Chrome Extension (Background Service Worker)
    ↕ Chrome DevTools Protocol
Browser Tab
```

## 常见问题

### Q: 为什么会有多个 MCP 服务器进程?
A: 可能的原因:
- 手动运行了 `python -m server.main`
- Claude Code 启动失败但进程未完全退出
- 测试时启动了多个实例

### Q: 如何确认 Chrome Extension 已连接?
A: 查看日志:
```bash
tail -f /Users/zhangyu/PycharmProjects/Link2Chrome/logs/link2chrome_2026-02-06.log | grep "Extension 已连接"
```

### Q: `claude mcp list` 仍然显示失败怎么办?
A: 按顺序尝试:
1. 等待 10-15 秒后重试
2. 重启 Claude Code
3. 清理所有进程并重新启动
4. 检查 Python 虚拟环境路径是否正确

---

**生成时间**: 2026-02-06 17:20
**状态**: MCP 服务器已启动,等待 Chrome Extension 连接
