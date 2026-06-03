import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  createNativeMessagingTransport,
  createLink2ChromeClient,
} from "../runtime/link2chrome-client.mjs";
import {
  HOST_NAME,
  createNativeHostManifest,
  getChromeNativeMessagingManifestPath,
} from "../scripts/native-host/installManifest.mjs";
import {
  createNativeHostCommandHandler,
  decodeNativeMessages,
  encodeNativeMessage,
} from "../scripts/native-host/native-host.mjs";

test("native host manifest path uses the macOS Chrome NativeMessagingHosts directory", () => {
  const manifestPath = getChromeNativeMessagingManifestPath({ homeDir: "/Users/alice" });

  assert.equal(
    manifestPath,
    `/Users/alice/Library/Application Support/Google/Chrome/NativeMessagingHosts/${HOST_NAME}.json`
  );
});

test("native host manifest includes stdio host metadata and allowed extension origin", () => {
  const manifest = createNativeHostManifest({
    hostPath: "/Applications/Link2Chrome/native-host.mjs",
    extensionId: "abcdefghijklmnopabcdefghijklmnop",
  });

  assert.deepEqual(manifest, {
    name: HOST_NAME,
    description: "Link2Chrome native messaging host",
    type: "stdio",
    path: "/Applications/Link2Chrome/native-host.mjs",
    allowed_origins: ["chrome-extension://abcdefghijklmnopabcdefghijklmnop/"],
  });
});

test("native host framing encodes and decodes little-endian JSON messages", () => {
  const encoded = encodeNativeMessage({ id: 3, name: "browser_tab_info", args: { active: true } });

  assert.equal(encoded.readUInt32LE(0), encoded.length - 4);
  assert.deepEqual(decodeNativeMessages(encoded), {
    messages: [{ id: 3, name: "browser_tab_info", args: { active: true } }],
    remainder: Buffer.alloc(0),
  });
});

test("native messaging transport sends framed commands to the spawned host", async () => {
  const child = new EventEmitter();
  child.stdin = {
    writes: [],
    write(chunk) {
      this.writes.push(Buffer.from(chunk));
    },
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const spawnCalls = [];
  const transport = createNativeMessagingTransport({
    hostPath: "/tmp/link2chrome-native-host.mjs",
    spawnImpl: (...args) => {
      spawnCalls.push(args);
      return child;
    },
  });

  const commandPromise = transport.command("browser_tab_info", { tabId: 7 });
  const outbound = decodeNativeMessages(child.stdin.writes[0]).messages[0];
  assert.deepEqual(spawnCalls[0], ["/tmp/link2chrome-native-host.mjs", [], { stdio: ["pipe", "pipe", "pipe"] }]);
  assert.deepEqual(outbound, { id: 1, name: "browser_tab_info", args: { tabId: 7 } });

  child.stdout.emit("data", encodeNativeMessage({ id: 1, result: { ok: true, tabId: 7 } }));

  assert.deepEqual(await commandPromise, { ok: true, tabId: 7 });
  assert.equal(transport.nativeMessaging, true);
});

test("runtime diagnostics capabilities report native messaging from transport state", async () => {
  const transport = {
    nativeMessaging: true,
    async command(name) {
      if (name === "__hub_status__") return { extension_connected: true };
      if (name === "browser_tab_info") return { id: 7 };
      return { ok: true };
    },
  };
  const client = createLink2ChromeClient({
    transport,
    localEnvironment: { inspect: async () => ({ ok: true }) },
  });

  const readiness = await client.diagnostics.readiness();

  assert.equal(readiness.capabilities.nativeMessaging, true);
});

test("native host command handler starts Browser Hub and reports status", async () => {
  const spawnCalls = [];
  const hubStatusCalls = [];
  let hubStatusAttempt = 0;
  const handler = createNativeHostCommandHandler({
    projectRoot: "/repo/Link2Chrome",
    pythonBin: "python3.9",
    spawnImpl: (...args) => {
      spawnCalls.push(args);
      return { pid: 42, unref() {} };
    },
    hubCommand: async (name, args) => {
      hubStatusCalls.push({ name, args });
      if (name === "__hub_status__" && hubStatusAttempt++ === 0) {
        throw new Error("not running");
      }
      return { hub_id: "hub-test", extension_connected: true };
    },
  });

  assert.deepEqual(await handler("__native_start_hub__", {}), {
    ok: true,
    alreadyRunning: false,
    pid: 42,
  });
  assert.deepEqual(await handler("__native_status__", {}), {
    ok: true,
    hub: { hub_id: "hub-test", extension_connected: true },
    hubProcess: { running: true, pid: 42 },
  });
  assert.deepEqual(spawnCalls[0], [
    "python3.9",
    ["/repo/Link2Chrome/server/browser_hub.py"],
    {
      cwd: "/repo/Link2Chrome",
      env: { ...process.env, LOG_CONSOLE: "false" },
      stdio: ["ignore", "ignore", "pipe"],
    },
  ]);
  assert.deepEqual(hubStatusCalls, [
    { name: "__hub_status__", args: {} },
    { name: "__hub_status__", args: {} },
  ]);
});

test("native host command handler does not spawn Browser Hub when an existing hub is reachable", async () => {
  const spawnCalls = [];
  const handler = createNativeHostCommandHandler({
    projectRoot: "/repo/Link2Chrome",
    spawnImpl: (...args) => {
      spawnCalls.push(args);
      return { pid: 42, unref() {} };
    },
    hubCommand: async (name) => {
      if (name === "__hub_status__") return { hub_id: "existing", extension_connected: true };
      return { ok: true };
    },
  });

  assert.deepEqual(await handler("__native_start_hub__", {}), {
    ok: true,
    alreadyRunning: true,
    pid: null,
  });
  assert.deepEqual(spawnCalls, []);
});
