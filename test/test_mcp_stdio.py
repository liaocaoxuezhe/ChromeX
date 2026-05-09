#!/usr/bin/env python3
"""
测试 MCP Server 的 stdio 通信
"""
import asyncio
import json
import sys


async def test_mcp_connection():
    """测试 MCP 初始化握手"""
    print("开始测试 MCP stdio 通信...", file=sys.stderr)

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

    print(f"发送初始化请求: {json.dumps(init_request)}", file=sys.stderr)
    print(json.dumps(init_request))
    sys.stdout.flush()

    # 等待响应
    try:
        response_line = await asyncio.wait_for(
            asyncio.to_thread(sys.stdin.readline),
            timeout=5.0
        )
        print(f"收到响应: {response_line.strip()}", file=sys.stderr)

        response = json.loads(response_line)
        if "result" in response:
            print("✓ MCP 初始化成功!", file=sys.stderr)
            print(f"服务器信息: {response['result']}", file=sys.stderr)
            return True
        else:
            print(f"✗ MCP 初始化失败: {response}", file=sys.stderr)
            return False
    except asyncio.TimeoutError:
        print("✗ 等待响应超时", file=sys.stderr)
        return False
    except Exception as e:
        print(f"✗ 错误: {e}", file=sys.stderr)
        return False


if __name__ == "__main__":
    result = asyncio.run(test_mcp_connection())
    sys.exit(0 if result else 1)
