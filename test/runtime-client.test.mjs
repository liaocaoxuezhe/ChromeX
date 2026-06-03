import test from "node:test";
import assert from "node:assert/strict";
import { createLink2ChromeClient, createWebSocketTransport } from "../runtime/link2chrome-client.mjs";

function fakeTransport() {
  const calls = [];
  return {
    calls,
    async command(name, args = {}) {
      calls.push({ name, args });
      if (name === "browser_tabs_list") {
        return { tabs: [{ id: 7, active: true, url: "https://example.com", title: "Example" }] };
      }
      return { ok: true };
    },
  };
}

test("browsers.get returns an extension browser with tabs API", async () => {
  const transport = fakeTransport();
  const link2chrome = createLink2ChromeClient({ transport });

  const browser = await link2chrome.browsers.get("extension");
  const tabs = await browser.tabs.list();

  assert.equal(browser.kind, "extension");
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].id, 7);
  assert.deepEqual(transport.calls[0], { name: "browser_tabs_list", args: {} });
});

test("diagnose returns Browser Hub status", async () => {
  const transport = {
    calls: [],
    async command(name, args = {}) {
      this.calls.push({ name, args });
      if (name === "__hub_status__") {
        return {
          hub_id: "hub-1",
          extension_connected: true,
          adapter_connections: 2,
          queue_locked: false,
        };
      }
      return { ok: true };
    },
  };
  const link2chrome = createLink2ChromeClient({ transport });

  const result = await link2chrome.diagnose();

  assert.deepEqual(result, {
    ok: true,
    hub: {
      hub_id: "hub-1",
      extension_connected: true,
      adapter_connections: 2,
      queue_locked: false,
    },
  });
  assert.deepEqual(transport.calls, [{ name: "__hub_status__", args: {} }]);
});

test("diagnose returns structured error when Hub is unreachable", async () => {
  const transport = {
    async command() {
      throw new Error("connection refused");
    },
  };
  const link2chrome = createLink2ChromeClient({ transport });

  const result = await link2chrome.diagnose();

  assert.equal(result.ok, false);
  assert.equal(result.error, "connection refused");
});

test("tabs.selected returns active tab info and tab navigation uses browser_navigate", async () => {
  const transport = {
    calls: [],
    async command(name, args = {}) {
      this.calls.push({ name, args });
      if (name === "browser_tab_info") {
        return { id: 7, active: true, url: "https://start.test", title: "Start" };
      }
      if (name === "browser_navigate") {
        return { ok: true, url: args.url };
      }
      return { ok: true };
    },
  };
  const browser = await createLink2ChromeClient({ transport }).browsers.get("extension");

  const tab = await browser.tabs.selected();
  const result = await tab.goto("https://example.com");

  assert.equal(tab.id, 7);
  assert.equal(result.ok, true);
  assert.deepEqual(transport.calls, [
    { name: "browser_tab_info", args: {} },
    { name: "browser_navigate", args: { url: "https://example.com" } },
  ]);
});

test("user.openTabs lists currently open tabs", async () => {
  const transport = fakeTransport();
  const browser = await createLink2ChromeClient({ transport }).browsers.get("extension");

  const tabs = await browser.user.openTabs();

  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].id, 7);
  assert.deepEqual(transport.calls[0], { name: "browser_tabs_list", args: {} });
});

test("user.claimTab without arguments claims selected tab", async () => {
  const transport = {
    calls: [],
    async command(name, args = {}) {
      this.calls.push({ name, args });
      if (name === "browser_tab_info") {
        return { id: 9, active: true, url: "https://claimed.test", title: "Claimed" };
      }
      return { ok: true };
    },
  };
  const browser = await createLink2ChromeClient({ transport }).browsers.get("extension");

  const tab = await browser.user.claimTab();

  assert.equal(tab.id, 9);
  assert.deepEqual(transport.calls, [{ name: "browser_tab_info", args: {} }]);
});

