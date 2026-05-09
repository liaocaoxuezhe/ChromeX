# Agent-First Browser Tools — PRD

## 为 AI Agent 设计的浏览器可观测性与操控工具集

**版本** v0.1
**状态** 草案
**日期** 2026-04-26

---

## 一、产品理念与愿景

### 1.1 核心论断

**当前所有 Browser Agent 方案都落后于 Computer Agent 的根本原因，不在于模型能力，而在于工具层的可观测性代差。**

在计算机本地环境里，Agent 通过 bash 可以在毫秒级获得精准、结构化、低噪音的反馈：

```bash
$ curl -s https://api.example.com/products | jq '.items[].name'
→ ["Product A", "Product B", "Product C"]
# 精准、结构化、< 50 tokens、信噪比接近 100%
```

同一个 Agent 在浏览器环境里，得到的反馈却是：

```
extract_content() →
<html><head>...</head><body>
  <nav>首页 产品 关于我们 联系方式</nav>
  <aside>广告横幅 ×3</aside>
  <main>...目标内容淹没在 8000 tokens 的噪音里...</main>
  <footer>版权信息 Cookie 政策 隐私条款</footer>
</body></html>
# 噪音极高、> 8000 tokens、LLM 需要自行定位目标
```

**这不是提示词工程能解决的问题，是工具层的设计缺陷。**

### 1.2 愿景

打造一套 **Agent-First（Agent 优先）** 的浏览器工具集，让 AI Agent 在浏览器环境里获得**等同于甚至超越**本地计算机环境的可观测性与操控能力。

实现后的效果：

```
Agent: "帮我在这家电商网站找到 50-100 元之间、评分 4 星以上的蓝牙耳机"

# Agent 的工作流（工具层视角）：
1. network_capture({"urlPattern": "api/products"})     → 静默捕获 API 响应
2. action_scroll({"to": "bottom"})                      → 触发懒加载
3. network_query({"urlPattern": "api/products"})        → 拿到 200 个商品的 JSON
4. compute_json({"query": "[?price>=50 && price<=100 && rating>=4.0].{name, price, rating}"})
   → [{"name":"QCY T5","price":79,"rating":4.5}, ...]  # 20 个精准结果

# 全程 token 消耗：< 500 tokens
# 全程耗时：< 2 秒
# 准确率：取决于 API 数据质量，不依赖 DOM 解析精度
```

### 1.3 核心洞察：三层可观测性模型

浏览器环境有三层数据源，信噪比从高到低：

```
第一层：网络层（信噪比 ≈ 100%）
  └─ XHR/fetch 响应 JSON → 网站自己的 API 返回的纯净结构化数据
     优先级：最高。能从这里拿就从这里拿。

第二层：DOM 结构化提取（信噪比 ≈ 60%）
  └─ CSS 选择器精准提取 + AX Tree 语义映射 + JSON-LD/OG/meta
     优先级：中等。网络层拿不到时用。

第三层：视觉/截图（信噪比 ≈ 20%）
  └─ 截图 → 多模态模型识别
     优先级：最低。前两层都拿不到时才用，作为兜底方案。
```

**现有方案的致命问题：几乎都从第三层（截图）出发，直接跳过了前两层。**

---

## 二、问题分析：现有方案的落后之处

### 2.1 截图优先方案（browser-use, WebAgent, Agent-E 等）

```
流程：截图 → 多模态模型分析 → 输出坐标 → 点击 → 截图 → ...
```

**问题**：
- 每步都需要一次多模态 LLM 调用（延迟高、成本高）
- 截图 token 消耗极大（一张 1080p 截图 ≈ 1000-3000 tokens）
- 无法"看到"不在屏幕上的内容（需要反复滚动）
- 无法直接获取网络数据（最重要的数据源被忽略）
- 像素坐标定位不稳定（响应式布局、不同分辨率）

### 2.2 全量 DOM 提取方案

```
流程：extract_content() → 拿整个页面文本 → LLM 自行定位 → ...
```

**问题**：
- 单次 observation 可能 5000-20000 tokens
- 大量噪音（导航栏、广告、页脚、脚本内联文本）
- LLM 容易迷失在海量文本中
- 无法区分信息优先级

### 2.3 为什么 bash 式工具在浏览器里更好

bash 环境之所以高效，不是因为"命令行"的形式，而是背后的设计哲学：

| 哲学 | bash 实现 | 应该如何在浏览器实现 |
|------|----------|-------------------|
| **精准查询，而非全量倾倒** | `grep` / `jq` / `find` | CSS 选择器查询、网络拦截、文本搜索 |
| **结构化输出** | JSON / 表格 / 纯量 | 所有工具强制返回 JSON，禁止返回原始 HTML |
| **明确成功/失败信号** | exit code 0/1 | 每个 tool 返回明确的 `ok` / `error` + 原因 |
| **可组合** | pipe `\|` | tool 结果可以喂给下一个 tool |
| **信噪比优先** | 先 `curl` API，不行再 `curl` 页面 | 先拦截网络，不行再查 DOM，最后才截图 |

---

## 三、设计原则

### P1：Agent 是第一公民

所有工具设计从 Agent 的视角出发，而非人类开发者。这意味着：
- 输出永远是 JSON 结构化数据，不是终端文本
- 字段命名清晰、一致，LLM 无需猜测含义
- 每个工具的描述和参数说明足够详细，LLM 看了就能用
- 默认返回的数据量控制在合理范围（有 token 预算意识）

### P2：三层可观测性，逐级降级

```
Agent 想要某个数据时：
  1. 先用 network_* 系列工具 → 尝试从 API 响应中拿
  2. 拿不到 → 用 dom_* 系列工具 → 从 DOM 中精准提取
  3. 还拿不到 → 用 browser_screenshot → 多模态兜底
```

工具集的设计本身就应该引导 Agent 走这个优先级。

### P3：精准查询优于全量获取

```
✅ dom_query({"selector": "table.pricing td.price"})
   → ["$9/mo", "$29/mo", "$99/mo"]  # 12 tokens

❌ dom_get_full_page_text()
   → 8000 tokens 的全页面文本
```

### P4：每种工具只做一件事

```
✅ network_capture → network_query → compute_json  # 三个工具组合

❌ get_all_product_info_and_filter_by_price()  # 一个工具做太多
```

### P5：被动捕获优于主动轮询

网络拦截应该是**持续被动捕获**，而非 Agent 每次需要数据时主动发起请求。Agent 执行操作后，API 响应已经在缓存里等着了。

### P6：工具即文档

每个工具的 description 应该足够详细，Agent 读了就能理解：
- 这个工具做什么
- 什么场景下使用
- 参数含义和格式
- 返回值结构
- 一个简短的示例

---

## 四、系统架构

### 4.1 整体架构

