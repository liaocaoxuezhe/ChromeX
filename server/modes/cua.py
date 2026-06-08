# -*- coding: utf-8 -*-
"""Computer-use style primitives backed by the extension CDP plane.

The caller's multimodal model decides coordinates from screenshots. This module
only returns screenshot metadata and dispatches calibrated coordinate actions.
"""

from __future__ import annotations

from typing import Any


class CuaController:
    def __init__(self, ws_manager):
        self.ws_manager = ws_manager

    async def screenshot(self, args: dict) -> dict:
        info = await self.ws_manager.send_command("get_info")
        viewport = info.get("viewport", {})
        dpr = _dpr(viewport)
        image = await self.ws_manager.send_command(
            "screenshot",
            {
                "format": args.get("format", "png"),
                "quality": args.get("quality", 80),
            },
        )
        css_width = viewport.get("innerWidth")
        css_height = viewport.get("innerHeight")
        return {
            "ok": bool(image.get("image")),
            "format": image.get("format", args.get("format", "png")),
            "data": image.get("image", ""),
            "metadata": {
                "coordinateSpace": "screenshot",
                "devicePixelRatio": dpr,
                "cssViewport": {"width": css_width, "height": css_height},
                "screenshotSize": {
                    "width": int(css_width * dpr) if css_width else None,
                    "height": int(css_height * dpr) if css_height else None,
                },
                "note": "x/y inputs for browser.cua.* are screenshot pixels; the server converts them to CSS pixels before CDP dispatch.",
            },
        }

    async def click(self, args: dict) -> dict:
        css = await self._css_point(args["x"], args["y"])
        params = {
            "x": css["x"],
            "y": css["y"],
            "button": args.get("button", "left"),
            "clickCount": args.get("clickCount", 1),
        }
        await self.ws_manager.send_command("click", params)
        return _action_result("click", args, css)

    async def double_click(self, args: dict) -> dict:
        payload = dict(args)
        payload["clickCount"] = 2
        result = await self.click(payload)
        result["action"] = "double_click"
        return result

    async def move(self, args: dict) -> dict:
        css = await self._css_point(args["x"], args["y"])
        await self.ws_manager.send_command("action_hover", {"target": css})
        return _action_result("move", args, css)

    async def type(self, args: dict) -> dict:
        await self.ws_manager.send_command("type", {"text": args["text"], "clearFirst": args.get("clearFirst", False)})
        return {"ok": True, "action": "type", "textLength": len(args["text"])}

    async def key(self, args: dict) -> dict:
        key = args.get("combo") or args.get("key")
        await self.ws_manager.send_command("send_keys", {"keys": key})
        return {"ok": True, "action": "key", "key": key}

    async def scroll(self, args: dict) -> dict:
        await self.ws_manager.send_command(
            "scroll",
            {
                "x": args.get("x", 0),
                "y": args.get("y", 0),
                "deltaX": args.get("dx", 0),
                "deltaY": args.get("dy", args.get("deltaY", 500)),
            },
        )
        return {"ok": True, "action": "scroll"}

    async def drag(self, args: dict) -> dict:
        start = await self._css_point(args["x1"], args["y1"])
        end = await self._css_point(args["x2"], args["y2"])
        await self.ws_manager.send_command(
            "drag",
            {
                "startX": start["x"],
                "startY": start["y"],
                "endX": end["x"],
                "endY": end["y"],
                "duration": args.get("duration", 500),
            },
        )
        return {"ok": True, "action": "drag", "coordinateSpace": "screenshot", "startCss": start, "endCss": end}

    async def _css_point(self, x: float, y: float) -> dict[str, Any]:
        info = await self.ws_manager.send_command("get_info")
        dpr = _dpr(info.get("viewport", {}))
        return {"x": _clean_number(x / dpr), "y": _clean_number(y / dpr)}


def _dpr(viewport: dict) -> float:
    value = viewport.get("devicePixelRatio", 1) or 1
    return float(value)


def _clean_number(value: float) -> int | float:
    return int(value) if float(value).is_integer() else value


def _action_result(action: str, original: dict, css: dict) -> dict:
    return {
        "ok": True,
        "action": action,
        "coordinateSpace": "screenshot",
        "input": {"x": original["x"], "y": original["y"]},
        "css": css,
    }
