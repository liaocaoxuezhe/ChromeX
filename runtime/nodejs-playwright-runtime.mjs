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

const LOCATOR_CHAIN_METHODS = new Set([
  "locator",
  "frameLocator",
  "getByText",
  "getByRole",
  "getByLabel",
  "getByPlaceholder",
  "getByTestId",
  "filter",
  "nth",
  "first",
  "last",
]);

const TAB_METHODS = new Set([
  "goto",
  "reload",
  "back",
  "forward",
  "goBack",
  "goForward",
  "url",
  "title",
  "info",
  "screenshot",
  "waitFor",
  "close",
]);

async function resolveCurrentTabForPageFacade() {
  if (globalThis.tab) return globalThis.tab;
  if (!browser?.tabs?.selected) {
    throw new Error("page facade 无法获取当前标签页：browser.tabs.selected() 不可用。");
  }

  const selected = await browser.tabs.selected();
  if (!selected) {
    throw new Error("page facade 无法获取当前标签页：请先用 browser.tabs.new(url) 或 browser.user.claimTab(...) 绑定标签页。");
  }

  globalThis.tab = selected;
  return selected;
}

function createLocatorFacade(resolveLocator) {
  return new Proxy({}, {
    get(_target, prop) {
      if (prop === "then") return undefined;
      if (prop === Symbol.toStringTag) return "Link2ChromeLocatorFacade";

      return (...args) => {
        if (LOCATOR_CHAIN_METHODS.has(prop)) {
          return createLocatorFacade(async () => {
            const locator = await resolveLocator();
            const fn = locator?.[prop];
            if (typeof fn !== "function") {
              throw new TypeError(`page locator facade 不支持 ${String(prop)}()`);
            }
            return await fn.apply(locator, args);
          });
        }

        return (async () => {
          const locator = await resolveLocator();
          const value = locator?.[prop];
          if (typeof value === "function") {
            return await value.apply(locator, args);
          }
          if (args.length > 0) {
            throw new TypeError(`page locator facade 属性 ${String(prop)} 不是函数`);
          }
          return value;
        })();
      };
    },
  });
}

function createPageFacade() {
  return new Proxy({}, {
    get(_target, prop) {
      if (prop === "then") return undefined;
      if (prop === Symbol.toStringTag) return "Link2ChromePageFacade";

      if (prop === "tab") {
        return resolveCurrentTabForPageFacade;
      }

      if (TAB_METHODS.has(prop)) {
        return async (...args) => {
          const tab = await resolveCurrentTabForPageFacade();
          const fn = tab?.[prop];
          if (typeof fn !== "function") {
            throw new TypeError(`page facade 无法在 tab 上调用 ${String(prop)}()`);
          }
          return await fn.apply(tab, args);
        };
      }

      if (LOCATOR_CHAIN_METHODS.has(prop)) {
        return (...args) => createLocatorFacade(async () => {
          const tab = await resolveCurrentTabForPageFacade();
          const fn = tab?.playwright?.[prop];
          if (typeof fn !== "function") {
            throw new TypeError(`page facade 无法在 tab.playwright 上调用 ${String(prop)}()`);
          }
          return await fn.apply(tab.playwright, args);
        });
      }

      return async (...args) => {
        const tab = await resolveCurrentTabForPageFacade();
        const fn = tab?.playwright?.[prop];
        if (typeof fn !== "function") {
          throw new TypeError(`page facade 不支持 ${String(prop)}()；请改用 tab.playwright 或 browser.tabs API。`);
        }
        return await fn.apply(tab.playwright, args);
      };
    },
  });
}

async function setupClient() {
  await resolveWebSocketImpl();

  try {
    transport = createWebSocketTransport({ url: WS_URL, WebSocketImpl });
    link2chrome = createLink2ChromeClient({ transport });
    // browsers.get("extension") 是同步的（仅构造对象，不触发网络请求）
    browser = await link2chrome.browsers.get("extension");
    hubConnected = await transport.healthCheck?.({ timeoutMs: 750 }) || false;
  } catch (error) {
    hubConnected = false;
    sendLog("error", `Client 初始化失败: ${error.message}`);
  }
}

