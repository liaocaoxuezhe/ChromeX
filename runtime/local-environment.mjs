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

export async function openLocalBrowserWindow({
  browser,
  profileId,
  url,
  extensionDir,
  onlyExtension = false,
  launcher = defaultLauncher,
} = {}) {
  if (!browser?.executablePath) {
    throw new Error("browser executable is required to open a local browser window");
  }
  const args = [];
  if (profileId) args.push(`--profile-directory=${profileId}`);
  if (browser.profileRoot) args.push(`--user-data-dir=${browser.profileRoot}`);
  if (extensionDir && onlyExtension) args.push(`--disable-extensions-except=${extensionDir}`);
  if (extensionDir) args.push(`--load-extension=${extensionDir}`);
  if (url) args.push(url);

  const launchResult = await launcher(browser.executablePath, args);
  return {
    ok: true,
    browserId: browser.id || null,
    profileId: profileId || null,
    url: url || null,
    extensionDir: extensionDir || null,
    pid: launchResult?.pid || null,
  };
}

export async function discoverLocalBrowserEnvironment(options = {}) {
  const platform = options.platform || process.platform;
  const candidates = options.candidates || defaultBrowserCandidates(platform);
  const processes = options.processes || await listProcesses(platform);
  const extensionDir = options.extensionDir || join(PROJECT_ROOT, "extension");
  const extensionPackage = await diagnoseExtensionPackage(extensionDir);
  const browsers = [];

  for (const candidate of candidates) {
    const executablePath = await firstExisting(candidate.executablePaths || []);
    const installed = Boolean(executablePath);
    const running = isProcessRunning(processes, candidate.processNames || [candidate.name]);
    const profiles = await discoverProfiles(candidate.profileRoot, {
      extensionDir,
      extensionName: extensionPackage.name,
    });
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
    extensionPackage,
  };
}

async function defaultLauncher(command, args) {
  const child = execFile(command, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return { pid: child.pid };
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

async function discoverProfiles(profileRoot, extension = {}) {
  if (!profileRoot || !await exists(profileRoot)) return [];
  const localState = await readLocalState(profileRoot);
  const infoCache = localState?.profile?.info_cache || {};
  const entries = await readdir(profileRoot, { withFileTypes: true });
  const profiles = entries
    .filter((entry) => entry.isDirectory() && (entry.name === "Default" || /^Profile \d+$/.test(entry.name)))
    .map((entry) => ({
      id: entry.name,
      name: infoCache[entry.name]?.name || entry.name,
      path: join(profileRoot, entry.name),
    }))
    .sort((a, b) => a.id.localeCompare(b.id, "en"));
  return Promise.all(profiles.map(async (profile) => ({
    ...profile,
    extensionInstall: await diagnoseProfileExtensionInstall(profile.path, extension),
  })));
}

async function readLocalState(profileRoot) {
  try {
    return JSON.parse(await readFile(join(profileRoot, "Local State"), "utf8"));
  } catch {
    return null;
  }
}

async function diagnoseProfileExtensionInstall(profilePath, extension = {}) {
  for (const fileName of ["Preferences", "Secure Preferences"]) {
    const preferences = await readJsonFile(join(profilePath, fileName));
    const match = findExtensionSettingsMatch(preferences, extension);
    if (match) {
      return {
        installed: true,
        enabled: match.enabled,
        id: match.id,
        path: match.path,
        source: fileName,
      };
    }
  }
  return missingExtensionInstall();
}

function findExtensionSettingsMatch(preferences, extension = {}) {
  const settings = preferences?.extensions?.settings || {};
  for (const [id, value] of Object.entries(settings)) {
    const extensionPath = value?.path || null;
    const manifestName = value?.manifest?.name || "";
    const pathMatches = extension.extensionDir && extensionPath === extension.extensionDir;
    const nameMatches = extension.extensionName && manifestName === extension.extensionName;
    if (pathMatches || nameMatches) {
      return {
        id,
        path: extensionPath,
        enabled: value?.state === undefined ? true : value.state === 1,
      };
    }
  }
  return null;
}

function missingExtensionInstall() {
  return {
    installed: false,
    enabled: false,
    id: null,
    path: null,
    source: null,
  };
}

async function readJsonFile(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
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
    const backgroundDiagnostics = backgroundServiceWorker
      ? await diagnoseBackgroundServiceWorker(join(extensionDir, backgroundServiceWorker))
      : missingBackgroundDiagnostics();
    const missingPermissions = REQUIRED_EXTENSION_PERMISSIONS.filter((permission) => !permissions.includes(permission));
    const missingHostPermissions = REQUIRED_HOST_PERMISSIONS.filter((permission) => !hostPermissions.includes(permission));
    return {
      ok: (
        manifest.manifest_version === 3
        && Boolean(backgroundServiceWorker)
        && missingPermissions.length === 0
        && missingHostPermissions.length === 0
        && backgroundDiagnostics.keepalive.ok
      ),
      path: extensionDir,
      manifestVersion: manifest.manifest_version || null,
      name: manifest.name || "",
      backgroundServiceWorker,
      missingPermissions,
      missingHostPermissions,
      websocketUrl: backgroundDiagnostics.websocketUrl,
      keepalive: backgroundDiagnostics.keepalive,
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
      websocketUrl: null,
      keepalive: missingBackgroundDiagnostics().keepalive,
    };
  }
}

async function diagnoseBackgroundServiceWorker(path) {
  try {
    const source = await readFile(path, "utf8");
    const hasAlarmsApi = /chrome\.alarms\.(create|onAlarm)/.test(source);
    const hasRuntimeLifecycleListener = /chrome\.runtime\.(onStartup|onInstalled|onSuspend|onConnect|onMessage)\.addListener/.test(source);
    const missingSignals = [];
    if (!hasAlarmsApi) missingSignals.push("chrome.alarms");
    if (!hasRuntimeLifecycleListener) missingSignals.push("chrome.runtime lifecycle listener");
    return {
      websocketUrl: extractWebSocketUrl(source),
      keepalive: {
        ok: missingSignals.length === 0,
        hasAlarmsApi,
        hasRuntimeLifecycleListener,
        missingSignals,
      },
    };
  } catch {
    return missingBackgroundDiagnostics();
  }
}

function missingBackgroundDiagnostics() {
  return {
    websocketUrl: null,
    keepalive: {
      ok: false,
      hasAlarmsApi: false,
      hasRuntimeLifecycleListener: false,
      missingSignals: ["chrome.alarms", "chrome.runtime lifecycle listener"],
    },
  };
}

function extractWebSocketUrl(source) {
  const match = source.match(/wss?:\/\/[^"'`\s)]+/);
  return match ? match[0] : null;
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
