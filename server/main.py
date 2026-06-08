"""
Link2Chrome MCP Server
通过 StdIO 提供 Browser Tools 给 Claude Code 使用
Tool 定义集中在 server/tool_descriptions.py 中维护
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import sys
import time

# 确保项目根目录在 Python 路径中（解决模块导入问题）
_current_file = os.path.abspath(__file__)
_project_root = os.path.dirname(os.path.dirname(_current_file))
if _project_root not in sys.path:
    sys.path.insert(0, _project_root)

from dotenv import load_dotenv
from markdownify import markdownify as md
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import TextContent, ImageContent, Tool

from server.hub_client import HubClient
from server.dom_compressor import compress_dom
from server.logger import setup_logging, get_logger, get_operation_logger
from server.debugger_manager import DebuggerManager
from server.script_library import get_script
from server.tool_descriptions import TOOL_DEFINITIONS
from server.modes.cua import CuaController
from server.modes.playwright_plane import PlaywrightPlane

# 加载环境变量
load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))

# 设置日志系统
log_level = os.getenv("LOG_LEVEL", "INFO")
console_enabled = os.getenv("LOG_CONSOLE", "false").lower() in ("true", "1", "yes", "on")
setup_logging(log_level=log_level, console_enabled=console_enabled)
logger = get_logger()

# 操作日志记录器
op_logger = get_operation_logger()

# 全局实例
ws_manager = HubClient()
debugger_manager = DebuggerManager(ws_manager=ws_manager)
cua_controller = CuaController(ws_manager)
playwright_plane = PlaywrightPlane()

app = Server("local-browser")

# ==================== Legacy Alias Mapping ====================
# Old tool names silently redirect to new unified names for backward compatibility.
LEGACY_ALIASES = {
    # Legacy browser_* tools
    "browser_action_navigate": "browser_navigate",
    "browser_go_back": "browser_navigate",
    "browser_manage_tab": "browser_tab",
    "browser_get_tabs": "browser_tabs_list",
    "browser_get_state": "browser_dom_overview",
    "browser_get_screenshot": "browser_screenshot",
    "browser_click": "action_click",
    "browser_type": "action_fill",
    "browser_type_at_coord": "action_fill",
    "browser_drag": "action_drag",
    "browser_action_scroll": "action_scroll",
    "browser_send_keys": "action_press_key",
    "browser_find_text": "browser_dom_search",
    "browser_extract_content": "browser_dom_get_text",
    "browser_execute_script": "script_evaluate",
    "browser_scroll_until": "action_scroll",
    "browser_wait": "browser_dom_overview",
    "browser_wait_for_condition": "script_evaluate",
    "browser_detach_debugger": "browser_diagnose",
    # Legacy dom_* / action_* tools
    "dom_overview": "browser_dom_overview",
    "dom_query": "browser_dom_query",
    "dom_search": "browser_dom_search",
    "dom_structured_data": "browser_dom_query",
    "dom_element_detail": "browser_dom_query",
    "dom_wait_for": "script_evaluate",
    "action_type": "action_fill",
    "action_select": "action_click",
    "action_fill_form": "playwright_run",
    # Legacy network / console tools
    "network_capture": "network_check",
    "network_list": "network_check",
    "network_query": "network_check",
    "network_fetch": "network_check",
    "network_replay": "network_check",
    "console_capture": "console_check",
    "console_list": "console_check",
    "console_get": "console_check",
    "console_clear": "console_check",
    # Plan C namespace aliases
    "browser.dom.overview": "browser_dom_overview",
    "browser.dom.query": "browser_dom_query",
    "browser.dom.search": "browser_dom_search",
    "browser.dom.click": "action_click",
    "browser.dom.type": "action_fill",
    "browser.dom.scroll": "action_scroll",
    "browser.cua.screenshot": "browser_screenshot",
    "browser.cua.click": "action_click",
    "browser.cua.double_click": "action_double_click",
    "browser.cua.move": "action_hover",
    "browser.cua.type": "action_fill",
    "browser.cua.key": "action_press_key",
    "browser.cua.scroll": "action_scroll",
    "browser.cua.drag": "action_drag",
    "browser.pw.start": "playwright_run",
    "browser.pw.endpoint": "playwright_run",
    "browser.pw.stop": "playwright_run",
    "browser.pw.goto": "browser_navigate",
    "browser.pw.click": "action_click",
    "browser.pw.fill": "action_fill",
    "browser.pw.eval": "script_evaluate",
    "browser.pw.screenshot": "browser_screenshot",
    "browser_tab_info": "browser_tab",
    "browser_tab_switch": "browser_tab",
    "browser_tab_new": "browser_tab",
}


def _convert_legacy_params(old_name: str, args: dict) -> dict:
    """Convert legacy tool parameters to new unified parameter schemas."""
    args = dict(args)  # shallow copy

    if old_name == "browser_go_back":
        return {"action": "forward" if args.get("forward") else "back"}

    if old_name in ("browser_type", "browser.dom.type", "browser.cua.type", "action_type"):
        if "text" in args:
            args["value"] = args.pop("text")
        if "selector" in args:
            args["target"] = {"selector": args.pop("selector")}
        args.setdefault("clearFirst", True)
        return args

    if old_name == "browser_type_at_coord":
        x = args.pop("x", 0)
        y = args.pop("y", 0)
        args["target"] = {"x": x, "y": y}
        if "text" in args:
            args["value"] = args.pop("text")
        args.setdefault("clearFirst", True)
        return args

    if old_name == "browser_click":
        if "selector" in args:
            args["target"] = {"selector": args.pop("selector")}
        elif "x" in args and "y" in args:
            args["target"] = {"x": args.pop("x"), "y": args.pop("y")}
        return args

    if old_name == "browser_send_keys":
        args["key"] = args.pop("keys", "")
        if "selector" in args:
            args["target"] = {"selector": args.pop("selector")}
        return args

    if old_name == "browser_find_text":
        args["query"] = args.pop("text", "")
        return args

    if old_name == "browser_execute_script":
        args["expression"] = args.pop("script", "")
        return args

    if old_name in ("browser_tab_new", "browser_tab_switch", "browser_tab_info"):
        if old_name == "browser_tab_new":
            args["action"] = "new"
        elif old_name == "browser_tab_switch":
            args["action"] = "switch"
        elif old_name == "browser_tab_info":
            args["action"] = "info"
        return args

    if old_name == "browser_action_navigate":
        args.setdefault("action", "goto")
        return args

    if old_name == "browser_get_state":
        return {"include": []}

    if old_name in ("browser_scroll_until", "browser_manage_tab", "browser_extract_content",
                    "browser_wait", "browser_wait_for_condition", "browser_detach_debugger"):
        # Best-effort pass-through; new handlers may ignore incompatible params
        return args

    return args


# ==================== Tool 定义（从 tool_descriptions.py 加载） ====================

@app.list_tools()
async def list_tools() -> list[Tool]:
    return [
        Tool(
            name=td["name"],
            description=td["description"],
            inputSchema=td["inputSchema"],
        )
        for td in TOOL_DEFINITIONS
    ]


# ==================== Tool 实现 ====================

@app.call_tool()
async def call_tool(name: str, arguments: dict) -> list[TextContent | ImageContent]:
    logger.info(f"调用工具: {name}, 参数: {arguments}")

    # Apply legacy alias mapping
    if name in LEGACY_ALIASES:
        old_name = name
        name = LEGACY_ALIASES[name]
        arguments = _convert_legacy_params(old_name, arguments)
        logger.info(f"Legacy alias: {old_name} -> {name}, converted args: {arguments}")

    try:
        if name == "browser_diagnose":
            result = await tool_diagnose(arguments)
            result_summary = _extract_result_summary(result)
            op_logger.log_operation(name, arguments, result_summary=result_summary)
            return result

        async with ws_manager.operation(name):
            # New unified 26-tool routing
            if name in {
                "browser_navigate",
                "browser_tab",
                "browser_session",
                "browser_tabs_list",
                "browser_dom_overview",
                "browser_dom_query",
                "browser_dom_search",
                "browser_dom_get_text",
                "browser_dom_diff",
                "browser_screenshot",
                "action_click",
                "action_double_click",
                "action_hover",
                "action_scroll",
                "action_drag",
                "action_fill",
                "action_press_key",
                "upload_file",
                "handle_dialog",
                "playwright_run",
                "script_evaluate",
                "save_as_pdf",
                "console_check",
                "network_check",
                "browser_scrape_with_scroll",
            }:
                result = await tool_agent_first(name, arguments)
            else:
                result = _json_content({"ok": False, "error": f"未知工具: {name}"})

        # 记录成功操作
        result_summary = _extract_result_summary(result)
        op_logger.log_operation(name, arguments, result_summary=result_summary)
        return result

    except ConnectionError as e:
        error_msg = f"浏览器未连接: {e}"
        logger.error(f"Tool {name} 连接错误: {e}")
        op_logger.log_operation(name, arguments, error=error_msg)
        return _json_content({"ok": False, "error": error_msg})
    except TimeoutError as e:
        error_msg = f"操作超时: {e}"
        logger.error(f"Tool {name} 超时: {e}")
        op_logger.log_operation(name, arguments, error=error_msg)
        return _json_content({"ok": False, "error": error_msg})
    except Exception as e:
        error_msg = f"执行出错: {e}"
        logger.exception(f"Tool {name} 执行异常")
        op_logger.log_operation(name, arguments, error=error_msg)
        return _json_content({"ok": False, "error": error_msg})


def _extract_result_summary(result: list) -> str:
    """从结果中提取摘要信息"""
    if not result:
        return "无返回结果"

    summaries = []
    for item in result:
        if hasattr(item, 'text'):
            text = item.text
            # 只取第一行，限制长度
            first_line = text.split('\n')[0][:100]
            summaries.append(first_line)
        elif hasattr(item, 'type') and item.type == 'image':
            summaries.append('[图片]')

    return ' | '.join(summaries) if summaries else '执行完成'


def _json_content(payload: object) -> list[TextContent]:
    """Return a compact JSON tool response, matching the PRD's agent-first contract."""
    return [TextContent(type="text", text=json.dumps(payload, ensure_ascii=False, indent=2))]


