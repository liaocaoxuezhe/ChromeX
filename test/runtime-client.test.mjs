import test from "node:test";
import assert from "node:assert/strict";
import {
  createLink2ChromeClient,
  createWebSocketTransport,
  setupLink2ChromeRuntime,
} from "../runtime/link2chrome-client.mjs";

function fakeTransport() {
  const calls = [];
  return {
    calls,
    async command(name, args = {}) {
      calls.push({ name, args });
      if (name === "browser_tabs_list") {
        return { tabs: [{ id: 7, active: true, url: "https://example.com", title: "Example" }] };
      }
      return { ok: true };
    },
  };
}

test("browsers.get returns an extension browser with tabs API", async () => {
  const transport = fakeTransport();
  const link2chrome = createLink2ChromeClient({ transport });

  const browser = await link2chrome.browsers.get("extension");
  const tabs = await browser.tabs.list();

  assert.equal(browser.kind, "extension");
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].id, 7);
  assert.deepEqual(transport.calls[0], { name: "browser_tabs_list", args: {} });
});

test("setupLink2ChromeRuntime installs agent and link2chrome globals", async () => {
  const globals = {};
  const transport = fakeTransport();

  const runtime = setupLink2ChromeRuntime({ globals, transport });

  assert.equal(globals.link2chrome, runtime.link2chrome);
  assert.equal(globals.agent, runtime.agent);
  assert.equal(globals.agent.browsers, globals.link2chrome.browsers);
  const browser = await globals.agent.browsers.get("extension");
  const tabs = await browser.tabs.list();

  assert.equal(tabs[0].id, 7);
  assert.deepEqual(transport.calls[0], { name: "browser_tabs_list", args: {} });
});

test("setupLink2ChromeRuntime preserves existing globals unless overwrite is true", () => {
  const globals = { agent: { existing: true }, link2chrome: { existing: true } };
  const transport = fakeTransport();

  const runtime = setupLink2ChromeRuntime({ globals, transport });

  assert.deepEqual(globals.agent, { existing: true });
  assert.deepEqual(globals.link2chrome, { existing: true });
  assert.notEqual(runtime.agent, globals.agent);
  setupLink2ChromeRuntime({ globals, transport, overwrite: true });
  assert.equal(globals.agent.browsers, globals.link2chrome.browsers);
});

test("runtime exposes local environment inspect and openBrowser helpers", async () => {
  const calls = [];
  const link2chrome = createLink2ChromeClient({
    transport: fakeTransport(),
    localEnvironment: {
      inspect: async () => ({ ok: true, summary: { installedCount: 1 } }),
      openBrowser: async (options) => {
        calls.push(options);
        return { ok: true, pid: 1234 };
      },
    },
  });

  assert.deepEqual(await link2chrome.localEnvironment.inspect(), {
    ok: true,
    summary: { installedCount: 1 },
  });
  assert.deepEqual(await link2chrome.localEnvironment.openBrowser({ browserId: "chrome", profileId: "Default" }), {
    ok: true,
    pid: 1234,
  });
  assert.deepEqual(calls, [{ browserId: "chrome", profileId: "Default" }]);
});