```
┌──────────────────────────────────────────────────────────────┐
│                    Claude Code (AI Agent)                     │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  MCP Client (内置于 Claude Code)                        │  │
│  │  - 看到所有 30+ tools                                   │  │
│  │  - 通过 tool description 选择合适的工具                  │  │
│  │  - 工具调用结果直接作为 context                          │  │
│  └────────────────────┬───────────────────────────────────┘  │
└───────────────────────┼──────────────────────────────────────┘
                        │ MCP JSON-RPC (stdio)
┌───────────────────────┼──────────────────────────────────────┐
│  MCP Server (Node.js 本地进程，浏览器外)                       │
│  ┌────────────────────┴───────────────────────────────────┐  │
│  │  Tool Registry        — 注册所有 30+ tools              │  │
│  │  Request Router       — 路由请求到 Extension 或本地处理  │  │
│  │  Response Formatter   — 确保输出符合 Schema              │  │
│  │  Token Budget Manager — 监控/截断超量输出                │  │
│  │  Security Manager     — 权限检查、域名白名单、审计日志    │  │
│  │  Local File System    — 真实文件系统读写（结果持久化）    │  │
│  └────────────────────┬───────────────────────────────────┘  │
└───────────────────────┼──────────────────────────────────────┘
                        │ WebSocket (localhost:9876)
┌───────────────────────┼──────────────────────────────────────┐
│  Chrome Extension (Manifest V3)                               │
│  ┌────────────────────┴───────────────────────────────────┐  │
│  │  Service Worker（命令中枢）                              │  │
│  │  ├─ WebSocket Client  — 与 MCP Server 保持长连接        │  │
│  │  ├─ CDP Manager        — 管理 chrome.debugger 连接       │  │
│  │  ├─ Network Interceptor — CDP Network domain 被动捕获    │  │
│  │  ├─ Tab/Window Manager — chrome.tabs/windows API 封装    │  │
│  │  ├─ Storage Manager    — chrome.storage + OPFS 管理      │  │
│  │  └─ Command Dispatcher — 分发指令到 Content Script/Worker │  │
│  ├────────────────────────────────────────────────────────┤  │
│  │  Content Script（DOM 执行器，注入每个页面）              │  │
│  │  ├─ DOM Query Engine   — CSS 选择器 + AX Tree 混合查询   │  │
│  │  ├─ Action Executor    — 点击、输入、滚动等操作          │  │
│  │  ├─ Text Searcher      — 全文搜索 + 上下文提取          │  │
│  │  └─ Structured Data Extractor — JSON-LD/OG/Meta 提取    │  │
│  ├────────────────────────────────────────────────────────┤  │
│  │  Web Worker（计算运行时）                                │  │
│  │  ├─ Pyodide Runtime    — CPython 3.12 in WASM           │  │
│  │  └─ JMESPath Engine    — JSON 查询                      │  │
│  ├────────────────────────────────────────────────────────┤  │
│  │  Side Panel（可选调试 UI，人类使用）                      │  │
│  │  ├─ Live Tool Call Monitor  — 实时显示 Agent 调用了什么  │  │
│  │  ├─ Network Capture Log     — 被拦截的 API 响应列表      │  │
│  │  ├─ Console Output          — Agent 操作日志             │  │
│  │  ├─ Permission Prompt       — 敏感操作确认               │  │
│  │  └─ Screenshot Preview      — 当前页面截图               │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

### 4.2 数据流

以 Agent 执行 "获取商品列表" 任务为例：

```
Agent                          MCP Server              Extension SW          Content Script    Page
 │                                │                        │                    │             │
 │─ network_capture("api/list")──▶│                        │                    │             │
 │                                │──WebSocket────────────▶│                    │             │
 │                                │                        │──CDP Network.enable│             │
 │                                │                        │──────────────────────────────────▶│
 │                                │                        │                    │             │
 │─ action_scroll(to="bottom")───▶│                        │                    │             │
 │                                │──WebSocket────────────▶│                    │             │
 │                                │                        │──postMessage()────▶│             │
 │                                │                        │                    │──window.──▶│
 │                                │                        │                    │  scrollTo()│
 │                                │                        │                    │            │
 │                                │                        │◀─"scrolled"────────│             │
 │                                │                        │                    │             │
 │                                │                        │◀─CDP responseReceived─────────────│
 │                                │                        │  (api/list 响应被捕获)            │
 │                                │                        │                    │             │
 │─ network_query("api/list")────▶│                        │                    │             │
 │                                │──WebSocket────────────▶│                    │             │
 │                                │◀───────JSON───────────│                    │             │
 │◀──── [{name, price}...]────────│                        │                    │             │
 │                                │                        │                    │             │
 │─ compute_json("jq query")─────▶│                        │                    │             │
 │                                │──WebSocket────────────▶│                    │             │
 │                                │                        │──Worker: jmespath  │             │
 │                                │◀───────filtered────────│                    │             │
 │◀──── filtered results ────────│                        │                    │             │
```

### 4.3 通信协议

**Agent ↔ MCP Server**: MCP JSON-RPC (stdio)

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "dom_query",
    "arguments": {
      "selector": "table.pricing td.price",
      "attributes": ["text"],
      "limit": 20
    }
  }
}
```

**MCP Server ↔ Extension**: WebSocket (localhost:9876)，私有二进制协议 + JSON

```json
{
  "id": "req-001",
  "tool": "dom_query",
  "params": {
    "tabId": 12,
    "selector": "table.pricing td.price",
    "attributes": ["text"],
    "limit": 20
  }
}
```

---

## 五、工具集详细设计

### 5.1 工具总览

工具按照"Agent 的工作流"组织，而非技术实现：

| 阶段 | 工具类别 | 数量 | 用途 |
|------|---------|------|------|
| **环境感知** | browser_* | 6 | 了解浏览器状态（有哪些标签页、当前在哪个页面） |
| **高信噪比数据获取** | network_* | 5 | 从网络层获取数据（最优路径） |
| **DOM 精准查询** | dom_* | 8 | 从 DOM 层获取数据（次优路径） |
| **视觉兜底** | visual_* | 1 | 截图（最后手段） |
| **动作执行** | action_* | 7 | 点击、输入、滚动、导航 |
| **脚本执行** | script_* | 1 | 在页面上下文执行 JavaScript |
| **数据持久化** | storage_* | 4 | 读写 OPFS 文件系统 |
| **计算处理** | compute_* | 2 | Python 执行、JSON 查询 |
| **总计** | | **34** | |

### 5.2 环境感知类（browser_*）

#### `browser_tabs_list`

列出浏览器中所有打开的标签页。

```
参数：无

返回值：
{
  "tabs": [
    {
      "id": 12,
      "windowId": 1,
      "active": true,
      "url": "https://example.com/products",
      "title": "Products - Example Store",
      "status": "complete",       // loading | complete
      "favicon": "https://..."
    },
    ...
  ],
  "totalCount": 5
}
```

使用场景：Agent 需要了解当前浏览器环境，或者需要切换到特定标签页。

---

#### `browser_tab_info`

获取当前（或指定）标签页的详细状态。

```
参数：
  tabId?: number  // 不传则默认当前活跃标签页

返回值：
{
  "id": 12,
  "url": "https://example.com/products",
  "title": "Products - Example Store",
  "readyState": "complete",
  "scrollY": 320,
  "scrollHeight": 4200,
  "viewportHeight": 900,
  "networkIdle": true,           // 当前是否有进行中的网络请求
  "canGoBack": true,
  "canGoForward": false
}
```

---

#### `browser_tab_switch`

切换到指定标签页。

```
参数：
  tabId: number  // 目标标签页 ID

返回值：
{ "ok": true, "tabId": 12, "url": "https://..." }
```

---

#### `browser_tab_new`

在新标签页中打开 URL。

```
参数：
  url: string
  active?: boolean  // 是否立即切换到新标签页，默认 true

返回值：
{ "ok": true, "tabId": 15, "url": "https://..." }
```

---

#### `browser_navigate`

在当前标签页导航到新 URL。

```
参数：
  url: string
  waitUntil?: "dom-ready" | "network-idle"  // 默认 network-idle

返回值：
{
  "ok": true,
  "finalUrl": "https://...",     // 重定向后的最终 URL
  "redirected": false,
  "elapsed": 1840                // 加载耗时 ms
}
```

---

#### `browser_wait`

等待页面状态变化。

```
参数：
  condition: "network-idle" | "dom-ready" | "timeout"
  timeout?: number   // 超时 ms，默认 10000
  selector?: string  // 当 condition="dom-ready" 时，等待此选择器出现

返回值：
{ "ok": true, "elapsed": 1240, "condition": "network-idle" }
```

---

### 5.3 网络层工具（network_*）— 最高信噪比

#### 设计理念

**网络层是信噪比最高的数据源。** 现代 Web 应用的数据几乎都在 XHR/fetch 响应中以 JSON 形式传输。直接捕获这些响应，就能绕过 DOM 解析的全部噪音。

工作模式：**被动持续捕获 + 按需查询**。Extension 的 Service Worker 通过 CDP Network domain 持续监听并缓存所有匹配的 API 响应，Agent 随时可以查询已捕获的数据。

---

#### `network_capture`

