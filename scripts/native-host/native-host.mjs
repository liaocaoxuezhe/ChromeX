import { fileURLToPath } from "node:url";

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

async function main() {
  const runtime = createNativeHostRuntime({
    commandHandler: async (name, args) => ({ ok: false, error: "not_connected", name, args }),
  });
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