test("runtime localEnvironment openBrowser passes extension launch options", async () => {
  const launched = [];
  const link2chrome = createLink2ChromeClient({
    transport: fakeTransport(),
    localEnvironment: {
      inspect: async () => ({
        ok: true,
        browsers: [{
          id: "chrome",
          installed: true,
          executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          profileRoot: "/Users/me/Library/Application Support/Google/Chrome",
        }],
      }),
    },
  });

  await link2chrome.localEnvironment.openBrowser({
    browserId: "chrome",
    profileId: "Default",
    extensionDir: "/Users/me/Link2Chrome/extension",
    onlyExtension: true,
    launcher: async (command, args) => {
      launched.push({ command, args });
      return { pid: 99 };
    },
  });

  assert.equal(launched[0].command, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  assert.deepEqual(launched[0].args.slice(-2), [
    "--disable-extensions-except=/Users/me/Link2Chrome/extension",
    "--load-extension=/Users/me/Link2Chrome/extension",
  ]);
});

test("runtime localEnvironment openBrowser prefers a profile with Link2Chrome enabled", async () => {
  const launched = [];
  const link2chrome = createLink2ChromeClient({
    transport: fakeTransport(),
    localEnvironment: {
      inspect: async () => ({
        ok: true,
        extensionPackage: { ok: true, path: "/Users/me/Link2Chrome/extension" },
        browsers: [{
          id: "chrome",
          installed: true,
          executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          profileRoot: "/Users/me/Library/Application Support/Google/Chrome",
          profiles: [
            { id: "Profile 1", extensionInstall: { installed: false, enabled: false } },
            { id: "Profile 3", extensionInstall: { installed: true, enabled: true } },
          ],
        }],
      }),
    },
  });

  const result = await link2chrome.localEnvironment.openBrowser({
    browserId: "chrome",
    launcher: async (command, args) => {
      launched.push({ command, args });
      return { pid: 101 };
    },
  });

  assert.equal(result.profileId, "Profile 3");
  assert.deepEqual(launched[0].args, [
    "--profile-directory=Profile 3",
    "--user-data-dir=/Users/me/Library/Application Support/Google/Chrome",
  ]);
});

test("runtime localEnvironment openBrowser loads the unpacked extension when no profile has it enabled", async () => {
  const launched = [];
  const link2chrome = createLink2ChromeClient({
    transport: fakeTransport(),
    localEnvironment: {
      inspect: async () => ({
        ok: true,
        extensionPackage: { ok: true, path: "/Users/me/Link2Chrome/extension" },
        browsers: [{
          id: "chrome",
          installed: true,
          executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          profileRoot: "/Users/me/Library/Application Support/Google/Chrome",
          profiles: [
            { id: "Default", extensionInstall: { installed: false, enabled: false } },
          ],
        }],
      }),
    },
  });

  const result = await link2chrome.localEnvironment.openBrowser({
    browserId: "chrome",
    launcher: async (command, args) => {
      launched.push({ command, args });
      return { pid: 102 };
    },
  });

  assert.equal(result.profileId, "Default");
  assert.equal(result.extensionDir, "/Users/me/Link2Chrome/extension");
  assert.deepEqual(launched[0].args, [
    "--profile-directory=Default",
    "--user-data-dir=/Users/me/Library/Application Support/Google/Chrome",
    "--load-extension=/Users/me/Link2Chrome/extension",
  ]);
});

test("runtime localEnvironment openAndWait opens Chrome and waits until extension readiness", async () => {
  const launched = [];
  let readinessChecks = 0;
  const transport = {
    async command(name) {
      if (name === "__hub_status__") {
        readinessChecks += 1;
        return { extension_connected: readinessChecks >= 3 };
      }
      if (name === "browser_tab_info") {
        if (readinessChecks < 3) throw new Error("tab not ready");
        return { id: 7, active: true, url: "https://ready.test" };
      }
      return { ok: true };
    },
  };
  const link2chrome = createLink2ChromeClient({
    transport,
    localEnvironment: {
      inspect: async () => ({
        ok: true,
        extensionPackage: { ok: true, path: "/Users/me/Link2Chrome/extension" },
        browsers: [{
          id: "chrome",
          installed: true,
          executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          profileRoot: "/Users/me/Library/Application Support/Google/Chrome",
          profiles: [{ id: "Default", extensionInstall: { installed: true, enabled: true } }],
        }],
      }),
    },
  });

  const result = await link2chrome.localEnvironment.openAndWait({
    browserId: "chrome",
    timeoutMs: 1000,
    intervalMs: 1,
    sleep: async () => {},
    launcher: async (command, args) => {
      launched.push({ command, args });
      return { pid: 103 };
    },
  });

  assert.equal(result.launch.profileId, "Default");
  assert.equal(result.readiness.ok, true);
  assert.equal(readinessChecks, 3);
  assert.equal(launched.length, 1);
});

test("runtime localEnvironment openAndWait reports timeout with last readiness", async () => {
  const link2chrome = createLink2ChromeClient({
    transport: {
      async command(name) {
        if (name === "__hub_status__") return { extension_connected: false };
        if (name === "browser_tab_info") throw new Error("Extension not connected");
        return { ok: true };
      },
    },
    localEnvironment: {
      inspect: async () => ({
        ok: true,
        extensionPackage: { ok: true, path: "/Users/me/Link2Chrome/extension" },
        browsers: [{
          id: "chrome",
          installed: true,
          executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          profileRoot: "/Users/me/Library/Application Support/Google/Chrome",
          profiles: [{ id: "Default", extensionInstall: { installed: true, enabled: true } }],
        }],
      }),
    },
  });

  await assert.rejects(
    () => link2chrome.localEnvironment.openAndWait({
      timeoutMs: 1,
      intervalMs: 1,
      now: (() => {
        let t = 0;
        return () => {
          t += 2;
          return t;
        };
      })(),
      sleep: async () => {},
      launcher: async () => ({ pid: 104 }),
    }),
    (error) => {
      assert.match(error.message, /Timed out waiting for Link2Chrome readiness/);
      assert.equal(error.readiness.ok, false);
      assert.equal(error.readiness.extension.connected, false);
      return true;
    }
  );
});

test("sessions.runExclusive acquires and releases a browser hub lease", async () => {
  const transport = {
    calls: [],
    async command(name, args = {}) {
      this.calls.push({ name, args });
      if (name === "__hub_acquire__") return { lease_token: "lease-1", lease_name: args.name };
      if (name === "browser_tabs_list") return { tabs: [{ id: 7, active: true }] };
      return { ok: true };
    },
  };
  const link2chrome = createLink2ChromeClient({ transport });

  const tabIds = await link2chrome.sessions.runExclusive("checkout", async ({ browser }) => {
    const tabs = await browser.tabs.list();
    return tabs.map((tab) => tab.id);
  });

  assert.deepEqual(tabIds, [7]);
  assert.deepEqual(transport.calls, [
    { name: "__hub_acquire__", args: { name: "checkout" } },
    { name: "browser_tabs_list", args: {} },
    { name: "__hub_release__", args: { lease_token: "lease-1" } },
  ]);
});

test("sessions.runExclusive releases the browser hub lease after callback errors", async () => {
  const transport = {
    calls: [],
    async command(name, args = {}) {
      this.calls.push({ name, args });
      if (name === "__hub_acquire__") return { lease_token: "lease-2", lease_name: args.name };
      return { ok: true };
    },
  };
  const link2chrome = createLink2ChromeClient({ transport });

  await assert.rejects(
    () => link2chrome.sessions.runExclusive("failing task", async () => {
      throw new Error("callback failed");
    }),
    /callback failed/
  );

  assert.deepEqual(transport.calls, [
    { name: "__hub_acquire__", args: { name: "failing task" } },
    { name: "__hub_release__", args: { lease_token: "lease-2" } },
  ]);
});

test("scripts.run executes a model-authored callback with runtime browser context", async () => {
  const transport = fakeTransport();
  const link2chrome = createLink2ChromeClient({ transport });

  const result = await link2chrome.scripts.run(async ({ agent, link2chrome, browser }) => {
    assert.equal(agent.browsers, link2chrome.browsers);
    const tabs = await browser.tabs.list();
    return tabs.map((tab) => tab.id);
  });

  assert.deepEqual(result, [7]);
  assert.deepEqual(transport.calls, [{ name: "browser_tabs_list", args: {} }]);
});

test("scripts.run executes source code and can wrap it in an exclusive browser session", async () => {
  const transport = {
    calls: [],
    async command(name, args = {}) {
      this.calls.push({ name, args });
      if (name === "__hub_acquire__") return { lease_token: "lease-3", lease_name: args.name };
      if (name === "browser_tab_info") return { id: 17, active: true, url: "https://code.test", title: "Code" };
      return { ok: true };
    },
  };
  const link2chrome = createLink2ChromeClient({ transport });

  const result = await link2chrome.scripts.run(
    "const tab = await browser.tabs.selected(); return { tabId: tab.id, lease: lease.lease_token };",
    { sessionName: "model-authored code" }
  );

  assert.deepEqual(result, { tabId: 17, lease: "lease-3" });
  assert.deepEqual(transport.calls, [
    { name: "__hub_acquire__", args: { name: "model-authored code" } },
    { name: "browser_tab_info", args: {} },
    { name: "__hub_release__", args: { lease_token: "lease-3" } },
  ]);
});

test("tasks.run opens a ready browser session and executes model-authored code", async () => {
  const launched = [];
  const transport = {
    calls: [],
    async command(name, args = {}) {
      this.calls.push({ name, args });
      if (name === "__hub_status__") return { extension_connected: true, queue_locked: false };
      if (name === "browser_tab_info") return { id: 21, active: true, url: "https://task.test" };
      if (name === "__hub_acquire__") return { lease_token: "lease-task", lease_name: args.name };
      if (name === "browser_tabs_list") return { tabs: [{ id: 21, active: true, title: "Task" }] };
      return { ok: true };
    },
  };
  const link2chrome = createLink2ChromeClient({
    transport,
    localEnvironment: {
      inspect: async () => ({
        ok: true,
        extensionPackage: { ok: true, path: "/Users/me/Link2Chrome/extension" },
        browsers: [{
          id: "chrome",
          installed: true,
          executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          profileRoot: "/Users/me/Library/Application Support/Google/Chrome",
          profiles: [{ id: "Default", extensionInstall: { installed: true, enabled: true } }],
        }],
      }),
    },
  });

  const task = await link2chrome.tasks.run("inspect tabs", `
const tabs = await browser.tabs.list();
return {
  tabIds: tabs.map((tab) => tab.id),
  lease: lease.lease_token,
  taskName: task.name,
  launchProfile: launch.profileId,
  readyTabId: readiness.selectedTab.tab.id,
};
`, {
    launcher: async (command, args) => {
      launched.push({ command, args });
      return { pid: 105 };
    },
  });

  assert.equal(task.launch.profileId, "Default");
  assert.equal(task.readiness.ok, true);
  assert.deepEqual(task.result, {
    tabIds: [21],
    lease: "lease-task",
    taskName: "inspect tabs",
    launchProfile: "Default",
    readyTabId: 21,
  });
  assert.deepEqual(transport.calls.filter((call) => call.name === "__hub_acquire__" || call.name === "__hub_release__"), [
    { name: "__hub_acquire__", args: { name: "inspect tabs" } },
    { name: "__hub_release__", args: { lease_token: "lease-task" } },
  ]);
  assert.equal(launched.length, 1);
});

test("diagnose returns Browser Hub status", async () => {
  const transport = {
    calls: [],
    async command(name, args = {}) {
      this.calls.push({ name, args });
      if (name === "__hub_status__") {
        return {
          hub_id: "hub-1",
          extension_connected: true,
          adapter_connections: 2,
          queue_locked: false,
        };
      }
      return { ok: true };
    },
  };
  const link2chrome = createLink2ChromeClient({ transport });

  const result = await link2chrome.diagnose();

  assert.deepEqual(result, {
    ok: true,
    hub: {
      hub_id: "hub-1",
      extension_connected: true,
      adapter_connections: 2,
      queue_locked: false,
    },
  });
  assert.deepEqual(transport.calls, [{ name: "__hub_status__", args: {} }]);
});

test("diagnose returns structured error when Hub is unreachable", async () => {
  const transport = {
    async command() {
      throw new Error("connection refused");
    },
  };
  const link2chrome = createLink2ChromeClient({ transport });

  const result = await link2chrome.diagnose();

  assert.equal(result.ok, false);
  assert.equal(result.error, "connection refused");
});

test("diagnostics readiness checks hub extension tab and runtime capabilities", async () => {
  const transport = {
    calls: [],
    async command(name, args = {}) {
      this.calls.push({ name, args });
      if (name === "__hub_status__") {
        return { hub_id: "hub-1", extension_connected: true, adapter_connections: 1, queue_locked: false };
      }
      if (name === "browser_tab_info") {
        return { id: 7, active: true, url: "https://ready.test", title: "Ready" };
      }
      return { ok: true };
    },
  };
  const localEnvironment = {
    inspect: async () => ({
      ok: true,
      summary: { installedCount: 1, runningCount: 1, profileCount: 2 },
      browsers: [{ id: "chrome", installed: true, running: true, profiles: [{ id: "Default" }, { id: "Profile 1" }] }],
      extensionPackage: { ok: true, missingPermissions: [], missingHostPermissions: [] },
    }),
  };
  const link2chrome = createLink2ChromeClient({ transport, localEnvironment });

  const result = await link2chrome.diagnostics.readiness();

  assert.equal(result.ok, true);
  assert.deepEqual(result.hub, {
    ok: true,
    status: { hub_id: "hub-1", extension_connected: true, adapter_connections: 1, queue_locked: false },
  });
  assert.deepEqual(result.extension, { ok: true, connected: true });
  assert.deepEqual(result.selectedTab, {
    ok: true,
    tab: { id: 7, active: true, url: "https://ready.test", title: "Ready" },
  });
  assert.deepEqual(result.localEnvironment, {
    ok: true,
    summary: { installedCount: 1, runningCount: 1, profileCount: 2 },
    browsers: [{ id: "chrome", installed: true, running: true, profiles: [{ id: "Default" }, { id: "Profile 1" }] }],
    extensionPackage: { ok: true, missingPermissions: [], missingHostPermissions: [] },
  });
  assert.deepEqual(result.capabilities.playwrightStyle, {
    domSnapshot: true,
    locator: true,
    fileChooser: true,
    dialog: true,
    hover: true,
    press: true,
    selectOption: true,
    fillForm: true,
  });
  assert.deepEqual(result.capabilities.browserState, {
    openTabs: true,
    claimTab: true,
    history: true,
  });
  assert.deepEqual(result.capabilities.sessions, {
    runExclusive: true,
  });
  assert.deepEqual(result.capabilities.localEnvironment, {
    inspect: true,
    openBrowser: true,
    openAndWait: true,
  });
  assert.deepEqual(result.capabilities.codeRunner, {
    scriptsRun: true,
    acceptsFunction: true,
    acceptsSourceString: true,
    exclusiveSession: true,
  });
  assert.deepEqual(result.capabilities.tasks, {
    run: true,
    preparesBrowser: true,
    exclusiveSession: true,
  });
  assert.deepEqual(result.capabilities.domCua, {
    visibleDom: true,
    query: true,
    click: true,
  });
  assert.deepEqual(transport.calls, [
    { name: "__hub_status__", args: {} },
    { name: "browser_tab_info", args: {} },
  ]);
});

test("diagnostics readiness reports partial failures without throwing", async () => {
  const transport = {
    async command(name) {
      if (name === "__hub_status__") {
        return { hub_id: "hub-2", extension_connected: false, queue_locked: false };
      }
      if (name === "browser_tab_info") {
        throw new Error("Extension not connected");
      }
      return { ok: true };
    },
  };
  const link2chrome = createLink2ChromeClient({ transport });

  const result = await link2chrome.diagnostics.readiness();

  assert.equal(result.ok, false);
  assert.deepEqual(result.extension, { ok: false, connected: false });
  assert.deepEqual(result.selectedTab, { ok: false, error: "Extension not connected" });
});

test("tabs.selected returns active tab info and tab navigation uses browser_navigate", async () => {
  const transport = {
    calls: [],
    async command(name, args = {}) {
      this.calls.push({ name, args });
      if (name === "browser_tab_info") {
        return { id: 7, active: true, url: "https://start.test", title: "Start" };
      }
      if (name === "browser_navigate") {
        return { ok: true, url: args.url };
      }
      return { ok: true };
    },
  };
  const browser = await createLink2ChromeClient({ transport }).browsers.get("extension");

  const tab = await browser.tabs.selected();
  const result = await tab.goto("https://example.com");

  assert.equal(tab.id, 7);
  assert.equal(result.ok, true);
  assert.deepEqual(transport.calls, [
    { name: "browser_tab_info", args: {} },
    { name: "browser_navigate", args: { url: "https://example.com" } },
  ]);
});

test("tab waitFor maps to browser wait command", async () => {
  const transport = fakeTransport();
  const browser = await createLink2ChromeClient({ transport }).browsers.get("extension");
  const [tab] = await browser.tabs.list();

  await tab.waitFor({ condition: "dom-ready", timeout: 5000 });

  assert.deepEqual(transport.calls.at(-1), {
    name: "browser.wait",
    args: { condition: "dom-ready", timeout: 5000 },
  });
});

test("user.openTabs lists currently open tabs", async () => {
  const transport = fakeTransport();
  const browser = await createLink2ChromeClient({ transport }).browsers.get("extension");

  const tabs = await browser.user.openTabs();

  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].id, 7);
  assert.deepEqual(transport.calls[0], { name: "browser_tabs_list", args: {} });
});