配置网络捕获规则。调用后，Extension 开始持续捕获匹配的请求响应。

```
参数：
  urlPattern: string            // URL 包含此字符串的请求，如 "api/products"
  method?: string               // 过滤请求方法 GET/POST/PUT/DELETE
  resourceType?: string         // "xhr" | "fetch" | "document" | "all"
  maxBodySize?: number          // 单个响应体最大缓存大小 (bytes)，默认 500KB
  enabled?: boolean             // 是否启用，默认 true。传 false 可暂停捕获

返回值：
{
  "ok": true,
  "rules": [
    { "urlPattern": "api/products", "resourceType": "xhr", "enabled": true }
  ],
  "note": "捕获规则已生效。后续匹配的响应将被缓存，使用 network_query 查询。"
}
```

**使用模式**：Agent 在进入页面后立即调用此工具设置捕获规则，然后放心地进行交互操作。当需要数据时，调用 `network_query` 获取已缓存的响应。

---

#### `network_query`

查询已捕获的网络响应。这是 Agent 获取高信噪比数据的**核心工具**。

```
参数：
  urlPattern?: string           // 过滤 URL，不传则返回所有已捕获的响应
  method?: string               // 过滤方法
  fields?: string               // 用 jmespath 从响应体中提取字段，如 "items[].name"
  limit?: number                // 最多返回条数，默认 5
  includeBody?: boolean         // 是否包含完整响应体，默认 true. false 时只返回摘要
  since?: string                // 只返回此时间之后的响应（ISO 8601），用于增量获取

返回值：
{
  "captures": [
    {
      "url": "https://api.example.com/products?page=1&limit=50",
      "method": "GET",
      "status": 200,
      "size": "12.4KB",
      "capturedAt": "2026-04-26T10:30:01Z",
      "body": {                  // includeBody=true 时
        "items": [
          { "id": 1, "name": "Product A", "price": 29.99 },
          ...
        ],
        "total": 142,
        "page": 1
      }
    }
  ],
  "totalCaptured": 3,
  "hint": "使用 fields 参数可直接提取嵌套字段，减少 token 消耗。"
}
```

---

#### `network_list`

列出当前页面发出的所有网络请求（摘要视图），帮助 Agent 发现可用的 API 端点。

```
参数：
  filter?: string               // URL 包含此字符串
  resourceType?: string         // "xhr" | "fetch" | "all"
  statusCode?: string           // "2xx" | "3xx" | "4xx" | "5xx"
  limit?: number                // 默认 30

返回值：
{
  "requests": [
    {
      "url": "https://api.example.com/graphql",
      "method": "POST",
      "status": 200,
      "type": "fetch",
      "size": "2.1KB",
      "duration": 145           // 请求耗时 ms
    },
    {
      "url": "https://cdn.example.com/bundle.js",
      "method": "GET",
      "status": 200,
      "type": "script",
      "size": "240KB",
      "duration": 320
    }
  ],
  "totalCount": 47
}
```

**使用模式**：Agent 进入一个不熟悉的网站，不确定有哪些 API 端点。先调用 `network_list` 浏览一遍，找到目标 API 后用 `network_capture` + `network_query` 精准获取数据。

---

#### `network_fetch`

从 Service Worker 发起 HTTP 请求。天然绕过 CORS，可以使用当前浏览器的 Cookie。

```
参数：
  url: string
  method?: string               // 默认 GET
  headers?: object              // 额外请求头
  body?: string                 // 请求体（POST/PUT 时使用）

返回值：
{
  "ok": true,
  "status": 200,
  "headers": { "content-type": "application/json" },
  "body": { ... },              // 自动解析 JSON；非 JSON 则返回文本
  "size": 1234
}
```

**为什么不用页面内的 fetch？** 页面内的 fetch 受 CORS 限制，且会被 CSP 拦截。Service Worker 发起的请求不受这些限制。

---

#### `network_replay`

重放之前捕获的某个请求（使用相同的 Cookie/Session），可以修改查询参数。

```
参数：
  captureIndex: number          // 从 network_query 结果中选择第几个捕获
  overrides?: {
    url?: string                // 修改 URL（如翻页参数）
    body?: string               // 修改请求体
    headers?: object            // 修改/添加请求头
  }

返回值：
{ "ok": true, "status": 200, "body": { ... } }
```

**使用场景**：Agent 发现 `api/products?page=1` 返回了第 1 页，想拿第 2 页。可以用 `network_replay` 把 `page=1` 改成 `page=2` 直接重放，无需在页面上点击"下一页"。

---

### 5.4 DOM 层工具（dom_*）— 中等信噪比

#### 设计理念

当网络层无法提供所需数据时（如：网站 SSR 渲染、数据嵌入在 HTML 属性中、动态内容尚未触发 API），使用 DOM 层工具进行精准提取。

DOM 层工具的核心哲学：**永远不要返回原始 HTML。** 输出必须是结构化 JSON，字段精炼，token 可控。

---

#### `dom_overview`

获取页面结构摘要。这是 Agent 进入新页面的第一件事——快速了解页面上有什么。

```
参数：
  include?: string[]  // 需要包含的信息类别，可选: "headings","buttons","inputs","forms","tables","links","images"
                      // 默认全部

返回值：
{
  "url": "https://example.com/pricing",
  "title": "Pricing - Example Corp",
  "headings": [
    { "tag": "H1", "text": "Simple, Transparent Pricing" },
    { "tag": "H2", "text": "Monthly Plans" },
    { "tag": "H2", "text": "Annual Plans" },
    { "tag": "H3", "text": "Starter" },
    { "tag": "H3", "text": "Professional" }
  ],
  "buttons": [
    { "text": "Sign Up Free", "visible": true },
    { "text": "Contact Sales", "visible": true },
    { "text": "Get Started", "visible": false }
  ],
  "inputs": [
    { "type": "email", "name": "email", "placeholder": "Enter your email" },
    { "type": "password", "name": "password", "placeholder": "Password" }
  ],
  "forms": 2,
  "tables": 1,
  "links": 34,
  "images": 12,
  "summary": "页面有 1 个搜索表单、1 个定价表格、3 个 CTA 按钮。主要内容区域为定价表。"
}
```

**token 估算**：通常 < 300 tokens。

---

#### `dom_query`

CSS 选择器精准查询。对标 jq 的选择功能。

```
参数：
  selector: string              // CSS 选择器
  attributes?: string[]         // 要提取的属性，如 ["text","href","src","value","ariaLabel","data-*"]
                                // 默认 ["text"]
  limit?: number                // 最多返回条数，默认 50
  includeHtml?: boolean         // 是否包含 innerHTML（用于理解富文本内容），默认 false

返回值：
{
  "results": [
    { "text": "$9/mo", "selector": "table.pricing tr:nth-child(1) td.price" },
    { "text": "$29/mo", "selector": "table.pricing tr:nth-child(2) td.price" }
  ],
  "count": 4,
  "truncated": false,
  "selector": "table.pricing td.price"
}
```

**使用示例**：
- `dom_query({ selector: "a.nav-link", attributes: ["text","href"] })` → 所有导航链接
- `dom_query({ selector: "[data-product-id]", attributes: ["text","data-product-id","data-price"] })` → 带 data 属性的产品
- `dom_query({ selector: "meta[name='csrf-token']", attributes: ["content"] })` → CSRF token

---

#### `dom_search`

全文搜索页面文本，返回匹配元素的上下文。

```
参数：
  query: string                 // 搜索关键词
  contextLines?: number         // 返回匹配元素的前后兄弟元素数，默认 2
  limit?: number                // 默认 20
  caseSensitive?: boolean       // 默认 false

返回值：
{
  "matches": [
    {
      "text": "Annual Revenue: $4.2M",
      "selector": "td.metric-value",
      "context": {
        "before": ["Company Alpha", "Annual Revenue"],
        "after": ["Net Profit", "Employees"]
      }
    }
  ],
  "count": 1,
  "query": "Annual Revenue"
}
```

