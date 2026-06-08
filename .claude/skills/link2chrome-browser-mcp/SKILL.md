---
name: link2chrome-browser-mcp
description: |
  Control the user's real Chrome browser — navigate, click, fill forms, read DOM,
  screenshot, and run Playwright-style automation scripts using the user's actual
  login sessions. Use this skill whenever the user wants to interact with websites,
  automate browser tasks, read web content, or perform any action requiring a real
  browser with existing login state.
---

# Link2Chrome Browser MCP

Control the user's real Chrome browser (with their login sessions, cookies, extensions)
through a local MCP server. The user's browser stays open and visible — you operate
it like a person sitting at the keyboard.

## Health Check (always do this first)

Before any browser operation, verify the connection:

```
browser_diagnose()
```

Act on the result:
- **Hub connected + Extension connected** → healthy, proceed
- **Hub connected, Extension NOT connected** → Chrome extension not running. Tell the user to check that the Link2Chrome extension is enabled in Chrome.
- **Hub NOT connected** → MCP server issue. The hub should auto-start; if it doesn't, tell the user to restart the MCP server.

Don't retry failed operations in a loop. If `browser_diagnose` shows a connection problem, report it to the user immediately.

## Tool Selection

```
Need to use the browser?
│
├─ OBSERVE the page
│  ├─ What's on this page? → browser_dom_overview
│  ├─ Read article/main content → browser_dom_get_text
│  ├─ Find specific elements → browser_dom_query (by CSS) or browser_dom_search (by text)
│  ├─ What changed after my last action? → browser_dom_diff
│  ├─ Visual check / layout → browser_screenshot
│  └─ Structured metadata → browser_dom_query (JSON-LD, Open Graph)
│
├─ NAVIGATE
│  ├─ Go to a URL → browser_navigate(action='goto', url='...')
│  ├─ Go back → browser_navigate(action='back')
│  ├─ Open URL in new tab → browser_tab(action='new', url='...')
│  ├─ Switch tabs → browser_tab(action='switch', tabId=N)
│  ├─ Close a tab → browser_tab(action='close', tabId=N)
│  └─ See all open tabs → browser_tabs_list
│
├─ INTERACT (single action)
│  ├─ Click → action_click(target={selector/text/x,y})
│  ├─ Fill input → action_fill(target={selector}, value='...')
│  ├─ Press key → action_press_key(key='Enter')
│  ├─ Scroll → action_scroll(direction='down')
│  ├─ Hover → action_hover(target={selector})
│  ├─ Drag → action_drag(...)
│  ├─ Upload file → upload_file(selector, paths)
│  └─ Handle popup → handle_dialog(action='accept')
│
├─ COMPLEX WORKFLOW (3+ steps, conditionals, loops)
│  └─ playwright_run(code='...')
│
├─ EXTRACT & EXPORT
│  ├─ Batch scrape with auto-scroll → browser_scrape_with_scroll
│  ├─ Run custom JS → script_evaluate(expression='...')
│  └─ Save page as PDF → save_as_pdf()
│
└─ DEBUG
   ├─ Connection issues → browser_diagnose
   ├─ JS errors → console_check(action='start'), then console_check(action='list')
   └─ API requests → network_check(action='start'), then network_check(action='query')
```

## Sessions and Tab Groups

**One task = one session = one Chrome tab group.**

When starting a browser task, pass `session` and `group_title` on your first navigate or tab call:

```
browser_navigate(action='goto', url='https://google.com/search?q=tents',
                 session='camping-research', group_title='露营装备调研')
```

Rules:
1. **Name the session by TASK, not by site.** Searching on Google, then opening Amazon and REI results = all the same session `camping-research`.
2. **Use the user's language for `group_title`.** Chinese conversation → Chinese label.
3. **One task = one session.** Don't create a new session when you navigate to a different site within the same task.
4. **Pass `session` on every subsequent call** in the same task. Later calls don't need `group_title` again.
5. **Multiple sessions only for genuinely unrelated parallel tasks** the user requested simultaneously.

