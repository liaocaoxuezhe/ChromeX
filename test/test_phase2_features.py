"""
测试第二阶段新功能
验证智能滚动、键盘快捷键、文本查找、批量爬取
"""

import asyncio
import sys
import os

# 添加项目路径到 sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from server.ws_manager import WSManager


async def test_scroll_until():
    """测试智能滚动"""
    print("\n=== 测试 1: 智能滚动 (scroll_until) ===")

    ws = WSManager()
    await ws.start()

    print("等待 Chrome Extension 连接...")
    connected = await ws.wait_for_connection(timeout=10.0)
    if not connected:
        print("❌ 连接超时")
        return False

    print("✅ 已连接")

    try:
        # 测试滚动到底部
        result = await ws.send_command("scroll_until", {
            "condition": "no_more_content",
            "max_scrolls": 10,
            "scroll_delay": 300
        })

        scrolled = result.get("scrolled", 0)
        reached_end = result.get("reached_condition", False)

        print(f"滚动次数: {scrolled}")
        print(f"是否到底: {reached_end}")

        return scrolled > 0

    except Exception as e:
        print(f"❌ 测试失败: {e}")
        return False


async def test_send_keys():
    """测试键盘快捷键"""
    print("\n=== 测试 2: 键盘快捷键 (send_keys) ===")

    ws = WSManager()
    await ws.start()

    connected = await ws.wait_for_connection(timeout=10.0)
    if not connected:
        print("❌ 连接超时")
        return False

    print("✅ 已连接")

    try:
        # 测试发送 Ctrl+A (全选)
        result = await ws.send_command("send_keys", {
            "keys": "Control+A"
        })

        sent = result.get("sent", False)
        print(f"发送结果: {sent}")
        print(f"按键组合: {result.get('keys', 'N/A')}")

        return sent

    except Exception as e:
        print(f"❌ 测试失败: {e}")
        return False


async def test_find_text():
    """测试文本查找"""
    print("\n=== 测试 3: 文本查找 (find_text) ===")

    ws = WSManager()
    await ws.start()

    connected = await ws.wait_for_connection(timeout=10.0)
    if not connected:
        print("❌ 连接超时")
        return False

    print("✅ 已连接")

    try:
        # 测试查找页面上的文本
        result = await ws.send_command("find_text", {
            "text": "搜索",
            "click": False
        })

        found = result.get("found", False)
        total = result.get("total_found", 0)

        print(f"是否找到: {found}")
        print(f"找到数量: {total}")

        if found:
            elements = result.get("elements", [])
            if elements:
                print(f"第一个元素: {elements[0]}")

        return found

    except Exception as e:
        print(f"❌ 测试失败: {e}")
        return False


async def test_scrape_with_scroll():
    """测试批量爬取"""
    print("\n=== 测试 4: 批量爬取 (scrape_with_scroll) ===")

    ws = WSManager()
    await ws.start()

    connected = await ws.wait_for_connection(timeout=10.0)
    if not connected:
        print("❌ 连接超时")
        return False

    print("✅ 已连接")

    try:
        # 测试批量提取链接
        extract_script = """
        Array.from(document.querySelectorAll('a')).map(a => ({
            text: a.textContent.trim().substring(0, 50),
            href: a.href
        })).filter(item => item.href && item.text)
        """

        result = await ws.send_command("scrape_with_scroll", {
            "extract_script": extract_script,
            "max_items": 20,
            "batch_size": 5,
            "scroll_delay": 300,
            "dedupe_by": "href"
        })

        items = result.get("items", [])
        total = result.get("total", 0)
        scrolls = result.get("scrolls", 0)

        print(f"提取数据: {total} 条")
        print(f"滚动次数: {scrolls} 次")

        if items:
            print(f"\n前 3 条数据:")
            for i, item in enumerate(items[:3], 1):
                print(f"{i}. {item.get('text', 'N/A')[:30]} -> {item.get('href', 'N/A')[:50]}")

        return total > 0

    except Exception as e:
        print(f"❌ 测试失败: {e}")
        return False


async def test_xiaohongshu_scrape():
    """测试小红书爬取（完整场景）"""
    print("\n=== 测试 5: 小红书笔记爬取 (完整流程) ===")

    ws = WSManager()
    await ws.start()

    connected = await ws.wait_for_connection(timeout=10.0)
    if not connected:
        print("❌ 连接超时")
        return False

    print("✅ 已连接")

    try:
        # 假设已经在小红书页面上
        extract_script = """
        Array.from(document.querySelectorAll('.note-item, [class*="note"], [class*="feed-card"]')).map(note => {
            const titleEl = note.querySelector('.title, [class*="title"]');
            const authorEl = note.querySelector('.author, [class*="author"]');
            const likesEl = note.querySelector('[class*="like"], [class*="interaction"]');
            const linkEl = note.closest('a') || note.querySelector('a');

            return {
                title: titleEl?.textContent?.trim() || null,
                author: authorEl?.textContent?.trim() || null,
                likes: likesEl?.textContent?.trim() || null,
                link: linkEl?.href || null
            };
        }).filter(item => item.link)
        """

        result = await ws.send_command("scrape_with_scroll", {
            "extract_script": extract_script,
            "max_items": 50,
            "batch_size": 10,
            "scroll_delay": 500,
            "dedupe_by": "link"
        })

        items = result.get("items", [])
        total = result.get("total", 0)
        scrolls = result.get("scrolls", 0)

        print(f"提取笔记: {total} 条")
        print(f"滚动次数: {scrolls} 次")
        print(f"是否到底: {result.get('reached_end', False)}")

        if items:
            print(f"\n示例笔记:")
            for i, item in enumerate(items[:2], 1):
                print(f"{i}. {item.get('title', 'N/A')}")
                print(f"   作者: {item.get('author', 'N/A')}")
                print(f"   点赞: {item.get('likes', 'N/A')}")

        return total > 0

    except Exception as e:
        print(f"❌ 测试失败: {e}")
        return False


async def run_all_tests():
    """运行所有测试"""
    print("=" * 60)
    print("Link2Chrome 第二阶段功能测试")
    print("=" * 60)

    print("\n⚠️  请确保:")
    print("1. Chrome Extension 已连接")
    print("2. 已打开一个网页（建议：百度、小红书等）")
    input("\n按 Enter 继续...")

    results = []

    # 运行测试
    results.append(("智能滚动", await test_scroll_until()))
    results.append(("键盘快捷键", await test_send_keys()))
    results.append(("文本查找", await test_find_text()))
    results.append(("批量爬取", await test_scrape_with_scroll()))

    # 可选：小红书测试（需要先导航到小红书）
    print("\n是否测试小红书爬取？(需要先导航到小红书页面)")
    test_xhs = input("输入 y 继续，其他键跳过: ").lower() == 'y'
    if test_xhs:
        results.append(("小红书爬取", await test_xiaohongshu_scrape()))

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
