import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveProjectRoot } from "./resolve-project-root.mjs";

export function createMcpServerLaunchPlan({ projectRoot, env = process.env } = {}) {
  if (!projectRoot) throw new Error("projectRoot is required");
  return {
    command: path.join(projectRoot, "server", "venv", "bin", "python"),
    args: [path.join(projectRoot, "server", "main.py")],
    cwd: projectRoot,
    env: {
      ...process.env,
      ...env,
      LOG_LEVEL: env.LOG_LEVEL || "INFO",
      LOG_CONSOLE: env.LOG_CONSOLE || "false"
    }
  };
}

async function main() {
  const projectRoot = await resolveProjectRoot();
  const plan = createMcpServerLaunchPlan({ projectRoot });
  const child = spawn(plan.command, plan.args, {
    cwd: plan.cwd,
    env: plan.env,
    stdio: "inherit"
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exitCode = code ?? 1;
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message || String(error));
    process.exitCode = 1;
  });
}
