# ChromeX Codex Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将当前 Link2Chrome/ChromeX 项目封装为一个可被 Codex 安装、启用和分发的本地 Chrome 自动化插件。

**Architecture:** 采用“repo marketplace + plugin wrapper”的方案：插件目录放在仓库 `plugins/chromex/`，通过 `.agents/plugins/marketplace.json` 暴露给 Codex。插件本身复用现有 ChromeX 源码、MCP Server、Chrome 扩展、Native Host 安装脚本、诊断脚本和技能文档，避免复制核心运行时代码造成双源维护。

**Tech Stack:** Codex plugin manifest、Codex marketplace、MCP stdio server、Python 3.10+ venv、Node.js 18+、Chrome Manifest V3 extension、Native Messaging Host、现有 Link2Chrome runtime。

## Global Constraints

- 中文回复和中文文档必须使用 UTF-8；写入中文文件时避免系统默认编码导致乱码。
- 专门用于测试的文件统一放在 `/Users/zhangyu/PycharmProjects/Link2Chrome/test`。
- 用户本机 Python 版本可能是 3.9；安装前必须检测依赖是否要求更高版本。当前 `server/requirements.txt` 中 `mcp>=1.0.0` 和 `openai>=1.0.0` 对 Python 3.10+ 生效，项目 README 也声明 MCP Python SDK 需要 Python 3.10+。
- 本地部署应在虚拟环境中完成；若默认 `python3` 是 3.9，插件安装脚本必须寻找 `python3.10`、`python3.11` 或 `python3.12`，并在 `server/venv` 创建隔离环境。
- 不提交 `.env`、日志、缓存、虚拟环境、运行输出、浏览器 profile 数据或敏感凭据。
- Codex plugin manifest 必须位于插件根目录的 `.codex-plugin/plugin.json`；插件组件路径必须以 `./` 开头并相对插件根目录。
- Marketplace entry 必须包含 `policy.installation`、`policy.authentication` 和 `category`。

---

## 调研结论

### Codex 插件要求

来自 `/Users/zhangyu/PycharmProjects/Link2Chrome/docs/Codex Build plugins Instructions.md`：

- 插件入口是 `.codex-plugin/plugin.json`。
- 插件根目录可包含 `skills/`、`hooks/`、`.mcp.json`、`.app.json`、`assets/`。
- repo 级 marketplace 推荐路径是 `$REPO_ROOT/.agents/plugins/marketplace.json`。
- repo marketplace 的插件通常放在 `$REPO_ROOT/plugins/<plugin-name>`，`source.path` 使用相对 marketplace root 的 `./plugins/<plugin-name>`。
- Codex 安装 local plugin 后会从 `~/.codex/plugins/cache/<marketplace>/<plugin>/<version-or-local>/` 加载安装副本。
- Published-style manifest 可配置 `interface.displayName`、描述、能力、品牌色、图标、默认 prompt 等安装界面元数据。
- MCP server 可以通过插件根目录 `.mcp.json` 暴露。

### 官方 Chrome 插件样例

参考 `/Users/zhangyu/PycharmProjects/codex-chrome-extension-plugins/26.602.40724`：

- `.codex-plugin/plugin.json` 声明插件名 `chrome`、版本 `26.602.40724`、`skills: "./skills/"` 和丰富的 `interface` 元数据。
- `skills/control-chrome/SKILL.md` 是主要行为入口，强调仅在需要用户现有 Chrome 状态或用户明确要求 Chrome 时使用。
- 官方插件用 `scripts/browser-client.mjs` + `extension-host` 二进制 + Native Messaging Host 直连 Chrome 扩展。
- 官方插件包含 `docs/`，技能运行时按需读取 `api`、`playwright`、`confirmations`、`screenshots`、`chrome-troubleshooting` 等专题文档。
- 官方插件包含安装和诊断脚本：`installManifest.mjs`、`check-extension-installed.js`、`check-native-host-manifest.js`、`installed-browsers.js`、`chrome-is-running.js`、`open-chrome-window.js`。

### ChromeX/Link2Chrome 现状

当前仓库已经具备插件封装基础：

- `skills/link2chrome-browser-mcp/SKILL.md`：已是面向 Codex 的浏览器 MCP 使用说明，包含 session、Playwright、确认、安全、排错规则。
- `claude_config_snippet.json`：已有 MCP stdio 配置样例，server command 指向 `server/venv/bin/python server/main.py`。
- `server/main.py` 和 `server/tool_descriptions.py`：提供 26 个浏览器工具。
- `runtime/link2chrome-client.mjs`、`runtime/nodejs-playwright-runtime.mjs`、`runtime/docs/*.md`：提供 `browser_code_run` 和运行时文档。
- `extension/manifest.json`、`extension/background.js`、`extension/content.js`：Chrome MV3 扩展源码。
- `scripts/dev-extension/install.mjs`、`scripts/native-host/installManifest.mjs`、`scripts/native-host/native-host.mjs`：开发扩展和 Native Host bootstrap。
- `scripts/diagnostics/*.mjs`、`scripts/check-node-env.mjs`：已有环境与连接诊断脚本。

