#!/usr/bin/env node
/**
 * Link2Chrome Node.js Playwright Runtime
 *
 * 长期运行的 Node.js 子进程入口。接收来自 Python MCP Server 的代码执行请求，
 * 在持久化的 REPL 上下文中执行，并通过 link2chrome-client.mjs 操控浏览器。
 *
 * IPC 协议（stdin/stdout，每行一个 JSON）：
 *   输入：{ id, type: "execute", code, timeout }
 *   输入：{ type: "shutdown" }
 *   输出：{ type: "ready", version, hubConnected }
 *   输出：{ id, ok: true, result, meta: { elapsedMs } }
 *   输出：{ id, ok: false, error, stack, meta: { elapsedMs } }
 *   输出：{ type: "log", level, message }
 */

import { createInterface } from "readline";
import { createLink2ChromeClient, createDocumentationSurface, createWebSocketTransport } from "./link2chrome-client.mjs";

const VERSION = "1.0.0";
const WS_URL = process.env.LINK2CHROME_WS_URL || "ws://localhost:8766";

// ─── WebSocket 实现探测 ───────────────────────────────────
// Node.js < 21 没有内置 WebSocket，尝试动态加载 ws 包；否则标记 hubConnected=false
let WebSocketImpl = globalThis.WebSocket;

async function resolveWebSocketImpl() {
  if (WebSocketImpl) return;
  try {
    const wsModule = await import("ws");
    WebSocketImpl = wsModule.default || wsModule.WebSocket || wsModule;
  } catch {
    // ws 包未安装，后续 hubConnected=false
  }
}

