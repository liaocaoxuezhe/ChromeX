"""
Link2Chrome MCP Server
通过 StdIO 提供 Browser Tools 给 Claude Code 使用
Tool 定义集中在 server/tool_descriptions.py 中维护
"""

from __future__ import annotations

import asyncio
import atexit
import base64
import json
import os
import re
import shutil
import sys
import tempfile
import time
from io import BytesIO

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
from server.dom_snapshot_cache import DomSnapshotCache
from server.logger import setup_logging, get_logger, get_operation_logger
from server.debugger_manager import DebuggerManager
from server.session_manager import SessionManager
from server.tool_descriptions import TOOL_DEFINITIONS
from server.playwright_runtime import PlaywrightRuntime

try:
    from server.nodejs_runtime_manager import NodeJSRuntimeManager
except ImportError:
    NodeJSRuntimeManager = None  # type: ignore

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
session_manager = SessionManager()
dom_cache = DomSnapshotCache()
playwright_runtime = PlaywrightRuntime()

if NodeJSRuntimeManager is not None:
    nodejs_runtime: Optional[NodeJSRuntimeManager] = NodeJSRuntimeManager(project_root=_project_root)
else:
    nodejs_runtime = None

_SESSION_TMPDIR = tempfile.mkdtemp(prefix="link2chrome_")
atexit.register(shutil.rmtree, _SESSION_TMPDIR, True)
_URL_SCHEME_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9+.-]*:")

app = Server("local-browser")

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

    try:
        if name == "browser_diagnose":
            result = await tool_diagnose(arguments)
            result_summary = _extract_result_summary(result)
            op_logger.log_operation(name, arguments, result_summary=result_summary)
            return result

        async with ws_manager.operation(name):
            # New unified 27-tool routing
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
                "script_evaluate",
                "console_check",
                "network_check",
                "browser_scrape_with_scroll",
            }:
                result = await tool_agent_first(name, arguments)
            elif name == "browser_code_run":
                result = await tool_browser_code_run(arguments)
            elif name == "save_as_pdf":
                result = await tool_save_as_pdf(arguments)
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


def _normalize_url(url: str) -> str:
    """Add https:// only for host-like inputs; preserve explicit schemes such as data:."""
    if not url:
        return url
    return url if _URL_SCHEME_RE.match(url) else "https://" + url


def _compress_screenshot_to_jpeg(image_b64: str, quality: int = 70) -> tuple[bytes, int, int]:
    from PIL import Image

    image = Image.open(BytesIO(base64.b64decode(image_b64)))
    quality = max(1, min(int(quality), 100))
    buf = BytesIO()
    image.convert("RGB").save(buf, format="JPEG", quality=quality, optimize=True)
    return buf.getvalue(), image.width, image.height


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

