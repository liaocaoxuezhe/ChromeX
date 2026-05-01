# -*- coding: utf-8 -*-
"""
Link2Chrome Tool Descriptions 配置文件

所有 MCP Tool 的 name、description、inputSchema 集中定义在此文件。
修改 tool 说明只需编辑此文件，无需改动 main.py 的逻辑代码。

Tool 选择指南（写在这里帮助维护者理解设计意图）：
- 不知道页面长什么样 → 先 browser_get_state 获取状态，再 browser_get_screenshot 获取截图
- 已知 CSS 选择器 → browser_click / browser_type（直接操作，更快更稳）
- 已知坐标 → browser_click(x,y) / browser_type_at_coord（直接操作）
- 需要提取正文 → browser_extract_content（Readability 算法）
- 需要自定义提取 → browser_execute_script（运行任意 JS）
- 需要批量爬取 → browser_scrape_with_scroll（自动滚动+提取+去重）
"""

TOOL_DEFINITIONS = [
    # ==================== 页面状态与信息获取 ====================
    {
        "name": "browser_get_state",
        "description": (
            "获取当前浏览器活跃标签页的状态快照，包括 URL、标题、视口信息和压缩 DOM 树。\n"
            "【使用场景】\n"
            "- 开始操作前先了解用户当前正在看什么页面\n"
            "- 需要 DOM 树来查找可交互元素的选择器\n"
            "- 需要页面基础元信息（URL、标题、DPR、滚动位置等）\n"
            "【注意】\n"
            "- 本工具不返回截图；如需截图请调用 browser_get_screenshot\n"
            "- DOM 树经过压缩，只保留可交互元素（链接、按钮、输入框、文本），适合 LLM 消费\n"
            "- 如果只需要状态不需要 DOM，设 include_dom=false 可减少返回数据量"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "include_dom": {
                    "type": "boolean",
                    "description": "是否返回压缩 DOM 树（仅包含可交互元素）。默认 true。设为 false 可减少数据量",
                    "default": True,
                },
            },
        },
    },
    {
        "name": "browser_get_screenshot",
        "description": (
            "获取当前浏览器活跃标签页截图，返回 image/jpeg 的 base64 图片内容。\n"
            "【使用场景】\n"
            "- 需要基于截图做视觉分析或记录页面快照\n"
            "- 需要与 browser_get_state 分开调用，降低单次返回复杂度\n"
            "【注意】\n"
            "- 截图分辨率为浏览器实际视口大小，会自动处理 devicePixelRatio\n"
            "- 本工具仅返回截图，不返回 URL/DOM 等文本信息"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {},
        },
    },
    {
        "name": "browser_get_tabs",
        "description": (
            "获取所有浏览器窗口中打开的全部标签页列表。\n"
            "【返回信息】每个标签页的 tabId、URL、标题、是否活跃（active）、是否固定（pinned）。\n"
            "【使用场景】\n"
            "- 需要了解用户打开了哪些页面\n"
            "- 切换标签页前先获取 tab_index\n"
            "- 确认某个页面是否已打开"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {},
        },
    },
    {
        "name": "browser_diagnose",
        "description": (
            "诊断 Link2Chrome 系统连接状态，返回 Extension 版本、WebSocket 连接状态、当前跟踪的标签页等信息。\n"
            "【使用场景】\n"
            "- 其他 tool 调用失败时，先用此工具排查连接问题\n"
            "- 确认 Chrome Extension 是否正常连接到 MCP Server\n"
            "【注意】此工具仅用于调试，不会对浏览器产生任何操作"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {},
        },
    },

    # ==================== 导航与标签页管理 ====================
    {
        "name": "browser_action_navigate",
        "description": (
            "导航当前标签页到指定 URL，等待页面加载完成后返回。\n"
            "【使用场景】\n"
            "- 打开一个新网址\n"
            "- 跳转到特定页面\n"
            "【注意】\n"
            "- 会等待页面 load 事件触发后才返回\n"
            "- 如果需要在新标签页打开，请使用 browser_manage_tab(action='new', url='...')"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "url": {
                    "type": "string",
                    "description": "目标 URL，需包含协议前缀（如 https://）",
                },
            },
            "required": ["url"],
        },
    },
    {
        "name": "browser_go_back",
        "description": (
            "浏览器历史导航：后退或前进一步（相当于点击浏览器的 ← / → 按钮）。\n"
            "【使用场景】\n"
            "- 返回上一个页面\n"
            "- 设 forward=true 前进到下一个页面"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "forward": {
                    "type": "boolean",
                    "description": "true=前进，false=后退。默认 false（后退）",
                },
            },
        },
    },
    {
        "name": "browser_manage_tab",
        "description": (
            "管理浏览器标签页：新建、关闭、切换标签页。\n"
            "【操作类型】\n"
            "- new: 新建标签页（可指定 url，不指定则打开空白页）\n"
            "- close: 关闭指定标签页（需提供 tab_index）\n"
            "- switch: 切换到指定标签页（需提供 tab_index）\n"
            "- list: 列出所有标签页（等同于 browser_get_tabs）\n"
            "【注意】tab_index 从 0 开始，可通过 browser_get_tabs 获取"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["new", "close", "switch", "list"],
                    "description": "操作类型: new=新建, close=关闭, switch=切换, list=列出",
                },
                "tab_index": {
                    "type": "integer",
                    "description": "目标标签页索引（从 0 开始）。switch 和 close 时必填",
                },
                "url": {
                    "type": "string",
                    "description": "新标签页要打开的 URL。仅 action=new 时有效，可选",
                },
            },
            "required": ["action"],
        },
    },

    # ==================== 直接交互操作（无需视觉模型） ====================
    {
        "name": "browser_click",
        "description": (
            "直接点击页面元素。支持两种定位方式：CSS 选择器 或 坐标(x, y)。\n"
            "【使用场景】\n"
            "- 已知元素的 CSS 选择器（如从 DOM 树获取）→ 使用 selector 参数\n"
            "- 已知元素的坐标（如从截图分析或之前操作获取）→ 使用 x, y 参数\n"
            "- 需要右键点击或双击\n"
            "【注意】selector 和 x/y 二选一，同时提供时 selector 优先"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "x": {
                    "type": "number",
                    "description": "点击位置的 X 坐标（CSS 像素）。与 selector 二选一",
                },
                "y": {
                    "type": "number",
                    "description": "点击位置的 Y 坐标（CSS 像素）。与 selector 二选一",
                },
                "selector": {
                    "type": "string",
                    "description": "CSS 选择器，自动定位到元素中心并点击。与 x/y 二选一",
                },
                "button": {
                    "type": "string",
                    "enum": ["left", "right", "middle"],
                    "description": "鼠标按钮。默认 left",
                },
                "clickCount": {
                    "type": "integer",
                    "description": "点击次数。1=单击，2=双击。默认 1",
                },
            },
        },
    },
    {
        "name": "browser_type",
        "description": (
            "在输入框中输入文本。可通过 CSS 选择器指定目标输入框，或直接输入到当前焦点元素。\n"
            "【使用场景】\n"
            "- 在搜索框、表单字段中输入内容\n"
            "- 配合 clearFirst=true 替换已有文本\n"
            "【典型用法】\n"
            "- 先 browser_click(selector='#search') 聚焦，再 browser_type(text='关键词')\n"
            "- 或直接 browser_type(selector='#search', text='关键词', clearFirst=true)\n"
            "- 输入后需要按回车请单独调用 browser_send_keys(keys='Enter')\n"
            "【注意】如果不指定 selector，会输入到当前已聚焦的元素中"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "text": {
                    "type": "string",
                    "description": "要输入的文本内容",
                },
                "selector": {
                    "type": "string",
                    "description": "目标输入框的 CSS 选择器。不填则输入到当前焦点元素",
                },
                "clearFirst": {
                    "type": "boolean",
                    "description": "输入前是否先清空输入框（Ctrl+A 后删除）。默认 false",
                },
            },
            "required": ["text"],
        },
    },
    {
        "name": "browser_type_at_coord",
        "description": (
            "在指定坐标处点击聚焦后输入文本。先点击 (x, y) 使元素获得焦点，再输入文字。\n"
            "【使用场景】\n"
            "- 已知输入框坐标但不知道 CSS 选择器时\n"
            "- 从截图分析得到坐标后直接输入\n"
            "【vs browser_type】\n"
            "- browser_type 用 CSS 选择器定位，更稳定\n"
            "- browser_type_at_coord 用坐标定位，适合无法用选择器定位的场景\n"
            "【注意】输入后需要按回车请单独调用 browser_send_keys(keys='Enter')"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "x": {
                    "type": "number",
                    "description": "目标输入框的 X 坐标（CSS 像素）",
                },
                "y": {
                    "type": "number",
                    "description": "目标输入框的 Y 坐标（CSS 像素）",
                },
                "text": {
                    "type": "string",
                    "description": "要输入的文本内容",
                },
                "clearFirst": {
                    "type": "boolean",
                    "description": "输入前是否先清空输入框。默认 false",
                },
            },
            "required": ["x", "y", "text"],
        },
    },
    {
        "name": "browser_drag",
        "description": (
            "在页面上执行拖拽操作：从起点 (startX, startY) 拖动到终点 (endX, endY)。\n"
            "【使用场景】\n"
            "- 拖动滑块（如价格筛选、音量调节）\n"
            "- 拖拽排序（如拖动列表项调整顺序）\n"
            "- 拖放操作（如拖动文件到目标区域）\n"
            "【注意】坐标单位为 CSS 像素，duration 控制拖拽速度（越大越慢）"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "startX": {
                    "type": "number",
                    "description": "拖拽起点 X 坐标（CSS 像素）",
                },
                "startY": {
                    "type": "number",
                    "description": "拖拽起点 Y 坐标（CSS 像素）",
                },
                "endX": {
                    "type": "number",
                    "description": "拖拽终点 X 坐标（CSS 像素）",
                },
                "endY": {
                    "type": "number",
                    "description": "拖拽终点 Y 坐标（CSS 像素）",
                },
                "duration": {
                    "type": "integer",
                    "description": "拖拽持续时间（毫秒），越大拖得越慢。默认 500",
                },
            },
            "required": ["startX", "startY", "endX", "endY"],
        },
    },
    {
        "name": "browser_send_keys",
        "description": (
            "发送键盘按键或快捷键组合。\n"
            "【使用场景】\n"
            "- 发送快捷键：Ctrl+A（全选）、Ctrl+C（复制）、Ctrl+V（粘贴）\n"
            "- 发送特殊键：Enter、Escape、Tab、Backspace、Delete\n"
            "- 发送组合键：Shift+Enter（换行）、Alt+F4（关闭）\n"
            "【格式】修饰键用 + 连接，如 'Control+Shift+A'、'Command+C'\n"
            "【支持的修饰键】Control（或 Ctrl）、Alt、Shift、Meta（或 Command）\n"
            "【注意】可选 selector 参数，会先点击该元素使其获得焦点再发送按键"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "keys": {
                    "type": "string",
                    "description": "按键或组合键。如 'Enter'、'Control+A'、'Command+C'、'Shift+Tab'",
                },
                "selector": {
                    "type": "string",
                    "description": "可选。先点击此 CSS 选择器的元素使其获得焦点，再发送按键",
                },
            },
            "required": ["keys"],
        },
    },
    {
        "name": "browser_find_text",
        "description": (
            "在当前页面中查找包含指定文本的所有可见元素，返回匹配元素的信息（标签名、文本、位置、尺寸）。\n"
            "【使用场景】\n"
            "- 确认页面上是否存在某段文字\n"
            "- 查找按钮/链接的位置（不知道选择器时）\n"
            "- 设 click=true 可直接点击找到的第一个可见匹配元素\n"
            "【注意】基于 DOM 文本匹配，只能匹配文字内容"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "text": {
                    "type": "string",
                    "description": "要查找的文本内容（部分匹配即可）",
                },
                "click": {
                    "type": "boolean",
                    "description": "是否自动点击找到的第一个可见匹配元素。默认 false",
                    "default": False,
                },
            },
            "required": ["text"],
        },
    },

    # ==================== 滚动操作 ====================
    {
        "name": "browser_action_scroll",
        "description": (
            "滚动当前页面，支持向上或向下滚动指定像素数。\n"
            "【使用场景】\n"
            "- 向下滚动查看更多内容\n"
            "- 向上滚动回到之前的位置\n"
            "【vs browser_scroll_until】\n"
            "- browser_action_scroll: 滚动固定像素数，简单直接\n"
            "- browser_scroll_until: 智能滚动直到满足条件（到底部/元素可见），适合不确定需要滚动多少的场景"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "direction": {
                    "type": "string",
                    "enum": ["up", "down"],
                    "description": "滚动方向: up=向上, down=向下",
                },
                "amount": {
                    "type": "integer",
                    "description": "滚动像素数。默认 500（约半屏）",
                    "default": 500,
                },
            },
            "required": ["direction"],
        },
    },
    {
        "name": "browser_scroll_until",
        "description": (
            "智能滚动：持续向下滚动直到满足指定条件后停止。\n"
            "【停止条件】\n"
            "- no_more_content: 滚动到页面底部（连续两次滚动后页面高度不再变化）\n"
            "- element_visible: 滚动到指定元素出现在视口中（需配合 selector 参数）\n"
            "【使用场景】\n"
            "- 加载无限滚动页面的所有内容\n"
            "- 滚动到页面底部的「加载更多」按钮\n"
            "- 滚动到某个特定元素可见为止\n"
            "【注意】max_scrolls 用于防止无限滚动，scroll_delay 用于等待动态内容加载"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "condition": {
                    "type": "string",
                    "enum": ["no_more_content", "element_visible"],
                    "description": "停止条件: no_more_content=到达底部, element_visible=目标元素出现",
                },
                "selector": {
                    "type": "string",
                    "description": "CSS 选择器。condition=element_visible 时必填，指定要等待出现的元素",
                },
                "max_scrolls": {
                    "type": "integer",
                    "description": "最大滚动次数（防止无限循环）。默认 20",
                    "default": 20,
                },
                "scroll_delay": {
                    "type": "integer",
                    "description": "每次滚动后等待动态内容加载的延迟（毫秒）。默认 500",
                    "default": 500,
                },
            },
            "required": ["condition"],
        },
    },

    # ==================== 等待与条件判断 ====================
    {
        "name": "browser_wait",
        "description": (
            "等待指定条件满足。三种模式任选其一：\n"
            "- seconds: 固定等待 N 秒\n"
            "- selector: 等待某个 CSS 选择器的元素出现在 DOM 中\n"
            "- text: 等待页面中出现包含指定文本的元素\n"
            "【使用场景】\n"
            "- 等待页面异步加载完成\n"
            "- 等待 AJAX 请求返回后的内容出现\n"
            "- 简单的固定延迟等待\n"
            "【vs browser_wait_for_condition】\n"
            "- browser_wait: 简单等待，够用就行\n"
            "- browser_wait_for_condition: 更高级，支持网络空闲检测和自定义 JS 条件"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "seconds": {
                    "type": "number",
                    "description": "固定等待秒数。与 selector/text 三选一",
                },
                "selector": {
                    "type": "string",
                    "description": "等待此 CSS 选择器的元素出现在 DOM 中。与 seconds/text 三选一",
                },
                "text": {
                    "type": "string",
                    "description": "等待页面中出现包含此文本的元素。与 seconds/selector 三选一",
                },
                "timeout": {
                    "type": "integer",
                    "description": "超时时间（毫秒），超时后返回错误。默认 10000（10秒）",
                },
                "condition": {
                    "type": "string",
                    "enum": ["dom-ready", "timeout"],
                    "description": "Agent-first 等待条件。提供该字段时返回 JSON 结构化结果。",
                },
            },
        },
    },
    {
        "name": "browser_wait_for_condition",
        "description": (
            "高级智能等待：等待指定条件满足后返回，比固定延迟更高效。\n"
            "【条件类型】\n"
            "- visible: 等待元素在视口中可见（不仅存在于 DOM，还要实际可见）。需配合 selector\n"
            "- custom: 自定义 JS 条件表达式，表达式返回 true 时停止等待。需配合 script\n"
            "【使用场景】\n"
            "- 等待骨架屏消失、加载动画结束: visible + selector='实际内容的选择器'\n"
            "- 等待复杂条件: custom + script='document.querySelectorAll(\".item\").length >= 10'"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "condition_type": {
                    "type": "string",
                    "enum": ["visible", "custom"],
                    "description": "条件类型: visible=元素可见, custom=自定义JS条件",
                },
                "selector": {
                    "type": "string",
                    "description": "CSS 选择器。condition_type=visible 时必填",
                },
                "script": {
                    "type": "string",
                    "description": "JS 条件表达式（返回 boolean）。condition_type=custom 时必填",
                },
                "timeout": {
                    "type": "integer",
                    "description": "超时时间（毫秒）。默认 10000（10秒）",
                    "default": 10000,
                },
            },
            "required": ["condition_type"],
        },
    },

    # ==================== 内容提取与脚本执行 ====================
    {
        "name": "browser_extract_content",
        "description": (
            "使用 Mozilla Readability 算法提取当前页面的正文内容，自动过滤导航栏、侧边栏、广告等，"
            "输出干净的 Markdown 格式文本。\n"
            "【使用场景】\n"
            "- 提取文章、博客、新闻的正文内容\n"
            "- 保存网页内容到本地 Markdown 文件\n"
            "- 获取页面主要文本用于后续分析\n"
            "【vs browser_execute_script】\n"
            "- browser_extract_content: 自动提取正文，无需编写 JS，适合标准文章页\n"
            "- browser_execute_script: 自定义提取逻辑，适合非标准页面或需要特定数据"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "save_path": {
                    "type": "string",
                    "description": "保存 Markdown 文件的本地路径（如 '/tmp/article.md'）。不填则只返回内容不保存文件",
                },
            },
        },
    },
    {
        "name": "browser_execute_script",
        "description": (
            "当你需要批量获取单个页面内的内容时，可以使用这个工具\n"
            "在当前页面上下文中执行任意 JavaScript 代码，返回执行结果。\n"
            "【使用场景】\n"
            "- 提取页面上的特定数据（如商品价格、用户评论列表）\n"
            "- 执行自定义 DOM 操作（如隐藏元素、修改样式）\n"
            "- 调用页面上的 JavaScript API\n"
            "- 获取页面状态信息（如滚动位置、元素数量）\n"
            "【示例】\n"
            "- 获取所有链接: \"Array.from(document.querySelectorAll('a')).map(a => ({text: a.textContent, href: a.href}))\"\n"
            "- 获取页面标题: \"document.title\"\n"
            "- 异步操作: script='fetch(\"/api/data\").then(r => r.json())', awaitPromise=true\n"
            "【注意】\n"
            "- 脚本在页面上下文执行，可访问 document、window 等全局对象\n"
            "- 返回值会被 JSON 序列化，不支持返回 DOM 元素等不可序列化对象\n"
            "- 异步脚本需设 awaitPromise=true"
            "- 很多动态加载的页面，都会限制这个 script 的执行，如果执行失败，不要重试"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "script": {
                    "type": "string",
                    "description": "要执行的 JavaScript 代码。可以是表达式（自动返回值）或语句块",
                },
                "awaitPromise": {
                    "type": "boolean",
                    "description": "是否等待返回的 Promise 解析完成。默认 false。异步操作时设为 true",
                    "default": False,
                },
                "timeout": {
                    "type": "integer",
                    "description": "脚本执行超时时间（秒）。默认 60",
                    "default": 60,
                },
            },
            "required": ["script"],
        },
    },
    {
        "name": "browser_scrape_with_scroll",
        "description": (
            "批量爬取工具：自动滚动页面并持续提取数据，直到达到目标数量或滚动到底部。\n"
            "整个滚动+提取过程在浏览器端一次性完成，大幅减少通信往返次数。\n"
            "【使用场景】\n"
            "- 爬取无限滚动页面（小红书、B站、微博等）的内容列表\n"
            "- 批量收集搜索结果、商品列表、评论列表等\n"
            "- 需要自动去重的数据采集\n"
            "【性能优势】\n"
            "- 100次滚动只需 1 次 MCP 往返（传统方式需要 300+ 次往返）\n"
            "【参数说明】\n"
            "- extract_script: JS 表达式，必须返回对象数组，每个对象代表一条数据\n"
            "- dedupe_by: 指定用于去重的字段名，如 'href' 或 'id'，避免重复数据\n"
            "【示例 extract_script】\n"
            "- 小红书笔记: \"Array.from(document.querySelectorAll('.note-item')).map(el => ({title: el.querySelector('.title')?.textContent, link: el.querySelector('a')?.href}))\"\n"
            "- 通用列表: \"Array.from(document.querySelectorAll('.list-item')).map(el => ({text: el.textContent.trim(), href: el.querySelector('a')?.href}))\""
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "extract_script": {
                    "type": "string",
                    "description": "提取数据的 JS 表达式，必须返回对象数组。如: \"Array.from(document.querySelectorAll('.item')).map(el => ({title: el.textContent}))\"",
                },
                "max_items": {
                    "type": "integer",
                    "description": "最多提取的数据条数，达到后停止。默认 100",
                    "default": 100,
                },
                "batch_size": {
                    "type": "integer",
                    "description": "每批次连续滚动次数（影响日志中的进度报告频率）。默认 10",
                    "default": 10,
                },
                "scroll_delay": {
                    "type": "integer",
                    "description": "每次滚动后等待新内容加载的延迟（毫秒）。默认 500。加载慢的页面可增大此值",
                    "default": 500,
                },
                "dedupe_by": {
                    "type": "string",
                    "description": "去重字段名。如 'href'、'id'。不指定则不去重（可能有重复数据）",
                },
            },
            "required": ["extract_script"],
        },
    },

    # ==================== 调试与维护 ====================
    {
        "name": "browser_detach_debugger",
        "description": (
            "主动解除 Chrome Debugger 对标签页的附加。\n"
            "【使用场景】\n"
            "- 遇到 'Another debugger is already attached' 错误时\n"
            "- Chrome DevTools 与 Link2Chrome 冲突时\n"
            "- 操作完成后想去掉浏览器顶部的 '浏览器正在被自动化程序控制' 提示条\n"
            "【注意】解除后需要再次附加才能继续操作，通常由系统自动处理"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "tab_id": {
                    "type": "integer",
                    "description": "要解除调试器的标签页 ID。不填则解除当前活跃标签页",
                },
            },
        },
    },
]


