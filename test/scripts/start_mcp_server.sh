#!/bin/bash
# MCP Server 启动脚本（兼容 Cursor）

cd "$(dirname "$0")"
exec server/venv/bin/python -m server.main
