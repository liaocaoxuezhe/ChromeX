/**
 * task-9: 完整剪贴板 clipboard.read / write（P2-1）
 * Node 离线 mock transport 断言 + background.js 静态检查
 *
 * 运行方式:
 *     node test/test_task9_clipboard.mjs
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
      if (name === "browser.clipboard.read") {
        commands.push({ name, args });
        return [
          {
            entries: [
              { mimeType: "text/plain", text: "hello clipboard" },
            ],
          },
        ];
      }
      if (name === "browser.clipboard.write") {
        commands.push({ name, args });
        return { ok: true };
      }
      if (name === "browser.clipboard.readText") {
        commands.push({ name, args });
        return "hello text";
      }
      if (name === "browser.clipboard.writeText") {
        commands.push({ name, args });
        return { ok: true };
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

  // 注入记录式 safety mock
  const confirmCalls = [];
  const originalConfirm = tab._safety.confirm.bind(tab._safety);
  tab._safety.confirm = async (action) => {
    confirmCalls.push(action);
    return true;
  };

  // === read() 存在性与命令名 ===
  await test("ClipboardSurface has read method", () => {
    assertTrue(typeof tab.clipboard.read === "function", "read missing");
  });

  await test("read() sends browser.clipboard.read command", async () => {
    mock.commands.length = 0;
    const result = await tab.clipboard.read();
    const cmd = mock.commands.find((c) => c.name === "browser.clipboard.read");
    assertTrue(cmd !== undefined, "browser.clipboard.read should be called");
    assertTrue(Array.isArray(result), "read should return an array");
    assertEqual(result[0].entries[0].mimeType, "text/plain", "mimeType mismatch");
    assertEqual(result[0].entries[0].text, "hello clipboard", "text mismatch");
  });

  // === write(items) 存在性、命令名、safety.confirm ===
  await test("ClipboardSurface has write method", () => {
    assertTrue(typeof tab.clipboard.write === "function", "write missing");
  });

  await test("write(items) sends browser.clipboard.write with items", async () => {
    mock.commands.length = 0;
    confirmCalls.length = 0;
    const items = [
      {
        entries: [
          { mimeType: "text/plain", text: "test write" },
        ],
      },
    ];
    const result = await tab.clipboard.write(items);
    const cmd = mock.commands.find((c) => c.name === "browser.clipboard.write");
    assertTrue(cmd !== undefined, "browser.clipboard.write should be called");
    assertEqual(cmd.args.items, items, "items should be passed through");
    assertEqual(result.ok, true, "write should return ok");
  });

  await test("write(items) calls safety.confirm before sending command", async () => {
    mock.commands.length = 0;
    confirmCalls.length = 0;
    const items = [
      {
        entries: [
          { mimeType: "image/png", base64: "iVBORw0KGgo=" },
        ],
      },
    ];
    await tab.clipboard.write(items);
    const writeCall = confirmCalls.find((c) => c.type === "clipboard.write");
    assertTrue(writeCall !== undefined, "safety.confirm should be called with type clipboard.write");
    assertEqual(writeCall.items, items, "confirm should receive items");
    // 确认 safety.confirm 在 command 之前调用
    const cmdIndex = mock.commands.findIndex((c) => c.name === "browser.clipboard.write");
    assertTrue(cmdIndex >= 0, "command should be recorded");
  });

  // === readText / writeText 回归 ===
  await test("readText() still sends browser.clipboard.readText", async () => {
    mock.commands.length = 0;
    const result = await tab.clipboard.readText();
    const cmd = mock.commands.find((c) => c.name === "browser.clipboard.readText");
    assertTrue(cmd !== undefined, "browser.clipboard.readText should be called");
    assertEqual(result, "hello text", "readText result mismatch");
  });

  await test("writeText(text) still sends browser.clipboard.writeText", async () => {
    mock.commands.length = 0;
    confirmCalls.length = 0;
    const result = await tab.clipboard.writeText("hello", { safety: { level: "no-confirm" } });
    const cmd = mock.commands.find((c) => c.name === "browser.clipboard.writeText");
    assertTrue(cmd !== undefined, "browser.clipboard.writeText should be called");
    assertEqual(cmd.args.text, "hello", "text mismatch");
    assertEqual(result.ok, true, "writeText result mismatch");
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

  await test("background.js command table includes browser.clipboard.read", () => {
    assertIncludes(bgSource, 'case "browser.clipboard.read":', "command table missing browser.clipboard.read");
  });

  await test("background.js command table includes browser.clipboard.write", () => {
    assertIncludes(bgSource, 'case "browser.clipboard.write":', "command table missing browser.clipboard.write");
  });

  await test("background.js contains cmdClipboardRead function", () => {
    assertTrue(/function\s+cmdClipboardRead\s*\(/.test(bgSource), "cmdClipboardRead not found");
  });

  await test("background.js contains cmdClipboardWrite function", () => {
    assertTrue(/function\s+cmdClipboardWrite\s*\(/.test(bgSource), "cmdClipboardWrite not found");
  });

  await test("background.js cmdClipboardRead handles NotAllowedError", () => {
    assertIncludes(bgSource, "NotAllowedError", "cmdClipboardRead missing NotAllowedError handling");
    assertIncludes(bgSource, "剪贴板访问被拒绝", "cmdClipboardRead missing Chinese error message");
  });

  await test("background.js cmdClipboardWrite handles NotAllowedError", () => {
    assertIncludes(bgSource, "NotAllowedError", "cmdClipboardWrite missing NotAllowedError handling");
    assertIncludes(bgSource, "剪贴板访问被拒绝", "cmdClipboardWrite missing Chinese error message");
  });

  await test("background.js clipboard commands check secure context", () => {
    assertIncludes(bgSource, "isSecureContext", "clipboard commands should check isSecureContext");
    assertIncludes(bgSource, "localhost", "clipboard commands should mention localhost fallback");
  });

  // ---------------------------------------------------------------------------
  // 汇总
  // ---------------------------------------------------------------------------
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
