#!/usr/bin/env python3
"""测试 MCP Server 的 stdio 通信"""
import subprocess
import json
import sys
import time

def test_stdio():
    print("🔍 测试 MCP Server stdio 通信...\n")

    # 启动 MCP Server
    proc = subprocess.Popen(
        ["/Users/zhangyu/PycharmProjects/Link2Chrome/server/venv/bin/python", "-m", "server.main"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd="/Users/zhangyu/PycharmProjects/Link2Chrome",
        text=True,
        bufsize=1
    )

    print(f"✅ MCP Server 进程已启动 (PID: {proc.pid})\n")

    # 发送初始化请求
    init_request = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "test", "version": "1.0"}
        }
    }

    print(f"📤 发送初始化请求:\n{json.dumps(init_request, indent=2)}\n")

    try:
        # 发送请求
        proc.stdin.write(json.dumps(init_request) + '\n')
        proc.stdin.flush()

        print("⏳ 等待响应...\n")

        # 等待响应（最多5秒）
        start_time = time.time()
        response = None

        while time.time() - start_time < 5:
            line = proc.stdout.readline()
            if line:
                try:
                    response = json.loads(line)
                    break
                except json.JSONDecodeError as e:
                    print(f"⚠️  解析JSON失败: {line.strip()}")
                    print(f"    错误: {e}\n")
                    continue

        if response:
            print(f"📥 收到响应:\n{json.dumps(response, indent=2)}\n")

            if "result" in response:
                print("✅ MCP Server stdio 通信正常！\n")
                server_info = response["result"].get("serverInfo", {})
                print(f"服务器信息:")
                print(f"  名称: {server_info.get('name', 'N/A')}")
                print(f"  版本: {server_info.get('version', 'N/A')}")
                success = True
            else:
                print("❌ 响应中没有 result 字段\n")
                success = False
        else:
            print("❌ 5秒内没有收到响应\n")
            success = False

            # 检查 stderr
            print("📋 检查错误输出:\n")
            stderr_lines = []
            while True:
                try:
                    line = proc.stderr.readline()
                    if not line:
                        break
                    stderr_lines.append(line)
                    if len(stderr_lines) >= 20:
                        break
                except:
                    break

            if stderr_lines:
                print("".join(stderr_lines))
            else:
                print("(无错误输出)")

    except Exception as e:
        print(f"❌ 测试失败: {e}\n")
        success = False

    finally:
        # 终止进程
        proc.terminate()
        try:
            proc.wait(timeout=2)
        except:
            proc.kill()

    return success

if __name__ == "__main__":
    success = test_stdio()
    sys.exit(0 if success else 1)
