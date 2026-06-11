import { spawn as defaultSpawn } from "node:child_process";
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
    documentation: {
      async get(name) {
        throw new Error("documentation 将在后续版本提供");
      },
    },
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
          documentation: {
            async get(name) {
              throw new Error("documentation 将在后续版本提供");
            },
          },
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

export function createWebSocketTransport({ url = "ws://localhost:8766", WebSocketImpl = globalThis.WebSocket } = {}) {
  let leaseToken = null;
  return {
    async acquireLease(name) {
      const lease = await sendHubCommand({
        url,
        WebSocketImpl,
        commandName: "__hub_acquire__",
        params: { name },
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
      const send = (commandName, params = {}) => sendHubCommand({ url, WebSocketImpl, commandName, params, leaseToken });
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
      if (name === "browser_navigate") return send("navigate", args);
      if (name === "browser.dom.overview") return send("dom_overview", args);
      if (name === "browser.dom.query") return send("dom_query", args);
      if (name === "browser.dom.search") return send("dom_search", args);
      if (name === "browser.dom.click") return send("action_click", args);
      if (name === "browser.dom.type") return send("action_type", args);
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
        });
      }
      if (name === "browser.cua.double_click") {
        const point = await screenshotPointToCss(send, args.x, args.y);
        return send("click", { x: point.x, y: point.y, button: "left", clickCount: 2 });
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
        });
      }

      return send(name, args);
    },
  };
}

