import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  HOST_NAME,
  getChromeNativeMessagingManifestPath,
} from "./installManifest.mjs";

export async function checkNativeHostManifest({
  manifestPath = getChromeNativeMessagingManifestPath(),
  readFile = fs.promises.readFile,
} = {}) {
  try {
    const raw = await readFile(manifestPath, "utf8");
    const manifest = JSON.parse(raw);
    return {
      ok: manifest.name === HOST_NAME && manifest.type === "stdio" && Boolean(manifest.path),
      manifestPath,
      manifest,
    };
  } catch (error) {
    return {
      ok: false,
      manifestPath,
      error: String(error?.message || error),
    };
  }
}

async function main() {
  const result = await checkNativeHostManifest();
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message || String(error));
    process.exitCode = 1;
  });
}