test("user.claimTab without arguments claims selected tab", async () => {
  const transport = {
    calls: [],
    async command(name, args = {}) {
      this.calls.push({ name, args });
      if (name === "browser_tab_info") {
        return { id: 9, active: true, url: "https://claimed.test", title: "Claimed" };
      }
      return { ok: true };
    },
  };
  const browser = await createLink2ChromeClient({ transport }).browsers.get("extension");

  const tab = await browser.user.claimTab();

  assert.equal(tab.id, 9);
  assert.deepEqual(transport.calls, [{ name: "browser_tab_info", args: {} }]);
});

test("user.claimTab with tabId switches and returns selected tab", async () => {
  const transport = {
    calls: [],
    async command(name, args = {}) {
      this.calls.push({ name, args });
      if (name === "browser_tab_switch") return { ok: true, tabId: args.tabId };
      if (name === "browser_tab_info") {
        return { id: 11, active: true, url: "https://target.test", title: "Target" };
      }
      return { ok: true };
    },
  };
  const browser = await createLink2ChromeClient({ transport }).browsers.get("extension");

  const tab = await browser.user.claimTab({ tabId: 11 });

  assert.equal(tab.id, 11);
  assert.deepEqual(transport.calls, [
    { name: "browser_tab_switch", args: { tabId: 11 } },
    { name: "browser_tab_info", args: {} },
  ]);
});

