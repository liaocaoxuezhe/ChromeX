import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("chromex repo marketplace exposes chromex plugin", async () => {
  const raw = await readFile(path.join(root, ".agents/plugins/marketplace.json"), "utf8");
  const marketplace = JSON.parse(raw);
  assert.equal(marketplace.name, "chromex-local");
  assert.equal(marketplace.interface.displayName, "ChromeX Local Plugins");
  assert.equal(marketplace.plugins.length, 1);
  assert.deepEqual(marketplace.plugins[0], {
    name: "chromex",
    source: {
      source: "local",
      path: "./plugins/chromex"
    },
    policy: {
      installation: "AVAILABLE",
      authentication: "ON_INSTALL"
    },
    category: "Productivity"
  });
});

test("chromex plugin manifest has install surface metadata", async () => {
  const raw = await readFile(path.join(root, "plugins/chromex/.codex-plugin/plugin.json"), "utf8");
  const manifest = JSON.parse(raw);
  assert.equal(manifest.name, "chromex");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.skills, "./skills/");
  assert.equal(manifest.mcpServers, "./.mcp.json");
  assert.equal(manifest.interface.displayName, "ChromeX");
  assert.equal(manifest.interface.shortDescription, "Control real Chrome with Link2Chrome");
  assert.deepEqual(manifest.interface.capabilities, ["Interactive", "Read"]);
  assert.equal(manifest.interface.composerIcon, "./assets/composer.png");
  assert.equal(manifest.interface.logo, "./assets/icon128.png");
});

test("chromex mcp config declares local-browser server", async () => {
  const raw = await readFile(path.join(root, "plugins/chromex/.mcp.json"), "utf8");
  const config = JSON.parse(raw);
  assert.equal(config.mcpServers["local-browser"].command, "node");
  assert.deepEqual(config.mcpServers["local-browser"].args, ["./scripts/mcp-server.mjs"]);
  assert.equal(config.mcpServers["local-browser"].env.LOG_LEVEL, "INFO");
  assert.equal(config.mcpServers["local-browser"].env.LOG_CONSOLE, "false");
});

test("chromex skill and docs are present", async () => {
  const skill = await readFile(path.join(root, "plugins/chromex/skills/control-chromex/SKILL.md"), "utf8");
  assert.match(skill, /^---\nname: control-chromex\n/m);
  assert.match(skill, /browser_diagnose/);
  assert.match(skill, /browser_session/);
  assert.match(skill, /browser_code_run/);

  for (const name of ["install.md", "troubleshooting.md", "api-map.md"]) {
    const doc = await readFile(path.join(root, "plugins/chromex/docs", name), "utf8");
    assert.ok(doc.includes("ChromeX"));
  }
});
