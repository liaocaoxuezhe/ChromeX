/**
 * task-8: 下载事件 waitForEvent("download") + downloadMedia（P1-2）
 * Node 离线 mock transport 断言 + background.js 静态检查
 *
 * 运行方式:
 *     node test/test_task8_download.mjs
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
const MANIFEST_PATH = join(__dirname, "..", "extension", "manifest.json");
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));

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
        return { elements: [{ selector: "img#logo" }] };
      }
      if (name === "script_evaluate") {
        commands.push({ name, args });
        return { result: "https://example.com/image.png" };
      }
      if (name === "wait_for_download") {
        commands.push({ name, args });
        return {
          ok: true,
          download: {
            guid: "test-guid-123",
            url: "https://example.com/file.zip",
            suggestedFilename: "file.zip",
          },
        };
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

  // === waitForEvent("download") 存在性 ===
  await test("waitForEvent('download') sends wait_for_download command", async () => {
    mock.commands.length = 0;
    const result = await tab.playwright.waitForEvent("download");
    const cmd = mock.commands.find((c) => c.name === "wait_for_download");
    assertTrue(cmd !== undefined, "wait_for_download should be called");
    assertEqual(result.download.guid, "test-guid-123", "download guid mismatch");
    assertEqual(result.download.url, "https://example.com/file.zip", "download url mismatch");
  });

  await test("waitForEvent('download') passes timeout correctly", async () => {
    mock.commands.length = 0;
    await tab.playwright.waitForEvent("download", { timeoutMs: 15000 });
    const cmd = mock.commands.find((c) => c.name === "wait_for_download");
    assertTrue(cmd !== undefined, "wait_for_download should be called");
    assertEqual(cmd.args.timeout, 15000, "timeout parameter mismatch");
  });

  await test("waitForEvent('download') uses default timeout when not specified", async () => {
    mock.commands.length = 0;
    await tab.playwright.waitForEvent("download");
    const cmd = mock.commands.find((c) => c.name === "wait_for_download");
    assertTrue(cmd !== undefined, "wait_for_download should be called");
    assertEqual(cmd.args.timeout, 30000, "default timeout mismatch");
  });

  // === filechooser 回归 ===
  await test("waitForEvent('filechooser') still returns FileChooser", async () => {
    const fc = await tab.playwright.waitForEvent("filechooser");
    assertTrue(typeof fc.setFiles === "function", "filechooser.setFiles should be a function");
  });

  // === Locator.downloadMedia 存在性 ===
  await test("Locator has downloadMedia method", () => {
    const loc = tab.playwright.locator("img");
    assertTrue(typeof loc.downloadMedia === "function", "downloadMedia missing");
  });

  await test("downloadMedia sends script_evaluate to get src/href", async () => {
    mock.commands.length = 0;
    const loc = tab.playwright.locator("img#logo");
    await loc.downloadMedia();
    const cmds = mock.commands.filter((c) => c.name === "script_evaluate");
    assertTrue(cmds.length >= 1, "script_evaluate should be called at least once");
    assertIncludes(cmds[0].args.script, "document.querySelector", "first script_evaluate should query element");
    assertIncludes(cmds[0].args.script, "el.src || el.href", "should read src or href");
  });

  await test("downloadMedia sends second script_evaluate to trigger download", async () => {
    mock.commands.length = 0;
    const loc = tab.playwright.locator("img#logo");
    await loc.downloadMedia({ suggestedFilename: "logo.png" });
    const cmds = mock.commands.filter((c) => c.name === "script_evaluate");
    assertTrue(cmds.length >= 2, "script_evaluate should be called twice");
    assertIncludes(cmds[1].args.script, "document.createElement('a')", "second script should create anchor");
    assertIncludes(cmds[1].args.script, "a.click()", "second script should click anchor");
  });

  await test("downloadMedia returns url and suggestedFilename", async () => {
    mock.commands.length = 0;
    const loc = tab.playwright.locator("img#logo");
    const result = await loc.downloadMedia({ suggestedFilename: "logo.png" });
    assertEqual(result.url, "https://example.com/image.png", "url mismatch");
    assertEqual(result.suggestedFilename, "logo.png", "suggestedFilename mismatch");
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

  await test("manifest.json is valid JSON with downloads permission", () => {
    assertTrue(Array.isArray(manifest.permissions), "permissions should be an array");
    assertTrue(manifest.permissions.includes("downloads"), "manifest should include downloads permission");
  });

  await test("background.js contains downloadState definition", () => {
    assertIncludes(bgSource, "downloadState", "downloadState missing");
    assertIncludes(bgSource, "pending: new Map()", "pending Map missing");
    assertIncludes(bgSource, "completed: new Map()", "completed Map missing");
  });

  await test("background.js contains Page.downloadWillBegin handler", () => {
    assertIncludes(bgSource, '"Page.downloadWillBegin"', "Page.downloadWillBegin handler missing");
  });

  await test("background.js contains Page.downloadProgress handler", () => {
    assertIncludes(bgSource, '"Page.downloadProgress"', "Page.downloadProgress handler missing");
  });

  await test("background.js contains setDownloadBehavior call with fallback", () => {
    assertIncludes(bgSource, "Browser.setDownloadBehavior", "setDownloadBehavior call missing");
    assertIncludes(bgSource, "setupDownloadsFallback", "downloads fallback missing");
  });

  await test("background.js command table includes wait_for_download", () => {
    assertIncludes(bgSource, 'case "wait_for_download":', "command table missing wait_for_download");
  });

  await test("background.js contains cmdWaitForDownload function", () => {
    assertTrue(/function\s+cmdWaitForDownload\s*\(/.test(bgSource), "cmdWaitForDownload not found");
  });

  await test("background.js contains chrome.downloads fallback listeners", () => {
    assertIncludes(bgSource, "chrome.downloads.onCreated.addListener", "onCreated listener missing");
    assertIncludes(bgSource, "chrome.downloads.onChanged.addListener", "onChanged listener missing");
  });

  // ---------------------------------------------------------------------------
  // 汇总
  // ---------------------------------------------------------------------------
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