**为什么不用 `document.querySelectorAll(':contains("text")')`？** 因为那不存在。`:contains` 不是标准 CSS 选择器。浏览器内唯一可靠的文本搜索方式是遍历 DOM 树并匹配 `textContent`。

---

#### `dom_structured_data`

提取页面已有的结构化数据（JSON-LD、Open Graph、Twitter Cards、meta 标签）。这通常比解析 DOM 准确得多。

```
参数：无

返回值：
{
  "jsonLd": [
    { "@type": "Product", "name": "Widget Pro", "price": "29.99", "currency": "USD" }
  ],
  "openGraph": {
    "title": "Widget Pro - Example Store",
    "description": "The best widget you'll ever buy.",
    "image": "https://cdn.example.com/og-image.jpg",
    "type": "product"
  },
  "meta": {
    "description": "The best widget you'll ever buy. Free shipping.",
    "keywords": "widget, pro, best widget",
    "author": "Example Corp"
  }
}
```

**token 估算**：通常 < 200 tokens。

---

#### `dom_accessibility_tree`

获取页面的无障碍树（AX Tree）。AX Tree 是 DOM 的语义化表示，比原始 DOM 更结构化，跨站点通用性更强。

```
参数：
  maxDepth?: number             // 最大深度，默认 4。控制返回的树有多大
  rootSelector?: string         // 从哪个元素开始，默认 body
  includeRoles?: string[]       // 只包含特定 role，如 ["button","link","heading","textbox"]
  excludeRoles?: string[]       // 排除特定 role，如 ["generic","none"]

返回值：
{
  "tree": {
    "role": "WebArea",
    "name": "Products - Example Store",
    "children": [
      {
        "role": "heading",
        "name": "Product Catalog",
        "level": 1
      },
      {
        "role": "link",
        "name": "Product A",
        "properties": { "url": "/products/a", "description": "High-performance widget" }
      },
      {
        "role": "button",
        "name": "Add to Cart",
        "properties": { "pressed": false }
      }
    ]
  },
  "nodeCount": 52,
  "truncated": false
}
```

**设计考量**：AX Tree 是 DOMShell 的核心数据源，也是其最大优势。但全量 AX Tree 可能很大（复杂页面 500+ 节点）。因此设计了 `maxDepth`、`includeRoles`、`excludeRoles` 参数来控制输出大小。

---

#### `dom_element_detail`

获取单个元素的详细信息。当 Agent 通过 `dom_query` 或 `dom_search` 定位到感兴趣的元素后，用它深钻细节。

```
参数：
  selector: string              // CSS 选择器定位元素
  include?: string[]            // 需要的信息: "attributes","styles","position","accessibility"
                                // 默认 ["attributes","accessibility"]

返回值：
{
  "tag": "button",
  "text": "Add to Cart",
  "attributes": {
    "id": "add-to-cart-btn",
    "class": "btn btn-primary btn-lg",
    "data-product-id": "12345",
    "data-price": "29.99",
    "aria-label": "Add Product A to cart",
    "disabled": false
  },
  "position": {                  // include "position" 时
    "x": 450,
    "y": 320,
    "width": 180,
    "height": 48,
    "visible": true,
    "inViewport": true
  },
  "accessibility": {             // include "accessibility" 时
    "role": "button",
    "name": "Add to Cart",
    "description": "Add Product A to cart",
    "focusable": true,
    "focused": false
  }
}
```

---

#### `dom_wait_for`

等待某个元素出现在 DOM 中。

```
参数：
  selector: string              // 等待此 CSS 选择器出现
  state?: "present" | "visible" | "hidden" | "enabled"  // 默认 visible
  timeout?: number              // 超时 ms，默认 10000

返回值：
{
  "ok": true,
  "selector": ".search-results",
  "elapsed": 2340,
  "state": "visible"
}
```

---

#### `dom_diff`

对比两次快照之间 DOM 的变化。用于理解操作后页面发生了什么。

```
参数：
  action: string                // 描述对比的动作，用于标识
  selector?: string             // 只关注此选择器内的变化，默认整个 body

返回值：
{
  "added": {
    "elements": [".success-message", ".new-item:nth-child(5)"],
    "count": 2
  },
  "removed": {
    "elements": [".loading-spinner", ".modal-overlay"],
    "count": 2
  },
  "modified": {
    "elements": [".cart-count"],
    "changes": [{ "selector": ".cart-count", "oldText": "0", "newText": "1" }],
    "count": 1
  },
  "unchanged": 187
}
```

**注意**：此工具需要在 Action 执行前后各拍一次快照。实现上，Extension 自动在执行任何 action_* 工具时拍摄快照，Agent 可通过此工具获取 diff。

---

### 5.5 视觉工具（visual_*）— 最后手段

#### `browser_screenshot`

截取页面截图。仅当前两层工具都无法获取所需数据时使用。

```
参数：
  selector?: string             // 截取特定元素区域，不传则截取当前视口
  fullPage?: boolean            // 截取完整页面（含滚动区域），默认 false
  format?: "png" | "jpeg"      // 默认 png
  quality?: number              // JPEG 质量 1-100，默认 80

返回值：
{
  "format": "png",
  "width": 1440,
  "height": 900,
  "data": "base64-encoded-string...",
  "note": "截图 token 消耗较高，仅在 network_* 和 dom_* 工具无法获取所需信息时使用。"
}
```

---

### 5.6 动作类（action_*）

#### 设计理念

每个动作工具返回操作的结果摘要，而非全页面状态。Agent 不需要在每次点击后看到整个页面——它只需要知道操作是否成功、触发了什么变化。

---

#### `action_click`

点击页面元素。

```
参数：
  target: {
    selector?: string           // CSS 选择器
    text?: string               // 按可见文本匹配（模糊匹配）
    ariaLabel?: string          // 按 aria-label 匹配
    // 三者至少提供一个，优先级：selector > text > ariaLabel
  }
  method?: "js" | "cdp"        // 点击方式。js=元素.click() 更自然，cdp=CDP Input.dispatchMouseEvent 更可靠
                                // 默认先尝试 js，失败自动降级为 cdp
  waitForNavigation?: boolean   // 是否等待页面导航完成，默认 true
  waitForSelector?: string      // 点击后等待此选择器出现

返回值：
{
  "ok": true,
  "target": { "selector": "button.submit", "text": "Submit" },
  "method": "js",
  "effects": {
    "domChanged": true,
    "urlChanged": false,
    "networkTriggered": ["api/submit", "api/validate"],
    "newElements": [".success-message"],
    "dialogOpened": null
  },
  "elapsed": 450
}
```

---

#### `action_type`

在输入框或文本区域中输入文本。

```
参数：
  target: {
    selector?: string
    name?: string               // 按 input 的 name 属性匹配
    placeholder?: string        // 按 placeholder 匹配
  }
  text: string
  clearFirst?: boolean          // 输入前先清空，默认 true
  submitAfter?: "enter" | "tab" | "none"  // 输入后按什么键，默认 none

返回值：
{
  "ok": true,
  "target": { "selector": "#email" },
  "value": "user@example.com",
  "effects": {
    "inputEventFired": true,
    "validationTriggered": true
  }
}
```

---

#### `action_scroll`

滚动页面。

```
参数：
  direction?: "down" | "up"    // 默认 down
  amount?: number               // 滚动像素，默认 500（约半屏）
  to?: "top" | "bottom"        // 滚动到页面顶部/底部（会覆盖 direction 和 amount）
  toSelector?: string           // 滚动到指定元素可见
  waitAfter?: number            // 滚动后等待 ms（等待懒加载），默认 500

返回值：
{
  "ok": true,
  "scrollY": 1200,
  "scrollHeight": 4200,
  "atBottom": false,
  "newContentLoaded": true,     // 是否检测到新的 DOM 节点（懒加载触发）
  "networkTriggered": ["api/feed?page=2"]
}
```

---

#### `action_select`

在下拉框（`<select>`）中选择选项。

