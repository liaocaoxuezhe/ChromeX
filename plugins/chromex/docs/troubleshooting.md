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

If Codex installed the plugin into a cache directory and the scripts cannot find the repository, set:

```bash
export CHROMEX_PROJECT_ROOT=/Users/zhangyu/PycharmProjects/Link2Chrome
```
