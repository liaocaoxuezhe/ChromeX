"""快速验证 Phase 2 基础功能"""
import asyncio
import sys
import os
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from server.ws_manager import WSManager

async def quick_test():
    print("=== Phase 2 快速测试 ===\n")

    ws = WSManager()
    await ws.start()

    print("⏳ 等待连接...")
    connected = await ws.wait_for_connection(timeout=10.0)

    if not connected:
        print("❌ 连接失败，请检查：")
        print("   1. Chrome Extension 是否已重新加载")
        print("   2. 是否已打开至少一个网页")
        return False

    print("✅ 连接成功\n")

    # 测试1：智能滚动
    print("测试 1/4: browser_scroll_until")
    try:
        result = await ws.send_command("scroll_until", {
            "condition": "no_more_content",
            "max_scrolls": 3,
            "scroll_delay": 300
        })
        print(f"   ✅ 滚动 {result.get('scrolled', 0)} 次")
    except Exception as e:
        print(f"   ❌ 失败: {e}")
        return False

    # 测试2：键盘快捷键
    print("测试 2/4: browser_send_keys")
    try:
        result = await ws.send_command("send_keys", {"keys": "Escape"})
        print(f"   ✅ 发送成功")
    except Exception as e:
        print(f"   ❌ 失败: {e}")
        return False

    # 测试3：文本查找
    print("测试 3/4: browser_find_text")
    try:
        result = await ws.send_command("find_text", {
            "text": "搜索",
            "click": False
        })
        found = result.get("found", False)
        total = result.get("total_found", 0)
        print(f"   ✅ 找到 {total} 个匹配")
    except Exception as e:
        print(f"   ❌ 失败: {e}")
        return False

    # 测试4：批量爬取（提取链接）
    print("测试 4/4: browser_scrape_with_scroll")
    try:
        extract_script = """
        Array.from(document.querySelectorAll('a')).slice(0, 5).map(a => ({
            text: a.textContent.trim().substring(0, 30),
            href: a.href
        })).filter(item => item.href)
        """
        result = await ws.send_command("scrape_with_scroll", {
            "extract_script": extract_script,
            "max_items": 5,
            "scroll_delay": 300
        })
        total = result.get("total", 0)
        print(f"   ✅ 提取 {total} 条数据")
    except Exception as e:
        print(f"   ❌ 失败: {e}")
        return False

    print("\n🎉 所有测试通过！Phase 2 功能正常")
    return True

if __name__ == "__main__":
    success = asyncio.run(quick_test())
    sys.exit(0 if success else 1)
