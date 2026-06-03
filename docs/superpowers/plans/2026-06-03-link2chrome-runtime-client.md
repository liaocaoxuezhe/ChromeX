# Link2Chrome Runtime Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a JavaScript runtime client so agents can write code against Browser, Tab, Locator, Playwright-style, and CUA objects while reusing the existing Link2Chrome server and extension.

**Architecture:** Create a dependency-free Node ESM client in `runtime/link2chrome-client.mjs`. The client accepts an injectable transport for tests and exposes an object API that maps method calls to existing Link2Chrome command names. Documentation updates clarify that DOM, CUA, and Playwright endpoint support are parallel control surfaces, not mutually exclusive modes.

**Tech Stack:** Node.js ESM, Node built-in `node:test`, existing Python MCP/WebSocket/extension backend, Markdown docs.

---

## File Structure

- Create `runtime/link2chrome-client.mjs`: runtime entrypoint, transport abstraction, Browser/Tab/Locator classes, CUA and Playwright-style API surfaces.
- Create `runtime/examples/basic-navigation.mjs`: minimal agent-style flow using selected tab, navigation, DOM snapshot, and text locator.
- Create `runtime/examples/locator-search.mjs`: form/search style flow showing locator fill and role/text click patterns.
- Create `test/runtime-client.test.mjs`: Node built-in tests with fake transport. This lives under `test/` per project instruction.
- Modify `README.md`: document code-first runtime client and replace "three modes" wording.
- Modify `.codex/skills/link2chrome-browser-mcp/SKILL.md`, `.claude/skills/link2chrome-browser-mcp/SKILL.md`, and `skills/link2chrome-browser-mcp/SKILL.md`: explain runtime-first usage and parallel control surfaces.
- Modify `.codex/skills/link2chrome-browser-mcp/commands/browser-pw.md`, `browser-dom.md`, `browser-cua.md`: remove `set_mode` language and describe surfaces directly.

## Task 1: Runtime Client Skeleton

**Files:**
- Create: `runtime/link2chrome-client.mjs`
- Test: `test/runtime-client.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createLink2ChromeClient } from "../runtime/link2chrome-client.mjs";

function fakeTransport() {
  const calls = [];
  return {
    calls,
    async command(name, args = {}) {
      calls.push({ name, args });
      if (name === "browser_tabs_list") {
        return { tabs: [{ id: 7, active: true, url: "https://example.com", title: "Example" }] };
      }
      return { ok: true };
    },
  };
}

test("browsers.get returns an extension browser with tabs API", async () => {
  const transport = fakeTransport();
  const link2chrome = createLink2ChromeClient({ transport });

  const browser = await link2chrome.browsers.get("extension");
  const tabs = await browser.tabs.list();

  assert.equal(browser.kind, "extension");
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].id, 7);
  assert.deepEqual(transport.calls[0], { name: "browser_tabs_list", args: {} });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test test/runtime-client.test.mjs
```

Expected: FAIL because `runtime/link2chrome-client.mjs` does not exist or does not export `createLink2ChromeClient`.

- [ ] **Step 3: Write minimal implementation**

Create `runtime/link2chrome-client.mjs`:

```js
export function createLink2ChromeClient({ transport } = {}) {
  if (!transport || typeof transport.command !== "function") {
    throw new TypeError("createLink2ChromeClient requires a transport with command(name, args)");
  }
  return {
    browsers: {
      async get(kind = "extension") {
        if (kind !== "extension") {
          throw new Error(`unsupported browser kind: ${kind}`);
        }
        return new Browser({ kind, transport });
      },
    },
  };
}

class Browser {
  constructor({ kind, transport }) {
    this.kind = kind;
    this._transport = transport;
    this.tabs = new Tabs({ browser: this, transport });
  }
}

class Tabs {
  constructor({ browser, transport }) {
    this._browser = browser;
    this._transport = transport;
  }

  async list() {
    const raw = await this._transport.command("browser_tabs_list", {});
    return (raw.tabs || []).map((tab) => new Tab({ browser: this._browser, transport: this._transport, data: tab, raw: tab }));
  }
}

class Tab {
  constructor({ browser, transport, data = {}, raw = data }) {
    this.browser = browser;
    this._transport = transport;
    this.id = data.id;
    this.url = data.url;
    this.title = data.title;
    this.active = data.active;
    this.raw = raw;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
node --test test/runtime-client.test.mjs
```

