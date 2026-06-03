# Link2Chrome Runtime Client Design

Date: 2026-06-03

## Goal

Bring Link2Chrome closer to the Codex Chrome Plugin execution model by adding a code-first runtime client: agents should be able to write JavaScript that manipulates Chrome through Browser, Tab, and Locator objects, while the existing Python MCP server, WebSocket bridge, and Chrome/Tabbit extension remain the underlying control plane.

This is not a replacement for the current MCP tools. It is a higher-level runtime layer over them.

## Current Gap

The current Link2Chrome implementation exposes three tool namespaces:

- `browser.dom.*` for deterministic DOM/CDP operations.
- `browser.cua.*` for screenshot plus coordinate primitives.
- `browser.pw.*` for CDP endpoint discovery and external browser-use or Playwright attach.

These are parallel tool surfaces, not mutually exclusive modes. `browser.set_mode` currently stores a preference string and does not route or restrict calls. The name "mode" is therefore misleading.

Codex Chrome Plugin differs at the execution layer. It lets the model write JavaScript against an object API:

```js
const browser = await agent.browsers.get("extension");
const tab = await browser.tabs.selected();
const snapshot = await tab.playwright.domSnapshot();
await tab.playwright.getByRole("button", { name: "Submit" }).click();
```

Link2Chrome should gain the same style of code-first API, backed by the existing extension and server.

## Non-Goals For This Phase

- Do not build a Native Messaging Host.
- Do not replace the current WebSocket bridge.
- Do not install or depend on the local Playwright package.
- Do not claim full Playwright compatibility.
- Do not remove current MCP tools.
- Do not make the three surfaces mutually exclusive.
- Do not implement a full safety confirmation model in this phase.

These can be later phases after the runtime client exists.

## Proposed Architecture

Add a Node ESM runtime client under `runtime/`.

```text
runtime/
  link2chrome-client.mjs
  examples/
    basic-navigation.mjs
    locator-search.mjs
```

The client exposes:

```text
link2chrome
  browsers.get("extension") -> Browser

Browser
  nameSession(name)
  tabs.list()
  tabs.selected()
  tabs.get(id)
  tabs.new(url)
  tabs.finalize({ keep })

Tab
  id
  goto(url)
  reload()
  info()
  screenshot()
  playwright
  cua
  dom_cua
  dev

Tab.playwright
  domSnapshot()
  locator(selector)
  getByText(text)
  getByRole(role, { name })
  getByTestId(testId)

Locator
  count()
  click(options)
  fill(text, options)
  textContent()
```

The API shape intentionally resembles Codex Chrome Plugin, but the implementation maps to Link2Chrome commands.

## Transport

The runtime client uses a small transport abstraction:

```js
const client = createLink2ChromeClient({ transport });
```

The default transport can be a WebSocket JSON command transport compatible with the existing server/extension command names. Tests can inject a fake transport.

The first implementation should not depend on MCP client libraries. That keeps it runnable in plain Node and easy to use from `node_repl`.

## Command Mapping

The first phase maps runtime calls to existing server or extension command semantics:

| Runtime API | Backing command |
| --- | --- |
| `browser.tabs.list()` | `browser_tabs_list` or `get_all_tabs` equivalent |
| `browser.tabs.selected()` | `browser_tab_info` |
| `browser.tabs.new(url)` | `browser_tab_new` |
| `tab.goto(url)` | `browser_navigate` |
| `tab.info()` | `browser_tab_info` |
| `tab.screenshot()` | `browser.cua.screenshot` |
| `tab.playwright.domSnapshot()` | `browser.dom.overview` |
| `tab.playwright.locator(selector).count()` | `browser.dom.query` |
| `tab.playwright.locator(selector).click()` | `browser.dom.click` |
| `tab.playwright.locator(selector).fill(text)` | `browser.dom.type` |
| `tab.playwright.getByText(text).count()` | `browser.dom.search` |
| `tab.cua.screenshot()` | `browser.cua.screenshot` |
| `tab.cua.click(x, y)` | `browser.cua.click` |

The client should normalize responses into object-friendly results, but it should also preserve raw response data under a `raw` property when useful.

