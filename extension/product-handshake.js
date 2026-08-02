(function initProductHandshake(root, factory) {
  const api = factory();
  root.ChromeXProductHandshake = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createProductHandshake() {
  const productId = "chromex";
  const browserKind = "chrome";
  const protocolVersion = 2;

  function buildExtensionHello({ extensionId, buildVersion }) {
    return {
      type: "hello",
      productId,
      browserKind,
      extensionId,
      protocolVersion,
      buildVersion,
    };
  }

  function isAcceptedHelloAck(message) {
    return Boolean(
      message
      && message.type === "hello_ack"
      && message.accepted === true
      && message.productId === productId
      && message.browserKind === browserKind
      && message.protocolVersion === protocolVersion
    );
  }

  return { buildExtensionHello, isAcceptedHelloAck };
});
