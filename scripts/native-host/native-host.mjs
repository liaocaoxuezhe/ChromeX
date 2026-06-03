import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import path from "node:path";

export function encodeNativeMessage(message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

export function decodeNativeMessages(buffer) {
  let offset = 0;
  const messages = [];
  while (buffer.length - offset >= 4) {
    const length = buffer.readUInt32LE(offset);
    const payloadStart = offset + 4;
    const payloadEnd = payloadStart + length;
    if (buffer.length < payloadEnd) break;
    const payload = buffer.subarray(payloadStart, payloadEnd).toString("utf8");
    messages.push(JSON.parse(payload));
    offset = payloadEnd;
  }
  return {
    messages,
    remainder: buffer.subarray(offset),
  };
}

export function createNativeHostRuntime({ commandHandler }) {
  let pending = Buffer.alloc(0);
  return {
    async accept(chunk, write) {
      pending = Buffer.concat([pending, Buffer.from(chunk)]);
      const decoded = decodeNativeMessages(pending);
      pending = decoded.remainder;
      for (const message of decoded.messages) {
        try {
          const result = await commandHandler(message.name, message.args || {});
          write(encodeNativeMessage({ id: message.id, result }));
        } catch (error) {
          write(encodeNativeMessage({
            id: message.id,
            error: String(error?.message || error),
          }));
        }
      }
    },
  };
}

export function createNativeHostCommandHandler({
  projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."),
  pythonBin = process.env.PYTHON_BIN || "python3",
  spawnImpl = spawn,
  hubCommand,
} = {}) {
  let hubProcess = null;
  const commandHub = hubCommand || ((name, args = {}) => sendHubCommand({
    url: process.env.LINK2CHROME_WS_URL || "ws://localhost:8766",
    name,
    args,
  }));

  const isHubProcessRunning = () => Boolean(hubProcess && (hubProcess.exitCode === null || hubProcess.exitCode === undefined));

  const startHub = () => {
    if (isHubProcessRunning()) {
      return { ok: true, alreadyRunning: true, pid: hubProcess.pid };
    }
    hubProcess = spawnImpl(pythonBin, [path.join(projectRoot, "server", "browser_hub.py")], {
      cwd: projectRoot,
      env: { ...process.env, LOG_CONSOLE: "false" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    hubProcess.unref?.();
    return { ok: true, alreadyRunning: false, pid: hubProcess.pid };
  };

  return async (name, args = {}) => {
    if (name === "__native_start_hub__") {
      return startHub();
    }
    if (name === "__native_status__") {
      let hub = null;
      try {
        hub = await commandHub("__hub_status__", {});
      } catch (error) {
        hub = { ok: false, error: String(error?.message || error) };
      }
      return {
        ok: true,
        hub,
        hubProcess: {
          running: isHubProcessRunning(),
          pid: hubProcess?.pid || null,
        },
      };
    }
    if (!isHubProcessRunning()) {
      startHub();
    }
    return commandHub(name, args);
  };
}

function sendHubCommand({ url, name, args = {} }) {
  return new Promise((resolve, reject) => {
    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const ws = new WebSocket(url);
    const timeout = setTimeout(() => {
      try { ws.close(); } catch (_) {}
      reject(new Error(`Browser Hub native command timed out: ${name}`));
    }, 10000);

    ws.onopen = () => {
      ws.send(JSON.stringify({
        request_id: requestId,
        command: name,
        params: args,
      }));
    };
    ws.onmessage = (event) => {
      clearTimeout(timeout);
      try { ws.close(); } catch (_) {}
      const response = JSON.parse(event.data);
      if (!response.success) {
        reject(new Error(response.error || `Browser Hub command failed: ${name}`));
        return;
      }
      resolve(response.data || {});
    };
    ws.onerror = () => {
      clearTimeout(timeout);
      reject(new Error(`Browser Hub native websocket error: ${name}`));
    };
  });
}

async function main() {
  const runtime = createNativeHostRuntime({ commandHandler: createNativeHostCommandHandler() });
  process.stdin.on("data", (chunk) => {
    runtime.accept(chunk, (response) => process.stdout.write(response));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message || String(error));
    process.exitCode = 1;
  });
}