function sendHubCommand({ url, WebSocketImpl, commandName, params, leaseToken }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocketImpl(url);
    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      reject(new Error(`Link2Chrome command timed out: ${commandName}`));
    }, 30000);

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
    this._transport = transport;
    this._safety = safety;
    this.tabs = new Tabs({ browser: this, transport, safety });
    this.user = new UserSurface({ browser: this, transport, safety });
  }

  async nameSession(name) {
    this.sessionName = name;
    return { ok: true, name };
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
    return this._browser.tabs.list();
  }

  async claimTab(options = {}) {
    if (options.tabId !== undefined && options.tabId !== null) {
      await this._transport.command("browser_tab_switch", { tabId: options.tabId });
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
  }

  async url() {
    try {
      const info = await this._transport.command("browser_tab_info", {});
      return info.url ?? this._url;
    } catch {
      return this._url;
    }
  }

  async title() {
    try {
      const info = await this._transport.command("browser_tab_info", {});
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
    return this._transport.command("browser_tab_info", {});
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

  async waitForEvent(eventName, options = {}) {
    if (eventName !== "filechooser") {
      throw new Error(`Unsupported playwright event: ${eventName}`);
    }
    return new FileChooser({ transport: this._transport, safety: this._safety, selector: options.selector });
  }

  async waitForLoadState(state = "load", options = {}) {
    const timeoutMs = options.timeoutMs ?? options.timeout ?? 30000;
    const deadline = Date.now() + timeoutMs;
    const sleepMs = 250;

    const readyScripts = {
      load: "document.readyState === 'complete'",
      domcontentloaded: "document.readyState !== 'loading'",
      networkidle: "(function(){const e=performance.getEntriesByType('resource');const n=performance.now();return e.filter(r=>n-r.startTime<500).length===0&&document.readyState==='complete';})()",
    };

    if (readyScripts[state]) {
      while (Date.now() < deadline) {
        const result = await this._evalBoolean(readyScripts[state]);
        if (result === true) return;
        if (result === undefined) break; // transport doesn't support script_evaluate, fallback
        await new Promise((resolve) => setTimeout(resolve, sleepMs));
      }
    }

    // Fallback to browser.wait for unknown states or when script_evaluate unavailable
    const condition = state === "networkidle" ? "network-idle" : "dom-ready";
    return this._transport.command("browser.wait", {
      condition,
      state,
      ...options,
    });
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

  getByLabel(label) {
    const escaped = cssStringEscape(label);
    return new Locator({
      transport: this._transport,
      safety: this._safety,
      tab: this._tab,
      target: { selector: `[aria-label="${escaped}"]`, label },
    });
  }

  getByPlaceholder(placeholder) {
    const escaped = cssStringEscape(placeholder);
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
      const raw = await this._transport.command("script_evaluate", { script, awaitPromise: false, timeout: 5000 });
      if (typeof raw === "boolean") return raw;
      if (raw && typeof raw === "object" && typeof raw.result === "boolean") return raw.result;
    } catch {
      // ignore
    }
    return undefined;
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
    if (this.target.has || this.target.hasNot || this.target.visibleOnly || this.target.hasNotText !== undefined) {
      return this._countWithScriptEvaluate();
    }
    if (matcher && !this.target.selector) {
      if (matcher.kind === "contains") {
        const raw = await this._transport.command("browser.dom.search", { query: matcher.text });
        return (raw.matches || raw.elements || []).length;
      }
      const raw = await this._queryTextMatches(matcher);
      return locatorElements(raw).filter((element) => locatorTextMatches(element, matcher)).length;
    }
    const raw = await this._transport.command("browser.dom.query", {
      selector: this.target.selector,
      limit: 100,
      ...(matcher ? { attributes: ["text", "ariaLabel"] } : {}),
    });
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
    const raw = await this._transport.command("script_evaluate", { script });
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
    return this._transport.command("browser.dom.click", { target, ...commandOptions });
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
    return this._transport.command("browser.dom.type", {
      target,
      text,
      clearFirst: options.clearFirst ?? true,
    });
  }

  async hover(options = {}) {
    await this._strictCheck(options);
    const target = await this._resolveTarget();
    const { strict, ...commandOptions } = options;
    return this._transport.command("action_hover", {
      target,
      ...commandOptions,
    });
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
    return this._transport.command("action_press_key", {
      target,
      key,
      ...commandOptions,
    });
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
    return this._transport.command("action_select", {
      target,
      value,
      ...commandOptions,
    });
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
    return this._transport.command("script_evaluate", {
      script: `
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
      `,
      ...commandOptions,
    });
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
    return this._transport.command("browser.dom.click", {
      target,
      clickCount: 2,
      ...commandOptions,
    });
  }

  async waitFor(options = {}) {
    return this._transport.command("browser.wait", {
      condition: options.condition || "dom-ready",
      selector: this.target.selector,
      ...options,
    });
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
    return this._transport.command("upload_file", {
      selector: this.target.selector,
      paths: normalizedPaths,
      ...commandOptions,
    });
  }

  async textContent() {
    if (this.target.text && !this.target.selector) {
      return this.target.text;
    }
    const selector = await this._resolveSelector();
    const raw = await this._transport.command("browser.dom.query", {
      selector,
      limit: 1,
      attributes: ["text"],
    });
    const first = locatorElements(raw)[0];
    return first?.text || first?.textContent || "";
  }

  async allTextContents() {
    if (this.target.text && !this.target.selector) {
      return [this.target.text];
    }
    const raw = await this._transport.command("browser.dom.query", {
      selector: this.target.selector,
      limit: 100,
      attributes: ["text", "ariaLabel"],
    });
    return locatorElements(raw)
      .map((element) => element.text ?? element.textContent ?? element.ariaLabel ?? "")
      .filter((text) => text !== "");
  }

  async getAttribute(name) {
    const selector = await this._resolveSelector();
    const raw = await this._transport.command("browser.dom.query", {
      selector,
      limit: 1,
      attributes: [name],
    });
    const first = locatorElements(raw)[0];
    return first?.[name] ?? null;
  }

  async inputValue() {
    return this.getAttribute("value");
  }

  async isVisible() {
    const selector = await this._resolveSelector();
    const detail = await this._transport.command("dom_element_detail", {
      selector,
      include: ["position"],
    });
    return Boolean(detail.ok && detail.position?.visible);
  }

  async isEnabled() {
    const selector = await this._resolveSelector();
    const detail = await this._transport.command("dom_element_detail", {
      selector,
      include: ["position", "accessibility"],
    });
    return Boolean(detail.ok && detail.position?.visible && detail.accessibility?.focusable);
  }

  async boundingBox() {
    const selector = await this._resolveSelector();
    const detail = await this._transport.command("dom_element_detail", {
      selector,
      include: ["position"],
    });
    if (!detail.ok || !detail.position?.visible) return null;
    const { x, y, width, height } = detail.position;
    return { x, y, width, height };
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
    };
  }

  _needsResolvedTarget() {
    const matcher = this._textMatcher();
    return this.target.index !== undefined
      || this.target.last
      || (matcher && matcher.kind !== "contains")
      || this.target.hasNotText !== undefined;
  }

  _textMatcher() {
    if (this.target.text === undefined) return null;
    return this.target.textMatcher || normalizeTextMatcher(this.target.text);
  }

  _queryTextMatches(matcher) {
    if (matcher.kind === "exact") {
      return this._transport.command("browser.dom.search", { query: matcher.text, limit: 100 });
    }
    return this._transport.command("browser.dom.query", {
      selector: "*",
      limit: 100,
      attributes: ["text", "ariaLabel"],
    });
  }

  _queryResolvableElements(matcher) {
    if (this.target.selector) {
      const limit = matcher || this.target.last ? 100 : (this.target.index ?? 0) + 1;
      return this._transport.command("browser.dom.query", {
        selector: this.target.selector,
        limit,
        attributes: matcher ? ["text", "ariaLabel"] : ["text"],
      });
    }
    if (matcher) {
      return this._queryTextMatches(matcher);
    }
    return this._transport.command("browser.dom.search", {
      query: this.target.text,
      limit: this.target.last ? 100 : (this.target.index ?? 0) + 1,
    });
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
    if (typeof x === "object" && x !== null) {
      options = y || {};
      y = x.y;
      x = x.x;
    }
    await this._safety?.confirm({ type: "cua.click", target: { x, y }, safety: options.safety });
    const { safety, ...commandOptions } = options;
    return this._transport.command("browser.cua.click", { x, y, ...commandOptions });
  }

  async doubleClick(x, y) {
    return this._transport.command("browser.cua.double_click", { x, y });
  }

  async move(x, y) {
    return this._transport.command("browser.cua.move", { x, y });
  }

  async type(text, options = {}) {
    await this._safety?.confirm({ type: "cua.type", text, safety: options.safety });
    const { safety, ...commandOptions } = options;
    return this._transport.command("browser.cua.type", { text, ...commandOptions });
  }

  async key(combo, options = {}) {
    await this._safety?.confirm({ type: "cua.key", key: combo, safety: options.safety });
    const { safety, ...commandOptions } = options;
    return this._transport.command("browser.cua.key", { combo, ...commandOptions });
  }

  async scroll(dx = 0, dy = 500, options = {}) {
    return this._transport.command("browser.cua.scroll", { dx, dy, ...options });
  }

  async drag(x1, y1, x2, y2, options = {}) {
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

  async visibleDom(options = {}) {
    return this._transport.command("browser.dom.overview", options);
  }

  async query(selector, options = {}) {
    return this._transport.command("browser.dom.query", { selector, ...options });
  }

  async click(target, options = {}) {
    await this._safety?.confirm({
      type: "dom_cua.click",
      target,
      safety: options.safety,
    });
    const { safety, ...commandOptions } = options;
    return this._transport.command("browser.dom.click", { target, ...commandOptions });
  }
}

class DevSurface {
  constructor({ tab, transport }) {
    this._tab = tab;
    this._transport = transport;
    this.console = new ConsoleDevSurface({ transport });
    this.network = new NetworkDevSurface({ transport });
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
