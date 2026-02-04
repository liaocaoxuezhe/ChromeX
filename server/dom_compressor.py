"""
DOM 压缩算法
将 Extension 返回的 DOM JSON 进一步压缩，去除冗余信息，保留关键结构
"""

import json
import logging
from typing import Any, Optional

logger = logging.getLogger("link2chrome.dom")

# 最大输出字符数限制
MAX_OUTPUT_CHARS = 50000


def compress_dom(raw_dom: str, max_chars: int = MAX_OUTPUT_CHARS) -> str:
    """
    压缩 DOM JSON 字符串，返回精简版本。

    Args:
        raw_dom: Extension 返回的 DOM JSON 字符串
        max_chars: 最大输出字符数

    Returns:
        压缩后的 DOM 字符串
    """
    try:
        tree = json.loads(raw_dom)
    except (json.JSONDecodeError, TypeError):
        return raw_dom if isinstance(raw_dom, str) else str(raw_dom)

    if tree is None:
        return "{}"

    # 第一遍：裁剪深层结构
    pruned = _prune_tree(tree, max_depth=10)

    # 第二遍：合并纯文本子节点
    merged = _merge_text_nodes(pruned)

    # 序列化并检查大小
    result = json.dumps(merged, ensure_ascii=False, separators=(",", ":"))

    # 如果超过限制，逐步降低深度
    if len(result) > max_chars:
        for depth in [8, 6, 4]:
            pruned = _prune_tree(tree, max_depth=depth)
            merged = _merge_text_nodes(pruned)
            result = json.dumps(merged, ensure_ascii=False, separators=(",", ":"))
            if len(result) <= max_chars:
                break

    # 最终截断保护
    if len(result) > max_chars:
        result = result[:max_chars] + "...(truncated)"

    return result


def _prune_tree(node: dict, max_depth: int, depth: int = 0) -> Optional[dict]:
    """递归裁剪 DOM 树，限制最大深度"""
    if not isinstance(node, dict):
        return node

    # 纯文本节点
    if "t" in node and len(node) == 1:
        text = node["t"].strip()
        return {"t": text[:150]} if text else None

    result = {}

    # 复制重要属性
    for key in ["tag", "id", "class", "href", "src", "alt", "title",
                 "placeholder", "value", "type", "name", "role",
                 "aria-label", "interactive", "rect"]:
        if key in node:
            result[key] = node[key]

    # 递归处理子节点
    if "children" in node and depth < max_depth:
        children = []
        for child in node["children"]:
            compressed = _prune_tree(child, max_depth, depth + 1)
            if compressed:
                children.append(compressed)
        if children:
            result["children"] = children
    elif "children" in node and depth >= max_depth:
        # 超过深度限制时，只记录子节点数量
        count = len(node["children"])
        if count > 0:
            result["_childCount"] = count

    return result if result else None


def _merge_text_nodes(node: Any) -> Any:
    """合并连续的纯文本子节点"""
    if not isinstance(node, dict):
        return node

    if "children" not in node:
        return node

    merged_children = []
    text_buffer = []

    for child in node["children"]:
        if isinstance(child, dict) and "t" in child and len(child) == 1:
            text_buffer.append(child["t"])
        else:
            # 先刷出缓冲的文本
            if text_buffer:
                merged_text = " ".join(text_buffer)
                if len(merged_text) > 200:
                    merged_text = merged_text[:200] + "..."
                merged_children.append({"t": merged_text})
                text_buffer = []
            # 递归处理非文本子节点
            processed = _merge_text_nodes(child)
            if processed:
                merged_children.append(processed)

    # 处理尾部缓冲
    if text_buffer:
        merged_text = " ".join(text_buffer)
        if len(merged_text) > 200:
            merged_text = merged_text[:200] + "..."
        merged_children.append({"t": merged_text})

    result = {k: v for k, v in node.items() if k != "children"}
    if merged_children:
        result["children"] = merged_children

    return result