test("user.history maps to browser user history command", async () => {
  const transport = fakeTransport();
  const browser = await createLink2ChromeClient({ transport }).browsers.get("extension");

  await browser.user.history({ text: "docs", maxResults: 5 });

  assert.deepEqual(transport.calls.at(-1), {
    name: "browser.user.history",
    args: { text: "docs", maxResults: 5 },
  });
});

test("tabs.finalize is a structured no-op for deliverable handoff habits", async () => {
  const transport = fakeTransport();
  const originalCommand = transport.command.bind(transport);
  transport.command = async (name, args = {}) => {
    if (name === "browser.tabs.finalize") {
      throw new Error("unknown command: browser.tabs.finalize");
    }
    return originalCommand(name, args);
  };
  const browser = await createLink2ChromeClient({ transport }).browsers.get("extension");
  const [tab] = await browser.tabs.list();

  const result = await browser.tabs.finalize({ keep: [{ tab, status: "deliverable" }] });

  assert.deepEqual(result, {
    ok: true,
    action: "finalize",
    kept: [{ tabId: 7, status: "deliverable" }],
    raw: null,
  });
});

test("tabs.finalize calls backend when finalize support is available", async () => {
  const transport = {
    calls: [],
    async command(name, args = {}) {
      this.calls.push({ name, args });
      if (name === "browser_tabs_list") {
        return { tabs: [{ id: 7, active: true, url: "https://example.com", title: "Example" }] };
      }
      if (name === "browser.tabs.finalize") {
        return { ok: true, action: "finalize", grouped: [{ tabId: 7, status: "deliverable" }] };
      }
      return { ok: true };
    },
  };
  const browser = await createLink2ChromeClient({ transport }).browsers.get("extension");
  const [tab] = await browser.tabs.list();

  const result = await browser.tabs.finalize({ keep: [{ tab, status: "deliverable" }] });

  assert.deepEqual(result, { ok: true, action: "finalize", grouped: [{ tabId: 7, status: "deliverable" }] });
  assert.deepEqual(transport.calls.at(-1), {
    name: "browser.tabs.finalize",
    args: { keep: [{ tabId: 7, status: "deliverable" }] },
  });
});