Expected: PASS for the skeleton test.

- [ ] **Step 5: Commit**

```bash
git add runtime/link2chrome-client.mjs test/runtime-client.test.mjs
git commit -m "feat: add Link2Chrome runtime client skeleton"
```

## Task 2: Browser And Tab Lifecycle API

**Files:**
- Modify: `runtime/link2chrome-client.mjs`
- Modify: `test/runtime-client.test.mjs`

- [ ] **Step 1: Write failing tests**

Append:

```js
test("tabs.selected returns active tab info and tab navigation uses browser_navigate", async () => {
  const transport = {
    calls: [],
    async command(name, args = {}) {
      this.calls.push({ name, args });
      if (name === "browser_tab_info") {
        return { id: 7, active: true, url: "https://start.test", title: "Start" };
      }
      if (name === "browser_navigate") {
        return { ok: true, url: args.url };
      }
      return { ok: true };
    },
  };
  const browser = await createLink2ChromeClient({ transport }).browsers.get("extension");

  const tab = await browser.tabs.selected();
  const result = await tab.goto("https://example.com");

  assert.equal(tab.id, 7);
  assert.equal(result.ok, true);
  assert.deepEqual(transport.calls, [
    { name: "browser_tab_info", args: {} },
    { name: "browser_navigate", args: { url: "https://example.com" } },
  ]);
});

test("tabs.finalize is a structured no-op for deliverable handoff habits", async () => {
  const transport = fakeTransport();
  const browser = await createLink2ChromeClient({ transport }).browsers.get("extension");
  const [tab] = await browser.tabs.list();

  const result = await browser.tabs.finalize({ keep: [{ tab, status: "deliverable" }] });

  assert.deepEqual(result, {
    ok: true,
    action: "finalize",
    kept: [{ tabId: 7, status: "deliverable" }],
    raw: null,
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
node --test test/runtime-client.test.mjs
```

Expected: FAIL because `tabs.selected`, `tab.goto`, and `tabs.finalize` are missing.

- [ ] **Step 3: Implement lifecycle methods**

Add methods:

```js
class Browser {
  constructor({ kind, transport }) {
    this.kind = kind;
    this._transport = transport;
    this.tabs = new Tabs({ browser: this, transport });
  }

  async nameSession(name) {
    this.sessionName = name;
    return { ok: true, name };
  }
}

class Tabs {
  // existing constructor and list()

  async selected() {
    const raw = await this._transport.command("browser_tab_info", {});
    return new Tab({ browser: this._browser, transport: this._transport, data: raw, raw });
  }

  async get(id) {
    const tabs = await this.list();
    return tabs.find((tab) => tab.id === id) || null;
  }

  async new(url) {
    const raw = await this._transport.command("browser_tab_new", url ? { url } : {});
    return new Tab({ browser: this._browser, transport: this._transport, data: raw, raw });
  }

  async finalize({ keep = [] } = {}) {
    return {
      ok: true,
      action: "finalize",
      kept: keep.map((item) => ({
        tabId: item.tab?.id ?? item.tabId ?? null,
        status: item.status || "handoff",
      })),
      raw: null,
    };
  }
}

class Tab {
  // existing constructor

  async goto(url) {
    return this._transport.command("browser_navigate", { url });
  }

  async reload() {
    const current = await this.info();
    return this.goto(current.url);
  }

  async info() {
    return this._transport.command("browser_tab_info", {});
  }

  async screenshot(options = {}) {
    return this._transport.command("browser.cua.screenshot", options);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
node --test test/runtime-client.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add runtime/link2chrome-client.mjs test/runtime-client.test.mjs
git commit -m "feat: add runtime browser tab lifecycle"
```

## Task 3: Playwright-Style Locator API

**Files:**
- Modify: `runtime/link2chrome-client.mjs`
- Modify: `test/runtime-client.test.mjs`