async def tool_agent_first(name: str, args: dict) -> list[TextContent | ImageContent]:
    """Dispatch the unified 27-tool namespace and return JSON-only observations."""

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
            url = _normalize_url(url)
            result = await ws_manager.send_command(
                "navigate",
                {
                    "url": url,
                    "waitUntil": args.get("waitUntil", "dom-ready"),
                    "timeout": args.get("timeout", 10000),
                },
            )
            final_url = result.get("url", url)

            joined_session = None
            if session_manager.active_session:
                try:
                    tab_info = await ws_manager.send_command("get_info")
                    tab_id = tab_info.get("tabId")
                    if tab_id is not None:
                        joined_session = await session_manager.auto_add_tab(tab_id, ws_manager)
                except Exception:
                    pass

            resp = {
                "ok": True,
                "action": "goto",
                "finalUrl": final_url,
                "redirected": final_url != url,
                "status": result.get("status", "unknown"),
                "method": result.get("method", "unknown"),
                "elapsed": int((time.monotonic() - started) * 1000),
                "hint": "Page loaded. Use browser_dom_overview to inspect the page structure.",
            }
            if joined_session:
                resp["session"] = joined_session
            return _json_content(resp)
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
            tab_id = result.get("tabId")
            joined_session = None
            if tab_id is not None and session_manager.active_session:
                try:
                    joined_session = await session_manager.auto_add_tab(tab_id, ws_manager)
                except Exception:
                    pass
            resp = {"ok": True, "action": "new", "tabId": tab_id}
            if joined_session:
                resp["session"] = joined_session
            return _json_content(resp)
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
        action = args.get("action", "list")
        if action == "create":
            session = args.get("session")
            if not session:
                return _json_content({"ok": False, "error": "session is required for 'create'"})
            group_title = args.get("group_title")
            info = await session_manager.ensure_session(session, group_title, ws_manager)
            return _json_content({
                "ok": True, "action": "create", "session": session,
                "groupId": info.get("group_id"), "groupTitle": info.get("group_title"),
                "hint": "Active session set. Subsequent browser_navigate / browser_tab calls will auto-join this group.",
            })
        if action == "new_tab":
            session = args.get("session")
            url = args.get("url")
            if not session:
                return _json_content({"ok": False, "error": "session is required for 'new_tab'"})
            if not url:
                return _json_content({"ok": False, "error": "url is required for 'new_tab'"})
            url = _normalize_url(url)
            group_title = args.get("group_title")
            info = await session_manager.ensure_session(session, group_title, ws_manager)
            tab_result = await ws_manager.send_command("agent_browser_tab_new", {
                "url": url, "active": True,
            })
            tab_id = tab_result.get("tabId")
            if tab_id is not None:
                await session_manager.add_tab_to_session(session, tab_id, ws_manager)
            return _json_content({
                "ok": True, "action": "new_tab", "session": session,
                "tabId": tab_id, "url": url,
                "groupId": info.get("group_id"), "groupTitle": info.get("group_title"),
            })
        if action == "add":
            session = args.get("session")
            tab_id = args.get("tabId")
            if not session:
                return _json_content({"ok": False, "error": "session is required for 'add'"})
            if tab_id is None:
                return _json_content({"ok": False, "error": "tabId is required for 'add'"})
            await session_manager.ensure_session(session, None, ws_manager)
            await session_manager.add_tab_to_session(session, tab_id, ws_manager)
            return _json_content({"ok": True, "action": "add", "session": session, "tabId": tab_id})
        if action == "close":
            session = args.get("session")
            if not session:
                return _json_content({"ok": False, "error": "session is required for 'close'"})
            result = await session_manager.close_session(session, ws_manager)
            return _json_content(result)
        if action == "list":
            return _json_content({
                "ok": True,
                "activeSession": session_manager.active_session,
                "sessions": session_manager.list_sessions(),
            })
        return _json_content({"ok": False, "error": f"unknown session action: {action}"})

    if name == "browser_dom_overview":
        raw = await ws_manager.send_command("dom_overview", args)
        try:
            info = await ws_manager.send_command("get_info")
            current_url = info.get("url", "")
            current_tab_id = info.get("tabId")
        except Exception:
            current_url = ""
            current_tab_id = None

        raw_json = json.dumps(raw, ensure_ascii=False)
        markdown = compress_dom(raw_json, max_chars=args.get("max_chars", 30000))

        if current_tab_id is not None:
            dom_cache.save_snapshot(current_tab_id, current_url, markdown)

        return _json_content(
            {
                "ok": True,
                "url": current_url,
                "overview": markdown,
                "hint": "Use action_click / action_fill to interact. Use browser_dom_diff after actions to verify changes.",
            }
        )

    if name == "browser_dom_query":
        return _json_content(await ws_manager.send_command("dom_query", args))

    if name == "browser_dom_search":
        return _json_content(await ws_manager.send_command("dom_search", args))

    if name == "browser_dom_get_text":
        selector = args.get("selector")
        max_chars = args.get("max_chars", 20000)
        include_meta = args.get("include_meta", False)

        if selector:
            try:
                result = await ws_manager.send_command("dom_get_text", {"selector": selector})
            except Exception as e:
                if "dom_get_text" not in str(e) and "未知指令" not in str(e):
                    raise
                result = await ws_manager.send_command(
                    "script_evaluate",
                    {
                        "expression": f"""
(() => {{
  const el = document.querySelector({json.dumps(selector, ensure_ascii=False)});
  if (!el) throw new Error("selector not found");
  const rect = el.getBoundingClientRect();
  const style = window.getComputedStyle(el);
  const text = el.innerText || el.textContent || "";
  return {{
    text,
    charCount: text.length,
    meta: {{
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role") || "",
      ariaLabel: el.getAttribute("aria-label") || "",
      childCount: el.children.length,
      visible: rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
    }}
  }};
}})()
""",
                        "awaitPromise": True,
                        "timeout": 5000,
                    },
                )
                if not result.get("ok", True):
                    return _json_content({"ok": False, "error": result.get("error", "dom_get_text fallback failed")})
                result = result.get("result", result)
            text = result.get("text", "")
            truncated = len(text) > max_chars
            if truncated:
                text = text[:max_chars] + "\n...(truncated)"

            payload = {
                "ok": True,
                "mode": "element",
                "selector": selector,
                "text": text,
                "charCount": len(text),
                "truncated": truncated,
            }
            if include_meta:
                payload["meta"] = result.get("meta", {})
            return _json_content(payload)
        else:
            result = await ws_manager.send_command("extract_content", {})
            if "error" in result:
                return _json_content({"ok": False, "error": result["error"]})

            title = result.get("title", "")
            byline = result.get("byline", "")
            content_html = result.get("content", "")
            excerpt = result.get("excerpt", "")

            if not content_html:
                return _json_content({"ok": False, "error": "页面内容为空，Readability 无法提取有效正文。"})

            content_md = md(
                content_html,
                heading_style="atx",
                bullets="-",
                strip=["img"],
            )
            content_md = re.sub(r"\n{3,}", "\n\n", content_md).strip()

            parts = []
            if title:
                parts.append(f"# {title}\n")
            if byline:
                parts.append(f"> {byline}\n")
            if excerpt:
                parts.append(f"*{excerpt}*\n")
            parts.append(content_md)
            full_text = "\n".join(parts)

            truncated = len(full_text) > max_chars
            if truncated:
                full_text = full_text[:max_chars] + "\n...(truncated)"

            return _json_content(
                {
                    "ok": True,
                    "mode": "readability",
                    "title": title,
                    "content": full_text,
                    "charCount": len(full_text),
                    "truncated": truncated,
                }
            )

    if name == "browser_dom_diff":
        try:
            info = await ws_manager.send_command("get_info")
            current_url = info.get("url", "")
            current_tab_id = info.get("tabId")
        except Exception:
            return _json_content({"ok": False, "error": "无法获取当前页面信息"})

        if current_tab_id is None:
            return _json_content({"ok": False, "error": "无法确定当前标签页 ID"})

        raw = await ws_manager.send_command("dom_overview", args)
        raw_json = json.dumps(raw, ensure_ascii=False)
        current_overview = compress_dom(raw_json, max_chars=args.get("max_chars", 30000))

        diff = dom_cache.compute_diff(current_tab_id, current_overview, current_url)

        return _json_content(
            {
                "ok": True,
                "diff": diff,
                "hint": "Positive diff lines (+) are new content. Negative (-) are removed." if diff.startswith("---") else "",
            }
        )

    if name == "browser_screenshot":
        screenshot = await ws_manager.send_command(
            "screenshot",
            {
                "format": args.get("format", "jpeg"),
                "quality": args.get("quality", 70),
                "selector": args.get("selector"),
                "fullPage": args.get("fullPage", False),
            },
        )

        image_b64 = screenshot.get("image", "")
        if not image_b64:
            return _json_content({"ok": False, "error": "Screenshot returned no image data"})

        jpeg_bytes, width, height = _compress_screenshot_to_jpeg(
            image_b64,
            quality=args.get("quality", 70),
        )

        payload = {
            "ok": True,
            "format": "jpeg",
            "width": width,
            "height": height,
            "coordinateSpace": "screenshot pixels",
            "sizeBytes": len(jpeg_bytes),
        }

        if args.get("inline"):
            return [
                TextContent(type="text", text=json.dumps(payload, ensure_ascii=False, indent=2)),
                ImageContent(
                    type="image",
                    data=base64.b64encode(jpeg_bytes).decode("ascii"),
                    mimeType="image/jpeg",
                ),
            ]

        title = "screenshot"
        try:
            info = await ws_manager.send_command("get_info")
            title = re.sub(r"[^\w\-. ]+", "_", info.get("title", "screenshot")).strip("_") or "screenshot"
        except Exception:
            pass

        output_path = args.get("path") or os.path.join(
            _SESSION_TMPDIR, f"{title}-{int(time.time() * 1000)}.jpg"
        )

        output_dir = os.path.dirname(os.path.abspath(output_path))
        os.makedirs(output_dir, exist_ok=True)

        with open(output_path, "wb") as f:
            f.write(jpeg_bytes)

        return _json_content({
            **payload,
            "path": output_path,
            "note": "Use the Read tool to view this screenshot file.",
        })

    if name == "action_click":
        return _json_content(await ws_manager.send_command("action_click", args))

    if name == "action_double_click":
        target = args.get("target")
        if not target:
            return _json_content({"ok": False, "error": "target is required"})
        return _json_content(await ws_manager.send_command("action_click", {"target": target, "clickCount": 2}))

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
            "text": value,
            "clearFirst": True,
            "submitAfter": args.get("submitAfter", "none"),
        }
        if isinstance(target, dict):
            if "selector" in target:
                params["selector"] = target["selector"]
            elif "x" in target and "y" in target:
                params["x"] = target["x"]
                params["y"] = target["y"]
            elif "placeholder" in target:
                params["selector"] = f"input[placeholder={json.dumps(target['placeholder'])}], textarea[placeholder={json.dumps(target['placeholder'])}]"
            elif "name" in target:
                params["selector"] = f"[name={json.dumps(target['name'])}]"
            else:
                params["target"] = target
        return _json_content(await ws_manager.send_command("type", params))

    if name == "action_press_key":
        return _json_content(await ws_manager.send_command("action_press_key", args))

    if name == "upload_file":
        return _json_content(await ws_manager.send_command("upload_file", args))

    if name == "handle_dialog":
        return _json_content(await ws_manager.send_command("handle_dialog", args))

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
            list_params = {"limit": args.get("limit", 50)}
            for key in ("resourceType", "status", "method"):
                if args.get(key) is not None:
                    list_params[key] = args[key]
            return _json_content(await ws_manager.send_command("network_list", list_params))
        elif action == "query":
            query_params = {"limit": args.get("limit", 50)}
            for key in ("urlContains", "method", "status", "resourceType", "hasResponseBody", "includeBody"):
                if args.get(key) is not None:
                    query_params[key] = args[key]
            return _json_content(await ws_manager.send_command("network_query", query_params))
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


