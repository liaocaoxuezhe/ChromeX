<p align="center">
  <img src="extension/icons/readme_logo.png" width="128" alt="Link2Chrome Logo">
</p>

# Link2Chrome

Link2Chrome 是一个本地优先的浏览器自动化项目，通过 Chrome 扩展、WebSocket 和 MCP Server 将本地 Agent 与真实浏览器连接起来，让 Agent 可以导航页面、执行点击/输入/滚动、读取 DOM、截图、运行 Playwright 风格的自动化脚本，以及管理多任务 Session（标签组）。

## 功能概览

- **本地 MCP Server**：通过 stdio 向 Claude Code 暴露 26 个统一浏览器工具。
- **Chrome 扩展**：基于 Manifest V3，通过 `chrome.debugger` 调用 Chrome DevTools Protocol，并用 alarms keepalive 强化连接稳定性。
- **WebSocket 桥接**：Server 与扩展之间通过本地 WebSocket 通信。
- **页面观察**：URL、标题、截图、Markdown 格式 DOM 概览、DOM diff、正文提取、元素查询。
- **浏览器操作**：导航、点击、双击、悬停、输入、滚动、拖拽、按键、对话框处理、文件上传。
- **playwright_run**：以代码为动作——向扩展发送 JavaScript 代码片段，通过内置 page shim 执行多步骤自动化，无需切换模式。
- **Session 机制**：一个任务对应一个 Session，映射到 Chrome 标签组，支持跨标签的多任务并发。
- **save_as_pdf**：通过 CDP `Page.printToPDF` 将当前页面保存为 PDF 文件。
- **控制台 & 网络监控**：统一的 `console_check` 和 `network_check` 工具，支持捕获、查询、重放。

## 工具列表（26 个）

| 类别 | 工具 |
|------|------|
| 导航 & 标签 | `browser_navigate`, `browser_tab`, `browser_tabs_list`, `browser_session` |
| DOM 观察 | `browser_dom_overview`, `browser_dom_query`, `browser_dom_search`, `browser_dom_get_text`, `browser_dom_diff` |
| 截图 & 内容 | `browser_screenshot`, `browser_scrape_with_scroll` |
| 动作 | `action_click`, `action_double_click`, `action_hover`, `action_scroll`, `action_drag`, `action_fill`, `action_press_key` |
| 文件 & 对话框 | `upload_file`, `handle_dialog` |
| 脚本 & 自动化 | `playwright_run`, `script_evaluate`, `save_as_pdf` |
| 监控 & 诊断 | `console_check`, `network_check`, `browser_diagnose` |

## 目录结构

```text
.
├── extension/                  # Chrome 扩展源码
├── server/                     # Python MCP Server
│   ├── main.py                 # MCP 入口，call_tool 路由
│   ├── tool_descriptions.py    # 26 个工具定义
│   ├── session_manager.py      # Session → Chrome 标签组映射
│   ├── dom_snapshot_cache.py   # DOM 快照与 diff 计算
│   ├── dom_compressor.py       # DOM → Markdown 压缩
│   └── playwright_runtime.py  # playwright_run 编排
├── docs/                       # 使用说明和设计文档
├── test/                       # 测试脚本（含 test_tools.py）
├── claude_config_snippet.json  # Claude Code MCP 配置示例
├── setup.sh                    # 本地安装脚本
└── server/requirements.txt     # Python 依赖
```

## 环境要求

- Python 3.10+
- Chrome / Chromium
- Claude Code

当前 MCP Python SDK 要求 Python 3.10 或更高版本。如果本机默认 Python 是 3.9，请先安装 `python3.10`、`python3.11` 或 `python3.12`，再由安装脚本创建隔离虚拟环境，避免污染系统环境。

## 快速开始

```bash
./setup.sh
```

安装脚本会创建 `server/venv`，安装服务端依赖，并在缺少 `.env` 时生成配置模板。

手动安装方式：

```bash
python3.10 -m venv server/venv
server/venv/bin/pip install -r server/requirements.txt
```

然后在项目根目录创建 `.env`：

```env
LOG_LEVEL=INFO
LINK2CHROME_BROWSER=chrome
```

## 加载 Chrome 扩展

先安装开发者模式 Native Host bootstrap：

```bash
node scripts/dev-extension/install.mjs
```

脚本会基于 `extension/manifest.json` 中的固定 key 推导扩展 ID，并写入 Chrome Native Messaging Host manifest。然后：

1. 打开 `chrome://extensions/`
2. 开启「开发者模式」
3. 如果之前加载过同一个 `extension/` 但扩展 ID 不是 `gfmbcnhkhgdlpcdhmolaefigfapbamcg`，先移除旧项
4. 点击「加载已解压的扩展程序」
5. 选择本项目的 `extension/` 目录
6. 打开扩展 popup，确认显示 `Native Host + :8765` 或已连接状态

## 配置 Claude Code

将 `claude_config_snippet.json` 中的配置合并到 Claude Code 的配置文件中，并根据本机路径调整 `command`、`args` 和 `cwd`。

## playwright_run 示例

对于需要 3 步以上、含条件逻辑或循环的操作，推荐使用 `playwright_run` 一次发送代码，而不是逐个调用 MCP 工具：

```javascript
// 登录表单示例
await page.locator('#username').fill('user@example.com');
await page.locator('#password').fill('secret');
await page.locator('button[type=submit]').click();
await page.waitForSelector('.dashboard', { timeout: 5000 });
const title = await page.title();
return title;
```

```javascript
// 数据提取示例
const rows = await page.evaluate(() => {
  return Array.from(document.querySelectorAll('table tr')).map(r => r.innerText);
});
return rows;
```

page shim 支持的 API：`locator`、`getByText`、`getByRole`、`getByLabel`、`getByPlaceholder`、`waitForSelector`、`waitForTimeout`、`evaluate`、`title`、`url`、`goto`、`screenshot`。

## Session 机制

每个任务可以绑定一个命名 Session，对应 Chrome 中的一个标签组：

```
# 创建 session
browser_session(action="create", session="research", group_title="调研")

# 新建标签
browser_tab(action="new", url="https://example.com")

# 将标签加入 session
browser_session(action="add", session="research", tabId=123)

# 关闭 session 及其所有标签
browser_session(action="close", session="research")

# 列出所有活跃 session
browser_session(action="list")
```

## 开发与测试

```bash
# 运行所有工具定义验证（不需要浏览器连接）
server/venv/bin/python -m pytest test/test_tools.py -v

# 运行完整测试套件
server/venv/bin/python -m pytest test
node --test test/runtime-client.test.mjs
```

## 安全提示

- 不要提交 `.env`、日志、缓存、虚拟环境或运行输出。
- Chrome 扩展使用 `debugger` 权限，请只在可信环境中加载和运行。

## License

MIT License. See [LICENSE](LICENSE) for details.
