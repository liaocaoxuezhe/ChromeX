import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

async function exists(filePath) {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function isProjectRoot(dir) {
  return await exists(path.join(dir, "package.json"))
    && await exists(path.join(dir, "server", "main.py"))
    && await exists(path.join(dir, "extension", "manifest.json"));
}

export async function resolveProjectRoot({
  env = process.env,
  startDir = path.dirname(fileURLToPath(import.meta.url))
} = {}) {
  if (env.CHROMEX_PROJECT_ROOT) {
    const explicit = path.resolve(env.CHROMEX_PROJECT_ROOT);
    if (!await isProjectRoot(explicit)) {
      throw new Error(`CHROMEX_PROJECT_ROOT is not a ChromeX project root: ${explicit}`);
    }
    return explicit;
  }

  let current = path.resolve(startDir);
  while (true) {
    if (await isProjectRoot(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error("Unable to locate ChromeX project root. Set CHROMEX_PROJECT_ROOT=/absolute/path/to/Link2Chrome.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  resolveProjectRoot()
    .then((projectRoot) => console.log(JSON.stringify({ projectRoot }, null, 2)))
    .catch((error) => {
      console.error(error.message || String(error));
      process.exitCode = 1;
    });
}