### 推荐封装路线

不要复制整个项目到插件目录。推荐创建一个轻量插件壳：

```text
/Users/zhangyu/PycharmProjects/Link2Chrome/
├── .agents/
│   └── plugins/
│       └── marketplace.json
├── plugins/
│   └── chromex/
│       ├── .codex-plugin/
│       │   └── plugin.json
│       ├── .mcp.json
│       ├── assets/
│       │   ├── icon128.png
│       │   └── composer.png
│       ├── docs/
│       │   ├── install.md
│       │   ├── troubleshooting.md
│       │   └── api-map.md
│       ├── scripts/
│       │   ├── install.mjs
│       │   ├── diagnose.mjs
│       │   └── resolve-project-root.mjs
│       └── skills/
│           └── control-chromex/
│               └── SKILL.md
```

这个插件壳通过相对路径解析仓库根目录，调用现有源码。优点是维护成本低、测试覆盖可复用、用户安装路径稳定。风险是 Codex 将 local plugin 安装到 cache 后，`${PLUGIN_ROOT}` 不再等于仓库根目录；因此必须在插件目录内提供 `scripts/resolve-project-root.mjs`，从插件安装副本回溯或通过环境变量 `CHROMEX_PROJECT_ROOT` 找到真实项目根目录。

## File Structure

- Create `/Users/zhangyu/PycharmProjects/Link2Chrome/.agents/plugins/marketplace.json`: repo 级插件目录，向 Codex 暴露 `chromex`。
- Create `/Users/zhangyu/PycharmProjects/Link2Chrome/plugins/chromex/.codex-plugin/plugin.json`: 插件 manifest 和安装界面元数据。
- Create `/Users/zhangyu/PycharmProjects/Link2Chrome/plugins/chromex/.mcp.json`: 插件绑定 MCP server，command 使用插件脚本解析真实项目根和 Python venv。
- Create `/Users/zhangyu/PycharmProjects/Link2Chrome/plugins/chromex/skills/control-chromex/SKILL.md`: 从现有 `skills/link2chrome-browser-mcp/SKILL.md` 收敛为插件入口，补充 Codex plugin 安装/诊断路径。
- Create `/Users/zhangyu/PycharmProjects/Link2Chrome/plugins/chromex/scripts/resolve-project-root.mjs`: 解析真实项目根目录，支持 `CHROMEX_PROJECT_ROOT` 和从 plugin cache 回溯。
- Create `/Users/zhangyu/PycharmProjects/Link2Chrome/plugins/chromex/scripts/install.mjs`: 检测 Node/Python，创建或复用 `server/venv`，安装 Python 依赖，安装 Native Host manifest，并提示用户加载扩展。
- Create `/Users/zhangyu/PycharmProjects/Link2Chrome/plugins/chromex/scripts/diagnose.mjs`: 聚合 `check-node-env.mjs`、extension install、native host manifest、MCP server 可启动性检查。
- Create `/Users/zhangyu/PycharmProjects/Link2Chrome/plugins/chromex/docs/install.md`: 插件安装和首次启动流程。
- Create `/Users/zhangyu/PycharmProjects/Link2Chrome/plugins/chromex/docs/troubleshooting.md`: 常见失败路径和诊断脚本。
- Create `/Users/zhangyu/PycharmProjects/Link2Chrome/plugins/chromex/docs/api-map.md`: 插件能力到现有 MCP 工具/运行时文档的映射。
- Create `/Users/zhangyu/PycharmProjects/Link2Chrome/test/chromex-plugin-manifest.test.mjs`: 验证 manifest、marketplace、`.mcp.json` 路径和 JSON schema 关键字段。
- Create `/Users/zhangyu/PycharmProjects/Link2Chrome/test/chromex-plugin-scripts.test.mjs`: 验证 project root 解析、Python 版本选择和诊断输出。

## Tasks

### Task 1: Repo Marketplace

**Files:**
- Create: `/Users/zhangyu/PycharmProjects/Link2Chrome/.agents/plugins/marketplace.json`
- Test: `/Users/zhangyu/PycharmProjects/Link2Chrome/test/chromex-plugin-manifest.test.mjs`

**Interfaces:**
- Consumes: none.
- Produces: marketplace named `chromex-local`, plugin entry name `chromex`, source path `./plugins/chromex`.

- [ ] **Step 1: Write failing marketplace test**

