(function installFocusPolicy(root) {
  function buildBackgroundTabCreateProperties(options = {}, anchorTab = null) {
    const { active: _active, selected: _selected, ...properties } = options || {};

    if (anchorTab) {
      if (properties.windowId == null && anchorTab.windowId != null) {
        properties.windowId = anchorTab.windowId;
      }
      if (properties.index == null && Number.isInteger(anchorTab.index)) {
        properties.index = anchorTab.index + 1;
      }
      if (properties.openerTabId == null && anchorTab.id != null) {
        properties.openerTabId = anchorTab.id;
      }
    }

    return { ...properties, active: false };
  }

  function canReuseDebuggerAttachment(attachedTabId, expectedTabId) {
    return expectedTabId != null && attachedTabId === expectedTabId;
  }

  root.Link2ChromeFocusPolicy = Object.freeze({
    buildBackgroundTabCreateProperties,
    canReuseDebuggerAttachment,
  });
})(globalThis);
