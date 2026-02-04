/**
 * Link2Chrome - Content Script
 * 提供页面内高亮框等辅助调试功能
 */

// 高亮覆盖层
let highlightOverlay = null;

function createHighlight(rect) {
  removeHighlight();
  highlightOverlay = document.createElement("div");
  highlightOverlay.id = "link2chrome-highlight";
  Object.assign(highlightOverlay.style, {
    position: "fixed",
    left: rect.x + "px",
    top: rect.y + "px",
    width: rect.w + "px",
    height: rect.h + "px",
    border: "2px solid #FF4444",
    backgroundColor: "rgba(255, 68, 68, 0.15)",
    zIndex: "2147483647",
    pointerEvents: "none",
    borderRadius: "3px",
    transition: "all 0.2s ease"
  });
  document.body.appendChild(highlightOverlay);

  // 2 秒后自动移除
  setTimeout(removeHighlight, 2000);
}

function removeHighlight() {
  if (highlightOverlay && highlightOverlay.parentNode) {
    highlightOverlay.parentNode.removeChild(highlightOverlay);
  }
  highlightOverlay = null;
}

// 监听来自 background 的高亮指令
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "highlight") {
    createHighlight(message.rect);
    sendResponse({ ok: true });
  }
  return true;
});
