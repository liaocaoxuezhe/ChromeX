# ChromeX Install

ChromeX is packaged as a Codex repo plugin at `plugins/chromex`.

1. Restart Codex so it discovers `.agents/plugins/marketplace.json`.
2. Install or enable the `chromex` plugin from the `ChromeX Local Plugins` marketplace.
3. From the project root, run `node plugins/chromex/scripts/install.mjs`.
4. Load `/Users/zhangyu/PycharmProjects/Link2Chrome/extension` in `chrome://extensions` with Developer Mode enabled.
5. Run `node plugins/chromex/scripts/diagnose.mjs`.

Python note: ChromeX requires Python 3.10+ for the MCP SDK path. If your default Python is 3.9, the installer searches for `python3.10`, `python3.11`, or `python3.12` and creates `server/venv` with a compatible interpreter.