- [ ] **Step 1: Write failing tests**

Append:

```js
test("locator fill maps to browser.dom.type", async () => {
  const transport = fakeTransport();
  const browser = await createLink2ChromeClient({ transport }).browsers.get("extension");
  const [tab] = await browser.tabs.list();

  await tab.playwright.locator("input[name='q']").fill("Link2Chrome");

  assert.deepEqual(transport.calls.at(-1), {
    name: "browser.dom.type",
    args: {
      target: { selector: "input[name='q']" },
      text: "Link2Chrome",
      clearFirst: true,
    },
  });
});

test("getByText count maps to browser.dom.search", async () => {
  const transport = {
    calls: [],
    async command(name, args = {}) {
      this.calls.push({ name, args });
      if (name === "browser.dom.search") {
        return { matches: [{ text: "More information" }, { text: "More links" }] };
      }
      return { tabs: [{ id: 7, active: true }] };
    },
  };
  const browser = await createLink2ChromeClient({ transport }).browsers.get("extension");
  const [tab] = await browser.tabs.list();

  const count = await tab.playwright.getByText("More").count();

  assert.equal(count, 2);
  assert.deepEqual(transport.calls.at(-1), {
    name: "browser.dom.search",
    args: { query: "More" },
  });
});

test("getByRole click maps to browser.dom.click with role and name target", async () => {
  const transport = fakeTransport();
  const browser = await createLink2ChromeClient({ transport }).browsers.get("extension");
  const [tab] = await browser.tabs.list();

  await tab.playwright.getByRole("button", { name: "Search" }).click();

  assert.deepEqual(transport.calls.at(-1), {
    name: "browser.dom.click",
    args: { target: { role: "button", text: "Search" } },
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
node --test test/runtime-client.test.mjs
```

Expected: FAIL because `tab.playwright` and `Locator` are missing.

- [ ] **Step 3: Implement Playwright-style API**

Add:

```js
class Tab {
  constructor({ browser, transport, data = {}, raw = data }) {
    this.browser = browser;
    this._transport = transport;
    this.id = data.id;
    this.url = data.url;
    this.title = data.title;
    this.active = data.active;
    this.raw = raw;
    this.playwright = new PlaywrightSurface({ tab: this, transport });
    this.cua = new CuaSurface({ tab: this, transport });
    this.dom_cua = new DomCuaSurface({ tab: this, transport });
    this.dev = new DevSurface({ tab: this, transport });
  }
}

class PlaywrightSurface {
  constructor({ tab, transport }) {
    this._tab = tab;
    this._transport = transport;
  }

  async domSnapshot(options = {}) {
    return this._transport.command("browser.dom.overview", options);
  }

  locator(selector) {
    return new Locator({ transport: this._transport, target: { selector } });
  }

  getByText(text) {
    return new Locator({ transport: this._transport, target: { text } });
  }

  getByRole(role, options = {}) {
    return new Locator({ transport: this._transport, target: { role, text: options.name } });
  }

  getByTestId(testId) {
    const escaped = String(testId).replaceAll('"', '\\"');
    return this.locator(`[data-testid="${escaped}"], [data-test-id="${escaped}"], [data-test="${escaped}"]`);
  }
}

class Locator {
  constructor({ transport, target }) {
    this._transport = transport;
    this.target = target;
  }

  async count() {
    if (this.target.text && !this.target.selector) {
      const raw = await this._transport.command("browser.dom.search", { query: this.target.text });
      return (raw.matches || raw.elements || []).length;
    }
    const raw = await this._transport.command("browser.dom.query", { selector: this.target.selector, limit: 100 });
    return (raw.elements || raw.matches || []).length;
  }

  async click(options = {}) {
    return this._transport.command("browser.dom.click", { target: this.target, ...options });
  }

  async fill(text, options = {}) {
    return this._transport.command("browser.dom.type", {
      target: this.target,
      text,
      clearFirst: options.clearFirst ?? true,
    });
  }

  async textContent() {
    if (this.target.text && !this.target.selector) {
      return this.target.text;
    }
    const raw = await this._transport.command("browser.dom.query", { selector: this.target.selector, limit: 1 });
    const first = (raw.elements || raw.matches || [])[0];
    return first?.text || first?.textContent || "";
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
node --test test/runtime-client.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add runtime/link2chrome-client.mjs test/runtime-client.test.mjs
git commit -m "feat: add runtime locator API"
```

