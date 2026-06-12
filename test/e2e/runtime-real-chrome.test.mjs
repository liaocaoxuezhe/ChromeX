import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  createLink2ChromeClient,
  createWebSocketTransport,
} from "../../runtime/link2chrome-client.mjs";

const enabled = process.env.LINK2CHROME_REAL_CHROME_E2E === "1";

test("real Chrome runtime surfaces work through Browser Hub and extension", {
  skip: enabled ? false : "set LINK2CHROME_REAL_CHROME_E2E=1 to run real Chrome E2E",
}, async (t) => {
  const server = process.env.LINK2CHROME_E2E_START_SERVER === "0"
    ? null
    : startServer(t);
  const link2chrome = createLink2ChromeClient({
    transport: createWebSocketTransport({
      url: process.env.LINK2CHROME_WS_URL || "ws://localhost:8766",
    }),
  });

  try {
    const readiness = await waitForReadiness(link2chrome, {
      timeoutMs: Number(process.env.LINK2CHROME_E2E_TIMEOUT_MS || 15000),
    });
    const browser = await link2chrome.browsers.get("extension");
    const tab = await browser.tabs.selected();

    await tab.playwright.waitForLoadState("domcontentloaded");
    const bodyCount = await tab.playwright.locator("body").count();
    const screenshot = await tab.cua.screenshot();
    const bodyQuery = await tab.dom_cua.query("body");

    assert.equal(readiness.ok, true);
    assert.ok(bodyCount >= 1);
    assert.equal(Boolean(screenshot.data), true);
    assert.equal(Array.isArray(bodyQuery.results || bodyQuery.elements || bodyQuery.matches), true);
  } catch (error) {
    const diagnostics = await collectFailureDiagnostics(link2chrome, server);
    error.message = `${error.message}\nE2E diagnostics:\n${JSON.stringify(diagnostics, null, 2)}`;
    throw error;
  }
});

function startServer(t) {
  const python = process.env.PYTHON_BIN || "python3";
  const child = spawn(python, ["server/main.py"], {
    cwd: process.cwd(),
    env: { ...process.env, LOG_CONSOLE: "false" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  t.after(() => {
    child.kill("SIGTERM");
  });
  return { child, stderr };
}

async function waitForReadiness(link2chrome, { timeoutMs, intervalMs = 500 }) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await link2chrome.diagnostics.readiness();
    if (last.ok) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  const error = new Error("Timed out waiting for real Chrome Link2Chrome readiness");
  error.readiness = last;
  throw error;
}

async function collectFailureDiagnostics(link2chrome, server) {
  let readiness = null;
  let diagnostics = null;
  try {
    readiness = await link2chrome.diagnostics.readiness();
  } catch (error) {
    readiness = { ok: false, error: String(error?.message || error) };
  }
  try {
    diagnostics = await link2chrome.diagnostics();
  } catch (error) {
    diagnostics = { ok: false, error: String(error?.message || error) };
  }
  return {
    chromeRunning: diagnostics?.chromeRunning || null,
    extensionInstalled: diagnostics?.extensionInstalled || null,
    websocket: readiness?.hub || null,
    extension: readiness?.extension || null,
    selectedTab: readiness?.selectedTab || null,
    readiness,
    server: server
      ? {
        pid: server.child.pid,
        exitCode: server.child.exitCode,
        stderr: server.stderr.join("").slice(-4000),
      }
      : null,
  };
}
