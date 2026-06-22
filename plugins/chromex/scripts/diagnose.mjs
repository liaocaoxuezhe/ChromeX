import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveProjectRoot } from "./resolve-project-root.mjs";

function runCheck(label, command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  return {
    label,
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim()
  };
}

async function main() {
  const projectRoot = await resolveProjectRoot();
  const checks = [
    runCheck("node-env", "node", [path.join(projectRoot, "scripts/check-node-env.mjs"), "--json"], projectRoot),
    runCheck("extension-installed", "node", [path.join(projectRoot, "scripts/diagnostics/check-extension-installed.mjs")], projectRoot),
    runCheck("native-host-manifest", "node", [path.join(projectRoot, "scripts/diagnostics/check-native-host-manifest.mjs")], projectRoot)
  ];
  console.log(JSON.stringify({ ok: checks.every((check) => check.ok), projectRoot, checks }, null, 2));
  if (!checks.every((check) => check.ok)) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message || String(error));
    process.exitCode = 1;
  });
}