## Task 4: CUA, DOM CUA, And Dev Surfaces

**Files:**
- Modify: `runtime/link2chrome-client.mjs`
- Modify: `test/runtime-client.test.mjs`

- [ ] **Step 1: Write failing tests**

Append:

```js
test("cua click maps to browser.cua.click", async () => {
  const transport = fakeTransport();
  const browser = await createLink2ChromeClient({ transport }).browsers.get("extension");
  const [tab] = await browser.tabs.list();

  await tab.cua.click(200, 100);

  assert.deepEqual(transport.calls.at(-1), {
    name: "browser.cua.click",
    args: { x: 200, y: 100 },
  });
});

test("dom_cua visibleDom clearly reports unsupported backend", async () => {
  const transport = fakeTransport();
  const browser = await createLink2ChromeClient({ transport }).browsers.get("extension");
  const [tab] = await browser.tabs.list();

  await assert.rejects(
    () => tab.dom_cua.visibleDom(),
    /dom_cua.visibleDom is not implemented/
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
node --test test/runtime-client.test.mjs
```

Expected: FAIL because CUA and DOM CUA surfaces are incomplete.

- [ ] **Step 3: Implement surfaces**

Add:

```js
class CuaSurface {
  constructor({ tab, transport }) {
    this._tab = tab;
    this._transport = transport;
  }

  async screenshot(options = {}) {
    return this._transport.command("browser.cua.screenshot", options);
  }

  async click(x, y, options = {}) {
    return this._transport.command("browser.cua.click", { x, y, ...options });
  }

  async doubleClick(x, y) {
    return this._transport.command("browser.cua.double_click", { x, y });
  }

  async move(x, y) {
    return this._transport.command("browser.cua.move", { x, y });
  }

  async type(text, options = {}) {
    return this._transport.command("browser.cua.type", { text, ...options });
  }

  async key(combo) {
    return this._transport.command("browser.cua.key", { combo });
  }

  async scroll(dx = 0, dy = 500, options = {}) {
    return this._transport.command("browser.cua.scroll", { dx, dy, ...options });
  }

  async drag(x1, y1, x2, y2, options = {}) {
    return this._transport.command("browser.cua.drag", { x1, y1, x2, y2, ...options });
  }
}

class DomCuaSurface {
  async visibleDom() {
    throw new Error("dom_cua.visibleDom is not implemented by the current Link2Chrome backend");
  }
}

class DevSurface {
  constructor({ tab, transport }) {
    this._tab = tab;
    this._transport = transport;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
node --test test/runtime-client.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add runtime/link2chrome-client.mjs test/runtime-client.test.mjs
git commit -m "feat: add runtime cua surfaces"
```

## Task 5: Example Scripts

**Files:**
- Create: `runtime/examples/basic-navigation.mjs`
- Create: `runtime/examples/locator-search.mjs`

- [ ] **Step 1: Add example scripts**

Create `runtime/examples/basic-navigation.mjs`:

```js
import { createLink2ChromeClient, createWebSocketTransport } from "../link2chrome-client.mjs";

const link2chrome = createLink2ChromeClient({
  transport: createWebSocketTransport({ url: process.env.LINK2CHROME_WS_URL || "ws://localhost:8765" }),
});

const browser = await link2chrome.browsers.get("extension");
await browser.nameSession("Link2Chrome runtime basic navigation");
const tab = await browser.tabs.selected();

await tab.goto("https://example.com");
const snapshot = await tab.playwright.domSnapshot();
console.log(snapshot);

const more = tab.playwright.getByText("More information");
console.log("More information matches:", await more.count());
await browser.tabs.finalize({ keep: [{ tab, status: "deliverable" }] });
```

Create `runtime/examples/locator-search.mjs`:

