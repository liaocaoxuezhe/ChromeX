(function exposeConnectionPolicy(root, factory) {
  const policy = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = policy;
  }
  root.Link2ChromeConnectionPolicy = policy;
})(typeof globalThis !== "undefined" ? globalThis : this, function createConnectionPolicy() {
  const DUPLICATE_CLOSE_CODE = 1008;
  const DUPLICATE_CLOSE_REASON = "duplicate Link2Chrome extension connection";

  function isDuplicateConnectionClose(event = {}) {
    return event.code === DUPLICATE_CLOSE_CODE
      && event.reason === DUPLICATE_CLOSE_REASON;
  }

  function standbyDisplay() {
    return {
      dotClass: "status-dot standby",
      statusText: "待机",
      statusDetail: "其他 Chrome 实例正在使用",
      reconnectDisabled: false,
      toggleHint: "可手动尝试接管",
    };
  }

  return {
    DUPLICATE_CLOSE_CODE,
    DUPLICATE_CLOSE_REASON,
    isDuplicateConnectionClose,
    standbyDisplay,
  };
});
