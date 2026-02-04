"""
Link2Chrome MCP Server
通过 StdIO 提供 12 个 Browser Tools 给 Claude Code 使用
"""

import asyncio
import base64
import os
import re
import sys

from dotenv import load_dotenv
from markdownify import markdownify as md
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import TextContent, ImageContent, Tool

from server.ws_manager import WSManager
from server.vision import VisionClient
from server.dom_compressor import compress_dom
from server.logger import setup_logging, get_logger, get_operation_logger

# 加载环境变量
load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))

# 设置日志系统
log_level = os.getenv("LOG_LEVEL", "INFO")
setup_logging(log_level=log_level)
logger = get_logger()

# 操作日志记录器
op_logger = get_operation_logger()

# 全局实例
ws_manager = WSManager()
vision_client = None  # 延迟初始化

app = Server("local-browser")


def get_vision_client() -> VisionClient:
    """延迟初始化视觉模型客户端"""
    global vision_client
    if vision_client is None:
        vision_client = VisionClient()
    return vision_client


# ==================== Tool 定义 ====================

@app.list_tools()
async def list_tools() -> list[Tool]:
    return [
        Tool(
            name="browser_get_state",
            description=(
                "获取当前浏览器状态：包括 URL、标题、截图和压缩 DOM 树。"
                "用于了解用户当前正在浏览的页面内容和结构。"
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "include_screenshot": {
                        "type": "boolean",
                        "description": "是否包含截图（base64）。默认 true",
                        "default": True,
                    },
                    "include_dom": {
                        "type": "boolean",
                        "description": "是否包含压缩 DOM 树。默认 true",
                        "default": True,
                    },
                },
            },
        ),
        Tool(
            name="browser_action_vision",
            description=(
                "基于视觉模型执行浏览器操作。发送截图给 VLM，由模型分析页面并确定点击坐标。"
                "适用于：点击按钮/链接、输入文字、与页面元素交互。"
                "指令示例：'点击搜索框'、'点击登录按钮'、'在输入框中输入 hello'"
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "instruction": {
                        "type": "string",
                        "description": "自然语言操作指令，描述要执行的操作",
                    },
                },
                "required": ["instruction"],
            },
        ),
        Tool(
            name="browser_action_navigate",
            description="导航到指定 URL。会等待页面加载完成。",
            inputSchema={
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "要导航到的 URL",
                    },
                },
                "required": ["url"],
            },
        ),
        Tool(
            name="browser_action_scroll",
            description="滚动页面。支持上下滚动。",
            inputSchema={
                "type": "object",
                "properties": {
                    "direction": {
                        "type": "string",
                        "enum": ["up", "down"],
                        "description": "滚动方向",
                    },
                    "amount": {
                        "type": "integer",
                        "description": "滚动像素数。默认 500",
                        "default": 500,
                    },
                },
                "required": ["direction"],
            },
        ),
        Tool(
            name="browser_manage_tab",
            description=(
                "管理浏览器标签页：新建、关闭、切换标签页，以及列出所有标签。"
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["new", "close", "switch", "list"],
                        "description": "操作类型",
                    },
                    "tab_index": {
                        "type": "integer",
                        "description": "标签页索引（switch/close 时使用）",
                    },
                    "url": {
                        "type": "string",
                        "description": "新标签页的 URL（new 时使用，可选）",
                    },
                },
                "required": ["action"],
            },
        ),
        # ========== 新增 Tools ==========
        Tool(
            name="browser_click",
            description=(
                "直接点击页面上的指定坐标。支持 CSS 选择器定位或直接坐标。"
                "不经过视觉模型，适用于已知坐标或选择器的场景。"
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "x": {
                        "type": "number",
                        "description": "点击的 X 坐标（CSS 像素）",
                    },
                    "y": {
                        "type": "number",
                        "description": "点击的 Y 坐标（CSS 像素）",
                    },
                    "selector": {
                        "type": "string",
                        "description": "CSS 选择器，自动定位元素中心并点击（与 x/y 二选一）",
                    },
                    "button": {
                        "type": "string",
                        "enum": ["left", "right", "middle"],
                        "description": "鼠标按钮，默认 left",
                    },
                    "clickCount": {
                        "type": "integer",
                        "description": "点击次数，2 为双击。默认 1",
                    },
                },
            },
        ),
        Tool(
            name="browser_type",
            description=(
                "在当前聚焦的元素或指定选择器的元素中输入文本。"
                "可先点击选择器定位，再输入。支持 clearFirst 清空已有内容。"
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "text": {
                        "type": "string",
                        "description": "要输入的文本内容",
                    },
                    "selector": {
                        "type": "string",
                        "description": "目标输入框的 CSS 选择器（可选，不填则输入到当前焦点元素）",
                    },
                    "clearFirst": {
                        "type": "boolean",
                        "description": "输入前是否先清空已有内容。默认 false",
                    },
                    "pressEnter": {
                        "type": "boolean",
                        "description": "输入后是否按回车键。默认 false",
                    },
                },
                "required": ["text"],
            },
        ),
        Tool(
            name="browser_get_tabs",
            description=(
                "获取所有浏览器窗口中打开的全部标签页信息，"
                "包括 URL、标题、是否活跃、是否固定等。"
            ),
            inputSchema={
                "type": "object",
                "properties": {},
            },
        ),
        Tool(
            name="browser_go_back",
            description="浏览器后退到上一个页面（相当于点击后退按钮）。支持 forward 前进。",
            inputSchema={
                "type": "object",
                "properties": {
                    "forward": {
                        "type": "boolean",
                        "description": "设为 true 则前进而非后退。默认 false（后退）",
                    },
                },
            },
        ),
        Tool(
            name="browser_drag",
            description=(
                "在页面上执行拖拽操作：从起点坐标拖动到终点坐标。"
                "适用于拖拽排序、滑块操作、拖放元素等场景。"
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "startX": {
                        "type": "number",
                        "description": "起点 X 坐标（CSS 像素）",
                    },
                    "startY": {
                        "type": "number",
                        "description": "起点 Y 坐标（CSS 像素）",
                    },
                    "endX": {
                        "type": "number",
                        "description": "终点 X 坐标（CSS 像素）",
                    },
                    "endY": {
                        "type": "number",
                        "description": "终点 Y 坐标（CSS 像素）",
                    },
                    "duration": {
                        "type": "integer",
                        "description": "拖拽持续时间（毫秒）。默认 500",
                    },
                },
                "required": ["startX", "startY", "endX", "endY"],
            },
        ),
        Tool(
            name="browser_wait",
            description=(
                "等待指定条件满足：可以等待固定秒数、等待 CSS 选择器出现、"
                "或等待页面中出现指定文本。"
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "seconds": {
                        "type": "number",
                        "description": "等待固定秒数",
                    },
                    "selector": {
                        "type": "string",
                        "description": "等待此 CSS 选择器的元素出现",
                    },
                    "text": {
                        "type": "string",
                        "description": "等待页面中出现此文本",
                    },
                    "timeout": {
                        "type": "integer",
                        "description": "等待超时时间（毫秒）。默认 10000",
                    },
                },
            },
        ),
        Tool(
            name="browser_extract_content",
            description=(
                "使用 @mozilla/readability 提取当前页面的正文内容，"
                "转换为 Markdown 格式。可选保存到本地文件。"
                "适用于保存文章、博客、文档等网页内容。"
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "save_path": {
                        "type": "string",
                        "description": "保存 Markdown 文件的路径（可选，不填则只返回内容）",
                    },
                },
            },
        ),
        Tool(
            name="browser_diagnose",
            description="诊断浏览器连接状态：检查 Extension 版本、WS 连接、当前跟踪的标签页等。用于排查问题。",
            inputSchema={
                "type": "object",
                "properties": {},
            },
        ),
    ]


