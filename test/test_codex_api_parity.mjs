/**
 * task-12: Codex API parity 测试套件（8.8 验收）
 *
 * 以 Codex api.md 为唯一基准，对全部 surface/method 做存在性断言。
 * 运行方式: node test/test_codex_api_parity.mjs
 */

import { createLink2ChromeClient, setupLink2ChromeRuntime } from "../runtime/link2chrome-client.mjs";

// ============================================================================
// Mock Transport — 对未知命令返回通用成功结构，个别命令按需打桩
// ============================================================================
function createMockTransport() {
  const commands = [];
  return {
    commands,
    async command(name, args = {}) {
      commands.push({ name, args });

      switch (name) {
        case "browser_tabs_list":
          return {
            tabs: [{
              id: "tab-1",
              url: "https://example.com",
              title: "Example",
              active: true,
            }],
          };
        case "browser_tab_info":
          return {
            id: "tab-1",
            url: "https://example.com",
            title: "Example",
            active: true,
          };
        case "agent_browser_tab_info":
          return {
            id: "tab-1",
            url: "https://example.com",
            title: "Example",
            active: true,
          };
        case "browser_tab_new":
        case "agent_browser_tab_new":
          return { id: "tab-2", url: "about:blank" };
        case "browser.dom.query":
          return {
            elements: [
              { selector: "body", text: "Hello", textContent: "Hello", value: "test", ariaLabel: "label" },
            ],
          };
        case "browser.dom.search":
          return {
            matches: [
              { text: "Hello", textContent: "Hello" },
            ],
          };
        case "browser.dom.overview":
          return {
            title: "Page",
            url: "https://example.com",
            headings: [],
            buttons: [],
            inputs: [],
            links: 0,
            forms: 0,
            tables: 0,
            images: 0,
          };
        case "dom_element_detail":
          return {
            ok: true,
            position: { visible: true, width: 100, height: 100, x: 0, y: 0 },
            accessibility: { focusable: true },
          };
        case "script_evaluate":
          return { result: true };
        case "frame_evaluate":
          return { result: true };
        case "browser.cua.screenshot":
          return { data: "", format: "png", metadata: { coordinateSpace: "screenshot" } };
        case "screenshot":
          return { image: "", format: "png" };
        case "get_info":
          return { viewport: { devicePixelRatio: 1, innerWidth: 1280, innerHeight: 800 } };
        case "wait_for_download":
          return { ok: true, url: "https://example.com/file.zip", filename: "file.zip" };
        default:
          return { ok: true };
      }
    },
  };
}

// ============================================================================
// 断言工具
// ============================================================================
let totalAssertions = 0;
let passedAssertions = 0;
const failedList = [];

function assertTrue(value, message) {
  totalAssertions++;
  if (!value) {
    failedList.push(message);
    throw new Error(message);
  }
  passedAssertions++;
}

function assertEqual(actual, expected, message) {
  assertTrue(actual === expected, `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertTypeOf(value, type, message) {
  assertTrue(typeof value === type, `${message}: expected ${type}, got ${typeof value}`);
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}: ${error.message}`);
  }
}

// ============================================================================
// 结构化断言清单（与 Codex api.md 逐一对照）
// ============================================================================
const ASSERTION_CHECKLIST = [];

function addAssertion(surface, method, type = "function") {
  ASSERTION_CHECKLIST.push({ surface, method, type });
}

// --- Browsers ---
addAssertion("Browsers", "get");
addAssertion("Browsers", "list");

// --- Browser ---
addAssertion("Browser", "browserId", "property");
addAssertion("Browser", "capabilities", "property");
addAssertion("Browser", "tabs", "property");
addAssertion("Browser", "user", "property");
addAssertion("Browser", "documentation");
addAssertion("Browser", "nameSession");

// --- BrowserUser ---
addAssertion("BrowserUser", "claimTab");
addAssertion("BrowserUser", "history");
addAssertion("BrowserUser", "openTabs");

// --- Tabs ---
addAssertion("Tabs", "finalize");
addAssertion("Tabs", "get");
addAssertion("Tabs", "list");
addAssertion("Tabs", "new");
addAssertion("Tabs", "selected");

// --- Tab ---
addAssertion("Tab", "capabilities", "property");
addAssertion("Tab", "clipboard", "property");
addAssertion("Tab", "cua", "property");
addAssertion("Tab", "dev", "property");
addAssertion("Tab", "dom_cua", "property");
addAssertion("Tab", "id", "property");
addAssertion("Tab", "playwright", "property");
addAssertion("Tab", "back");
addAssertion("Tab", "close");
addAssertion("Tab", "forward");
addAssertion("Tab", "goto");
addAssertion("Tab", "reload");
addAssertion("Tab", "screenshot");
addAssertion("Tab", "title");
addAssertion("Tab", "url");