test("user.claimTab with tabId switches and returns selected tab", async () => {
  const transport = {
    calls: [],
    async command(name, args = {}) {
      this.calls.push({ name, args });
      if (name === "browser_tab_switch") return { ok: true, tabId: args.tabId };
      if (name === "browser_tab_info") {
        return { id: 11, active: true, url: "https://target.test", title: "Target" };
      }
      return { ok: true };
    },
  };
  const browser = await createLink2ChromeClient({ transport }).browsers.get("extension");

  const tab = await browser.user.claimTab({ tabId: 11 });

  assert.equal(tab.id, 11);
  assert.deepEqual(transport.calls, [
    { name: "browser_tab_switch", args: { tabId: 11 } },
    { name: "browser_tab_info", args: {} },
  ]);
});

test("user.history clearly reports unsupported backend", async () => {
  const transport = fakeTransport();
  const browser = await createLink2ChromeClient({ transport }).browsers.get("extension");

  await assert.rejects(
    () => browser.user.history(),
    /user.history is not implemented/
  );
});

test("tabs.finalize is a structured no-op for deliverable handoff habits", async () => {
  const transport = fakeTransport();
  const originalCommand = transport.command.bind(transport);
  transport.command = async (name, args = {}) => {
    if (name === "browser.tabs.finalize") {
      throw new Error("unknown command: browser.tabs.finalize");
    }
    return originalCommand(name, args);
  };
  const browser = await createLink2ChromeClient({ transport }).browsers.get("extension");
  const [tab] = await browser.tabs.list();

  const result = await browser.tabs.finalize({ keep: [{ tab, status: "deliverable" }] });

  assert.deepEqual(result, {
    ok: true,
    action: "finalize",
    kept: [{ tabId: 7, status: "deliverable" }],
    raw: null,
  });
});

test("tabs.finalize calls backend when finalize support is available", async () => {
  const transport = {
    calls: [],
    async command(name, args = {}) {
      this.calls.push({ name, args });
      if (name === "browser_tabs_list") {
        return { tabs: [{ id: 7, active: true, url: "https://example.com", title: "Example" }] };
      }
      if (name === "browser.tabs.finalize") {
        return { ok: true, action: "finalize", grouped: [{ tabId: 7, status: "deliverable" }] };
      }
      return { ok: true };
    },
  };
  const browser = await createLink2ChromeClient({ transport }).browsers.get("extension");
  const [tab] = await browser.tabs.list();

  const result = await browser.tabs.finalize({ keep: [{ tab, status: "deliverable" }] });

  assert.deepEqual(result, { ok: true, action: "finalize", grouped: [{ tabId: 7, status: "deliverable" }] });
  assert.deepEqual(transport.calls.at(-1), {
    name: "browser.tabs.finalize",
    args: { keep: [{ tabId: 7, status: "deliverable" }] },
  });
});

test("locator fill maps to browser.dom.type", async () => {
  const transport = fakeTransport();
  const browser = await createLink2ChromeClient({ transport }).browsers.get("extension");
  const [tab] = await browser.tabs.list();

  await tab.playwright.locator("input[name='q']").fill("Link2Chrome");

  assert.deepEqual(transport.calls.at(-1), {
    name: "browser.dom.type",
    args: {
      target: { selector: "input[name='q']" },
      text: "Link2Chrome",
      clearFirst: true,
    },
  });
});

test("locator setFiles maps to upload_file", async () => {
  const transport = fakeTransport();
  const browser = await createLink2ChromeClient({ transport }).browsers.get("extension");
  const [tab] = await browser.tabs.list();

  await tab.playwright.locator("input[type='file']").setFiles(["/tmp/a.txt", "/tmp/b.txt"]);

  assert.deepEqual(transport.calls.at(-1), {
    name: "upload_file",
    args: {
      selector: "input[type='file']",
      paths: ["/tmp/a.txt", "/tmp/b.txt"],
    },
  });
});

