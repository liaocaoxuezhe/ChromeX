import { spawn as defaultSpawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import {
  discoverLocalBrowserEnvironment,
  openLocalBrowserWindow,
} from "./local-environment.mjs";
import { evaluateSafetyPolicy } from "./safety-policy.mjs";
import {
  decodeNativeMessages,
  encodeNativeMessage,
} from "../scripts/native-host/native-host.mjs";
import { checkChromeIsRunning } from "../scripts/diagnostics/chrome-is-running.mjs";
import { checkExtensionInstalled } from "../scripts/diagnostics/check-extension-installed.mjs";
import { checkInstalledBrowsers } from "../scripts/diagnostics/installed-browsers.mjs";
import { checkNativeHostManifest } from "../scripts/diagnostics/check-native-host-manifest.mjs";

export function setupLink2ChromeRuntime({
  globals = globalThis,
  transport,
  confirmAction,
  localEnvironment,
  overwrite = false,
  wsUrl = process.env.LINK2CHROME_WS_URL || "ws://localhost:8766",
  WebSocketImpl = globalThis.WebSocket,
} = {}) {
  const link2chrome = createLink2ChromeClient({
    transport: transport || createWebSocketTransport({ url: wsUrl, WebSocketImpl }),
    confirmAction,
    localEnvironment,
  });
  const agent = {
    browsers: link2chrome.browsers,
    documentation: createDocumentationSurface(),
  };
  if (overwrite || globals.link2chrome === undefined) {
    globals.link2chrome = link2chrome;
  }
  if (overwrite || globals.agent === undefined) {
    globals.agent = agent;
  }
  return { agent, link2chrome };
}

export function createLink2ChromeClient({
  transport,
  confirmAction,
  localEnvironment,
  safetyPolicy,
  diagnosticsChecks,
} = {}) {
  if (!transport || typeof transport.command !== "function") {
    throw new TypeError("createLink2ChromeClient requires a transport with command(name, args)");
  }
  const safety = new SafetyManager({ confirmAction, policy: safetyPolicy });
  const diagnosticsSurface = new DiagnosticsSurface({ transport, localEnvironment, checks: diagnosticsChecks });
  const diagnostics = diagnosticsSurface.run.bind(diagnosticsSurface);
  diagnostics.readiness = diagnosticsSurface.readiness.bind(diagnosticsSurface);
  const client = {
    _transport: transport,
    _safety: safety,
    async diagnose() {
      try {
        return {
          ok: true,
          hub: await transport.command("__hub_status__", {}),
        };
      } catch (error) {
        return {
          ok: false,
          error: String(error?.message || error),
        };
      }
    },
    diagnostics,
    sessions: new SessionSurface({ transport, safety }),
    browsers: {
      async list() {
        return [{
          kind: "extension",
          name: "Link2Chrome Extension",
          available: true,
          default: true,
        }];
      },
      async get(kind = "extension") {
        if (kind !== "extension") {
          throw new Error(`unsupported browser kind: ${kind}`);
        }
        return new Browser({ kind, transport, safety });
      },
    },
  };
  client.localEnvironment = new LocalEnvironmentSurface({ localEnvironment, client });
  client.scripts = new ScriptSurface({ client });
  client.tasks = new TaskSurface({ client });
  return client;
}

class TaskSurface {
  constructor({ client }) {
    this._client = client;
  }

  async run(name, script, options = {}) {
    const sessionName = options.sessionName || name;
    return this._client.sessions.runExclusive(sessionName, async ({ browser, lease }) => {
      let launch;
      try {
        launch = await this._client.localEnvironment.openAndWait(options);
      } catch (error) {
        error.task = { name };
        throw error;
      }
      const taskContext = {
        task: { name },
        launch: launch.launch,
        readiness: launch.readiness,
        tab: preparedTabFromReadiness({
          browser,
          transport: this._client._transport,
          safety: this._client._safety,
          readiness: launch.readiness,
        }),
      };
      try {
        const result = await this._client.scripts.run(script, {
          ...options.scriptOptions,
          browser,
          lease,
          context: {
            ...options.scriptOptions?.context,
            ...taskContext,
          },
        });
        const finalize = options.finalize
          ? await browser.tabs.finalize({
            keep: [{
              tab: taskContext.tab,
              status: options.finalize.status || "handoff",
            }],
          })
          : null;
        return {
          launch: launch.launch,
          readiness: launch.readiness,
          result,
          ...(finalize ? { finalize } : {}),
        };
      } catch (error) {
        Object.assign(error, taskContext);
        throw error;
      }
    });
  }
}

class ScriptSurface {
  constructor({ client }) {
    this._client = client;
  }

  async run(script, options = {}) {
    const execute = async ({ browser = options.browser, lease = options.lease } = {}) => {
      const runtimeBrowser = browser || await this._client.browsers.get(options.browser || "extension");
      const context = {
        agent: {
          browsers: this._client.browsers,
          documentation: createDocumentationSurface(),
        },
        link2chrome: this._client,
        browser: runtimeBrowser,
        lease,
        ...options.context,
      };
      return runModelScript(script, context);
    };
    if (options.sessionName) {
      return this._client.sessions.runExclusive(options.sessionName, execute);
    }
    return execute();
  }
}

async function runModelScript(script, context) {
  if (typeof script === "function") {
    return script(context);
  }
  if (typeof script !== "string") {
    throw new TypeError("scripts.run requires an async function or JavaScript source string");
  }
  const runner = new Function(
    "context",
    `"use strict";
return (async () => {
  const { agent, link2chrome, browser, tab, lease, task, launch, readiness } = context;
{
${script}
}
})();`
  );
  return runner(context);
}

function preparedTabFromReadiness({ browser, transport, safety, readiness }) {
  const data = readiness?.selectedTab?.tab || {};
  return new Tab({ browser, transport, safety, data, raw: data });
}

class SessionSurface {
  constructor({ transport, safety }) {
    this._transport = transport;
    this._safety = safety;
  }

  async runExclusive(name, callback) {
    const lease = await this._acquire(name);
    const browser = new Browser({ kind: "extension", transport: this._transport, safety: this._safety });
    try {
      return await callback({ browser, lease });
    } finally {
      await this._release(lease);
    }
  }

  async _acquire(name) {
    if (typeof this._transport.acquireLease === "function") {
      return this._transport.acquireLease(name);
    }
    return this._transport.command("__hub_acquire__", { name });
  }

  async _release(lease) {
    if (typeof this._transport.releaseLease === "function") {
      return this._transport.releaseLease(lease);
    }
    const leaseToken = lease?.lease_token || lease?.leaseToken;
    return this._transport.command("__hub_release__", { lease_token: leaseToken });
  }
}

class LocalEnvironmentSurface {
  constructor({ localEnvironment, client }) {
    this._localEnvironment = localEnvironment;
    this._client = client;
  }

  async inspect(options = {}) {
    if (this._localEnvironment?.inspect) {
      return this._localEnvironment.inspect(options);
    }
    return discoverLocalBrowserEnvironment(options);
  }

  async openBrowser(options = {}) {
    if (this._localEnvironment?.openBrowser) {
      return this._localEnvironment.openBrowser(options);
    }
    const environment = options.environment || await this.inspect(options.inspect || {});
    const browser = findBrowserForOpen(environment, options);
    const launchTarget = selectLaunchTarget(environment, browser, options);
    return openLocalBrowserWindow({
      browser,
      profileId: launchTarget.profileId,
      url: options.url,
      extensionDir: launchTarget.extensionDir,
      onlyExtension: options.onlyExtension,
      launcher: options.launcher,
    });
  }

  async openAndWait(options = {}) {
    const launch = await this.openBrowser(options);
    try {
      const readiness = await waitForReadiness({
        diagnostics: this._client.diagnostics,
        timeoutMs: options.timeoutMs,
        intervalMs: options.intervalMs,
        sleep: options.sleep,
        now: options.now,
      });
      return { launch, readiness };
    } catch (error) {
      error.launch = launch;
      throw error;
    }
  }
}

function findBrowserForOpen(environment, options) {
  const browsers = environment?.browsers || [];
  if (options.browser) return options.browser;
  if (options.browserId) {
    return browsers.find((browser) => browser.id === options.browserId);
  }
  return browsers.find((browser) => browser.installed) || browsers[0];
}

function selectLaunchTarget(environment, browser, options) {
  const explicitProfileId = options.profileId || null;
  const explicitExtensionDir = options.extensionDir || null;
  if (explicitProfileId || explicitExtensionDir) {
    return {
      profileId: explicitProfileId,
      extensionDir: explicitExtensionDir,
    };
  }

  const profiles = browser?.profiles || [];
  const enabledProfile = profiles.find((profile) => profile.extensionInstall?.installed && profile.extensionInstall?.enabled);
  if (enabledProfile) {
    return {
      profileId: enabledProfile.id,
      extensionDir: null,
    };
  }

  const fallbackProfile = profiles[0] || null;
  return {
    profileId: fallbackProfile?.id || null,
    extensionDir: environment?.extensionPackage?.ok ? environment.extensionPackage.path : null,
  };
}

async function waitForReadiness({
  diagnostics,
  timeoutMs = 15000,
  intervalMs = 250,
  sleep = defaultSleep,
  now = Date.now,
}) {
  const deadline = now() + timeoutMs;
  let lastReadiness = null;
  while (true) {
    lastReadiness = await diagnostics.readiness();
    if (lastReadiness.ok) return lastReadiness;
    if (now() >= deadline) {
      const error = new Error("Timed out waiting for Link2Chrome readiness");
      error.readiness = lastReadiness;
      throw error;
    }
    await sleep(intervalMs);
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class DiagnosticsSurface {
  constructor({ transport, localEnvironment, checks }) {
    this._transport = transport;
    this._localEnvironment = localEnvironment;
    this._checks = checks || {
      chromeRunning: () => checkChromeIsRunning(),
      installedBrowsers: () => checkInstalledBrowsers({ inspect: this._inspectLocalEnvironment.bind(this) }),
      extensionInstalled: () => checkExtensionInstalled({ inspect: this._inspectLocalEnvironment.bind(this) }),
      nativeHostManifest: () => checkNativeHostManifest(),
    };
  }

  async run() {
    const [
      chromeRunning,
      installedBrowsers,
      extensionInstalled,
      nativeHostManifest,
    ] = await Promise.all([
      this._checks.chromeRunning(),
      this._checks.installedBrowsers(),
      this._checks.extensionInstalled(),
      this._checks.nativeHostManifest(),
    ]);
    return {
      chromeRunning,
      installedBrowsers,
      extensionInstalled,
      nativeHostManifest,
    };
  }

  async readiness() {
    const hub = await this._checkHub();
    const selectedTab = await this._checkSelectedTab();
    const localEnvironment = await this._checkLocalEnvironment();
    const extensionConnected = Boolean(hub.status?.extension_connected);
    return {
      ok: Boolean(hub.ok && extensionConnected && selectedTab.ok),
      hub,
      extension: {
        ok: extensionConnected,
        connected: extensionConnected,
      },
      selectedTab,
      localEnvironment,
      capabilities: runtimeCapabilities({ transport: this._transport }),
    };
  }

  async _checkHub() {
    try {
      return {
        ok: true,
        status: await this._transport.command("__hub_status__", {}),
      };
    } catch (error) {
      return {
        ok: false,
        error: String(error?.message || error),
      };
    }
  }

  async _checkSelectedTab() {
    try {
      return {
        ok: true,
        tab: await this._transport.command("browser_tab_info", {}),
      };
    } catch (error) {
      return {
        ok: false,
        error: String(error?.message || error),
      };
    }
  }

  async _checkLocalEnvironment() {
    try {
      return await this._inspectLocalEnvironment();
    } catch (error) {
      return {
        ok: false,
        error: String(error?.message || error),
      };
    }
  }

  async _inspectLocalEnvironment() {
    if (this._localEnvironment?.inspect) {
      return this._localEnvironment.inspect();
    }
    return discoverLocalBrowserEnvironment();
  }
}

function runtimeCapabilities({ transport } = {}) {
  return {
    playwrightStyle: {
      domSnapshot: true,
      waitForLoadState: true,
      locator: true,
      fileChooser: true,
      dialog: true,
      hover: true,
      press: true,
      selectOption: true,
      fillForm: true,
    },
    cua: {
      screenshot: true,
      click: true,
      drag: true,
      keyboard: true,
    },
    domCua: {
      visibleDom: true,
      query: true,
      click: true,
    },
    devtools: {
      console: true,
      network: true,
    },
    clipboard: {
      readText: true,
      writeText: true,
    },
    lifecycle: {
      tabList: true,
      tabClaim: true,
      tabFinalize: true,
      tabHistoryNavigation: true,
    },
    browserState: {
      browserList: true,
      openTabs: true,
      claimTab: true,
      history: true,
    },
    sessions: {
      runExclusive: true,
    },
    localEnvironment: {
      inspect: true,
      openBrowser: true,
      openAndWait: true,
    },
    codeRunner: {
      scriptsRun: true,
      acceptsFunction: true,
      acceptsSourceString: true,
      exclusiveSession: true,
    },
    tasks: {
      run: true,
      preparesBrowser: true,
      exclusiveSession: true,
      finalize: true,
    },
    nativeMessaging: Boolean(transport?.nativeMessaging),
    localPlaywrightDependency: false,
  };
}

export function createNativeMessagingTransport({
  hostPath,
  spawnImpl = defaultSpawn,
} = {}) {
  if (!hostPath) {
    throw new Error("createNativeMessagingTransport requires hostPath");
  }
  let nextId = 1;
  let stdoutBuffer = Buffer.alloc(0);
  const pending = new Map();
  const child = spawnImpl(hostPath, [], { stdio: ["pipe", "pipe", "pipe"] });

  child.stdout.on("data", (chunk) => {
    stdoutBuffer = Buffer.concat([stdoutBuffer, Buffer.from(chunk)]);
    const decoded = decodeNativeMessages(stdoutBuffer);
    stdoutBuffer = decoded.remainder;
    for (const message of decoded.messages) {
      const request = pending.get(message.id);
      if (!request) continue;
      pending.delete(message.id);
      if (message.error) {
        request.reject(new Error(message.error));
      } else {
        request.resolve(message.result);
      }
    }
  });

  const rejectPending = (error) => {
    for (const request of pending.values()) {
      request.reject(error);
    }
    pending.clear();
  };
  child.on?.("error", rejectPending);
  child.on?.("exit", (code, signal) => {
    rejectPending(new Error(`native messaging host exited: code=${code} signal=${signal}`));
  });

  return {
    nativeMessaging: true,
    child,
    command(name, args = {}) {
      const id = nextId++;
      const message = { id, name, args };
      const encoded = encodeNativeMessage(message);
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try {
          child.stdin.write(encoded);
        } catch (error) {
          pending.delete(id);
          reject(error);
        }
      });
    },
  };
}

export function createWebSocketTransport({ url = "ws://localhost:8766", WebSocketImpl = globalThis.WebSocket, commandTimeoutMs = 30000 } = {}) {
  let leaseToken = null;
  const command = (commandName, params = {}, options = {}) => sendHubCommand({
    url,
    WebSocketImpl,
    commandName,
    params,
    leaseToken,
    timeoutMs: options.timeoutMs ?? commandTimeoutMs,
  });
  return {
    setLeaseToken(token) {
      leaseToken = token;
    },
    async healthCheck({ timeoutMs = 750 } = {}) {
      if (!WebSocketImpl) return false;
      try {
        await command("get_info", {}, { timeoutMs });
        return true;
      } catch {
        return false;
      }
    },
    async acquireLease(name) {
      const lease = await sendHubCommand({
        url,
        WebSocketImpl,
        commandName: "__hub_acquire__",
        params: { name },
        timeoutMs: commandTimeoutMs,
      });
      leaseToken = lease.lease_token;
      return lease;
    },

    async releaseLease(lease = {}) {
      const token = lease.lease_token || lease.leaseToken || leaseToken;
      const result = await sendHubCommand({
        url,
        WebSocketImpl,
        commandName: "__hub_release__",
        params: { lease_token: token },
        timeoutMs: commandTimeoutMs,
      });
      if (!lease.lease_token || lease.lease_token === leaseToken) {
        leaseToken = null;
      }
      return result;
    },

    async command(name, args = {}) {
      if (!WebSocketImpl) {
        throw new Error("createWebSocketTransport requires global WebSocket or WebSocketImpl");
      }
      const send = (commandName, params = {}) => command(commandName, params);
      if (name === "browser_tabs_list") {
        const raw = await send("get_all_tabs", args);
        const tabs = [];
        for (const windowTabs of Object.values(raw.windows || {})) {
          for (const { id, windowId, active, url, title, status, favIconUrl } of windowTabs) {
            tabs.push({
              id,
              windowId,
              active,
              url,
              title,
              status: status || "unknown",
              favicon: favIconUrl,
            });
          }
        }
        return { tabs, totalCount: tabs.length, raw };
      }
      if (name === "browser_tab_info") return send("agent_browser_tab_info", args);
      if (name === "browser_tab_switch") return send("agent_browser_tab_switch", args);
      if (name === "browser_tab_new") return send("agent_browser_tab_new", args);
      if (name === "browser_tab_close") return send("tab_manage", { action: "close", ...args });
      if (name === "browser.tabs.finalize") return send("agent_browser_tabs_finalize", args);
      if (name === "browser.user.history") return send("agent_browser_history", args);
      if (name === "browser.wait") return send("agent_browser_wait", args);
      if (name === "browser.clipboard.readText") return send("clipboard_read", args);
      if (name === "browser.clipboard.writeText") return send("clipboard_write", args);
      if (name === "script_evaluate") return send("script_evaluate", normalizeScriptEvaluateArgs(args));
      if (name === "browser_navigate") return send("navigate", args);
      if (name === "browser.dom.overview") return send("dom_overview", args);
      if (name === "browser.dom.query") return send("dom_query", args);
      if (name === "browser.dom.search") return send("dom_search", args);
      if (name === "browser.dom.click") return send("action_click", args);
      if (name === "browser.dom.type") return send("type", normalizeTypeArgs(args));
      if (name === "browser.dom.scroll") return send("action_scroll", args);
      if (name === "browser.cua.screenshot") {
        const image = await send("screenshot", {
          format: args.format || "png",
          quality: args.quality || 80,
        });
        const info = await send("get_info", {});
        const viewport = info.viewport || {};
        const dpr = Number(viewport.devicePixelRatio || 1);
        const cssWidth = viewport.innerWidth;
        const cssHeight = viewport.innerHeight;
        return {
          ok: Boolean(image.image),
          format: image.format || args.format || "png",
          data: image.image || "",
          metadata: {
            coordinateSpace: "screenshot",
            devicePixelRatio: dpr,
            cssViewport: { width: cssWidth, height: cssHeight },
            screenshotSize: {
              width: cssWidth ? Math.trunc(cssWidth * dpr) : null,
              height: cssHeight ? Math.trunc(cssHeight * dpr) : null,
            },
          },
          raw: { image, info },
        };
      }
      if (name === "browser.cua.click") {
        const point = await screenshotPointToCss(send, args.x, args.y);
        return send("click", {
          x: point.x,
          y: point.y,
          button: args.button || "left",
          clickCount: args.clickCount || 1,
          keypress: args.keypress,
        });
      }
      if (name === "browser.cua.double_click") {
        const point = await screenshotPointToCss(send, args.x, args.y);
        return send("click", { x: point.x, y: point.y, button: "left", clickCount: 2, keypress: args.keypress });
      }
      if (name === "browser.cua.move") {
        const point = await screenshotPointToCss(send, args.x, args.y);
        return send("action_hover", { target: point });
      }
      if (name === "browser.cua.type") return send("type", args);
      if (name === "browser.cua.key") return send("send_keys", { keys: args.combo || args.key });
      if (name === "browser.cua.scroll") {
        return send("scroll", {
          x: args.x || 0,
          y: args.y || 0,
          deltaX: args.dx || 0,
          deltaY: args.dy ?? args.deltaY ?? 500,
          keypress: args.keypress,
        });
      }
      if (name === "browser.cua.drag") {
        const start = await screenshotPointToCss(send, args.x1, args.y1);
        const end = await screenshotPointToCss(send, args.x2, args.y2);
        return send("drag", {
          startX: start.x,
          startY: start.y,
          endX: end.x,
          endY: end.y,
          duration: args.duration || 500,
          keys: args.keys,
          path: args.path,
        });
      }

      return send(name, args);
    },
  };
}

function normalizeScriptEvaluateArgs(args = {}) {
  if (typeof args.expression === "string") return args;
  if (typeof args.script !== "string") return args;
  const { script, ...rest } = args;
  return { ...rest, expression: script };
}

function normalizeTypeArgs(args = {}) {
  if (!args.target) return args;
  const { target, ...rest } = args;
  const flatTarget = targetToTypeArgs(target);
  if (Object.keys(flatTarget).length > 0) return { ...rest, ...flatTarget };
  return args;
}

function targetToTypeArgs(target = {}) {
  if (target.selector) return { selector: target.selector };
  if (typeof target.x === "number" && typeof target.y === "number") {
    return { x: target.x, y: target.y };
  }
  return {};
}

function unwrapScriptEvaluateResult(raw) {
  if (raw && typeof raw === "object" && Object.prototype.hasOwnProperty.call(raw, "result")) {
    return raw.result;
  }
  return raw;
}

function sendHubCommand({ url, WebSocketImpl, commandName, params, leaseToken, timeoutMs = 30000 }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocketImpl(url);
    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      reject(new Error(`Link2Chrome command timed out: ${commandName}`));
    }, timeoutMs);

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({
        request_id: requestId,
        command: commandName,
        params,
        ...(leaseToken ? { lease_token: leaseToken } : {}),
      }));
    });
    ws.addEventListener("message", (event) => {
      const data = JSON.parse(event.data);
      if (data.request_id && data.request_id !== requestId) return;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      if (data.success === false || data.error) {
        reject(new Error(data.error || `Link2Chrome command failed: ${commandName}`));
      } else {
        resolve(data.data ?? data);
      }
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`Link2Chrome WebSocket error for command: ${commandName}`));
    });
  });
}

