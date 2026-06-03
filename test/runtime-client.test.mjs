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

test("tabs.finalize is a structured no-op for deliverable handoff habits", async () => {
  const transport = fakeTransport();
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
    args: { target: { role: "button", text: "Search" } },
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