test("locator setFiles can require safety confirmation", async () => {
  const confirmations = [];
  const transport = fakeTransport();
  const link2chrome = createLink2ChromeClient({
    transport,
    confirmAction: async (action) => {
      confirmations.push(action);
      return false;
    },
  });
  const browser = await link2chrome.browsers.get("extension");
  const [tab] = await browser.tabs.list();

  await assert.rejects(
    () => tab.playwright.locator("input[type='file']").setFiles("/tmp/secret.txt", {
      safety: { level: "always-confirm", reason: "upload local file" },
    }),
    /Action was not confirmed/
  );

  assert.equal(confirmations[0].type, "filechooser.setFiles");
  assert.deepEqual(confirmations[0].paths, ["/tmp/secret.txt"]);
  assert.notEqual(transport.calls.at(-1)?.name, "upload_file");
});

test("getByText count maps to browser.dom.search", async () => {
  const transport = {
    calls: [],
    async command(name, args = {}) {
      this.calls.push({ name, args });
      if (name === "browser.dom.search") {
        return { matches: [{ text: "More information" }, { text: "More links" }] };
      }
      return { tabs: [{ id: 7, active: true }] };
    },
  };
  const browser = await createLink2ChromeClient({ transport }).browsers.get("extension");
  const [tab] = await browser.tabs.list();

  const count = await tab.playwright.getByText("More").count();

  assert.equal(count, 2);
  assert.deepEqual(transport.calls.at(-1), {
    name: "browser.dom.search",
    args: { query: "More" },
  });
});

test("getByRole click maps to browser.dom.click with role and name target", async () => {
  const transport = fakeTransport();
  const browser = await createLink2ChromeClient({ transport }).browsers.get("extension");
  const [tab] = await browser.tabs.list();

  await tab.playwright.getByRole("button", { name: "Search" }).click();

  assert.deepEqual(transport.calls.at(-1), {
    name: "browser.dom.click",
    args: {
      target: {
        selector: 'button, input[type="button"], input[type="submit"], [role="button"]',
        role: "button",
        text: "Search",
      },
    },
  });
});

test("locator click runs safety confirmation before sensitive actions", async () => {
  const confirmations = [];
  const transport = fakeTransport();
  const link2chrome = createLink2ChromeClient({
    transport,
    confirmAction: async (action) => {
      confirmations.push(action);
      return false;
    },
  });
  const browser = await link2chrome.browsers.get("extension");
  const [tab] = await browser.tabs.list();

  await assert.rejects(
    () => tab.playwright.getByRole("button", { name: "Delete" }).click({
      safety: { level: "always-confirm", reason: "delete data" },
    }),
    /Action was not confirmed/
  );

  assert.equal(confirmations.length, 1);
  assert.equal(confirmations[0].type, "click");
  assert.deepEqual(confirmations[0].target, {
    selector: 'button, input[type="button"], input[type="submit"], [role="button"]',
    role: "button",
    text: "Delete",
  });
  assert.notDeepEqual(transport.calls.at(-1), {
    name: "browser.dom.click",
    args: { target: { role: "button", text: "Delete" } },
  });
});

test("cua click maps to browser.cua.click", async () => {
  const transport = fakeTransport();
  const browser = await createLink2ChromeClient({ transport }).browsers.get("extension");
  const [tab] = await browser.tabs.list();

  await tab.cua.click(200, 100);

  assert.deepEqual(transport.calls.at(-1), {
    name: "browser.cua.click",
    args: { x: 200, y: 100 },
  });
});

test("dom_cua visibleDom clearly reports unsupported backend", async () => {
  const transport = fakeTransport();
  const browser = await createLink2ChromeClient({ transport }).browsers.get("extension");
  const [tab] = await browser.tabs.list();

  await assert.rejects(
    () => tab.dom_cua.visibleDom(),
    /dom_cua.visibleDom is not implemented/
  );
});

test("dev console surface maps capture list and clear commands", async () => {
  const transport = fakeTransport();
  const browser = await createLink2ChromeClient({ transport }).browsers.get("extension");
  const [tab] = await browser.tabs.list();

  await tab.dev.console.start({ maxEntries: 25 });
  await tab.dev.console.list({ types: ["error"], limit: 5 });
  await tab.dev.console.clear();

  assert.deepEqual(transport.calls.slice(-3), [
    { name: "console_capture", args: { action: "start", maxEntries: 25 } },
    { name: "console_list", args: { types: ["error"], limit: 5 } },
    { name: "console_clear", args: {} },
  ]);
});

