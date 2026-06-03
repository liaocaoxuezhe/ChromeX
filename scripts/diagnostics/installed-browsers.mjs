import { fileURLToPath } from "node:url";
import { discoverLocalBrowserEnvironment } from "../../runtime/local-environment.mjs";

export async function checkInstalledBrowsers({ inspect = discoverLocalBrowserEnvironment } = {}) {
  try {
    const environment = await inspect();
    return {
      ok: true,
      browsers: environment.browsers || [],
    };
  } catch (error) {
    return { ok: false, browsers: [], error: String(error?.message || error) };
  }
}

async function main() {
  console.log(JSON.stringify(await checkInstalledBrowsers(), null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message || String(error));
    process.exitCode = 1;
  });
}
