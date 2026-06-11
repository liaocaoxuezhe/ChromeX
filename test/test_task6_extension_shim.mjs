/**
 * task-6: Extension createPageShim / Locator 降级路径补齐（P0-2）
 * Node 离线静态检查：正则断言 background.js 中 shim 区域包含全部新增方法名，
 * 且用户输入插值使用 JSON.stringify。
 *
 * 运行方式:
 *     node test/test_task6_extension_shim.mjs
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const BG_PATH = join(__dirname, "..", "extension", "background.js");
const source = readFileSync(BG_PATH, "utf-8");

let passed = 0;
let failed = 0;

function assertTrue(value, message) {
  if (!value) {
    console.error(`✗ ${message}`);
    failed++;
  } else {
    console.log(`✓ ${message}`);
    passed++;
  }
}

function assertIncludes(haystack, needle, message) {
  assertTrue(String(haystack).includes(needle), message || `expected to include "${needle}"`);
}

// ---------------------------------------------------------------------------
// 1. 语法检查
// ---------------------------------------------------------------------------
try {
  execSync("node --check extension/background.js", { cwd: join(__dirname, ".."), stdio: "pipe" });
  console.log("✓ node --check extension/background.js 通过");
  passed++;
} catch (err) {
  console.error("✗ node --check extension/background.js 失败");
  failed++;
}

// ---------------------------------------------------------------------------
// 辅助：提取函数体文本（简化版：从 "function name(...) {" 到下一个同层级的 "function " 或文件尾）
// ---------------------------------------------------------------------------
function extractFunctionBlock(src, funcName) {
  const startRe = new RegExp(`function\\s+${funcName}\\s*\\(`);
  const startMatch = startRe.exec(src);
  if (!startMatch) return null;

  // 1. 先跳过函数签名，找到参数列表结束的 ')'
  let parenCount = 0;
  let inString = false;
  let stringChar = null;
  let escaped = false;
  let templateExprDepth = 0;
  let i = startMatch.index + startMatch[0].length - 1; // 从 '(' 开始

  for (; i < src.length; i++) {
    const ch = src[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (!inString && (ch === "'" || ch === '"' || ch === "`")) {
      inString = true; stringChar = ch; continue;
    }
    if (inString) {
      if (stringChar === "`") {
        if (ch === "$" && src[i + 1] === "{") { templateExprDepth++; i++; continue; }
        if (templateExprDepth > 0) {
          if (ch === "{") { templateExprDepth++; continue; }
          if (ch === "}") { templateExprDepth--; continue; }
        }
        if (ch === "`") { inString = false; stringChar = null; }
        continue;
      }
      if (ch === stringChar) { inString = false; stringChar = null; }
      continue;
    }
    if (ch === "(") { parenCount++; continue; }
    if (ch === ")") {
      parenCount--;
      if (parenCount === 0) { i++; break; }
    }
  }

  // 2. 跳过空白，找到函数体的 '{'
  for (; i < src.length; i++) {
    if (/\s/.test(src[i])) continue;
    if (src[i] === "{") break;
    return null;
  }
  if (src[i] !== "{") return null;

  // 3. 从 '{' 开始匹配大括号
  let braceCount = 0;
  let started = false;
  inString = false;
  stringChar = null;
  escaped = false;
  templateExprDepth = 0;

  for (; i < src.length; i++) {
    const ch = src[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (!inString && (ch === "'" || ch === '"' || ch === "`")) {
      inString = true; stringChar = ch; continue;
    }
    if (inString) {
      if (stringChar === "`") {
        if (ch === "$" && src[i + 1] === "{") { templateExprDepth++; i++; continue; }
        if (templateExprDepth > 0) {
          if (ch === "{") { templateExprDepth++; continue; }
          if (ch === "}") { templateExprDepth--; continue; }
        }
        if (ch === "`") { inString = false; stringChar = null; }
        continue;
      }
      if (ch === stringChar) { inString = false; stringChar = null; }
      continue;
    }
    if (ch === "{") { started = true; braceCount++; continue; }
    if (ch === "}") {
      braceCount--;
      if (started && braceCount === 0) { i++; break; }
    }
  }
  return src.slice(startMatch.index, i);
}

const createLocatorBlock = extractFunctionBlock(source, "createLocator");
const createPageShimBlock = extractFunctionBlock(source, "createPageShim");
const createLocatorByTextBlock = extractFunctionBlock(source, "createLocatorByText");
const createLocatorByRoleBlock = extractFunctionBlock(source, "createLocatorByRole");
const createLocatorByLabelBlock = extractFunctionBlock(source, "createLocatorByLabel");

assertTrue(createLocatorBlock && createLocatorBlock.length > 0, "createLocator 函数体被提取");
assertTrue(createPageShimBlock && createPageShimBlock.length > 0, "createPageShim 函数体被提取");

// ---------------------------------------------------------------------------
// 2. createLocator 新增方法存在性断言
// ---------------------------------------------------------------------------
const locatorMethods = [
  "and", "or", "filter", "first", "last", "nth",
  "count", "textContent", "allTextContents", "getAttribute",
  "isVisible", "isEnabled", "check", "uncheck", "setChecked",
  "selectOption", "hover", "dblclick", "press",
];
for (const m of locatorMethods) {
  assertIncludes(createLocatorBlock, `${m}:`, `createLocator 包含方法 ${m}`);
}

// ---------------------------------------------------------------------------
// 3. createLocatorByText / ByRole / ByLabel 新增方法存在性断言
// ---------------------------------------------------------------------------
const derivedBlocks = [
  { name: "createLocatorByText", block: createLocatorByTextBlock },
  { name: "createLocatorByRole", block: createLocatorByRoleBlock },
  { name: "createLocatorByLabel", block: createLocatorByLabelBlock },
];
for (const { name, block } of derivedBlocks) {
  assertTrue(block && block.length > 0, `${name} 函数体被提取`);
  for (const m of locatorMethods) {
    assertIncludes(block, `${m}:`, `${name} 包含方法 ${m}`);
  }
}

// ---------------------------------------------------------------------------
// 4. createPageShim 新增方法存在性断言 + 原有 12 个方法回归
// ---------------------------------------------------------------------------
const pageNewMethods = ["getByTestId", "waitForLoadState", "waitForURL", "expectNavigation"];
for (const m of pageNewMethods) {
  assertIncludes(createPageShimBlock, `${m}:`, `createPageShim 包含方法 ${m}`);
}

const pageOriginalMethods = [
  "goto", "title", "url", "locator", "getByText", "getByRole",
  "getByLabel", "getByPlaceholder", "waitForSelector", "waitForTimeout",
  "evaluate", "screenshot",
];
for (const m of pageOriginalMethods) {
  assertIncludes(createPageShimBlock, `${m}:`, `createPageShim 保留原方法 ${m}`);
}

// ---------------------------------------------------------------------------
// 5. plan 验收脚本 1/2 调用形态存在性断言
// ---------------------------------------------------------------------------
assertTrue(createLocatorBlock.includes("first:") && createLocatorBlock.includes("click:"), "支持 locator().first().click() 形态");
assertTrue(createLocatorBlock.includes("filter:") && createLocatorBlock.includes("hasText"), "支持 filter({hasText}).fill() 形态");
assertTrue(createLocatorByTextBlock.includes("and:") && createLocatorByTextBlock.includes("click:"), "支持 getByText().and().click() 形态");
assertTrue(createLocatorBlock.includes("count:"), "支持 count() 形态");
assertTrue(createLocatorBlock.includes("allTextContents:"), "支持 allTextContents() 形态");
assertTrue(createLocatorBlock.includes("check:"), "支持 check() 形态");
assertTrue(createLocatorBlock.includes("selectOption:"), "支持 selectOption() 形态");

// ---------------------------------------------------------------------------
// 6. JSON.stringify 插值抽查
// ---------------------------------------------------------------------------
// selectOption 中 value 应经 JSON.stringify
assertIncludes(createLocatorBlock, "el.value = ${JSON.stringify(value)}", "createLocator selectOption 使用 JSON.stringify 插值 value");
assertIncludes(createLocatorByTextBlock, "el.value = ${JSON.stringify(value)}", "createLocatorByText selectOption 使用 JSON.stringify 插值 value");

// filter 中 hasText 应经 JSON.stringify
assertIncludes(createLocatorBlock, "el.textContent.includes(${JSON.stringify(hasText)})", "createLocator filter 使用 JSON.stringify 插值 hasText");
assertIncludes(createLocatorByTextBlock, "el.textContent.includes(${JSON.stringify(hasText)})", "createLocatorByText filter 使用 JSON.stringify 插值 hasText");

// getAttribute 中 name 应经 JSON.stringify
assertIncludes(createLocatorBlock, "el.getAttribute(${JSON.stringify(name)})", "createLocator getAttribute 使用 JSON.stringify 插值 name");
assertIncludes(createLocatorByRoleBlock, "el.getAttribute(${JSON.stringify(name)})", "createLocatorByRole getAttribute 使用 JSON.stringify 插值 name");

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
