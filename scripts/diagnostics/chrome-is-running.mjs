import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

export async function checkChromeIsRunning({ exec = execFileAsync } = {}) {
  try {
    const result = await exec("pgrep", ["-f", "Google Chrome|Chromium|Tabbit"]);
    const pids = String(result.stdout || "").trim().split(/\s+/).filter(Boolean);
    return { ok: pids.length > 0, pids };
  } catch (error) {
    return { ok: false, pids: [], error: String(error?.message || error) };
  }
}

async function main() {
  console.log(JSON.stringify(await checkChromeIsRunning(), null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message || String(error));
    process.exitCode = 1;
  });
}