# ==================== Legacy Tool Implementations (kept for Phase 1) ====================

async def tool_get_state(args: dict) -> list[TextContent | ImageContent]:
    """获取浏览器状态"""
    include_dom = args.get("include_dom", True)

    results: list[TextContent | ImageContent] = []

    # 获取页面基本信息
    info = await ws_manager.send_command("get_info")
    info_text = (
        f"URL: {info.get('url', 'N/A')}\n"
        f"标题: {info.get('title', 'N/A')}\n"
    )
    viewport = info.get("viewport", {})
    if viewport:
        info_text += (
            f"视口: {viewport.get('innerWidth', '?')}x{viewport.get('innerHeight', '?')}\n"
            f"DPR: {viewport.get('devicePixelRatio', '?')}\n"
            f"滚动位置: ({viewport.get('scrollX', 0)}, {viewport.get('scrollY', 0)})\n"
            f"页面尺寸: {viewport.get('documentWidth', '?')}x{viewport.get('documentHeight', '?')}"
        )

    results.append(TextContent(type="text", text=info_text))

    # DOM 树
    if include_dom:
        dom_data = await ws_manager.send_command("get_dom")
        raw_dom = dom_data.get("dom", "{}")
        compressed = compress_dom(raw_dom)
        results.append(
            TextContent(type="text", text=f"DOM 结构:\n{compressed}")
        )

    return results