// ─── IPC 输出（仅使用 stdout，保证每行一个合法 JSON）────────
// 必须使用 process.stdout.write，避免与注入到 globalThis 的 ipcConsole 产生递归
function sendIpc(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function sendLog(level, message) {
  sendIpc({ type: "log", level, message: String(message) });
}

// ─── IPC Console（注入到 globalThis，代理用户代码的 console）─
const ipcConsole = {
  log: (...args) => sendLog("log", args.map(String).join(" ")),
  error: (...args) => sendLog("error", args.map(String).join(" ")),
  warn: (...args) => sendLog("warn", args.map(String).join(" ")),
  info: (...args) => sendLog("info", args.map(String).join(" ")),
  debug: (...args) => sendLog("debug", args.map(String).join(" ")),
};

// ─── Client 初始化 ────────────────────────────────────────
let link2chrome = null;
let browser = null;
let agent = null;
let transport = null;
let hubConnected = false;

async function setupClient() {
  await resolveWebSocketImpl();

  try {
    transport = createWebSocketTransport({ url: WS_URL, WebSocketImpl });
    link2chrome = createLink2ChromeClient({ transport });
    // browsers.get("extension") 是同步的（仅构造对象，不触发网络请求）
    browser = await link2chrome.browsers.get("extension");
    hubConnected = !!WebSocketImpl;
  } catch (error) {
    hubConnected = false;
    sendLog("error", `Client 初始化失败: ${error.message}`);
  }
}

// ─── REPL 上下文持久化 ────────────────────────────────────
// 将 browser/link2chrome/console 注入 globalThis，实现跨执行变量共享
function setupReplContext() {
  globalThis.link2chrome = link2chrome;
  globalThis.browser = browser;
  globalThis.console = ipcConsole;
  agent = {
    browsers: link2chrome.browsers,
    documentation: createDocumentationSurface(),
  };
  globalThis.agent = agent;
}

// ─── 结果序列化器 ─────────────────────────────────────────
// 处理 undefined / function / Symbol / BigInt / Uint8Array / 自定义对象等
function serializeResult(value, depth = 0) {
  if (depth > 5) {
    return { __type: "object", description: "[Deep Object]" };
  }

  if (value === undefined) {
    return { __type: "undefined" };
  }
  if (value === null) {
    return null;
  }

  const type = typeof value;

  if (type === "function") {
    return { __type: "function", description: `function ${value.name || "(anonymous)"}()` };
  }
  if (type === "symbol") {
    return { __type: "symbol", description: value.toString() };
  }
  if (type === "bigint") {
    return { __type: "bigint", description: value.toString() };
  }
  if (type === "string" || type === "number" || type === "boolean") {
    return value;
  }

  // 内置类型
  if (value instanceof Uint8Array) {
    return { __type: "Uint8Array", length: value.length };
  }
  if (value instanceof Date) {
    return { __type: "Date", iso: value.toISOString() };
  }
  if (value instanceof Error) {
    return {
      __type: "Error",
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }
  if (value instanceof RegExp) {
    return { __type: "RegExp", source: value.source, flags: value.flags };
  }

  // link2chrome-client 的自定义对象（Locator / Tab / Browser 等）
  if (type === "object") {
    const className = value.constructor?.name;
    if (
      className &&
      ["Locator", "Tab", "Browser", "Tabs", "PlaywrightSurface", "CuaSurface", "DomCuaSurface"].includes(className)
    ) {
      return { __type: className, description: `[${className}]` };
    }

    if (Array.isArray(value)) {
      return value.map((v) => serializeResult(v, depth + 1));
    }

    const obj = {};
    for (const key of Object.keys(value)) {
      obj[key] = serializeResult(value[key], depth + 1);
    }
    return obj;
  }

  return String(value);
}

// ─── 代码执行器 ───────────────────────────────────────────
// 使用 new Function 保持原型链完整，与 Codex Chrome Plugin 策略一致
async function executeCode({ id, code, timeout = 30000 }) {
  const startTime = Date.now();

  try {
    const runner = new Function(
      "browser",
      "link2chrome",
      "console",
      "agent",
      `return (async () => {\n${code}\n})();`
    );

    const resultPromise = runner(browser, link2chrome, ipcConsole, agent);

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Timeout after ${timeout}ms`));
      }, timeout);
    });

    const rawResult = await Promise.race([resultPromise, timeoutPromise]);
    const elapsedMs = Date.now() - startTime;

    sendIpc({
      id,
      ok: true,
      result: serializeResult(rawResult),
      meta: { elapsedMs },
    });
  } catch (error) {
    const elapsedMs = Date.now() - startTime;
    sendIpc({
      id,
      ok: false,
      error: error?.message || String(error),
      stack: error?.stack || "",
      meta: { elapsedMs },
    });
  }
}

// ─── 主循环 ───────────────────────────────────────────────
async function main() {
  // 全局错误捕获：写入 stderr + IPC log，进程不崩溃
  process.on("uncaughtException", (err) => {
    sendLog("error", `Uncaught exception: ${err.message}`);
    if (err.stack) sendLog("error", err.stack);
  });

  process.on("unhandledRejection", (reason) => {
    sendLog("error", `Unhandled rejection: ${String(reason)}`);
  });

  await setupClient();
  setupReplContext();

  // 发送就绪信号
  sendIpc({
    type: "ready",
    version: VERSION,
    hubConnected,
  });

  // stdin 逐行读取
  const rl = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  rl.on("line", async (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      sendLog("error", `stdin 收到非法 JSON: ${line.slice(0, 200)}`);
      return;
    }

    if (message.type === "shutdown") {
      sendIpc({ type: "shutdown", ok: true });
      rl.close();
      process.exit(0);
      return;
    }

    if (message.type === "execute") {
      await executeCode({
        id: message.id,
        code: message.code,
        timeout: typeof message.timeout === "number" ? message.timeout : 30000,
      });
      return;
    }

    sendLog("warn", `未知消息类型: ${message.type}`);
  });

  rl.on("close", () => {
    process.exit(0);
  });
}

main().catch((err) => {
  // 致命启动错误：写入 stderr，避免污染 stdout
  console.error("Fatal error starting runtime:", err);
  process.exit(1);
});
