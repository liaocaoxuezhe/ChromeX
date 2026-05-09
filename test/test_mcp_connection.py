#!/usr/bin/env python
"""测试 MCP Server 的 stdio 通信"""
import asyncio
import json
import sys
from pathlib import Path

# 添加 server 目录到 Python 路径
sys.path.insert(0, str(Path(__file__).parent / "server"))

async def test_mcp_stdio():
    """测试 MCP Server 是否能正常启动并响应"""
    print("🔍 测试 MCP Server stdio 通信...", file=sys.stderr)

    # 启动 MCP Server 进程
    process = await asyncio.create_subprocess_exec(
        "/Users/zhangyu/PycharmProjects/Link2Chrome/server/venv/bin/python",
        "-m", "server.main",
        cwd="/Users/zhangyu/PycharmProjects/Link2Chrome",
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE
    )

    print("✅ MCP Server 进程已启动", file=sys.stderr)

    # 发送初始化请求
    init_request = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {
                "name": "test-client",
                "version": "1.0.0"
            }
        }
    }

    print(f"📤 发送初始化请求: {json.dumps(init_request)[:100]}...", file=sys.stderr)
    process.stdin.write(json.dumps(init_request).encode() + b'\n')
    await process.stdin.drain()

    # 等待响应（5秒超时）
    try:
        response_line = await asyncio.wait_for(process.stdout.readline(), timeout=5.0)
        response = json.loads(response_line.decode())
        print(f"📥 收到响应: {json.dumps(response)[:200]}...", file=sys.stderr)

        if "result" in response:
            print("✅ MCP Server 正常响应！", file=sys.stderr)
            print(f"   服务器信息: {response['result'].get('serverInfo', {})}", file=sys.stderr)
            success = True
        else:
            print(f"❌ 响应格式异常: {response}", file=sys.stderr)
            success = False

    except asyncio.TimeoutError:
        print("❌ 等待响应超时（5秒）", file=sys.stderr)
        success = False
    except Exception as e:
        print(f"❌ 解析响应失败: {e}", file=sys.stderr)
        success = False

    # 读取 stderr 输出
    try:
        stderr_output = await asyncio.wait_for(process.stderr.read(1000), timeout=0.5)
        if stderr_output:
            print(f"\n📋 Server stderr:\n{stderr_output.decode()}", file=sys.stderr)
    except asyncio.TimeoutError:
        pass

    # 终止进程
    process.terminate()
    await process.wait()

    return success

if __name__ == "__main__":
    result = asyncio.run(test_mcp_stdio())
    sys.exit(0 if result else 1)