async function screenshotPointToCss(send, x, y) {
  const info = await send("get_info", {});
  const dpr = Number(info.viewport?.devicePixelRatio || 1);
  return {
    x: cleanNumber(x / dpr),
    y: cleanNumber(y / dpr),
  };
}

function cleanNumber(value) {
  return Number.isInteger(value) ? value : Number(value.toFixed(3));
}

function omitUndefined(value = {}) {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
}

class Link2ChromeError extends Error {
  constructor(message, props = {}) {
    super(message);
    this.name = this.constructor.name;
    Object.assign(this, props);
  }
}

export class LocatorNotFoundError extends Link2ChromeError {
  constructor(selector, url) {
    super(`Locator did not match any element: ${selector}`, { selector, url });
  }
}

export class StrictModeError extends Link2ChromeError {
  constructor(selector, url, count) {
    super(`Strict mode violation: locator resolved to ${count} elements: ${selector}`, { selector, url, count });
  }
}

export class TimeoutError extends Link2ChromeError {
  constructor(message, selector, url) {
    super(message, { selector, url });
  }
}

// ===== CapabilityCollection 能力发现框架 =====
const browserCapabilityRegistry = new Map();
const tabCapabilityRegistry = new Map();

export function registerBrowserCapability(id, description, factory) {
  browserCapabilityRegistry.set(id, { description, factory });
}