test("dev network surface maps capture query and replay commands", async () => {
  const transport = fakeTransport();
  const browser = await createLink2ChromeClient({ transport }).browsers.get("extension");
  const [tab] = await browser.tabs.list();

  await tab.dev.network.start({ includeResponseBody: true });
  await tab.dev.network.query({ urlContains: "/api", includeBody: true });
  await tab.dev.network.replay({ id: "net-1" });

  assert.deepEqual(transport.calls.slice(-3), [
    { name: "network_capture", args: { action: "start", includeResponseBody: true } },
    { name: "network_query", args: { urlContains: "/api", includeBody: true } },
    { name: "network_replay", args: { id: "net-1" } },
  ]);
});

test("clipboard surface maps read and write commands", async () => {
  const transport = fakeTransport();
  const browser = await createLink2ChromeClient({ transport }).browsers.get("extension");
  const [tab] = await browser.tabs.list();

  await tab.clipboard.readText();
  await tab.clipboard.writeText("hello");

  assert.deepEqual(transport.calls.slice(-2), [
    { name: "browser.clipboard.readText", args: {} },
    { name: "browser.clipboard.writeText", args: { text: "hello" } },
  ]);
});

test("clipboard write can require safety confirmation", async () => {
  const confirmations = [];
  const transport = fakeTransport();
  const link2chrome = createLink2ChromeClient({
    transport,
    confirmAction: async (action) => {
      confirmations.push(action);
      return false;
    },
  });
  const browser = await link2chrome.browsers.get("extension");
  const [tab] = await browser.tabs.list();

  await assert.rejects(
    () => tab.clipboard.writeText("secret", {
      safety: { level: "always-confirm", reason: "overwrite clipboard" },
    }),
    /Action was not confirmed/
  );

  assert.equal(confirmations[0].type, "clipboard.writeText");
  assert.equal(confirmations[0].text, "secret");
  assert.notEqual(transport.calls.at(-1)?.name, "browser.clipboard.writeText");
});

test("dialog surface maps accept and dismiss to handle_dialog", async () => {
  const transport = fakeTransport();
  const browser = await createLink2ChromeClient({ transport }).browsers.get("extension");
  const [tab] = await browser.tabs.list();

  await tab.dialog.accept({ promptText: "yes", timeout: 1000 });
  await tab.dialog.dismiss();

  assert.deepEqual(transport.calls.slice(-2), [
    { name: "handle_dialog", args: { action: "accept", promptText: "yes", timeout: 1000 } },
    { name: "handle_dialog", args: { action: "dismiss" } },
  ]);
});

test("createWebSocketTransport exports a command transport", () => {
  const transport = createWebSocketTransport({ url: "ws://127.0.0.1:8765", WebSocketImpl: class {} });

  assert.equal(typeof transport.command, "function");
});

test("websocket transport speaks Browser Hub request_id protocol", async () => {
  const sentMessages = [];
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.listeners = {};
      queueMicrotask(() => this.listeners.open?.({}));
    }

    addEventListener(name, handler) {
      this.listeners[name] = handler;
    }

    send(message) {
      const parsed = JSON.parse(message);
      sentMessages.push(parsed);
      this.listeners.message?.({
        data: JSON.stringify({
          request_id: parsed.request_id,
          success: true,
          data: { ok: true, echoed: parsed.command },
        }),
      });
    }

    close() {}
  }
  const transport = createWebSocketTransport({
    url: "ws://127.0.0.1:8766",
    WebSocketImpl: FakeWebSocket,
  });

  const result = await transport.command("agent_browser_tab_info", {});

  assert.deepEqual(result, { ok: true, echoed: "agent_browser_tab_info" });
  assert.equal(sentMessages[0].command, "agent_browser_tab_info");
  assert.deepEqual(sentMessages[0].params, {});
  assert.equal(typeof sentMessages[0].request_id, "string");
});

