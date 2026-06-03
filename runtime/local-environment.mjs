import { access, readdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const REQUIRED_EXTENSION_PERMISSIONS = [
  "debugger",
  "activeTab",
  "scripting",
  "tabs",
  "storage",
  "history",
  "tabGroups",
  "clipboardRead",
  "clipboardWrite",
];
const REQUIRED_HOST_PERMISSIONS = ["<all_urls>"];
const RUNTIME_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = dirname(RUNTIME_DIR);

export async function discoverLocalBrowserEnvironment(options = {}) {
  const platform = options.platform || process.platform;
  const candidates = options.candidates || defaultBrowserCandidates(platform);
  const processes = options.processes || await listProcesses(platform);
  const extensionDir = options.extensionDir || join(PROJECT_ROOT, "extension");
  const browsers = [];

  for (const candidate of candidates) {
    const executablePath = await firstExisting(candidate.executablePaths || []);
    const installed = Boolean(executablePath);
    const running = isProcessRunning(processes, candidate.processNames || [candidate.name]);
    const profiles = await discoverProfiles(candidate.profileRoot);
    browsers.push({
      id: candidate.id,
      name: candidate.name,
      installed,
      running,
      executablePath,
      profileRoot: candidate.profileRoot,
      profiles,
    });
  }

  const summary = {
    installedCount: browsers.filter((browser) => browser.installed).length,
    runningCount: browsers.filter((browser) => browser.running).length,
    profileCount: browsers.reduce((count, browser) => count + browser.profiles.length, 0),
  };

  return {
    ok: summary.installedCount > 0,
    platform,
    browsers,
    summary,
    extensionPackage: await diagnoseExtensionPackage(extensionDir),
  };
}

export function defaultBrowserCandidates(platform = process.platform) {
  const home = homedir();
  if (platform === "darwin") {
    return [
      {
        id: "chrome",
        name: "Google Chrome",
        executablePaths: [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          join(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
        ],
        profileRoot: join(home, "Library/Application Support/Google/Chrome"),
        processNames: ["Google Chrome"],
      },
      {
        id: "chromium",
        name: "Chromium",
        executablePaths: [
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
          join(home, "Applications/Chromium.app/Contents/MacOS/Chromium"),
        ],
        profileRoot: join(home, "Library/Application Support/Chromium"),
        processNames: ["Chromium"],
      },
      {
        id: "brave",
        name: "Brave Browser",
        executablePaths: [
          "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
          join(home, "Applications/Brave Browser.app/Contents/MacOS/Brave Browser"),
        ],
        profileRoot: join(home, "Library/Application Support/BraveSoftware/Brave-Browser"),
        processNames: ["Brave Browser"],
      },
    ];
  }
  return [
    {
      id: "chrome",
      name: "Google Chrome",
      executablePaths: ["google-chrome", "chrome", "chromium"],
      profileRoot: join(home, ".config/google-chrome"),
      processNames: ["google-chrome", "chrome", "chromium"],
    },
  ];
}

async function firstExisting(paths) {
  for (const path of paths) {
    if (await exists(path)) return path;
  }
  return null;
}

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function discoverProfiles(profileRoot) {
  if (!profileRoot || !await exists(profileRoot)) return [];
  const localState = await readLocalState(profileRoot);
  const infoCache = localState?.profile?.info_cache || {};
  const entries = await readdir(profileRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && (entry.name === "Default" || /^Profile \d+$/.test(entry.name)))
    .map((entry) => ({
      id: entry.name,
      name: infoCache[entry.name]?.name || entry.name,
      path: join(profileRoot, entry.name),
    }))
    .sort((a, b) => a.id.localeCompare(b.id, "en"));
}

async function readLocalState(profileRoot) {
  try {
    return JSON.parse(await readFile(join(profileRoot, "Local State"), "utf8"));
  } catch {
    return null;
  }
}

async function diagnoseExtensionPackage(extensionDir) {
  const manifestPath = join(extensionDir, "manifest.json");
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const permissions = manifest.permissions || [];
    const hostPermissions = manifest.host_permissions || [];
    const backgroundServiceWorker = manifest.background?.service_worker || null;
    const missingPermissions = REQUIRED_EXTENSION_PERMISSIONS.filter((permission) => !permissions.includes(permission));
    const missingHostPermissions = REQUIRED_HOST_PERMISSIONS.filter((permission) => !hostPermissions.includes(permission));
    return {
      ok: (
        manifest.manifest_version === 3
        && Boolean(backgroundServiceWorker)
        && missingPermissions.length === 0
        && missingHostPermissions.length === 0
      ),
      path: extensionDir,
      manifestVersion: manifest.manifest_version || null,
      name: manifest.name || "",
      backgroundServiceWorker,
      missingPermissions,
      missingHostPermissions,
    };
  } catch (error) {
    return {
      ok: false,
      path: extensionDir,
      error: String(error?.message || error),
      manifestVersion: null,
      name: "",
      backgroundServiceWorker: null,
      missingPermissions: REQUIRED_EXTENSION_PERMISSIONS,
      missingHostPermissions: REQUIRED_HOST_PERMISSIONS,
    };
  }
}

function isProcessRunning(processes, processNames) {
  return processes.some((processInfo) => {
    const command = String(processInfo.command || processInfo.name || "");
    return processNames.some((name) => command.includes(name));
  });
}

async function listProcesses(platform) {
  if (platform === "win32") return [];
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,command="], { timeout: 3000 });
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^(\d+)\s+(.*)$/);
        return {
          pid: match ? Number(match[1]) : null,
          command: match ? match[2] : line,
        };
      });
  } catch {
    return [];
  }
}