# ==================== Tool 实现 ====================

@app.call_tool()
async def call_tool(name: str, arguments: dict) -> list[TextContent | ImageContent]:
    logger.info(f"调用工具: {name}, 参数: {arguments}")
    try:
        if name == "browser_get_state":
            result = await tool_get_state(arguments)
        elif name == "browser_action_vision":
            result = await tool_action_vision(arguments)
        elif name == "browser_action_navigate":
            result = await tool_action_navigate(arguments)
        elif name == "browser_action_scroll":
            result = await tool_action_scroll(arguments)
        elif name == "browser_manage_tab":
            result = await tool_manage_tab(arguments)
        elif name == "browser_click":
            result = await tool_click(arguments)
        elif name == "browser_type":
            result = await tool_type(arguments)
        elif name == "browser_get_tabs":
            result = await tool_get_tabs(arguments)
        elif name == "browser_go_back":
            result = await tool_go_back(arguments)
        elif name == "browser_drag":
            result = await tool_drag(arguments)
        elif name == "browser_wait":
            result = await tool_wait(arguments)
        elif name == "browser_extract_content":
            result = await tool_extract_content(arguments)
        elif name == "browser_diagnose":
            result = await tool_diagnose(arguments)
        else:
            result = [TextContent(type="text", text=f"未知工具: {name}")]

        # 记录成功操作
        result_summary = _extract_result_summary(result)
        op_logger.log_operation(name, arguments, result_summary=result_summary)
        return result

    except ConnectionError as e:
        error_msg = f"浏览器未连接: {e}"
        logger.error(f"Tool {name} 连接错误: {e}")
        op_logger.log_operation(name, arguments, error=error_msg)
        return [TextContent(type="text", text=f"⚠️ {error_msg}")]
    except TimeoutError as e:
        error_msg = f"操作超时: {e}"
        logger.error(f"Tool {name} 超时: {e}")
        op_logger.log_operation(name, arguments, error=error_msg)
        return [TextContent(type="text", text=f"⚠️ {error_msg}")]
    except Exception as e:
        error_msg = f"执行出错: {e}"
        logger.exception(f"Tool {name} 执行异常")
        op_logger.log_operation(name, arguments, error=error_msg)
        return [TextContent(type="text", text=f"❌ {error_msg}")]


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


