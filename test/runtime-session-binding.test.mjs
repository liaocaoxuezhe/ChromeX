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

test("startup summary restores globalThis.tab from session-scoped tabs", () => {
  assert.match(runtimeSource, /globalThis\.tab = active;/);
  assert.doesNotMatch(runtimeSource, /if \(!hubConnected\) \{\n\s*summary\.source = "hub-unavailable";\n\s*return summary;\n\s*\}/);
});
