import test from "node:test";
import assert from "node:assert/strict";
import {
  createLink2ChromeClient,
  setupLink2ChromeRuntime,
} from "../runtime/link2chrome-client.mjs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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

test("Tab.url 和 Tab.title 是异步方法且返回实时值", async () => {
  const transport = mockTransport({
    browser_tab_info: () => ({ url: "https://live.example.com", title: "Live Title" }),
  });
  const client = createLink2ChromeClient({ transport });
  const browser = await client.browsers.get("extension");
  const tab = await browser.tabs.selected();

  assert.equal(typeof tab.url, "function", "tab.url 应该是函数");
  assert.equal(typeof tab.title, "function", "tab.title 应该是函数");

  const url = await tab.url();
  assert.equal(url, "https://live.example.com");

  const title = await tab.title();
  assert.equal(title, "Live Title");
});

test("Tab.url / Tab.title 命令失败时回退到快照值", async () => {
  const transport = mockTransport({
    browser_tabs_list: () => ({
      tabs: [{ id: 1, url: "https://snapshot.com", title: "Snapshot" }],
    }),
    browser_tab_info: () => {
      throw new Error("hub offline");
    },
  });
  const client = createLink2ChromeClient({ transport });
  const browser = await client.browsers.get("extension");
  const tabs = await browser.tabs.list();
  const tab = tabs[0];

  const url = await tab.url();
  assert.equal(url, "https://snapshot.com");

  const title = await tab.title();
  assert.equal(title, "Snapshot");
});

test("Tab.back / Tab.forward 存在且复用 goBack / goForward", async () => {
  const transport = mockTransport({
    browser_tab_info: () => ({ url: "https://example.com", title: "Example" }),
    go_back: () => ({ ok: true, action: "back" }),
    go_forward: () => ({ ok: true, action: "forward" }),
  });
  const client = createLink2ChromeClient({ transport });
  const browser = await client.browsers.get("extension");
  const tab = await browser.tabs.selected();

  assert.equal(typeof tab.back, "function", "tab.back 应该是函数");
  assert.equal(typeof tab.forward, "function", "tab.forward 应该是函数");
  assert.equal(typeof tab.goBack, "function", "tab.goBack 应该是函数");
  assert.equal(typeof tab.goForward, "function", "tab.goForward 应该是函数");

  const backResult = await tab.back();
  assert.deepEqual(backResult, { ok: true, action: "back" });

  const forwardResult = await tab.forward();
  assert.deepEqual(forwardResult, { ok: true, action: "forward" });
});

test("Tab.screenshot 默认返回 Uint8Array", async () => {
  const transport = mockTransport({
    browser_tab_info: () => ({ url: "https://example.com", title: "Example" }),
    "browser.cua.screenshot": () => ({
      ok: true,
      format: "png",
      data: "aGVsbG8=",
      metadata: {},
    }),
  });
  const client = createLink2ChromeClient({ transport });
  const browser = await client.browsers.get("extension");
  const tab = await browser.tabs.selected();

  const result = await tab.screenshot();
  assert.ok(result instanceof Uint8Array, "默认应返回 Uint8Array");
  assert.deepEqual(result, new Uint8Array([104, 101, 108, 108, 111]));
});

test("Tab.screenshot 传入 raw:true 返回原始对象", async () => {
  const transport = mockTransport({
    browser_tab_info: () => ({ url: "https://example.com", title: "Example" }),
    "browser.cua.screenshot": () => ({
      ok: true,
      format: "png",
      data: "aGVsbG8=",
      metadata: {},
    }),
  });
  const client = createLink2ChromeClient({ transport });
  const browser = await client.browsers.get("extension");
  const tab = await browser.tabs.selected();

  const result = await tab.screenshot({ raw: true });
  assert.equal(typeof result, "object");
  assert.equal(result.ok, true);
  assert.equal(result.data, "aGVsbG8=");
});

test("PlaywrightSurface.screenshot 默认返回 Uint8Array", async () => {
  const transport = mockTransport({
    browser_tab_info: () => ({ url: "https://example.com", title: "Example" }),
    "browser.cua.screenshot": () => ({
      ok: true,
      format: "png",
      data: "d29ybGQ=",
      metadata: {},
    }),
  });
  const client = createLink2ChromeClient({ transport });
  const browser = await client.browsers.get("extension");
  const tab = await browser.tabs.selected();

  const result = await tab.playwright.screenshot();
  assert.ok(result instanceof Uint8Array, "默认应返回 Uint8Array");
  assert.deepEqual(result, new Uint8Array([119, 111, 114, 108, 100]));
});

test("agent.documentation.get 返回真实文档内容", async () => {
  const transport = mockTransport();
  const { agent } = setupLink2ChromeRuntime({
    globals: {},
    transport,
    overwrite: true,
  });

  assert.equal(typeof agent.documentation.get, "function");
  const content = await agent.documentation.get("api");
  assert.equal(typeof content, "string");
  assert.ok(content.length >= 5000, "api 文档长度应 >= 5000");
});

test("agent.documentation.get 对不存在的文档名抛错", async () => {
  const transport = mockTransport();
  const { agent } = setupLink2ChromeRuntime({
    globals: {},
    transport,
    overwrite: true,
  });

  await assert.rejects(
    agent.documentation.get("nonexistent"),
    /not found/
  );
});

test("agent.browsers 可用", async () => {
  const transport = mockTransport();
  const { agent } = setupLink2ChromeRuntime({
    globals: {},
    transport,
    overwrite: true,
  });
  assert.equal(typeof agent.browsers.get, "function");
  assert.equal(typeof agent.browsers.list, "function");
});

test("nodejs-playwright-runtime.mjs 语法通过 node --check", () => {
  const runtimePath = join(
    __dirname,
    "..",
    "runtime",
    "nodejs-playwright-runtime.mjs"
  );
  assert.doesNotThrow(() => {
    execSync("node --check " + JSON.stringify(runtimePath), { stdio: "pipe" });
  }, "runtime 语法错误");
});

test("link2chrome-client.mjs 语法通过 node --check", () => {
  const clientPath = join(
    __dirname,
    "..",
    "runtime",
    "link2chrome-client.mjs"
  );
  assert.doesNotThrow(() => {
    execSync("node --check " + JSON.stringify(clientPath), { stdio: "pipe" });
  }, "client 语法错误");
});