test("locator fill maps to browser.dom.type", async () => {
  const transport = fakeTransport();
  const browser = await createLink2ChromeClient({ transport }).browsers.get("extension");
  const [tab] = await browser.tabs.list();

  await tab.playwright.locator("input[name='q']").fill("Link2Chrome");

  assert.deepEqual(transport.calls.at(-1), {
    name: "browser.dom.type",
    args: {
      target: { selector: "input[name='q']" },
      text: "Link2Chrome",
      clearFirst: true,
    },
  });
});

test("playwright fillForm maps to form fill action", async () => {
  const transport = fakeTransport();
  const browser = await createLink2ChromeClient({ transport }).browsers.get("extension");
  const [tab] = await browser.tabs.list();
  const fields = [
    { name: "email", value: "me@example.com" },
    { selector: "textarea[name=message]", value: "hello" },
  ];

  await tab.playwright.fillForm(fields, { formSelector: "form#contact", submit: true });

  assert.deepEqual(transport.calls.at(-1), {
    name: "action_fill_form",
    args: { fields, formSelector: "form#contact", submit: true },
  });
});

test("playwright fillForm can require safety confirmation", async () => {
  const confirmations = [];
  const transport = fakeTransport();
  const link2chrome = createLink2ChromeClient({
    transport,
    confirmAction: async (action) => {
      confirmations.push(action);
      return false;
    },
  });
  const browser = await link2chrome.browsers.get("extension");
  const [tab] = await browser.tabs.list();
  const fields = [{ name: "email", value: "me@example.com" }];

  await assert.rejects(
    () => tab.playwright.fillForm(fields, {
      safety: { level: "always-confirm", reason: "submit contact form" },
      submit: true,
    }),
    /Action was not confirmed/
  );

  assert.equal(confirmations[0].type, "fillForm");
  assert.deepEqual(confirmations[0].fields, fields);
  assert.notEqual(transport.calls.at(-1)?.name, "action_fill_form");
});

test("locator hover press and selectOption map to action commands", async () => {
  const transport = fakeTransport();
  const browser = await createLink2ChromeClient({ transport }).browsers.get("extension");
  const [tab] = await browser.tabs.list();

  await tab.playwright.locator("button.help").hover();
  await tab.playwright.locator("input[name=q]").press("Enter");
  await tab.playwright.locator("select[name=country]").selectOption("US");

  assert.deepEqual(transport.calls.slice(-3), [
    { name: "action_hover", args: { target: { selector: "button.help" } } },
    { name: "action_press_key", args: { target: { selector: "input[name=q]" }, key: "Enter" } },
    { name: "action_select", args: { target: { selector: "select[name=country]" }, value: "US" } },
  ]);
});

test("locator selectOption can require safety confirmation", async () => {
  const confirmations = [];
  const transport = fakeTransport();
  const link2chrome = createLink2ChromeClient({
    transport,
    confirmAction: async (action) => {
      confirmations.push(action);
      return false;
    },
  });
  const browser = await link2chrome.browsers.get("extension");
  const [tab] = await browser.tabs.list();

  await assert.rejects(
    () => tab.playwright.locator("select[name=plan]").selectOption("enterprise", {
      safety: { level: "always-confirm", reason: "change plan" },
    }),
    /Action was not confirmed/
  );

  assert.equal(confirmations[0].type, "selectOption");
  assert.deepEqual(confirmations[0].target, { selector: "select[name=plan]" });
  assert.equal(confirmations[0].value, "enterprise");
  assert.notEqual(transport.calls.at(-1)?.name, "action_select");
});

test("locator waitFor maps selector waits to browser wait command", async () => {
  const transport = fakeTransport();
  const browser = await createLink2ChromeClient({ transport }).browsers.get("extension");
  const [tab] = await browser.tabs.list();

  await tab.playwright.locator("#ready").waitFor({ state: "visible", timeout: 2000 });

  assert.deepEqual(transport.calls.at(-1), {
    name: "browser.wait",
    args: { condition: "dom-ready", selector: "#ready", state: "visible", timeout: 2000 },
  });
});

