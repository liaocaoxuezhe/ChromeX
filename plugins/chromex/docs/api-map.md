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
