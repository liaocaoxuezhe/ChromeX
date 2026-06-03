import { discoverLocalBrowserEnvironment } from "./local-environment.mjs";

export function createLink2ChromeClient({ transport, confirmAction, localEnvironment } = {}) {
  if (!transport || typeof transport.command !== "function") {
    throw new TypeError("createLink2ChromeClient requires a transport with command(name, args)");
  }
  const safety = new SafetyManager({ confirmAction });

  return {
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
    browsers: {
      async get(kind = "extension") {
        if (kind !== "extension") {
          throw new Error(`unsupported browser kind: ${kind}`);
        }
        return new Browser({ kind, transport, safety });
      },
    },
  };
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
      locator: true,
      fileChooser: true,
      dialog: true,
    },
    cua: {
      screenshot: true,
      click: true,
      drag: true,
      keyboard: true,
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
    },
    browserState: {
      openTabs: true,
      claimTab: true,
      history: true,
    },
    nativeMessaging: false,
    localPlaywrightDependency: false,
  };
}

export function createWebSocketTransport({ url = "ws://localhost:8766", WebSocketImpl = globalThis.WebSocket } = {}) {
  return {
    async command(name, args = {}) {
      if (!WebSocketImpl) {
        throw new Error("createWebSocketTransport requires global WebSocket or WebSocketImpl");
      }
      const send = (commandName, params = {}) => sendHubCommand({ url, WebSocketImpl, commandName, params });
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
      if (name === "browser.tabs.finalize") return send("agent_browser_tabs_finalize", args);
      if (name === "browser.user.history") return send("agent_browser_history", args);
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

function sendHubCommand({ url, WebSocketImpl, commandName, params }) {
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
      ws.send(JSON.stringify({ request_id: requestId, command: commandName, params }));
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

  async new(url) {
    const raw = await this._transport.command("browser_tab_new", url ? { url } : {});
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
    this.dom_cua = new DomCuaSurface({ tab: this, transport });
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

  async info() {
    return this._transport.command("browser_tab_info", {});
  }

  async screenshot(options = {}) {
    return this._transport.command("browser.cua.screenshot", options);
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
    const raw = await this._transport.command("browser.dom.query", { selector: this.target.selector, limit: 100 });
    return (raw.elements || raw.matches || []).length;
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
  constructor({ tab, transport }) {
    this._tab = tab;
    this._transport = transport;
  }

  async visibleDom() {
    throw new Error("dom_cua.visibleDom is not implemented by the current Link2Chrome backend");
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
