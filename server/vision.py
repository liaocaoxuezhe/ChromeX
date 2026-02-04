"""
视觉模型模块 - 调用火山引擎 doubao-seed 视觉模型
通过 OpenAI 兼容接口，分析截图并返回操作坐标
"""

import base64
import json
import os
import re
from dataclasses import dataclass
from typing import Optional

from openai import OpenAI

from server.logger import get_logger

logger = get_logger("vision")


@dataclass
class VisionAction:
    """视觉模型解析出的操作"""

    action: str  # click, type, scroll, none
    x: Optional[int] = None
    y: Optional[int] = None
    text: Optional[str] = None  # 用于 type 操作
    direction: Optional[str] = None  # 用于 scroll: up/down
    reasoning: str = ""  # 模型的推理过程


SYSTEM_PROMPT = """你是一个精确的视觉定位助手。用户会给你一张浏览器截图和一个操作指令。

你的任务是：
1. 分析截图，理解页面内容和布局
2. 根据指令确定需要执行的操作类型和目标位置
3. 返回精确的像素坐标

请以 JSON 格式返回结果（不要包含 markdown 代码块标记）：
{
  "action": "click" | "type" | "scroll" | "none",
  "x": <像素x坐标>,
  "y": <像素y坐标>,
  "text": "<要输入的文字，仅 type 操作需要>",
  "direction": "<滚动方向 up/down，仅 scroll 操作需要>",
  "reasoning": "<简要说明你的分析过程>"
}

注意：
- 坐标是相对于截图左上角的像素位置
- 对于 click 操作，定位到目标元素的中心点
- 对于 type 操作，先定位输入框（x, y 为输入框坐标），text 为要输入的内容
- 如果无法确定操作，action 设为 "none" 并在 reasoning 中说明原因
- 只返回 JSON，不要有其他内容"""


class VisionClient:
    """火山引擎视觉模型客户端"""

    def __init__(self):
        api_key = os.getenv("DOUBAO_API_KEY")
        base_url = os.getenv("DOUBAO_BASE_URL", "https://ark.cn-beijing.volces.com/api/v3")
        self.model = os.getenv("DOUBAO_MODEL", "doubao-seed-1.8-thinking-250528")

        if not api_key:
            raise ValueError("DOUBAO_API_KEY 环境变量未设置")

        self.client = OpenAI(api_key=api_key, base_url=base_url)
        logger.info(f"Vision 客户端已初始化, model={self.model}")

    async def analyze(
        self,
        screenshot_b64: str,
        instruction: str,
        viewport_width: int,
        viewport_height: int,
    ) -> VisionAction:
        """
        分析截图并返回操作。

        Args:
            screenshot_b64: base64 编码的截图
            instruction: 自然语言操作指令
            viewport_width: 浏览器 viewport 宽度（CSS 像素）
            viewport_height: 浏览器 viewport 高度（CSS 像素）

        Returns:
            VisionAction 包含操作类型和坐标
        """
        user_content = [
            {
                "type": "text",
                "text": (
                    f"浏览器视口大小: {viewport_width}x{viewport_height} CSS 像素\n"
                    f"操作指令: {instruction}\n\n"
                    f"请分析截图并返回操作的 JSON。"
                ),
            },
            {
                "type": "image_url",
                "image_url": {
                    "url": f"data:image/jpeg;base64,{screenshot_b64}",
                },
            },
        ]

        try:
            response = self.client.chat.completions.create(
                model=self.model,
                messages=[
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": user_content},
                ],
                max_tokens=1024,
                temperature=0.1,
            )

            raw_text = response.choices[0].message.content.strip()
            logger.debug(f"模型原始返回: {raw_text[:500]}")

            return self._parse_response(raw_text)

        except Exception as e:
            logger.error(f"视觉模型调用失败: {e}")
            return VisionAction(
                action="none",
                reasoning=f"模型调用失败: {str(e)}",
            )

    def _parse_response(self, raw_text: str) -> VisionAction:
        """解析模型返回的 JSON"""
        # 尝试从文本中提取 JSON
        # 先直接尝试解析
        try:
            data = json.loads(raw_text)
        except json.JSONDecodeError:
            # 尝试从 markdown 代码块中提取
            json_match = re.search(r"```(?:json)?\s*\n?(.*?)\n?```", raw_text, re.DOTALL)
            if json_match:
                try:
                    data = json.loads(json_match.group(1))
                except json.JSONDecodeError:
                    pass
                else:
                    return self._dict_to_action(data)

            # 尝试查找 JSON 对象
            brace_match = re.search(r"\{[^{}]*\}", raw_text, re.DOTALL)
            if brace_match:
                try:
                    data = json.loads(brace_match.group())
                except json.JSONDecodeError:
                    return VisionAction(
                        action="none",
                        reasoning=f"无法解析模型返回: {raw_text[:200]}",
                    )
            else:
                return VisionAction(
                    action="none",
                    reasoning=f"模型返回中未找到 JSON: {raw_text[:200]}",
                )

        return self._dict_to_action(data)

    def _dict_to_action(self, data: dict) -> VisionAction:
        """将字典转换为 VisionAction"""
        return VisionAction(
            action=data.get("action", "none"),
            x=data.get("x"),
            y=data.get("y"),
            text=data.get("text"),
            direction=data.get("direction"),
            reasoning=data.get("reasoning", ""),
        )
