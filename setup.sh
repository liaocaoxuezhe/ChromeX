#!/bin/bash
# Link2Chrome - 安装脚本

set -e

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER_DIR="$PROJECT_DIR/server"
VENV_DIR="$SERVER_DIR/venv"

echo "=============================="
echo "  Link2Chrome 安装脚本"
echo "=============================="
echo ""

# 1. 检测 Python 3.10+
echo "[1/4] 检测 Python 3.10+..."
if command -v python3.12 &> /dev/null; then
    PYTHON=$(command -v python3.12)
elif command -v python3.11 &> /dev/null; then
    PYTHON=$(command -v python3.11)
elif command -v python3.10 &> /dev/null; then
    PYTHON=$(command -v python3.10)
elif command -v python3 &> /dev/null; then
    PYTHON=$(command -v python3)
else
    echo "  ✗ 未找到 Python 3.10+"
    echo "  当前 MCP 依赖要求 Python 3.10 或更高版本"
    exit 1
fi

echo "  ✓ 找到 Python: $PYTHON"
$PYTHON --version

PY_VERSION=$("$PYTHON" - << 'EOF'
import sys
print(f"{sys.version_info.major}.{sys.version_info.minor}")
EOF
)

if "$PYTHON" - << 'EOF'
import sys
raise SystemExit(0 if sys.version_info >= (3, 10) else 1)
EOF
then
    echo "  ✓ Python 版本满足要求: $PY_VERSION"
else
    echo "  ✗ 当前 Python 版本过低: $PY_VERSION"
    echo "  当前 MCP 依赖要求 Python 3.10 或更高版本；请先安装 python3.10+，脚本会在 server/venv 中隔离安装依赖"
    exit 1
fi

# 2. 创建/更新虚拟环境
echo ""
echo "[2/4] 设置虚拟环境..."
if [ ! -d "$VENV_DIR" ]; then
    $PYTHON -m venv "$VENV_DIR"
    echo "  ✓ 已创建虚拟环境: $VENV_DIR"
else
    echo "  ✓ 虚拟环境已存在: $VENV_DIR"
fi

# 3. 安装依赖
echo ""
echo "[3/4] 安装 Python 依赖..."
"$VENV_DIR/bin/pip" install -q -r "$SERVER_DIR/requirements.txt"
echo "  ✓ 依赖安装完成"

# 4. 检查 .env
echo ""
echo "[4/4] 检查配置文件..."
if [ -f "$PROJECT_DIR/.env" ]; then
    echo "  ✓ .env 文件已存在"
else
    echo "  ⚠ 未找到 .env 文件，创建模板..."
    cat > "$PROJECT_DIR/.env" << 'EOF'
DOUBAO_API_KEY=your-api-key-here
DOUBAO_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
DOUBAO_MODEL=doubao-seed-1.8-thinking-250528
EOF
    echo "  请编辑 .env 文件填入你的 API Key"
fi

echo ""
echo "=============================="
echo "  安装完成！"
echo "=============================="
echo ""
echo "后续步骤:"
echo ""
echo "1. 加载 Chrome 扩展:"
echo "   打开 chrome://extensions/"
echo "   开启「开发者模式」"
echo "   点击「加载已解压的扩展程序」"
echo "   选择目录: $PROJECT_DIR/extension/"
echo ""
echo "2. 配置 Claude Code (将以下内容合并到 ~/.claude.json):"
echo ""
cat "$PROJECT_DIR/claude_config_snippet.json"
echo ""
echo ""
echo "3. 启动后，扩展会自动连接 WebSocket 服务器"
echo "   在 Claude Code 中即可使用 browser_* 系列工具"