// --- CUAAPI ---
addAssertion("CUAAPI", "click");
addAssertion("CUAAPI", "double_click");
addAssertion("CUAAPI", "drag");
addAssertion("CUAAPI", "keypress");
addAssertion("CUAAPI", "move");
addAssertion("CUAAPI", "scroll");
addAssertion("CUAAPI", "type");

// --- DomCUAAPI ---
addAssertion("DomCUAAPI", "click");
addAssertion("DomCUAAPI", "double_click");
addAssertion("DomCUAAPI", "get_visible_dom");
addAssertion("DomCUAAPI", "keypress");
addAssertion("DomCUAAPI", "scroll");
addAssertion("DomCUAAPI", "type");

// --- PlaywrightAPI ---
addAssertion("PlaywrightAPI", "domSnapshot");
addAssertion("PlaywrightAPI", "evaluate");
addAssertion("PlaywrightAPI", "expectNavigation");
addAssertion("PlaywrightAPI", "frameLocator");
addAssertion("PlaywrightAPI", "getByLabel");
addAssertion("PlaywrightAPI", "getByPlaceholder");
addAssertion("PlaywrightAPI", "getByRole");
addAssertion("PlaywrightAPI", "getByTestId");
addAssertion("PlaywrightAPI", "getByText");
addAssertion("PlaywrightAPI", "locator");
addAssertion("PlaywrightAPI", "waitForEvent");
addAssertion("PlaywrightAPI", "waitForLoadState");
addAssertion("PlaywrightAPI", "waitForTimeout");
addAssertion("PlaywrightAPI", "waitForURL");

// --- PlaywrightFrameLocator ---
addAssertion("PlaywrightFrameLocator", "frameLocator");
addAssertion("PlaywrightFrameLocator", "getByLabel");
addAssertion("PlaywrightFrameLocator", "getByPlaceholder");
addAssertion("PlaywrightFrameLocator", "getByRole");
addAssertion("PlaywrightFrameLocator", "getByTestId");
addAssertion("PlaywrightFrameLocator", "getByText");
addAssertion("PlaywrightFrameLocator", "locator");

// --- PlaywrightLocator ---
addAssertion("PlaywrightLocator", "all");
addAssertion("PlaywrightLocator", "allTextContents");
addAssertion("PlaywrightLocator", "and");
addAssertion("PlaywrightLocator", "check");
addAssertion("PlaywrightLocator", "click");
addAssertion("PlaywrightLocator", "count");
addAssertion("PlaywrightLocator", "dblclick");
addAssertion("PlaywrightLocator", "downloadMedia");
addAssertion("PlaywrightLocator", "fill");
addAssertion("PlaywrightLocator", "filter");
addAssertion("PlaywrightLocator", "first");
addAssertion("PlaywrightLocator", "getAttribute");
addAssertion("PlaywrightLocator", "getByLabel");
addAssertion("PlaywrightLocator", "getByPlaceholder");
addAssertion("PlaywrightLocator", "getByRole");
addAssertion("PlaywrightLocator", "getByTestId");
addAssertion("PlaywrightLocator", "getByText");
addAssertion("PlaywrightLocator", "innerText");
addAssertion("PlaywrightLocator", "isEnabled");
addAssertion("PlaywrightLocator", "isVisible");
addAssertion("PlaywrightLocator", "last");
addAssertion("PlaywrightLocator", "locator");
addAssertion("PlaywrightLocator", "nth");
addAssertion("PlaywrightLocator", "or");
addAssertion("PlaywrightLocator", "press");
addAssertion("PlaywrightLocator", "selectOption");
addAssertion("PlaywrightLocator", "setChecked");
addAssertion("PlaywrightLocator", "textContent");
addAssertion("PlaywrightLocator", "type");
addAssertion("PlaywrightLocator", "uncheck");
addAssertion("PlaywrightLocator", "waitFor");

// --- TabClipboardAPI ---
addAssertion("TabClipboardAPI", "read");
addAssertion("TabClipboardAPI", "readText");
addAssertion("TabClipboardAPI", "write");
addAssertion("TabClipboardAPI", "writeText");

// --- TabDevAPI ---
addAssertion("TabDevAPI", "logs");

// --- Documentation ---
addAssertion("Documentation", "get");

// --- CapabilityCollection (browser + tab) ---
addAssertion("CapabilityCollection", "list");
addAssertion("CapabilityCollection", "get");