async def tool_browser_code_run(args: dict) -> list[TextContent]:
    """执行用于控制真实浏览器的 JavaScript 代码。

    强制通过 NodeJSRuntimeManager 在 Node.js 子进程中执行；
    Node.js 不可用时返回明确错误，不再降级到 Extension 端执行。
    """
    code = args["code"]
    timeout = args.get("timeout", 30000)
    max_result_chars = args.get("max_result_chars", 20000)

    def _truncate_result(raw_result: object) -> dict:
        """对执行结果进行截断处理，保持与原有 PlaywrightRuntime 一致的返回格式。"""
        serialized = PlaywrightRuntime._serialize_result(raw_result)
        truncated = False
        if len(serialized) > max_result_chars:
            serialized = serialized[:max_result_chars] + "\n...[truncated]"
            truncated = True
        return {
            "ok": True,
            "result": serialized if truncated else raw_result,
            "truncated": truncated,
            "charCount": len(serialized),
        }

    # 强制 Node.js Runtime 优先策略（P0-1）
    if nodejs_runtime is not None:
        try:
            if not nodejs_runtime.is_ready:
                started = await nodejs_runtime.start()
                if not started:
                    logger.warning(
                        f"Node.js Runtime 启动失败: {nodejs_runtime.startup_error}，"
                        "拒绝降级到 Extension 端 PlaywrightRuntime"
                    )
                    return _json_content({
                        "ok": False,
                        "error": (
                            f"{nodejs_runtime.startup_error}\n"
                            "Playwright 高级功能需要 Node.js Runtime，"
                            "请安装 Node.js (>=18) 并确保 node 命令在 PATH 中，然后重启 MCP Server。"
                            "可运行 node scripts/check-node-env.mjs 诊断环境。"
                        ),
                    })

            result = await nodejs_runtime.execute(
                code,
                timeout,
                lease_token=getattr(ws_manager, "_lease_token", None),
            )
            if result.get("ok"):
                payload = _truncate_result(result["result"])
                if result.get("meta") is not None:
                    payload["meta"] = result["meta"]
                return _json_content(payload)
            else:
                # Node.js 正常执行但用户代码出错，直接返回错误（含堆栈）
                return _json_content({
                    "ok": False,
                    "error": result.get("error", "未知错误"),
                    "stack": result.get("stack"),
                })
        except Exception as exc:
            logger.warning(
                f"Node.js Runtime 异常: {exc}，拒绝降级到 Extension 端 PlaywrightRuntime"
            )
            return _json_content({
                "ok": False,
                "error": (
                    f"Node.js Runtime 异常: {exc}\n"
                    "Playwright 高级功能需要 Node.js Runtime，"
                    "请安装 Node.js (>=18) 并确保 node 命令在 PATH 中，然后重启 MCP Server。"
                    "可运行 node scripts/check-node-env.mjs 诊断环境。"
                ),
            })
    else:
        logger.warning("Node.js Playwright Runtime 未配置，拒绝执行 browser_code_run")
        return _json_content({
            "ok": False,
            "error": (
                "Node.js Playwright Runtime 未配置，无法执行 browser_code_run。\n"
                "请安装 Node.js (>=18) 并确保 node 命令在 PATH 中，然后重启 MCP Server。"
                "可运行 node scripts/check-node-env.mjs 诊断环境。"
            ),
        })