```
参数：
  target: { selector?: string; name?: string; ariaLabel?: string }
  value: string                 // 选项的 value 或可见文本
  by: "value" | "text"         // 按 value 还是文本匹配，默认先 value 后 text

返回值：
{ "ok": true, "selected": "price-asc", "optionsCount": 5 }
```

---

#### `action_hover`

鼠标悬停在元素上。

```
参数：
  target: { selector?: string; text?: string }

返回值：
{ "ok": true, "effects": { "tooltipShown": true, "dropdownOpened": false } }
```

---

#### `action_press_key`

按下键盘按键或快捷键。

```
参数：
  key: string                   // 如 "Enter"、"Escape"、"Tab"、"Control+A"、"Meta+C"
  target?: { selector?: string } // 可选：先聚焦此元素再按键

返回值：
{ "ok": true, "key": "Enter" }
```

---

#### `action_fill_form`

批量填写表单。对于有多个字段的表单，比多次调用 `action_type` 更高效。

```
参数：
  formSelector?: string         // 限定在某个 <form> 内查找字段
  fields: Array<{
    name?: string               // 按 input name 匹配
    selector?: string           // 按 CSS 选择器匹配
    value: string
    type?: "text" | "select" | "checkbox" | "radio"  // 默认 text
  }>
  submit?: boolean              // 填写完成后是否提交表单

返回值：
{
  "ok": true,
  "filled": 5,
  "failed": [],
  "submitted": false
}
```

---

### 5.7 脚本执行类（script_*）

#### `script_evaluate`

在页面 JavaScript 上下文中执行代码并返回结果。这是最灵活的能力——Agent 可以直接读取页面中的任何 JS 变量（包括框架内部的 store）。

```
参数：
  expression: string            // JS 表达式或代码块
  awaitPromise?: boolean        // 等待 Promise 解析，默认 true
  timeout?: number              // 执行超时 ms，默认 5000

返回值：
{
  "ok": true,
  "result": { ... },            // JSON 序列化的返回值
  "type": "object"              // typeof result
}
```

**典型用法**：

```javascript
// 读取框架内部状态
script_evaluate({ expression: "window.__INITIAL_STATE__" })

// 读取 Redux store
script_evaluate({ expression: "window.__REDUX_STORE__.getState()" })

// 读取所有 localStorage keys
script_evaluate({ expression: "Object.keys(localStorage)" })

// 获取页面上的所有图片 URL
script_evaluate({ expression: `
  Array.from(document.querySelectorAll('img'))
    .map(img => ({ src: img.src, alt: img.alt, width: img.naturalWidth, height: img.naturalHeight }))
    .filter(img => img.width > 100)
`})

// 复杂操作：滚动到底部 + 等待加载
script_evaluate({
  expression: `
    (async () => {
      window.scrollTo(0, document.body.scrollHeight);
      await new Promise(r => setTimeout(r, 1000));
      return document.querySelectorAll('.item').length;
    })()
  `,
  awaitPromise: true
})
```

---

### 5.8 数据持久化类（storage_*）

#### 设计理念

Agent 在执行任务时会产生中间数据。这些数据应该落在浏览器内的 OPFS（Origin Private File System）中，而非每次都发回 MCP Server。OPFS 提供真正的文件系统语义：目录、文件、读、写、追加、删除。

---

#### `file_write`

写入文件到 OPFS。

```
参数：
  path: string                  // 文件路径，如 "tasks/001/products.json"
  content: string               // 文件内容（文本或 JSON 字符串）
  mode?: "overwrite" | "append"  // 默认 overwrite

返回值：
{ "ok": true, "path": "tasks/001/products.json", "size": 10240, "lines": 342 }
```

---

#### `file_read`

从 OPFS 读取文件。

```
参数：
  path: string
  query?: string                // 可选：JMESPath 查询，如 "items[].name"，直接在读取时过滤
  offset?: number               // 从第几行开始读
  limit?: number                // 最多读多少行

返回值：
{
  "ok": true,
  "path": "tasks/001/products.json",
  "content": "...",             // JSON 文件自动解析为对象，文本文件返回字符串
  "size": 10240
}
```

---

#### `file_list`

列出 OPFS 目录内容。

```
参数：
  path?: string                 // 默认根目录 "/"
  recursive?: boolean           // 是否递归列出子目录

返回值：
{
  "entries": [
    { "name": "products.json", "type": "file", "size": 10240 },
    { "name": "screenshots/", "type": "directory" }
  ]
}
```

---

#### `file_download`

将 OPFS 中的文件下载到用户的本地文件系统。

```
参数：
  path: string                  // OPFS 中的文件路径
  filename?: string             // 下载时的文件名，默认使用原文件名
  zip?: boolean                 // 如果是目录，打包为 ZIP 下载

返回值：
{ "ok": true, "filename": "report.xlsx", "triggered": true }
```

---

### 5.9 计算处理类（compute_*）

#### `compute_json`

使用 JMESPath 查询 JSON 数据。轻量高效，避免为简单过滤启动 Pyodide。

```
参数：
  query: string                 // JMESPath 查询表达式
  data?: any                    // 直接传入 JSON 数据
  file?: string                 // 或从 OPFS 文件读取
  // data 和 file 二选一

返回值：
{
  "ok": true,
  "result": ["Product A", "Product B"],
  "query": "items[].name"
}
```

**支持的 JMESPath 语法**：
- 字段访问：`items[0].name`、`items[].price`
- 条件过滤：`items[?price > `100`]`
- 多字段投影：`items[].{name: name, price: price}`
- 函数：`length(items)`、`sort_by(items, &price)`
- 管道：`items[?price > `50`] | [?rating >= `4.0`]`

---

#### `compute_python`

使用 Pyodide（CPython 3.12 编译到 WASM）在浏览器内执行 Python 代码。

```
参数：
  code: string                  // Python 代码
  input?: any                   // 直接传入的输入数据，在代码中通过 INPUT 变量访问
  inputFile?: string            // 或从 OPFS 文件读取，在代码中通过 INPUT 访问
  packages?: string[]           // 需要额外安装的 pip 包（纯 Python 包可运行时安装）
  timeout?: number              // 执行超时 ms，默认 30000
  outputFile?: string           // 将执行结果（最后一行表达式的值）写入 OPFS 文件

返回值：
{
  "ok": true,
  "result": ...,                // Python 代码中最后一个表达式的值（或 print 的内容）
  "stdout": "...",              // print() 输出
  "elapsed": 450,
  "cached": true                // 是否使用了预热的 Pyodide（首次调用 ~3s，预热后 < 200ms）
}
```

**典型用法**：

```python
# 数据处理
compute_python({
  code: """
import json
data = INPUT
# 筛选价格在 50-100 之间、评分 >= 4.0 的商品
filtered = [
    item for item in data['items']
    if 50 <= item['price'] <= 100 and item.get('rating', 0) >= 4.0
]
# 按评分排序
filtered.sort(key=lambda x: x['rating'], reverse=True)
json.dumps(filtered[:20])
""",
  input: { "items": [...] }
})

# 生成 Excel 报告
compute_python({
  code: """
import io, json
# 注意：openpyxl 是纯 Python 包，可通过 micropip 安装
data = INPUT
# ... 构建 Excel ...
output = io.BytesIO()
wb.save(output)
output.getvalue().hex()  # 返回二进制数据的 hex 表示
""",
  packages: ["openpyxl"]
})
```

---

## 六、安全模型

### 6.1 权限分级

| 级别 | 包含工具 | 风险 | 策略 |
|------|---------|------|------|
| **只读-低风险** | `browser_*`, `dom_*`, `network_list`, `network_query`, `file_read`, `file_list`, `compute_*` | 仅读取信息不改写 | 默认允许，无需确认 |
| **只读-中风险** | `network_fetch`, `network_replay`, `browser_screenshot`, `script_evaluate` | 可能触发副作用或泄露数据 | 允许，记录审计日志 |
| **写入-高风险** | `action_*`, `browser_navigate`, `browser_tab_new` | 修改页面状态，触发实际操作 | 重要域名需要用户确认 |
| **写入-危险** | `file_write`, `file_download`, `browser_tab_close` | 数据外泄、丢失 | 需要用户明确确认 |