async function bindRuntimeSession(session, scope) {
  if (!session || !browser) return;
  const previousSession = browser.sessionName;
  const previousTab = globalThis.tab;
  if (scope && typeof browser._bindSession === "function") {
    browser._bindSession(session, scope);
  } else {
    if (browser.sessionName === session) return;
    await browser.nameSession(session, { groupTitle: session });
  }
  if (shouldResetBoundTab(previousSession, session, previousTab, scope)) {
    globalThis.tab = null;
  }
}

function tabIdFromObject(tab) {
  return tab?.id ?? tab?.raw?.id ?? tab?.raw?.tabId ?? null;
}

function tabIsAllowedByScope(tab, scope) {
  const allowedTabIds = scope?.allowedTabIds;
  if (!Array.isArray(allowedTabIds)) return true;
  const tabId = tabIdFromObject(tab);
  return tabId != null && allowedTabIds.includes(tabId);
}

function shouldResetBoundTab(previousSession, nextSession, previousTab, scope) {
  if (!previousTab) return false;
  if (previousSession && previousSession !== nextSession) return true;
  return !tabIsAllowedByScope(previousTab, scope);
}

// ─── REPL 上下文持久化 ────────────────────────────────────
// 将 browser/link2chrome/console 注入 globalThis，实现跨执行变量共享
function setupReplContext() {
  globalThis.link2chrome = link2chrome;
  globalThis.browser = browser;
  globalThis.page = createPageFacade();
  globalThis.console = ipcConsole;
  agent = {
    browsers: link2chrome.browsers,
    documentation: createDocumentationSurface(),
  };
  globalThis.agent = agent;
}

async function summarizeTab(tab) {
  if (!tab) return null;
  let info = null;
  try {
    info = await tab.info?.();
  } catch {
    info = tab.raw || {};
  }
  const raw = tab.raw || info || {};
  let url = raw.url || tab._url || null;
  let title = raw.title || tab._title || null;
  try {
    url = await tab.url?.() || url;
  } catch {
    // Keep the best local value.
  }
  try {
    title = await tab.title?.() || title;
  } catch {
    // Keep the best local value.
  }
  return {
    id: tab.id ?? raw.id ?? raw.tabId ?? null,
    url,
    title,
    active: raw.active ?? tab.active ?? null,
    debuggable: raw.debuggable ?? raw.debugable ?? raw.raw?.debuggable ?? raw.raw?.debugable ?? null,
    session: raw.session ?? raw.sessionName ?? browser?.sessionName ?? null,
    group: raw.group ?? raw.groupTitle ?? raw.groupId ?? null,
  };
}