When the task is done:
- If the user might still want the tabs → **leave them open** (don't call close)
- If the tabs are just intermediate work → `browser_session(action='close', session='camping-research')`

## Standard Workflow

Follow this pattern for most browser tasks:

```
1. browser_diagnose()                          # verify connection
2. browser_navigate(action='goto', url='..',   # open page with session
     session='task-name', group_title='任务名')
3. browser_dom_overview()                       # understand the page
4. action_click / action_fill / ...             # one action at a time
5. browser_dom_diff()                           # verify what changed
6. repeat 4-5 as needed
7. browser_session(action='close') or leave tabs open
```

**Key principle: observe → act → verify. One action at a time.**

Don't chain multiple blind clicks without checking what happened. After each significant action, verify with `browser_dom_diff`, `browser_dom_overview`, or `browser_screenshot`.

## action_fill — Text Input

`action_fill` clears existing content and inserts new text (same semantics as Playwright's `fill`):

```
action_fill(target={selector: '#email'}, value='user@example.com')
action_fill(target={placeholder: 'Search'}, value='camping tents', submitAfter='enter')
```

For `[contenteditable]` rich text editors (ProseMirror, Lexical, Slate), `action_fill` handles focus + select all + insert automatically.

To **append** to existing text instead of replacing, read the current value with `script_evaluate` first, then `action_fill` with the concatenated result.

## action_press_key — Keyboard Shortcuts

Separate from `action_fill` because the intent is different: pressing keys vs. filling text.

```
action_press_key(key='Enter')                    # submit form
action_press_key(key='Escape')                   # close modal
action_press_key(key='Control+A')                # select all
action_press_key(key='Control+C')                # copy
action_press_key(key='Control+V')                # paste
action_press_key(key='Control+Z')                # undo
action_press_key(key='Tab')                      # next field
action_press_key(key='ArrowDown', target={selector: '.dropdown'})  # navigate dropdown
```

## playwright_run — Complex Workflows

For multi-step operations (3+ actions), conditional logic, or loops, write Playwright-style code in a single `playwright_run` call instead of chaining individual tools.

The `page` object is pre-bound to the current active tab.

### When to use playwright_run

| Scenario | Use playwright_run? |
|----------|---------------------|
| Click one button | No → `action_click` |
| Fill one input and press Enter | No → `action_fill` + `action_press_key` |
| Fill 5 form fields and submit | **Yes** |
| Check if element exists, then click or skip | **Yes** (conditional) |
| Extract data from 20 list items | **Yes** (loop) |
| Login flow: fill email → next → fill password → submit | **Yes** (multi-step) |

### Basic Pattern

```javascript
// playwright_run code
await page.locator('#username').fill('user@example.com');
await page.locator('#password').fill('password123');
await page.locator('button[type=submit]').click();
await page.waitForSelector('.dashboard');
return { success: true, title: await page.title() };
```

### Locator Methods

```javascript
// CSS selector
page.locator('button.submit')

// By visible text
page.getByText('Sign In', { exact: true })

// By ARIA role
page.getByRole('textbox', { name: 'Email' })
page.getByRole('button', { name: 'Submit' })

// By label / placeholder
page.getByLabel('Email')
page.getByPlaceholder('Enter your email')

// Chain and filter
page.locator('table tr').nth(2).locator('td').first()
```

### Data Extraction

```javascript
const items = [];
const cards = page.locator('.product-card');
const count = await cards.count();
for (let i = 0; i < Math.min(count, 20); i++) {
  const card = cards.nth(i);
  items.push({
    name: await card.locator('.name').textContent(),
    price: await card.locator('.price').textContent(),
    link: await card.locator('a').getAttribute('href')
  });
}
return items;
```

### Conditional Logic

```javascript
const loginBtn = page.locator('button:has-text("Login")');
if (await loginBtn.isVisible()) {
  await loginBtn.click();
  await page.waitForSelector('.dashboard');
  return { action: 'logged_in' };
} else {
  return { action: 'already_logged_in', title: await page.title() };
}
```

### Login Form Example

```javascript
await page.goto('https://example.com/login');
await page.locator('#username').fill('user@example.com');
await page.locator('#password').fill('secret');
await page.locator('button[type=submit]').click();
await page.waitForTimeout(1000);
const error = page.locator('.error-message');
if (await error.isVisible()) {
  return { success: false, error: await error.textContent() };
}
return { success: true, title: await page.title() };
```

### Available page API

| API | Description |
|-----|-------------|
| `page.goto(url)` | Navigate |
| `page.title()` / `page.url()` | Page info |
| `page.locator(css)` | CSS selector |
| `page.getByText(text, {exact?})` | Find by text |
| `page.getByRole(role, {name?})` | Find by ARIA role |
| `page.getByLabel(text)` / `page.getByPlaceholder(text)` | Find by label/placeholder |
| `.click()` / `.fill(value)` / `.type(value)` / `.press(key)` | Interact |
| `.textContent()` / `.innerText()` / `.getAttribute(name)` | Read |
| `.isVisible()` / `.count()` / `.first()` / `.nth(n)` | Query |
| `page.waitForSelector(selector)` | Wait for element |
| `page.waitForTimeout(ms)` | Fixed wait |
| `page.evaluate(fn)` | Run JS in page context |
| `page.screenshot()` | Capture screenshot |

## script_evaluate — Page-context JavaScript

For one-off JS execution in the page context. Different from `playwright_run`:

| | `script_evaluate` | `playwright_run` |
|---|---|---|
| Runs in | Page JS context (access to `document`, `window`) | Sandboxed runtime with `page` API |
| Best for | Read framework state, call page APIs, quick DOM queries | Multi-step automation with locators |
| Example | `document.querySelectorAll('.item').length` | `await page.locator('.item').count()` |

```
script_evaluate(expression="document.title")
script_evaluate(expression="Array.from(document.querySelectorAll('a')).map(a => ({text: a.textContent, href: a.href}))")
```

Tips:
- Wrap in IIFE for fresh scope: `(() => { const x = ...; return x; })()`
- Use `JSON.stringify(data)` without formatting (no `null, 2`) to avoid inflated output
- Set `awaitPromise=true` for async operations

## save_as_pdf

Render the current page to PDF using Chrome's built-in print-to-PDF:

```
save_as_pdf()                                    # default A4, saves to temp dir
save_as_pdf(format='a4', landscape=true)         # landscape A4
save_as_pdf(path='/tmp/report.pdf')              # custom path
```

## Operating Discipline

1. **Observe before acting.** Always call `browser_dom_overview` or `browser_screenshot` before your first interaction on a new page.
2. **One action, then verify.** After clicking, filling, or scrolling, check the result with `browser_dom_diff` or `browser_screenshot`. Don't chain blind actions.
3. **Control output size.** Always set `max_chars` on `browser_dom_get_text` and `browser_dom_overview` to avoid flooding your context. Default to 20000.
4. **Don't reload unnecessarily.** If a tab is already on the target URL, don't call `browser_navigate(action='goto')` with the same URL — it will reload and may lose in-progress state.
5. **Prefer DOM over screenshots.** DOM tools are cheaper in tokens and more precise. Use screenshots only when you need visual layout, Canvas content, or to verify visual appearance.
6. **playwright_run for 3+ steps.** If you're about to call 3+ individual action tools in sequence, write a `playwright_run` instead.
7. **Diagnose before retrying.** If a tool call fails, call `browser_diagnose` first. Don't blindly retry.
8. **Respect user sessions.** You're controlling the user's real browser with real login sessions. Don't navigate away from pages the user has open unless they asked you to. Use `browser_tab(action='new')` to open new tabs.

## Individual Tool Reference

### Navigation and Session

- **browser_navigate** — Navigate the current tab: goto URL, back, forward, or reload. Always prefer this over screenshot-driven navigation. Returns finalUrl, redirected flag, and elapsed time.
- **browser_tab** — Manage tabs: create new, switch to existing, or close. Use `action='new'` to open URLs without losing the current page.
- **browser_session** — Manage task sessions and their Chrome tab groups. Use `action='list'` to see active sessions, `action='close'` to clean up finished tasks.
- **browser_tabs_list** — List all open tabs with id, title, url, active state, and groupTitle. Use this before switching tabs to get the correct tabId.

### DOM Observation

- **browser_dom_overview** — Get a compact markdown overview of the page structure. Shows headings, buttons, inputs, forms, links, and images in a hierarchical list. This is your first step on any new page.
- **browser_dom_query** — Extract precise element data by CSS selector. Returns structured attributes (text, href, src, etc.) without raw HTML. Use for precise data extraction.
- **browser_dom_search** — Find elements by visible text content. Good when you know what text should be on the page but don't know the selector.
- **browser_dom_get_text** — Extract article text with Mozilla Readability, or read a specific element's text. Use the Readability mode (no selector) for article pages.
- **browser_dom_diff** — Compare current page with the last snapshot. Shows what changed after your last action. Essential for the observe-act-verify loop.
- **browser_screenshot** — Capture the page as a base64 image. Use sparingly; prefer DOM tools for most tasks since they are cheaper in tokens.

### Interaction

- **action_click** — Click by CSS selector, visible text, aria-label, or coordinates. Supports left/right/middle buttons and optional navigation waits.
- **action_double_click** — Double-click an element. Use for features that require double-click activation.
- **action_hover** — Move the mouse over an element. Useful for triggering hover menus or tooltips.
- **action_scroll** — Scroll by direction/amount, jump to top/bottom, scroll to a selector, or scroll until the page end loads all content.
- **action_drag** — Drag from one element or coordinate to another. Supports slider CAPTCHA, drag-and-drop, and sortable lists.
- **action_fill** — Clear and fill text into an input, textarea, or contenteditable. Matches Playwright fill semantics. Supports submitAfter for pressing Enter or Tab after fill.
- **action_press_key** — Press a key or keyboard shortcut. Supports modifiers (Control, Alt, Shift, Meta) combined with '+'.
- **upload_file** — Set local files on a file input element. Requires absolute file paths.
- **handle_dialog** — Accept or dismiss JavaScript dialogs (alert, confirm, prompt). Can supply prompt text when accepting.

### Code Execution and Export

- **playwright_run** — Execute Playwright-style JavaScript with a pre-bound `page` object. Best for complex multi-step workflows, conditionals, and loops.
- **script_evaluate** — Run arbitrary JavaScript in the page context. Returns JSON-serializable results. Use for quick data extraction or framework state inspection.
- **save_as_pdf** — Render the page to PDF using Chrome's print-to-PDF. Supports A4, letter, landscape, and custom scale.

### Diagnostics and Batch Operations

- **browser_scrape_with_scroll** — Automatically scroll and extract data in batches. The entire operation runs in the browser, minimizing MCP round-trips. Supports deduplication.
- **console_check** — Capture and inspect browser console output. Actions: start, stop, list, get, clear, status. Filter by type (log, error, warn, info).
- **network_check** — Capture and inspect network requests. Actions: start, stop, list, query, fetch, replay, clear, status. Supports filtering by URL, method, status, and resource type.
- **browser_diagnose** — Check Link2Chrome connection health. Always run this first if any tool fails unexpectedly.

## Known Limitations

- **`isTrusted` checks**: Some banking/payment sites reject synthetic events. `action_click` and `action_fill` use CDP-level events which are generally trusted, but certain sites may still block them. Report this to the user rather than retrying.
- **Cross-origin iframes**: Tools operate on the top frame. For cross-origin iframe content, navigate directly to the iframe URL or use `script_evaluate` with frame targeting.
- **chrome:// pages**: Cannot interact with `chrome://`, `chrome-extension://`, or `devtools://` pages. These are protected by Chrome.
- **File downloads**: Download triggers initiated by clicks may not be captured automatically. Use `network_check` to inspect download URLs if needed.
- **Multiple windows**: The MCP server tracks a single active tab. Pop-ups or new windows may require manual switching via `browser_tabs_list` and `browser_tab`.
- **Mobile emulation**: Not supported. The browser operates at the user's current viewport size.

## Troubleshooting Guide

### `browser_diagnose` shows Extension not connected
1. Check that the Link2Chrome Chrome extension is installed and enabled.
2. Open Chrome's extensions page (`chrome://extensions`) and verify it is turned on.
3. If the extension was just installed, reload the extension or restart Chrome.
4. Run `browser_diagnose` again after a few seconds.

### Click or fill doesn't seem to work
1. Check that the element is actually visible: `browser_dom_query(selector='...')`
2. Some sites use shadow DOM. Try `script_evaluate` with `querySelector` on the shadow root.
3. If the element is inside an iframe, you may need to navigate directly to the iframe URL.

### Page content doesn't load after navigation
1. Some SPAs (React, Vue, Angular) load content asynchronously. Use `browser_dom_diff` or `script_evaluate` to wait for DOM changes.
2. Increase the navigation timeout: `browser_navigate(action='goto', url='...', timeout=20000)`.
3. Check the browser console for JavaScript errors: `console_check(action='list', types=['error'])`.