### 6.2 域名白名单

```json
{
  "domainPolicies": [
    {
      "pattern": "*://*.example.com/*",
      "permission": "auto-allow-all"
    },
    {
      "pattern": "*://mail.google.com/*",
      "permission": "read-only"
    },
    {
      "pattern": "*://*.bank.com/*",
      "permission": "confirm-each-action"
    }
  ],
  "defaultPolicy": "confirm-write"
}
```

### 6.3 审计日志

所有工具调用（特别是 action_* 和 network_*）记录到审计日志：

```json
{
  "timestamp": "2026-04-26T10:30:01Z",
  "tool": "action_click",
  "params": { "target": { "selector": "#submit-btn" } },
  "result": { "ok": true },
  "tabId": 12,
  "url": "https://example.com/checkout",
  "elapsed": 450
}
```

审计日志持久化到 MCP Server 的文件系统（而非浏览器内），确保即使 Extension 卸载，日志依然保留。

---

## 七、技术实现方案

### 7.1 项目结构

```
agent-browser-tools/
├── extension/                       # Chrome Extension (Manifest V3)
│   ├── manifest.json
│   ├── service-worker/
│   │   ├── index.ts                 # SW 入口
│   │   ├── ws-client.ts             # WebSocket 客户端（连接 MCP Server）
│   │   ├── cdp-manager.ts           # CDP 连接管理
│   │   ├── network-interceptor.ts   # CDP Network domain 封装
│   │   ├── tab-manager.ts          # chrome.tabs/windows 封装
│   │   ├── storage-manager.ts      # OPFS 管理
│   │   ├── command-dispatcher.ts   # 指令分发器
│   │   └── permission-checker.ts   # 权限检查
│   ├── content-script/
│   │   ├── index.ts                 # Content Script 入口
│   │   ├── dom-query-engine.ts      # CSS 选择器 + AX Tree 查询
│   │   ├── action-executor.ts       # 点击/输入/滚动执行
│   │   ├── text-searcher.ts         # 全文搜索
│   │   └── structured-data.ts       # JSON-LD/OG/Meta 提取
│   ├── worker/
│   │   ├── pyodide-runtime.ts       # Pyodide 运行时 + 预热
│   │   └── jmespath-engine.ts       # JMESPath 执行
│   ├── sidepanel/
│   │   ├── index.html
│   │   ├── index.tsx                # React 入口
│   │   ├── ToolCallMonitor.tsx      # 工具调用实时监控
│   │   ├── NetworkLog.tsx           # 网络捕获日志
│   │   └── PermissionPrompt.tsx     # 权限确认弹窗
│   └── shared/
│       ├── types.ts                 # 共享类型定义
│       ├── constants.ts             # 常量
│       └── utils.ts                 # 工具函数
├── mcp-server/                      # MCP Server (Node.js)
│   ├── index.ts                     # 入口
│   ├── mcp-handler.ts              # MCP JSON-RPC 协议处理
│   ├── tool-registry.ts            # 工具注册 + Schema 定义
│   ├── ws-server.ts                # WebSocket 服务端
│   ├── security-manager.ts         # 安全策略 + 域名白名单
│   ├── audit-logger.ts             # 审计日志
│   ├── token-budget.ts             # Token 预算控制
│   └── file-store.ts               # 本地文件存储（用于持久化结果）
├── sdk/                             # JavaScript SDK（开发者用）
│   └── index.ts
├── docs/
│   ├── prd.md                      # 本文档
│   ├── architecture.md             # 架构文档
│   ├── tool-reference.md           # 工具参考手册
│   └── security.md                 # 安全模型详细文档
├── package.json
└── tsconfig.json
```

### 7.2 关键技术选型

| 技术点 | 选型 | 原因 |
|--------|------|------|
| Extension 框架 | Vanilla TS + Vite | 轻量，Service Worker 不需要 React |
| Side Panel UI | React + Tailwind | 开发效率高，调试 UI 不复杂 |
| CDP 通信 | `chrome.debugger` API | Manifest V3 唯一支持 CDP 的方式 |
| Service Worker ↔ Content Script | `chrome.runtime.sendMessage` | 标准通信方式 |
| Service Worker ↔ Web Worker | `postMessage` | Worker 间通信 |
| MCP Server | `@modelcontextprotocol/sdk` | MCP 官方 SDK |
| WebSocket | `ws` (Node.js 端) + 原生 WebSocket (SW 端) | 标准、双向、低延迟 |
| Pyodide | CDN 加载 `pyodide.js` | 首次 6-8MB，后续 Service Worker 缓存 |
| JMESPath | `jmespath` npm 包 | 轻量 < 10KB |
| Token 计数 | `tiktoken` | 与 OpenAI/Claude 一致的 token 计数 |

### 7.3 关键实现细节

#### 7.3.1 网络被动捕获

```typescript
// service-worker/network-interceptor.ts

class NetworkInterceptor {
  private capturedResponses: Map<string, CapturedResponse[]> = new Map();
  private captureRules: CaptureRule[] = [];

  async enable(tabId: number) {
    await chrome.debugger.attach({ tabId }, "1.3");
    await chrome.debugger.sendCommand({ tabId }, "Network.enable");

    chrome.debugger.onEvent.addListener((source, method, params) => {
      if (method === "Network.responseReceived") {
        const rule = this.matchRule(params.response.url);
        if (rule) {
          // 异步获取响应体
          this.captureBody(source.tabId, params.requestId, params.response);
        }
      }
    });
  }

  private async captureBody(tabId: number, requestId: string, response: any) {
    try {
      const { body, base64Encoded } = await chrome.debugger.sendCommand(
        { tabId },
        "Network.getResponseBody",
        { requestId }
      );
      const parsed = this.parseResponse(response.mimeType, body, base64Encoded);
      this.store(response.url, { url: response.url, status: response.status, body: parsed });
    } catch (e) {
      // 响应体可能已被清除（如重定向后的请求）
    }
  }
}
```

#### 7.3.2 Content Script DOM 查询引擎

```typescript
// content-script/dom-query-engine.ts

class DomQueryEngine {
  query(params: QueryParams): QueryResult {
    const elements = document.querySelectorAll(params.selector);
    return {
      results: Array.from(elements)
        .slice(0, params.limit || 50)
        .map(el => this.extractAttributes(el, params.attributes || ["text"])),
      count: Math.min(elements.length, params.limit || 50),
      truncated: elements.length > (params.limit || 50)
    };
  }

  private extractAttributes(el: Element, attrs: string[]): Record<string, any> {
    const result: Record<string, any> = {};
    for (const attr of attrs) {
      switch (attr) {
        case "text":
          result.text = (el as HTMLElement).innerText?.trim() || el.textContent?.trim() || "";
          break;
        case "html":
          result.html = el.innerHTML.substring(0, 500); // 截断
          break;
        case "href":
          result.href = (el as HTMLAnchorElement).href || "";
          break;
        case "src":
          result.src = (el as HTMLImageElement).src || "";
          break;
        default:
          result[attr] = el.getAttribute(attr) || "";
      }
    }
    return result;
  }
}
```

#### 7.3.3 Pyodide 预热策略

```typescript
// worker/pyodide-runtime.ts

class PyodideRuntime {
  private pyodide: any = null;
  private loading: Promise<void> | null = null;

  // Extension 安装/启动时立即预热
  async preheat() {
    if (!this.loading) {
      this.loading = this.loadPyodide();
    }
    return this.loading;
  }

  private async loadPyodide() {
    importScripts("https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js");
    this.pyodide = await (self as any).loadPyodide({
      indexURL: "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/"
    });
  }

  async execute(code: string, input?: any, packages?: string[]) {
    await this.preheat();
    if (packages) {
      await this.pyodide.loadPackage(["micropip"]);
      const micropip = this.pyodide.pyimport("micropip");
      for (const pkg of packages) {
        await micropip.install(pkg);
      }
    }
    // 注入 INPUT 变量
    this.pyodide.globals.set("INPUT", input);
    const result = await this.pyodide.runPythonAsync(code);
    return result.toJs();
  }
}
```

