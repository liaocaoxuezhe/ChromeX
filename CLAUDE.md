# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Link2Chrome is a local-first browser automation system that creates a bridge between Claude Code and Chrome browsers through a Chrome extension and WebSocket-based MCP server. The system enables Claude Code to control browsers programmatically without launching new browser instances.

## Architecture

The system consists of two main components:

### 1. MCP Server (`/server/`)
- Python-based MCP server using stdio communication with Claude Code
- WebSocket server listening on `localhost:8765`
- Integrates with Vision AI (Doubao/Seed model) for screenshot analysis
- Exposes 12 browser automation tools to Claude Code

### 2. Chrome Extension (`/extension/`)
- Manifest V3 extension with background service worker
- Uses Chrome DevTools Protocol (CDP) via `chrome.debugger` API
- WebSocket client connects to the MCP server
- Includes content script, popup UI, and Readability.js for content extraction

### Data Flow
```
Claude Code (MCP Protocol) <-> MCP Server <-> WebSocket <-> Chrome Extension <-> CDP <-> Browser Tab
```

## Development Commands

### Initial Setup
```bash
# Run setup script to install Python 3.12, create venv, and install dependencies
./setup.sh
```

### Configure Environment
Create or edit `.env` file in project root:
```
DOUBAO_API_KEY=your-api-key-here
DOUBAO_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
DOUBAO_MODEL=doubao-seed-1.8-thinking-250528

# 日志配置 (可选)
LOG_LEVEL=INFO  # DEBUG, INFO, WARNING, ERROR
```

### Configure Claude Code
Add the following to your Claude Code configuration (merge into `~/.claude.json`):
```json
{
  "mcpServers": {
    "local-browser": {
      "command": "/Users/zhangyu/PycharmProjects/Link2Chrome/server/venv/bin/python",
      "args": ["-m", "server.main"],
      "cwd": "/Users/zhangyu/PycharmProjects/Link2Chrome"
    }
  }
}
```

### Load Chrome Extension
1. Navigate to `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select the `/extension/` directory

### Running the Server (for testing)
```bash
cd server
python -m server.main
```

## Key Technologies

**Server (Python):**
- `mcp>=1.0.0` - Model Context Protocol implementation
- `websockets>=12.0` - WebSocket server
- `openai>=1.0.0` - OpenAI-compatible API for vision model
- `Pillow>=10.0.0` - Image processing
- `markdownify>=0.11.0` - HTML to Markdown conversion

**Extension (JavaScript):**
- Manifest V3 Chrome extension
- Chrome DevTools Protocol (CDP) for browser control
- Readability.js for content extraction

## MCP Tools Reference

The following tools are exposed to Claude Code:

| Tool | Description |
|------|-------------|
| `browser_get_state` | Get current browser state (URL, title, screenshot, DOM) |
| `browser_action_vision` | AI-powered visual interaction (core feature) |
| `browser_action_navigate` | Navigate to URLs |
| `browser_action_scroll` | Scroll page up/down |
| `browser_manage_tab` | Create, close, switch tabs |
| `browser_click` | Direct coordinate/selector clicking |
| `browser_type` | Text input with optional clearing |
| `browser_get_tabs` | List all tabs across windows |
| `browser_go_back` | Navigate back/forward |
| `browser_drag` | Drag and drop operations |
| `browser_wait` | Wait for time, selector, or text |
| `browser_extract_content` | Extract page content using Readability |
| `browser_diagnose` | Connection diagnostics |

## Critical Technical Details

### Coordinate System
The system handles CSS pixel vs screen pixel conversion using `devicePixelRatio`. The vision model receives screenshot dimensions and returns coordinates that are calibrated before being sent to CDP.

### Debugger Infobar
Using `chrome.debugger` causes Chrome to display a "Browser is being controlled by..." notification bar that affects viewport height. The extension accounts for this offset in coordinate calculations.

### Connection Management
- Single WebSocket connection per browser instance
- Heartbeat/ping-pong mechanism (30s interval)
- Automatic reconnection with exponential backoff
- Maximum 10 reconnection attempts

### DOM Compression
The `dom_compressor.py` module implements a lightweight algorithm that extracts only interactive elements (a, button, input, text) and removes style, script, and SVG elements to reduce token usage.

### Content Security
The extension filters un-debuggable URLs (chrome://, chrome-extension://, etc.) to prevent errors when attempting to attach the debugger to system pages.

## Logging System

The server includes a comprehensive logging system that records all operations and errors.

### Log Files

Logs are stored in the `logs/` directory:

| File | Description |
|------|-------------|
| `logs/link2chrome_YYYY-MM-DD.log` | Main application log (all levels) |
| `logs/link2chrome_error_YYYY-MM-DD.log` | Error-only log |
| `logs/operations/operations_YYYY-MM-DD.log` | Detailed operation records |

### Log Features

- **Console output**: Logs are also output to stderr for real-time monitoring
- **Automatic rotation**: Log files rotate when they reach 10MB
- **Date-based organization**: New log files created daily
- **UTF-8 encoding**: Full Chinese character support

### Viewing Logs

```bash
cd server

# List all log files
python view_logs.py

# View today's main log (last 50 lines)
python view_logs.py -t main

# View error log (last 100 lines)
python view_logs.py -t error -n 100

# Real-time log tailing
python view_logs.py -t operations -f

# Clear all logs
python view_logs.py --clear
```

### Log Format

**Main log:**
```
2025-01-15 10:30:45 [link2chrome] INFO: 等待 Chrome Extension 连接...
2025-01-15 10:30:52 [link2chrome.ws] INFO: Chrome Extension 已连接: ('127.0.0.1', 54321)
```

**Operation log:**
```
[2025-01-15 10:31:02.123] OPERATION: browser_action_navigate
  Arguments: {'url': 'https://example.com'}
  Result: 已导航到: https://example.com (状态: success)
------------------------------------------------------------
```

## File Structure

```
Link2Chrome/
├── server/                 # Python MCP Server
│   ├── main.py            # MCP server implementation with tool definitions
│   ├── ws_manager.py      # WebSocket server and connection management
│   ├── vision.py          # Vision model client (Doubao/Seed)
│   ├── dom_compressor.py  # DOM tree compression for LLM consumption
│   ├── logger.py          # Logging system configuration
│   ├── view_logs.py       # Log viewing utility
│   ├── requirements.txt   # Python dependencies
│   └── venv/              # Virtual environment
├── extension/             # Chrome Extension
│   ├── manifest.json      # Manifest V3 configuration
│   ├── background.js      # Service worker (WebSocket client, CDP operations)
│   ├── content.js         # Content script for page interaction
│   ├── popup.html/js      # Extension popup UI
│   └── lib/               # Third-party libraries (Readability.js)
├── logs/                  # Log files (auto-created)
│   ├── link2chrome_YYYY-MM-DD.log
│   ├── link2chrome_error_YYYY-MM-DD.log
│   └── operations/
│       └── operations_YYYY-MM-DD.log
├── setup.sh               # Installation script
├── claude_config_snippet.json  # Claude Code MCP configuration template
└── .env                   # Environment variables (API keys)
```
