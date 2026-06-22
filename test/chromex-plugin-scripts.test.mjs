import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const resolverPath = path.join(root, "plugins/chromex/scripts/resolve-project-root.mjs");

test("resolveProjectRoot prefers CHROMEX_PROJECT_ROOT", async () => {
  const { resolveProjectRoot } = await import(resolverPath);
  const result = await resolveProjectRoot({
    env: { CHROMEX_PROJECT_ROOT: root },
    startDir: path.join(root, "plugins/chromex/scripts")
  });
  assert.equal(result, root);
});

test("resolveProjectRoot walks upward to package marker", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "chromex-root-"));
  try {
    await mkdir(path.join(tmp, "server"), { recursive: true });
    await mkdir(path.join(tmp, "extension"), { recursive: true });
    await writeFile(path.join(tmp, "package.json"), "{\"dependencies\":{\"ws\":\"^8.21.0\"}}\n", "utf8");
    await writeFile(path.join(tmp, "server/main.py"), "", "utf8");
    await writeFile(path.join(tmp, "extension/manifest.json"), "{}", "utf8");
    const nested = path.join(tmp, "plugins/chromex/scripts");
    await mkdir(nested, { recursive: true });
    const { resolveProjectRoot } = await import(resolverPath);
    assert.equal(await resolveProjectRoot({ env: {}, startDir: nested }), tmp);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("createMcpServerLaunchPlan points to project venv python and server main", async () => {
  const launcherPath = path.join(root, "plugins/chromex/scripts/mcp-server.mjs");
  const { createMcpServerLaunchPlan } = await import(launcherPath);
  const plan = createMcpServerLaunchPlan({
    projectRoot: root,
    env: { LOG_LEVEL: "DEBUG", LOG_CONSOLE: "false" }
  });
  assert.equal(plan.command, path.join(root, "server/venv/bin/python"));
  assert.deepEqual(plan.args, [path.join(root, "server/main.py")]);
  assert.equal(plan.cwd, root);
  assert.equal(plan.env.LOG_LEVEL, "DEBUG");
  assert.equal(plan.env.LOG_CONSOLE, "false");
});

test("selectPythonCandidate rejects python 3.9 and accepts python 3.10+", async () => {
  const installPath = path.join(root, "plugins/chromex/scripts/install.mjs");
  const { selectPythonCandidate } = await import(installPath);
  const candidates = [
    { command: "python3", version: "3.9.18" },
    { command: "python3.10", version: "3.10.14" }
  ];
  assert.deepEqual(selectPythonCandidate(candidates), candidates[1]);
});