export function registerTabCapability(id, description, factory) {
  tabCapabilityRegistry.set(id, { description, factory });
}

class CapabilityCollection {
  constructor({ scope, registry, owner, transport, safety }) {
    this._scope = scope;
    this._registry = registry || new Map();
    this._owner = owner;
    this._transport = transport;
    this._safety = safety;
  }

  async list() {
    const result = [];
    for (const [id, entry] of this._registry.entries()) {
      result.push({ id, description: entry.description || "" });
    }
    return result;
  }

  async get(id) {
    const entry = this._registry.get(id);
    if (!entry) {
      const available = Array.from(this._registry.keys());
      const availableStr = available.length > 0 ? available.join(", ") : "(无)";
      throw new Error(`Capability "${id}" not found in ${this._scope} scope. Available capabilities: ${availableStr}`);
    }
    const context = this._scope === "browser"
      ? { browser: this._owner, transport: this._transport, safety: this._safety }
      : { tab: this._owner, transport: this._transport, safety: this._safety };
    return entry.factory(context);
  }
}

function roleSelector(role) {
  const normalized = String(role || "").toLowerCase();
  const selectors = {
    button: 'button, input[type="button"], input[type="submit"], [role="button"]',
    link: 'a[href], [role="link"]',
    textbox: 'input:not([type]), input[type="text"], input[type="search"], textarea, [role="textbox"]',
    checkbox: 'input[type="checkbox"], [role="checkbox"]',
    radio: 'input[type="radio"], [role="radio"]',
    combobox: 'select, [role="combobox"]',
  };
  return selectors[normalized] || `[role="${cssStringEscape(normalized)}"]`;
}