async def tool_get_screenshot(args: dict) -> list[TextContent | ImageContent]:
    """获取当前页面截图"""
    screenshot_data = await ws_manager.send_command("screenshot")
    image_b64 = screenshot_data.get("image", "")

    if not image_b64:
        return [TextContent(type="text", text="无法获取截图")]

    return [
        ImageContent(
            type="image",
            data=image_b64,
            mimeType="image/jpeg",
        )
    ]


async def tool_action_navigate(args: dict) -> list[TextContent | ImageContent]:
    """导航到 URL"""
    url = args["url"]

    # 补全协议头
    if not url.startswith(("http://", "https://", "chrome://")):
        url = "https://" + url

    result = await ws_manager.send_command("navigate", {"url": url})
    status = result.get("status", "unknown")
    return [TextContent(type="text", text=f"已导航到: {url} (状态: {status})")]


async def tool_action_scroll(args: dict) -> list[TextContent | ImageContent]:
    """滚动页面"""
    direction = args["direction"]
    amount = args.get("amount", 500)

    delta_y = -amount if direction == "up" else amount

    # 获取 viewport 中心作为滚动基点
    info = await ws_manager.send_command("get_info")
    viewport = info.get("viewport", {})
    center_x = viewport.get("innerWidth", 1280) // 2
    center_y = viewport.get("innerHeight", 720) // 2

    await ws_manager.send_command(
        "scroll",
        {"x": center_x, "y": center_y, "deltaX": 0, "deltaY": delta_y},
    )

    return [
        TextContent(
            type="text",
            text=f"已向{('上' if direction == 'up' else '下')}滚动 {amount} 像素",
        )
    ]


async def tool_manage_tab(args: dict) -> list[TextContent | ImageContent]:
    """管理标签页"""
    action = args["action"]
    params = {"action": action}

    if "tab_index" in args:
        params["tab_index"] = args["tab_index"]
    if "url" in args:
        params["url"] = args["url"]

    result = await ws_manager.send_command("tab_manage", params)

    if action == "list":
        tabs = result.get("tabs", [])
        lines = [f"共 {len(tabs)} 个标签页:"]
        for tab in tabs:
            marker = "→ " if tab.get("active") else "  "
            lines.append(
                f"{marker}[{tab['index']}] {tab.get('title', 'N/A')[:50]} - {tab.get('url', '')[:80]}"
            )
        return [TextContent(type="text", text="\n".join(lines))]

    if action == "new":
        return [TextContent(type="text", text=f"已创建新标签页 (ID: {result.get('tabId')})")]
    if action == "close":
        return [TextContent(type="text", text="已关闭标签页")]
    if action == "switch":
        return [
            TextContent(
                type="text",
                text=f"已切换到标签页 [{args.get('tab_index')}]",
            )
        ]

    return [TextContent(type="text", text=f"标签操作完成: {result}")]


async def tool_click(args: dict) -> list[TextContent | ImageContent]:
    """直接点击坐标或 CSS 选择器"""
    selector = args.get("selector")
    button = args.get("button", "left")
    click_count = args.get("clickCount", 1)

    if selector:
        # Extension 端的 cmdClick 已支持 selector，直接传过去
        result = await ws_manager.send_command(
            "click",
            {"selector": selector, "button": button, "clickCount": click_count},
        )
        clicked_x = result.get("x", "?")
        clicked_y = result.get("y", "?")
        return [
            TextContent(
                type="text",
                text=f"已点击选择器 `{selector}` → 坐标 ({clicked_x}, {clicked_y})",
            )
        ]

    # 直接坐标点击
    x = args.get("x")
    y = args.get("y")
    if x is None or y is None:
        return [TextContent(type="text", text="需要提供 x/y 坐标或 selector")]

    await ws_manager.send_command(
        "click", {"x": x, "y": y, "button": button, "clickCount": click_count}
    )
    return [TextContent(type="text", text=f"已点击坐标 ({x}, {y})")]


