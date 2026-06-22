# ChromeX Install

ChromeX is packaged as a Codex repo plugin at `plugins/chromex`.

1. Register the marketplace root: `codex plugin marketplace add /Users/zhangyu/PycharmProjects/Link2Chrome`.
2. Install the plugin: `codex plugin add chromex@chromex-local`.
3. From the project root, run `node plugins/chromex/scripts/install.mjs`.
4. Load `/Users/zhangyu/PycharmProjects/Link2Chrome/extension` in `chrome://extensions` with Developer Mode enabled.
5. Run `node plugins/chromex/scripts/diagnose.mjs`.
6. Restart Codex so the enabled plugin and MCP server are available in new threads.

Python note: ChromeX requires Python 3.10+ for the MCP SDK path. If your default Python is 3.9, the installer searches for `python3.10`, `python3.11`, or `python3.12` and creates `server/venv` with a compatible interpreter.
