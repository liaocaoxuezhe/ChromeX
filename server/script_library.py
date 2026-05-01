"""
预定义 JavaScript 脚本库
用于高性能爬虫操作(表格提取、滚动加载、链接提取等)
"""

from dataclasses import dataclass
from typing import Dict


@dataclass
class ScraperScript:
    """脚本定义"""
    name: str
    description: str
    script: str
    await_promise: bool = False  # 是否等待异步执行


class CommonScraperScripts:
    """通用爬虫脚本库"""

    @staticmethod
    def extract_table(selector: str = "table") -> ScraperScript:
        """
        提取表格数据为 JSON 格式

        Args:
            selector: 表格的 CSS 选择器
        """
        script = f"""
        (function() {{
            const tables = document.querySelectorAll('{selector}');
            if (tables.length === 0) return JSON.stringify({{error: "未找到表格"}});

            const result = [];
            tables.forEach((table, tableIdx) => {{
                const rows = Array.from(table.querySelectorAll('tr'));
                const headers = [];
                const data = [];

                rows.forEach((row, rowIdx) => {{
                    const cells = Array.from(row.querySelectorAll('th, td'));
                    const cellData = cells.map(cell => cell.textContent.trim());

                    if (rowIdx === 0 && row.querySelectorAll('th').length > 0) {{
                        headers.push(...cellData);
                    }} else {{
                        data.push(cellData);
                    }}
                }});

                result.push({{
                    tableIndex: tableIdx,
                    headers: headers.length > 0 ? headers : null,
                    rows: data
                }});
            }});

            return JSON.stringify(result);
        }})()
        """
        return ScraperScript(
            name="extract_table",
            description=f"提取页面中的表格数据 (selector: {selector})",
            script=script,
            await_promise=False
        )

    @staticmethod
    def extract_links(selector: str = "a", filter_pattern: str = None) -> ScraperScript:
        """
        批量提取链接

        Args:
            selector: 限定范围的选择器
            filter_pattern: URL 过滤正则表达式(可选)
        """
        filter_js = ""
        if filter_pattern:
            filter_js = f".filter(link => /{filter_pattern}/.test(link.href))"

        script = f"""
        (function() {{
            const links = Array.from(document.querySelectorAll('{selector}'))
                {filter_js}
                .map(link => ({{
                    text: link.textContent.trim(),
                    href: link.href,
                    title: link.title || null,
                    target: link.target || null
                }}));

            return JSON.stringify(links);
        }})()
        """
        return ScraperScript(
            name="extract_links",
            description=f"提取链接 (selector: {selector}, filter: {filter_pattern or 'none'})",
            script=script,
            await_promise=False
        )

    @staticmethod
    def scroll_load_all(
        max_scrolls: int = 20,
        scroll_delay: int = 500,
        no_change_threshold: int = 3
    ) -> ScraperScript:
        """
        无限滚动加载,直到页面高度不再变化

        Args:
            max_scrolls: 最大滚动次数
            scroll_delay: 每次滚动后的延迟(毫秒)
            no_change_threshold: 高度不变的次数阈值
        """
        script = f"""
        (async function() {{
            let lastHeight = document.body.scrollHeight;
            let noChangeCount = 0;
            let scrollCount = 0;

            while (scrollCount < {max_scrolls}) {{
                window.scrollTo(0, document.body.scrollHeight);
                await new Promise(r => setTimeout(r, {scroll_delay}));

                const newHeight = document.body.scrollHeight;
                if (newHeight === lastHeight) {{
                    noChangeCount++;
                    if (noChangeCount >= {no_change_threshold}) {{
                        break;
                    }}
                }} else {{
                    noChangeCount = 0;
                    lastHeight = newHeight;
                }}

                scrollCount++;
            }}

            return JSON.stringify({{
                scrolled: scrollCount,
                finalHeight: document.body.scrollHeight,
                reachedBottom: noChangeCount >= {no_change_threshold}
            }});
        }})()
        """
        return ScraperScript(
            name="scroll_load_all",
            description="无限滚动加载直到页面底部",
            script=script,
            await_promise=True
        )

    @staticmethod
    def get_all_images(min_width: int = 100, min_height: int = 100) -> ScraperScript:
        """
        提取页面中的所有图片 URL

        Args:
            min_width: 最小宽度过滤
            min_height: 最小高度过滤
        """
        script = f"""
        (function() {{
            const images = Array.from(document.querySelectorAll('img'))
                .filter(img => img.naturalWidth >= {min_width} && img.naturalHeight >= {min_height})
                .map(img => ({{
                    src: img.src,
                    alt: img.alt || null,
                    width: img.naturalWidth,
                    height: img.naturalHeight
                }}));

            return JSON.stringify(images);
        }})()
        """
        return ScraperScript(
            name="get_all_images",
            description=f"提取图片 (min: {min_width}x{min_height})",
            script=script,
            await_promise=False
        )

    @staticmethod
    def check_element_visible(selector: str) -> ScraperScript:
        """
        检查元素是否可见

        Args:
            selector: CSS 选择器
        """
        script = f"""
        (function() {{
            const el = document.querySelector('{selector}');
            if (!el) return JSON.stringify({{exists: false, visible: false}});

            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            const isVisible = rect.width > 0 && rect.height > 0
                && style.display !== 'none'
                && style.visibility !== 'hidden'
                && style.opacity !== '0';

            return JSON.stringify({{
                exists: true,
                visible: isVisible,
                rect: {{x: rect.x, y: rect.y, w: rect.width, h: rect.height}}
            }});
        }})()
        """
        return ScraperScript(
            name="check_element_visible",
            description=f"检查元素可见性 ({selector})",
            script=script,
            await_promise=False
        )