async function collectStartupSummary() {
  const summary = {
    hubConnected,
    session: browser?.sessionName ?? null,
    group: null,
    boundTab: null,
    tabs: [],
    source: null,
  };

  if (globalThis.tab) {
    summary.boundTab = await summarizeTab(globalThis.tab);
    summary.group = summary.boundTab?.group ?? null;
    summary.source = "globalThis.tab";
    return summary;
  }

  if (!browser?.sessionName) {
    summary.source = "session-required";
    summary.sessionRequired = true;
    return summary;
  }

  try {
    const scopedTabs = await browser.tabs.list();
    summary.tabs = await Promise.all(scopedTabs.map((tab) => summarizeTab(tab)));
    const active = scopedTabs.find((tab) => tab.raw?.active) || scopedTabs[0];
    if (active) {
      globalThis.tab = active;
      summary.boundTab = await summarizeTab(active);
      summary.group = summary.boundTab?.group ?? null;
      summary.source = "browser.tabs.list";
      return summary;
    }
  } catch (error) {
    summary.tabsError = error?.message || String(error);
  }

  if (!hubConnected) {
    summary.source = "hub-unavailable";
  }
  return summary;
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

function persistTopLevelDeclarations(code) {
  let depth = 0;
  const lines = String(code).split("\n");
  return lines.map((line) => {
    const depthAtLineStart = depth;
    const match = line.match(/^(\s*)(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=(.*)$/);
    let rewritten = line;
    if (depthAtLineStart === 0 && match) {
      rewritten = `${match[1]}globalThis.${match[2]} =${match[3]}`;
    }

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth = Math.max(0, depth - 1);
    }
    return rewritten;
  }).join("\n");
}

function buildErrorHint(error) {
  const name = error?.name || "";
  const message = error?.message || String(error);

  if (name === "ReferenceError" && /\bpage\b.*not defined|page is not defined/i.test(message)) {
    return "page is not defined：browser_code_run 现在会预注入 page facade；若在旧上下文或局部作用域中遇到该错误，请使用 `const tab = await browser.tabs.selected(); const page = tab.playwright;`，或直接调用预注入的 `page.evaluate(...)`。page facade 是 Link2Chrome 的 Playwright 兼容层，不是完整 Playwright Page。";
  }

  if (name === "ReferenceError" && /\btab\b.*not defined|tab is not defined/i.test(message)) {
    return "tab is not defined：请先用 `const tab = await browser.tabs.selected()` 获取当前标签页；复杂任务优先 `browser.user.openTabs()` + `browser.user.claimTab(...)`，再通过 `tab.playwright` 操作页面。";
  }

  if (name === "ReferenceError") {
    return "变量未定义。请检查拼写、作用域；若要跨 browser_code_run 调用复用变量，请赋值到 globalThis。";
  }

  if (name === "SyntaxError") {
    return "JavaScript 语法错误。请检查括号、引号、逗号和 return 语句位置。";
  }

  if (name === "TypeError") {
    return "类型错误。常见原因是对象为空、API 名称写错、异步调用缺少 await，或在错误的对象上调用方法。";
  }

  if (message.includes("Timeout after")) {
    return "代码执行超时。请检查等待条件是否会结束，避免无限等待；必要时提高 timeout。";
  }

  if (/playwright|locator|selector|timeout/i.test(message)) {
    return "浏览器自动化调用失败。请确认目标 tab 正确、选择器存在；使用 tab.playwright 或 page facade 前先读取对应文档。";
  }

  return "执行 browser_code_run 代码失败。请查看 error 和 stack，必要时先读取 await browser.documentation()。";
}

function describeExecutionError(error) {
  return {
    error: error?.message || String(error),
    errorType: error?.name || "Error",
    hint: buildErrorHint(error),
    stack: error?.stack || "",
  };
}

// ─── 代码执行器 ───────────────────────────────────────────
// 使用 new Function 保持原型链完整，与 Codex Chrome Plugin 策略一致
async function executeCode({ id, code, timeout = 30000 }) {
  const startTime = Date.now();
  const startupSummary = await collectStartupSummary();

  try {
    const executableCode = persistTopLevelDeclarations(code);
    const runner = new Function(
      "browser",
      "link2chrome",
      "console",
      "agent",
      `return (async () => {\n${executableCode}\n})();`
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
      meta: { elapsedMs, startupSummary },
    });
  } catch (error) {
    const elapsedMs = Date.now() - startTime;
    const executionError = describeExecutionError(error);
    sendIpc({
      id,
      ok: false,
      ...executionError,
      meta: { elapsedMs, startupSummary },
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
    startupSummary: await collectStartupSummary(),
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
      if (message.lease_token && transport && transport.setLeaseToken) {
        transport.setLeaseToken(message.lease_token);
      }
      if (message.session) {
        await bindRuntimeSession(message.session, message.scope);
      }
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
