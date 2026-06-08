# -*- coding: utf-8 -*-
"""
DOM 压缩算法

将 Extension 返回的 DOM JSON 进一步压缩，去除冗余信息，
保留关键结构并以多层级 markdown 无序列表格式输出。
"""

import json
import logging
from typing import Any, Optional

logger = logging.getLogger("link2chrome.dom")

# 默认最大输出字符数限制
MAX_OUTPUT_CHARS = 30000


def compress_dom(raw_dom: str, max_chars: int = MAX_OUTPUT_CHARS) -> str:
    """
    压缩 DOM JSON 字符串，返回多层级 markdown 无序列表格式。

    Args:
        raw_dom: Extension 返回的 DOM JSON 字符串
        max_chars: 最大输出字符数

    Returns:
        markdown 格式的 DOM 结构字符串
    """
    try:
        tree = json.loads(raw_dom)
    except (json.JSONDecodeError, TypeError):
        # 如果输入不是合法 JSON，直接返回字符串表示
        text = raw_dom if isinstance(raw_dom, str) else str(raw_dom)
        if len(text) > max_chars:
            text = text[:max_chars] + "\n...(truncated)"
        return text

    if tree is None or not isinstance(tree, dict):
        return "- (empty)"

    lines = []
    _build_markdown(tree, lines, depth=0)

    if not lines:
        return "- (empty)"

    result = "\n".join(lines)

    # 如果超过限制，逐层截断
    if len(result) > max_chars:
        result = _truncate_markdown(result, max_chars)

    return result


def _build_markdown(node: Any, lines: list[str], depth: int) -> None:
    """递归构建 markdown 列表行。"""
    if not isinstance(node, dict):
        return

    indent = "  " * depth

    # 纯文本节点 {t: "..."}
    if "t" in node and len(node) == 1:
        text = node["t"].strip()
        if text:
            lines.append(f"{indent}- {text[:200]}{'...' if len(text) > 200 else ''}")
        return

    tag = node.get("tag", "div")
    elem_id = node.get("id", "")
    classes = node.get("class", "")
    href = node.get("href", "")
    src = node.get("src", "")
    alt = node.get("alt", "")
    placeholder = node.get("placeholder", "")
    value = node.get("value", "")
    name = node.get("name", "")
    role = node.get("role", "")
    aria_label = node.get("aria-label", "")
    interactive = node.get("interactive", False)
    elem_type = node.get("type", "")

    # 构建标签描述
    tag_desc = tag
    if elem_id:
        tag_desc += f"#{elem_id}"
    elif classes:
        # 只取前两个 class
        cls_parts = classes.split()[:2]
        tag_desc += "." + ".".join(cls_parts)

    # 构建属性摘要
    attrs = []
    if interactive:
        attrs.append("[interactive]")
    if placeholder:
        attrs.append(f"placeholder: '{placeholder[:60]}'")
    if value and tag in ("input", "textarea", "select"):
        attrs.append(f"value: '{value[:60]}'")
    if aria_label:
        attrs.append(f"aria-label: '{aria_label[:60]}'")
    if role:
        attrs.append(f"role={role}")
    if href:
        attrs.append(f"href={href[:80]}")
    if src:
        attrs.append(f"src={src[:80]}")
    if alt:
        attrs.append(f"alt='{alt[:60]}'")
    if name:
        attrs.append(f"name={name}")
    if elem_type:
        attrs.append(f"type={elem_type}")

    # 构建当前行文本
    line = f"{indent}- {tag_desc}"
    if attrs:
        line += " " + " ".join(attrs)

    children = node.get("children", [])

    # 同类元素折叠检测：如果 children 全是同 tag 且无 id，尝试折叠
    if children and _should_fold(children):
        folded = _fold_children(children)
        # 如果折叠后有内容，直接输出折叠行，不再递归
        if folded:
            lines.append(line)
            for f_line in folded:
                lines.append(f"{indent}  {f_line}")
            return

    lines.append(line)

    # 递归处理子节点
    for child in children:
        _build_markdown(child, lines, depth + 1)


def _should_fold(children: list[dict]) -> bool:
    """判断是否应该折叠子节点。"""
    if len(children) < 3:
        return False
    tags = set()
    has_ids = False
    for c in children:
        if not isinstance(c, dict):
            return False
        if c.get("id"):
            has_ids = True
        tags.add(c.get("tag", ""))
    # 只有所有子节点 tag 相同，且没有 id 时才折叠
    return len(tags) == 1 and not has_ids


def _fold_children(children: list[dict]) -> list[str]:
    """折叠同类子节点，返回折叠后的 markdown 行列表。"""
    if not children:
        return []

    tag = children[0].get("tag", "div")
    cls = children[0].get("class", "")
    total = len(children)

    # 统计有文本内容的子节点
    texts = []
    for c in children:
        t = c.get("t", "")
        if t:
            texts.append(t.strip())

    desc = tag
    if cls:
        desc += "." + cls.split()[0]

    lines = [f"- {desc} × {total}"]

    # 如果子节点是纯文本或简单链接，列出前几个示例
    if texts:
        for t in texts[:3]:
            lines.append(f"  - '{t[:80]}'")
        if len(texts) > 3:
            lines.append(f"  - ... and {len(texts) - 3} more")

    return lines


def _truncate_markdown(text: str, max_chars: int) -> str:
    """截断 markdown 文本，尽量在列表项边界处截断。"""
    if len(text) <= max_chars:
        return text

    # 找到最后一个完整的列表项边界
    truncate_at = text.rfind("\n- ", 0, max_chars - 50)
    if truncate_at <= 0:
        truncate_at = max_chars

    return text[:truncate_at] + "\n...(truncated)"


def _prune_tree(node: dict, max_depth: int, depth: int = 0) -> Optional[dict]:
    """（保留供内部使用）递归裁剪 DOM 树，限制最大深度。"""
    if not isinstance(node, dict):
        return node

    if "t" in node and len(node) == 1:
        text = node["t"].strip()
        return {"t": text[:150]} if text else None

    result = {}
    for key in ["tag", "id", "class", "href", "src", "alt", "title",
                "placeholder", "value", "type", "name", "role",
                "aria-label", "interactive", "rect"]:
        if key in node:
            result[key] = node[key]

    if "children" in node and depth < max_depth:
        children = []
        for child in node["children"]:
            compressed = _prune_tree(child, max_depth, depth + 1)
            if compressed:
                children.append(compressed)
        if children:
            result["children"] = children
    elif "children" in node and depth >= max_depth:
        count = len(node["children"])
        if count > 0:
            result["_childCount"] = count

    return result if result else None


def _merge_text_nodes(node: Any) -> Any:
    """（保留供内部使用）合并连续的纯文本子节点。"""
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
            if text_buffer:
                merged_text = " ".join(text_buffer)
                if len(merged_text) > 200:
                    merged_text = merged_text[:200] + "..."
                merged_children.append({"t": merged_text})
                text_buffer = []
            processed = _merge_text_nodes(child)
            if processed:
                merged_children.append(processed)

    if text_buffer:
        merged_text = " ".join(text_buffer)
        if len(merged_text) > 200:
            merged_text = merged_text[:200] + "..."
        merged_children.append({"t": merged_text})

    result = {k: v for k, v in node.items() if k != "children"}
    if merged_children:
        result["children"] = merged_children

    return result
