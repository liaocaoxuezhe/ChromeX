#!/bin/bash
# Link2Chrome - 清理并准备重连

echo "========================================="
echo "Link2Chrome 清理脚本"
echo "========================================="
echo ""

# 1. 停止所有相关进程
echo "[1/3] 清理旧进程..."
pkill -f "python -m server.main" 2>/dev/null && echo "  ✓ 已停止 MCP 服务器进程" || echo "  ℹ 没有运行中的 MCP 服务器"

# 2. 等待并验证端口释放
echo ""
echo "[2/3] 验证端口 8765..."
sleep 2

if lsof -i :8765 > /dev/null 2>&1; then
    echo "  ⚠️  端口 8765 仍被占用，强制清理..."
    PID=$(lsof -ti :8765)
    if [ ! -z "$PID" ]; then
        kill -9 $PID 2>/dev/null
        sleep 1
    fi
fi

if ! lsof -i :8765 > /dev/null 2>&1; then
    echo "  ✓ 端口 8765 已释放"
else
    echo "  ✗ 端口 8765 仍被占用"
    lsof -i :8765
    echo ""
    echo "请手动检查占用进程"
    exit 1
fi

# 3. 提供下一步指示
echo ""
echo "[3/3] 清理完成"
echo ""
echo "========================================="
echo "✓ 系统已清理完成"
echo "========================================="
echo ""
echo "现在请执行以下步骤:"
echo ""
echo "1. 刷新 Chrome Extension:"
echo "   - 打开: chrome://extensions/"
echo "   - 找到 'Link2Chrome' 扩展"
echo "   - 点击刷新按钮 (🔄)"
echo ""
echo "2. 让 Claude Code 重新连接:"
echo "   方式 A (推荐): 运行"
echo "     claude mcp list"
echo "   Claude Code 会自动启动 MCP 服务器"
echo ""
echo "   方式 B: 如果方式 A 不工作，重启 Claude Code"
echo "     - 退出 Claude Code"
echo "     - 重新启动"
echo ""
echo "3. 验证连接:"
echo "   claude mcp list"
echo "   应该显示: local-browser: ... - ✓ Connected"
echo ""
echo "4. 查看日志 (可选):"
echo "   tail -f logs/link2chrome_\$(date +%Y-%m-%d).log"
echo ""
