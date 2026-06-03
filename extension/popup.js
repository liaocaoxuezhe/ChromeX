const dot = document.getElementById("dot");
const statusText = document.getElementById("statusText");
const statusDetail = document.getElementById("statusDetail");
const statusCard = document.getElementById("statusCard");
const reconnectBtn = document.getElementById("reconnectBtn");
const enableToggle = document.getElementById("enableToggle");
const toggleHint = document.getElementById("toggleHint");

function updateUI(statusOrConnected, enabled) {
  const status = typeof statusOrConnected === "object"
    ? statusOrConnected
    : { connected: statusOrConnected, enabled };
  const connected = Boolean(status.connected || status.wsConnected);
  const nativeConnected = Boolean(status.nativeConnected);
  enabled = status.enabled !== false;
  statusCard.classList.toggle("dimmed", !enabled);

  if (!enabled) {
    dot.className = "status-dot";
    statusText.textContent = "已停用";
    statusDetail.textContent = "";
    reconnectBtn.disabled = true;
    toggleHint.textContent = "已关闭";
    return;
  }

  toggleHint.textContent = "启用连接";

  if (connected) {
    dot.className = "status-dot connected";
    statusText.textContent = "已连接";
    statusDetail.textContent = nativeConnected ? "Native Host + :8765" : "WebSocket :8765";
    reconnectBtn.disabled = true;
  } else {
    dot.className = "status-dot disconnected";
    statusText.textContent = nativeConnected ? "Hub 未连接" : "未连接";
    statusDetail.textContent = nativeConnected ? "Native Host 已连接" : "Native Host / :8765";
    reconnectBtn.disabled = false;
  }
}

// 初始化：查询当前状态（包含 enabled）
chrome.runtime.sendMessage({ type: "getStatus" }, (response) => {
  if (response) {
    enableToggle.checked = response.enabled !== false;
    updateUI(response);
  } else {
    enableToggle.checked = true;
    updateUI(false, true);
  }
});

// 监听来自 background 的状态广播
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "status") {
    enableToggle.checked = message.enabled !== false;
    updateUI(message);
  }
});

// 开关切换
enableToggle.addEventListener("change", () => {
  const enabled = enableToggle.checked;

  // 乐观更新 UI
  if (!enabled) {
    updateUI(false, false);
  } else {
    dot.className = "status-dot connecting";
    statusText.textContent = "连接中...";
    statusDetail.textContent = "ws://localhost:8765";
    reconnectBtn.disabled = true;
    statusCard.classList.remove("dimmed");
    toggleHint.textContent = "允许 MCP 控制浏览器";
  }

  chrome.runtime.sendMessage({ type: "setEnabled", enabled }, (response) => {
    // background 会广播新状态，这里不需要额外处理
    if (chrome.runtime.lastError) {
      // 连接错误时回退
      enableToggle.checked = !enabled;
      updateUI(false, !enabled);
    }
  });
});

// 重连按钮
reconnectBtn.addEventListener("click", () => {
  reconnectBtn.disabled = true;
  dot.className = "status-dot connecting";
  statusText.textContent = "连接中...";

  chrome.runtime.sendMessage({ type: "reconnect" }, () => {
    setTimeout(() => {
      chrome.runtime.sendMessage({ type: "getStatus" }, (response) => {
        if (response) {
          enableToggle.checked = response.enabled !== false;
          updateUI(response);
        }
      });
    }, 2000);
  });
});
