# -*- coding: utf-8 -*-
"""
Link2Chrome Tool Descriptions 配置文件

最终工具清单：26 个统一工具（消除模式切换和重复工具）
所有 MCP Tool 的 name、description、inputSchema 集中定义在此文件。
"""


def _obj_schema(properties=None, required=None):
    return {
        "type": "object",
        "properties": properties or {},
        **({"required": required} if required else {}),
    }


TOOL_DEFINITIONS = [
    # ==================== 导航与 Session（3 个）====================
    {
        "name": "browser_navigate",
        "description": (
            "Navigate the current tab: go to a URL, go back, go forward, or reload.\n\n"
            "**When to use:**\n"
            "- Open a new page: action='goto', url='https://...'\n"
            "- Return to previous page: action='back'\n"
            "- Reload current page: action='reload'\n\n"
            "**When NOT to use:**\n"
            "- To open a URL in a NEW tab → use browser_tab(action='new', url='...')\n"
            "- To switch between existing tabs → use browser_tab(action='switch')\n\n"
            "**Example:**\n"
            "  browser_navigate(action='goto', url='https://github.com')\n"
            "  browser_navigate(action='back')"
        ),
        "inputSchema": _obj_schema(
            {
                "action": {
                    "type": "string",
                    "enum": ["goto", "back", "forward", "reload"],
                    "description": "Navigation action. Defaults to 'goto'.",
                    "default": "goto",
                },
                "url": {
                    "type": "string",
                    "description": "Destination URL. Required when action='goto'.",
                },
                "waitUntil": {
                    "type": "string",
                    "enum": ["dom-ready", "commit"],
                    "description": "Load wait strategy for 'goto'. Defaults to 'dom-ready'.",
                },
                "timeout": {
                    "type": "integer",
                    "description": "Navigation timeout in ms. Defaults to 10000.",
                },
            }
        ),
    },
    {
        "name": "browser_tab",
        "description": (
            "Manage browser tabs: create new tab, switch to a tab, or close a tab.\n\n"
            "**When to use:**\n"
            "- Open URL in new tab: action='new', url='https://...'\n"
            "- Switch to tab: action='switch', tabId=123\n"
            "- Close tab: action='close', tabId=123\n\n"
            "**When NOT to use:**\n"
            "- To navigate current tab → use browser_navigate\n"
            "- To list all tabs → use browser_tabs_list\n\n"
            "**Example:**\n"
            "  browser_tab(action='new', url='https://google.com')\n"
            "  browser_tab(action='switch', tabId=42)"
        ),
        "inputSchema": _obj_schema(
            {
                "action": {
                    "type": "string",
                    "enum": ["new", "switch", "close"],
                    "description": "Tab management action.",
                },
                "tabId": {
                    "type": "integer",
                    "description": "Target tab ID. Required for 'switch' and 'close'. Get IDs from browser_tabs_list.",
                },
                "url": {
                    "type": "string",
                    "description": "URL to open. Only used with action='new'. Defaults to blank page.",
                },
                "active": {
                    "type": "boolean",
                    "description": "Activate the new tab. Only used with action='new'. Defaults to true.",
                },
            },
            ["action"],
        ),
    },
    {
        "name": "browser_session",
        "description": (
            "Manage tab groups (sessions). Groups all tabs for one task "
            "into a Chrome tab group.\n\n"
            "**Actions:**\n"
            "- `create`: Create a new tab group and set it as the active session. "
            "Subsequent browser_navigate / browser_tab calls auto-join this group.\n"
            "- `new_tab`: Open a URL in a new tab AND add it to the session's group in one step.\n"
            "- `add`: Add an existing tab to a session's tab group.\n"
            "- `close`: Close all tabs in a session's tab group.\n"
            "- `list`: List all active sessions and their tab counts.\n\n"
            "**Typical workflow:**\n"
            "1. browser_session(action='create', session='research', group_title='调研')\n"
            "2. browser_navigate / browser_tab → tabs auto-join the active session\n"
            "3. browser_session(action='close', session='research')\n\n"
            "**Without active session:**\n"
            "  browser_session(action='new_tab', session='research', "
            "url='https://example.com', group_title='调研')\n\n"
            "**When NOT to use:**\n"
            "- Close a single tab → use browser_tab(action='close')"
        ),
        "inputSchema": _obj_schema(
            {
                "action": {
                    "type": "string",
                    "enum": ["create", "new_tab", "add", "close", "list"],
                    "description": "Tab group operation.",
                },
                "session": {
                    "type": "string",
                    "description": "Session name. Required for create, new_tab, add, close.",
                },
                "group_title": {
                    "type": "string",
                    "description": "Display title for the Chrome tab group. Used with create/new_tab. Defaults to session name.",
                },
                "url": {
                    "type": "string",
                    "description": "URL to open. Required for 'new_tab'.",
                },
                "tabId": {
                    "type": "integer",
                    "description": "Tab ID to add to the group. Required for 'add'. Get IDs from browser_tabs_list.",
                },
            },
            ["action"],
        ),
    },

    # ==================== 观测（7 个）====================
    {
        "name": "browser_tabs_list",
        "description": (
            "List all open Chrome tabs as structured JSON. Use this first when choosing a target tab."
        ),
        "inputSchema": _obj_schema(),
    },
    {
        "name": "browser_dom_overview",
        "description": (
            "Get a compact page structure overview as a multi-level markdown list. "
            "Shows headings, buttons, inputs, forms, links, and key interactive elements.\n\n"
            "**When to use:**\n"
            "- First step after navigating to a new page\n"
            "- Need to understand page layout before taking action\n"
            "- Looking for interactive elements (buttons, inputs, links)\n\n"
            "**When NOT to use:**\n"
            "- Need precise element attributes → use browser_dom_query\n"
            "- Need full article text → use browser_dom_get_text\n"
            "- Need visual layout → use browser_screenshot\n\n"
            "**Output format:** Multi-level markdown unordered list, NOT nested JSON."
        ),
        "inputSchema": _obj_schema(
            {
                "include": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Categories to include: headings, buttons, inputs, forms, links, images, tables. Defaults to all.",
                },
                "max_chars": {
                    "type": "integer",
                    "description": "Maximum output characters. Defaults to 30000.",
                },
            }
        ),
    },
    {
        "name": "browser_dom_query",
        "description": (
            "Precise CSS selector extraction. Returns structured attributes only, never raw full-page HTML."
        ),
        "inputSchema": _obj_schema(
            {
                "selector": {"type": "string", "description": "CSS selector."},
                "attributes": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Attributes to extract, e.g. text, href, src, value, data-id.",
                },
                "limit": {"type": "integer", "description": "Max elements. Defaults to 50."},
                "includeHtml": {"type": "boolean", "description": "Include truncated innerHTML if needed."},
            },
            ["selector"],
        ),
    },
    {
        "name": "browser_dom_search",
        "description": (
            "Search visible page text and return matching elements with local context."
        ),
        "inputSchema": _obj_schema(
            {
                "query": {"type": "string", "description": "Text to search for."},
                "contextLines": {"type": "integer", "description": "Sibling context count. Defaults to 2."},
                "limit": {"type": "integer", "description": "Max matches. Defaults to 20."},
                "caseSensitive": {"type": "boolean", "description": "Case-sensitive match. Defaults to false."},
            },
            ["query"],
        ),
    },
    {
        "name": "browser_dom_get_text",
        "description": (
            "Extract text content from the page. Two modes:\n"
            "1. **Readability mode** (no selector): Extract article body as clean Markdown using Mozilla Readability.\n"
            "2. **Element mode** (with selector): Read a specific element's text, accessibility metadata, and HTML snippet.\n\n"
            "**When to use:**\n"
            "- Read article/blog content → no selector, gets clean Markdown\n"
            "- Read specific element text → provide selector\n"
            "- Control output size to avoid context overflow → set max_chars\n\n"
            "**When NOT to use:**\n"
            "- Need page structure → use browser_dom_overview\n"
            "- Need element attributes (href, src) → use browser_dom_query"
        ),
        "inputSchema": _obj_schema(
            {
                "selector": {
                    "type": "string",
                    "description": "CSS selector for element mode. Omit for Readability full-page extraction.",
                },
                "max_chars": {
                    "type": "integer",
                    "description": "Maximum returned text length. Defaults to 20000. Set lower to save context.",
                    "default": 20000,
                },
                "include_meta": {
                    "type": "boolean",
                    "description": "In element mode, include accessibility name/role and computed styles. Defaults to false.",
                },
            }
        ),
    },
    {
        "name": "browser_dom_diff",
        "description": (
            "Compare current page state with the previous snapshot.\n"
            "- Same page: returns a text diff of structural changes\n"
            "- Different page: returns navigation summary (from URL → to URL)\n\n"
            "**When to use:**\n"
            "- After clicking a button, check what changed on the page\n"
            "- After form submission, verify the result appeared\n\n"
            "**When NOT to use:**\n"
            "- No previous dom_overview call in this session → call dom_overview first\n"
            "- Need full page content → use browser_dom_get_text"
        ),
        "inputSchema": _obj_schema(
            {
                "scope": {
                    "type": "string",
                    "description": "CSS selector to limit diff scope. Defaults to full page.",
                },
                "max_chars": {
                    "type": "integer",
                    "description": "Maximum diff output length. Defaults to 10000.",
                },
            }
        ),
    },
    {
        "name": "browser_screenshot",
        "description": (
            "Capture the current screen as a compressed JPEG without changing pixel dimensions.\n\n"
            "**When to use:**\n"
            "- DOM is noisy, incomplete, canvas-based, virtualized, or does not reflect the real screen\n"
            "- Need visual layout inspection or screenshot-pixel coordinates for click/drag planning\n"
            "- Use inline=true when the model should see the screenshot directly as ImageContent\n"
            "- Use inline=false or an explicit path when a local image file is needed\n\n"
            "**DOM vs screenshot:**\n"
            "- If DOM is clear and semantic, prefer browser_dom_overview/query/get_text\n"
            "- If DOM output misses key visual state, call browser_screenshot with inline=true"
        ),
        "inputSchema": _obj_schema(
            {
                "path": {
                    "type": "string",
                    "description": "Output file path. Defaults to this MCP session's temp screenshot directory.",
                },
                "inline": {
                    "type": "boolean",
                    "description": "Return compressed JPEG as ImageContent instead of writing a file. Defaults to false.",
                },
                "selector": {
                    "type": "string",
                    "description": "Optional element selector. Current implementation captures viewport.",
                },
                "fullPage": {"type": "boolean", "description": "Reserved full-page hint."},
                "format": {
                    "type": "string",
                    "enum": ["png", "jpeg"],
                    "description": "Requested browser capture format. Defaults to jpeg; server output is compressed JPEG.",
                },
                "quality": {"type": "integer", "description": "JPEG quality 1-100. Defaults to 70."},
            }
        ),
    },

    # ==================== 交互（9 个）====================
    {
        "name": "action_click",
        "description": (
            "Click an element on the page. Supports multiple targeting methods.\n\n"
            "**Targeting (pick one in target object):**\n"
            "- `selector`: CSS selector, e.g. '#submit-btn'\n"
            "- `text`: Visible text, e.g. 'Submit'\n"
            "- `ariaLabel`: Accessibility label\n"
            "- `x` + `y`: CSS pixel coordinates\n\n"
            "**When to use:**\n"
            "- Click buttons, links, menu items, checkboxes\n"
            "- Right-click for context menu: button='right'\n\n"
            "**When NOT to use:**\n"
            "- Double-click → use action_double_click\n"
            "- Type text into input → use action_fill\n"
            "- Drag element → use action_drag"
        ),
        "inputSchema": _obj_schema(
            {
                "target": {
                    "type": "object",
                    "description": "Target: {selector: '...'}, {text: '...'}, {ariaLabel: '...'}, or {x: N, y: N}.",
                },
                "button": {
                    "type": "string",
                    "enum": ["left", "right", "middle"],
                    "description": "Mouse button. Defaults to 'left'.",
                },
                "waitForNavigation": {
                    "type": "boolean",
                    "description": "Wait for page navigation after click. Defaults to false.",
                },
                "waitForSelector": {
                    "type": "string",
                    "description": "CSS selector to wait for after click (useful for dynamic content).",
                },
            },
            ["target"],
        ),
    },
    {
        "name": "action_double_click",
        "description": (
            "Double-click an element on the page. Supports selector, text, aria-label, or coordinates.\n\n"
            "**When to use:**\n"
            "- Double-click to edit text\n"
            "- Double-click to open items"
        ),
        "inputSchema": _obj_schema(
            {
                "target": {
                    "type": "object",
                    "description": "Target: {selector: '...'}, {text: '...'}, {ariaLabel: '...'}, or {x: N, y: N}.",
                },
            },
            ["target"],
        ),
    },
    {
        "name": "action_hover",
        "description": (
            "Move the mouse over an element by selector, visible text, aria-label, or CSS pixel coordinates."
        ),
        "inputSchema": _obj_schema(
            {
                "target": {
                    "type": "object",
                    "description": "selector, text, ariaLabel, or x/y CSS pixel coordinates.",
                },
            },
            ["target"],
        ),
    },
    {
        "name": "action_scroll",
        "description": (
            "Scroll the page or a specific element.\n\n"
            "**Scroll modes (pick one):**\n"
            "- `direction` + `amount`: Scroll up/down by pixels (default 500px)\n"
            "- `to`: Jump to 'top' or 'bottom'\n"
            "- `toSelector`: Scroll until element is visible\n"
            "- `untilEnd`: Keep scrolling until page bottom\n\n"
            "**When to use:**\n"
            "- Browse more content: action_scroll(direction='down')\n"
            "- Go to page bottom: action_scroll(to='bottom')\n"
            "- Scroll to element: action_scroll(toSelector='#footer')\n"
            "- Load all infinite scroll: action_scroll(untilEnd=true, maxScrolls=20)"
        ),
        "inputSchema": _obj_schema(
            {
                "direction": {
                    "type": "string",
                    "enum": ["down", "up"],
                    "description": "Scroll direction. Defaults to 'down'.",
                },
                "amount": {
                    "type": "integer",
                    "description": "Pixels to scroll. Defaults to 500.",
                },
                "to": {
                    "type": "string",
                    "enum": ["top", "bottom"],
                    "description": "Jump to page top or bottom.",
                },
                "toSelector": {
                    "type": "string",
                    "description": "Scroll until this CSS selector element is visible.",
                },
                "untilEnd": {
                    "type": "boolean",
                    "description": "Keep scrolling until no more content loads. For infinite scroll pages.",
                },
                "maxScrolls": {
                    "type": "integer",
                    "description": "Max scroll iterations when untilEnd=true. Defaults to 20.",
                },
                "waitAfter": {
                    "type": "integer",
                    "description": "Wait time in ms after scrolling for dynamic content. Defaults to 500.",
                },
            }
        ),
    },
    {
        "name": "action_drag",
        "description": (
            "Drag from an element or CSS pixel coordinate to another coordinate/element, useful for slider CAPTCHA and drag-and-drop interactions."
        ),
        "inputSchema": _obj_schema(
            {
                "target": {
                    "type": "object",
                    "description": "Drag start: selector, text, ariaLabel, or x/y CSS pixel coordinates.",
                },
                "to": {
                    "type": "object",
                    "description": "Drag end: selector, text, ariaLabel, or x/y CSS pixel coordinates.",
                },
                "by": {
                    "type": "object",
                    "description": "Relative offset from start, e.g. {\"x\": 260, \"y\": 0}.",
                },
                "duration": {
                    "type": "integer",
                    "description": "Drag duration in ms. Defaults to 500.",
                },
            },
            ["target"],
        ),
    },
    {
        "name": "action_fill",
        "description": (
            "Fill text into an input field. Clears existing content first (like Playwright's fill).\n"
            "Works on <input>, <textarea>, and [contenteditable] elements.\n\n"
            "**When to use:**\n"
            "- Fill a search box: action_fill(target={selector: '#search'}, value='query')\n"
            "- Fill by placeholder: action_fill(target={placeholder: 'Enter email'}, value='a@b.com')\n"
            "- Fill and submit: action_fill(target={selector: '#search'}, value='query', submitAfter='enter')\n\n"
            "**When NOT to use:**\n"
            "- Press Enter/Escape/shortcuts → use action_press_key\n"
            "- Click a button → use action_click\n"
            "- Fill 5+ fields at once → use playwright_run"
        ),
        "inputSchema": _obj_schema(
            {
                "target": {
                    "type": "object",
                    "description": "Target input: {selector: '...'}, {placeholder: '...'}, {name: '...'}, or {x: N, y: N}.",
                },
                "value": {
                    "type": "string",
                    "description": "Text to fill. Existing content is cleared first.",
                },
                "submitAfter": {
                    "type": "string",
                    "enum": ["enter", "tab", "none"],
                    "description": "Key to press after filling. Defaults to 'none'.",
                },
            },
            ["target", "value"],
        ),
    },
    {
        "name": "action_press_key",
        "description": (
            "Press a keyboard key or shortcut combo.\n\n"
            "**When to use:**\n"
            "- Submit form: action_press_key(key='Enter')\n"
            "- Close modal: action_press_key(key='Escape')\n"
            "- Select all: action_press_key(key='Control+A')\n"
            "- Copy: action_press_key(key='Control+C')\n"
            "- Paste: action_press_key(key='Control+V')\n\n"
            "**Supported keys:** Enter, Escape, Tab, Backspace, Delete, ArrowUp/Down/Left/Right, "
            "Home, End, PageUp, PageDown, Space, F1-F12\n"
            "**Modifiers:** Control (Ctrl), Alt, Shift, Meta (Command). Combine with '+': Control+A"
        ),
        "inputSchema": _obj_schema(
            {
                "key": {
                    "type": "string",
                    "description": "Key or shortcut combo. Examples: 'Enter', 'Escape', 'Control+A', 'Control+C'.",
                },
                "target": {
                    "type": "object",
                    "description": "Optional target to focus first: {selector: '...'}. Omit to use currently focused element.",
                },
            },
            ["key"],
        ),
    },
    {
        "name": "upload_file",
        "description": (
            "Set one or more local files on an <input type=file> element."
        ),
        "inputSchema": _obj_schema(
            {
                "selector": {"type": "string", "description": "CSS selector for the file input."},
                "paths": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Absolute local file paths to upload.",
                },
            },
            ["selector", "paths"],
        ),
    },
    {
        "name": "handle_dialog",
        "description": (
            "Accept or dismiss the current JavaScript dialog, optionally supplying prompt text."
        ),
        "inputSchema": _obj_schema(
            {
                "action": {
                    "type": "string",
                    "enum": ["accept", "dismiss"],
                    "description": "Dialog action.",
                },
                "promptText": {
                    "type": "string",
                    "description": "Text for prompt dialogs when accepting.",
                },
                "timeout": {
                    "type": "integer",
                    "description": "Wait time in ms for a dialog. Defaults to 5000.",
                },
            },
            ["action"],
        ),
    },

    # ==================== 代码执行（2 个）====================
    {
        "name": "playwright_run",
        "description": (
            "Execute a Playwright-style JavaScript snippet in a real Node.js subprocess managed by the MCP Server. "
            "The code runs with async/await support, closures, and cross-call variable persistence (variables declared with 'const' or 'let' in one tool call remain available in subsequent calls).\n\n"
            "**Execution Environment:**\n"
            "- Runs in a Node.js subprocess via stdio IPC.\n"
            "- Pre-injected globals: `browser` (Browser instance), `link2chrome` (client API namespace), `console` (redirected to MCP logs).\n"
            "- Under the hood, the Node.js process connects to the Browser Hub via WebSocket (ws://localhost:8766) and reuses the Chrome Extension + CDP transport.\n\n"
            "**When to use:**\n"
            "- Multi-step form filling (5+ fields)\n"
            "- Conditional logic (if element exists, do X, else do Y)\n"
            "- Loop through list items and extract data\n"
            "- Complex workflows that would need 5+ individual tool calls\n\n"
            "**When NOT to use:**\n"
            "- Single click or type → use action_click / action_fill\n"
            "- Just reading page content → use browser_dom_get_text\n"
            "- Just taking a screenshot → use browser_screenshot\n\n"
            "**Examples:**\n"
            "```javascript\n"
            "// Navigate and interact with a page\n"
            "const tab = await browser.tabs.selected();\n"
            "await tab.goto('https://example.com');\n"
            "await tab.playwright.locator('input[name=\"q\"]').fill('hello');\n"
            "await tab.playwright.locator('button[type=\"submit\"]').click();\n"
            "await tab.playwright.waitForLoadState('networkidle');\n"
            "return await tab.playwright.domSnapshot();\n"
            "```\n\n"
            "```javascript\n"
            "// Variable persists across tool calls (no 'const' needed in second call)\n"
            "await tab.playwright.locator('.item').nth(2).click();\n"
            "return await tab.playwright.locator('.item').count();\n"
            "```"
        ),
        "inputSchema": _obj_schema(
            {
                "code": {
                    "type": "string",
                    "description": (
                        "Playwright-style JavaScript code executed in the Node.js runtime. "
                        "Use the pre-bound `browser` and `link2chrome` objects. "
                        "Use 'return' to send serializable results back to the MCP client."
                    ),
                },
                "timeout": {
                    "type": "integer",
                    "description": "Maximum execution time in ms. Defaults to 30000.",
                },
                "max_result_chars": {
                    "type": "integer",
                    "description": "Maximum characters in the returned result. Defaults to 20000.",
                },
            },
            ["code"],
        ),
    },
    {
        "name": "script_evaluate",
        "description": (
            "Evaluate JavaScript in the page context and return JSON. Use for framework state or precise custom extraction."
        ),
        "inputSchema": _obj_schema(
            {
                "expression": {
                    "type": "string",
                    "description": "JavaScript expression or async expression.",
                },
                "awaitPromise": {
                    "type": "boolean",
                    "description": "Await promise. Defaults to true.",
                    "default": True,
                },
                "timeout": {
                    "type": "integer",
                    "description": "Timeout in ms. Defaults to 5000.",
                },
            },
            ["expression"],
        ),
    },

    # ==================== 导出与调试（5 个）====================
    {
        "name": "save_as_pdf",
        "description": (
            "Render the current page as a PDF file using Chrome's built-in print-to-PDF."
        ),
        "inputSchema": _obj_schema(
            {
                "path": {
                    "type": "string",
                    "description": "Output file path. Defaults to OS temp dir with page title as filename.",
                },
                "format": {
                    "type": "string",
                    "enum": ["a4", "letter", "legal", "a3", "tabloid"],
                    "description": "Paper format. Defaults to 'a4'.",
                },
                "landscape": {
                    "type": "boolean",
                    "description": "Landscape orientation. Defaults to false.",
                },
                "scale": {
                    "type": "number",
                    "description": "Scale factor 0.1-2.0. Defaults to 1.0.",
                },
                "printBackground": {
                    "type": "boolean",
                    "description": "Include background colors/images. Defaults to true.",
                },
            }
        ),
    },
    {
        "name": "console_check",
        "description": (
            "Manage and inspect browser console output.\n\n"
            "**Actions:**\n"
            "- `start`: Begin capturing console messages\n"
            "- `stop`: Stop capturing\n"
            "- `list`: List captured messages (supports type filter)\n"
            "- `get`: Get one message by id\n"
            "- `clear`: Clear captured messages\n"
            "- `status`: Check capture status"
        ),
        "inputSchema": _obj_schema(
            {
                "action": {
                    "type": "string",
                    "enum": ["start", "stop", "list", "get", "clear", "status"],
                    "description": "Console operation.",
                },
                "types": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Filter by console type: log, error, warn, info. Only for action='list'.",
                },
                "id": {
                    "type": "string",
                    "description": "Message id. Only for action='get'.",
                },
                "limit": {
                    "type": "integer",
                    "description": "Max results for action='list'. Defaults to 50.",
                },
                "maxEntries": {
                    "type": "integer",
                    "description": "Max retained entries for action='start'. Defaults to 300.",
                },
            },
            ["action"],
        ),
    },
    {
        "name": "network_check",
        "description": (
            "Manage and inspect network requests captured via CDP.\n\n"
            "**Actions:**\n"
            "- `start`: Begin capturing network requests\n"
            "- `stop`: Stop capturing\n"
            "- `list`: List captured requests (supports filters)\n"
            "- `query`: Advanced filter by URL, method, status, resource type\n"
            "- `fetch`: Make a fetch request from extension context (bypasses CORS)\n"
            "- `replay`: Replay a captured request\n"
            "- `clear`: Clear captured entries\n"
            "- `status`: Check capture status"
        ),
        "inputSchema": _obj_schema(
            {
                "action": {
                    "type": "string",
                    "enum": ["start", "stop", "list", "query", "fetch", "replay", "clear", "status"],
                    "description": "Network operation.",
                },
                "urlContains": {
                    "type": "string",
                    "description": "URL substring filter. For 'query' action.",
                },
                "method": {
                    "type": "string",
                    "description": "HTTP method filter. For 'list'/'query'.",
                },
                "status": {
                    "type": "integer",
                    "description": "HTTP status filter. For 'list'/'query'.",
                },
                "resourceType": {
                    "type": "string",
                    "description": "CDP resource type filter. For 'list'/'query'.",
                },
                "includeBody": {
                    "type": "boolean",
                    "description": "Include response bodies. For 'query'.",
                },
                "url": {
                    "type": "string",
                    "description": "URL to fetch. Required for 'fetch' action.",
                },
                "headers": {
                    "type": "object",
                    "description": "Request headers. For 'fetch'.",
                },
                "body": {
                    "type": "string",
                    "description": "Request body. For 'fetch'.",
                },
                "id": {
                    "type": "string",
                    "description": "Captured entry id. For 'replay'.",
                },
                "limit": {
                    "type": "integer",
                    "description": "Max results. Defaults to 50.",
                },
                "maxEntries": {
                    "type": "integer",
                    "description": "Max retained entries for 'start'. Defaults to 500.",
                },
                "includeResponseBody": {
                    "type": "boolean",
                    "description": "Store response bodies during capture. For 'start'.",
                },
            },
            ["action"],
        ),
    },
    {
        "name": "browser_scrape_with_scroll",
        "description": (
            "批量爬取工具：自动滚动页面并持续提取数据，直到达到目标数量或滚动到底部。\n"
            "整个滚动+提取过程在浏览器端一次性完成，大幅减少通信往返次数。\n\n"
            "**性能优势：**\n"
            "- 100次滚动只需 1 次 MCP 往返\n\n"
            "**参数说明：**\n"
            "- extract_script: JS 表达式，必须返回对象数组\n"
            "- dedupe_by: 指定用于去重的字段名"
        ),
        "inputSchema": _obj_schema(
            {
                "extract_script": {
                    "type": "string",
                    "description": "提取数据的 JS 表达式，必须返回对象数组。",
                },
                "max_items": {
                    "type": "integer",
                    "description": "最多提取的数据条数，达到后停止。默认 100",
                    "default": 100,
                },
                "batch_size": {
                    "type": "integer",
                    "description": "每批次连续滚动次数。默认 10",
                    "default": 10,
                },
                "scroll_delay": {
                    "type": "integer",
                    "description": "每次滚动后等待新内容加载的延迟（毫秒）。默认 500",
                    "default": 500,
                },
                "dedupe_by": {
                    "type": "string",
                    "description": "去重字段名。如 'href'、'id'。不指定则不去重",
                },
            },
            ["extract_script"],
        ),
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
        "inputSchema": _obj_schema(),
    },
]


# Public tool surface exposed to MCP clients — exactly 26 tools.
PUBLIC_TOOL_NAMES = {
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
    "browser_diagnose",
}

# Filter to ensure only public tools are exposed (defensive).
TOOL_DEFINITIONS = [
    tool for tool in TOOL_DEFINITIONS
    if tool["name"] in PUBLIC_TOOL_NAMES
]
