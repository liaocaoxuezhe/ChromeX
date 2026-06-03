import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getChromeNativeMessagingManifestPath,
  installNativeHostManifest,
} from "../native-host/installManifest.mjs";

export function computeExtensionIdFromKey(key) {
  const der = Buffer.from(String(key).replace(/\s+/g, ""), "base64");
  const digest = crypto.createHash("sha256").update(der).digest();
  return [...digest.subarray(0, 16)]
    .map((byte) => `${String.fromCharCode(97 + (byte >> 4))}${String.fromCharCode(97 + (byte & 0x0f))}`)
    .join("");
}

export function createDevExtensionInstallPlan({
  projectRoot,
  manifest,
  homeDir = os.homedir(),
} = {}) {
  if (!projectRoot) {
    throw new Error("createDevExtensionInstallPlan requires projectRoot");
  }
  if (!manifest?.key) {
    throw new Error("extension manifest must include a stable key");
  }
  const extensionId = computeExtensionIdFromKey(manifest.key);
  return {
    extensionId,
    extensionDir: path.join(projectRoot, "extension"),
    hostPath: path.join(projectRoot, "scripts", "native-host", "native-host.mjs"),
    manifestPath: getChromeNativeMessagingManifestPath({ homeDir }),
  };
}

export async function installDevExtensionBootstrap({
  projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."),
  homeDir = os.homedir(),
  readFile = fs.promises.readFile,
  chmod = fs.promises.chmod,
} = {}) {
  const manifestPath = path.join(projectRoot, "extension", "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const plan = createDevExtensionInstallPlan({ projectRoot, manifest, homeDir });
  await chmod(plan.hostPath, 0o755);
  const nativeHost = await installNativeHostManifest({
    hostPath: plan.hostPath,
    extensionId: plan.extensionId,
    manifestPath: plan.manifestPath,
  });
  return { ok: true, ...plan, nativeHost };
}

async function main() {
  const result = await installDevExtensionBootstrap();
  console.log(JSON.stringify({
    ok: result.ok,
    extensionId: result.extensionId,
    extensionDir: result.extensionDir,
    nativeHostManifest: result.manifestPath,
    next: [
      "打开 chrome://extensions",
      "开启开发者模式",
      `加载已解压扩展: ${result.extensionDir}`,
      "打开扩展 popup，确认 Native Host 和 Browser Hub 为已连接",
    ],
  }, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message || String(error));
    process.exitCode = 1;
  });
}
