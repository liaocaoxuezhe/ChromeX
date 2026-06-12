import { fileURLToPath } from "node:url";
import { discoverLocalBrowserEnvironment } from "../../runtime/local-environment.mjs";

export async function checkExtensionInstalled({ inspect = discoverLocalBrowserEnvironment } = {}) {
  try {
    const environment = await inspect();
    const profiles = (environment.browsers || []).flatMap((browser) => browser.profiles || []);
    const installedProfiles = profiles.filter((profile) => profile.extensionInstall?.installed);
    return {
      ok: installedProfiles.length > 0 || Boolean(environment.extensionPackage?.ok),
      installedProfiles,
      extensionPackage: environment.extensionPackage || null,
    };
  } catch (error) {
    return { ok: false, installedProfiles: [], error: String(error?.message || error) };
  }
}

async function main() {
  console.log(JSON.stringify(await checkExtensionInstalled(), null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message || String(error));
    process.exitCode = 1;
  });
}
