#!/bin/bash
# Link2Chrome 自动诊断脚本

set -e

echo "🔍 Link2Chrome 自动诊断"
echo "========================================"
echo

# 检查 1：Python 虚拟环境
echo "✓ 检查 Python 虚拟环境..."
if [ -f "server/venv/bin/python" ]; then
    PYTHON_VERSION=$(server/venv/bin/python --version 2>&1)
    echo "  Python 版本: $PYTHON_VERSION"
else
    echo "  ❌ 虚拟环境不存在！请运行 ./setup.sh"
    exit 1
fi
echo

# 检查 2：依赖包
echo "✓ 检查 Python 依赖..."
# 检查关键依赖（使用正确的导入名）
MISSING_DEPS=()

# 检查每个包（使用导入名而不是安装名）
for pkg in "mcp" "websockets" "openai" "dotenv" "PIL" "markdownify"; do
    if ! server/venv/bin/python -c "import $pkg" 2>/dev/null; then
        MISSING_DEPS+=("$pkg")
    fi
done

if [ ${#MISSING_DEPS[@]} -eq 0 ]; then
    echo "  所有依赖已安装 ✅"
else
    echo "  ❌ 缺少依赖: ${MISSING_DEPS[*]}"
    echo "  运行: server/venv/bin/pip install -r server/requirements.txt"
    exit 1
fi
echo

# 检查 3：环境变量
echo "✓ 检查环境变量..."
if [ -f ".env" ]; then
    echo "  .env 文件存在 ✅"
    if grep -q "DOUBAO_API_KEY" .env; then
        echo "  DOUBAO_API_KEY 已设置"
    else
        echo "  ⚠️  DOUBAO_API_KEY 未设置（Vision 功能将不可用）"
    fi
else
    echo "  ⚠️  .env 文件不存在（Vision 功能将不可用）"
fi
echo

# 检查 4：端口占用
echo "✓ 检查端口 8765..."
if lsof -i :8765 >/dev/null 2>&1; then
    echo "  ⚠️  端口 8765 已被占用："
    lsof -i :8765 | grep LISTEN
    echo "  可能需要终止占用进程"
else
    echo "  端口 8765 空闲 ✅"
fi
echo

# 检查 5：运行中的进程
echo "✓ 检查运行中的 MCP Server..."
if ps aux | grep -E "python.*server.main" | grep -v grep >/dev/null; then
    echo "  ⚠️  发现运行中的 MCP Server 进程："
    ps aux | grep -E "python.*server.main" | grep -v grep
    echo "  建议终止后重新启动 Claude Code"
else
    echo "  无运行中的进程 ✅"
fi
echo

# 检查 6：Claude Code 配置
echo "✓ 检查 Claude Code 配置..."
if [ -f "$HOME/.claude.json" ]; then
    if grep -q "local-browser" "$HOME/.claude.json"; then
        echo "  ~/.claude.json 包含 local-browser 配置 ✅"

        # 提取并验证配置
        PYTHON_PATH=$(cat "$HOME/.claude.json" | python3 -c "import json, sys; data=json.load(sys.stdin); print(data.get('mcpServers', {}).get('local-browser', {}).get('command', ''))" 2>/dev/null || echo "")

        if [ -n "$PYTHON_PATH" ]; then
            if [ -f "$PYTHON_PATH" ]; then
                echo "  Python 路径正确: $PYTHON_PATH"
            else
                echo "  ❌ Python 路径不存在: $PYTHON_PATH"
                echo "  请更新 ~/.claude.json 中的 command 路径"
                exit 1
            fi
        fi
    else
        echo "  ❌ ~/.claude.json 中未找到 local-browser 配置"
        echo "  请参考 claude_config_snippet.json 添加配置"
        exit 1
    fi
else
    echo "  ❌ ~/.claude.json 不存在"
    echo "  请创建配置文件"
    exit 1
fi
echo

# 检查 7：日志目录
echo "✓ 检查日志目录..."
if [ -d "logs" ]; then
    LOG_COUNT=$(ls -1 logs/*.log 2>/dev/null | wc -l)
    echo "  日志目录存在，包含 $LOG_COUNT 个日志文件"

    # 检查今天的日志
    TODAY_LOG="logs/link2chrome_$(date +%Y-%m-%d).log"
    if [ -f "$TODAY_LOG" ]; then
        LAST_LINE=$(tail -1 "$TODAY_LOG" 2>/dev/null || echo "")
        if [ -n "$LAST_LINE" ]; then
            echo "  最新日志记录: $(echo "$LAST_LINE" | cut -c1-80)..."
        fi
    fi
else
    echo "  日志目录不存在（将在首次运行时创建）"
fi
echo

# 检查 8：MCP stdio 通信测试
echo "✓ 测试 MCP Server stdio 通信..."
if [ -f "test_mcp_connection.py" ]; then
    if python test_mcp_connection.py 2>&1 | grep -q "MCP Server 正常响应"; then
        echo "  MCP Server stdio 通信正常 ✅"
    else
        echo "  ❌ MCP Server stdio 通信失败"
        echo "  查看详细输出："
        python test_mcp_connection.py
        exit 1
    fi
else
    echo "  ⚠️  test_mcp_connection.py 不存在，跳过测试"
fi
echo

# 总结
echo "========================================"
echo "📋 诊断总结"
echo "========================================"
echo
echo "✅ 所有检查通过！"
echo
echo "📝 接下来的步骤："
echo
echo "1. 确保 Chrome Extension 已加载："
echo "   - 打开 chrome://extensions/"
echo "   - 确认 Link2Chrome 已启用"
echo "   - 如有错误，点击 🔄 重新加载"
echo
echo "2. 完全重启 Claude Code："
echo "   macOS: Cmd + Q 退出，然后重新打开"
echo "   Linux: 完全关闭所有 Claude Code 窗口"
echo
echo "3. 等待 5-10 秒让 MCP Server 连接"
echo
echo "4. 测试连接："
echo "   在 Claude Code 中执行: browser_diagnose"
echo
echo "5. 运行完整测试（可选）："
echo "   python test/quick_test.py"
echo
echo "如果仍有问题，请查看 TROUBLESHOOTING.md"
echo