// ============================================================================
// 主测试逻辑
// ============================================================================
async function main() {
  const mock = createMockTransport();
  const client = createLink2ChromeClient({ transport: mock });
  const browser = await client.browsers.get("extension");
  const tabs = await browser.tabs.list();
  const tab = tabs[0];
  const pw = tab.playwright;
  const loc = pw.locator("body");
  const fl = pw.frameLocator("iframe");

  const globals = {};
  setupLink2ChromeRuntime({ globals, transport: mock, overwrite: true });
  const agent = globals.agent;

  // --------------------------------------------------------------------------
  // 辅助：按 surface 名称解析到实际对象
  // --------------------------------------------------------------------------
  function resolveSurface(name) {
    const map = {
      Browsers: client.browsers,
      Browser: browser,
      BrowserUser: browser.user,
      Tabs: browser.tabs,
      Tab: tab,
      CUAAPI: tab.cua,
      DomCUAAPI: tab.dom_cua,
      PlaywrightAPI: pw,
      PlaywrightFrameLocator: fl,
      PlaywrightLocator: loc,
      TabClipboardAPI: tab.clipboard,
      TabDevAPI: tab.dev,
      Documentation: agent.documentation,
      CapabilityCollection: null, // 需要分别对 browser/tab 断言
    };
    return map[name];
  }

  // --------------------------------------------------------------------------
  // 1. 基于 ASSERTION_CHECKLIST 的批量存在性断言
  // --------------------------------------------------------------------------
  for (const item of ASSERTION_CHECKLIST) {
    if (item.surface === "CapabilityCollection") {
      // browser + tab 各做一次
      await test(`CapabilityCollection (browser).${item.method} 是函数`, () => {
        assertTypeOf(browser.capabilities[item.method], "function", `browser.capabilities.${item.method}`);
      });
      await test(`CapabilityCollection (tab).${item.method} 是函数`, () => {
        assertTypeOf(tab.capabilities[item.method], "function", `tab.capabilities.${item.method}`);
      });
      continue;
    }

    const target = resolveSurface(item.surface);
    await test(`${item.surface}.${item.method} ${item.type === "property" ? "存在" : "是函数"}`, () => {
      assertTrue(
        target !== undefined && target !== null,
        `${item.surface} instance missing`
      );
      if (item.type === "property") {
        assertTrue(
          target[item.method] !== undefined,
          `${item.surface}.${item.method} missing`
        );
      } else {
        assertTypeOf(
          target[item.method],
          "function",
          `${item.surface}.${item.method}`
        );
      }
    });
  }

  // --------------------------------------------------------------------------
  // 2. agent 全局
  // --------------------------------------------------------------------------
  await test("agent.browsers 存在", () => {
    assertTrue(agent !== undefined, "agent missing");
    assertTrue(agent.browsers !== undefined, "agent.browsers missing");
  });

  // --------------------------------------------------------------------------
  // 16. 旧签名回归区
  // --------------------------------------------------------------------------
  await test("旧签名: cua.click(x, y) 可用", async () => {
    mock.commands.length = 0;
    await tab.cua.click(10, 20);
    const cmd = mock.commands.pop();
    assertEqual(cmd.name, "browser.cua.click", "command name mismatch");
  });
  await test("旧签名: cua.doubleClick(x, y) 可用", async () => {
    mock.commands.length = 0;
    await tab.cua.doubleClick(10, 20);
    const cmd = mock.commands.pop();
    assertEqual(cmd.name, "browser.cua.double_click", "command name mismatch");
  });
  await test("旧签名: cua.key(combo) 可用", async () => {
    mock.commands.length = 0;
    await tab.cua.key("Enter");
    const cmd = mock.commands.pop();
    assertEqual(cmd.name, "browser.cua.key", "command name mismatch");
  });
  await test("旧签名: tab.goBack() 可用", async () => {
    mock.commands.length = 0;
    await tab.goBack();
    const cmd = mock.commands.pop();
    assertEqual(cmd.name, "go_back", "command name mismatch");
  });
  await test("旧签名: tab.goForward() 可用", async () => {
    mock.commands.length = 0;
    await tab.goForward();
    const cmd = mock.commands.pop();
    assertEqual(cmd.name, "go_forward", "command name mismatch");
  });
  await test("旧签名: link2chrome.browsers 可用", () => {
    assertTrue(client.browsers !== undefined, "link2chrome.browsers missing");
    assertTypeOf(client.browsers.get, "function", "link2chrome.browsers.get");
  });
  await test("旧签名: dom_cua.visibleDom() 可用", async () => {
    mock.commands.length = 0;
    await tab.dom_cua.visibleDom();
    const cmd = mock.commands.find((c) => c.name === "browser.dom.overview");
    assertTrue(cmd !== undefined, "visibleDom should call browser.dom.overview");
  });

  // --------------------------------------------------------------------------
  // 17. 验收脚本（plan 8.8 脚本 9 等效）在 mock 下可执行不抛 '不是函数'
  // --------------------------------------------------------------------------
  const notFunctionErrors = [];

  async function runAcceptanceCall(label, fn) {
    try {
      await fn();
    } catch (error) {
      const msg = String(error?.message || error);
      if (/is not a function|不是函数|不是方法/.test(msg)) {
        notFunctionErrors.push(`${label}: ${msg}`);
      }
    }
  }

  await test("验收脚本：全部调用不抛 '不是函数' 错误", async () => {
    // --- agent / browser 初始化 ---
    await runAcceptanceCall("agent.browsers.get", async () => {
      const b = await client.browsers.get("extension");
      await b.nameSession("test");
      await b.documentation();
      await b.capabilities.list();
    });

    // --- tabs ---
    await runAcceptanceCall("tabs.new", async () => {
      const newTab = await browser.tabs.new();
      await newTab.goto("https://example.com");
    });
    await runAcceptanceCall("tabs.selected", async () => {
      const selTab = await browser.tabs.selected();
      await selTab.title();
      await selTab.url();
    });
    await runAcceptanceCall("tabs.list", async () => {
      const list = await browser.tabs.list();
      await browser.tabs.get(list[0]?.id);
    });

    // --- tab 导航 ---
    await runAcceptanceCall("tab.reload", async () => {
      await tab.reload();
    });
    await runAcceptanceCall("tab.back", async () => {
      await tab.back();
    });
    await runAcceptanceCall("tab.forward", async () => {
      await tab.forward();
    });
    await runAcceptanceCall("tab.screenshot", async () => {
      await tab.screenshot({ fullPage: true });
    });
    await runAcceptanceCall("tab.close", async () => {
      await tab.close();
    });

    // --- playwright ---
    await runAcceptanceCall("pw.domSnapshot", async () => {
      await pw.domSnapshot();
    });
    await runAcceptanceCall("pw.evaluate", async () => {
      await pw.evaluate("1+1");
      await pw.evaluate((x) => x + 1, 5);
    });
    await runAcceptanceCall("pw.waitForTimeout", async () => {
      await pw.waitForTimeout(10);
    });
    await runAcceptanceCall("pw.waitForLoadState", async () => {
      await pw.waitForLoadState("load");
      await pw.waitForLoadState({ state: "domcontentloaded", timeoutMs: 100 });
    });
    await runAcceptanceCall("pw.waitForURL", async () => {
      await pw.waitForURL("https://example.com", { timeoutMs: 100 });
    });
    await runAcceptanceCall("pw.expectNavigation", async () => {
      await pw.expectNavigation(async () => {}, { timeoutMs: 100 });
    });
    await runAcceptanceCall("pw.waitForEvent download", async () => {
      await pw.waitForEvent("download", { timeoutMs: 100 });
    });

    // --- playwright locators ---
    await runAcceptanceCall("pw.getByText", async () => {
      const l = pw.getByText("Hello");
      await l.click();
      await l.dblclick();
      await l.fill("text");
      await l.type("text");
      await l.press("Enter");
      await l.check();
      await l.uncheck();
      await l.setChecked(true);
      await l.innerText();
      await l.textContent();
      await l.getAttribute("class");
      await l.count();
      await l.all();
      await l.first();
      await l.last();
      await l.nth(0);
      await l.and(l);
      await l.or(l);
      await l.filter({ hasText: "foo" });
      await l.waitFor();
      await l.allTextContents();
      await l.isVisible();
      await l.isEnabled();
      await l.selectOption("value");
      await l.downloadMedia();
    });

    await runAcceptanceCall("pw.getByRole", async () => {
      const l = pw.getByRole("button", { name: "Submit" });
      await l.click();
    });
    await runAcceptanceCall("pw.getByLabel", async () => {
      const l = pw.getByLabel("Email");
      await l.fill("a@b.com");
    });
    await runAcceptanceCall("pw.getByPlaceholder", async () => {
      const l = pw.getByPlaceholder("Search");
      await l.fill("query");
    });
    await runAcceptanceCall("pw.getByTestId", async () => {
      const l = pw.getByTestId("submit");
      await l.click();
    });
    await runAcceptanceCall("pw.locator", async () => {
      const l = pw.locator("body");
      const child = l.locator("div");
      const grandchild = child.locator("span");
      await grandchild.click();
    });

    // --- frameLocator ---
    await runAcceptanceCall("pw.frameLocator", async () => {
      const frame = pw.frameLocator("iframe");
      const nested = frame.frameLocator("nested");
      const flLoc = nested.locator("body");
      await flLoc.click();
      frame.getByText("foo");
      frame.getByRole("button");
      frame.getByLabel("label");
      frame.getByPlaceholder("placeholder");
      frame.getByTestId("id");
    });

    // --- cua ---
    await runAcceptanceCall("cua.click", async () => {
      await tab.cua.click({ x: 10, y: 10, button: 1 });
    });
    await runAcceptanceCall("cua.double_click", async () => {
      await tab.cua.double_click({ x: 10, y: 10 });
    });
    await runAcceptanceCall("cua.drag", async () => {
      await tab.cua.drag({ path: [{ x: 0, y: 0 }, { x: 10, y: 10 }] });
    });
    await runAcceptanceCall("cua.keypress", async () => {
      await tab.cua.keypress({ keys: ["Enter"] });
    });
    await runAcceptanceCall("cua.move", async () => {
      await tab.cua.move({ x: 10, y: 10 });
    });
    await runAcceptanceCall("cua.scroll", async () => {
      await tab.cua.scroll({ x: 0, y: 0, scrollX: 0, scrollY: 100 });
    });
    await runAcceptanceCall("cua.type", async () => {
      await tab.cua.type({ text: "hello" });
    });

    // --- dom_cua ---
    await runAcceptanceCall("dom_cua.get_visible_dom", async () => {
      await tab.dom_cua.get_visible_dom();
    });
    await runAcceptanceCall("dom_cua.click", async () => {
      await tab.dom_cua.click({ node_id: "123" });
    });
    await runAcceptanceCall("dom_cua.double_click", async () => {
      await tab.dom_cua.double_click({ node_id: "123" });
    });
    await runAcceptanceCall("dom_cua.keypress", async () => {
      await tab.dom_cua.keypress({ keys: ["Enter"] });
    });
    await runAcceptanceCall("dom_cua.scroll", async () => {
      await tab.dom_cua.scroll({ x: 0, y: 100 });
    });
    await runAcceptanceCall("dom_cua.type", async () => {
      await tab.dom_cua.type({ text: "hello" });
    });

    // --- clipboard ---
    await runAcceptanceCall("clipboard.readText", async () => {
      await tab.clipboard.readText();
    });
    await runAcceptanceCall("clipboard.writeText", async () => {
      await tab.clipboard.writeText("hello");
    });
    await runAcceptanceCall("clipboard.read", async () => {
      await tab.clipboard.read();
    });
    await runAcceptanceCall("clipboard.write", async () => {
      await tab.clipboard.write([{ entries: [] }]);
    });

    // --- dev ---
    await runAcceptanceCall("dev.logs", async () => {
      await tab.dev.logs();
    });

    // --- browser.user ---
    await runAcceptanceCall("browser.user.openTabs", async () => {
      await browser.user.openTabs();
    });
    await runAcceptanceCall("browser.user.history", async () => {
      await browser.user.history();
    });
    await runAcceptanceCall("browser.user.claimTab", async () => {
      await browser.user.claimTab({ tabId: "1" });
    });

    // --- tabs.finalize ---
    await runAcceptanceCall("tabs.finalize", async () => {
      await browser.tabs.finalize({ keep: [] });
    });

    // --- documentation ---
    await runAcceptanceCall("agent.documentation.get", async () => {
      await agent.documentation.get("api");
    });

    // --- tab.capabilities ---
    await runAcceptanceCall("tab.capabilities", async () => {
      await tab.capabilities.list();
    });

    // 最后统一断言没有 "不是函数" 错误
    assertTrue(notFunctionErrors.length === 0, `"不是函数" 错误: ${notFunctionErrors.join("; ")}`);
  });

  // --------------------------------------------------------------------------
  // 汇总
  // --------------------------------------------------------------------------
  console.log("\n========================================");
  console.log(`总断言数: ${totalAssertions}`);
  console.log(`通过数: ${passedAssertions}`);
  console.log(`失败数: ${failedList.length}`);
  if (failedList.length > 0) {
    console.log("\n失败清单:");
    for (const f of failedList) {
      console.log(`  - ${f}`);
    }
  }
  console.log("========================================");

  process.exit(failedList.length > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("测试运行异常:", error);
  process.exit(1);
});
