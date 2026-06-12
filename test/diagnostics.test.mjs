import test from "node:test";
import assert from "node:assert/strict";
import { createLink2ChromeClient } from "../runtime/link2chrome-client.mjs";

test("diagnostics aggregates chrome runtime checks", async () => {
  const client = createLink2ChromeClient({
    transport: { async command() { return { ok: true }; } },
    diagnosticsChecks: {
      chromeRunning: async () => ({ ok: true }),
      installedBrowsers: async () => ({ ok: true, browsers: [] }),
      extensionInstalled: async () => ({ ok: true }),
      nativeHostManifest: async () => ({ ok: true }),
    },
  });

  const result = await client.diagnostics();

  assert.deepEqual(result, {
    chromeRunning: { ok: true },
    installedBrowsers: { ok: true, browsers: [] },
    extensionInstalled: { ok: true },
    nativeHostManifest: { ok: true },
  });
});

test("diagnostics keeps readiness helper available", async () => {
  const client = createLink2ChromeClient({
    transport: {
      async command(name) {
        if (name === "__hub_status__") return { extension_connected: true };
        if (name === "browser_tab_info") return { id: 7 };
        return { ok: true };
      },
    },
    localEnvironment: { inspect: async () => ({ ok: true }) },
  });

  const readiness = await client.diagnostics.readiness();

  assert.equal(readiness.ok, true);
});
