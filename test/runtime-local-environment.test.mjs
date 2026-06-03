import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  discoverLocalBrowserEnvironment,
  openLocalBrowserWindow,
} from "../runtime/local-environment.mjs";

test("discovers installed browser apps and profile directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "link2chrome-env-"));
  const chromeApp = join(root, "Google Chrome.app");
  const chromeProfileRoot = join(root, "ChromeProfiles");
  await mkdir(join(chromeApp, "Contents", "MacOS"), { recursive: true });
  await writeFile(join(chromeApp, "Contents", "MacOS", "Google Chrome"), "", "utf8");
  await mkdir(join(chromeProfileRoot, "Default"), { recursive: true });
  await mkdir(join(chromeProfileRoot, "Profile 1"), { recursive: true });
  await writeFile(
    join(chromeProfileRoot, "Local State"),
    JSON.stringify({
      profile: {
        info_cache: {
          Default: { name: "Person 1" },
          "Profile 1": { name: "Work" },
        },
      },
    }),
    "utf8"
  );

  const env = await discoverLocalBrowserEnvironment({
    platform: "darwin",
    candidates: [
      {
        id: "chrome",
        name: "Google Chrome",
        executablePaths: [join(chromeApp, "Contents", "MacOS", "Google Chrome")],
        profileRoot: chromeProfileRoot,
        processNames: ["Google Chrome"],
      },
    ],
    processes: [{ pid: 42, command: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" }],
  });

  assert.equal(env.ok, true);
  assert.deepEqual(env.browsers, [
    {
      id: "chrome",
      name: "Google Chrome",
      installed: true,
      running: true,
      executablePath: join(chromeApp, "Contents", "MacOS", "Google Chrome"),
      profileRoot: chromeProfileRoot,
      profiles: [
        { id: "Default", name: "Person 1", path: join(chromeProfileRoot, "Default") },
        { id: "Profile 1", name: "Work", path: join(chromeProfileRoot, "Profile 1") },
      ],
    },
  ]);
  assert.deepEqual(env.summary, {
    installedCount: 1,
    runningCount: 1,
    profileCount: 2,
  });
});

test("reports missing browsers without throwing", async () => {
  const root = await mkdtemp(join(tmpdir(), "link2chrome-env-missing-"));

  const env = await discoverLocalBrowserEnvironment({
    platform: "darwin",
    candidates: [
      {
        id: "chrome",
        name: "Google Chrome",
        executablePaths: [join(root, "Missing Chrome")],
        profileRoot: join(root, "MissingProfiles"),
        processNames: ["Google Chrome"],
      },
    ],
    processes: [],
  });

  assert.equal(env.ok, false);
  assert.deepEqual(env.summary, {
    installedCount: 0,
    runningCount: 0,
    profileCount: 0,
  });
  assert.equal(env.browsers[0].installed, false);
  assert.deepEqual(env.browsers[0].profiles, []);
});

test("diagnoses a loadable Link2Chrome extension package", async () => {
  const root = await mkdtemp(join(tmpdir(), "link2chrome-extension-"));
  await writeFile(
    join(root, "manifest.json"),
    JSON.stringify({
      manifest_version: 3,
      name: "ChromeX - Local Browser MCP",
      permissions: [
        "debugger",
        "activeTab",
        "scripting",
        "tabs",
        "storage",
        "history",
        "tabGroups",
        "clipboardRead",
        "clipboardWrite",
      ],
      host_permissions: ["<all_urls>"],
      background: { service_worker: "background.js" },
    }),
    "utf8"
  );
  await writeFile(join(root, "background.js"), "", "utf8");

  const env = await discoverLocalBrowserEnvironment({
    candidates: [],
    processes: [],
    extensionDir: root,
  });

  assert.deepEqual(env.extensionPackage, {
    ok: true,
    path: root,
    manifestVersion: 3,
    name: "ChromeX - Local Browser MCP",
    backgroundServiceWorker: "background.js",
    missingPermissions: [],
    missingHostPermissions: [],
  });
});

test("reports missing Link2Chrome extension package permissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "link2chrome-extension-missing-"));
  await writeFile(
    join(root, "manifest.json"),
    JSON.stringify({
      manifest_version: 3,
      name: "Incomplete Extension",
      permissions: ["tabs"],
      host_permissions: [],
      background: {},
    }),
    "utf8"
  );

  const env = await discoverLocalBrowserEnvironment({
    candidates: [],
    processes: [],
    extensionDir: root,
  });

  assert.equal(env.extensionPackage.ok, false);
  assert.deepEqual(env.extensionPackage.missingPermissions, [
    "debugger",
    "activeTab",
    "scripting",
    "storage",
    "history",
    "tabGroups",
    "clipboardRead",
    "clipboardWrite",
  ]);
  assert.deepEqual(env.extensionPackage.missingHostPermissions, ["<all_urls>"]);
  assert.equal(env.extensionPackage.backgroundServiceWorker, null);
});

test("opens a local browser window with a selected profile and url", async () => {
  const launched = [];
  const result = await openLocalBrowserWindow({
    browser: {
      id: "chrome",
      name: "Google Chrome",
      executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      profileRoot: "/Users/me/Library/Application Support/Google/Chrome",
    },
    profileId: "Profile 1",
    url: "https://example.com",
    launcher: async (command, args) => {
      launched.push({ command, args });
      return { pid: 1234 };
    },
  });

  assert.deepEqual(launched, [
    {
      command: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      args: [
        "--profile-directory=Profile 1",
        "--user-data-dir=/Users/me/Library/Application Support/Google/Chrome",
        "https://example.com",
      ],
    },
  ]);
  assert.deepEqual(result, {
    ok: true,
    browserId: "chrome",
    profileId: "Profile 1",
    url: "https://example.com",
    pid: 1234,
  });
});

test("openLocalBrowserWindow rejects missing browser executable", async () => {
  await assert.rejects(
    () => openLocalBrowserWindow({ browser: { id: "chrome", name: "Google Chrome" } }),
    /browser executable is required/
  );
});