async def tool_type(args: dict) -> list[TextContent | ImageContent]:
    """直接输入文本"""
    text = args["text"]
    selector = args.get("selector")
    clear_first = args.get("clearFirst", False)

    params = {"text": text, "clearFirst": clear_first}
    if selector:
        params["selector"] = selector

    await ws_manager.send_command("type", params)

    result_text = f"已输入: {text[:50]}{'...' if len(text) > 50 else ''}"
    if selector:
        result_text = f"在 `{selector}` 中" + result_text

    return [TextContent(type="text", text=result_text)]


async def tool_type_at_coord(args: dict) -> list[TextContent | ImageContent]:
    """在指定坐标处输入文本（先点击再输入）"""
    x = args["x"]
    y = args["y"]
    text = args["text"]
    clear_first = args.get("clearFirst", False)

    params = {
        "text": text,
        "x": x,
        "y": y,
        "clearFirst": clear_first,
    }

    await ws_manager.send_command("type", params)

    result_text = f"已在坐标 ({x}, {y}) 输入: {text[:50]}{'...' if len(text) > 50 else ''}"

    return [TextContent(type="text", text=result_text)]


async def tool_get_tabs(args: dict) -> list[TextContent | ImageContent]:
    """获取所有标签页信息"""
    result = await ws_manager.send_command("get_all_tabs")
    windows = result.get("windows", {})
    total = result.get("totalTabs", 0)

    lines = [f"共 {total} 个标签页，{len(windows)} 个窗口:\n"]
    for wid, tabs in windows.items():
        lines.append(f"--- 窗口 {wid} ({len(tabs)} 个标签) ---")
        for tab in tabs:
            marker = ">> " if tab.get("active") else "   "
            pin = "[pin] " if tab.get("pinned") else ""
            lines.append(
                f"{marker}{pin}[{tab['index']}] {tab.get('title', 'N/A')[:60]}"
            )
            lines.append(f"       {tab.get('url', '')[:100]}")
        lines.append("")

    return [TextContent(type="text", text="\n".join(lines))]


async def tool_go_back(args: dict) -> list[TextContent | ImageContent]:
    """浏览器后退/前进"""
    forward = args.get("forward", False)
    command = "go_forward" if forward else "go_back"
    result = await ws_manager.send_command(command)
    status = result.get("status", "unknown")
    direction = "前进" if forward else "后退"
    return [TextContent(type="text", text=f"已{direction} (状态: {status})")]


async def tool_drag(args: dict) -> list[TextContent | ImageContent]:
    """拖拽操作"""
    params = {
        "startX": args["startX"],
        "startY": args["startY"],
        "endX": args["endX"],
        "endY": args["endY"],
    }
    if "duration" in args:
        params["duration"] = args["duration"]

    result = await ws_manager.send_command("drag", params)
    return [
        TextContent(
            type="text",
            text=(
                f"已拖拽: ({params['startX']}, {params['startY']}) "
                f"→ ({params['endX']}, {params['endY']})"
            ),
        )
    ]


async def tool_wait(args: dict) -> list[TextContent | ImageContent]:
    """等待条件"""
    if "condition" in args:
        return _json_content(await ws_manager.send_command("agent_browser_wait", args))

    params = {}
    if "seconds" in args:
        params["seconds"] = args["seconds"]
    if "selector" in args:
        params["selector"] = args["selector"]
    if "text" in args:
        params["text"] = args["text"]
    if "timeout" in args:
        params["timeout"] = args["timeout"]

    result = await ws_manager.send_command("wait", params)
    wait_type = result.get("type", "unknown")
    found = result.get("found")

    if wait_type == "time":
        return [TextContent(type="text", text=f"已等待 {result.get('seconds')} 秒")]
    elif wait_type == "selector":
        status = "已出现" if found else "等待超时未出现"
        return [
            TextContent(
                type="text",
                text=f"选择器 `{result.get('selector')}` {status}",
            )
        ]
    elif wait_type == "text":
        status = "已出现" if found else "等待超时未出现"
        return [
            TextContent(
                type="text",
                text=f"文本 \"{result.get('text')}\" {status}",
            )
        ]
    return [TextContent(type="text", text=f"等待完成: {result}")]


