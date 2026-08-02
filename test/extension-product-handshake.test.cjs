const test = require("node:test");
const assert = require("node:assert/strict");

const handshake = require("../extension/product-handshake.js");

test("ChromeX extension emits its stable product hello", () => {
  assert.deepEqual(
    handshake.buildExtensionHello({
      extensionId: "gfmbcnhkhgdlpcdhmolaefigfapbamcg",
      buildVersion: "test-build",
    }),
    {
      type: "hello",
      productId: "chromex",
      browserKind: "chrome",
      extensionId: "gfmbcnhkhgdlpcdhmolaefigfapbamcg",
      protocolVersion: 2,
      buildVersion: "test-build",
    },
  );
});

test("ChromeX extension accepts only matching Hub acknowledgement", () => {
  assert.equal(handshake.isAcceptedHelloAck({
    type: "hello_ack",
    accepted: true,
    productId: "chromex",
    browserKind: "chrome",
    protocolVersion: 2,
  }), true);
  assert.equal(handshake.isAcceptedHelloAck({
    type: "hello_ack",
    accepted: true,
    productId: "tabbitdance",
    browserKind: "tabbit",
    protocolVersion: 2,
  }), false);
});
