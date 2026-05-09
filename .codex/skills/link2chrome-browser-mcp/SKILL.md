---
name: link2chrome-browser-mcp
description: Use when controlling Chrome through the Link2Chrome MCP server, inspecting live webpages, extracting DOM/content, navigating tabs, or performing browser actions with observe-think-act discipline.
---

# Link2Chrome Browser MCP

## 核心品味

把浏览器当成仪表盘，不要当成一张截图。优先相信 DOM 事实、结构化数据和可验证的小动作；只有布局、Canvas、图片内容或视觉确认重要时，才动用截图。

## 工具地图

- **连接诊断**：工具失败、标签页不对、扩展状态不明时，用 `browser_diagnose`。
- **标签页**：`browser_tabs_list` -> `browser_tab_switch` / `browser_tab_new` -> `browser_tab_info`。
- **导航**：`browser_navigate` 后，用 `browser_tab_info` 或 `dom_overview` 验证。
- **观察**：先 `dom_overview`；再用 `dom_query`、`dom_search`、`dom_element_detail` 缩小范围；元数据优先 `dom_structured_data`。
- **等待**：导航或动作之后，用 `dom_wait_for` 等待具体 DOM 状态。
- **动作**：`action_click`、`action_type`、`action_scroll`、`action_drag`、`action_press_key`。
- **提取**：文章用 `browser_extract_content`；无限列表用 `browser_scrape_with_scroll`；精确自定义逻辑才用 `script_evaluate`。
- **视觉兜底**：DOM 回答不了时，用 `browser_screenshot`。

## 观察-思考-操作

1. **观察**：收集最低成本、最可靠的事实。
   - 未知页面：`browser_tab_info` + `dom_overview`。
   - 找目标：文本用 `dom_search`，选择器用 `dom_query`。
   - 看单个节点：`dom_element_detail`，按需带 `position` 或 `accessibility`。
2. **思考**：选择能改变页面的最小工具。
   - selector 优于 text，text 优于坐标。
   - 等待具体后置条件，不等随手写的秒数。
   - 写 JS 前先问：已有 DOM/action 工具是否已经足够表达意图。
3. **操作**：只做一个有意义的动作。
   - 点击、输入、滚动、拖拽、按键。
   - 立刻用 `dom_wait_for`、`dom_overview`、`dom_query` 或 `browser_tab_info` 验证效果。
4. **循环**：用新观察继续下一步。不要拿过期 DOM 连续猜测操作。

## 常用配方

- **打开并检查页面**：`browser_navigate` -> `dom_wait_for{"selector":"body"}` -> `dom_overview`。
- **按可见文案点击**：`dom_search` -> 若 selector 可信则优先 selector -> `action_click` -> `dom_wait_for` 等预期结果。
- **填写搜索框**：`dom_query{"selector":"input,textarea","attributes":["text","placeholder","name","ariaLabel"]}` -> `action_type` -> `action_press_key{"key":"Enter"}`。
- **滚动信息流**：阅读用 `action_scroll`；采集用 `browser_scrape_with_scroll`。
- **提取文章**：先 `browser_extract_content`；Readability 漏字段时才 `script_evaluate`。
- **排查混乱**：用 `browser_tabs_list` 确认目标标签；命令失败再 `browser_diagnose`。

## 护栏

- 不要把 `browser_screenshot` 当第一步，除非任务天然视觉化。
- selector、text、aria-label 能定位时，不要先用坐标。
- `dom_query`、`dom_structured_data`、`browser_extract_content` 足够时，不要抓整页 HTML。
- 不依赖固定 sleep；等待 DOM 状态，或操作后验证。
- 回答必须贴着工具观察。推断可以有，但要明说是推断。