async def tool_extract_content(args: dict) -> list[TextContent | ImageContent]:
    """使用 Readability 提取页面内容并转为 Markdown"""
    save_path = args.get("save_path")

    # 1. 获取页面信息
    info = await ws_manager.send_command("get_info")
    page_url = info.get("url", "")
    page_title = info.get("title", "")

    # 2. 调用 Extension 端的 Readability 提取
    extracted = await ws_manager.send_command("extract_content", {})

    if "error" in extracted:
        return [TextContent(type="text", text=f"提取失败: {extracted['error']}")]

    title = extracted.get("title", page_title)
    byline = extracted.get("byline", "")
    content_html = extracted.get("content", "")
    excerpt = extracted.get("excerpt", "")

    if not content_html:
        return [TextContent(type="text", text="页面内容为空，Readability 无法提取有效正文。")]

    # 3. HTML → Markdown (服务端转换)
    content_md = md(
        content_html,
        heading_style="atx",
        bullets="-",
        strip=["img"],
    )

    # 清理多余空行
    content_md = re.sub(r"\n{3,}", "\n\n", content_md).strip()

    # 4. 组装最终 Markdown
    parts = []
    parts.append(f"# {title}\n")
    if byline:
        parts.append(f"> {byline}\n")
    if excerpt:
        parts.append(f"*{excerpt}*\n")
    parts.append(f"来源: {page_url}\n")
    parts.append("---\n")
    parts.append(content_md)

    markdown_text = "\n".join(parts)

    # 5. 可选保存文件
    if save_path:
        # 确保目录存在
        save_dir = os.path.dirname(os.path.abspath(save_path))
        os.makedirs(save_dir, exist_ok=True)

        with open(save_path, "w", encoding="utf-8") as f:
            f.write(markdown_text)

        return [
            TextContent(
                type="text",
                text=f"已保存到: {save_path}\n标题: {title}\n字数: {len(content_md)}",
            )
        ]

    # 返回 Markdown 内容
    return [TextContent(type="text", text=markdown_text)]


async def tool_diagnose(args: dict) -> list[TextContent | ImageContent]:
    """诊断连接状态"""
    lines = ["=== Link2Chrome 诊断 ===", ""]
    hub_status = None

    # Hub / WS 连接状态
    try:
        hub_status = await ws_manager.send_command("__hub_status__", timeout=3.0)
        lines.append("Browser Hub: 已连接")
        lines.append(f"Hub ID: {hub_status.get('hub_id', '未知')}")
        lines.append(f"Adapter 连接数: {hub_status.get('adapter_connections', '未知')}")
        lines.append(f"操作队列: {'忙碌' if hub_status.get('queue_locked') else '空闲'}")
        if hub_status.get("lease_name"):
            lines.append(f"当前 lease: {hub_status.get('lease_name')}")
        if hub_status.get("lease_age_seconds") is not None:
            lines.append(f"lease 持续: {hub_status.get('lease_age_seconds')}s")
        lines.append(
            f"WebSocket 连接: {'已连接' if hub_status.get('extension_connected') else '未连接'}"
        )
        if hub_status.get("extension_startup_error"):
            lines.append(f"Extension WS 启动错误: {hub_status.get('extension_startup_error')}")
    except Exception as e:
        lines.append(f"Browser Hub: 未连接 ({e})")
        lines.append(f"WebSocket 连接: {'已连接' if ws_manager.is_connected else '未连接'}")

    if hub_status and hub_status.get("queue_locked"):
        lines.append("")
        lines.append("诊断提示: Browser Hub 操作队列忙碌，已跳过需要排队的 Extension 查询。")
        return [TextContent(type="text", text="\n".join(lines))]

    # Extension 版本
    try:
        version_info = await ws_manager.send_command("ping_version")
        lines.append(f"Extension 版本: {version_info.get('version', '未知')}")
        lines.append(f"targetTabId: {version_info.get('targetTabId', 'None')}")
        lines.append(f"attachedTabId: {version_info.get('attachedTabId', 'None')}")
        lines.append(f"wsConnected: {version_info.get('wsConnected', '未知')}")
    except Exception as e:
        lines.append(f"Extension 通信失败: {e}")

    # 获取所有标签页信息
    lines.append("")
    lines.append("--- 所有标签页 ---")
    try:
        all_tabs = await ws_manager.send_command("get_all_tabs")
        windows = all_tabs.get("windows", {})
        for window_id, tabs in windows.items():
            lines.append(f"窗口 {window_id}:")
            for tab in tabs:
                debuggable = "可调试" if tab.get("debugable") else "不可调试"
                target = " [TARGET]" if tab.get("isTarget") else ""
                lines.append(f"  [{tab.get('index')}] ID={tab.get('id')}, {debuggable}{target}")
                lines.append(f"      URL: {tab.get('url', 'N/A')[:60]}...")
    except Exception as e:
        lines.append(f"获取标签页信息失败: {e}")

    return [TextContent(type="text", text="\n".join(lines))]


# ==================== 第一阶段新增 Tool 实现 ====================

async def tool_execute_script(args: dict) -> list[TextContent]:
    """执行 JavaScript 脚本"""
    script = args["script"]
    await_promise = args.get("awaitPromise", False)
    timeout = args.get("timeout", 60)

    params = {
        "script": script,
        "awaitPromise": await_promise,
        "timeout": timeout * 1000  # 转换为毫秒
    }

    result = await ws_manager.send_command("execute_script", params)

    if result.get("success"):
        return [
            TextContent(
                type="text",
                text=f"脚本执行成功\n结果:\n{json.dumps(result.get('result'), ensure_ascii=False, indent=2)}"
            )
        ]
    else:
        return [
            TextContent(
                type="text",
                text=f"脚本执行失败: {result.get('error', '未知错误')}"
            )
        ]