# Agent-First Browser Tools (PRD v0.1)
#
# These tools intentionally return JSON-only observations. The older browser_*
# tools remain available for compatibility, while the new namespaces guide
# agents toward lightweight DOM/action workflows.

def _obj_schema(properties=None, required=None):
    return {
        "type": "object",
        "properties": properties or {},
        **({"required": required} if required else {}),
    }


TOOL_DEFINITIONS.extend([
    {
        "name": "browser_tabs_list",
        "description": "List all open Chrome tabs as structured JSON. Use this first when choosing a target tab.",
        "inputSchema": _obj_schema(),
    },
    {
        "name": "browser_tab_info",
        "description": "Get structured state for the active or specified tab: URL, title, readyState, scroll metrics, and basic navigation flags.",
        "inputSchema": _obj_schema({"tabId": {"type": "integer", "description": "Optional tab id. Defaults to the active target tab."}}),
    },
    {
        "name": "browser_tab_switch",
        "description": "Switch Chrome focus to a specific tab id and make it the Link2Chrome target tab.",
        "inputSchema": _obj_schema({"tabId": {"type": "integer", "description": "Target Chrome tab id."}}, ["tabId"]),
    },
    {
        "name": "browser_tab_new",
        "description": "Open a URL in a new tab and optionally activate it.",
        "inputSchema": _obj_schema({
            "url": {"type": "string", "description": "URL to open."},
            "active": {"type": "boolean", "description": "Whether to activate the new tab. Defaults to true."},
        }, ["url"]),
    },
    {
        "name": "browser_navigate",
        "description": "Navigate the current target tab and return JSON with finalUrl, redirected, and elapsed. Prefer this over screenshot-driven navigation.",
        "inputSchema": _obj_schema({
            "url": {"type": "string", "description": "Destination URL."},
            "waitUntil": {"type": "string", "enum": ["dom-ready"], "description": "Load wait strategy. Defaults to dom-ready."},
        }, ["url"]),
    },
    {
        "name": "browser_screenshot",
        "description": "Capture a screenshot as JSON base64. Use only when DOM/action tools cannot answer the task.",
        "inputSchema": _obj_schema({
            "selector": {"type": "string", "description": "Optional element selector. Current implementation captures viewport."},
            "fullPage": {"type": "boolean", "description": "Reserved full-page hint."},
            "format": {"type": "string", "enum": ["png", "jpeg"], "description": "Image format. Defaults to png."},
            "quality": {"type": "integer", "description": "JPEG quality 1-100."},
        }),
    },
    {
        "name": "dom_overview",
        "description": "Return a compact page overview: headings, buttons, inputs, forms, tables, links, images. Use before detailed DOM queries.",
        "inputSchema": _obj_schema({"include": {"type": "array", "items": {"type": "string"}, "description": "Optional categories to include."}}),
    },
    {
        "name": "dom_query",
        "description": "Precise CSS selector extraction. Returns structured attributes only, never raw full-page HTML.",
        "inputSchema": _obj_schema({
            "selector": {"type": "string", "description": "CSS selector."},
            "attributes": {"type": "array", "items": {"type": "string"}, "description": "Attributes to extract, e.g. text, href, src, value, data-id."},
            "limit": {"type": "integer", "description": "Max elements. Defaults to 50."},
            "includeHtml": {"type": "boolean", "description": "Include truncated innerHTML if needed."},
        }, ["selector"]),
    },
    {
        "name": "dom_search",
        "description": "Search visible page text and return matching elements with local context.",
        "inputSchema": _obj_schema({
            "query": {"type": "string", "description": "Text to search for."},
            "contextLines": {"type": "integer", "description": "Sibling context count. Defaults to 2."},
            "limit": {"type": "integer", "description": "Max matches. Defaults to 20."},
            "caseSensitive": {"type": "boolean", "description": "Case-sensitive match. Defaults to false."},
        }, ["query"]),
    },
    {
        "name": "dom_structured_data",
        "description": "Extract JSON-LD, Open Graph, Twitter Cards, and key meta tags. Prefer this over scraping visible DOM when available.",
        "inputSchema": _obj_schema(),
    },
    {
        "name": "dom_element_detail",
        "description": "Inspect one element after locating it with dom_query/search. Can include attributes, styles, position, and accessibility summary.",
        "inputSchema": _obj_schema({
            "selector": {"type": "string", "description": "CSS selector for one element."},
            "include": {"type": "array", "items": {"type": "string"}, "description": "attributes, styles, position, accessibility."},
        }, ["selector"]),
    },
    {
        "name": "dom_wait_for",
        "description": "Wait for an element state: present, visible, hidden, or enabled.",
        "inputSchema": _obj_schema({
            "selector": {"type": "string", "description": "CSS selector."},
            "state": {"type": "string", "enum": ["present", "visible", "hidden", "enabled"], "description": "Desired state. Defaults to visible."},
            "timeout": {"type": "integer", "description": "Timeout in ms. Defaults to 10000."},
        }, ["selector"]),
    },
    {
        "name": "action_click",
        "description": "Click an element by selector, visible text, or aria-label. Returns a compact effects summary instead of full page state.",
        "inputSchema": _obj_schema({
            "target": {"type": "object", "description": "selector, text, or ariaLabel."},
            "method": {"type": "string", "enum": ["js", "cdp"], "description": "Click method hint. Current implementation uses CDP."},
            "waitForNavigation": {"type": "boolean", "description": "Reserved for navigation waits."},
            "waitForSelector": {"type": "string", "description": "Selector to wait for after click."},
        }, ["target"]),
    },
    {
        "name": "action_type",
        "description": "Type text into an input found by selector, name, or placeholder.",
        "inputSchema": _obj_schema({
            "target": {"type": "object", "description": "selector, name, or placeholder."},
            "text": {"type": "string", "description": "Text to enter."},
            "clearFirst": {"type": "boolean", "description": "Clear existing value first. Defaults to true."},
            "submitAfter": {"type": "string", "enum": ["enter", "tab", "none"], "description": "Optional key after typing."},
        }, ["target", "text"]),
    },
    {
        "name": "action_scroll",
        "description": "Scroll by amount, to top/bottom, or to a selector. Returns scroll metrics and bottom detection.",
        "inputSchema": _obj_schema({
            "direction": {"type": "string", "enum": ["down", "up"], "description": "Scroll direction. Defaults to down."},
            "amount": {"type": "integer", "description": "Pixels to scroll. Defaults to 500."},
            "to": {"type": "string", "enum": ["top", "bottom"], "description": "Jump to top or bottom."},
            "toSelector": {"type": "string", "description": "Scroll element into view."},
            "waitAfter": {"type": "integer", "description": "Wait after scrolling in ms. Defaults to 500."},
        }),
    },
    {
        "name": "action_select",
        "description": "Select an option in a select element by value or visible text.",
        "inputSchema": _obj_schema({
            "target": {"type": "object", "description": "selector, name, or ariaLabel."},
            "value": {"type": "string", "description": "Option value or text."},
            "by": {"type": "string", "enum": ["value", "text"], "description": "Match mode."},
        }, ["target", "value"]),
    },
    {
        "name": "action_hover",
        "description": "Move the mouse over an element by selector or visible text.",
        "inputSchema": _obj_schema({"target": {"type": "object", "description": "selector or text."}}, ["target"]),
    },
    {
        "name": "action_press_key",
        "description": "Press a key or shortcut, optionally focusing a selector first.",
        "inputSchema": _obj_schema({
            "key": {"type": "string", "description": "Key or shortcut, e.g. Enter, Escape, Control+A."},
            "target": {"type": "object", "description": "Optional selector target."},
        }, ["key"]),
    },
    {
        "name": "action_fill_form",
        "description": "Fill multiple form fields in one tool call and optionally submit.",
        "inputSchema": _obj_schema({
            "formSelector": {"type": "string", "description": "Optional form scope."},
            "fields": {"type": "array", "items": {"type": "object"}, "description": "Fields with name or selector, value, and optional type."},
            "submit": {"type": "boolean", "description": "Submit after filling."},
        }, ["fields"]),
    },
    {
        "name": "script_evaluate",
        "description": "Evaluate JavaScript in the page context and return JSON. Use for framework state or precise custom extraction.",
        "inputSchema": _obj_schema({
            "expression": {"type": "string", "description": "JavaScript expression or async expression."},
            "awaitPromise": {"type": "boolean", "description": "Await promise. Defaults to true."},
            "timeout": {"type": "integer", "description": "Timeout in ms. Defaults to 5000."},
        }, ["expression"]),
    },
    {
        "name": "file_write",
        "description": "Write text or JSON to the local agent-browser storage directory. This approximates the PRD OPFS layer from the MCP server side.",
        "inputSchema": _obj_schema({
            "path": {"type": "string", "description": "Storage path."},
            "content": {"description": "Text or JSON content."},
            "mode": {"type": "string", "enum": ["overwrite", "append"], "description": "Write mode. Defaults to overwrite."},
        }, ["path", "content"]),
    },
    {
        "name": "file_read",
        "description": "Read text or JSON from local agent-browser storage. Can apply a JMESPath query to JSON files.",
        "inputSchema": _obj_schema({
            "path": {"type": "string", "description": "Storage path."},
            "query": {"type": "string", "description": "Optional JMESPath query."},
            "offset": {"type": "integer", "description": "Line offset for text files."},
            "limit": {"type": "integer", "description": "Line limit for text files."},
        }, ["path"]),
    },
    {
        "name": "file_list",
        "description": "List files in local agent-browser storage.",
        "inputSchema": _obj_schema({
            "path": {"type": "string", "description": "Storage directory. Defaults to root."},
            "recursive": {"type": "boolean", "description": "List recursively."},
        }),
    },
])
