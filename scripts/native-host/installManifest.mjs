import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HOST_NAME = "com.link2chrome.nativehost";

export function getChromeNativeMessagingManifestPath({
  homeDir = os.homedir(),
  hostName = HOST_NAME,
} = {}) {
  return path.join(
    homeDir,
    "Library",
    "Application Support",
    "Google",
    "Chrome",
    "NativeMessagingHosts",
    `${hostName}.json`
  );
}

export function createNativeHostManifest({ hostPath, extensionId }) {
  if (!path.isAbsolute(hostPath)) {
    throw new Error("native host manifest path must be absolute");
  }
  if (!extensionId) {
    throw new Error("native host manifest requires an extension id");
  }
  return {
    name: HOST_NAME,
    description: "Link2Chrome native messaging host",
    type: "stdio",
    path: hostPath,
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };
}

export function installNativeHostManifest({
  hostPath,
  extensionId,
  manifestPath = getChromeNativeMessagingManifestPath(),
  writeFile = fs.promises.writeFile,
  mkdir = fs.promises.mkdir,
} = {}) {
  const manifest = createNativeHostManifest({ hostPath, extensionId });
  return mkdir(path.dirname(manifestPath), { recursive: true })
    .then(() => writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8"))
    .then(() => ({ ok: true, manifestPath, manifest }));
}

async function main() {
  const [, , hostPath, extensionId] = process.argv;
  if (!hostPath || !extensionId) {
    throw new Error("usage: node scripts/native-host/installManifest.mjs /absolute/path/to/native-host.mjs <extension-id>");
  }
  const result = await installNativeHostManifest({ hostPath, extensionId });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message || String(error));
    process.exitCode = 1;
  });
}
