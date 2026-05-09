"""
测试第一阶段新功能
验证 JavaScript 执行、智能等待、Debugger 管理
"""

import asyncio
import sys
import os

# 添加项目路径到 sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from server.ws_manager import WSManager
from server.debugger_manager import DebuggerManager
from server.retry_manager import VisionFallbackHandler
from server.script_library import get_script


async def test_execute_script():
    """测试 JavaScript 脚本执行"""
    print("\n=== 测试 1: JavaScript 脚本执行 ===")

    ws = WSManager()
    await ws.start()

    # 等待连接
    print("等待 Chrome Extension 连接...")
    connected = await ws.wait_for_connection(timeout=10.0)
    if not connected:
        print("❌ 连接超时")
        return False

    print("✅ 已连接")

    try:
        # 测试简单脚本
        result = await ws.send_command("execute_script", {
            "script": "JSON.stringify({title: document.title, url: window.location.href})",
            "awaitPromise": False
        })

        print(f"脚本结果: {result}")
        return result.get("success", False)

    except Exception as e:
        print(f"❌ 测试失败: {e}")
        return False


async def test_wait_for_visible():
    """测试元素可见性等待"""
    print("\n=== 测试 2: 元素可见性等待 ===")

    ws = WSManager()
    await ws.start()

    connected = await ws.wait_for_connection(timeout=10.0)
    if not connected:
        print("❌ 连接超时")
        return False

    print("✅ 已连接")

    try:
        # 等待 body 元素可见
        result = await ws.send_command("wait_for_condition", {
            "condition_type": "visible",
            "selector": "body",
            "timeout": 5000
        })

        print(f"等待结果: {result}")
        return result.get("found", False)

    except Exception as e:
        print(f"❌ 测试失败: {e}")
        return False


async def test_detach_debugger():
    """测试 Debugger 管理"""
    print("\n=== 测试 3: Debugger 管理 ===")

    ws = WSManager()
    await ws.start()

    connected = await ws.wait_for_connection(timeout=10.0)
    if not connected:
        print("❌ 连接超时")
        return False

    print("✅ 已连接")

    try:
        debugger_mgr = DebuggerManager(ws_manager=ws)

        # 测试 detach
        success = await debugger_mgr.detach_debugger()
        print(f"Detach 结果: {success}")

        return True

    except Exception as e:
        print(f"❌ 测试失败: {e}")
        return False


async def test_script_library():
    """测试脚本库"""
    print("\n=== 测试 4: 预定义脚本库 ===")

    try:
        # 测试表格提取脚本
        table_script = get_script("extract_table", selector="table")
        print(f"✅ 表格提取脚本: {table_script.name}")

        # 测试链接提取脚本
        link_script = get_script("extract_links", selector="a[href]")
        print(f"✅ 链接提取脚本: {link_script.name}")

        # 测试小红书脚本
        xhs_script = get_script("xiaohongshu_extract_notes")
        print(f"✅ 小红书脚本: {xhs_script.name}")

        return True

    except Exception as e:
        print(f"❌ 测试失败: {e}")
        return False


async def test_vision_fallback():
    """测试 Vision 降级逻辑"""
    print("\n=== 测试 5: Vision 降级推断 ===")

    try:
        ws = WSManager()
        fallback = VisionFallbackHandler(ws)

        # 测试选择器推断
        test_cases = [
            ("点击搜索框", "input[type='search']"),
            ("点击登录按钮", "button[type='submit']"),
            ("点击'确定'", "button:has-text('确定')"),
        ]

        for instruction, expected_selector in test_cases:
            selector = fallback._infer_selector(instruction)
            if selector:
                print(f"✅ '{instruction}' -> {selector}")
            else:
                print(f"❌ '{instruction}' -> 无法推断")

        return True

    except Exception as e:
        print(f"❌ 测试失败: {e}")
        return False


async def run_all_tests():
    """运行所有测试"""
    print("=" * 60)
    print("Link2Chrome 第一阶段功能测试")
    print("=" * 60)

    results = []

    # 测试 4: 脚本库(不需要连接)
    results.append(("脚本库", await test_script_library()))

    # 测试 5: Vision 降级(不需要连接)
    results.append(("Vision 降级", await test_vision_fallback()))

    # 以下测试需要 Chrome Extension 连接
    print("\n⚠️  以下测试需要 Chrome Extension 已连接并打开一个网页")
    input("按 Enter 继续...")

    results.append(("JavaScript 执行", await test_execute_script()))
    results.append(("元素可见性等待", await test_wait_for_visible()))
    results.append(("Debugger 管理", await test_detach_debugger()))

    # 输出测试结果
    print("\n" + "=" * 60)
    print("测试结果汇总")
    print("=" * 60)

    for name, success in results:
        status = "✅ 通过" if success else "❌ 失败"
        print(f"{name}: {status}")

    total = len(results)
    passed = sum(1 for _, s in results if s)
    print(f"\n总计: {passed}/{total} 通过")


if __name__ == "__main__":
    asyncio.run(run_all_tests())
