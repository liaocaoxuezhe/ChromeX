import {
  discoverLocalBrowserEnvironment,
  openLocalBrowserWindow,
} from "./local-environment.mjs";

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
  const agent = { browsers: link2chrome.browsers };
  if (overwrite || globals.link2chrome === undefined) {
    globals.link2chrome = link2chrome;
  }
  if (overwrite || globals.agent === undefined) {
    globals.agent = agent;
  }
  return { agent, link2chrome };
}

export function createLink2ChromeClient({ transport, confirmAction, localEnvironment } = {}) {
  if (!transport || typeof transport.command !== "function") {
    throw new TypeError("createLink2ChromeClient requires a transport with command(name, args)");
  }
  const safety = new SafetyManager({ confirmAction });
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
    diagnostics: new DiagnosticsSurface({ transport, localEnvironment }),
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
        agent: { browsers: this._client.browsers },
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
  constructor({ transport, localEnvironment }) {
    this._transport = transport;
    this._localEnvironment = localEnvironment;
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
      capabilities: runtimeCapabilities(),
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
      if (this._localEnvironment?.inspect) {
        return await this._localEnvironment.inspect();
      }
      return await discoverLocalBrowserEnvironment();
    } catch (error) {
      return {
        ok: false,
        error: String(error?.message || error),
      };
    }
  }
}

function runtimeCapabilities() {
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
    nativeMessaging: false,
    localPlaywrightDependency: false,
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
          for (const tab of windowTabs) {
            tabs.push({
              id: tab.id,
              windowId: tab.windowId,
              active: tab.active,
              url: tab.url,
              title: tab.title,
              status: tab.status || "unknown",
              favicon: tab.favIconUrl,
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
  constructor({ confirmAction } = {}) {
    this._confirmAction = confirmAction;
  }

  async confirm(action) {
    if (!action.safety) return true;
    if (action.safety.level === "no-confirm") return true;
    if (typeof this._confirmAction !== "function") {
      throw new Error(`Action requires confirmation: ${action.safety.reason || action.type}`);
    }
    const confirmed = await this._confirmAction(action);
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
    this.url = data.url;
    this.title = data.title;
    this.active = data.active;
    this.raw = raw;
    this.playwright = new PlaywrightSurface({ tab: this, transport, safety });
    this.cua = new CuaSurface({ tab: this, transport, safety });
    this.dom_cua = new DomCuaSurface({ tab: this, transport, safety });
    this.dev = new DevSurface({ tab: this, transport });
    this.clipboard = new ClipboardSurface({ tab: this, transport, safety });
    this.dialog = new DialogSurface({ tab: this, transport, safety });
  }

  async goto(url) {
    return this._transport.command("browser_navigate", { url });
  }

  async reload() {
    const current = await this.info();
    return this.goto(current.url);
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
    return this._transport.command("browser.cua.screenshot", options);
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
    return this._transport.command("browser.dom.overview", options);
  }

  async screenshot(options = {}) {
    return this._transport.command("browser.cua.screenshot", options);
  }

  async waitForEvent(eventName, options = {}) {
    if (eventName !== "filechooser") {
      throw new Error(`Unsupported playwright event: ${eventName}`);
    }
    return new FileChooser({ transport: this._transport, safety: this._safety, selector: options.selector });
  }

  async waitForLoadState(state = "load", options = {}) {
    const condition = state === "networkidle" ? "network-idle" : "dom-ready";
    return this._transport.command("browser.wait", {
      condition,
      state,
      ...options,
    });
  }

  locator(selector) {
    return new Locator({ transport: this._transport, safety: this._safety, target: { selector } });
  }

  getByText(text) {
    return new Locator({ transport: this._transport, safety: this._safety, target: { text } });
  }

  getByRole(role, options = {}) {
    return new Locator({
      transport: this._transport,
      safety: this._safety,
      target: { selector: roleSelector(role), role, text: options.name },
    });
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
  constructor({ transport, safety, target }) {
    this._transport = transport;
    this._safety = safety;
    this.target = target;
  }

  async count() {
    if (this.target.text && !this.target.selector) {
      const raw = await this._transport.command("browser.dom.search", { query: this.target.text });
      return (raw.matches || raw.elements || []).length;
    }
    const raw = await this._transport.command("browser.dom.query", {
      selector: this.target.selector,
      limit: 100,
      ...(this.target.text ? { attributes: ["text", "ariaLabel"] } : {}),
    });
    const elements = locatorElements(raw);
    if (this.target.text) {
      const needle = normalizeLocatorText(this.target.text);
      return elements.filter((element) => {
        const text = normalizeLocatorText(element.text || element.textContent || element.ariaLabel || element.name || "");
        return text.includes(needle);
      }).length;
    }
    return elements.length || Number(raw.count || 0);
  }

  async click(options = {}) {
    await this._safety?.confirm({
      type: "click",
      target: this.target,
      safety: options.safety,
    });
    const { safety, ...commandOptions } = options;
    return this._transport.command("browser.dom.click", { target: this.target, ...commandOptions });
  }

  async fill(text, options = {}) {
    await this._safety?.confirm({
      type: "fill",
      target: this.target,
      text,
      safety: options.safety,
    });
    return this._transport.command("browser.dom.type", {
      target: this.target,
      text,
      clearFirst: options.clearFirst ?? true,
    });
  }

  async hover(options = {}) {
    return this._transport.command("action_hover", {
      target: this.target,
      ...options,
    });
  }

  async press(key, options = {}) {
    await this._safety?.confirm({
      type: "press",
      target: this.target,
      key,
      safety: options.safety,
    });
    const { safety, ...commandOptions } = options;
    return this._transport.command("action_press_key", {
      target: this.target,
      key,
      ...commandOptions,
    });
  }

  async selectOption(value, options = {}) {
    await this._safety?.confirm({
      type: "selectOption",
      target: this.target,
      value,
      safety: options.safety,
    });
    const { safety, ...commandOptions } = options;
    return this._transport.command("action_select", {
      target: this.target,
      value,
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
    const normalizedPaths = Array.isArray(paths) ? paths : [paths];
    await this._safety?.confirm({
      type: "filechooser.setFiles",
      target: this.target,
      paths: normalizedPaths,
      safety: options.safety,
    });
    const { safety, ...commandOptions } = options;
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
    const raw = await this._transport.command("browser.dom.query", { selector: this.target.selector, limit: 1 });
    const first = (raw.elements || raw.matches || [])[0];
    return first?.text || first?.textContent || "";
  }
}

function locatorElements(raw = {}) {
  return raw.elements || raw.matches || raw.results || [];
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
    return this._transport.command("browser.cua.type", { text, ...options });
  }

  async key(combo) {
    return this._transport.command("browser.cua.key", { combo });
  }

  async scroll(dx = 0, dy = 500, options = {}) {
    return this._transport.command("browser.cua.scroll", { dx, dy, ...options });
  }

  async drag(x1, y1, x2, y2, options = {}) {
    return this._transport.command("browser.cua.drag", { x1, y1, x2, y2, ...options });
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