```js
import { createLink2ChromeClient, createWebSocketTransport } from "../link2chrome-client.mjs";

const link2chrome = createLink2ChromeClient({
  transport: createWebSocketTransport({ url: process.env.LINK2CHROME_WS_URL || "ws://localhost:8765" }),
});

const browser = await link2chrome.browsers.get("extension");
const tab = await browser.tabs.selected();

await tab.goto("https://www.google.com/search?q=Link2Chrome");
const input = tab.playwright.locator("textarea[name='q'], input[name='q']");
console.log("Search inputs:", await input.count());
await browser.tabs.finalize({ keep: [{ tab, status: "handoff" }] });
```

- [ ] **Step 2: Verify examples parse**

Run:

```bash
node --check runtime/examples/basic-navigation.mjs
node --check runtime/examples/locator-search.mjs
```

Expected: both commands exit 0.

- [ ] **Step 3: Commit**

```bash
git add runtime/examples/basic-navigation.mjs runtime/examples/locator-search.mjs
git commit -m "docs: add runtime client examples"
```

## Task 6: Default WebSocket Transport

**Files:**
- Modify: `runtime/link2chrome-client.mjs`
- Modify: `test/runtime-client.test.mjs`

- [ ] **Step 1: Write failing tests**

Append:

```js
test("createWebSocketTransport requires a WebSocket implementation in Node without global WebSocket", () => {
  assert.equal(typeof createLink2ChromeClient, "function");
});
```

Also update the import:

```js
import { createLink2ChromeClient, createWebSocketTransport } from "../runtime/link2chrome-client.mjs";
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
node --test test/runtime-client.test.mjs
```

Expected: FAIL because `createWebSocketTransport` is not exported.

- [ ] **Step 3: Implement transport**

Add:

```js
export function createWebSocketTransport({ url = "ws://localhost:8765", WebSocketImpl = globalThis.WebSocket } = {}) {
  return {
    async command(name, args = {}) {
      if (!WebSocketImpl) {
        throw new Error("createWebSocketTransport requires global WebSocket or WebSocketImpl");
      }
      return new Promise((resolve, reject) => {
        const ws = new WebSocketImpl(url);
        const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const timer = setTimeout(() => {
          try { ws.close(); } catch {}
          reject(new Error(`Link2Chrome command timed out: ${name}`));
        }, 30000);

        ws.addEventListener("open", () => {
          ws.send(JSON.stringify({ id: requestId, type: "command", command: name, params: args }));
        });
        ws.addEventListener("message", (event) => {
          const data = JSON.parse(event.data);
          if (data.id && data.id !== requestId) return;
          clearTimeout(timer);
          try { ws.close(); } catch {}
          if (data.error) reject(new Error(data.error));
          else resolve(data.result ?? data.data ?? data);
        });
        ws.addEventListener("error", () => {
          clearTimeout(timer);
          reject(new Error(`Link2Chrome WebSocket error for command: ${name}`));
        });
      });
    },
  };
}
```

- [ ] **Step 4: Run tests and syntax checks**

Run:

```bash
node --test test/runtime-client.test.mjs
node --check runtime/examples/basic-navigation.mjs
node --check runtime/examples/locator-search.mjs
```

Expected: PASS and both checks exit 0.

- [ ] **Step 5: Commit**

```bash
git add runtime/link2chrome-client.mjs test/runtime-client.test.mjs runtime/examples/basic-navigation.mjs runtime/examples/locator-search.mjs
git commit -m "feat: add runtime websocket transport"
```

## Task 7: Documentation Updates

**Files:**
- Modify: `README.md`
- Modify: `.codex/skills/link2chrome-browser-mcp/SKILL.md`
- Modify: `.claude/skills/link2chrome-browser-mcp/SKILL.md`
- Modify: `skills/link2chrome-browser-mcp/SKILL.md`
- Modify: `.codex/skills/link2chrome-browser-mcp/commands/browser-pw.md`
- Modify: `.codex/skills/link2chrome-browser-mcp/commands/browser-dom.md`
- Modify: `.codex/skills/link2chrome-browser-mcp/commands/browser-cua.md`

- [ ] **Step 1: Update README wording and runtime section**