async def tool_save_as_pdf(args: dict) -> list[TextContent]:
    """将当前页面渲染为 PDF 文件。"""
    import base64
    import tempfile

    params = {
        "format": args.get("format", "a4"),
        "landscape": args.get("landscape", False),
        "scale": args.get("scale", 1.0),
        "printBackground": args.get("printBackground", True),
    }

    output_path = args.get("path")
    if not output_path:
        # 使用临时目录，以页面标题作为文件名
        title = "page"
        try:
            info = await ws_manager.send_command("get_info")
            title = re.sub(r"[^\w\-. ]+", "_", info.get("title", "page")).strip("_") or "page"
        except Exception:
            pass
        output_path = os.path.join(tempfile.gettempdir(), f"{title}-{int(time.time() * 1000)}.pdf")

    result = await ws_manager.send_command("save_as_pdf", params)

    if not result.get("ok"):
        return _json_content({
            "ok": False,
            "error": result.get("error") or "PDF generation failed",
        })

    pdf_data = result.get("data")
    if not pdf_data:
        return _json_content({"ok": False, "error": "PDF data is empty"})

    # 确保目录存在
    output_dir = os.path.dirname(os.path.abspath(output_path))
    os.makedirs(output_dir, exist_ok=True)

    # 将 base64 数据写入文件
    try:
        decoded = base64.b64decode(pdf_data)
    except Exception as e:
        return _json_content({"ok": False, "error": f"Invalid PDF base64 data: {e}"})

    with open(output_path, "wb") as f:
        f.write(decoded)

    return _json_content({
        "ok": True,
        "path": output_path,
        "sizeBytes": len(decoded),
        "format": params["format"],
        "landscape": params["landscape"],
    })


# ==================== 启动 ====================

async def run():
    """启动 MCP adapter，并连接/拉起共享 Browser Hub"""
    await ws_manager.start()
    logger.info("MCP adapter 已连接 Browser Hub，等待 Chrome Extension 连接...")

    # 启动 MCP StdIO Server
    try:
        async with stdio_server() as (read_stream, write_stream):
            await app.run(read_stream, write_stream, app.create_initialization_options())
    finally:
        if nodejs_runtime is not None:
            await nodejs_runtime.stop()
            logger.info("Node.js Playwright Runtime 已停止")


def main():
    asyncio.run(run())


if __name__ == "__main__":
    main()