function cssStringEscape(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

class Browser {
  constructor({ kind, transport, safety }) {
    this.kind = kind;
    this.browserId = kind;
    this._transport = transport;
    this._safety = safety;
    this.tabs = new Tabs({ browser: this, transport, safety });
    this.user = new UserSurface({ browser: this, transport, safety });
    this.capabilities = new CapabilityCollection({ scope: "browser", registry: browserCapabilityRegistry, owner: this, transport, safety });
  }

  async nameSession(name) {
    this.sessionName = name;
    return { ok: true, name };
  }

  async documentation() {
    const docs = createDocumentationSurface();
    return docs.get("api");
  }
}

class Tabs {
  constructor({ browser, transport, safety }) {
    this._browser = browser;
    this._transport = transport;
    this._safety = safety;
  }

  async list() {
    const raw = await this._transport.command("browser_tabs_list", {});
    return (raw.tabs || []).map(
      (tab) => new Tab({ browser: this._browser, transport: this._transport, safety: this._safety, data: tab, raw: tab })
    );
  }

  async selected() {
    const raw = await this._transport.command("browser_tab_info", {});
    return new Tab({ browser: this._browser, transport: this._transport, safety: this._safety, data: raw, raw });
  }

  async get(id) {
    const tabs = await this.list();
    return tabs.find((tab) => tab.id === id) || null;
  }

  async new(urlOrOptions, options = {}) {
    const args = typeof urlOrOptions === "object" && urlOrOptions !== null
      ? { ...urlOrOptions }
      : { ...(urlOrOptions ? { url: urlOrOptions } : {}), ...options };
    const raw = await this._transport.command("browser_tab_new", args);
    return new Tab({ browser: this._browser, transport: this._transport, safety: this._safety, data: raw, raw });
  }

  async finalize({ keep = [] } = {}) {
    const normalizedKeep = keep.map((item) => ({
      tabId: item.tab?.id ?? item.tabId ?? null,
      status: item.status || "handoff",
    }));
    try {
      return await this._transport.command("browser.tabs.finalize", { keep: normalizedKeep });
    } catch (error) {
      if (!isUnsupportedCommandError(error)) {
        throw error;
      }
    }
    return {
      ok: true,
      action: "finalize",
      kept: normalizedKeep,
      raw: null,
    };
  }
}

class UserSurface {
  constructor({ browser, transport, safety }) {
    this._browser = browser;
    this._transport = transport;
    this._safety = safety;
  }

  async openTabs() {
    // browser.user.openTabs: list real user Chrome tabs before claiming one.
    return this._browser.tabs.list();
  }

  async claimTab(tabOrOptions = {}) {
    // browser.user.claimTab: accept a Tab, raw tab object, or { tabId }.
    const tabId = tabOrOptions?.tabId ?? tabOrOptions?.id ?? tabOrOptions?.raw?.id;
    if (tabId !== undefined && tabId !== null) {
      await this._transport.command("browser_tab_switch", { tabId });
    }
    return this._browser.tabs.selected();
  }

  async history(options = {}) {
    return this._transport.command("browser.user.history", options);
  }
}

function isUnsupportedCommandError(error) {
  return /unknown|unsupported|unimplemented|未知|未实现/i.test(String(error?.message || error));
}

class SafetyManager {
  constructor({ confirmAction, policy } = {}) {
    this._confirmAction = confirmAction;
    this._policy = policy;
  }

  async confirm(action) {
    const safety = action.safety || evaluateSafetyPolicy({ policy: this._policy, action });
    if (!safety) return true;
    if (safety.level === "no-confirm") return true;
    if (typeof this._confirmAction !== "function") {
      throw new Error(`Action requires confirmation: ${safety.reason || action.type}`);
    }
    const confirmed = await this._confirmAction({ ...action, safety });
    if (!confirmed) {
      throw new Error("Action was not confirmed");
    }
    return true;
  }
}

class Tab {
  constructor({ browser, transport, safety, data = {}, raw = data }) {
    this.browser = browser;
    this._transport = transport;
    this._safety = safety;
    this.id = data.id;
    this._url = data.url;
    this._title = data.title;
    this.active = data.active;
    this.raw = raw;
    this.playwright = new PlaywrightSurface({ tab: this, transport, safety });
    this.cua = new CuaSurface({ tab: this, transport, safety });
    this.dom_cua = new DomCuaSurface({ tab: this, transport, safety });
    this.dev = new DevSurface({ tab: this, transport });
    this.clipboard = new ClipboardSurface({ tab: this, transport, safety });
    this.dialog = new DialogSurface({ tab: this, transport, safety });
    this.capabilities = new CapabilityCollection({ scope: "tab", registry: tabCapabilityRegistry, owner: this, transport, safety });
  }

  async url() {
    try {
      const info = await this._transport.command("browser_tab_info", { tabId: this.id });
      return info.url ?? this._url;
    } catch {
      return this._url;
    }
  }

  async title() {
    try {
      const info = await this._transport.command("browser_tab_info", { tabId: this.id });
      return info.title ?? this._title;
    } catch {
      return this._title;
    }
  }

  async goto(url) {
    return this._transport.command("browser_navigate", { url });
  }

  async reload() {
    const current = await this.info();
    return this.goto(current.url);
  }

  async back() {
    return this.goBack();
  }

  async forward() {
    return this.goForward();
  }

  async goBack() {
    return this._transport.command("go_back", {});
  }

  async goForward() {
    return this._transport.command("go_forward", {});
  }

  async info() {
    return this._transport.command("browser_tab_info", { tabId: this.id });
  }

  async screenshot(options = {}) {
    const result = await this._transport.command("browser.cua.screenshot", options);
    if (options.raw === true) {
      return result;
    }
    const base64 = result?.data ?? result?.base64;
    if (typeof base64 === "string" && base64.length > 0) {
      const buf = Buffer.from(base64, "base64");
      return new Uint8Array(buf);
    }
    return result;
  }

  async waitFor(options = {}) {
    return this._transport.command("browser.wait", options);
  }

  async close() {
    return this._transport.command("browser_tab_close", { tabId: this.id });
  }
}

class PlaywrightSurface {
  constructor({ tab, transport, safety }) {
    this._tab = tab;
    this._transport = transport;
    this._safety = safety;
  }

  async domSnapshot(options = {}) {
    const raw = await this._transport.command("browser.dom.overview", options);
    return formatDomSnapshot(raw);
  }

  async screenshot(options = {}) {
    const result = await this._transport.command("browser.cua.screenshot", options);
    if (options.raw === true) {
      return result;
    }
    const base64 = result?.data ?? result?.base64;
    if (typeof base64 === "string" && base64.length > 0) {
      const buf = Buffer.from(base64, "base64");
      return new Uint8Array(buf);
    }
    return result;
  }

  async evaluate(pageFunction, arg, options = {}) {
    const hasArg = arguments.length >= 2;
    const expression = typeof pageFunction === "string"
      ? pageFunction
      : `(() => {
        const fn = (${pageFunction.toString()});
        const args = ${JSON.stringify(hasArg ? [arg] : [])};
        return fn.apply(null, args);
      })()`;
    const timeout = options.timeoutMs ?? options.timeout ?? 30000;
    const raw = await this._transport.command("script_evaluate", { expression, awaitPromise: true, timeout });
    return unwrapScriptEvaluateResult(raw);
  }

  async waitForTimeout(timeoutMs) {
    return new Promise((resolve) => setTimeout(resolve, timeoutMs));
  }

  async waitForEvent(eventName, options = {}) {
    if (eventName === "download") {
      const timeoutMs = options.timeoutMs ?? options.timeout ?? 30000;
      return this._transport.command("wait_for_download", { timeout: timeoutMs });
    }
    if (eventName !== "filechooser") {
      throw new Error(`Unsupported playwright event: ${eventName}`);
    }
    return new FileChooser({ transport: this._transport, safety: this._safety, selector: options.selector });
  }

  async waitForLoadState(stateOrOptions = "load", options = {}) {
    let state;
    let opts;
    if (typeof stateOrOptions === "object" && stateOrOptions !== null) {
      state = stateOrOptions.state ?? "load";
      opts = stateOrOptions;
    } else {
      state = stateOrOptions ?? "load";
      opts = options;
    }
    const timeoutMs = opts.timeoutMs ?? opts.timeout ?? 30000;
    const deadline = Date.now() + timeoutMs;
    const sleepMs = 250;

    const readyScripts = {
      load: "document.readyState === 'complete'",
      domcontentloaded: "document.readyState !== 'loading'",
      networkidle: "(function(){const e=performance.getEntriesByType('resource');const n=performance.now();return e.filter(r=>n-r.startTime<500).length===0&&document.readyState==='complete';})()",
    };

    if (!readyScripts[state]) {
      throw new Error(`Unsupported load state: ${state}`);
    }

    while (Date.now() < deadline) {
      const result = await this._evalBoolean(readyScripts[state]);
      if (result === true) return;
      if (result === undefined) {
        throw new Error("script_evaluate is required for waitForLoadState");
      }
      await new Promise((resolve) => setTimeout(resolve, sleepMs));
    }
    throw new TimeoutError(`waitForLoadState('${state}') timed out after ${timeoutMs}ms`, state, await this._tab?.url?.());
  }

  async waitForURL(pattern, options = {}) {
    const timeoutMs = options.timeoutMs ?? options.timeout ?? 30000;
    const deadline = Date.now() + timeoutMs;
    const sleepMs = 250;
    const matcher = globToRegex(pattern);
    const tabUrl = await this._tab?.url?.();
    if (tabUrl && matcher.test(tabUrl)) return;

    while (Date.now() < deadline) {
      let currentUrl;
      try {
        const info = await this._tab?.info?.();
        currentUrl = info?.url;
      } catch {
        currentUrl = await this._tab?.url?.();
      }
      if (currentUrl && matcher.test(currentUrl)) return;
      await new Promise((resolve) => setTimeout(resolve, sleepMs));
    }
    throw new TimeoutError(`waitForURL('${pattern}') timed out after ${timeoutMs}ms`, pattern, await this._tab?.url?.());
  }

  async expectNavigation(action, options = {}) {
    const timeoutMs = options.timeoutMs ?? options.timeout ?? 30000;
    let before;
    try {
      const info = await this._tab?.info?.();
      before = info?.url;
    } catch {
      before = await this._tab?.url?.();
    }

    await action();

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      let after;
      try {
        const info = await this._tab?.info?.();
        after = info?.url;
      } catch {
        after = await this._tab?.url?.();
      }
      if (after && after !== before) return { from: before, to: after };
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new TimeoutError(`expectNavigation timed out after ${timeoutMs}ms`, null, before);
  }

  locator(selector) {
    return new Locator({ transport: this._transport, safety: this._safety, tab: this._tab, target: { selector } });
  }

  frameLocator(selector) {
    return new FrameLocator({ transport: this._transport, safety: this._safety, tab: this._tab, frameSelectors: [selector] });
  }

  getByText(text, options = {}) {
    return new Locator({
      transport: this._transport,
      safety: this._safety,
      tab: this._tab,
      target: { text, textMatcher: normalizeTextMatcher(text, options) },
    });
  }

  getByRole(role, options = {}) {
    return new Locator({
      transport: this._transport,
      safety: this._safety,
      tab: this._tab,
      target: { selector: roleSelector(role), role, text: options.name },
    });
  }

  getByLabel(label, options = {}) {
    const matcher = normalizeTextMatcher(label, options);
    if (matcher.kind === "regex" || matcher.kind === "contains") {
      return new Locator({
        transport: this._transport,
        safety: this._safety,
        tab: this._tab,
        target: { selector: "[aria-label]", textMatcher: matcher },
      });
    }
    const escaped = cssStringEscape(matcher.text);
    return new Locator({
      transport: this._transport,
      safety: this._safety,
      tab: this._tab,
      target: { selector: `[aria-label="${escaped}"]`, label: matcher.text, textMatcher: matcher },
    });
  }

  getByPlaceholder(placeholder, options = {}) {
    const matcher = normalizeTextMatcher(placeholder, options);
    if (matcher.kind === "regex" || matcher.kind === "contains") {
      return new Locator({
        transport: this._transport,
        safety: this._safety,
        tab: this._tab,
        target: { selector: "[placeholder]", textMatcher: matcher },
      });
    }
    const escaped = cssStringEscape(matcher.text);
    return this.locator(`[placeholder="${escaped}"]`);
  }

  getByTestId(testId) {
    const escaped = String(testId).replaceAll('"', '\\"');
    return this.locator(`[data-testid="${escaped}"], [data-test-id="${escaped}"], [data-test="${escaped}"]`);
  }

  async fillForm(fields, options = {}) {
    await this._safety?.confirm({
      type: "fillForm",
      fields,
      safety: options.safety,
    });
    const { safety, ...commandOptions } = options;
    return this._transport.command("action_fill_form", {
      fields,
      ...commandOptions,
    });
  }

  async _evalBoolean(script) {
    try {
      const raw = await this._transport.command("script_evaluate", { expression: script, awaitPromise: false, timeout: 5000 });
      if (typeof raw === "boolean") return raw;
      if (raw && typeof raw === "object" && typeof raw.result === "boolean") return raw.result;
    } catch {
      // ignore
    }
    return undefined;
  }
}

class FrameLocator {
  constructor({ transport, safety, tab, frameSelectors = [] }) {
    this._transport = transport;
    this._safety = safety;
    this._tab = tab;
    this._frameSelectors = frameSelectors;
  }

  frameLocator(selector) {
    return new FrameLocator({
      transport: this._transport,
      safety: this._safety,
      tab: this._tab,
      frameSelectors: [...this._frameSelectors, selector],
    });
  }

  locator(selector, options = {}) {
    return new Locator({
      transport: this._transport,
      safety: this._safety,
      tab: this._tab,
      target: { selector, frameContext: this._frameSelectors },
    });
  }

  getByText(text, options = {}) {
    const matcher = normalizeTextMatcher(text, options);
    return new Locator({
      transport: this._transport,
      safety: this._safety,
      tab: this._tab,
      target: { selector: "*", text: typeof text === "string" ? text : undefined, textMatcher: matcher, frameContext: this._frameSelectors },
    });
  }

  getByRole(role, options = {}) {
    return new Locator({
      transport: this._transport,
      safety: this._safety,
      tab: this._tab,
      target: { selector: roleSelector(role), role, text: options.name, frameContext: this._frameSelectors },
    });
  }

  getByLabel(label, options = {}) {
    const matcher = normalizeTextMatcher(label, options);
    if (matcher.kind === "regex" || matcher.kind === "contains") {
      return new Locator({
        transport: this._transport,
        safety: this._safety,
        tab: this._tab,
        target: { selector: "[aria-label]", textMatcher: matcher, frameContext: this._frameSelectors },
      });
    }
    const escaped = cssStringEscape(matcher.text);
    return new Locator({
      transport: this._transport,
      safety: this._safety,
      tab: this._tab,
      target: { selector: `[aria-label="${escaped}"]`, label: matcher.text, textMatcher: matcher, frameContext: this._frameSelectors },
    });
  }

  getByPlaceholder(placeholder, options = {}) {
    const matcher = normalizeTextMatcher(placeholder, options);
    if (matcher.kind === "regex" || matcher.kind === "contains") {
      return new Locator({
        transport: this._transport,
        safety: this._safety,
        tab: this._tab,
        target: { selector: "[placeholder]", textMatcher: matcher, frameContext: this._frameSelectors },
      });
    }
    const escaped = cssStringEscape(matcher.text);
    return new Locator({
      transport: this._transport,
      safety: this._safety,
      tab: this._tab,
      target: { selector: `[placeholder="${escaped}"]`, frameContext: this._frameSelectors },
    });
  }

  getByTestId(testId) {
    const escaped = String(testId).replaceAll('"', '\\"');
    return new Locator({
      transport: this._transport,
      safety: this._safety,
      tab: this._tab,
      target: {
        selector: `[data-testid="${escaped}"], [data-test-id="${escaped}"], [data-test="${escaped}"]`,
        frameContext: this._frameSelectors,
      },
    });
  }
}

function formatDomSnapshot(raw = {}) {
  const lines = [];
  lines.push(`# ${raw.title || "Page"}`);
  lines.push(`- URL: ${raw.url || ""}`);
  lines.push("");

  const section = (title, items, formatter) => {
    if (!Array.isArray(items) || items.length === 0) return;
    lines.push(`## ${title}`);
    for (const item of items.slice(0, 50)) {
      lines.push(`- ${formatter(item)}`);
    }
    lines.push("");
  };

  section("Headings", raw.headings, (h) => `${h.tag}: ${h.text || ""}`);
  section("Buttons", raw.buttons, (b) => `${b.text || ""}${b.visible === false ? " (hidden)" : ""}`);
  section("Inputs", raw.inputs, (i) => `${i.tag}${i.type ? `[type=${i.type}]` : ""}${i.name ? ` name="${i.name}"` : ""}${i.placeholder ? ` placeholder="${i.placeholder}"` : ""}`);
  section("Links", raw.linksDetailed, (l) => `${l.text || ""} → ${l.href || ""}`);

  if (raw.forms !== undefined || raw.tables !== undefined || raw.links !== undefined || raw.images !== undefined) {
    lines.push("## Summary");
    if (raw.forms !== undefined) lines.push(`- Forms: ${raw.forms}`);
    if (raw.tables !== undefined) lines.push(`- Tables: ${raw.tables}`);
    if (raw.links !== undefined) lines.push(`- Links: ${raw.links}`);
    if (raw.images !== undefined) lines.push(`- Images: ${raw.images}`);
    lines.push("");
  }

  if (raw.summary) {
    lines.push(`> ${raw.summary}`);
  }

  return lines.join("\n").trim();
}

function globToRegex(pattern) {
  const escaped = String(pattern)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "<<<DOUBLESTAR>>>")
    .replace(/\*/g, "[^/]*")
    .replace(/<<<DOUBLESTAR>>>/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

class FileChooser {
  constructor({ transport, safety, selector }) {
    this._transport = transport;
    this._safety = safety;
    this.selector = selector;
  }

  async setFiles(paths, options = {}) {
    const selector = options.selector || this.selector;
    if (!selector) {
      throw new Error("filechooser.setFiles requires a selector because Link2Chrome cannot observe native file chooser events yet");
    }
    const normalizedPaths = Array.isArray(paths) ? paths : [paths];
    await this._safety?.confirm({
      type: "filechooser.setFiles",
      target: { selector },
      paths: normalizedPaths,
      safety: options.safety,
    });
    const { safety, ...commandOptions } = options;
    return this._transport.command("upload_file", {
      selector,
      paths: normalizedPaths,
      ...commandOptions,
    });
  }
}

class Locator {
  constructor({ transport, safety, tab, target }) {
    this._transport = transport;
    this._safety = safety;
    this._tab = tab;
    this.target = target;
  }

  _hasFrameContext() {
    return Array.isArray(this.target.frameContext) && this.target.frameContext.length > 0;
  }

  _frameSelectors() {
    return this.target.frameContext || [];
  }

  _withFrameContext(args = {}) {
    if (this._hasFrameContext()) {
      return { ...args, frameContext: this._frameSelectors() };
    }
    return args;
  }

  first() {
    return this.nth(0);
  }

  last() {
    return new Locator({
      transport: this._transport,
      safety: this._safety,
      tab: this._tab,
      target: { ...this.target, last: true },
    });
  }

  nth(index) {
    if (!Number.isInteger(index) || index < 0) {
      throw new RangeError("locator.nth(index) requires a non-negative integer");
    }
    return new Locator({
      transport: this._transport,
      safety: this._safety,
      tab: this._tab,
      target: { ...this.target, index },
    });
  }

  and(other) {
    const otherSelector = other?.target?.selector;
    if (!this.target.selector || !otherSelector) {
      return this;
    }
    return new Locator({
      transport: this._transport,
      safety: this._safety,
      tab: this._tab,
      target: { ...this.target, selector: `:is(${this.target.selector}):is(${otherSelector})` },
    });
  }

  or(other) {
    const otherSelector = other?.target?.selector;
    if (!this.target.selector || !otherSelector) {
      return this;
    }
    return new Locator({
      transport: this._transport,
      safety: this._safety,
      tab: this._tab,
      target: { ...this.target, selector: `:is(${this.target.selector}, ${otherSelector})` },
    });
  }

  filter(options = {}) {
    const next = { ...this.target };
    if (options.hasText !== undefined) {
      next.text = options.hasText;
      next.textMatcher = normalizeTextMatcher(options.hasText);
    }
    if (options.hasNotText !== undefined) {
      next.hasNotText = options.hasNotText;
      next.hasNotTextMatcher = normalizeTextMatcher(options.hasNotText);
    }
    if (options.has !== undefined) {
      const hasSelector = options.has?.target?.selector || String(options.has);
      next.has = hasSelector;
    }
    if (options.hasNot !== undefined) {
      const hasNotSelector = options.hasNot?.target?.selector || String(options.hasNot);
      next.hasNot = hasNotSelector;
    }
    if (options.visible === true) {
      next.visibleOnly = true;
    }
    if (options.visible === false) {
      next.hiddenOnly = true;
    }
    if (Object.keys(next).length === Object.keys(this.target).length) {
      return this;
    }
    return new Locator({
      transport: this._transport,
      safety: this._safety,
      tab: this._tab,
      target: next,
    });
  }

  async count() {
    const matcher = this._textMatcher();
    if (this.target.has || this.target.hasNot || this.target.visibleOnly || this.target.hiddenOnly || this.target.hasNotText !== undefined) {
      return this._countWithScriptEvaluate();
    }
    if (matcher && !this.target.selector) {
      if (matcher.kind === "contains") {
        const raw = await this._transport.command("browser.dom.search", this._withFrameContext({ query: matcher.text }));
        return (raw.matches || raw.elements || []).length;
      }
      const raw = await this._queryTextMatches(matcher);
      return locatorElements(raw).filter((element) => locatorTextMatches(element, matcher)).length;
    }
    const raw = await this._transport.command("browser.dom.query", this._withFrameContext({
      selector: this.target.selector,
      limit: 100,
      ...(matcher ? { attributes: ["text", "ariaLabel"] } : {}),
    }));
    const elements = locatorElements(raw);
    if (matcher) {
      return elements.filter((element) => locatorTextMatches(element, matcher)).length;
    }
    return elements.length || Number(raw.count || 0);
  }

  async _countWithScriptEvaluate() {
    const selector = this.target.selector || "*";
    const has = this.target.has || "";
    const hasNot = this.target.hasNot || "";
    const visibleOnly = this.target.visibleOnly || false;
    const hiddenOnly = this.target.hiddenOnly || false;
    const hasNotTextMatcher = this.target.hasNotTextMatcher || null;
    const hasNotText = hasNotTextMatcher
      ? (hasNotTextMatcher.kind === "regex"
        ? { kind: "regex", source: hasNotTextMatcher.source, flags: hasNotTextMatcher.flags }
        : { kind: hasNotTextMatcher.kind, text: hasNotTextMatcher.text })
      : null;
    const script = `
      (function() {
        const nodes = document.querySelectorAll(${JSON.stringify(selector)});
        let count = 0;
        for (const el of nodes) {
          ${has ? `if (!el.querySelector(${JSON.stringify(has)})) continue;` : ""}
          ${hasNot ? `if (el.querySelector(${JSON.stringify(hasNot)})) continue;` : ""}
          ${visibleOnly ? `
            const r = el.getBoundingClientRect();
            const st = getComputedStyle(el);
            if (r.width === 0 || r.height === 0 || st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') continue;
          ` : ""}
          ${hiddenOnly ? `
            const r = el.getBoundingClientRect();
            const st = getComputedStyle(el);
            if (!(r.width === 0 || r.height === 0 || st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0')) continue;
          ` : ""}
          ${hasNotText ? `
            const text = (el.textContent || "").replace(/\\s+/g, " ").trim().toLowerCase();
            ${hasNotText.kind === "regex"
              ? `if (new RegExp(${JSON.stringify(hasNotText.source)}, ${JSON.stringify(hasNotText.flags || "")}).test(text)) continue;`
              : hasNotText.kind === "exact"
                ? `if (text === ${JSON.stringify(hasNotText.text.toLowerCase())}) continue;`
                : `if (text.includes(${JSON.stringify(hasNotText.text.toLowerCase())})) continue;`
            }
          ` : ""}
          count++;
        }
        return count;
      })()
    `;
    if (this._hasFrameContext()) {
      const raw = await this._transport.command("frame_evaluate", { frameSelectors: this._frameSelectors(), script });
      if (typeof raw === "number") return raw;
      if (raw && typeof raw === "object" && typeof raw.result === "number") return raw.result;
      return 0;
    }
    const raw = await this._transport.command("script_evaluate", { expression: script });
    if (typeof raw === "number") return raw;
    if (raw && typeof raw === "object" && typeof raw.result === "number") return raw.result;
    return 0;
  }

  async click(options = {}) {
    await this._strictCheck(options);
    const target = await this._resolveTarget();
    await this._safety?.confirm({
      type: "click",
      target,
      safety: options.safety,
    });
    const { safety, strict, ...commandOptions } = options;
    return this._transport.command("browser.dom.click", this._withFrameContext({ target, ...commandOptions }));
  }

  async fill(text, options = {}) {
    await this._strictCheck(options);
    const target = await this._resolveTarget();
    await this._safety?.confirm({
      type: "fill",
      target,
      text,
      safety: options.safety,
    });
    return this._transport.command("browser.dom.type", this._withFrameContext({
      ...targetToTypeArgs(target),
      text,
      clearFirst: options.clearFirst ?? true,
    }));
  }

  async hover(options = {}) {
    await this._strictCheck(options);
    const target = await this._resolveTarget();
    const { strict, ...commandOptions } = options;
    return this._transport.command("action_hover", this._withFrameContext({
      target,
      ...commandOptions,
    }));
  }

  async press(key, options = {}) {
    await this._strictCheck(options);
    const target = await this._resolveTarget();
    await this._safety?.confirm({
      type: "press",
      target,
      key,
      safety: options.safety,
    });
    const { safety, strict, ...commandOptions } = options;
    return this._transport.command("action_press_key", this._withFrameContext({
      target,
      key,
      ...commandOptions,
    }));
  }

  async selectOption(value, options = {}) {
    await this._strictCheck(options);
    const target = await this._resolveTarget();
    await this._safety?.confirm({
      type: "selectOption",
      target,
      value,
      safety: options.safety,
    });
    const { safety, strict, ...commandOptions } = options;
    return this._transport.command("action_select", this._withFrameContext({
      target,
      value,
      ...commandOptions,
    }));
  }

  async check(options = {}) {
    return this.setChecked(true, options);
  }

  async uncheck(options = {}) {
    return this.setChecked(false, options);
  }

  async setChecked(checked, options = {}) {
    await this._strictCheck(options);
    const target = await this._resolveTarget();
    await this._safety?.confirm({
      type: checked ? "check" : "uncheck",
      target,
      safety: options.safety,
    });
    const { safety, strict, ...commandOptions } = options;
    const script = `
      (function() {
        const el = document.querySelector(${JSON.stringify(target.selector)});
        if (!el) throw new Error('Element not found: ${target.selector}');
        if (el.tagName !== 'INPUT' || (el.type !== 'checkbox' && el.type !== 'radio')) {
          throw new Error('Element is not a checkbox or radio: ' + el.tagName);
        }
        el.checked = ${checked};
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return el.checked;
      })()
    `;
    if (this._hasFrameContext()) {
      return this._transport.command("frame_evaluate", { frameSelectors: this._frameSelectors(), script, ...commandOptions });
    }
    return this._transport.command("script_evaluate", { expression: script, ...commandOptions });
  }

  async dblclick(options = {}) {
    await this._strictCheck(options);
    const target = await this._resolveTarget();
    await this._safety?.confirm({
      type: "dblclick",
      target,
      safety: options.safety,
    });
    const { safety, strict, ...commandOptions } = options;
    return this._transport.command("browser.dom.click", this._withFrameContext({
      target,
      clickCount: 2,
      ...commandOptions,
    }));
  }

  async waitFor(options = {}) {
    const state = options.state || "visible";
    const allowedStates = ["attached", "detached", "visible", "hidden"];
    if (!allowedStates.includes(state)) {
      throw new Error(`Locator.waitFor state must be one of ${allowedStates.join(", ")}, got: ${state}`);
    }
    const args = this._withFrameContext({
      condition: options.condition || "dom-ready",
      selector: this.target.selector,
      state,
      ...options,
    });
    if (args.timeoutMs === undefined && args.timeout === undefined) {
      args.timeoutMs = 30000;
    }
    return this._transport.command("browser.wait", args);
  }

  async setFiles(paths, options = {}) {
    await this._strictCheck(options);
    const normalizedPaths = Array.isArray(paths) ? paths : [paths];
    await this._safety?.confirm({
      type: "filechooser.setFiles",
      target: this.target,
      paths: normalizedPaths,
      safety: options.safety,
    });
    const { safety, strict, ...commandOptions } = options;
    return this._transport.command("upload_file", this._withFrameContext({
      selector: this.target.selector,
      paths: normalizedPaths,
      ...commandOptions,
    }));
  }

  async textContent() {
    if (this.target.text && !this.target.selector) {
      return this.target.text;
    }
    const selector = await this._resolveSelector();
    const raw = await this._transport.command("browser.dom.query", this._withFrameContext({
      selector,
      limit: 1,
      attributes: ["text"],
    }));
    const first = locatorElements(raw)[0];
    return first?.text || first?.textContent || "";
  }

  async allTextContents() {
    if (this.target.text && !this.target.selector) {
      return [this.target.text];
    }
    const raw = await this._transport.command("browser.dom.query", this._withFrameContext({
      selector: this.target.selector,
      limit: 100,
      attributes: ["text", "ariaLabel"],
    }));
    return locatorElements(raw)
      .map((element) => element.text ?? element.textContent ?? element.ariaLabel ?? "")
      .filter((text) => text !== "");
  }

  async getAttribute(name) {
    const selector = await this._resolveSelector();
    const raw = await this._transport.command("browser.dom.query", this._withFrameContext({
      selector,
      limit: 1,
      attributes: [name],
    }));
    const first = locatorElements(raw)[0];
    return first?.[name] ?? null;
  }

  async inputValue() {
    return this.getAttribute("value");
  }

  async isVisible() {
    const selector = await this._resolveSelector();
    const detail = await this._transport.command("dom_element_detail", this._withFrameContext({
      selector,
      include: ["position"],
    }));
    return Boolean(detail.ok && detail.position?.visible);
  }

  async isEnabled() {
    const selector = await this._resolveSelector();
    const detail = await this._transport.command("dom_element_detail", this._withFrameContext({
      selector,
      include: ["position", "accessibility"],
    }));
    return Boolean(detail.ok && detail.position?.visible && detail.accessibility?.focusable);
  }

  async boundingBox() {
    const selector = await this._resolveSelector();
    const detail = await this._transport.command("dom_element_detail", this._withFrameContext({
      selector,
      include: ["position"],
    }));
    if (!detail.ok || !detail.position?.visible) return null;
    const { x, y, width, height } = detail.position;
    return { x, y, width, height };
  }

  async innerText(options = {}) {
    if (this.target.text && !this.target.selector) {
      return this.target.text;
    }
    const selector = await this._resolveSelector();
    const script = `
      (function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        return el ? el.innerText : "";
      })()
    `;
    if (this._hasFrameContext()) {
      const raw = await this._transport.command("frame_evaluate", { frameSelectors: this._frameSelectors(), script, timeout: options.timeoutMs ?? options.timeout ?? 30000 });
      if (typeof raw === "string") return raw;
      if (raw && typeof raw === "object" && typeof raw.result === "string") return raw.result;
      return String(raw ?? "");
    }
    const raw = await this._transport.command("script_evaluate", {
      expression: script,
      awaitPromise: false,
      timeout: options.timeoutMs ?? options.timeout ?? 30000,
    });
    if (typeof raw === "string") return raw;
    if (raw && typeof raw === "object" && typeof raw.result === "string") return raw.result;
    return String(raw ?? "");
  }

  async type(text, options = {}) {
    await this._strictCheck(options);
    const target = await this._resolveTarget();
    await this._safety?.confirm({
      type: "type",
      target,
      text,
      safety: options.safety,
    });
    return this._transport.command("browser.dom.type", this._withFrameContext({
      ...targetToTypeArgs(target),
      text,
      clearFirst: false,
    }));
  }

  async all() {
    const count = await this.count();
    return Array.from({ length: count }, (_, i) => this.nth(i));
  }

  async downloadMedia(options = {}) {
    await this._strictCheck(options);
    const target = await this._resolveTarget();
    const script = `
      (function() {
        const el = document.querySelector(${JSON.stringify(target.selector)});
        if (!el) throw new Error('Element not found: ${target.selector}');
        const url = el.src || el.href || '';
        if (!url) throw new Error('Element has no src or href');
        return url;
      })()
    `;
    const getUrl = this._hasFrameContext()
      ? await this._transport.command("frame_evaluate", { frameSelectors: this._frameSelectors(), script, timeout: options.timeoutMs ?? options.timeout ?? 30000 })
      : await this._transport.command("script_evaluate", { expression: script, awaitPromise: false, timeout: options.timeoutMs ?? options.timeout ?? 30000 });
    const resolvedUrl = typeof getUrl === "string" ? getUrl : (getUrl?.result || "");
    if (!resolvedUrl) throw new Error("downloadMedia: element has no src or href");

    const downloadScript = `
      (function() {
        const a = document.createElement('a');
        a.href = ${JSON.stringify(resolvedUrl)};
        a.download = ${JSON.stringify(options.suggestedFilename || "")};
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        return true;
      })()
    `;
    if (this._hasFrameContext()) {
      await this._transport.command("frame_evaluate", { frameSelectors: this._frameSelectors(), script: downloadScript, timeout: 10000 });
    } else {
      await this._transport.command("script_evaluate", { expression: downloadScript, awaitPromise: false, timeout: 10000 });
    }
    return { url: resolvedUrl, suggestedFilename: options.suggestedFilename || null };
  }

  locator(selector, options = {}) {
    const childSelector = String(selector);
    const nextTarget = {
      ...(this.target.selector ? { selector: `${this.target.selector} ${childSelector}` } : { selector: childSelector }),
      ...(this.target.index !== undefined ? { index: this.target.index } : {}),
      ...(this.target.last ? { last: this.target.last } : {}),
      ...(this.target.has ? { has: this.target.has } : {}),
      ...(this.target.hasNot ? { hasNot: this.target.hasNot } : {}),
      ...(this.target.visibleOnly ? { visibleOnly: this.target.visibleOnly } : {}),
      ...(this.target.hiddenOnly ? { hiddenOnly: this.target.hiddenOnly } : {}),
      ...(this.target.hasNotText !== undefined ? { hasNotText: this.target.hasNotText, hasNotTextMatcher: this.target.hasNotTextMatcher } : {}),
      ...(this.target.frameContext ? { frameContext: this.target.frameContext } : {}),
    };

    if (options.hasText !== undefined) {
      nextTarget.text = options.hasText;
      nextTarget.textMatcher = normalizeTextMatcher(options.hasText);
    }
    if (options.hasNotText !== undefined) {
      nextTarget.hasNotText = options.hasNotText;
      nextTarget.hasNotTextMatcher = normalizeTextMatcher(options.hasNotText);
    }
    if (options.has !== undefined) {
      const hasSelector = options.has?.target?.selector || String(options.has);
      nextTarget.has = hasSelector;
    }
    if (options.hasNot !== undefined) {
      const hasNotSelector = options.hasNot?.target?.selector || String(options.hasNot);
      nextTarget.hasNot = hasNotSelector;
    }

    return new Locator({
      transport: this._transport,
      safety: this._safety,
      tab: this._tab,
      target: nextTarget,
    });
  }

  getByText(text, options = {}) {
    const matcher = normalizeTextMatcher(text, options);
    const baseSelector = this.target.selector || "*";
    return new Locator({
      transport: this._transport,
      safety: this._safety,
      tab: this._tab,
      target: {
        selector: `${baseSelector} *`,
        text: typeof text === "string" ? text : undefined,
        textMatcher: matcher,
        ...(this.target.frameContext ? { frameContext: this.target.frameContext } : {}),
      },
    });
  }

  getByRole(role, options = {}) {
    const baseSelector = this.target.selector || "*";
    return new Locator({
      transport: this._transport,
      safety: this._safety,
      tab: this._tab,
      target: {
        selector: `${baseSelector} ${roleSelector(role)}`,
        role,
        text: options.name,
        ...(this.target.frameContext ? { frameContext: this.target.frameContext } : {}),
      },
    });
  }

  getByLabel(label, options = {}) {
    const matcher = normalizeTextMatcher(label, options);
    const baseSelector = this.target.selector || "*";
    if (matcher.kind === "regex" || matcher.kind === "contains") {
      return new Locator({
        transport: this._transport,
        safety: this._safety,
        tab: this._tab,
        target: {
          selector: `${baseSelector} [aria-label]`,
          textMatcher: matcher,
          ...(this.target.frameContext ? { frameContext: this.target.frameContext } : {}),
        },
      });
    }
    const escaped = cssStringEscape(matcher.text);
    return new Locator({
      transport: this._transport,
      safety: this._safety,
      tab: this._tab,
      target: {
        selector: `${baseSelector} [aria-label="${escaped}"]`,
        label: matcher.text,
        textMatcher: matcher,
        ...(this.target.frameContext ? { frameContext: this.target.frameContext } : {}),
      },
    });
  }

  getByPlaceholder(placeholder, options = {}) {
    const matcher = normalizeTextMatcher(placeholder, options);
    const baseSelector = this.target.selector || "*";
    if (matcher.kind === "regex" || matcher.kind === "contains") {
      return new Locator({
        transport: this._transport,
        safety: this._safety,
        tab: this._tab,
        target: {
          selector: `${baseSelector} [placeholder]`,
          textMatcher: matcher,
          ...(this.target.frameContext ? { frameContext: this.target.frameContext } : {}),
        },
      });
    }
    const escaped = cssStringEscape(matcher.text);
    return new Locator({
      transport: this._transport,
      safety: this._safety,
      tab: this._tab,
      target: {
        selector: `${baseSelector} [placeholder="${escaped}"]`,
        ...(this.target.frameContext ? { frameContext: this.target.frameContext } : {}),
      },
    });
  }

  getByTestId(testId) {
    const escaped = String(testId).replaceAll('"', '\\"');
    const baseSelector = this.target.selector || "*";
    return new Locator({
      transport: this._transport,
      safety: this._safety,
      tab: this._tab,
      target: {
        selector: `${baseSelector} [data-testid="${escaped}"], ${baseSelector} [data-test-id="${escaped}"], ${baseSelector} [data-test="${escaped}"]`,
        ...(this.target.frameContext ? { frameContext: this.target.frameContext } : {}),
      },
    });
  }

  async _resolveSelector() {
    if (!this._needsResolvedTarget()) return this.target.selector;
    return (await this._resolveTarget()).selector;
  }

  async _strictCheck(options = {}) {
    if (options.strict === false) return;
    // User explicitly narrowed with nth() or last() — respect that choice
    if (this.target.index !== undefined || this.target.last) return;
    let count;
    try {
      count = await this.count();
    } catch {
      return;
    }
    if (count === 0) {
      try {
        const raw = await this._transport.command("browser.dom.query", {
          selector: this.target.selector,
          limit: 1,
          ...(this.target.text ? { attributes: ["text", "ariaLabel"] } : {}),
        });
        const hasValidResponse = raw && (
          Array.isArray(raw.results) || Array.isArray(raw.elements) || Array.isArray(raw.matches) || typeof raw.count === "number"
        );
        if (!hasValidResponse) return; // fake or unsupported transport, skip strict check
      } catch {
        return;
      }
      throw new LocatorNotFoundError(this.target.selector || this.target.text, await this._tab?.url?.());
    }
    if (count > 1) {
      throw new StrictModeError(this.target.selector || this.target.text, await this._tab?.url?.(), count);
    }
  }

  async _resolveTarget() {
    if (!this._needsResolvedTarget()) return this.target;
    const matcher = this._textMatcher();
    const hasNotTextMatcher = this.target.hasNotTextMatcher || null;
    const raw = await this._queryResolvableElements(matcher);
    let elements = matcher
      ? locatorElements(raw).filter((element) => locatorTextMatches(element, matcher))
      : locatorElements(raw);
    if (hasNotTextMatcher) {
      elements = elements.filter((element) => !locatorTextMatches(element, hasNotTextMatcher));
    }
    const index = this.target.index ?? 0;
    const element = this.target.last ? elements.at(-1) : elements[index];
    if (!element) {
      const selector = this.target.selector || this.target.text || String(this.target);
      throw new LocatorNotFoundError(selector, await this._tab?.url?.());
    }
    return {
      ...(element.selector ? { selector: element.selector } : this.target),
      ...(this.target.text ? { text: this.target.text } : {}),
      ...(this._hasFrameContext() ? { frameContext: this.target.frameContext } : {}),
    };
  }

  _needsResolvedTarget() {
    const matcher = this._textMatcher();
    return this.target.index !== undefined
      || this.target.last
      || (matcher && matcher.kind !== "contains")
      || this.target.hasNotText !== undefined
      || this.target.hiddenOnly;
  }

  _textMatcher() {
    if (this.target.text === undefined) return null;
    return this.target.textMatcher || normalizeTextMatcher(this.target.text);
  }

  _queryTextMatches(matcher) {
    if (matcher.kind === "exact") {
      return this._transport.command("browser.dom.search", this._withFrameContext({ query: matcher.text, limit: 100 }));
    }
    return this._transport.command("browser.dom.query", this._withFrameContext({
      selector: "*",
      limit: 100,
      attributes: ["text", "ariaLabel"],
    }));
  }

  _queryResolvableElements(matcher) {
    if (this.target.selector) {
      const limit = matcher || this.target.last ? 100 : (this.target.index ?? 0) + 1;
      return this._transport.command("browser.dom.query", this._withFrameContext({
        selector: this.target.selector,
        limit,
        attributes: matcher ? ["text", "ariaLabel"] : ["text"],
      }));
    }
    if (matcher) {
      return this._queryTextMatches(matcher);
    }
    return this._transport.command("browser.dom.search", this._withFrameContext({
      query: this.target.text,
      limit: this.target.last ? 100 : (this.target.index ?? 0) + 1,
    }));
  }
}

function locatorElements(raw = {}) {
  return raw.elements || raw.matches || raw.results || [];
}

function normalizeTextMatcher(value, options = {}) {
  if (value instanceof RegExp) {
    return { kind: "regex", source: value.source, flags: value.flags };
  }
  const text = String(value ?? "");
  return options.exact ? { kind: "exact", text } : { kind: "contains", text };
}

function locatorTextMatches(element, matcher) {
  const text = locatorElementText(element);
  if (matcher.kind === "exact") {
    return normalizeLocatorText(text) === normalizeLocatorText(matcher.text);
  }
  if (matcher.kind === "regex") {
    return new RegExp(matcher.source, matcher.flags).test(text);
  }
  return normalizeLocatorText(text).includes(normalizeLocatorText(matcher.text));
}

function locatorElementText(element = {}) {
  return String(element.text || element.textContent || element.ariaLabel || element.name || "");
}

function normalizeLocatorText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

class CuaSurface {
  constructor({ tab, transport, safety }) {
    this._tab = tab;
    this._transport = transport;
    this._safety = safety;
  }

  async screenshot(options = {}) {
    return this._transport.command("browser.cua.screenshot", options);
  }

  async click(x, y, options = {}) {
    // Codex 风格：click({ x, y, button?, keypress? })
    if (typeof x === "object" && x !== null) {
      const original = x;
      options = y || {};
      y = original.y;
      x = original.x;
      const { x: _x, y: _y, ...rest } = original;
      options = { ...rest, ...options };
    }
    await this._safety?.confirm({ type: "cua.click", target: { x, y }, safety: options.safety });
    const { safety, button: rawButton, keypress, ...commandOptions } = options;
    // button 数值映射（1-left, 2-middle, 3-right, 4-back, 5-forward）
    let button = rawButton;
    if (typeof button === "number") {
      const map = { 1: "left", 2: "middle", 3: "right", 4: "back", 5: "forward" };
      button = map[button] || "left";
    }
    return this._transport.command("browser.cua.click", omitUndefined({
      x,
      y,
      button,
      keypress,
      ...commandOptions,
    }));
  }

  async double_click(options = {}) {
    // Codex 风格：double_click({ x, y, keypress? })
    if (typeof options === "object" && options !== null) {
      const { x, y, keypress, ...rest } = options;
      return this._transport.command("browser.cua.double_click", { x, y, keypress, ...rest });
    }
    return this._transport.command("browser.cua.double_click", { x: options, y: arguments[1] });
  }

  // 别名
  async doubleClick(x, y) {
    return this.double_click({ x, y });
  }

  async move(x, y, options = {}) {
    // Codex 风格：move({ x, y, keys? })
    if (typeof x === "object" && x !== null) {
      const original = x;
      options = y || {};
      y = original.y;
      x = original.x;
      const { x: _x, y: _y, ...rest } = original;
      options = { ...rest, ...options };
    }
    const { safety, keys, ...commandOptions } = options;
    return this._transport.command("browser.cua.move", { x, y, keys, ...commandOptions });
  }

  async type(text, options = {}) {
    // Codex 风格：type({ text })
    if (typeof text === "object" && text !== null) {
      const original = text;
      options = { ...original, ...options };
      text = original.text;
    }
    await this._safety?.confirm({ type: "cua.type", text, safety: options.safety });
    const { safety, ...commandOptions } = options;
    return this._transport.command("browser.cua.type", { text, ...commandOptions });
  }

  async keypress(options = {}) {
    // Codex 风格：keypress({ keys: string[] })
    if (typeof options === "object" && options !== null && Array.isArray(options.keys)) {
      const combo = options.keys.join("+");
      return this.key(combo, options);
    }
    if (typeof options === "string") {
      return this.key(options, arguments[1]);
    }
    throw new TypeError("keypress requires an object with keys array");
  }

  async key(combo, options = {}) {
    await this._safety?.confirm({ type: "cua.key", key: combo, safety: options.safety });
    const { safety, ...commandOptions } = options;
    return this._transport.command("browser.cua.key", { combo, ...commandOptions });
  }

  async scroll(dx = 0, dy = 500, options = {}) {
    // Codex 风格：scroll({ x, y, scrollX, scrollY, keypress? })
    if (typeof dx === "object" && dx !== null) {
      const { x, y, scrollX, scrollY, keypress, ...rest } = dx;
      return this._transport.command("browser.cua.scroll", {
        x: x || 0,
        y: y || 0,
        dx: scrollX || 0,
        dy: scrollY ?? 500,
        keypress,
        ...rest,
      });
    }
    // 旧签名兼容：scroll(dx, dy, options)
    if (typeof dy === "object" && dy !== null) {
      options = dy;
      dy = 500;
    }
    return this._transport.command("browser.cua.scroll", { dx, dy, ...options });
  }

  async drag(x1, y1, x2, y2, options = {}) {
    // Codex 风格：drag({ path: [{x,y},...], keys? })
    if (typeof x1 === "object" && x1 !== null) {
      const { path, keys, ...rest } = x1;
      if (!Array.isArray(path) || path.length < 2) {
        throw new TypeError("drag requires a path array with at least 2 points");
      }
      const start = path[0];
      const end = path[path.length - 1];
      await this._safety?.confirm({
        type: "cua.drag",
        target: { x1: start.x, y1: start.y, x2: end.x, y2: end.y },
        safety: rest.safety,
      });
      const { safety, ...commandOptions } = rest;
      const args = {
        x1: start.x,
        y1: start.y,
        x2: end.x,
        y2: end.y,
        keys,
        ...commandOptions,
      };
      if (path.length > 2) {
        args.path = path;
      }
      return this._transport.command("browser.cua.drag", args);
    }
    // 旧签名兼容
    await this._safety?.confirm({
      type: "cua.drag",
      target: { x1, y1, x2, y2 },
      safety: options.safety,
    });
    const { safety, ...commandOptions } = options;
    return this._transport.command("browser.cua.drag", { x1, y1, x2, y2, ...commandOptions });
  }
}

class DomCuaSurface {
  constructor({ tab, transport, safety }) {
    this._tab = tab;
    this._transport = transport;
    this._safety = safety;
  }

  async get_visible_dom(options = {}) {
    return this._transport.command("browser.dom.overview", options);
  }

  // 别名
  async visibleDom(options = {}) {
    return this.get_visible_dom(options);
  }

  async query(selector, options = {}) {
    return this._transport.command("browser.dom.query", { selector, ...options });
  }

  async click(target, options = {}) {
    // Codex 风格：click({ node_id })
    if (typeof target === "object" && target !== null && target.node_id !== undefined) {
      const nodeTarget = { node_id: target.node_id };
      await this._safety?.confirm({
        type: "dom_cua.click",
        target: nodeTarget,
        safety: target.safety ?? options.safety,
      });
      const { safety, node_id, ...commandOptions } = target;
      return this._transport.command("browser.dom.click", {
        target: nodeTarget,
        ...commandOptions,
      });
    }
    // 旧签名兼容
    await this._safety?.confirm({
      type: "dom_cua.click",
      target,
      safety: options.safety,
    });
    const { safety, ...commandOptions } = options;
    return this._transport.command("browser.dom.click", { target, ...commandOptions });
  }

  async double_click(options = {}) {
    // Codex 风格：double_click({ node_id })
    if (typeof options === "object" && options !== null && options.node_id !== undefined) {
      const target = { node_id: options.node_id };
      await this._safety?.confirm({
        type: "dom_cua.double_click",
        target,
        safety: options.safety,
      });
      const { safety, node_id, ...commandOptions } = options;
      return this._transport.command("browser.dom.click", {
        target,
        clickCount: 2,
        ...commandOptions,
      });
    }
    throw new TypeError("double_click requires an object with node_id");
  }

  async keypress(options = {}) {
    // Codex 风格：keypress({ keys })
    if (typeof options === "object" && options !== null && Array.isArray(options.keys)) {
      const combo = options.keys.join("+");
      await this._safety?.confirm({
        type: "dom_cua.keypress",
        key: combo,
        safety: options.safety,
      });
      const { safety, keys, ...commandOptions } = options;
      return this._transport.command("browser.cua.key", { combo, ...commandOptions });
    }
    throw new TypeError("keypress requires an object with keys array");
  }

  async scroll(options = {}) {
    // Codex 风格：scroll({ node_id?, x, y })
    if (typeof options === "object" && options !== null) {
      const { node_id, x, y } = options;
      if (node_id !== undefined) {
        return this._transport.command("script_evaluate", {
          expression: `(function() {
            const el = document.querySelector('[data-link2chrome-node-id="${node_id}"]') || document.querySelector('[data-node-id="${node_id}"]') || document.getElementById(${JSON.stringify(node_id)});
            if (el && el.scrollBy) { el.scrollBy(${x || 0}, ${y || 0}); return true; }
            return false;
          })()`,
          awaitPromise: false,
        });
      }
      return this._transport.command("browser.cua.scroll", { dx: x || 0, dy: y ?? 500 });
    }
    throw new TypeError("scroll requires an options object");
  }

  async type(options = {}) {
    // Codex 风格：type({ text })
    if (typeof options === "object" && options !== null) {
      const text = options.text;
      await this._safety?.confirm({
        type: "dom_cua.type",
        text,
        safety: options.safety,
      });
      const { safety, ...commandOptions } = options;
      return this._transport.command("browser.cua.type", { text, ...commandOptions });
    }
    throw new TypeError("type requires an object with text property");
  }
}

class DevSurface {
  constructor({ tab, transport }) {
    this._tab = tab;
    this._transport = transport;
    this.console = new ConsoleDevSurface({ transport });
    this.network = new NetworkDevSurface({ transport });
  }

  // Codex TabDevAPI.logs(options): 读取该 tab 已捕获的 console 日志
  async logs(options = {}) {
    return this._transport.command("console_list", options);
  }
}

class ClipboardSurface {
  constructor({ tab, transport, safety }) {
    this._tab = tab;
    this._transport = transport;
    this._safety = safety;
  }

  async readText(options = {}) {
    return this._transport.command("browser.clipboard.readText", options);
  }

  async writeText(text, options = {}) {
    await this._safety?.confirm({
      type: "clipboard.writeText",
      text,
      safety: options.safety,
    });
    const { safety, ...commandOptions } = options;
    return this._transport.command("browser.clipboard.writeText", { text, ...commandOptions });
  }

  async read() {
    return this._transport.command("browser.clipboard.read", {});
  }

  async write(items) {
    await this._safety?.confirm({
      type: "clipboard.write",
      items,
    });
    return this._transport.command("browser.clipboard.write", { items });
  }
}

class DialogSurface {
  constructor({ tab, transport, safety }) {
    this._tab = tab;
    this._transport = transport;
    this._safety = safety;
  }

  async accept(options = {}) {
    await this._safety?.confirm({
      type: "dialog.accept",
      safety: options.safety,
    });
    const { safety, ...commandOptions } = options;
    return this._transport.command("handle_dialog", { action: "accept", ...commandOptions });
  }

  async dismiss(options = {}) {
    await this._safety?.confirm({
      type: "dialog.dismiss",
      safety: options.safety,
    });
    const { safety, ...commandOptions } = options;
    return this._transport.command("handle_dialog", { action: "dismiss", ...commandOptions });
  }
}

class ConsoleDevSurface {
  constructor({ transport }) {
    this._transport = transport;
  }

  async start(options = {}) {
    return this._transport.command("console_capture", { action: "start", ...options });
  }

  async stop(options = {}) {
    return this._transport.command("console_capture", { action: "stop", ...options });
  }

  async status(options = {}) {
    return this._transport.command("console_capture", { action: "status", ...options });
  }

  async list(options = {}) {
    return this._transport.command("console_list", options);
  }

  async get(id) {
    return this._transport.command("console_get", { id });
  }

  async clear() {
    return this._transport.command("console_clear", {});
  }
}

class NetworkDevSurface {
  constructor({ transport }) {
    this._transport = transport;
  }

  async start(options = {}) {
    return this._transport.command("network_capture", { action: "start", ...options });
  }

  async stop(options = {}) {
    return this._transport.command("network_capture", { action: "stop", ...options });
  }

  async status(options = {}) {
    return this._transport.command("network_capture", { action: "status", ...options });
  }

  async clear(options = {}) {
    return this._transport.command("network_capture", { action: "clear", ...options });
  }

  async list(options = {}) {
    return this._transport.command("network_list", options);
  }

  async query(options = {}) {
    return this._transport.command("network_query", options);
  }

  async fetch(options = {}) {
    return this._transport.command("network_fetch", options);
  }

  async replay(options = {}) {
    return this._transport.command("network_replay", options);
  }
}

class PageAssetsCapability {
  constructor({ tab, transport, safety }) {
    this._tab = tab;
    this._transport = transport;
    this._safety = safety;
  }

  async list() {
    return this._transport.command("page_assets_list", {});
  }

  async bundle({ outputDir } = {}) {
    if (!outputDir) {
      throw new Error("bundle requires outputDir");
    }
    const result = await this._transport.command("page_assets_bundle", {});
    const assets = Array.isArray(result) ? result : (result?.assets || []);
    const errors = Array.isArray(result) ? [] : (result?.errors || []);

    await mkdir(outputDir, { recursive: true });

    const seen = new Set();
    const files = [];

    for (const asset of assets) {
      const filename = this._dedupeFilename(this._extractFilename(asset.name || "resource"), seen);
      const filepath = join(outputDir, filename);
      const buf = Buffer.from(asset.base64 || "", "base64");
      await writeFile(filepath, buf);
      files.push(filepath);
    }

    return { outputDir, files, errors };
  }

  async documentation() {
    // 文档源在 runtime/docs/capabilities/tab/pageAssets.md（与 agent.documentation.get 同源）；
    // 读取失败时回退到内嵌精简版，保证离线/打包环境仍可用。
    try {
      const fileUrl = new URL("./docs/capabilities/tab/pageAssets.md", import.meta.url);
      return readFileSync(fileUrl, "utf-8");
    } catch {
      return `# pageAssets 能力

列举并打包当前页面已加载的资源。

## 方法

- \`await capability.list()\`
  返回当前页面已加载资源列表，每项包含 \`{ name, type, size }\`。

- \`await capability.bundle({ outputDir })\`
  将资源下载为 base64 并写入 \`outputDir\`（自动创建目录）。
  返回 \`{ outputDir, files: [路径数组], errors: [{ name, reason }] }\`。

## 示例

\`\`\`js
const cap = await tab.capabilities.get("pageAssets");
const list = await cap.list();
const { files, errors } = await cap.bundle({ outputDir: "/tmp/page-assets" });
\`\`\`
`;
    }
  }

  _extractFilename(name) {
    try {
      const url = new URL(name);
      const pathname = url.pathname;
      const base = pathname.split("/").pop() || "resource";
      return base.replace(/[<>:"/\\|?*]+/g, "_");
    } catch {
      return "resource";
    }
  }

  _dedupeFilename(filename, seen) {
    if (!seen.has(filename)) {
      seen.add(filename);
      return filename;
    }
    const ext = extname(filename);
    const base = basename(filename, ext);
    let counter = 1;
    let candidate = `${base}_${counter}${ext}`;
    while (seen.has(candidate)) {
      counter++;
      candidate = `${base}_${counter}${ext}`;
    }
    seen.add(candidate);
    return candidate;
  }
}

export function createDocumentationSurface() {
  const available = new Set([
    "api",
    "playwright",
    "screenshots",
    "confirmations",
    "file-management",
    "api-troubleshooting",
    "chrome-troubleshooting",
    "capabilities/tab/pageAssets",
  ]);
  return {
    async get(name) {
      if (!available.has(name)) {
        const availableStr = Array.from(available).join(", ");
        throw new Error(`Documentation "${name}" not found. Available: ${availableStr}`);
      }
      try {
        const fileUrl = new URL(`./docs/${name}.md`, import.meta.url);
        return readFileSync(fileUrl, "utf-8");
      } catch (error) {
        throw new Error(`Failed to read documentation "${name}": ${error?.message || error}`);
      }
    },
  };
}

registerTabCapability("pageAssets", "列举并打包当前页面已加载的资源", ({ tab, transport, safety }) => {
  return new PageAssetsCapability({ tab, transport, safety });
});
