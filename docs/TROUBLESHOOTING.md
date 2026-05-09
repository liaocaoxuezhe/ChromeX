# Link2Chrome 故障排查指南

## 常见问题

### 1. MCP 服务器无法启动

**症状**: Claude Code 提示 "MCP server failed to start"

**解决方案**:
```bash
cd /Users/zhangyu/PycharmProjects/Link2Chrome

# 检查 Python 虚拟环境
test -f server/venv/bin/python && echo "✓ 虚拟环境正常" || echo "✗ 需要运行 ./setup.sh"

# 手动测试服务器
echo '{"jsonrpc":"2.0","method":"initialize","id":1,"params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' | \
server/venv/bin/python server/main.py
```

**预期输出**:
```json
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05",...}}
```

### 2. Chrome 扩展无法连接

**症状**: 扩展图标显示断开连接

**解决方案**:
1. 确认扩展已正确加载到 Chrome
2. 打开扩展的 popup 界面，检查连接状态
3. 查看 Chrome 扩展的 Service Worker 日志:
   - 访问 `chrome://extensions/`
   - 找到 Link2Chrome 扩展
   - 点击 "Service Worker" 查看日志
4. 确认 MCP 服务器 WebSocket 端口 (8765) 已启动:
   ```bash
   lsof -i :8765
   ```

### 3. WebSocket 连接失败

**症状**: 扩展日志显示 "WebSocket connection failed"

**原因**:
- MCP 服务器未启动
- 端口 8765 被占用
- 防火墙阻止本地连接

**解决方案**:
```bash
# 检查端口状态
lsof -i :8765

# 如果端口被占用，服务器会自动清理
# 或手动清理:
lsof -t -i :8765 | xargs kill -9

# 重启 Claude Code 让 MCP 服务器重新启动
```

**注意**: MCP 服务器会在启动时自动清理占用端口的进程，无需手动干预。

### 4. API 密钥错误

**症状**: vision 功能报错 "Invalid API key"

**解决方案**:
```bash
# 检查 .env 文件
cat /Users/zhangyu/PycharmProjects/Link2Chrome/.env

# 确保包含有效的配置:
# DOUBAO_API_KEY=your-api-key-here
# DOUBAO_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
# DOUBAO_MODEL=doubao-seed-1-8-251228
```

**注意**: `.env` 文件应在项目根目录（`/Users/zhangyu/PycharmProjects/Link2Chrome/.env`）

### 5. 查看日志

```bash
cd /Users/zhangyu/PycharmProjects/Link2Chrome/server

# 查看最新日志
python view_logs.py -t main -n 100

# 查看错误日志
python view_logs.py -t error -n 50

# 实时监控操作日志
python view_logs.py -t operations -f
```

## 测试命令

### 基础连接测试
在 Claude Code 中运行: 请使用 browser_diagnose 工具测试连接

### 完整功能测试
1. 获取浏览器状态: 请使用 `browser_get_state` 获取当前浏览器状态（仅文本状态和 DOM）
2. 获取页面截图: 请使用 `browser_get_screenshot` 获取当前页面截图
3. 导航测试: 请使用 `browser_action_navigate` 访问 https://www.baidu.com
4. 视觉交互测试: 请使用 `browser_action_vision` 在百度首页点击搜索框

## 配置检查清单

### 基础配置
- [ ] Python 3.12+ 虚拟环境已创建 (`server/venv/bin/python` 存在)
- [ ] `server/requirements.txt` 依赖已安装
- [ ] `.env` 文件已配置 API 密钥

### MCP 配置
- [ ] `~/.claude.json` 包含正确的 MCP 服务器配置
  - [ ] `command` 指向正确的 Python 解释器
  - [ ] `args` 包含 `main.py` 的完整路径
  - [ ] `cwd` 设置为项目根目录
  - [ ] `env.LOG_CONSOLE` 设置为 `false`

### Chrome 扩展
- [ ] Chrome 扩展已加载 (`chrome://extensions/`)
- [ ] 扩展已启用
- [ ] 至少有一个浏览器标签页打开

### 验证步骤
- [ ] 重启 Claude Code（完全退出后重新打开）
- [ ] 测试 MCP 连接：运行 `browser_diagnose` 工具
- [ ] 检查日志文件确认没有错误

## 联系支持

如果问题仍未解决，请查看:

### 日志文件位置
- **主日志**: `logs/link2chrome_YYYY-MM-DD.log`
- **错误日志**: `logs/link2chrome_error_YYYY-MM-DD.log`
- **操作日志**: `logs/operations/operations_YYYY-MM-DD.log`

### 查看日志命令
```bash
cd /Users/zhangyu/PycharmProjects/Link2Chrome/server

# 查看最新日志（最后 50 行）
python view_logs.py -t main -n 50

# 查看错误日志
python view_logs.py -t error -n 50

# 实时监控操作日志
python view_logs.py -t operations -f
```

### Chrome 扩展日志
1. 访问 `chrome://extensions/`
2. 找到 Link2Chrome 扩展
3. 点击 "Service Worker" 查看日志

### 常用诊断命令
```bash
# 检查端口占用
lsof -i :8765

# 测试 MCP 服务器
echo '{"jsonrpc":"2.0","method":"initialize","id":1,"params":{...}}' | server/venv/bin/python server/main.py

# 检查 Python 环境
server/venv/bin/python --version
server/venv/bin/python -m pip list | grep mcp
```
