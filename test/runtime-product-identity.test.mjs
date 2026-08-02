import assert from "node:assert/strict";
import test from "node:test";

import { createWebSocketTransport } from "../runtime/link2chrome-client.mjs";

function socketFor(identity, sent) {
  return class FakeWebSocket {
    constructor() {
      this.listeners = new Map();
      queueMicrotask(() => this.listeners.get("open")?.());
    }
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    send(raw) {
      const request = JSON.parse(raw);
      sent.push(request);
      queueMicrotask(() => this.listeners.get("message")?.({
        data: JSON.stringify({
          request_id: request.request_id,
          success: true,
          data: identity,
        }),
      }));
    }
    close() {}
  };
}

test("ChromeX runtime health check accepts only ChromeX Hub identity", async () => {
  const accepted = createWebSocketTransport({
    WebSocketImpl: socketFor({
      productId: "chromex",
      browserKind: "chrome",
      protocolVersion: 2,
    }, []),
  });
  assert.equal(await accepted.healthCheck(), true);

  const sent = [];
  const rejected = createWebSocketTransport({
    WebSocketImpl: socketFor({
      productId: "tabbitdance",
      browserKind: "tabbit",
      protocolVersion: 2,
    }, sent),
  });
  await assert.rejects(
    rejected.healthCheck(),
    (error) => error.code === "HUB_PRODUCT_MISMATCH",
  );
  assert.equal(sent[0].command, "__hub_status__");
});
