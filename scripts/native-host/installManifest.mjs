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

function normalizeExtensionIds({ extensionId, extensionIds } = {}) {
  const ids = [
    ...(Array.isArray(extensionIds) ? extensionIds : []),
    ...(extensionId ? [extensionId] : []),
  ].map((id) => String(id).trim()).filter(Boolean);
  return [...new Set(ids)];
}

export function createNativeHostManifest({ hostPath, extensionId, extensionIds }) {
  if (!path.isAbsolute(hostPath)) {
    throw new Error("native host manifest path must be absolute");
  }
  const allowedExtensionIds = normalizeExtensionIds({ extensionId, extensionIds });
  if (allowedExtensionIds.length === 0) {
    throw new Error("native host manifest requires an extension id");
  }
  return {
    name: HOST_NAME,
    description: "Link2Chrome native messaging host",
    type: "stdio",
    path: hostPath,
    allowed_origins: allowedExtensionIds.map((id) => `chrome-extension://${id}/`),
  };
}

export function installNativeHostManifest({
  hostPath,
  extensionId,
  extensionIds,
  manifestPath = getChromeNativeMessagingManifestPath(),
  writeFile = fs.promises.writeFile,
  mkdir = fs.promises.mkdir,
} = {}) {
  const manifest = createNativeHostManifest({ hostPath, extensionId, extensionIds });
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