async def tool_wait_for_condition(args: dict) -> list[TextContent]:
    """智能等待条件满足"""
    condition_type = args["condition_type"]
    selector = args.get("selector")
    script = args.get("script")
    timeout = args.get("timeout", 10000)

    params = {
        "condition_type": condition_type,
        "timeout": timeout
    }

    if selector:
        params["selector"] = selector
    if script:
        params["script"] = script

    result = await ws_manager.send_command("wait_for_condition", params)

    # 格式化结果
    if condition_type == "visible":
        found = result.get("found", False)
        status = "已出现" if found else "超时未出现"
        return [
            TextContent(
                type="text",
                text=f"元素可见性等待: {status}\n选择器: {selector}"
            )
        ]
    elif condition_type == "custom":
        satisfied = result.get("satisfied", False)
        status = "条件满足" if satisfied else "超时"
        return [
            TextContent(
                type="text",
                text=f"自定义条件等待: {status}"
            )
        ]

    return [TextContent(type="text", text=f"等待完成: {result}")]


async def tool_detach_debugger(args: dict) -> list[TextContent]:
    """主动解除 debugger 附加"""
    tab_id = args.get("tab_id")

    # 使用 DebuggerManager 执行 detach
    success = await debugger_manager.detach_debugger(tab_id)

    if success:
        return [
            TextContent(
                type="text",
                text=f"已成功解除 debugger 附加 (tab_id: {tab_id or '当前标签'})"
            )
        ]
    else:
        return [
            TextContent(
                type="text",
                text="解除 debugger 失败,可能没有已附加的 debugger"
            )
        ]


# ==================== 第二阶段新增 Tool 实现 ====================

async def tool_scroll_until(args: dict) -> list[TextContent]:
    """智能滚动直到满足条件"""
    condition = args["condition"]
    selector = args.get("selector")
    max_scrolls = args.get("max_scrolls", 20)
    scroll_delay = args.get("scroll_delay", 500)

    params = {
        "condition": condition,
        "max_scrolls": max_scrolls,
        "scroll_delay": scroll_delay
    }

    if selector:
        params["selector"] = selector

    result = await ws_manager.send_command("scroll_until", params)

    scrolled = result.get("scrolled", 0)
    reached = result.get("reached_condition", False)

    if condition == "no_more_content":
        status = "已到底部" if reached else f"已滚动 {scrolled} 次但未到底"
    else:  # element_visible
        status = "元素已可见" if reached else f"滚动 {scrolled} 次后仍未找到元素"

    return [
        TextContent(
            type="text",
            text=f"智能滚动完成\n条件: {condition}\n状态: {status}\n总滚动次数: {scrolled}"
        )
    ]


async def tool_send_keys(args: dict) -> list[TextContent]:
    """发送键盘快捷键"""
    keys = args["keys"]
    selector = args.get("selector")

    params = {"keys": keys}
    if selector:
        params["selector"] = selector

    result = await ws_manager.send_command("send_keys", params)

    if result.get("sent"):
        text = f"已发送按键: {keys}"
        if selector:
            text += f"\n目标元素: {selector}"
        return [TextContent(type="text", text=text)]
    else:
        return [TextContent(type="text", text=f"发送按键失败: {keys}")]


async def tool_find_text(args: dict) -> list[TextContent]:
    """查找页面文本"""
    text = args["text"]
    click = args.get("click", False)

    result = await ws_manager.send_command("find_text", {"text": text, "click": click})

    if not result.get("found"):
        return [
            TextContent(
                type="text",
                text=f"未找到文本: \"{text}\""
            )
        ]

    total = result.get("total_found", 0)
    clicked = result.get("clicked", False)

    response = f"找到 {total} 个包含 \"{text}\" 的元素"

    if clicked:
        element = result.get("element", {})
        response += f"\n已点击第一个可见元素: {element.get('tag', 'unknown')} at ({element.get('x', 0)}, {element.get('y', 0)})"
    else:
        elements = result.get("elements", [])[:3]  # 只显示前3个
        if elements:
            response += "\n前几个元素:"
            for i, el in enumerate(elements, 1):
                response += f"\n  {i}. {el.get('tag', 'unknown')}: {el.get('text', '')[:50]}"

    return [TextContent(type="text", text=response)]