#### 7.3.4 MCP Server Tool Schema 示例

```typescript
// mcp-server/tool-registry.ts

const domQueryTool = {
  name: "dom_query",
  description: `使用 CSS 选择器精准查询页面元素，返回结构化数据。

适用场景：
- 当你知道元素的 CSS 选择器时（如 ".price"、"table.pricing td"、"a.nav-link"）
- 需要批量提取同类元素的特定属性（所有商品价格、所有链接 URL）
- 需要获取 data-* 属性中的结构化数据

不适用场景：
- 不确定元素在页面中的位置 → 先用 dom_overview 了解页面结构
- 需要搜索特定文本 → 用 dom_search
- 需要语义化理解（按钮/链接/输入框）→ 用 dom_accessibility_tree

示例：
- 提取所有定价：dom_query({ selector: "table.pricing td.price", attributes: ["text"] })
- 提取所有导航链接：dom_query({ selector: "a.nav-link", attributes: ["text","href"] })
- 提取所有产品 data 属性：dom_query({ selector: "[data-product-id]", attributes: ["text","data-product-id","data-price"] })`,

  inputSchema: {
    type: "object",
    properties: {
      selector: {
        type: "string",
        description: "CSS 选择器，如 '.class-name'、'#id'、'table.pricing td.price'、'a[href]'"
      },
      attributes: {
        type: "array",
        items: { type: "string" },
        description: "要提取的属性列表。可选值: 'text'(innerText), 'html'(innerHTML, 截断500字符), 'href', 'src', 'value', 'placeholder', 'ariaLabel', 'id', 'className', 或任意 HTML 属性如 'data-product-id'",
        default: ["text"]
      },
      limit: {
        type: "number",
        description: "最多返回条数，默认 50，最大 200",
        default: 50
      },
      includeHtml: {
        type: "boolean",
        description: "是否包含 innerHTML（仅在需要理解富文本时启用），默认 false",
        default: false
      }
    },
    required: ["selector"]
  }
};
```

### 7.4 Side Panel 设计

Side Panel 是人类用户的调试仪表盘，不是 Agent 的操作界面。

```
┌──────────────────────────────────────────────┐
│  Agent Browser Tools                    ⚙ 🔌  │
├──────────────────────────────────────────────┤
│  [监控] [网络] [日志] [权限]                    │
├──────────────────────────────────────────────┤
│                                              │
│  📍 当前页面                                  │
│  https://example.com/products                │
│  标签页 #12  |  network: idle                 │
│                                              │
│  ── 最近工具调用 ────────────────────────────  │
│                                              │
│  10:30:01  dom_overview()          ✅  45ms  │
│  10:30:02  network_capture()       ✅  12ms  │
│  10:30:03  action_scroll()         ✅  520ms │
│  10:30:04  network_query()         ✅  34ms  │
│  10:30:05  compute_json()         ✅  8ms   │
│                                              │
│  ── 网络捕获 (3 个响应已缓存) ──────────────── │
│                                              │
│  GET  api/products?page=1         200  12KB  │
│  GET  api/recommendations         200   3KB  │
│  POST api/tracking                204   0B   │
│                                              │
│  ── 提示 ─────────────────────────────────── │
│  点击任意工具调用查看详情                       │
│                                              │
└──────────────────────────────────────────────┘
```

---

## 八、与现有方案的系统性对比

| 维度 | Playwright/Puppeteer | browser-use (Python) | DOMShell | browsersh | **本方案** |
|------|---------------------|---------------------|----------|-----------|----------|
| **定位** | 测试自动化 | Agent 工具 | 人类+Agent 浏览器 | Agent 命令行 | **Agent-First 工具集** |
| **数据源优先级** | DOM | 截图 → 多模态 | AX Tree | CSS + Network | **Network → DOM → 截图（三级降级）** |
| **网络拦截** | ✅ 完整 | ❌ | ❌ | ✅ （规划） | **✅ 被动持续捕获 + 按需查询** |
| **输出格式** | 取决于脚本 | 文本/截图 | 终端文本（可选 JSON） | 强制 JSON | **强制 JSON** |
| **Token 预算** | N/A | 无控制（~5000/步） | 无控制 | ✅ 2000 上限 | **✅ 逐工具限额 + 字段级控制** |
| **接入方式** | SDK | Python Tool | MCP (40+ tools) | 单一 shell tool | **MCP (34 tools)** |
| **人类 UI** | Headless 为主 | 无 | ✅ 终端 + 侧边栏 | 无 | **✅ 监控仪表盘** |
| **Python 支持** | ❌ | ✅（宿主机） | ❌ | ✅ Pyodide（规划） | **✅ Pyodide + 预热** |
| **文件系统** | ❌ | ✅（宿主机） | ❌（VFS 虚拟） | ✅ OPFS（规划） | **✅ OPFS** |
| **AX Tree** | ✅ | ❌ | ✅ | ❌ | **✅** |
| **CSS 选择器** | ✅ | ❌ | ❌ | ✅ | **✅** |
| **跨 Tab 操作** | ✅ | ❌ | ✅ | ❌ | **✅** |
| **安全模型** | 无 | 无 | ✅ 三层权限 | ❌ 待设计 | **✅ 四级权限 + 域名策略** |
| **运行环境** | 独立浏览器 | 独立浏览器 | Extension+用户浏览器 | Extension+用户浏览器 | **Extension+用户浏览器+MCP** |

---

## 九、开发路线图

### Phase 1：核心可观测性（4 周）

**目标**：Agent 能"看清"浏览器环境。网络捕获 + DOM 查询 + Tab 管理。

**工具**：
- browser_tabs_list, browser_tab_info, browser_tab_switch, browser_tab_new
- browser_navigate, browser_wait
- network_capture, network_query, network_list, network_fetch
- dom_overview, dom_query, dom_search, dom_structured_data, dom_wait_for
- browser_screenshot
- file_write, file_read, file_list

**基础架构**：
- Chrome Extension Service Worker + Content Script
- MCP Server（Node.js, WebSocket bridge）
- 基础安全模型（域名白名单 + 审计日志）
- Side Panel（只读监控视图）

**验收标准**：
- Agent 在 Research 场景下单步 observation 平均 token 数 < 500
- 网络捕获延迟 < 100ms（从请求完成到可查询）
- 所有工具端到端延迟 < 500ms（不含页面加载时间）

---

### Phase 2：操控能力 + 计算层（4 周）

**目标**：Agent 能精准"操控"浏览器。动作执行 + Python 计算。

**新增工具**：
- action_click, action_type, action_scroll, action_select, action_hover, action_press_key
- action_fill_form
- script_evaluate
- compute_json, compute_python

**增强架构**：
- CDP Input domain 深度集成
- Pyodide Web Worker + 预热策略
- Side Panel 权限确认交互
- network_replay（Phase 1 已有数据基础）

**验收标准**：
- action_click 成功率 > 95%（主流网站）
- Pyodide 预热后执行延迟 < 200ms
- network_replay 成功率 > 90%

---

### Phase 3：高级能力 + 生产就绪（4 周）

**目标**：Agent 能够完成复杂多步骤任务。高级 DOM + 脚本执行优化。

**新增/增强**：
- dom_element_detail, dom_accessibility_tree, dom_diff
- file_download
- OPFS 目录管理增强
- 审计日志持久化 + 可视化
- JavaScript SDK（供开发者接入）
- 命令自动补全提示（Side Panel）

**验收标准**：
- Agent 完成 10 个预设的复杂浏览器任务（如：搜索商品 → 筛选 → 比价 → 生成报告），成功率 > 80%
- 全流程平均 token 消耗 < 同等任务使用截图方案的 30%
- 零安全漏洞

---

## 十、成功指标