test("websocket transport maps runtime finalize to extension finalize command", async () => {
  const sentMessages = [];
  class FakeWebSocket {
    constructor() {
      this.listeners = {};
      queueMicrotask(() => this.listeners.open?.({}));
    }

    addEventListener(name, handler) {
      this.listeners[name] = handler;
    }

    send(message) {
      const parsed = JSON.parse(message);
      sentMessages.push(parsed);
      this.listeners.message?.({
        data: JSON.stringify({
          request_id: parsed.request_id,
          success: true,
          data: { ok: true, action: "finalize" },
        }),
      });
    }

    close() {}
  }
  const transport = createWebSocketTransport({ WebSocketImpl: FakeWebSocket });

  await transport.command("browser.tabs.finalize", { keep: [{ tabId: 7, status: "deliverable" }] });

  assert.equal(sentMessages[0].command, "agent_browser_tabs_finalize");
  assert.deepEqual(sentMessages[0].params, { keep: [{ tabId: 7, status: "deliverable" }] });
});

test("websocket transport maps runtime tab switch to extension switch command", async () => {
  const sentMessages = [];
  class FakeWebSocket {
    constructor() {
      this.listeners = {};
      queueMicrotask(() => this.listeners.open?.({}));
    }

    addEventListener(name, handler) {
      this.listeners[name] = handler;
    }

    send(message) {
      const parsed = JSON.parse(message);
      sentMessages.push(parsed);
      this.listeners.message?.({
        data: JSON.stringify({
          request_id: parsed.request_id,
          success: true,
          data: { ok: true, tabId: parsed.params.tabId },
        }),
      });
    }

    close() {}
  }
  const transport = createWebSocketTransport({ WebSocketImpl: FakeWebSocket });

  await transport.command("browser_tab_switch", { tabId: 12 });

  assert.equal(sentMessages[0].command, "agent_browser_tab_switch");
  assert.deepEqual(sentMessages[0].params, { tabId: 12 });
});

test("websocket transport passes dev console and network commands through", async () => {
  const sentMessages = [];
  class FakeWebSocket {
    constructor() {
      this.listeners = {};
      queueMicrotask(() => this.listeners.open?.({}));
    }

    addEventListener(name, handler) {
      this.listeners[name] = handler;
    }

    send(message) {
      const parsed = JSON.parse(message);
      sentMessages.push(parsed);
      this.listeners.message?.({
        data: JSON.stringify({
          request_id: parsed.request_id,
          success: true,
          data: { ok: true },
        }),
      });
    }

    close() {}
  }
  const transport = createWebSocketTransport({ WebSocketImpl: FakeWebSocket });

  await transport.command("console_capture", { action: "start" });
  await transport.command("network_query", { urlContains: "/api" });

  assert.equal(sentMessages[0].command, "console_capture");
  assert.deepEqual(sentMessages[0].params, { action: "start" });
  assert.equal(sentMessages[1].command, "network_query");
  assert.deepEqual(sentMessages[1].params, { urlContains: "/api" });
});

test("websocket transport maps clipboard commands to extension commands", async () => {
  const sentMessages = [];
  class FakeWebSocket {
    constructor() {
      this.listeners = {};
      queueMicrotask(() => this.listeners.open?.({}));
    }

    addEventListener(name, handler) {
      this.listeners[name] = handler;
    }

    send(message) {
      const parsed = JSON.parse(message);
      sentMessages.push(parsed);
      this.listeners.message?.({
        data: JSON.stringify({
          request_id: parsed.request_id,
          success: true,
          data: { ok: true },
        }),
      });
    }

    close() {}
  }
  const transport = createWebSocketTransport({ WebSocketImpl: FakeWebSocket });

  await transport.command("browser.clipboard.readText", {});
  await transport.command("browser.clipboard.writeText", { text: "hello" });

  assert.equal(sentMessages[0].command, "clipboard_read");
  assert.deepEqual(sentMessages[0].params, {});
  assert.equal(sentMessages[1].command, "clipboard_write");
  assert.deepEqual(sentMessages[1].params, { text: "hello" });
});
