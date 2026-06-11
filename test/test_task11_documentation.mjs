/**
 * task-11: documentation 文档体系（P1-3 + 8.1）
 * Node 离线断言：browser.documentation()、createDocumentationSurface()、文档存在性与内容抽查。
 *
 * 运行方式:
 *     node test/test_task11_documentation.mjs
 */

import {
  createLink2ChromeClient,
  createDocumentationSurface,
  setupLink2ChromeRuntime,
} from "../runtime/link2chrome-client.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";

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
  const transport = mockTransport();
  const client = createLink2ChromeClient({ transport });
  const browser = await client.browsers.get("extension");

  // === (A) browser.documentation() 返回 api.md 内容，长度 >= 5000 ===
  await test("browser.documentation() returns string with length >= 5000", async () => {
    const doc = await browser.documentation();
    assertTrue(typeof doc === "string", "documentation() should return a string");
    assertTrue(doc.length >= 5000, `documentation() length ${doc.length} < 5000`);
    assertTrue(/## /.test(doc), "documentation() should contain Markdown headings");
  });

  // === (B) createDocumentationSurface().get() 支持 6 个名称 ===
  const docNames = [
    "api",
    "playwright",
    "screenshots",
    "confirmations",
    "file-management",
    "api-troubleshooting",
    "chrome-troubleshooting",
    "capabilities/tab/pageAssets",
  ];

  for (const name of docNames) {
    await test(`documentation.get("${name}") returns non-empty string`, async () => {
      const docs = createDocumentationSurface();
      const content = await docs.get(name);
      assertTrue(typeof content === "string", "should return string");
      assertTrue(content.length > 0, "should return non-empty string");
    });
  }

  // === (C) get('nonexistent') throws with available names list ===
  await test("documentation.get('nonexistent') throws error with available list", async () => {
    const docs = createDocumentationSurface();
    let thrown = false;
    let message = "";
    try {
      await docs.get("nonexistent");
    } catch (error) {
      thrown = true;
      message = error?.message || String(error);
    }
    assertTrue(thrown, "should throw");
    assertTrue(message.includes('"nonexistent" not found'), `message should indicate not found: ${message}`);
    assertTrue(message.includes("api"), `message should list available names: ${message}`);
    assertTrue(message.includes("playwright"), `message should list playwright: ${message}`);
  });

  // === (D) api.md content spot-checks ===
  await test("api.md contains frameLocator", async () => {
    const docs = createDocumentationSurface();
    const api = await docs.get("api");
    assertIncludes(api, "frameLocator", "api.md should mention frameLocator");
  });

  await test("api.md contains waitForEvent", async () => {
    const docs = createDocumentationSurface();
    const api = await docs.get("api");
    assertIncludes(api, "waitForEvent", "api.md should mention waitForEvent");
  });

  await test("api.md contains get_visible_dom", async () => {
    const docs = createDocumentationSurface();
    const api = await docs.get("api");
    assertIncludes(api, "get_visible_dom", "api.md should mention get_visible_dom");
  });

  await test("api.md contains innerText", async () => {
    const docs = createDocumentationSurface();
    const api = await docs.get("api");
    assertIncludes(api, "innerText", "api.md should mention innerText");
  });

  await test("api.md contains capabilities", async () => {
    const docs = createDocumentationSurface();
    const api = await docs.get("api");
    assertIncludes(api, "capabilities", "api.md should mention capabilities");
  });

  await test("api.md contains downloadMedia", async () => {
    const docs = createDocumentationSurface();
    const api = await docs.get("api");
    assertIncludes(api, "downloadMedia", "api.md should mention downloadMedia");
  });

  // === (E) agent.documentation.get('api') 正常返回（task-1 占位已移除）===
  await test("agent.documentation.get('api') returns real content", async () => {
    const { agent } = setupLink2ChromeRuntime({
      globals: {},
      transport,
      overwrite: true,
    });
    assertTrue(typeof agent.documentation.get === "function", "agent.documentation.get should be a function");
    const content = await agent.documentation.get("api");
    assertTrue(typeof content === "string", "should return string");
    assertTrue(content.length >= 5000, `length ${content.length} < 5000`);
  });

  // === (F) node --check passes for modified .mjs files ===
  await test("node --check runtime/link2chrome-client.mjs passes", () => {
    try {
      execSync("node --check runtime/link2chrome-client.mjs", { cwd: join(__dirname, ".."), stdio: "pipe" });
    } catch (err) {
      throw new Error("node --check runtime/link2chrome-client.mjs failed: " + err.message);
    }
  });

  await test("node --check runtime/nodejs-playwright-runtime.mjs passes", () => {
    try {
      execSync("node --check runtime/nodejs-playwright-runtime.mjs", { cwd: join(__dirname, ".."), stdio: "pipe" });
    } catch (err) {
      throw new Error("node --check runtime/nodejs-playwright-runtime.mjs failed: " + err.message);
    }
  });

  // === (G) api.md methods exist in client source ===
  const clientSource = readFileSync(join(__dirname, "..", "runtime", "link2chrome-client.mjs"), "utf-8");
  const methodsToCheck = [
    "frameLocator",
    "waitForEvent",
    "get_visible_dom",
    "innerText",
    "capabilities",
    "downloadMedia",
    "createDocumentationSurface",
    "documentation()",
    "getByTestId",
    "setChecked",
  ];

  for (const method of methodsToCheck) {
    await test(`client source contains ${method}`, () => {
      assertTrue(
        clientSource.includes(method),
        `link2chrome-client.mjs should contain ${method}`
      );
    });
  }

  // ---------------------------------------------------------------------------
  // 汇总
  // ---------------------------------------------------------------------------
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