test("locator setFiles maps to upload_file", async () => {
  const transport = fakeTransport();
  const browser = await createLink2ChromeClient({ transport }).browsers.get("extension");
  const [tab] = await browser.tabs.list();

  await tab.playwright.locator("input[type='file']").setFiles(["/tmp/a.txt", "/tmp/b.txt"]);

  assert.deepEqual(transport.calls.at(-1), {
    name: "upload_file",
    args: {
      selector: "input[type='file']",
      paths: ["/tmp/a.txt", "/tmp/b.txt"],
    },
  });
});

test("locator setFiles can require safety confirmation", async () => {
  const confirmations = [];
  const transport = fakeTransport();
  const link2chrome = createLink2ChromeClient({
    transport,
    confirmAction: async (action) => {
      confirmations.push(action);
      return false;
    },
  });
  const browser = await link2chrome.browsers.get("extension");
  const [tab] = await browser.tabs.list();

  await assert.rejects(
    () => tab.playwright.locator("input[type='file']").setFiles("/tmp/secret.txt", {
      safety: { level: "always-confirm", reason: "upload local file" },
    }),
    /Action was not confirmed/
  );

  assert.equal(confirmations[0].type, "filechooser.setFiles");
  assert.deepEqual(confirmations[0].paths, ["/tmp/secret.txt"]);
  assert.notEqual(transport.calls.at(-1)?.name, "upload_file");
});

test("getByText count maps to browser.dom.search", async () => {
  const transport = {
    calls: [],
    async command(name, args = {}) {
      this.calls.push({ name, args });
      if (name === "browser.dom.search") {
        return { matches: [{ text: "More information" }, { text: "More links" }] };
      }
      return { tabs: [{ id: 7, active: true }] };
    },
  };
  const browser = await createLink2ChromeClient({ transport }).browsers.get("extension");
  const [tab] = await browser.tabs.list();

  const count = await tab.playwright.getByText("More").count();

  assert.equal(count, 2);
  assert.deepEqual(transport.calls.at(-1), {
    name: "browser.dom.search",
    args: { query: "More" },
  });
});

test("getByRole click maps to browser.dom.click with role and name target", async () => {
  const transport = fakeTransport();
  const browser = await createLink2ChromeClient({ transport }).browsers.get("extension");
  const [tab] = await browser.tabs.list();

  await tab.playwright.getByRole("button", { name: "Search" }).click();

  assert.deepEqual(transport.calls.at(-1), {
    name: "browser.dom.click",
    args: {
      target: {
        selector: 'button, input[type="button"], input[type="submit"], [role="button"]',
        role: "button",
        text: "Search",
      },
    },
  });
});

test("locator click runs safety confirmation before sensitive actions", async () => {
  const confirmations = [];
  const transport = fakeTransport();
  const link2chrome = createLink2ChromeClient({
    transport,
    confirmAction: async (action) => {
      confirmations.push(action);
      return false;
    },
  });
  const browser = await link2chrome.browsers.get("extension");
  const [tab] = await browser.tabs.list();

  await assert.rejects(
    () => tab.playwright.getByRole("button", { name: "Delete" }).click({
      safety: { level: "always-confirm", reason: "delete data" },
    }),
    /Action was not confirmed/
  );

  assert.equal(confirmations.length, 1);
  assert.equal(confirmations[0].type, "click");
  assert.deepEqual(confirmations[0].target, {
    selector: 'button, input[type="button"], input[type="submit"], [role="button"]',
    role: "button",
    text: "Delete",
  });
  assert.notDeepEqual(transport.calls.at(-1), {
    name: "browser.dom.click",
    args: { target: { role: "button", text: "Delete" } },
  });
});

test("cua click maps to browser.cua.click", async () => {
  const transport = fakeTransport();
  const browser = await createLink2ChromeClient({ transport }).browsers.get("extension");
  const [tab] = await browser.tabs.list();

  await tab.cua.click(200, 100);

  assert.deepEqual(transport.calls.at(-1), {
    name: "browser.cua.click",
    args: { x: 200, y: 100 },
  });
});

test("dom_cua visibleDom maps to DOM overview", async () => {
  const transport = fakeTransport();
  const browser = await createLink2ChromeClient({ transport }).browsers.get("extension");
  const [tab] = await browser.tabs.list();

  await tab.dom_cua.visibleDom({ includeHidden: false });

  assert.deepEqual(transport.calls.at(-1), {
    name: "browser.dom.overview",
    args: { includeHidden: false },
  });
});

test("dom_cua query and click map to DOM commands", async () => {
  const transport = fakeTransport();
  const browser = await createLink2ChromeClient({ transport }).browsers.get("extension");
  const [tab] = await browser.tabs.list();

  await tab.dom_cua.query("button.primary", { limit: 5 });
  await tab.dom_cua.click({ selector: "button.primary" });

  assert.deepEqual(transport.calls.slice(-2), [
    { name: "browser.dom.query", args: { selector: "button.primary", limit: 5 } },
    { name: "browser.dom.click", args: { target: { selector: "button.primary" } } },
  ]);
});

test("dev console surface maps capture list and clear commands", async () => {
  const transport = fakeTransport();
  const browser = await createLink2ChromeClient({ transport }).browsers.get("extension");
  const [tab] = await browser.tabs.list();

  await tab.dev.console.start({ maxEntries: 25 });
  await tab.dev.console.list({ types: ["error"], limit: 5 });
  await tab.dev.console.clear();

  assert.deepEqual(transport.calls.slice(-3), [
    { name: "console_capture", args: { action: "start", maxEntries: 25 } },
    { name: "console_list", args: { types: ["error"], limit: 5 } },
    { name: "console_clear", args: {} },
  ]);
});

