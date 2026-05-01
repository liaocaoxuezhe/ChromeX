"""
Link2Chrome MCP Server 入口
支持通过 python -m server 启动
"""
import sys
from pathlib import Path

# 确保项目根目录在 Python 路径中
project_root = Path(__file__).parent.parent
if str(project_root) not in sys.path:
    sys.path.insert(0, str(project_root))

# 导入并运行主模块
from server.main import main

if __name__ == "__main__":
    main()