Add a Node test that reads `.agents/plugins/marketplace.json` as UTF-8 and asserts the required repo marketplace fields:

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("chromex repo marketplace exposes chromex plugin", async () => {
  const raw = await readFile(path.join(root, ".agents/plugins/marketplace.json"), "utf8");
  const marketplace = JSON.parse(raw);
  assert.equal(marketplace.name, "chromex-local");
  assert.equal(marketplace.interface.displayName, "ChromeX Local Plugins");
  assert.equal(marketplace.plugins.length, 1);
  assert.deepEqual(marketplace.plugins[0], {
    name: "chromex",
    source: {
      source: "local",
      path: "./plugins/chromex"
    },
    policy: {
      installation: "AVAILABLE",
      authentication: "ON_INSTALL"
    },
    category: "Productivity"
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test /Users/zhangyu/PycharmProjects/Link2Chrome/test/chromex-plugin-manifest.test.mjs
```

Expected: fails with `ENOENT` for `.agents/plugins/marketplace.json`.

- [ ] **Step 3: Create marketplace**

Create `/Users/zhangyu/PycharmProjects/Link2Chrome/.agents/plugins/marketplace.json`:

```json
{
  "name": "chromex-local",
  "interface": {
    "displayName": "ChromeX Local Plugins"
  },
  "plugins": [
    {
      "name": "chromex",
      "source": {
        "source": "local",
        "path": "./plugins/chromex"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Productivity"
    }
  ]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
node --test /Users/zhangyu/PycharmProjects/Link2Chrome/test/chromex-plugin-manifest.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add /Users/zhangyu/PycharmProjects/Link2Chrome/.agents/plugins/marketplace.json /Users/zhangyu/PycharmProjects/Link2Chrome/test/chromex-plugin-manifest.test.mjs
git commit -m "feat: add chromex codex marketplace"
```

### Task 2: Plugin Manifest and Assets

**Files:**
- Create: `/Users/zhangyu/PycharmProjects/Link2Chrome/plugins/chromex/.codex-plugin/plugin.json`
- Create: `/Users/zhangyu/PycharmProjects/Link2Chrome/plugins/chromex/assets/icon128.png`
- Create: `/Users/zhangyu/PycharmProjects/Link2Chrome/plugins/chromex/assets/composer.png`
- Modify: `/Users/zhangyu/PycharmProjects/Link2Chrome/test/chromex-plugin-manifest.test.mjs`

**Interfaces:**
- Consumes: marketplace entry from Task 1.
- Produces: plugin name `chromex`, skills path `./skills/`, MCP path `./.mcp.json`, install-surface metadata.

- [ ] **Step 1: Extend failing manifest test**

Append this test:

```js
test("chromex plugin manifest has install surface metadata", async () => {
  const raw = await readFile(path.join(root, "plugins/chromex/.codex-plugin/plugin.json"), "utf8");
  const manifest = JSON.parse(raw);
  assert.equal(manifest.name, "chromex");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.skills, "./skills/");
  assert.equal(manifest.mcpServers, "./.mcp.json");
  assert.equal(manifest.interface.displayName, "ChromeX");
  assert.equal(manifest.interface.shortDescription, "Control real Chrome with Link2Chrome");
  assert.deepEqual(manifest.interface.capabilities, ["Interactive", "Read"]);
  assert.equal(manifest.interface.composerIcon, "./assets/composer.png");
  assert.equal(manifest.interface.logo, "./assets/icon128.png");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test /Users/zhangyu/PycharmProjects/Link2Chrome/test/chromex-plugin-manifest.test.mjs
```

Expected: fails with `ENOENT` for plugin manifest.

- [ ] **Step 3: Create manifest**

Create `/Users/zhangyu/PycharmProjects/Link2Chrome/plugins/chromex/.codex-plugin/plugin.json`:

```json
{
  "name": "chromex",
  "version": "0.1.0",
  "description": "ChromeX browser automation for Codex using Link2Chrome, a local MCP server, a Chrome extension, and a native messaging bridge.",
  "author": {
    "name": "ChromeX"
  },
  "homepage": "https://github.com/local/chromex",
  "repository": "https://github.com/local/chromex",
  "license": "MIT",
  "keywords": ["browser", "chrome", "mcp", "automation", "link2chrome"],
  "skills": "./skills/",
  "mcpServers": "./.mcp.json",
  "interface": {
    "displayName": "ChromeX",
    "shortDescription": "Control real Chrome with Link2Chrome",
    "longDescription": "ChromeX lets Codex control your local Chrome browser through the Link2Chrome MCP server, Chrome extension, and native messaging bridge. It can navigate pages, inspect DOM, take screenshots, run Playwright-style browser code, and reuse your real browser session when you explicitly choose browser automation.",
    "developerName": "ChromeX",
    "category": "Productivity",
    "capabilities": ["Interactive", "Read"],
    "defaultPrompt": [
      "Use ChromeX to inspect the current Chrome page",
      "Use ChromeX to automate a multi-step browser workflow",
      "Use ChromeX to diagnose my Link2Chrome connection"
    ],
    "brandColor": "#2563EB",
    "composerIcon": "./assets/composer.png",
    "logo": "./assets/icon128.png",
    "screenshots": []
  }
}
```

- [ ] **Step 4: Copy assets from existing extension**

Copy binary assets without changing image bytes:

```bash
mkdir -p /Users/zhangyu/PycharmProjects/Link2Chrome/plugins/chromex/assets
cp /Users/zhangyu/PycharmProjects/Link2Chrome/extension/icons/icon128.png /Users/zhangyu/PycharmProjects/Link2Chrome/plugins/chromex/assets/icon128.png
cp /Users/zhangyu/PycharmProjects/Link2Chrome/extension/icons/icon48.png /Users/zhangyu/PycharmProjects/Link2Chrome/plugins/chromex/assets/composer.png
```

- [ ] **Step 5: Run test to verify it passes**

Run:

```bash
node --test /Users/zhangyu/PycharmProjects/Link2Chrome/test/chromex-plugin-manifest.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add /Users/zhangyu/PycharmProjects/Link2Chrome/plugins/chromex /Users/zhangyu/PycharmProjects/Link2Chrome/test/chromex-plugin-manifest.test.mjs
git commit -m "feat: add chromex plugin manifest"
```

### Task 3: Project Root Resolver

**Files:**
- Create: `/Users/zhangyu/PycharmProjects/Link2Chrome/plugins/chromex/scripts/resolve-project-root.mjs`
- Create: `/Users/zhangyu/PycharmProjects/Link2Chrome/test/chromex-plugin-scripts.test.mjs`

**Interfaces:**
- Consumes: optional env var `CHROMEX_PROJECT_ROOT`.
- Produces: exported async function `resolveProjectRoot({ env, startDir })`, CLI output `{ "projectRoot": "<abs path>" }`.

- [ ] **Step 1: Write failing resolver tests**

Create `/Users/zhangyu/PycharmProjects/Link2Chrome/test/chromex-plugin-scripts.test.mjs`:

```js
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const resolverPath = path.join(root, "plugins/chromex/scripts/resolve-project-root.mjs");

test("resolveProjectRoot prefers CHROMEX_PROJECT_ROOT", async () => {
  const { resolveProjectRoot } = await import(resolverPath);
  const result = await resolveProjectRoot({
    env: { CHROMEX_PROJECT_ROOT: root },
    startDir: path.join(root, "plugins/chromex/scripts")
  });
  assert.equal(result, root);
});

test("resolveProjectRoot walks upward to package marker", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "chromex-root-"));
  try {
    await mkdir(path.join(tmp, "server"), { recursive: true });
    await mkdir(path.join(tmp, "extension"), { recursive: true });
    await writeFile(path.join(tmp, "package.json"), "{\"dependencies\":{\"ws\":\"^8.21.0\"}}\n", "utf8");
    await writeFile(path.join(tmp, "server/main.py"), "", "utf8");
    await writeFile(path.join(tmp, "extension/manifest.json"), "{}", "utf8");
    const nested = path.join(tmp, "plugins/chromex/scripts");
    await mkdir(nested, { recursive: true });
    const { resolveProjectRoot } = await import(resolverPath);
    assert.equal(await resolveProjectRoot({ env: {}, startDir: nested }), tmp);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test /Users/zhangyu/PycharmProjects/Link2Chrome/test/chromex-plugin-scripts.test.mjs
```

Expected: fails with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement resolver**

Create `/Users/zhangyu/PycharmProjects/Link2Chrome/plugins/chromex/scripts/resolve-project-root.mjs`:

```js
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

async function exists(filePath) {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function isProjectRoot(dir) {
  return await exists(path.join(dir, "package.json"))
    && await exists(path.join(dir, "server", "main.py"))
    && await exists(path.join(dir, "extension", "manifest.json"));
}

export async function resolveProjectRoot({
  env = process.env,
  startDir = path.dirname(fileURLToPath(import.meta.url))
} = {}) {
  if (env.CHROMEX_PROJECT_ROOT) {
    const explicit = path.resolve(env.CHROMEX_PROJECT_ROOT);
    if (!await isProjectRoot(explicit)) {
      throw new Error(`CHROMEX_PROJECT_ROOT is not a ChromeX project root: ${explicit}`);
    }
    return explicit;
  }

  let current = path.resolve(startDir);
  while (true) {
    if (await isProjectRoot(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error("Unable to locate ChromeX project root. Set CHROMEX_PROJECT_ROOT=/absolute/path/to/Link2Chrome.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  resolveProjectRoot()
    .then((projectRoot) => console.log(JSON.stringify({ projectRoot }, null, 2)))
    .catch((error) => {
      console.error(error.message || String(error));
      process.exitCode = 1;
    });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
node --test /Users/zhangyu/PycharmProjects/Link2Chrome/test/chromex-plugin-scripts.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add /Users/zhangyu/PycharmProjects/Link2Chrome/plugins/chromex/scripts/resolve-project-root.mjs /Users/zhangyu/PycharmProjects/Link2Chrome/test/chromex-plugin-scripts.test.mjs
git commit -m "feat: resolve chromex project root"
```

### Task 4: Plugin MCP Configuration

**Files:**
- Create: `/Users/zhangyu/PycharmProjects/Link2Chrome/plugins/chromex/.mcp.json`
- Modify: `/Users/zhangyu/PycharmProjects/Link2Chrome/test/chromex-plugin-manifest.test.mjs`

**Interfaces:**
- Consumes: `scripts/resolve-project-root.mjs` from Task 3.
- Produces: plugin MCP server id `local-browser`, command `node`, args to a future launcher script.

- [ ] **Step 1: Extend failing MCP config test**

Implementation discovery: the plugin validator accepts `.mcp.json` with top-level `mcpServers`, not `mcp_servers`; use the camelCase key below.

Append:

```js
test("chromex mcp config declares local-browser server", async () => {
  const raw = await readFile(path.join(root, "plugins/chromex/.mcp.json"), "utf8");
  const config = JSON.parse(raw);
  assert.equal(config.mcpServers["local-browser"].command, "node");
  assert.deepEqual(config.mcpServers["local-browser"].args, ["./scripts/mcp-server.mjs"]);
  assert.equal(config.mcpServers["local-browser"].env.LOG_LEVEL, "INFO");
  assert.equal(config.mcpServers["local-browser"].env.LOG_CONSOLE, "false");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test /Users/zhangyu/PycharmProjects/Link2Chrome/test/chromex-plugin-manifest.test.mjs
```

Expected: fails with `ENOENT` for `.mcp.json`.

- [ ] **Step 3: Create `.mcp.json`**

Create:

```json
{
  "mcpServers": {
    "local-browser": {
      "command": "node",
      "args": ["./scripts/mcp-server.mjs"],
      "env": {
        "LOG_LEVEL": "INFO",
        "LOG_CONSOLE": "false"
      }
    }
  }
}
```

- [ ] **Step 4: Create MCP launcher in follow-up task**

Do not point `.mcp.json` directly at `server/venv/bin/python` because Codex runs plugins from installed cache paths. Task 5 creates `scripts/mcp-server.mjs`, which resolves the real project root and launches the Python server.

- [ ] **Step 5: Run test to verify it passes**

Run:

```bash
node --test /Users/zhangyu/PycharmProjects/Link2Chrome/test/chromex-plugin-manifest.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add /Users/zhangyu/PycharmProjects/Link2Chrome/plugins/chromex/.mcp.json /Users/zhangyu/PycharmProjects/Link2Chrome/test/chromex-plugin-manifest.test.mjs
git commit -m "feat: add chromex plugin mcp config"
```

### Task 5: MCP Server Launcher

**Files:**
- Create: `/Users/zhangyu/PycharmProjects/Link2Chrome/plugins/chromex/scripts/mcp-server.mjs`
- Modify: `/Users/zhangyu/PycharmProjects/Link2Chrome/test/chromex-plugin-scripts.test.mjs`

**Interfaces:**
- Consumes: `resolveProjectRoot()`.
- Produces: exported function `createMcpServerLaunchPlan({ projectRoot, env })` returning `{ command, args, cwd, env }`.

- [ ] **Step 1: Write failing launcher test**

Append:

```js
test("createMcpServerLaunchPlan points to project venv python and server main", async () => {
  const launcherPath = path.join(root, "plugins/chromex/scripts/mcp-server.mjs");
  const { createMcpServerLaunchPlan } = await import(launcherPath);
  const plan = createMcpServerLaunchPlan({
    projectRoot: root,
    env: { LOG_LEVEL: "DEBUG", LOG_CONSOLE: "false" }
  });
  assert.equal(plan.command, path.join(root, "server/venv/bin/python"));
  assert.deepEqual(plan.args, [path.join(root, "server/main.py")]);
  assert.equal(plan.cwd, root);
  assert.equal(plan.env.LOG_LEVEL, "DEBUG");
  assert.equal(plan.env.LOG_CONSOLE, "false");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test /Users/zhangyu/PycharmProjects/Link2Chrome/test/chromex-plugin-scripts.test.mjs
```

Expected: fails with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement launcher**

Create `/Users/zhangyu/PycharmProjects/Link2Chrome/plugins/chromex/scripts/mcp-server.mjs`:

```js
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveProjectRoot } from "./resolve-project-root.mjs";

export function createMcpServerLaunchPlan({ projectRoot, env = process.env } = {}) {
  if (!projectRoot) throw new Error("projectRoot is required");
  return {
    command: path.join(projectRoot, "server", "venv", "bin", "python"),
    args: [path.join(projectRoot, "server", "main.py")],
    cwd: projectRoot,
    env: {
      ...process.env,
      ...env,
      LOG_LEVEL: env.LOG_LEVEL || "INFO",
      LOG_CONSOLE: env.LOG_CONSOLE || "false"
    }
  };
}

async function main() {
  const projectRoot = await resolveProjectRoot();
  const plan = createMcpServerLaunchPlan({ projectRoot });
  const child = spawn(plan.command, plan.args, {
    cwd: plan.cwd,
    env: plan.env,
    stdio: "inherit"
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exitCode = code ?? 1;
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message || String(error));
    process.exitCode = 1;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
node --test /Users/zhangyu/PycharmProjects/Link2Chrome/test/chromex-plugin-scripts.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add /Users/zhangyu/PycharmProjects/Link2Chrome/plugins/chromex/scripts/mcp-server.mjs /Users/zhangyu/PycharmProjects/Link2Chrome/test/chromex-plugin-scripts.test.mjs
git commit -m "feat: add chromex mcp launcher"
```

### Task 6: Install and Diagnose Scripts

**Files:**
- Create: `/Users/zhangyu/PycharmProjects/Link2Chrome/plugins/chromex/scripts/install.mjs`
- Create: `/Users/zhangyu/PycharmProjects/Link2Chrome/plugins/chromex/scripts/diagnose.mjs`
- Modify: `/Users/zhangyu/PycharmProjects/Link2Chrome/test/chromex-plugin-scripts.test.mjs`

**Interfaces:**
- Consumes: `resolveProjectRoot()`, existing `scripts/dev-extension/install.mjs`, `server/requirements.txt`.
- Produces: install command `node plugins/chromex/scripts/install.mjs`, diagnose command `node plugins/chromex/scripts/diagnose.mjs`.

- [ ] **Step 1: Write failing tests for Python selection**

Append:

```js
test("selectPythonCandidate rejects python 3.9 and accepts python 3.10+", async () => {
  const installPath = path.join(root, "plugins/chromex/scripts/install.mjs");
  const { selectPythonCandidate } = await import(installPath);
  const candidates = [
    { command: "python3", version: "3.9.18" },
    { command: "python3.10", version: "3.10.14" }
  ];
  assert.deepEqual(selectPythonCandidate(candidates), candidates[1]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test /Users/zhangyu/PycharmProjects/Link2Chrome/test/chromex-plugin-scripts.test.mjs
```

Expected: fails with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement installer exports**

Create `install.mjs` with testable exports:

```js
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveProjectRoot } from "./resolve-project-root.mjs";

export function parsePythonVersion(versionText) {
  const match = String(versionText).match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function supportsChromeXPython(versionText) {
  const version = parsePythonVersion(versionText);
  return Boolean(version && (version.major > 3 || (version.major === 3 && version.minor >= 10)));
}

export function selectPythonCandidate(candidates) {
  return candidates.find((candidate) => supportsChromeXPython(candidate.version)) || null;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
  });
}

async function main() {
  const projectRoot = await resolveProjectRoot();
  console.log(`ChromeX project root: ${projectRoot}`);
  console.log("Use python3.10+ to create server/venv before installing Python dependencies.");
  await run("node", [path.join(projectRoot, "scripts/dev-extension/install.mjs")], { cwd: projectRoot });
  console.log("Next: load the extension directory in chrome://extensions and restart Codex.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message || String(error));
    process.exitCode = 1;
  });
}
```

- [ ] **Step 4: Implement diagnose script**

Create `diagnose.mjs`:

```js
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveProjectRoot } from "./resolve-project-root.mjs";

function runCheck(label, command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  return {
    label,
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim()
  };
}

async function main() {
  const projectRoot = await resolveProjectRoot();
  const checks = [
    runCheck("node-env", "node", [path.join(projectRoot, "scripts/check-node-env.mjs"), "--json"], projectRoot),
    runCheck("extension-installed", "node", [path.join(projectRoot, "scripts/diagnostics/check-extension-installed.mjs")], projectRoot),
    runCheck("native-host-manifest", "node", [path.join(projectRoot, "scripts/diagnostics/check-native-host-manifest.mjs")], projectRoot)
  ];
  console.log(JSON.stringify({ ok: checks.every((check) => check.ok), projectRoot, checks }, null, 2));
  if (!checks.every((check) => check.ok)) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message || String(error));
    process.exitCode = 1;
  });
}
```

- [ ] **Step 5: Run tests**

Run:

```bash
node --test /Users/zhangyu/PycharmProjects/Link2Chrome/test/chromex-plugin-scripts.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Manual install verification**

Run:

```bash
node /Users/zhangyu/PycharmProjects/Link2Chrome/plugins/chromex/scripts/install.mjs
node /Users/zhangyu/PycharmProjects/Link2Chrome/plugins/chromex/scripts/diagnose.mjs
```

Expected: installer prints extension load instructions; diagnose returns JSON with per-check status.

- [ ] **Step 7: Commit**

```bash
git add /Users/zhangyu/PycharmProjects/Link2Chrome/plugins/chromex/scripts /Users/zhangyu/PycharmProjects/Link2Chrome/test/chromex-plugin-scripts.test.mjs
git commit -m "feat: add chromex plugin install diagnostics"
```

### Task 7: Plugin Skill and Docs

**Files:**
- Create: `/Users/zhangyu/PycharmProjects/Link2Chrome/plugins/chromex/skills/control-chromex/SKILL.md`
- Create: `/Users/zhangyu/PycharmProjects/Link2Chrome/plugins/chromex/docs/install.md`
- Create: `/Users/zhangyu/PycharmProjects/Link2Chrome/plugins/chromex/docs/troubleshooting.md`
- Create: `/Users/zhangyu/PycharmProjects/Link2Chrome/plugins/chromex/docs/api-map.md`
- Modify: `/Users/zhangyu/PycharmProjects/Link2Chrome/test/chromex-plugin-manifest.test.mjs`

**Interfaces:**
- Consumes: existing `/skills/link2chrome-browser-mcp/SKILL.md`, plugin scripts, `.mcp.json`.
- Produces: skill name `control-chromex`, docs names `install`, `troubleshooting`, `api-map`.

- [ ] **Step 1: Write failing skill/docs test**

Append:

```js
test("chromex skill and docs are present", async () => {
  const skill = await readFile(path.join(root, "plugins/chromex/skills/control-chromex/SKILL.md"), "utf8");
  assert.match(skill, /^---\nname: control-chromex\n/m);
  assert.match(skill, /browser_diagnose/);
  assert.match(skill, /browser_session/);
  assert.match(skill, /browser_code_run/);

  for (const name of ["install.md", "troubleshooting.md", "api-map.md"]) {
    const doc = await readFile(path.join(root, "plugins/chromex/docs", name), "utf8");
    assert.ok(doc.includes("ChromeX"));
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test /Users/zhangyu/PycharmProjects/Link2Chrome/test/chromex-plugin-manifest.test.mjs
```

Expected: fails with `ENOENT` for `SKILL.md`.

- [ ] **Step 3: Create skill**

Start from existing `skills/link2chrome-browser-mcp/SKILL.md` and adapt the heading/frontmatter:

````md
---
name: control-chromex
description: Control the user's real Chrome through ChromeX/Link2Chrome MCP when a task needs local browser state, page inspection, screenshots, DOM extraction, or Playwright-style automation.
---

# ChromeX

Use ChromeX when the user mentions `@chromex`, asks to use Link2Chrome, or needs browser automation that depends on the user's real Chrome state.

Before browser work, prefer purpose-built connectors, APIs, or CLIs. Use ChromeX when the user explicitly requests Chrome/ChromeX/Link2Chrome, when the task needs open tabs or login state, or when local page inspection is the requested goal.

Start with:

```text
1. browser_diagnose()
2. browser_session(action='create', session='<task-name>', group_title='<user-language-title>')
3. browser_session(action='new_tab', session='<task-name>', url='<target-url>')
4. pass session='<task-name>' to all subsequent tools
```

For multi-step automation, use `browser_code_run` and read `await browser.documentation()` before writing runtime code. Use `await agent.documentation.get("playwright")` before relying on `tab.playwright`.

For setup or failures, run `node plugins/chromex/scripts/diagnose.mjs` from the project root and read `plugins/chromex/docs/troubleshooting.md`.
````

Then copy over the detailed session, cleanup, safety, confirmation, and browser_code_run examples from `/Users/zhangyu/PycharmProjects/Link2Chrome/skills/link2chrome-browser-mcp/SKILL.md`, keeping the Chinese instructions and UTF-8 encoding.

- [ ] **Step 4: Create docs**

Create `install.md` with:

```md
# ChromeX Install

ChromeX is packaged as a Codex repo plugin at `plugins/chromex`.

1. Restart Codex so it discovers `.agents/plugins/marketplace.json`.
2. Install or enable the `chromex` plugin from the `ChromeX Local Plugins` marketplace.
3. From the project root, run `node plugins/chromex/scripts/install.mjs`.
4. Load `/Users/zhangyu/PycharmProjects/Link2Chrome/extension` in `chrome://extensions` with Developer Mode enabled.
5. Run `node plugins/chromex/scripts/diagnose.mjs`.

Python note: ChromeX requires Python 3.10+ for the MCP SDK path. If your default Python is 3.9, create `server/venv` with `python3.10`, `python3.11`, or `python3.12`.
```

Create `troubleshooting.md` with:

````md
# ChromeX Troubleshooting

Run:

```bash
node plugins/chromex/scripts/diagnose.mjs
```

Check failures in this order:

1. Node.js must be 18+.
2. Python venv must exist at `server/venv` and use Python 3.10+.
3. Chrome extension must be loaded from the project `extension/` directory.
4. Native host manifest must point to `scripts/native-host/native-host.mjs`.
5. Browser Hub and extension WebSocket ports must be reachable.
````

Create `api-map.md` with:

```md
# ChromeX API Map

The plugin exposes the existing Link2Chrome MCP server as `local-browser`.

Core workflow:

- `browser_diagnose`: connection and setup check.
- `browser_session`: session and Chrome tab-group boundary.
- `browser_dom_overview`, `browser_dom_query`, `browser_dom_get_text`: page inspection.
- `browser_screenshot`: visual state.
- `action_click`, `action_fill`, `action_press_key`, `action_scroll`: simple actions.
- `browser_code_run`: multi-step Playwright-style automation.

Runtime docs live in `/Users/zhangyu/PycharmProjects/Link2Chrome/runtime/docs`.
```

- [ ] **Step 5: Run test to verify it passes**

Run:

```bash
node --test /Users/zhangyu/PycharmProjects/Link2Chrome/test/chromex-plugin-manifest.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add /Users/zhangyu/PycharmProjects/Link2Chrome/plugins/chromex/skills /Users/zhangyu/PycharmProjects/Link2Chrome/plugins/chromex/docs /Users/zhangyu/PycharmProjects/Link2Chrome/test/chromex-plugin-manifest.test.mjs
git commit -m "feat: add chromex plugin skill docs"
```

### Task 8: End-to-End Plugin Validation

**Files:**
- Modify: `/Users/zhangyu/PycharmProjects/Link2Chrome/README.md`
- Modify: `/Users/zhangyu/PycharmProjects/Link2Chrome/docs/2026-06-22-chromex-codex-plugin-plan.md` only if implementation discoveries change the plan.

**Interfaces:**
- Consumes: all previous tasks.
- Produces: documented local plugin install workflow.

- [ ] **Step 1: Run static validation**

Run:

```bash
node --test /Users/zhangyu/PycharmProjects/Link2Chrome/test/chromex-plugin-manifest.test.mjs /Users/zhangyu/PycharmProjects/Link2Chrome/test/chromex-plugin-scripts.test.mjs
```

Expected: PASS.

- [ ] **Step 2: Run existing focused tests**

Run:

```bash
node --test /Users/zhangyu/PycharmProjects/Link2Chrome/test/diagnostics.test.mjs /Users/zhangyu/PycharmProjects/Link2Chrome/test/dev-extension-bootstrap.test.mjs /Users/zhangyu/PycharmProjects/Link2Chrome/test/native-host-manifest.test.mjs
```

Expected: PASS.

- [ ] **Step 3: Validate plugin with plugin-creator validator**

Run:

```bash
python3 /Users/zhangyu/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py /Users/zhangyu/PycharmProjects/Link2Chrome/plugins/chromex
```

Expected: PASS or no schema errors. If the validator rejects `hooks` or unsupported manifest fields, remove unsupported fields rather than suppressing validation.

- [ ] **Step 4: Manual Codex discovery check**

Run:

```bash
codex plugin marketplace list
```

Expected: Codex sees repo or local marketplace entry for `/Users/zhangyu/PycharmProjects/Link2Chrome/.agents/plugins/marketplace.json` after restart. If not listed, restart Codex and confirm `.agents/plugins/marketplace.json` JSON is valid.

- [ ] **Step 5: Manual plugin install check**

In Codex app:

1. Open Plugins.
2. Select `ChromeX Local Plugins`.
3. Install or enable `ChromeX`.
4. Start a new thread and trigger `@chromex`.
5. Ask for a setup diagnosis.

Expected: `control-chromex` skill becomes available and the `local-browser` MCP server can be enabled.

- [ ] **Step 6: Update README**

Add a short section:

````md
## Codex Plugin

This repository includes a local Codex plugin at `plugins/chromex`.

After restarting Codex, install `ChromeX` from the `ChromeX Local Plugins` marketplace. Then run:

```bash
node plugins/chromex/scripts/install.mjs
node plugins/chromex/scripts/diagnose.mjs
```

If your default Python is 3.9, create `server/venv` with Python 3.10+ before installing dependencies.
````

- [ ] **Step 7: Final full verification**

Run:

```bash
node --test /Users/zhangyu/PycharmProjects/Link2Chrome/test/*.mjs
/Users/zhangyu/PycharmProjects/Link2Chrome/server/venv/bin/python -m pytest /Users/zhangyu/PycharmProjects/Link2Chrome/test
```

Expected: PASS. If `server/venv` does not exist, create it with Python 3.10+ first.

- [ ] **Step 8: Commit**

```bash
git add /Users/zhangyu/PycharmProjects/Link2Chrome/README.md /Users/zhangyu/PycharmProjects/Link2Chrome/docs/2026-06-22-chromex-codex-plugin-plan.md
git commit -m "docs: document chromex codex plugin"
```

## Risks and Decisions

- **Codex cache path:** local plugin install uses a cache copy, so plugin scripts cannot assume `PLUGIN_ROOT` equals repo root. Mitigation: `CHROMEX_PROJECT_ROOT` override plus upward root discovery.
- **Python 3.9:** current MCP SDK path requires Python 3.10+. Mitigation: installer must select Python 3.10+ and explain failure clearly.
- **Native Host path:** manifest must point to the real project `scripts/native-host/native-host.mjs`, not the plugin cache. Mitigation: installer resolves project root before calling existing bootstrap.
- **Extension install:** Chrome extension still needs manual Developer Mode loading unless future packaging adds signed extension distribution. Mitigation: plugin docs and installer print exact extension path.
- **MCP server lifecycle:** Codex plugin `.mcp.json` should launch a Node wrapper, not Python directly, so root resolution and env handling are centralized.
- **Duplicate skill wording:** existing root skill and plugin skill may drift. Mitigation: keep plugin skill mostly a thin, curated copy and document `scripts/sync-skill-docs.sh` as a future improvement.

## Self-Review

- Spec coverage: manifest, marketplace, MCP config, skills, scripts, docs, tests, Python version constraint, UTF-8 concern, and official Chrome plugin parity are covered by Tasks 1-8.
- Placeholder scan: no unresolved placeholder markers and no vague “add tests” steps; each task includes concrete files, snippets, commands, and expected results.
- Type consistency: `resolveProjectRoot`, `createMcpServerLaunchPlan`, `selectPythonCandidate`, plugin name `chromex`, MCP server id `local-browser`, and marketplace name `chromex-local` are used consistently across tasks.