test("dev network surface maps capture query and replay commands", async () => {
  const transport = fakeTransport();
  const browser = await createLink2ChromeClient({ transport }).browsers.get("extension");
  const [tab] = await browser.tabs.list();

  await tab.dev.network.start({ includeResponseBody: true });
  await tab.dev.network.query({ urlContains: "/api", includeBody: true });
  await tab.dev.network.replay({ id: "net-1" });

  assert.deepEqual(transport.calls.slice(-3), [
    { name: "network_capture", args: { action: "start", includeResponseBody: true } },
    { name: "network_query", args: { urlContains: "/api", includeBody: true } },
    { name: "network_replay", args: { id: "net-1" } },
  ]);
});

test("clipboard surface maps read and write commands", async () => {
  const transport = fakeTransport();
  const browser = await createLink2ChromeClient({ transport }).browsers.get("extension");
  const [tab] = await browser.tabs.list();

  await tab.clipboard.readText();
  await tab.clipboard.writeText("hello");

  assert.deepEqual(transport.calls.slice(-2), [
    { name: "browser.clipboard.readText", args: {} },
    { name: "browser.clipboard.writeText", args: { text: "hello" } },
  ]);
});

test("clipboard write can require safety confirmation", async () => {
  const confirmations = [];
  const transport = fakeTransport();
  const link2chrome = createLink2ChromeClient({
    transport,
    confirmAction: async (action) => {
      confirmations.push(action);
      return false;
    },
  });
  const browser = await link2chrome.browsers.get("extension");
  const [tab] = await browser.tabs.list();

  await assert.rejects(
    () => tab.clipboard.writeText("secret", {
      safety: { level: "always-confirm", reason: "overwrite clipboard" },
    }),
    /Action was not confirmed/
  );

  assert.equal(confirmations[0].type, "clipboard.writeText");
  assert.equal(confirmations[0].text, "secret");
  assert.notEqual(transport.calls.at(-1)?.name, "browser.clipboard.writeText");
});

test("dialog surface maps accept and dismiss to handle_dialog", async () => {
  const transport = fakeTransport();
  const browser = await createLink2ChromeClient({ transport }).browsers.get("extension");
  const [tab] = await browser.tabs.list();

  await tab.dialog.accept({ promptText: "yes", timeout: 1000 });
  await tab.dialog.dismiss();

  assert.deepEqual(transport.calls.slice(-2), [
    { name: "handle_dialog", args: { action: "accept", promptText: "yes", timeout: 1000 } },
    { name: "handle_dialog", args: { action: "dismiss" } },
  ]);
});

test("createWebSocketTransport exports a command transport", () => {
  const transport = createWebSocketTransport({ url: "ws://127.0.0.1:8765", WebSocketImpl: class {} });

  assert.equal(typeof transport.command, "function");
});

test("websocket transport speaks Browser Hub request_id protocol", async () => {
  const sentMessages = [];
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.listeners = {};
      queueMicrotask(() => this.listeners.open?.({}));
    }

    addEventListener(name, handler) {
      this.listeners[name] = handler;
    }

    send(message) {
      const parsed = JSON.parse(message);
      sentMessages.push(parsed);
      this.listeners.message?.({
        data: JSON.stringify({
          request_id: parsed.request_id,
          success: true,
          data: { ok: true, echoed: parsed.command },
        }),
      });
    }

    close() {}
  }
  const transport = createWebSocketTransport({
    url: "ws://127.0.0.1:8766",
    WebSocketImpl: FakeWebSocket,
  });

  const result = await transport.command("agent_browser_tab_info", {});

  assert.deepEqual(result, { ok: true, echoed: "agent_browser_tab_info" });
  assert.equal(sentMessages[0].command, "agent_browser_tab_info");
  assert.deepEqual(sentMessages[0].params, {});
  assert.equal(typeof sentMessages[0].request_id, "string");
});

test("websocket transport maps runtime finalize to extension finalize command", async () => {
  const sentMessages = [];
  class FakeWebSocket {
    constructor() {
      this.listeners = {};
      queueMicrotask(() => this.listeners.open?.({}));
    }

    addEventListener(name, handler) {
      this.listeners[name] = handler;
    }

    send(message) {
      const parsed = JSON.parse(message);
      sentMessages.push(parsed);
      this.listeners.message?.({
        data: JSON.stringify({
          request_id: parsed.request_id,
          success: true,
          data: { ok: true, action: "finalize" },
        }),
      });
    }

    close() {}
  }
  const transport = createWebSocketTransport({ WebSocketImpl: FakeWebSocket });

  await transport.command("browser.tabs.finalize", { keep: [{ tabId: 7, status: "deliverable" }] });

  assert.equal(sentMessages[0].command, "agent_browser_tabs_finalize");
  assert.deepEqual(sentMessages[0].params, { keep: [{ tabId: 7, status: "deliverable" }] });
});

test("websocket transport maps runtime tab switch to extension switch command", async () => {
  const sentMessages = [];
  class FakeWebSocket {
    constructor() {
      this.listeners = {};
      queueMicrotask(() => this.listeners.open?.({}));
    }

    addEventListener(name, handler) {
      this.listeners[name] = handler;
    }

    send(message) {
      const parsed = JSON.parse(message);
      sentMessages.push(parsed);
      this.listeners.message?.({
        data: JSON.stringify({
          request_id: parsed.request_id,
          success: true,
          data: { ok: true, tabId: parsed.params.tabId },
        }),
      });
    }

    close() {}
  }
  const transport = createWebSocketTransport({ WebSocketImpl: FakeWebSocket });

  await transport.command("browser_tab_switch", { tabId: 12 });

  assert.equal(sentMessages[0].command, "agent_browser_tab_switch");
  assert.deepEqual(sentMessages[0].params, { tabId: 12 });
});

