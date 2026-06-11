import { createLink2ChromeClient } from "../runtime/link2chrome-client.mjs";

function createMockTransport() {
  const commands = [];
  return {
    commands,
    async command(name, args = {}) {
      if (name === "browser_tabs_list") {
        return {
          tabs: [{
            id: "tab-1",
            url: "https://example.com",
            title: "Example",
            active: true,
          }],
        };
      }
      if (name === "browser_tab_info") {
        return {
          id: "tab-1",
          url: "https://example.com",
          title: "Example",
          active: true,
        };
      }
      if (name === "browser.dom.query") {
        // 默认返回空，测试中需要时由 mock 响应覆盖
        return { elements: [] };
      }
      commands.push({ name, args });
      return { ok: true };
    },
  };
}

function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${message}: expected ${e}, got ${a}`);
  }
}

function assertTrue(value, message) {
  if (!value) throw new Error(message || "Assertion failed");
}

function assertIncludes(haystack, needle, message) {
  if (!String(haystack).includes(needle)) {
    throw new Error(`${message}: expected to include "${needle}"`);
  }
}

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (error) {
    console.error(`✗ ${name}: ${error.message}`);
    failed++;
  }
}

async function main() {
  const mock = createMockTransport();
  const client = createLink2ChromeClient({ transport: mock });
  const browser = await client.browsers.get("extension");
  const tabs = await browser.tabs.list();
  const tab = tabs[0];

  // === 存在性断言：PlaywrightSurface ===
  await test("PlaywrightSurface has evaluate", () => {
    assertTrue(typeof tab.playwright.evaluate === "function", "evaluate missing");
  });

  await test("PlaywrightSurface has waitForTimeout", () => {
    assertTrue(typeof tab.playwright.waitForTimeout === "function", "waitForTimeout missing");
  });

  await test("PlaywrightSurface has waitForLoadState", () => {
    assertTrue(typeof tab.playwright.waitForLoadState === "function", "waitForLoadState missing");
  });

  await test("PlaywrightSurface waitForLoadState({state:'load'}) object signature works", async () => {
    mock.commands.length = 0;
    // 由于 waitForLoadState 使用轮询，mock 的 script_evaluate 会返回 undefined，然后 fallback 到 browser.wait
    // 我们只需要确认它不会因对象签名而抛错
    await tab.playwright.waitForLoadState({ state: "load", timeoutMs: 100 });
    const cmd = mock.commands.find((c) => c.name === "browser.wait");
    assertTrue(cmd !== undefined, "should fallback to browser.wait");
    assertEqual(cmd.args.state, "load", "state mismatch");
  });

  // === evaluate 序列化断言 ===
  await test("evaluate(string) sends script_evaluate with raw script", async () => {
    mock.commands.length = 0;
    await tab.playwright.evaluate("document.title");
    const cmd = mock.commands.pop();
    assertEqual(cmd.name, "script_evaluate", "command name mismatch");
    assertEqual(cmd.args.script, "document.title", "script mismatch");
    assertEqual(cmd.args.awaitPromise, true, "awaitPromise mismatch");
  });

  await test("evaluate(fn, arg) serializes function and arg into script_evaluate", async () => {
    mock.commands.length = 0;
    const fn = (x) => x + 1;
    await tab.playwright.evaluate(fn, 5);
    const cmd = mock.commands.pop();
    assertEqual(cmd.name, "script_evaluate", "command name mismatch");
    assertIncludes(cmd.args.script, "(x) => x + 1", "script should contain function body");
    assertIncludes(cmd.args.script, "5", "script should contain serialized arg");
    assertEqual(cmd.args.awaitPromise, true, "awaitPromise mismatch");
  });

  // === waitForTimeout ===
  await test("waitForTimeout resolves after specified ms", async () => {
    const start = Date.now();
    await tab.playwright.waitForTimeout(50);
    const elapsed = Date.now() - start;
    assertTrue(elapsed >= 40, `expected at least ~50ms, got ${elapsed}ms`);
  });

  // === waitForEvent download 真实实现（task-8）===
  await test("waitForEvent('download') sends wait_for_download command", async () => {
    mock.commands.length = 0;
    await tab.playwright.waitForEvent("download", { timeoutMs: 5000 });
    const cmd = mock.commands.find((c) => c.name === "wait_for_download");
    assertTrue(cmd !== undefined, "wait_for_download command should be sent");
    assertEqual(cmd.args.timeout, 5000, "timeout mismatch");
  });

  // === Locator 存在性断言 ===
  const loc = tab.playwright.locator("button");

  await test("Locator has innerText", () => {
    assertTrue(typeof loc.innerText === "function", "innerText missing");
  });

  await test("Locator has type", () => {
    assertTrue(typeof loc.type === "function", "type missing");
  });

  await test("Locator has all", () => {
    assertTrue(typeof loc.all === "function", "all missing");
  });

  await test("Locator has locator (descendant)", () => {
    assertTrue(typeof loc.locator === "function", "locator missing");
  });

  await test("Locator has getByText", () => {
    assertTrue(typeof loc.getByText === "function", "getByText missing");
  });

  await test("Locator has getByRole", () => {
    assertTrue(typeof loc.getByRole === "function", "getByRole missing");
  });

  await test("Locator has getByLabel", () => {
    assertTrue(typeof loc.getByLabel === "function", "getByLabel missing");
  });

  await test("Locator has getByPlaceholder", () => {
    assertTrue(typeof loc.getByPlaceholder === "function", "getByPlaceholder missing");
  });

  await test("Locator has getByTestId", () => {
    assertTrue(typeof loc.getByTestId === "function", "getByTestId missing");
  });

  // === RegExp 传入 getByText 不抛错 ===
  await test("getByText with RegExp does not throw", () => {
    const regex = /hello/;
    const l = tab.playwright.getByText(regex);
    assertTrue(l instanceof Object, "should return a Locator-like object");
    assertEqual(l.target.textMatcher.kind, "regex", "textMatcher kind should be regex");
  });

  await test("Locator.getByText with RegExp does not throw", () => {
    const regex = /world/;
    const l = loc.getByText(regex);
    assertTrue(l instanceof Object, "should return a Locator-like object");
    assertEqual(l.target.textMatcher.kind, "regex", "textMatcher kind should be regex");
  });

  // === type() 命令带 clearFirst:false ===
  await test("type() sends browser.dom.type with clearFirst: false", async () => {
    mock.commands.length = 0;
    // mock script_evaluate for _strictCheck resolution
    const transportWithResolve = {
      ...mock,
      async command(name, args = {}) {
        if (name === "browser.dom.query") {
          return { elements: [{ selector: "#input" }] };
        }
        return mock.command(name, args);
      },
    };
    const client2 = createLink2ChromeClient({ transport: transportWithResolve });
    const browser2 = await client2.browsers.get("extension");
    const tabs2 = await browser2.tabs.list();
    const tab2 = tabs2[0];
    await tab2.playwright.locator("#input").type("hello");
    const cmd = mock.commands.find((c) => c.name === "browser.dom.type");
    assertTrue(cmd !== undefined, "browser.dom.type command should exist");
    assertEqual(cmd.args.clearFirst, false, "clearFirst should be false");
    assertEqual(cmd.args.text, "hello", "text mismatch");
  });

  // === fill() 行为不变（回归） ===
  await test("fill() still sends browser.dom.type with clearFirst: true by default", async () => {
    mock.commands.length = 0;
    const transportWithResolve = {
      ...mock,
      async command(name, args = {}) {
        if (name === "browser.dom.query") {
          return { elements: [{ selector: "#input" }] };
        }
        return mock.command(name, args);
      },
    };
    const client2 = createLink2ChromeClient({ transport: transportWithResolve });
    const browser2 = await client2.browsers.get("extension");
    const tabs2 = await browser2.tabs.list();
    const tab2 = tabs2[0];
    await tab2.playwright.locator("#input").fill("world");
    const cmd = mock.commands.find((c) => c.name === "browser.dom.type");
    assertTrue(cmd !== undefined, "browser.dom.type command should exist");
    assertEqual(cmd.args.clearFirst, true, "clearFirst should be true by default for fill");
    assertEqual(cmd.args.text, "world", "text mismatch");
  });

  // === all() 返回 Locator 数组 ===
  await test("all() returns array of Locators with length equal to count", async () => {
    const transportWithCount = {
      ...mock,
      async command(name, args = {}) {
        if (name === "browser.dom.query") {
          return { elements: [{ selector: "a" }, { selector: "a" }, { selector: "a" }] };
        }
        return mock.command(name, args);
      },
    };
    const client2 = createLink2ChromeClient({ transport: transportWithCount });
    const browser2 = await client2.browsers.get("extension");
    const tabs2 = await browser2.tabs.list();
    const tab2 = tabs2[0];
    const items = await tab2.playwright.locator("a").all();
    assertTrue(Array.isArray(items), "all() should return an array");
    assertEqual(items.length, 3, "length should equal count");
    assertTrue(typeof items[0].click === "function", "each item should be a Locator");
  });

  // === locator 链式选择器 ===
  await test("locator chain reflects ancestor constraint in selector", () => {
    const child = tab.playwright.locator("form").locator("input");
    assertEqual(child.target.selector, "form input", "selector should concatenate ancestor and descendant");
  });

  await test("locator chain with options.hasText", () => {
    const child = tab.playwright.locator("form").locator("input", { hasText: "search" });
    assertEqual(child.target.selector, "form input", "selector should concatenate");
    assertEqual(child.target.text, "search", "hasText should be set");
  });

  // === waitFor 支持四种 state ===
  await test("waitFor({state:'attached'}) does not throw unsupported error", async () => {
    mock.commands.length = 0;
    await tab.playwright.locator("div").waitFor({ state: "attached" });
    const cmd = mock.commands.find((c) => c.name === "browser.wait");
    assertTrue(cmd !== undefined, "browser.wait should be called");
    assertEqual(cmd.args.state, "attached", "state mismatch");
  });

  await test("waitFor({state:'detached'}) does not throw unsupported error", async () => {
    mock.commands.length = 0;
    await tab.playwright.locator("div").waitFor({ state: "detached" });
    const cmd = mock.commands.find((c) => c.name === "browser.wait");
    assertEqual(cmd.args.state, "detached", "state mismatch");
  });

  await test("waitFor({state:'visible'}) does not throw unsupported error", async () => {
    mock.commands.length = 0;
    await tab.playwright.locator("div").waitFor({ state: "visible" });
    const cmd = mock.commands.find((c) => c.name === "browser.wait");
    assertEqual(cmd.args.state, "visible", "state mismatch");
  });

  await test("waitFor({state:'hidden'}) does not throw unsupported error", async () => {
    mock.commands.length = 0;
    await tab.playwright.locator("div").waitFor({ state: "hidden" });
    const cmd = mock.commands.find((c) => c.name === "browser.wait");
    assertEqual(cmd.args.state, "hidden", "state mismatch");
  });

  // === 现有 Locator 方法回归 ===
  await test("Locator click/fill/count/first/nth/and/or/filter still exist", () => {
    const l = tab.playwright.locator("button");
    assertTrue(typeof l.click === "function", "click missing");
    assertTrue(typeof l.fill === "function", "fill missing");
    assertTrue(typeof l.count === "function", "count missing");
    assertTrue(typeof l.first === "function", "first missing");
    assertTrue(typeof l.nth === "function", "nth missing");
    assertTrue(typeof l.and === "function", "and missing");
    assertTrue(typeof l.or === "function", "or missing");
    assertTrue(typeof l.filter === "function", "filter missing");
  });

  await test("filter({visible:true}) sets visibleOnly", () => {
    const l = tab.playwright.locator("div").filter({ visible: true });
    assertEqual(l.target.visibleOnly, true, "visibleOnly should be true");
  });

  await test("filter({visible:false}) sets hiddenOnly", () => {
    const l = tab.playwright.locator("div").filter({ visible: false });
    assertEqual(l.target.hiddenOnly, true, "hiddenOnly should be true");
  });

  await test("Locator getByText scoped selector includes ancestor", () => {
    const scoped = tab.playwright.locator("nav").getByText("Home");
    assertIncludes(scoped.target.selector, "nav", "scoped selector should include ancestor");
  });

  await test("Locator getByRole scoped selector includes ancestor", () => {
    const scoped = tab.playwright.locator("nav").getByRole("link");
    assertIncludes(scoped.target.selector, "nav", "scoped selector should include ancestor");
  });

  await test("Locator getByLabel scoped selector includes ancestor", () => {
    const scoped = tab.playwright.locator("form").getByLabel("Email");
    assertIncludes(scoped.target.selector, "form", "scoped selector should include ancestor");
  });

  await test("Locator getByPlaceholder scoped selector includes ancestor", () => {
    const scoped = tab.playwright.locator("form").getByPlaceholder("Email");
    assertIncludes(scoped.target.selector, "form", "scoped selector should include ancestor");
  });

  await test("Locator getByTestId scoped selector includes ancestor", () => {
    const scoped = tab.playwright.locator("form").getByTestId("submit");
    assertIncludes(scoped.target.selector, "form", "scoped selector should include ancestor");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
