const dot = document.getElementById("dot");
const statusText = document.getElementById("statusText");
const reconnectBtn = document.getElementById("reconnectBtn");

function updateUI(connected) {
  if (connected) {
    dot.className = "dot connected";
    statusText.textContent = "已连接";
    reconnectBtn.disabled = true;
  } else {
    dot.className = "dot disconnected";
    statusText.textContent = "未连接";
    reconnectBtn.disabled = false;
  }
}

// 查询当前状态
chrome.runtime.sendMessage({ type: "getStatus" }, (response) => {
  if (response) {
    updateUI(response.connected);
  } else {
    updateUI(false);
  }
});

// 监听状态变化
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "status") {
    updateUI(message.connected);
  }
});

// 重连按钮
reconnectBtn.addEventListener("click", () => {
  reconnectBtn.disabled = true;
  statusText.textContent = "连接中...";
  chrome.runtime.sendMessage({ type: "reconnect" }, () => {
    // 2 秒后重新查询状态
    setTimeout(() => {
      chrome.runtime.sendMessage({ type: "getStatus" }, (response) => {
        if (response) {
          updateUI(response.connected);
        }
      });
    }, 2000);
  });
});