Change the feature overview so it says "三组并行控制面" instead of "三种模式". Add:

```markdown
## Code-first Runtime Client

Link2Chrome also provides a Node ESM runtime client for agents that should write code instead of calling individual MCP tools:

```js
import { createLink2ChromeClient, createWebSocketTransport } from "./runtime/link2chrome-client.mjs";

const link2chrome = createLink2ChromeClient({
  transport: createWebSocketTransport({ url: "ws://localhost:8765" }),
});

const browser = await link2chrome.browsers.get("extension");
const tab = await browser.tabs.selected();
await tab.goto("https://example.com");
const snapshot = await tab.playwright.domSnapshot();
console.log(snapshot);
```

The runtime exposes Playwright-style locators and CUA primitives while reusing the existing extension and server. It does not require the local Playwright package.
```

- [ ] **Step 2: Update skill docs**

Replace "模式选择" with "控制面选择" and include:

```markdown
## Code-first Runtime

When the task benefits from multi-step browser automation, prefer writing JavaScript against `runtime/link2chrome-client.mjs` in Node or node_repl. Use MCP tools directly for one-off operations.

The three surfaces are parallel:

- `tab.playwright.*` / `browser.dom.*`: structured DOM/CDP operations.
- `tab.cua.*` / `browser.cua.*`: screenshot-pixel coordinate operations.
- `browser.pw.*`: CDP endpoint discovery for external browser-use or Playwright clients.
```

- [ ] **Step 3: Update command docs**

For each command file, remove `browser.set_mode`. Use:

```markdown
# /browser-dom

Use the DOM control surface for deterministic automation. In code-first flows, prefer `tab.playwright.domSnapshot()`, `tab.playwright.locator(selector)`, `getByText`, `getByRole`, and `getByTestId`.
```

```markdown
# /browser-cua

Use the CUA control surface for visual pages, canvas, unstable selectors, and coordinate actions. In code-first flows, call `tab.cua.screenshot()` first, inspect the image, then dispatch screenshot-pixel coordinates with `tab.cua.*`.
```

```markdown
# /browser-pw

Use `browser.pw.start`, then `browser.pw.endpoint` when an external browser-use or Playwright client needs a CDP endpoint. This is endpoint-oriented and does not mean Link2Chrome imports the local Playwright package.
```

- [ ] **Step 4: Verify docs do not imply mutually exclusive modes**

Run:

```bash
rg -n "三种模式|set_mode\\{\"mode\"|Use `browser.set_mode|互斥" README.md .codex/skills/link2chrome-browser-mcp skills/link2chrome-browser-mcp .claude/skills/link2chrome-browser-mcp
```

Expected: no matches for misleading mode-switch language.

- [ ] **Step 5: Commit**

```bash
git add README.md .codex/skills/link2chrome-browser-mcp/SKILL.md .claude/skills/link2chrome-browser-mcp/SKILL.md skills/link2chrome-browser-mcp/SKILL.md .codex/skills/link2chrome-browser-mcp/commands/browser-pw.md .codex/skills/link2chrome-browser-mcp/commands/browser-dom.md .codex/skills/link2chrome-browser-mcp/commands/browser-cua.md
git commit -m "docs: document runtime control surfaces"
```

## Task 8: Final Verification

**Files:**
- No code changes expected.

- [ ] **Step 1: Run runtime tests**

```bash
node --test test/runtime-client.test.mjs
```

Expected: all runtime tests pass.

- [ ] **Step 2: Run existing Python tests related to Plan C**

```bash
python3 -m pytest test/test_plan_c_modes.py
```

Expected: tests pass. If Python 3.9 cannot run MCP-dependent tests because installed dependencies require Python 3.10, use the existing project virtualenv with a compatible Python and record the exact command.

- [ ] **Step 3: Confirm no Playwright dependency was introduced**

```bash
rg -n "playwright" server/requirements.txt package.json runtime test README.md
```

Expected: references may appear in docs/runtime naming, but no dependency declaration for the local Playwright package.

- [ ] **Step 4: Inspect final status**

```bash
git status --short --branch
```

Expected: only unrelated pre-existing worktree changes remain.
