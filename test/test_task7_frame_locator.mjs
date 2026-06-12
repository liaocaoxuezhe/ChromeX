/**
 * task-7: iframe 支持 frameLocator 同源实现（P1-1）
 * Node 离线 mock transport 断言 + background.js 静态检查
 *
 * 运行方式:
 *     node test/test_task7_frame_locator.mjs
 */

import { createLink2ChromeClient } from "../runtime/link2chrome-client.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const BG_PATH = join(__dirname, "..", "extension", "background.js");
const bgSource = readFileSync(BG_PATH, "utf-8");

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
        commands.push({ name, args });
        return { elements: [{ selector: "button" }] };
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

  // === FrameLocator API 存在性 ===
  await test("PlaywrightSurface has frameLocator", () => {
    assertTrue(typeof tab.playwright.frameLocator === "function", "frameLocator missing");
  });

  await test("FrameLocator has locator", () => {
    const frame = tab.playwright.frameLocator("#f");
    assertTrue(typeof frame.locator === "function", "locator missing");
  });

  await test("FrameLocator has getByText", () => {
    const frame = tab.playwright.frameLocator("#f");
    assertTrue(typeof frame.getByText === "function", "getByText missing");
  });

  await test("FrameLocator has getByRole", () => {
    const frame = tab.playwright.frameLocator("#f");
    assertTrue(typeof frame.getByRole === "function", "getByRole missing");
  });

  await test("FrameLocator has getByLabel", () => {
    const frame = tab.playwright.frameLocator("#f");
    assertTrue(typeof frame.getByLabel === "function", "getByLabel missing");
  });

  await test("FrameLocator has getByPlaceholder", () => {
    const frame = tab.playwright.frameLocator("#f");
    assertTrue(typeof frame.getByPlaceholder === "function", "getByPlaceholder missing");
  });

  await test("FrameLocator has getByTestId", () => {
    const frame = tab.playwright.frameLocator("#f");
    assertTrue(typeof frame.getByTestId === "function", "getByTestId missing");
  });

  await test("FrameLocator has nested frameLocator", () => {
    const frame = tab.playwright.frameLocator("#f");
    assertTrue(typeof frame.frameLocator === "function", "nested frameLocator missing");
  });

  // === frameContext 传播 ===
  await test("frameLocator('#f').locator('button') target carries frameContext", () => {
    const loc = tab.playwright.frameLocator("#f").locator("button");
    assertEqual(loc.target.frameContext, ["#f"], "frameContext mismatch");
  });

  await test("nested frameLocator('#a').frameLocator('#b') produces ['#a','#b']", () => {
    const frame = tab.playwright.frameLocator("#a").frameLocator("#b");
    const loc = frame.locator("button");
    assertEqual(loc.target.frameContext, ["#a", "#b"], "nested frameContext mismatch");
  });

  await test("frameLocator getByText carries frameContext", () => {
    const loc = tab.playwright.frameLocator("#f").getByText("hello");
    assertEqual(loc.target.frameContext, ["#f"], "getByText frameContext mismatch");
  });

  await test("frameLocator getByRole carries frameContext", () => {
    const loc = tab.playwright.frameLocator("#f").getByRole("button");
    assertEqual(loc.target.frameContext, ["#f"], "getByRole frameContext mismatch");
  });

  await test("frameLocator getByLabel carries frameContext", () => {
    const loc = tab.playwright.frameLocator("#f").getByLabel("Name");
    assertEqual(loc.target.frameContext, ["#f"], "getByLabel frameContext mismatch");
  });

  await test("frameLocator getByPlaceholder carries frameContext", () => {
    const loc = tab.playwright.frameLocator("#f").getByPlaceholder("Search");
    assertEqual(loc.target.frameContext, ["#f"], "getByPlaceholder frameContext mismatch");
  });

  await test("frameLocator getByTestId carries frameContext", () => {
    const loc = tab.playwright.frameLocator("#f").getByTestId("submit");
    assertEqual(loc.target.frameContext, ["#f"], "getByTestId frameContext mismatch");
  });

  // === Locator 嵌套传播 frameContext ===
  await test("Locator.locator() propagates frameContext", () => {
    const loc = tab.playwright.frameLocator("#f").locator("form").locator("input");
    assertEqual(loc.target.frameContext, ["#f"], "nested locator frameContext mismatch");
  });

  await test("Locator.getByText() propagates frameContext", () => {
    const loc = tab.playwright.frameLocator("#f").locator("form").getByText("Submit");
    assertEqual(loc.target.frameContext, ["#f"], "nested getByText frameContext mismatch");
  });

  // === click() 命令参数含 frameContext ===
  await test("frameLocator('#f').locator('button').click() command args include frameContext", async () => {
    mock.commands.length = 0;
    await tab.playwright.frameLocator("#f").locator("button").click();
    const cmd = mock.commands.find((c) => c.name === "browser.dom.click");
    assertTrue(cmd !== undefined, "browser.dom.click should be called");
    assertEqual(cmd.args.target.frameContext, ["#f"], "click command should carry frameContext");
  });

  // === fill() 命令参数含 frameContext ===
  await test("frameLocator fill command args include frameContext", async () => {
    mock.commands.length = 0;
    await tab.playwright.frameLocator("#f").locator("input").fill("hello");
    const cmd = mock.commands.find((c) => c.name === "browser.dom.type");
    assertTrue(cmd !== undefined, "browser.dom.type should be called");
    assertEqual(cmd.args.frameContext, ["#f"], "fill command should carry frameContext");
  });

  // === count() 命令参数含 frameContext ===
  await test("frameLocator count command args include frameContext", async () => {
    mock.commands.length = 0;
    await tab.playwright.frameLocator("#f").locator("button").count();
    const cmd = mock.commands.find((c) => c.name === "browser.dom.query");
    assertTrue(cmd !== undefined, "browser.dom.query should be called");
    assertEqual(cmd.args.frameContext, ["#f"], "count command should carry frameContext");
  });

  // === hover() 命令参数含 frameContext ===
  await test("frameLocator hover command args include frameContext", async () => {
    mock.commands.length = 0;
    await tab.playwright.frameLocator("#f").locator("button").hover();
    const cmd = mock.commands.find((c) => c.name === "action_hover");
    assertTrue(cmd !== undefined, "action_hover should be called");
    assertEqual(cmd.args.target.frameContext, ["#f"], "hover command should carry frameContext");
  });

  // === 无 frameContext 的普通 Locator 行为回归 ===
  await test("plain Locator click does NOT include frameContext", async () => {
    mock.commands.length = 0;
    await tab.playwright.locator("button").click();
    const cmd = mock.commands.find((c) => c.name === "browser.dom.click");
    assertTrue(cmd !== undefined, "browser.dom.click should be called");
    assertTrue(cmd.args.target.frameContext === undefined, "plain locator click should NOT carry frameContext");
  });

  await test("plain Locator fill does NOT include frameContext", async () => {
    mock.commands.length = 0;
    await tab.playwright.locator("input").fill("hello");
    const cmd = mock.commands.find((c) => c.name === "browser.dom.type");
    assertTrue(cmd !== undefined, "browser.dom.type should be called");
    assertTrue(cmd.args.frameContext === undefined, "plain locator fill should NOT carry frameContext");
  });

  await test("plain Locator count does NOT include frameContext", async () => {
    mock.commands.length = 0;
    await tab.playwright.locator("button").count();
    const cmd = mock.commands.find((c) => c.name === "browser.dom.query");
    assertTrue(cmd !== undefined, "browser.dom.query should be called");
    assertTrue(cmd.args.frameContext === undefined, "plain locator count should NOT carry frameContext");
  });

  // === script_evaluate 在有 frameContext 时改为 frame_evaluate ===
  await test("frameLocator innerText sends frame_evaluate with frameSelectors", async () => {
    mock.commands.length = 0;
    // mock browser.dom.query for _resolveSelector
    const transportWithResolve = {
      ...mock,
      async command(name, args = {}) {
        if (name === "browser.dom.query") {
          return { elements: [{ selector: "#btn" }] };
        }
        return mock.command(name, args);
      },
    };
    const client2 = createLink2ChromeClient({ transport: transportWithResolve });
    const browser2 = await client2.browsers.get("extension");
    const tabs2 = await browser2.tabs.list();
    const tab2 = tabs2[0];
    await tab2.playwright.frameLocator("#f").locator("#btn").innerText();
    const cmd = mock.commands.find((c) => c.name === "frame_evaluate");
    assertTrue(cmd !== undefined, "frame_evaluate should be called for innerText in frame");
    assertEqual(cmd.args.frameSelectors, ["#f"], "frame_evaluate should carry frameSelectors");
  });

  // === background.js 静态断言 ===
  await test("node --check runtime/link2chrome-client.mjs passes", () => {
    try {
      execSync("node --check runtime/link2chrome-client.mjs", { cwd: join(__dirname, ".."), stdio: "pipe" });
    } catch (err) {
      throw new Error("node --check runtime/link2chrome-client.mjs failed: " + err.message);
    }
  });

  await test("node --check extension/background.js passes", () => {
    try {
      execSync("node --check extension/background.js", { cwd: join(__dirname, ".."), stdio: "pipe" });
    } catch (err) {
      throw new Error("node --check extension/background.js failed: " + err.message);
    }
  });

  await test("background.js contains cmdFrameEvaluate function", () => {
    assertTrue(/function\s+cmdFrameEvaluate\s*\(/.test(bgSource), "cmdFrameEvaluate not found");
  });

  await test("background.js command table includes frame_evaluate", () => {
    assertIncludes(bgSource, 'case "frame_evaluate":', "command table missing frame_evaluate");
  });

  await test("background.js cmdFrameEvaluate includes cross-origin error", () => {
    assertIncludes(bgSource, "cross-origin iframe not supported", "cross-origin error message missing");
  });

  await test("background.js cmdFrameEvaluate includes Frame not found error", () => {
    assertIncludes(bgSource, "Frame not found", "Frame not found error message missing");
  });

  // ---------------------------------------------------------------------------
  // 汇总
  // ---------------------------------------------------------------------------
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