| 指标 | 当前 Baseline（截图方案） | Phase 1 目标 | Phase 3 目标 |
|------|--------------------------|-------------|-------------|
| 单步 observation 平均 token | > 5000 | < 500 | < 200 |
| 单步 observation 信噪比 | < 20% | > 60% | > 80% |
| Agent 任务成功率 | ~40% | > 65% | > 85% |
| 完成任务所需 LLM 调用次数 | baseline | -30% | -50% |
| 工具执行延迟 (P50) | N/A | < 200ms | < 100ms |
| 网络捕获覆盖率 | 0% | > 90% API 请求 | > 98% |
| Pyodide 可用率 | 0% | 0%（Phase 1） | > 95%（预热后） |

---

## 十一、开放问题

### Q1：Side Panel 的定位

Side Panel 是必选功能还是可选功能？如果 Agent 在无头模式下运行（如 CI/CD），Side Panel 没有意义。但如果有用户在旁监督，Side Panel 是重要的信任建立工具。

**建议**：Phase 1 做 Side Panel 作为可选 UI。Extension 在无 Side Panel 环境下也能正常运行。

### Q2：`chrome.debugger` 的黄条问题

使用 `chrome.debugger.attach()` 会在 Chrome 窗口顶部显示"浏览器正在被自动化程序控制"的黄条。这会干扰正常使用。

**可能的缓解方案**：
- 方案 A：接受黄条，通过 Side Panel 说明
- 方案 B：在不需要 CDP 的工具上自动 detach，仅在 network_capture 时 attach
- 方案 C：使用自定义 Chromium 构建关闭该提示

**建议**：Phase 1 采用方案 A+B（按需 attach），Phase 3 探索方案 C。

### Q3：Pyodide 的包安装

Pyodide 可以安装纯 Python 包，但大量常用包（pandas、numpy）虽然预编译了，加载也需要时间。首次 `import pandas` 可能耗时 2-3 秒。

**建议**：预装 pandas、numpy、openpyxl 等高频包，在 Worker 预热时一次性加载。

### Q4：CDP attach 的并发限制

Chrome 对同一时间 attach 的标签页数量有限制。如果 Agent 需要在多个标签页间频繁切换：

**建议**：Service Worker 维护一个 CDP 连接池，最多保持 2-3 个活跃连接，自动管理 attach/detach。

### Q5：是否支持 Firefox？

Firefox 不支持 Chrome Extension API 和 CDP（Firefox 有自己的 DevTools Protocol 但不同）。

**建议**：Phase 1-3 只关注 Chromium。MVP 验证成功后，Phase 4 考虑抽象出浏览器无关层。

### Q6：与 DOMShell 和 browsersh 的关系

本方案是一个新的设计，但大量借鉴了 DOMShell（MCP 架构、安全模型、AX Tree、跨 Tab 操作）和 browsersh（网络拦截、结构化输出、Token 预算、CSS 选择器、OPFS、Pyodide）的思想。

**建议**：本方案可以视为 DOMShell 和 browsersh 的"融合升级版"——取两者之长，面向 Agent 重新设计。如果决定实现，建议：
- 复用 DOMShell 的 MCP Server 架构和 CDP 客户端
- 采用 browsersh 的命名空间命令设计和结构化输出
- 新增网络被动捕获、Pyodide 预热、JMESPath 等独特能力

---

## 附录 A：Agent 任务示例

### 场景：从招聘网站收集 AI 公司信息

```
Agent: "帮我找到今天发布的、薪资在 30K-50K 的 AI 工程师职位"

工具调用序列：

1. browser_navigate({ url: "https://example-jobs.com/search?q=AI+Engineer" })
2. browser_wait({ condition: "network-idle" })

3. network_list({ filter: "api/", resourceType: "fetch" })
   → 发现 api/jobs/search、api/jobs/recommended、api/user/profile 三个端点

4. network_capture({ urlPattern: "api/jobs/search" })
   → 开始捕获搜索 API 的响应

5. dom_overview({ include: ["headings","buttons","inputs"] })
   → 了解页面布局和筛选控件

6. action_type({ target: { placeholder: "min salary" }, text: "30000", submitAfter: "tab" })
7. action_type({ target: { placeholder: "max salary" }, text: "50000", submitAfter: "enter" })

8. dom_wait_for({ selector: ".job-list" })

9. network_query({ urlPattern: "api/jobs/search", fields: "jobs[].{title, company, salary, location, posted}" })
   → [
       {"title": "Senior AI Engineer", "company": "OpenAI", "salary": "45K-55K", "location": "Remote", "posted": "2026-04-26"},
       {"title": "ML Engineer", "company": "Anthropic", "salary": "35K-50K", "location": "SF", "posted": "2026-04-26"},
       ...
     ]

10. compute_json({
      query: "jobs[?starts_with(posted, '2026-04-26')] | [?salary >= '30K' && salary <= '50K'] | sort_by([], &salary)",
      data: <上一步结果>
    })
    → 精准结果，20 tokens

11. compute_python({
      code: """
import json
data = INPUT
# 进一步分析：按公司分组、计算平均薪资等
from collections import defaultdict
by_company = defaultdict(list)
for job in data:
    by_company[job['company']].append(job)
summary = {company: {'count': len(jobs), 'avg_salary': '...'} for company, jobs in by_company.items()}
json.dumps(summary)
""",
      input: <上一步结果>
    })

12. file_write({ path: "tasks/job-search/results.json", content: <最终结果> })
13. file_download({ path: "tasks/job-search/results.json", filename: "AI_Engineer_Jobs_2026-04-26.json" })

全程 token 消耗：约 1200 tokens（不含 LLM 推理）
全程耗时：约 8 秒
对比截图方案：同样任务需要 20+ 次截图 + 多模态调用，token 消耗 > 30000
```

---

## 附录 B：工具速查表

| 工具 | 对标 | 用途 | 信噪比 |
|------|------|------|--------|
| `network_capture` | `tcpdump` | 配置网络拦截规则 | — |
| `network_query` | `jq .` | 查询已捕获的 API 响应 | ⭐⭐⭐ |
| `network_list` | `netstat` | 列出页面所有请求 | ⭐⭐⭐ |
| `network_fetch` | `curl` | 无 CORS 限制的 fetch | ⭐⭐⭐ |
| `network_replay` | `curl -b cookies` | 重放请求 | ⭐⭐⭐ |
| `dom_overview` | `ls` | 页面结构摘要 | ⭐⭐ |
| `dom_query` | `grep -o` | CSS 选择器精准提取 | ⭐⭐ |
| `dom_search` | `grep -C` | 全文搜索 + 上下文 | ⭐⭐ |
| `dom_structured_data` | `cat meta.json` | JSON-LD/OG/Meta 提取 | ⭐⭐⭐ |
| `dom_accessibility_tree` | `tree` | 无障碍树 | ⭐⭐ |
| `dom_element_detail` | `stat` | 单元素详细信息 | ⭐⭐ |
| `dom_wait_for` | `wait` | 等待元素出现 | — |
| `dom_diff` | `diff` | 操作前后 DOM 对比 | ⭐⭐ |
| `browser_screenshot` | `scrot` | 截图 | ⭐ |
| `browser_tabs_list` | `ps aux` | 列出所有标签页 | ⭐⭐⭐ |
| `browser_tab_info` | `env` | 当前标签页状态 | ⭐⭐⭐ |
| `action_click` | — | 点击元素 | — |
| `action_type` | `echo >` | 输入文本 | — |
| `action_scroll` | — | 滚动页面 | — |
| `action_fill_form` | — | 批量填表 | — |
| `script_evaluate` | `node -e` | 执行 JS | ⭐⭐ |
| `file_write` / `file_read` | `cat` / `>` | OPFS 文件操作 | ⭐⭐⭐ |
| `compute_json` | `jq` | JMESPath 查询 | ⭐⭐⭐ |
| `compute_python` | `python3 -c` | Pyodide Python | ⭐⭐⭐ |

---

*文档完毕。欢迎讨论和提出修改建议。*