test("websocket transport passes dev console and network commands through", async () => {
  const sentMessages = [];
  class FakeWebSocket {
    constructor() {
      this.listeners = {};
      queueMicrotask(() => this.listeners.open?.({}));
    }

    addEventListener(name, handler) {
      this.listeners[name] = handler;
    }

    send(message) {
      const parsed = JSON.parse(message);
      sentMessages.push(parsed);
      this.listeners.message?.({
        data: JSON.stringify({
          request_id: parsed.request_id,
          success: true,
          data: { ok: true },
        }),
      });
    }

    close() {}
  }
  const transport = createWebSocketTransport({ WebSocketImpl: FakeWebSocket });

  await transport.command("console_capture", { action: "start" });
  await transport.command("network_query", { urlContains: "/api" });

  assert.equal(sentMessages[0].command, "console_capture");
  assert.deepEqual(sentMessages[0].params, { action: "start" });
  assert.equal(sentMessages[1].command, "network_query");
  assert.deepEqual(sentMessages[1].params, { urlContains: "/api" });
});

test("websocket transport maps clipboard commands to extension commands", async () => {
  const sentMessages = [];
  class FakeWebSocket {
    constructor() {
      this.listeners = {};
      queueMicrotask(() => this.listeners.open?.({}));
    }

    addEventListener(name, handler) {
      this.listeners[name] = handler;
    }

    send(message) {
      const parsed = JSON.parse(message);
      sentMessages.push(parsed);
      this.listeners.message?.({
        data: JSON.stringify({
          request_id: parsed.request_id,
          success: true,
          data: { ok: true },
        }),
      });
    }

    close() {}
  }
  const transport = createWebSocketTransport({ WebSocketImpl: FakeWebSocket });

  await transport.command("browser.clipboard.readText", {});
  await transport.command("browser.clipboard.writeText", { text: "hello" });

  assert.equal(sentMessages[0].command, "clipboard_read");
  assert.deepEqual(sentMessages[0].params, {});
  assert.equal(sentMessages[1].command, "clipboard_write");
  assert.deepEqual(sentMessages[1].params, { text: "hello" });
});

test("websocket transport maps user history to extension history command", async () => {
  const sentMessages = [];
  class FakeWebSocket {
    constructor() {
      this.listeners = {};
      queueMicrotask(() => this.listeners.open?.({}));
    }

    addEventListener(name, handler) {
      this.listeners[name] = handler;
    }

    send(message) {
      const parsed = JSON.parse(message);
      sentMessages.push(parsed);
      this.listeners.message?.({
        data: JSON.stringify({
          request_id: parsed.request_id,
          success: true,
          data: { ok: true, entries: [] },
        }),
      });
    }

    close() {}
  }
  const transport = createWebSocketTransport({ WebSocketImpl: FakeWebSocket });

  await transport.command("browser.user.history", { text: "docs", maxResults: 5 });

  assert.equal(sentMessages[0].command, "agent_browser_history");
  assert.deepEqual(sentMessages[0].params, { text: "docs", maxResults: 5 });
});

test("websocket transport maps runtime wait to extension wait command", async () => {
  const sentMessages = [];
  class FakeWebSocket {
    constructor() {
      this.listeners = {};
      queueMicrotask(() => this.listeners.open?.({}));
    }

    addEventListener(name, handler) {
      this.listeners[name] = handler;
    }

    send(message) {
      const parsed = JSON.parse(message);
      sentMessages.push(parsed);
      this.listeners.message?.({
        data: JSON.stringify({
          request_id: parsed.request_id,
          success: true,
          data: { ok: true, condition: parsed.params.condition },
        }),
      });
    }

    close() {}
  }
  const transport = createWebSocketTransport({ WebSocketImpl: FakeWebSocket });

  await transport.command("browser.wait", { condition: "dom-ready", selector: "#ready" });

  assert.equal(sentMessages[0].command, "agent_browser_wait");
  assert.deepEqual(sentMessages[0].params, { condition: "dom-ready", selector: "#ready" });
});

test("websocket transport sends lease_token on commands while lease is active", async () => {
  const sentMessages = [];
  class FakeWebSocket {
    constructor() {
      this.listeners = {};
      queueMicrotask(() => this.listeners.open?.({}));
    }

    addEventListener(name, handler) {
      this.listeners[name] = handler;
    }

    send(message) {
      const parsed = JSON.parse(message);
      sentMessages.push(parsed);
      const data = parsed.command === "__hub_acquire__"
        ? { lease_token: "lease-1", lease_name: parsed.params.name }
        : { ok: true };
      this.listeners.message?.({
        data: JSON.stringify({
          request_id: parsed.request_id,
          success: true,
          data,
        }),
      });
    }

    close() {}
  }
  const transport = createWebSocketTransport({ WebSocketImpl: FakeWebSocket });

  await transport.acquireLease("runtime task");
  await transport.command("browser_tab_info", {});
  await transport.releaseLease();

  assert.equal(sentMessages[0].command, "__hub_acquire__");
  assert.deepEqual(sentMessages[0].params, { name: "runtime task" });
  assert.equal(sentMessages[1].command, "agent_browser_tab_info");
  assert.equal(sentMessages[1].lease_token, "lease-1");
  assert.equal(sentMessages[2].command, "__hub_release__");
  assert.deepEqual(sentMessages[2].params, { lease_token: "lease-1" });
});
