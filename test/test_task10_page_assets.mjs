/**
 * task-10: pageAssets 页面资源能力（P2-2）
 * Node 离线 mock transport 断言 + background.js 静态检查
 *
 * 运行方式:
 *     node test/test_task10_page_assets.mjs
 */

import { createLink2ChromeClient } from "../runtime/link2chrome-client.mjs";
import { readFileSync, rmSync, existsSync, readFileSync as readFile } from "node:fs";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const BG_PATH = join(__dirname, "..", "extension", "background.js");
const bgSource = readFileSync(BG_PATH, "utf-8");

function createMockTransport() {
  const commands = [];
  return {
    commands,
    async command(name, args = {}) {
      commands.push({ name, args });
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
      if (name === "page_assets_list") {
        return [
          { name: "https://example.com/style.css", type: "stylesheet", size: 1024 },
          { name: "https://example.com/image.png", type: "img", size: 2048 },
        ];
      }
      if (name === "page_assets_bundle") {
        return {
          assets: [
            { name: "https://example.com/style.css", base64: "Ym9keXtjb2xvcjpyZWR9", mimeType: "text/css" },
            { name: "https://example.com/image.png", base64: "iVBORw0KGgo=", mimeType: "image/png" },
          ],
          errors: [
            { name: "https://example.com/fail.css", reason: "fetch failed" },
          ],
        };
      }
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

  // === capabilities.list() 包含 pageAssets ===
  await test("tab.capabilities.list() contains pageAssets", async () => {
    const list = await tab.capabilities.list();
    const found = list.find((c) => c.id === "pageAssets");
    assertTrue(found !== undefined, "pageAssets should be in capabilities list");
    assertTrue(found.description.includes("资源"), "description should mention resources");
  });

  // === get('pageAssets') 实例有 list/bundle/documentation ===
  await test("pageAssets capability has list method", async () => {
    const cap = await tab.capabilities.get("pageAssets");
    assertTrue(typeof cap.list === "function", "list missing");
  });

  await test("pageAssets capability has bundle method", async () => {
    const cap = await tab.capabilities.get("pageAssets");
    assertTrue(typeof cap.bundle === "function", "bundle missing");
  });

  await test("pageAssets capability has documentation method", async () => {
    const cap = await tab.capabilities.get("pageAssets");
    assertTrue(typeof cap.documentation === "function", "documentation missing");
    const doc = await cap.documentation();
    assertTrue(typeof doc === "string", "documentation should return string");
    assertTrue(doc.includes("pageAssets"), "doc should mention pageAssets");
  });

  // === list() 发出 page_assets_list 命令 ===
  await test("list() sends page_assets_list command", async () => {
    mock.commands.length = 0;
    const cap = await tab.capabilities.get("pageAssets");
    const result = await cap.list();
    const cmd = mock.commands.find((c) => c.name === "page_assets_list");
    assertTrue(cmd !== undefined, "page_assets_list should be called");
    assertTrue(Array.isArray(result), "list should return array");
    assertEqual(result.length, 2, "should return 2 items");
    assertEqual(result[0].type, "stylesheet", "first item type mismatch");
  });

  // === bundle() 写出文件并验证内容 ===
  const outputDir = join(tmpdir(), `link2chrome-task10-${Date.now()}`);
  await test("bundle() writes files to outputDir with correct content", async () => {
    mock.commands.length = 0;
    const cap = await tab.capabilities.get("pageAssets");
    const result = await cap.bundle({ outputDir });

    const cmd = mock.commands.find((c) => c.name === "page_assets_bundle");
    assertTrue(cmd !== undefined, "page_assets_bundle should be called");

    assertTrue(existsSync(outputDir), "outputDir should exist");
    assertTrue(Array.isArray(result.files), "result.files should be array");
    assertEqual(result.files.length, 2, "should write 2 files");
    assertEqual(result.outputDir, outputDir, "outputDir mismatch");

    // Verify file contents
    const stylePath = result.files.find((p) => p.includes("style.css"));
    const imagePath = result.files.find((p) => p.includes("image.png"));
    assertTrue(stylePath !== undefined, "style.css should be written");
    assertTrue(imagePath !== undefined, "image.png should be written");

    const styleContent = readFile(stylePath, "utf-8");
    assertEqual(styleContent, "body{color:red}", "style.css content mismatch");

    const imageContent = readFile(imagePath);
    const expectedImage = Buffer.from("iVBORw0KGgo=", "base64");
    assertTrue(imageContent.equals(expectedImage), "image.png content mismatch");

    // errors should be passed through
    assertTrue(Array.isArray(result.errors), "result.errors should be array");
    assertEqual(result.errors.length, 1, "should have 1 error");
    assertEqual(result.errors[0].name, "https://example.com/fail.css", "error name mismatch");
  });

  // Cleanup
  try {
    rmSync(outputDir, { recursive: true, force: true });
  } catch {}

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

  await test("background.js command table includes page_assets_list", () => {
    assertIncludes(bgSource, 'case "page_assets_list":', "command table missing page_assets_list");
  });

  await test("background.js command table includes page_assets_bundle", () => {
    assertIncludes(bgSource, 'case "page_assets_bundle":', "command table missing page_assets_bundle");
  });

  await test("background.js contains cmdPageAssetsList function", () => {
    assertTrue(/function\s+cmdPageAssetsList\s*\(/.test(bgSource), "cmdPageAssetsList not found");
  });

  await test("background.js contains cmdPageAssetsBundle function", () => {
    assertTrue(/function\s+cmdPageAssetsBundle\s*\(/.test(bgSource), "cmdPageAssetsBundle not found");
  });

  await test("background.js cmdPageAssetsList uses performance.getEntriesByType", () => {
    assertIncludes(bgSource, 'performance.getEntriesByType("resource")', "cmdPageAssetsList missing performance.getEntriesByType");
  });

  await test("background.js cmdPageAssetsBundle has size limit", () => {
    assertIncludes(bgSource, "50 * 1024 * 1024", "cmdPageAssetsBundle missing 50MB size limit");
  });

  await test("background.js cmdPageAssetsBundle has errors array", () => {
    assertIncludes(bgSource, "const errors = []", "cmdPageAssetsBundle missing errors array");
    assertIncludes(bgSource, "errors.push", "cmdPageAssetsBundle missing errors.push");
  });

  await test("background.js cmdPageAssetsBundle filters by urls", () => {
    assertIncludes(bgSource, "urls", "cmdPageAssetsBundle missing urls filtering");
  });

  // ---------------------------------------------------------------------------
  // 汇总
  // ---------------------------------------------------------------------------
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
