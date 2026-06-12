import { fileURLToPath } from "node:url";
import { checkNativeHostManifest } from "../native-host/check-native-host-manifest.mjs";

export { checkNativeHostManifest };

async function main() {
  console.log(JSON.stringify(await checkNativeHostManifest(), null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message || String(error));
    process.exitCode = 1;
  });
}