async def tool_get_state(args: dict) -> list[TextContent | ImageContent]:
    """获取浏览器状态"""
    include_screenshot = args.get("include_screenshot", True)
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

    # 截图
    if include_screenshot:
        screenshot_data = await ws_manager.send_command("screenshot")
        image_b64 = screenshot_data.get("image", "")
        if image_b64:
            results.append(
                ImageContent(
                    type="image",
                    data=image_b64,
                    mimeType="image/jpeg",
                )
            )

    # DOM 树
    if include_dom:
        dom_data = await ws_manager.send_command("get_dom")
        raw_dom = dom_data.get("dom", "{}")
        compressed = compress_dom(raw_dom)
        results.append(
            TextContent(type="text", text=f"DOM 结构:\n{compressed}")
        )

    return results


async def tool_action_vision(args: dict) -> list[TextContent | ImageContent]:
    """基于视觉模型执行操作"""
    instruction = args["instruction"]

    # 1. 获取截图和 viewport 信息
    info = await ws_manager.send_command("get_info")
    viewport = info.get("viewport", {})
    client_w = viewport.get("innerWidth", 1280)
    client_h = viewport.get("innerHeight", 720)
    dpr = viewport.get("devicePixelRatio", 1)

    screenshot_data = await ws_manager.send_command("screenshot")
    image_b64 = screenshot_data.get("image", "")

    if not image_b64:
        return [TextContent(type="text", text="无法获取截图")]

    # 2. 调用视觉模型
    vc = get_vision_client()
    # 截图实际像素尺寸 = client_size * DPR
    screenshot_w = int(client_w * dpr)
    screenshot_h = int(client_h * dpr)

    action = await vc.analyze(
        screenshot_b64=image_b64,
        instruction=instruction,
        viewport_width=screenshot_w,
        viewport_height=screenshot_h,
    )

    result_parts = [f"视觉分析: {action.reasoning}"]

    if action.action == "none":
        result_parts.append("模型未能确定操作，请尝试更明确的指令。")
        return [TextContent(type="text", text="\n".join(result_parts))]

    # 3. 坐标校准：模型坐标基于截图像素 → 转换为 CSS 像素
    if action.x is not None and action.y is not None:
        css_x = action.x / dpr
        css_y = action.y / dpr
        result_parts.append(
            f"坐标: 模型({action.x}, {action.y}) → CSS({css_x:.0f}, {css_y:.0f})"
        )
    else:
        css_x = client_w // 2
        css_y = client_h // 2

    # 4. 执行操作
    if action.action == "click":
        click_result = await ws_manager.send_command(
            "click", {"x": css_x, "y": css_y}
        )
        result_parts.append(f"已点击 ({css_x:.0f}, {css_y:.0f})")

    elif action.action == "type":
        # 先点击目标位置
        await ws_manager.send_command("click", {"x": css_x, "y": css_y})
        await asyncio.sleep(0.3)
        # 然后输入文字
        text = action.text or ""
        if text:
            await ws_manager.send_command("type", {"text": text, "clearFirst": True})
            result_parts.append(f"已在 ({css_x:.0f}, {css_y:.0f}) 输入: {text}")
        else:
            result_parts.append("type 操作但无输入文本")

    elif action.action == "scroll":
        direction = action.direction or "down"
        delta_y = -500 if direction == "up" else 500
        await ws_manager.send_command(
            "scroll", {"x": css_x, "y": css_y, "deltaX": 0, "deltaY": delta_y}
        )
        result_parts.append(f"已滚动 {direction}")

    # 返回截图作为执行结果的可视确认
    return [TextContent(type="text", text="\n".join(result_parts))]


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


# ==================== 新增 Tool 实现 ====================

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
    press_enter = args.get("pressEnter", False)

    # Extension 端的 cmdType 已支持 selector / clearFirst / pressEnter
    params = {"text": text, "clearFirst": clear_first, "pressEnter": press_enter}
    if selector:
        params["selector"] = selector

    await ws_manager.send_command("type", params)

    result_text = f"已输入: {text[:50]}{'...' if len(text) > 50 else ''}"
    if selector:
        result_text = f"在 `{selector}` 中" + result_text
    if press_enter:
        result_text += " (已按回车)"

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

    # WS 连接状态
    lines.append(f"WebSocket 连接: {'已连接' if ws_manager.is_connected else '未连接'}")

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


# ==================== 启动 ====================

async def run():
    """启动 MCP Server 和 WebSocket Server"""
    # 启动 WebSocket Server
    await ws_manager.start()
    logger.info("等待 Chrome Extension 连接...")

    # 启动 MCP StdIO Server
    async with stdio_server() as (read_stream, write_stream):
        await app.run(read_stream, write_stream, app.create_initialization_options())


def main():
    asyncio.run(run())


if __name__ == "__main__":
    main()