class XiaohongshuScripts:
    """小红书专用爬虫脚本"""

    @staticmethod
    def extract_note_cards() -> ScraperScript:
        """提取小红书笔记卡片数据"""
        script = """
        (function() {
            // 尝试多种可能的选择器
            const selectors = [
                'section.note-item',
                '.note-item',
                '[class*="note-item"]',
                '[class*="feed-card"]',
                'a[href*="/explore/"]'
            ];

            let notes = [];
            for (const selector of selectors) {
                const elements = document.querySelectorAll(selector);
                if (elements.length > 0) {
                    notes = Array.from(elements).map(note => {
                        const titleEl = note.querySelector('.title, [class*="title"]');
                        const authorEl = note.querySelector('.author, [class*="author"]');
                        const likesEl = note.querySelector('[class*="like"], [class*="interaction"]');
                        const imgEl = note.querySelector('img');
                        const linkEl = note.closest('a') || note.querySelector('a');

                        return {
                            title: titleEl?.textContent?.trim() || null,
                            author: authorEl?.textContent?.trim() || null,
                            likes: likesEl?.textContent?.trim() || null,
                            image: imgEl?.src || null,
                            link: linkEl?.href || null
                        };
                    });
                    break;
                }
            }

            return JSON.stringify({
                count: notes.length,
                notes: notes
            });
        })()
        """
        return ScraperScript(
            name="xiaohongshu_extract_notes",
            description="提取小红书笔记卡片",
            script=script,
            await_promise=False
        )

    @staticmethod
    def extract_user_info() -> ScraperScript:
        """提取小红书用户主页信息"""
        script = """
        (function() {
            return JSON.stringify({
                username: document.querySelector('.user-name, [class*="username"]')?.textContent?.trim() || null,
                bio: document.querySelector('.user-desc, [class*="desc"]')?.textContent?.trim() || null,
                followers: document.querySelector('[class*="follower"]')?.textContent?.trim() || null,
                following: document.querySelector('[class*="following"]')?.textContent?.trim() || null,
                noteCount: document.querySelector('[class*="note-count"]')?.textContent?.trim() || null
            });
        })()
        """
        return ScraperScript(
            name="xiaohongshu_user_info",
            description="提取用户主页信息",
            script=script,
            await_promise=False
        )

    @staticmethod
    def extract_comments() -> ScraperScript:
        """提取评论列表"""
        script = """
        (function() {
            const commentItems = document.querySelectorAll('.comment-item, [class*="comment-item"]');
            const comments = Array.from(commentItems).map(item => ({
                author: item.querySelector('.author, [class*="nickname"]')?.textContent?.trim() || null,
                content: item.querySelector('.content, [class*="content"]')?.textContent?.trim() || null,
                likes: item.querySelector('[class*="like"]')?.textContent?.trim() || null,
                time: item.querySelector('.time, [class*="time"]')?.textContent?.trim() || null
            }));

            return JSON.stringify({
                count: comments.length,
                comments: comments
            });
        })()
        """
        return ScraperScript(
            name="xiaohongshu_comments",
            description="提取评论列表",
            script=script,
            await_promise=False
        )


# 导出所有预定义脚本
SCRIPT_REGISTRY: Dict[str, ScraperScript] = {}


def register_common_scripts():
    """注册通用脚本到注册表"""
    # 这些脚本需要参数,所以注册为工厂函数
    pass


def get_script(script_name: str, **kwargs) -> ScraperScript:
    """
    获取预定义脚本

    Args:
        script_name: 脚本名称
        **kwargs: 脚本参数

    Returns:
        ScraperScript 实例

    Raises:
        ValueError: 如果脚本不存在
    """
    # 通用脚本
    if script_name == "extract_table":
        return CommonScraperScripts.extract_table(
            selector=kwargs.get("selector", "table")
        )
    elif script_name == "extract_links":
        return CommonScraperScripts.extract_links(
            selector=kwargs.get("selector", "a"),
            filter_pattern=kwargs.get("filter_pattern")
        )
    elif script_name == "scroll_load_all":
        return CommonScraperScripts.scroll_load_all(
            max_scrolls=kwargs.get("max_scrolls", 20),
            scroll_delay=kwargs.get("scroll_delay", 500),
            no_change_threshold=kwargs.get("no_change_threshold", 3)
        )
    elif script_name == "get_all_images":
        return CommonScraperScripts.get_all_images(
            min_width=kwargs.get("min_width", 100),
            min_height=kwargs.get("min_height", 100)
        )
    elif script_name == "check_element_visible":
        return CommonScraperScripts.check_element_visible(
            selector=kwargs.get("selector", "body")
        )
    # 小红书脚本
    elif script_name == "xiaohongshu_extract_notes":
        return XiaohongshuScripts.extract_note_cards()
    elif script_name == "xiaohongshu_user_info":
        return XiaohongshuScripts.extract_user_info()
    elif script_name == "xiaohongshu_comments":
        return XiaohongshuScripts.extract_comments()
    else:
        raise ValueError(f"未知脚本: {script_name}")
