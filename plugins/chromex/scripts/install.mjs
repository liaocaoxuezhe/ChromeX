import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveProjectRoot } from "./resolve-project-root.mjs";

const PYTHON_COMMANDS = ["python3.12", "python3.11", "python3.10", "python3"];

export function parsePythonVersion(versionText) {
  const match = String(versionText).match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function supportsChromeXPython(versionText) {
  const version = parsePythonVersion(versionText);
  return Boolean(version && (version.major > 3 || (version.major === 3 && version.minor >= 10)));
}

export function selectPythonCandidate(candidates) {
  return candidates.find((candidate) => supportsChromeXPython(candidate.version)) || null;
}

export function discoverPythonCandidates(commands = PYTHON_COMMANDS) {
  return commands.flatMap((command) => {
    const result = spawnSync(command, ["--version"], { encoding: "utf8" });
    if (result.error || result.status !== 0) return [];
    return [{ command, version: `${result.stdout} ${result.stderr}`.trim() }];
  });
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
  });
}

function assertNodeVersion() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 18) {
    throw new Error(`ChromeX requires Node.js 18+. Current version is ${process.version}.`);
  }
}

async function ensurePythonVenv(projectRoot) {
  const venvPython = path.join(projectRoot, "server", "venv", "bin", "python");
  const requirements = path.join(projectRoot, "server", "requirements.txt");
  const candidates = discoverPythonCandidates();
  const selected = selectPythonCandidate(candidates);
  if (!selected) {
    const seen = candidates.map((candidate) => `${candidate.command}=${candidate.version}`).join(", ") || "none";
    throw new Error(`ChromeX requires Python 3.10+ for the MCP SDK path. Detected candidates: ${seen}`);
  }

  if (!existsSync(venvPython)) {
    console.log(`Creating server/venv with ${selected.command} (${selected.version})`);
    await run(selected.command, ["-m", "venv", path.join(projectRoot, "server", "venv")], { cwd: projectRoot });
  } else {
    console.log(`Reusing existing Python venv: ${venvPython}`);
  }

  console.log("Installing Python dependencies from server/requirements.txt");
  await run(venvPython, ["-m", "pip", "install", "-r", requirements], { cwd: projectRoot });
  return { command: selected.command, version: selected.version, venvPython };
}

async function main() {
  assertNodeVersion();
  const projectRoot = await resolveProjectRoot();
  console.log(`ChromeX project root: ${projectRoot}`);
  const python = await ensurePythonVenv(projectRoot);
  await run("node", [path.join(projectRoot, "scripts", "dev-extension", "install.mjs")], { cwd: projectRoot });
  console.log(JSON.stringify({
    ok: true,
    projectRoot,
    python,
    next: [
      "Open chrome://extensions",
      "Enable Developer Mode",
      `Load unpacked extension: ${path.join(projectRoot, "extension")}`,
      "Run node plugins/chromex/scripts/diagnose.mjs"
    ]
  }, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message || String(error));
    process.exitCode = 1;
  });
}
