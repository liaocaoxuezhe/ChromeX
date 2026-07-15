import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const runtimeSource = readFileSync(
  new URL("../runtime/nodejs-playwright-runtime.mjs", import.meta.url),
  "utf8"
);

test("runtime keeps the bound tab when the same session still allows it", () => {
  assert.match(runtimeSource, /function\s+shouldResetBoundTab/);
  assert.doesNotMatch(
    runtimeSource,
    /async function bindRuntimeSession[\s\S]*?\n\s*globalThis\.tab = null;\n\}/
  );
});

test("startup summary binds the extension target without reading browser active state", () => {
  const startupSource = runtimeSource
    .split("async function collectStartupSummary()", 2)[1]
    .split("// ─── 结果序列化器", 1)[0];

  assert.doesNotMatch(startupSource, /raw\?\.active/);
  assert.match(startupSource, /await browser\.tabs\.selected\(\)/);
  assert.match(startupSource, /globalThis\.tab = selected;/);
  assert.match(startupSource, /summary\.source = "browser\.tabs\.selected";/);
  assert.doesNotMatch(startupSource, /if \(!hubConnected\) \{\n\s*summary\.source = "hub-unavailable";\n\s*return summary;\n\s*\}/);
});