async def tool_scrape_with_scroll(args: dict) -> list[TextContent]:
    """批量爬取操作"""
    extract_script = args["extract_script"]
    max_items = args.get("max_items", 100)
    batch_size = args.get("batch_size", 10)
    scroll_delay = args.get("scroll_delay", 500)
    dedupe_by = args.get("dedupe_by")

    params = {
        "extract_script": extract_script,
        "max_items": max_items,
        "batch_size": batch_size,
        "scroll_delay": scroll_delay
    }

    if dedupe_by:
        params["dedupe_by"] = dedupe_by

    logger.info(f"开始批量爬取: max_items={max_items}, dedupe_by={dedupe_by}")

    result = await ws_manager.send_command("scrape_with_scroll", params)

    items = result.get("items", [])
    total = result.get("total", 0)
    scrolls = result.get("scrolls", 0)
    reached_end = result.get("reached_end", False)

    # 返回结果
    response = f"批量爬取完成\n"
    response += f"提取数据: {total} 条\n"
    response += f"滚动次数: {scrolls} 次\n"
    response += f"是否到底: {'是' if reached_end else '否'}"

    if dedupe_by:
        response += f"\n去重字段: {dedupe_by}"

    # 显示前3条数据示例
    if items and len(items) > 0:
        response += f"\n\n前 {min(3, len(items))} 条数据示例:"
        for i, item in enumerate(items[:3], 1):
            response += f"\n{i}. {json.dumps(item, ensure_ascii=False)[:100]}..."

    return [TextContent(type="text", text=response)]


# ==================== Agent-first Unified Tool Implementation ====================