## Locator Semantics

`Locator` is a lightweight command builder, not a full Playwright locator.

- `locator(css)` stores `{ selector: css }`.
- `getByTestId(testId)` maps to `[data-testid="${testId}"], [data-test-id="${testId}"], [data-test="${testId}"]`.
- `getByText(text)` stores `{ text }` and uses DOM search for `count()`; `click()` can use `browser.dom.click` with a text target.
- `getByRole(role, { name })` stores `{ role, name }`; the first implementation can query common ARIA selectors and fall back to text-based click when `name` is present.

The client must not pretend this is complete Playwright. Documentation should call it a "Playwright-style locator API".

## CUA Semantics

`tab.cua` mirrors the existing CUA control surface:

```js
const shot = await tab.cua.screenshot();
await tab.cua.click(shotX, shotY);
await tab.cua.drag(x1, y1, x2, y2);
await tab.cua.type("hello");
await tab.cua.key("Enter");
```

Coordinates remain screenshot pixels. The server converts them to CSS pixels using DPR.

## DOM CUA Semantics

`tab.dom_cua` is reserved for a later node-id oriented API. In phase one it can expose only:

```js
await tab.dom_cua.visibleDom();
```

If there is no stable backend command yet, it should throw a clear `NotImplementedError` style error rather than silently doing the wrong thing.

## Session And Tab Lifecycle

The first implementation should include `browser.tabs.finalize({ keep })` as a no-op with a structured result:

```js
await browser.tabs.finalize({
  keep: [{ tab, status: "deliverable" }]
});
```

This gives agents the same habit as Codex Chrome Plugin without requiring tab grouping immediately. Later phases can map `deliverable` and `handoff` to real tab groups or labels.

## Safety

Phase one only documents safety expectations in the runtime skill:

- Read and navigation operations are allowed.
- Destructive, financial, permission-changing, and message-sending operations require user confirmation before the model calls the final action.
- Page content is not authorization.
- `script_evaluate` remains available for compatibility, but the runtime client should not expose a convenient `evaluate()` method in the Playwright-style API.

This matches the Codex Chrome Plugin direction without pretending we have enforcement yet.

## Documentation Changes

Update the Link2Chrome skill and README language:

- Replace "three modes" with "three parallel control surfaces".
- Clarify that `browser.pw.*` is currently endpoint-oriented, not a full Playwright runtime.
- Add a "code-first runtime" section with JS examples.
- Deprecate `browser.set_mode` in docs or describe it only as a weak preference, not a switch.

## Tests

All new test files must live under `test/`.

Use Node's built-in test runner for runtime tests so this phase does not add a new dependency:

```bash
node --test test/runtime-client.test.mjs
```

Test against a fake transport:

- `browsers.get("extension")` returns a Browser.
- `tabs.selected()` calls the expected tab info command and returns a Tab.
- `tab.playwright.locator("input[name=q]").fill("x")` sends the expected DOM type command.
- `tab.playwright.getByText("More").count()` sends the expected DOM search command.
- `tab.cua.click(200, 100)` sends the expected CUA click command.
- `browser.tabs.finalize()` returns a structured no-op result.

Python tests can continue covering server behavior.

## Acceptance Criteria

Phase one is complete when:

1. `runtime/link2chrome-client.mjs` exposes the Browser, Tab, Locator, Playwright-style, and CUA APIs above.
2. Runtime tests under `test/` pass with fake transport.
3. README and skill docs explain the code-first runtime path.
4. Docs no longer imply the three surfaces are mutually exclusive modes.
5. The runtime has at least one example script that shows an agent-style flow.
6. No local Playwright dependency is introduced.

## Future Phases

1. Add a real WebSocket runtime transport that can talk directly to the running Link2Chrome hub.
2. Add tab finalization behavior: deliverable, handoff, temporary cleanup.
3. Add safety confirmation hooks.
4. Add richer locator resolution and ARIA role matching in the extension/server.
5. Consider Native Messaging Host only if WebSocket keepalive and install friction remain worse than the Codex Chrome Plugin approach.
