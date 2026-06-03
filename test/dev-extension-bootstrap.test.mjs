import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  computeExtensionIdFromKey,
  createDevExtensionInstallPlan,
} from "../scripts/dev-extension/install.mjs";

const root = process.cwd();

test("extension manifest declares a stable key and native messaging permission", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "extension/manifest.json"), "utf8"));

  assert.equal(typeof manifest.key, "string");
  assert.ok(manifest.permissions.includes("nativeMessaging"));
});

test("background service worker bootstraps Browser Hub through native messaging before websocket", () => {
  const source = fs.readFileSync(path.join(root, "extension/background.js"), "utf8");

  assert.match(source, /chrome\.runtime\.connectNative\("com\.link2chrome\.nativehost"\)/);
  assert.match(source, /__native_start_hub__/);
  assert.match(source, /connectNativeBootstrap\(\).*connectWebSocket/s);
});

test("dev extension install plan derives extension id from manifest key", () => {
  const manifest = {
    key: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArwIDAQAB",
  };
  const plan = createDevExtensionInstallPlan({
    projectRoot: "/repo/Link2Chrome",
    manifest,
    homeDir: "/Users/alice",
  });

  assert.match(plan.extensionId, /^[a-p]{32}$/);
  assert.equal(plan.hostPath, "/repo/Link2Chrome/scripts/native-host/native-host.mjs");
  assert.equal(
    plan.manifestPath,
    "/Users/alice/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.link2chrome.nativehost.json"
  );
});

test("extension id computation is stable for a manifest key", () => {
  const key = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArwIDAQAB";

  assert.equal(computeExtensionIdFromKey(key), computeExtensionIdFromKey(key));
});