async def tool_agent_first(name: str, args: dict) -> list[TextContent]:
    """Dispatch the unified 26-tool namespace and return JSON-only observations."""

    if name == "browser_tabs_list":
        raw = await ws_manager.send_command("get_all_tabs")
        tabs = []
        for window_tabs in raw.get("windows", {}).values():
            for tab in window_tabs:
                tabs.append(
                    {
                        "id": tab.get("id"),
                        "windowId": tab.get("windowId"),
                        "active": tab.get("active"),
                        "url": tab.get("url"),
                        "title": tab.get("title"),
                        "status": tab.get("status", "unknown"),
                        "favicon": tab.get("favIconUrl"),
                    }
                )
        return _json_content({"tabs": tabs, "totalCount": len(tabs)})

    if name == "browser_navigate":
        action = args.get("action", "goto")
        if action == "goto":
            started = time.monotonic()
            url = args.get("url", "")
            if not url.startswith(("http://", "https://", "chrome://", "about:")):
                url = "https://" + url
            result = await ws_manager.send_command(
                "navigate",
                {
                    "url": url,
                    "waitUntil": args.get("waitUntil", "dom-ready"),
                    "timeout": args.get("timeout", 10000),
                },
            )
            final_url = result.get("url", url)
            return _json_content(
                {
                    "ok": True,
                    "action": "goto",
                    "finalUrl": final_url,
                    "redirected": final_url != url,
                    "status": result.get("status", "unknown"),
                    "method": result.get("method", "unknown"),
                    "elapsed": int((time.monotonic() - started) * 1000),
                }
            )
        elif action == "back":
            result = await ws_manager.send_command("go_back")
            return _json_content({
                "ok": True,
                "action": "back",
                "url": result.get("url"),
                "status": result.get("status", "unknown"),
                "hint": "Navigated back.",
            })
        elif action == "forward":
            result = await ws_manager.send_command("go_forward")
            return _json_content({
                "ok": True,
                "action": "forward",
                "url": result.get("url"),
                "status": result.get("status", "unknown"),
                "hint": "Navigated forward.",
            })
        elif action == "reload":
            result = await ws_manager.send_command("reload")
            return _json_content({
                "ok": True,
                "action": "reload",
                "status": result.get("status", "unknown"),
                "hint": "Page reloaded.",
            })
        else:
            return _json_content({"ok": False, "error": f"unknown navigation action: {action}"})

    if name == "browser_tab":
        action = args.get("action")
        if action == "new":
            result = await ws_manager.send_command("agent_browser_tab_new", {
                "url": args.get("url"),
                "active": args.get("active", True)
            })
            return _json_content({"ok": True, "action": "new", "tabId": result.get("tabId")})
        elif action == "switch":
            tab_id = args.get("tabId")
            if tab_id is None:
                return _json_content({"ok": False, "error": "tabId is required for switch"})
            result = await ws_manager.send_command("agent_browser_tab_switch", {"tabId": tab_id})
            return _json_content({"ok": True, "action": "switch", "tabId": tab_id})
        elif action == "close":
            tab_id = args.get("tabId")
            if tab_id is None:
                return _json_content({"ok": False, "error": "tabId is required for close"})
            result = await ws_manager.send_command("agent_browser_tab_close", {"tabId": tab_id})
            return _json_content({"ok": True, "action": "close", "tabId": tab_id})
        elif action == "info":
            result = await ws_manager.send_command("agent_browser_tab_info", {})
            return _json_content({"ok": True, "action": "info", **result})
        else:
            return _json_content({"ok": False, "error": f"unknown tab action: {action}"})

    if name == "browser_session":
        return _json_content({"ok": False, "error": "not implemented in this phase"})

    if name == "browser_dom_overview":
        return _json_content(await ws_manager.send_command("dom_overview", args))

    if name == "browser_dom_query":
        return _json_content(await ws_manager.send_command("dom_query", args))

    if name == "browser_dom_search":
        return _json_content(await ws_manager.send_command("dom_search", args))

    if name == "browser_dom_get_text":
        return _json_content({"ok": False, "error": "not implemented in this phase"})

    if name == "browser_dom_diff":
        return _json_content({"ok": False, "error": "not implemented in this phase"})

    if name == "browser_screenshot":
        screenshot = await ws_manager.send_command(
            "screenshot",
            {
                "format": args.get("format", "png"),
                "quality": args.get("quality", 80),
                "selector": args.get("selector"),
                "fullPage": args.get("fullPage", False),
            },
        )
        return _json_content(
            {
                "format": screenshot.get("format", args.get("format", "png")),
                "data": screenshot.get("image", ""),
                "note": "Screenshots are high-token fallback observations; prefer DOM/action tools first.",
            }
        )

    if name == "action_click":
        return _json_content(await ws_manager.send_command("action_click", args))

    if name == "action_double_click":
        target = args.get("target")
        if not target:
            return _json_content({"ok": False, "error": "target is required"})
        return _json_content(await ws_manager.send_command("click", {"target": target, "clickCount": 2}))

    if name == "action_hover":
        return _json_content(await ws_manager.send_command("action_hover", args))

    if name == "action_scroll":
        return _json_content(await ws_manager.send_command("action_scroll", args))

    if name == "action_drag":
        return _json_content(await ws_manager.send_command("action_drag", args))

    if name == "action_fill":
        target = args.get("target")
        value = args.get("value", "")
        if not target:
            return _json_content({"ok": False, "error": "target is required"})
        params = {
            "target": target,
            "text": value,
            "clearFirst": True,
            "submitAfter": args.get("submitAfter", "none"),
        }
        return _json_content(await ws_manager.send_command("type", params))

    if name == "action_press_key":
        return _json_content(await ws_manager.send_command("action_press_key", args))

    if name == "upload_file":
        return _json_content(await ws_manager.send_command("upload_file", args))

    if name == "handle_dialog":
        return _json_content(await ws_manager.send_command("handle_dialog", args))

    if name == "playwright_run":
        return _json_content({"ok": False, "error": "not implemented in this phase"})

    if name == "script_evaluate":
        return _json_content(await ws_manager.send_command("script_evaluate", args))

    if name == "save_as_pdf":
        return _json_content({"ok": False, "error": "not implemented in this phase"})

    if name == "console_check":
        action = args.get("action")
        if action in ("start", "stop", "status", "clear"):
            return _json_content(await ws_manager.send_command("console_capture", {
                "action": action,
                "maxEntries": args.get("maxEntries", 300)
            }))
        elif action == "list":
            return _json_content(await ws_manager.send_command("console_list", {
                "types": args.get("types"),
                "limit": args.get("limit", 50)
            }))
        elif action == "get":
            return _json_content(await ws_manager.send_command("console_get", {"id": args.get("id")}))
        else:
            return _json_content({"ok": False, "error": f"unknown console action: {action}"})

    if name == "network_check":
        action = args.get("action")
        if action in ("start", "stop", "status", "clear"):
            return _json_content(await ws_manager.send_command("network_capture", {
                "action": action,
                "maxEntries": args.get("maxEntries", 500),
                "includeResponseBody": args.get("includeResponseBody", False)
            }))
        elif action == "list":
            return _json_content(await ws_manager.send_command("network_list", {
                "limit": args.get("limit", 50),
                "resourceType": args.get("resourceType"),
                "status": args.get("status"),
                "method": args.get("method")
            }))
        elif action == "query":
            return _json_content(await ws_manager.send_command("network_query", {
                "urlContains": args.get("urlContains"),
                "method": args.get("method"),
                "status": args.get("status"),
                "resourceType": args.get("resourceType"),
                "hasResponseBody": args.get("hasResponseBody"),
                "includeBody": args.get("includeBody"),
                "limit": args.get("limit", 50)
            }))
        elif action == "fetch":
            return _json_content(await ws_manager.send_command("network_fetch", {
                "url": args.get("url"),
                "method": args.get("method", "GET"),
                "headers": args.get("headers"),
                "body": args.get("body"),
                "responseType": args.get("responseType", "text")
            }))
        elif action == "replay":
            return _json_content(await ws_manager.send_command("network_replay", {
                "id": args.get("id"),
                "requestId": args.get("requestId"),
                "overrideHeaders": args.get("overrideHeaders"),
                "overrideBody": args.get("overrideBody")
            }))
        else:
            return _json_content({"ok": False, "error": f"unknown network action: {action}"})

    if name == "browser_scrape_with_scroll":
        # Reuse the existing implementation for consistent text formatting
        return await tool_scrape_with_scroll(args)

    return _json_content({"ok": False, "error": f"unimplemented tool: {name}"})


# ==================== 启动 ====================

async def run():
    """启动 MCP adapter，并连接/拉起共享 Browser Hub"""
    await ws_manager.start()
    logger.info("MCP adapter 已连接 Browser Hub，等待 Chrome Extension 连接...")

    # 启动 MCP StdIO Server
    async with stdio_server() as (read_stream, write_stream):
        await app.run(read_stream, write_stream, app.create_initialization_options())


def main():
    asyncio.run(run())


if __name__ == "__main__":
    main()
