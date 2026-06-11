import test from "node:test";
import assert from "node:assert/strict";
import {
  createLink2ChromeClient,
  registerTabCapability,
  registerBrowserCapability,
} from "../runtime/link2chrome-client.mjs";

function mockTransport(responses = {}) {
  return {
    async command(name, args = {}) {
      if (responses[name]) {
        return responses[name](name, args);
      }
      return { ok: true };
    },
  };
}

test("Browser 实例有 capabilities 属性且含 list/get 方法", async () => {
  const transport = mockTransport();
  const client = createLink2ChromeClient({ transport });
  const browser = await client.browsers.get("extension");

  assert.ok(browser.capabilities, "browser.capabilities 应该存在");
  assert.equal(typeof browser.capabilities.list, "function", "list 应该是函数");
  assert.equal(typeof browser.capabilities.get, "function", "get 应该是函数");
});

test("Tab 实例有 capabilities 属性且含 list/get 方法", async () => {
  const transport = mockTransport({
    browser_tab_info: () => ({ url: "https://example.com", title: "Example" }),
  });
  const client = createLink2ChromeClient({ transport });
  const browser = await client.browsers.get("extension");
  const tab = await browser.tabs.selected();

  assert.ok(tab.capabilities, "tab.capabilities 应该存在");
  assert.equal(typeof tab.capabilities.list, "function", "list 应该是函数");
  assert.equal(typeof tab.capabilities.get, "function", "get 应该是函数");
});

test("browser.capabilities.list() 空注册表返回 [] 不抛错", async () => {
  const transport = mockTransport();
  const client = createLink2ChromeClient({ transport });
  const browser = await client.browsers.get("extension");
  const list = await browser.capabilities.list();
  assert.deepEqual(list, [], "空注册表应返回 []");
});

test("tab.capabilities.list() 空注册表返回 [] 不抛错", async () => {
  const transport = mockTransport({
    browser_tab_info: () => ({ url: "https://example.com", title: "Example" }),
  });
  const client = createLink2ChromeClient({ transport });
  const browser = await client.browsers.get("extension");
  const tab = await browser.tabs.selected();
  const list = await tab.capabilities.list();
  assert.deepEqual(list, [], "空注册表应返回 []");
});

test("browser.capabilities.get('nonexistent') 抛出含可用 id 列表的错误", async () => {
  const transport = mockTransport();
  const client = createLink2ChromeClient({ transport });
  const browser = await client.browsers.get("extension");

  await assert.rejects(
    async () => await browser.capabilities.get("nonexistent"),
    /Capability "nonexistent" not found in browser scope\. Available capabilities: \(无\)/
  );
});

test("tab.capabilities.get('nonexistent') 抛出含可用 id 列表的错误", async () => {
  const transport = mockTransport({
    browser_tab_info: () => ({ url: "https://example.com", title: "Example" }),
  });
  const client = createLink2ChromeClient({ transport });
  const browser = await client.browsers.get("extension");
  const tab = await browser.tabs.selected();

  await assert.rejects(
    async () => await tab.capabilities.get("nonexistent"),
    /Capability "nonexistent" not found in tab scope\. Available capabilities: \(无\)/
  );
});

test("registerBrowserCapability 注册后 list() 含该项、get() 返回实例且含 documentation()", async () => {
  const transport = mockTransport();
  const client = createLink2ChromeClient({ transport });

  registerBrowserCapability("testBrowserCap", "Test browser capability", ({ browser, transport, safety }) => {
    return {
      async documentation() {
        return "# Test Browser Capability\nThis is a test.";
      },
    };
  });

  const browser = await client.browsers.get("extension");
  const list = await browser.capabilities.list();
  assert.equal(list.length, 1, "list 应包含 1 项");
  assert.equal(list[0].id, "testBrowserCap", "id 匹配");
  assert.equal(list[0].description, "Test browser capability", "description 匹配");

  const instance = await browser.capabilities.get("testBrowserCap");
  assert.equal(typeof instance.documentation, "function", "实例应含 documentation 方法");
  const doc = await instance.documentation();
  assert.equal(typeof doc, "string", "documentation() 应返回字符串");
  assert.ok(doc.includes("Test Browser Capability"), "文档内容应包含标题");
});

test("registerTabCapability 注册后 list() 含该项、get() 返回实例且含 documentation()", async () => {
  const transport = mockTransport({
    browser_tab_info: () => ({ url: "https://example.com", title: "Example" }),
  });
  const client = createLink2ChromeClient({ transport });

  registerTabCapability("testTabCap", "Test tab capability", ({ tab, transport, safety }) => {
    return {
      async documentation() {
        return "# Test Tab Capability\nThis is a tab test.";
      },
    };
  });

  const browser = await client.browsers.get("extension");
  const tab = await browser.tabs.selected();
  const list = await tab.capabilities.list();
  assert.equal(list.length, 1, "list 应包含 1 项");
  assert.equal(list[0].id, "testTabCap", "id 匹配");
  assert.equal(list[0].description, "Test tab capability", "description 匹配");

  const instance = await tab.capabilities.get("testTabCap");
  assert.equal(typeof instance.documentation, "function", "实例应含 documentation 方法");
  const doc = await instance.documentation();
  assert.equal(typeof doc, "string", "documentation() 应返回字符串");
  assert.ok(doc.includes("Test Tab Capability"), "文档内容应包含标题");
});

test("get('nonexistent') 在已有注册项时列出可用 id", async () => {
  const transport = mockTransport({
    browser_tab_info: () => ({ url: "https://example.com", title: "Example" }),
  });
  const client = createLink2ChromeClient({ transport });
  const browser = await client.browsers.get("extension");
  const tab = await browser.tabs.selected();

  await assert.rejects(
    async () => await tab.capabilities.get("missing"),
    /Available capabilities: testTabCap/
  );
});
