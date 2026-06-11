/**
 * task-13: SKILL.md 零虚构校验 + 淘汰写法检查
 *
 * 运行方式: node test/test_task13_skill_doc.mjs
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

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

async function test(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}: ${error.message}`);
  }
}

// ============================================================================
// 读取文件
// ============================================================================
const skillPath = join(ROOT, "skills", "link2chrome-browser-mcp", "SKILL.md");
const parityPath = join(ROOT, "test", "test_codex_api_parity.mjs");

const skillContent = readFileSync(skillPath, "utf-8");
const parityContent = readFileSync(parityPath, "utf-8");

// ============================================================================
// 1. 提取 SKILL.md 代码块中的方法调用名
// ============================================================================
function extractMethodCallsFromCodeBlocks(markdown) {
  const calls = new Set();
  // 匹配 ```js ... ``` 或 ```javascript ... ``` 代码块
  const codeBlockRegex = /```(?:js|javascript)\n([\s\S]*?)```/g;
  const JS_BUILTINS = new Set([
    "log", "error", "warn", "info", "min", "max", "abs", "floor", "ceil", "round",
    "push", "pop", "shift", "unshift", "slice", "splice", "concat", "join", "map",
    "filter", "reduce", "forEach", "find", "includes", "indexOf", "sort", "reverse",
    "keys", "values", "entries", "from", "of", "then", "catch", "finally",
    "toString", "toFixed", "parseInt", "parseFloat", "json", "stringify",
    "exec", "test", "match", "replace", "split", "trim", "substring", "substr",
    "charAt", "charCodeAt", "toLowerCase", "toUpperCase", "startsWith", "endsWith",
    "padStart", "padEnd", "repeat", "codePointAt", "fromCharCode", "fromCodePoint",
    "isInteger", "isFinite", "isNaN", "random", "pow", "sqrt", "cbrt", "sign",
    "trunc", "exp", "ln", "log10", "log2", "sin", "cos", "tan", "asin", "acos", "atan",
    "atan2", "hypot", "imul", "clz32", "fround", "expm1", "log1p",
    "setPrototypeOf", "getPrototypeOf", "defineProperty", "getOwnPropertyDescriptor",
    "getOwnPropertyNames", "getOwnPropertySymbols", "preventExtensions", "isExtensible",
    "isSealed", "isFrozen", "seal", "freeze", "assign", "create", "keys", "values",
    "entries", "fromEntries", "hasOwn", "is", "now", "toISOString", "toUTCString",
    "getTime", "getFullYear", "getMonth", "getDate", "getDay", "getHours", "getMinutes",
    "getSeconds", "getMilliseconds", "setTime", "setFullYear", "setMonth", "setDate",
    "setHours", "setMinutes", "setSeconds", "setMilliseconds",
    "getUTC", "setUTC", "toDateString", "toTimeString", "toLocaleString",
    "toLocaleDateString", "toLocaleTimeString",
    "every", "some", "findIndex", "fill", "copyWithin", "flat", "flatMap", "at",
    "add", "delete", "clear", "has", "get", "set", "forEach",
    "next", "return", "throw", "value", "done",
    "resolve", "reject", "all", "allSettled", "race", "any",
    "apply", "call", "bind", "toSource", "arguments", "caller",
    "length", "name", "prototype", "constructor",
  ]);
  let match;
  while ((match = codeBlockRegex.exec(markdown)) !== null) {
    const code = match[1];
    // 匹配 .methodName( 形态
    const methodRegex = /\.([a-zA-Z_][a-zA-Z0-9_]*)\(/g;
    let m;
    while ((m = methodRegex.exec(code)) !== null) {
      const method = m[1];
      if (!JS_BUILTINS.has(method)) {
        calls.add(method);
      }
    }
  }
  return Array.from(calls);
}

const methodCalls = extractMethodCallsFromCodeBlocks(skillContent);

// ============================================================================
// 2. 零虚构校验：每个方法调用必须在 parity 测试中存在
// ============================================================================
await test("零虚构校验：SKILL.md 代码块中的方法调用都在 parity 测试中", () => {
  const missing = [];
  for (const method of methodCalls) {
    // 在 parity 测试文件中搜索该方法名
    // 方法可能在 addAssertion、测试描述、或代码中
    const found = parityContent.includes(`"${method}"`) ||
      parityContent.includes(`'.${method}'`) ||
      parityContent.includes(`.${method}`);
    if (!found) {
      missing.push(method);
    }
  }
  assertTrue(missing.length === 0, `SKILL.md 中的方法未在 parity 测试中找到: ${missing.join(", ")}`);
});

// ============================================================================
// 3. 淘汰写法检查
// ============================================================================
const BANNED_PATTERNS = [
  { pattern: /link2chrome\.browsers/, desc: "link2chrome.browsers" },
  { pattern: /["']dom-ready["']/, desc: "dom-ready" },
  { pattern: /tab\.goBack\(/, desc: "tab.goBack(" },
  { pattern: /cua\.click\(\s*[0-9]/, desc: "cua.click(x" },
  { pattern: /自动降级/, desc: "自动降级" },
];

await test("淘汰写法检查：SKILL.md 不含旧写法", () => {
  const found = [];
  for (const { pattern, desc } of BANNED_PATTERNS) {
    if (pattern.test(skillContent)) {
      found.push(desc);
    }
  }
  assertTrue(found.length === 0, `SKILL.md 中发现淘汰写法: ${found.join(", ")}`);
});

// ============================================================================
// 4. 必备章节检查
// ============================================================================
const REQUIRED_SECTIONS = [
  "Bootstrap",
  "文档自学习",
  "Tab Management",
  "API Use Behavior",
  "Snapshot Discipline",
  "Locator 策略",
  "错误恢复",
  "Browser Safety",
];

await test("必备章节检查", () => {
  const missing = [];
  for (const section of REQUIRED_SECTIONS) {
    if (!skillContent.includes(section)) {
      missing.push(section);
    }
  }
  assertTrue(missing.length === 0, `SKILL.md 缺少必备章节: ${missing.join(", ")}`);
});

// ============================================================================
// 5. 状态值检查：waitForLoadState 使用正确状态名
// ============================================================================
await test("状态值检查：使用 domcontentloaded 而非 dom-ready", () => {
  assertTrue(!skillContent.includes("dom-ready"), "SKILL.md 包含 dom-ready");
  assertTrue(skillContent.includes("domcontentloaded"), "SKILL.md 应包含 domcontentloaded");
});

// ============================================================================
// 6. 代码示例风格检查：使用 agent.browsers.get
// ============================================================================
await test("代码风格检查：Bootstrap 示例使用 agent.browsers.get", () => {
  assertTrue(skillContent.includes("agent.browsers.get"), "SKILL.md 应包含 agent.browsers.get");
});

// ============================================================================
// 汇总
// ============================================================================
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
