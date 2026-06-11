/**
 * Link2Chrome - Background Service Worker
 * 负责 WebSocket 客户端连接、CDP 操作分发、debugger 管理
 */

// ==================== 状态管理 ====================
const BUILD_VERSION = "2026-06-01-plan-c-keepalive";
let ws = null;
let wsConnected = false;
let nativePort = null;
let nativeConnected = false;
let nativeStatus = null;
let nativeHubStarted = false;
let connectionEnabled = true; // 用户可通过 popup 开关控制
let attachedTabId = null;
// 显式跟踪当前工作标签（解决 active tab 返回 chrome-extension:// 页面的问题）
let targetTabId = null;
let reconnectAttempts = 0;
let reconnectTimer = null;
const MAX_RECONNECT_ATTEMPTS = 10;
const WS_URL = "ws://localhost:8765";
const NATIVE_HOST_NAME = "com.link2chrome.nativehost";
const EXPECTED_EXTENSION_ID = "gfmbcnhkhgdlpcdhmolaefigfapbamcg";
const HEARTBEAT_INTERVAL = 30000;
const KEEPALIVE_ALARM = "link2chrome.keepalive";
const KEEPALIVE_PERIOD_MINUTES = 0.5;
const CDP_COMMAND_TIMEOUT = 10000;
let heartbeatTimer = null;
const networkCaptureState = {
  enabled: false,
  includeResponseBody: false,
  maxEntries: 500,
  entries: [],
  byRequestId: new Map()
};
const consoleCaptureState = {
  enabled: false,
  maxEntries: 300,
  entries: []
};
let currentDialog = null;
let networkSequence = 0;
let consoleSequence = 0;
const downloadState = {
  pending: new Map(),
  completed: new Map(),
};
let downloadsFallbackRegistered = false;

// 不可调试的 URL 前缀
const UNDEBUGABLE_PREFIXES = [
  "chrome-extension://",
  "chrome://",
  "chrome-search://",
  "devtools://",
  "about:",
  "data:",
];

function isDebugableUrl(url) {
  if (!url) {
    console.log("[Link2Chrome] URL 为空，不可调试");
    return false;
  }
  const isDebugable = !UNDEBUGABLE_PREFIXES.some(prefix => url.startsWith(prefix));
  if (!isDebugable) {
    console.log(`[Link2Chrome] URL 不可调试: ${url}`);
  }
  return isDebugable;
}

// ==================== Native Host / WebSocket 管理 ====================

function isExpectedExtensionId() {
  return chrome.runtime.id === EXPECTED_EXTENSION_ID;
}

function markExtensionIdMismatch() {
  nativeConnected = false;
  wsConnected = false;
  nativeStatus = {
    ok: false,
    error: "extension_id_mismatch",
    expectedId: EXPECTED_EXTENSION_ID,
    actualId: chrome.runtime.id
  };
  broadcastStatus();
}

function connectNativeBootstrap() {
  if (!connectionEnabled) return Promise.resolve({ ok: false, reason: "disabled" });
  if (!isExpectedExtensionId()) {
    markExtensionIdMismatch();
    return Promise.resolve(nativeStatus);
  }
  if (nativePort && nativeConnected) {
    return Promise.resolve(nativeStatus || { ok: true, state: "connected" });
  }
  if (!chrome.runtime.connectNative) {
    nativeConnected = false;
    nativeStatus = { ok: false, error: "nativeMessaging unavailable" };
    return Promise.resolve(nativeStatus);
  }

  return new Promise((resolve) => {
    let settled = false;
    try {
      const port = chrome.runtime.connectNative("com.link2chrome.nativehost");
      nativePort = port;
      nativeConnected = true;
      nativeStatus = { ok: true, state: "connected" };

      port.onMessage.addListener((message) => {
        if (message?.id !== "__native_start_hub__") return;
        nativeStatus = {
          ok: !message.error,
          result: message.result || null,
          error: message.error || null
        };
        nativeHubStarted = Boolean(nativeStatus.ok);
        if (!settled) {
          settled = true;
          resolve(nativeStatus);
        }
        broadcastStatus();
      });

      port.onDisconnect.addListener(() => {
        nativeConnected = false;
        nativePort = null;
        const lastError = chrome.runtime.lastError?.message || "";
        if (nativeHubStarted && nativeStatus?.ok) {
          nativeStatus = {
            ...nativeStatus,
            state: "bootstrap_disconnected",
            lastDisconnect: lastError || "native host disconnected after bootstrap"
          };
        } else {
          nativeStatus = {
            ok: false,
            error: lastError || "native host disconnected"
          };
        }
        broadcastStatus();
      });

      port.postMessage({ id: "__native_start_hub__", name: "__native_start_hub__", args: {} });
      setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve(nativeStatus);
        }
      }, 1500);
    } catch (err) {
      nativeConnected = false;
      nativePort = null;
      nativeHubStarted = false;
      nativeStatus = { ok: false, error: err.message || String(err) };
      resolve(nativeStatus);
    }
  });
}

function connectWebSocket() {
  if (!connectionEnabled) return;
  if (!isExpectedExtensionId()) {
    markExtensionIdMismatch();
    return;
  }
  // 避免 CONNECTING 阶段重复创建连接，导致连接风暴
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  try {
    const socket = new WebSocket(WS_URL);
    ws = socket;

    socket.onopen = () => {
      // 旧连接的回调不应覆盖当前状态
      if (ws !== socket) {
        try { socket.close(); } catch (_) {}
        return;
      }
      console.log("[Link2Chrome] WebSocket 已连接");
      wsConnected = true;
      reconnectAttempts = 0;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      broadcastStatus();
      startHeartbeat();
    };

    socket.onmessage = async (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === "pong") return;
        const result = await handleCommand(message);
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify(result));
        }
      } catch (err) {
        console.error("[Link2Chrome] 处理消息出错:", err);
        if (event.data) {
          try {
            const msg = JSON.parse(event.data);
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({
                request_id: msg.request_id,
                success: false,
                error: err.message
              }));
            }
          } catch (_) {}
        }
      }
    };

    socket.onclose = () => {
      // 忽略陈旧连接的关闭事件，防止误触发重连
      if (ws !== socket) return;
      console.log("[Link2Chrome] WebSocket 已断开");
      wsConnected = false;
      ws = null;
      broadcastStatus();
      stopHeartbeat();
      scheduleReconnect();
    };

    socket.onerror = (err) => {
      if (ws !== socket) return;
      console.error("[Link2Chrome] WebSocket 错误:", err);
    };
  } catch (err) {
    console.error("[Link2Chrome] 创建 WebSocket 失败:", err);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (!connectionEnabled) return;
  if (reconnectTimer) return;
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.log("[Link2Chrome] 已达最大重连次数，停止重连");
    return;
  }
  // 第一次重连立即执行，后续使用指数退避
  const delay = reconnectAttempts === 0 ? 0 : Math.min(1000 * Math.pow(2, reconnectAttempts - 1), 32000);
  reconnectAttempts++;
  if (delay === 0) {
    console.log(`[Link2Chrome] 立即尝试第 ${reconnectAttempts} 次重连`);
  } else {
    console.log(`[Link2Chrome] ${delay / 1000}s 后尝试第 ${reconnectAttempts} 次重连`);
  }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWebSocket();
  }, delay);
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    keepAliveTick();
  }, HEARTBEAT_INTERVAL);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

async function keepAliveTick() {
  if (!connectionEnabled) return;
  await chrome.storage.local.set({
    lastKeepaliveAt: Date.now(),
    wsConnected,
    buildVersion: BUILD_VERSION
  }).catch(() => {});

  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ type: "ping", source: "keepalive" }));
      return;
    } catch (err) {
      console.warn("[Link2Chrome] keepalive ping 失败:", err);
    }
  }

  if (!ws || ws.readyState === WebSocket.CLOSED) {
    scheduleReconnect();
  }
}

function setupKeepaliveAlarm() {
  if (!chrome.alarms) {
    console.warn("[Link2Chrome] chrome.alarms 不可用，使用心跳定时器兜底");
    return;
  }
  chrome.alarms.create(KEEPALIVE_ALARM, {
    periodInMinutes: KEEPALIVE_PERIOD_MINUTES
  });
}

chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    keepAliveTick();
  }
});

// ==================== Debugger 管理 ====================

/**
 * 查找一个可调试的标签页 ID。
 * excludeIds: 排除已知失败的 tab ID
 */
async function findUsableTabId(excludeIds = new Set()) {
  console.log(`[Link2Chrome] 查找可用标签页, targetTabId=${targetTabId}, excluded=${[...excludeIds].join(",")}`);

  // 1. 优先使用显式跟踪的 targetTabId
  if (targetTabId && !excludeIds.has(targetTabId)) {
    try {
      const tab = await chrome.tabs.get(targetTabId);
      console.log(`[Link2Chrome] 检查 targetTabId=${targetTabId}, url=${tab.url}`);
      if (isDebugableUrl(tab.url)) {
        console.log(`[Link2Chrome] 使用 targetTabId=${targetTabId}`);
        return targetTabId;
      }
      console.warn(`[Link2Chrome] targetTab ${targetTabId} URL 不可调试: ${tab.url}`);
    } catch (err) {
      console.warn(`[Link2Chrome] targetTab ${targetTabId} 已不存在: ${err.message}`);
    }
    targetTabId = null;
  }

  // 收集候选 tab 的查询策略（按优先级）
  const queries = [
    { active: true, lastFocusedWindow: true },
    { lastFocusedWindow: true },
    {},  // 全部窗口
  ];

  for (const query of queries) {
    const tabs = await chrome.tabs.query(query);
    console.log(`[Link2Chrome] 查询条件: ${JSON.stringify(query)}, 找到 ${tabs.length} 个标签页`);
    for (const tab of tabs) {
      console.log(`[Link2Chrome] 检查标签页 id=${tab.id}, url=${tab.url}, active=${tab.active}`);
      if (!excludeIds.has(tab.id) && isDebugableUrl(tab.url)) {
        targetTabId = tab.id;
        console.log(`[Link2Chrome] 找到可用标签页: ${tab.id} (${tab.url})`);
        return tab.id;
      }
    }
  }

  // 如果没有找到，抛出详细错误
  const allTabs = await chrome.tabs.query({});
  const tabInfo = allTabs.map(t => `id=${t.id}, url=${t.url}`).join("; ");
  console.error(`[Link2Chrome] 所有标签页信息: ${tabInfo}`);

  throw new Error(
    `没有找到可调试的标签页 (excluded=${[...excludeIds].join(",")}, ` +
    `targetTabId=${targetTabId}, 总共 ${allTabs.length} 个标签页)`
  );
}

function isDebuggerAlreadyAttachedError(err) {
  return String(err?.message || err).includes("Another debugger is already attached");
}

async function detachDebuggerTab(tabId) {
  try {
    await chrome.debugger.detach({ tabId });
    await new Promise(r => setTimeout(r, 100));
    return true;
  } catch (err) {
    console.warn(`[Link2Chrome] detach tab ${tabId} 失败: ${err.message}`);
    return false;
  }
}

async function enableCaptureDomainsForAttachedTab(tabId) {
  if (networkCaptureState.enabled) {
    await chrome.debugger.sendCommand(
      { tabId },
      "Network.enable",
      { maxPostDataSize: 200000 }
    ).catch((err) => console.warn(`[Link2Chrome] Network.enable 失败: ${err.message}`));
  }
  if (consoleCaptureState.enabled) {
    await chrome.debugger.sendCommand({ tabId }, "Runtime.enable")
      .catch((err) => console.warn(`[Link2Chrome] Runtime.enable 失败: ${err.message}`));
    await chrome.debugger.sendCommand({ tabId }, "Log.enable")
      .catch((err) => console.warn(`[Link2Chrome] Log.enable 失败: ${err.message}`));
  }
}

/**
 * 确保 debugger 附加到一个可调试的 tab。
 * 带重试机制：如果 attach 失败（如 chrome-extension:// 错误），排除该 tab 并重试。
 */
async function ensureDebuggerAttached() {
  // 如果已经 attach 到一个有效 tab，直接返回
  if (attachedTabId !== null) {
    try {
      const tab = await chrome.tabs.get(attachedTabId);
      if (isDebugableUrl(tab.url)) {
        console.log(`[Link2Chrome] 已附加到有效 tab ${attachedTabId}`);
        await enableCaptureDomainsForAttachedTab(attachedTabId);
        return attachedTabId;
      }
      // URL 变了（比如被其他扩展劫持），需要重新 attach
      console.warn(`[Link2Chrome] 已附加的 tab ${attachedTabId} URL 变为: ${tab.url}，需重新 attach`);
    } catch (err) {
      console.warn(`[Link2Chrome] 已附加的 tab ${attachedTabId} 已不存在: ${err.message}`);
    }
    try { await chrome.debugger.detach({ tabId: attachedTabId }); } catch (_) {}
    attachedTabId = null;
  }

  const failedIds = new Set();
  const MAX_RETRIES = 5;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let tabId;
    try {
      tabId = await findUsableTabId(failedIds);
    } catch (err) {
      console.error(`[Link2Chrome] 第 ${attempt + 1} 次尝试未找到可用标签页: ${err.message}`);
      // 如果没有找到可调试的标签页，等待一下再重试
      if (attempt < MAX_RETRIES - 1) {
        await new Promise(r => setTimeout(r, 500));
        continue;
      }
      throw err;
    }

    // 在 attach 之前再次确认 URL
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
      console.log(`[Link2Chrome] 尝试 attach 到 tab ${tabId}, url=${tab.url}`);
    } catch (err) {
      console.warn(`[Link2Chrome] 获取 tab ${tabId} 信息失败: ${err.message}`);
      failedIds.add(tabId);
      if (tabId === targetTabId) targetTabId = null;
      continue;
    }

    if (!isDebugableUrl(tab.url)) {
      console.warn(`[Link2Chrome] attach 前 tab ${tabId} URL 不可调试: ${tab.url}`);
      failedIds.add(tabId);
      if (tabId === targetTabId) targetTabId = null;
      continue;
    }

    // 先 detach 旧的
    if (attachedTabId !== null && attachedTabId !== tabId) {
      try { await chrome.debugger.detach({ tabId: attachedTabId }); } catch (_) {}
      attachedTabId = null;
    }

    try {
      await chrome.debugger.attach({ tabId }, "1.3");
      attachedTabId = tabId;
      targetTabId = tabId;
      chrome.debugger.sendCommand({ tabId }, "Page.enable").catch(() => {});
      await enableCaptureDomainsForAttachedTab(tabId);
      try {
        await chrome.debugger.sendCommand({ tabId }, "Browser.setDownloadBehavior", {
          behavior: "allowAndName",
          eventsEnabled: true,
        });
      } catch (err) {
        console.warn(`[Link2Chrome] Browser.setDownloadBehavior failed, falling back to chrome.downloads: ${err.message}`);
        setupDownloadsFallback();
      }
      console.log(`[Link2Chrome] Debugger 已附加到 tab ${tabId} (${tab.url})`);
      return tabId;
    } catch (err) {
      console.error(`[Link2Chrome] attach tab ${tabId} (${tab.url}) 失败: ${err.message}`);
      if (tabId === targetTabId) targetTabId = null;
      attachedTabId = null;
      if (isDebuggerAlreadyAttachedError(err)) {
        if (await detachDebuggerTab(tabId)) {
          failedIds.delete(tabId);
        } else {
          failedIds.add(tabId);
        }
        continue;
      }
      failedIds.add(tabId);
      // 如果不是可跳过的受限页面错误，直接抛出
      if (!err.message.includes("chrome-extension") && !err.message.includes("Cannot access")) {
        throw new Error(`Debugger attach 失败 (tab=${tabId}, url=${tab.url}): ${err.message}`);
      }
      // 否则继续重试下一个 tab
    }
  }

  throw new Error(
    `调试器附加失败: 尝试了 ${failedIds.size} 个标签页均不可调试。` +
    `失败 IDs: [${[...failedIds].join(", ")}]`
  );
}

async function sendCDP(method, params = {}) {
  const timeout = params.timeout || CDP_COMMAND_TIMEOUT;
  const tabId = await withTimeout(ensureDebuggerAttached(), timeout, `Debugger attach timeout: ${method}`);
  return withTimeout(
    chrome.debugger.sendCommand({ tabId }, method, params),
    timeout,
    `CDP command timeout: ${method}`
  );
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function withTimeout(promise, timeoutMs, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), timeoutMs))
  ]);
}

function cssEscape(value) {
  return String(value).replace(/["\\]/g, "\\$&");
}

function setupDownloadsFallback() {
  if (downloadsFallbackRegistered) return;
  downloadsFallbackRegistered = true;
  chrome.downloads.onCreated.addListener((item) => {
    downloadState.pending.set(String(item.id), {
      guid: String(item.id),
      url: item.url,
      suggestedFilename: item.filename || "",
      startedAt: Date.now(),
    });
  });
  chrome.downloads.onChanged.addListener((delta) => {
    if (delta.state?.current === "complete") {
      const pending = downloadState.pending.get(String(delta.id));
      if (pending) {
        downloadState.completed.set(pending.guid, pending);
        downloadState.pending.delete(String(delta.id));
      }
    }
  });
}

// 监听 debugger detach 事件
chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId === attachedTabId) {
    console.log(`[Link2Chrome] Debugger 已分离: ${reason}`);
    attachedTabId = null;
  }
});

chrome.debugger.onEvent.addListener(handleDebuggerEvent);

// 监听 tab 关闭，清理 targetTabId
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === targetTabId) {
    targetTabId = null;
  }
  if (tabId === attachedTabId) {
    attachedTabId = null;
  }
});

function trimCaptureEntries(state) {
  while (state.entries.length > state.maxEntries) {
    const removed = state.entries.shift();
    if (state.byRequestId && removed?.requestId) {
      state.byRequestId.delete(removed.requestId);
    }
  }
}

function compactHeaders(headers = {}) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    out[key] = String(value).slice(0, 2000);
  }
  return out;
}

function compactNetworkEntry(entry, includeBody = false) {
  const out = {
    id: entry.id,
    requestId: entry.requestId,
    url: entry.url,
    method: entry.method,
    resourceType: entry.resourceType,
    status: entry.status,
    statusText: entry.statusText,
    mimeType: entry.mimeType,
    fromDiskCache: entry.fromDiskCache,
    encodedDataLength: entry.encodedDataLength,
    errorText: entry.errorText,
    startedAt: entry.startedAt,
    finishedAt: entry.finishedAt,
    hasRequestBody: !!entry.requestBody,
    hasResponseBody: !!entry.responseBody
  };
  if (includeBody) {
    out.requestBody = entry.requestBody || null;
    out.responseBody = entry.responseBody || null;
    out.responseBodyBase64Encoded = !!entry.responseBodyBase64Encoded;
  }
  return out;
}

function handleDebuggerEvent(source, method, params) {
  if (source.tabId !== attachedTabId && source.tabId !== targetTabId) return;

  if (networkCaptureState.enabled) {
    handleNetworkEvent(method, params);
  }

  if (consoleCaptureState.enabled) {
    handleConsoleEvent(method, params);
  }

  if (method === "Page.javascriptDialogOpening") {
    currentDialog = {
      tabId: source.tabId,
      type: params.type,
      message: params.message,
      defaultPrompt: params.defaultPrompt || "",
      url: params.url || "",
      openedAt: Date.now()
    };
  } else if (method === "Page.javascriptDialogClosed") {
    currentDialog = null;
  }

  if (method === "Page.downloadWillBegin") {
    downloadState.pending.set(params.guid, {
      guid: params.guid,
      url: params.url,
      suggestedFilename: params.suggestedFilename || "",
      startedAt: Date.now(),
    });
  } else if (method === "Page.downloadProgress") {
    if (params.state === "completed") {
      const pending = downloadState.pending.get(params.guid);
      if (pending) {
        downloadState.completed.set(params.guid, pending);
        downloadState.pending.delete(params.guid);
      }
    }
  }
}

function handleNetworkEvent(method, params) {
  if (method === "Network.requestWillBeSent") {
    const request = params.request || {};
    const entry = {
      id: `net-${++networkSequence}`,
      requestId: params.requestId,
      loaderId: params.loaderId,
      frameId: params.frameId,
      url: request.url,
      method: request.method,
      requestHeaders: compactHeaders(request.headers),
      requestBody: request.postData || null,
      resourceType: params.type,
      initiator: params.initiator?.type || null,
      startedAt: Date.now(),
      timestamp: params.timestamp
    };
    networkCaptureState.byRequestId.set(params.requestId, entry);
    networkCaptureState.entries.push(entry);
    trimCaptureEntries(networkCaptureState);
  } else if (method === "Network.responseReceived") {
    const entry = networkCaptureState.byRequestId.get(params.requestId);
    if (!entry) return;
    const response = params.response || {};
    entry.status = response.status;
    entry.statusText = response.statusText;
    entry.responseHeaders = compactHeaders(response.headers);
    entry.mimeType = response.mimeType;
    entry.protocol = response.protocol;
    entry.remoteIPAddress = response.remoteIPAddress;
    entry.fromDiskCache = !!response.fromDiskCache;
    entry.resourceType = params.type || entry.resourceType;
  } else if (method === "Network.loadingFinished") {
    const entry = networkCaptureState.byRequestId.get(params.requestId);
    if (!entry) return;
    entry.finishedAt = Date.now();
    entry.encodedDataLength = params.encodedDataLength;
    if (networkCaptureState.includeResponseBody) {
      sendCDP("Network.getResponseBody", { requestId: params.requestId })
        .then((body) => {
          entry.responseBody = String(body.body || "").slice(0, 200000);
          entry.responseBodyBase64Encoded = !!body.base64Encoded;
        })
        .catch((err) => {
          entry.responseBodyError = err.message;
        });
    }
  } else if (method === "Network.loadingFailed") {
    const entry = networkCaptureState.byRequestId.get(params.requestId);
    if (!entry) return;
    entry.finishedAt = Date.now();
    entry.errorText = params.errorText;
    entry.canceled = !!params.canceled;
  }
}

function remoteObjectPreview(arg) {
  if (!arg) return null;
  if ("value" in arg) return arg.value;
  if (arg.unserializableValue) return arg.unserializableValue;
  if (arg.description) return arg.description;
  return arg.type || null;
}

function handleConsoleEvent(method, params) {
  let entry = null;
  if (method === "Runtime.consoleAPICalled") {
    entry = {
      id: `console-${++consoleSequence}`,
      source: "runtime",
      type: params.type,
      text: (params.args || []).map(remoteObjectPreview).map(v => String(v)).join(" "),
      args: (params.args || []).map(remoteObjectPreview),
      stackTrace: params.stackTrace || null,
      timestamp: params.timestamp || Date.now()
    };
  } else if (method === "Log.entryAdded") {
    const logEntry = params.entry || {};
    entry = {
      id: `console-${++consoleSequence}`,
      source: logEntry.source || "log",
      type: logEntry.level || "log",
      text: logEntry.text || "",
      url: logEntry.url || "",
      lineNumber: logEntry.lineNumber,
      stackTrace: logEntry.stackTrace || null,
      timestamp: logEntry.timestamp || Date.now()
    };
  }
  if (!entry) return;
  consoleCaptureState.entries.push(entry);
  trimCaptureEntries(consoleCaptureState);
}

// ==================== 指令处理 ====================

async function handleCommand(message) {
  const { request_id, command, params = {} } = message;
  const response = { request_id };

  try {
    switch (command) {
      case "screenshot":
        response.data = await cmdScreenshot(params);
        break;
      case "click":
        response.data = await cmdClick(params);
        break;
      case "type":
        response.data = await cmdType(params);
        break;
      case "scroll":
        response.data = await cmdScroll(params);
        break;
      case "navigate":
        response.data = await cmdNavigate(params);
        break;
      case "get_dom":
        response.data = await cmdGetDom(params);
        break;
      case "get_info":
        response.data = await cmdGetInfo();
        break;
      case "tab_manage":
        response.data = await cmdTabManage(params);
        break;
      case "go_back":
        response.data = await cmdGoBack();
        break;
      case "go_forward":
        response.data = await cmdGoForward();
        break;
      case "drag":
        response.data = await cmdDrag(params);
        break;
      case "get_all_tabs":
        response.data = await cmdGetAllTabs();
        break;
      case "extract_content":
        response.data = await cmdExtractContent(params);
        break;
      case "execute_script":
        response.data = await cmdExecuteScript(params);
        break;
      case "send_keys":
        response.data = await cmdSendKeys(params);
        break;
      case "find_text":
        response.data = await cmdFindText(params);
        break;
      case "scrape_with_scroll":
        response.data = await cmdScrapeWithScroll(params);
        break;
      case "agent_browser_tab_info":
        response.data = await cmdAgentBrowserTabInfo(params);
        break;
      case "agent_browser_tab_switch":
        response.data = await cmdAgentBrowserTabSwitch(params);
        break;
      case "agent_browser_tab_new":
        response.data = await cmdAgentBrowserTabNew(params);
        break;
      case "dom_overview":
        response.data = await cmdDomOverview(params);
        break;
      case "dom_query":
        response.data = await cmdDomQuery(params);
        break;
      case "dom_search":
        response.data = await cmdDomSearch(params);
        break;
      case "dom_element_detail":
        response.data = await cmdDomElementDetail(params);
        break;
      case "dom_wait_for":
        response.data = await cmdDomWaitFor(params);
        break;
      case "action_click":
        response.data = await cmdActionClick(params);
        break;
      case "action_drag":
        response.data = await cmdActionDrag(params);
        break;
      case "action_scroll":
        response.data = await cmdActionScroll(params);
        break;
      case "action_hover":
        response.data = await cmdActionHover(params);
        break;
      case "upload_file":
        response.data = await cmdUploadFile(params);
        break;
      case "handle_dialog":
        response.data = await cmdHandleDialog(params);
        break;
      case "wait_for_download":
        response.data = await cmdWaitForDownload(params);
        break;
      case "action_press_key":
        response.data = await cmdActionPressKey(params);
        break;
      case "network_capture":
        response.data = await cmdNetworkCapture(params);
        break;
      case "network_list":
        response.data = await cmdNetworkList(params);
        break;
      case "network_query":
        response.data = await cmdNetworkQuery(params);
        break;
      case "network_fetch":
        response.data = await cmdNetworkFetch(params);
        break;
      case "network_replay":
        response.data = await cmdNetworkReplay(params);
        break;
      case "console_capture":
        response.data = await cmdConsoleCapture(params);
        break;
      case "console_list":
        response.data = await cmdConsoleList(params);
        break;
      case "console_get":
        response.data = await cmdConsoleGet(params);
        break;
      case "console_clear":
        response.data = await cmdConsoleClear(params);
        break;
      case "script_evaluate":
        response.data = await cmdScriptEvaluate(params);
        break;
      case "frame_evaluate":
        response.data = await cmdFrameEvaluate(params);
        break;
      case "ping_version":
        response.data = {
          version: BUILD_VERSION,
          targetTabId,
          attachedTabId,
          wsConnected
        };
        break;
      case "dom_get_text":
        response.data = await cmdDomGetText(params);
        break;
      case "tab_group_create":
        response.data = await cmdTabGroupCreate(params);
        break;
      case "tab_group_add":
        response.data = await cmdTabGroupAdd(params);
        break;
      case "tab_group_close":
        response.data = await cmdTabGroupClose(params);
        break;
      case "playwright_batch":
        response.data = await cmdPlaywrightBatch(params);
        break;
      case "save_as_pdf":
        response.data = await cmdSaveAsPdf(params);
        break;
      case "browser.clipboard.read":
        response.data = await cmdClipboardRead(params);
        break;
      case "browser.clipboard.write":
        response.data = await cmdClipboardWrite(params);
        break;
      case "page_assets_list":
        response.data = await cmdPageAssetsList(params);
        break;
      case "page_assets_bundle":
        response.data = await cmdPageAssetsBundle(params);
        break;
      default:
        throw new Error(`未知指令: ${command}`);
    }
    response.success = true;
  } catch (err) {
    response.success = false;
    response.error = err.message;
  }

  return response;
}

// -- screenshot --
async function cmdScreenshot(params) {
  const format = params.format || "jpeg";
  const quality = params.quality || 70;
  const captureParams = {
    format,
    fromSurface: true
  };
  if (format === "jpeg" || format === "webp") {
    captureParams.quality = quality;
  }
  const result = await sendCDP("Page.captureScreenshot", captureParams);
  return { image: result.data, format };
}

// -- click --
async function cmdClick(params) {
  let { x, y, selector, button = "left", clickCount = 1 } = params;
  const btnMap = { left: "left", right: "right", middle: "middle" };
  const cdpButton = btnMap[button] || "left";

  // 如果给了 selector，先定位元素中心
  if (selector && (x === undefined || y === undefined)) {
    const locScript = `
      (function() {
        var el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return JSON.stringify({error: true});
        var rect = el.getBoundingClientRect();
        return JSON.stringify({
          x: Math.round(rect.x + rect.width / 2),
          y: Math.round(rect.y + rect.height / 2)
        });
      })()
    `;
    const locResult = await sendCDP("Runtime.evaluate", {
      expression: locScript, returnByValue: true
    });
    const loc = JSON.parse(locResult.result.value);
    if (loc.error) throw new Error("选择器未找到元素: " + selector);
    x = loc.x;
    y = loc.y;
  }

  await sendCDP("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x, y,
    button: cdpButton,
    clickCount
  });
  await sendCDP("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x, y,
    button: cdpButton,
    clickCount
  });
  return { clicked: true, x, y, selector: selector || null };
}

// -- type --
async function cmdType(params) {
  const { text, clearFirst = false, pressEnter = false, selector, x, y } = params;

  // 如果提供了选择器，先点击选择器定位
  if (selector) {
    await cmdClick({ selector });
    await new Promise(r => setTimeout(r, 150));
  }
  // 如果提供了坐标，先点击坐标定位
  else if (x !== undefined && y !== undefined) {
    await cmdClick({ x, y });
    await new Promise(r => setTimeout(r, 150));
  }

  if (clearFirst) {
    // Mac: modifiers 4 = Meta(Cmd)
    await sendCDP("Input.dispatchKeyEvent", {
      type: "keyDown", key: "a", code: "KeyA",
      windowsVirtualKeyCode: 65,
      modifiers: 4
    });
    await sendCDP("Input.dispatchKeyEvent", {
      type: "keyUp", key: "a", code: "KeyA",
      windowsVirtualKeyCode: 65,
      modifiers: 4
    });
    await sendCDP("Input.dispatchKeyEvent", {
      type: "keyDown", key: "Backspace", code: "Backspace",
      windowsVirtualKeyCode: 8
    });
    await sendCDP("Input.dispatchKeyEvent", {
      type: "keyUp", key: "Backspace", code: "Backspace",
      windowsVirtualKeyCode: 8
    });
  }

  if (text) {
    await sendCDP("Input.insertText", { text });
  }

  if (pressEnter) {
    await sendCDP("Input.dispatchKeyEvent", {
      type: "keyDown", key: "Enter", code: "Enter",
      windowsVirtualKeyCode: 13
    });
    await sendCDP("Input.dispatchKeyEvent", {
      type: "keyUp", key: "Enter", code: "Enter",
      windowsVirtualKeyCode: 13
    });
  }

  return { typed: true, text, pressEnter };
}

// -- scroll --
async function cmdScroll(params) {
  const { x = 0, y = 0, deltaX = 0, deltaY = 0 } = params;
  await sendCDP("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x, y,
    deltaX,
    deltaY
  });
  return { scrolled: true, deltaX, deltaY };
}

// -- navigate --
async function waitForNavigationReady(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastUrl = null;
  let lastReadyState = "loading";

  while (Date.now() < deadline) {
    try {
      const tab = await chrome.tabs.get(tabId);
      lastUrl = tab.url || lastUrl;
      if (tab.status === "complete") {
        return { status: "complete", url: lastUrl, readyState: "complete" };
      }
    } catch (_) {}

    try {
      const result = await sendCDP("Runtime.evaluate", {
        expression: "document.readyState",
        returnByValue: true
      });
      lastReadyState = result.result?.value || lastReadyState;
      if (lastReadyState === "interactive" || lastReadyState === "complete") {
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        return {
          status: lastReadyState === "complete" ? "complete" : "dom-ready",
          url: tab?.url || lastUrl,
          readyState: lastReadyState
        };
      }
    } catch (_) {
      // Navigation swaps execution contexts; CDP evaluation may briefly fail.
    }

    await sleep(100);
  }

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  return {
    status: "timeout",
    url: tab?.url || lastUrl,
    readyState: lastReadyState
  };
}

async function waitForTabsNavigation(tabId, url, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(poll);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(payload);
    };

    const timeout = setTimeout(() => {
      targetTabId = tabId;
      finish({ navigated: true, url, status: "timeout", tabId, method: "tabs" });
    }, timeoutMs);

    const listener = (updatedTabId, changeInfo, updatedTab) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        targetTabId = tabId;
        attachedTabId = null;
        console.log(`[Link2Chrome] tabs 导航完成: ${updatedTab.url}`);
        finish({ navigated: true, url: updatedTab.url, status: "complete", tabId, method: "tabs" });
      }
    };

    const poll = setInterval(async () => {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === "complete") {
          targetTabId = tabId;
          attachedTabId = null;
          finish({ navigated: true, url: tab.url || url, status: "complete", tabId, method: "tabs" });
        }
      } catch (_) {}
    }, 100);

    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function navigateWithTabs(url, timeoutMs) {
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  let tabId = activeTab?.id || null;

  if (!tabId && targetTabId) {
    try {
      const tab = await chrome.tabs.get(targetTabId);
      tabId = tab.id;
      console.log(`[Link2Chrome] tabs 导航: 使用 targetTabId ${tabId}`);
    } catch (err) {
      console.log(`[Link2Chrome] targetTabId ${targetTabId} 无效，将创建新标签页`);
    }
  }

  if (!tabId) {
    const newTab = await chrome.tabs.create({ url });
    tabId = newTab.id;
    targetTabId = tabId;
    attachedTabId = null;
    console.log(`[Link2Chrome] tabs 导航: 创建新标签页 ${tabId}`);
    return waitForTabsNavigation(tabId, url, timeoutMs);
  }

  await detachDebuggerTab(tabId);
  attachedTabId = null;
  await chrome.tabs.update(tabId, { url });
  targetTabId = tabId;
  console.log(`[Link2Chrome] tabs 导航: 已更新标签页 ${tabId} 的 URL 为 ${url}`);
  return waitForTabsNavigation(tabId, url, timeoutMs);
}

async function cmdNavigate(params) {
  const { url, timeout = 10000, waitUntil = "dom-ready", method = "tabs" } = params;
  const usesStandardWebProtocol = url.startsWith("http://") || url.startsWith("https://");

  if (method !== "cdp" || !usesStandardWebProtocol) {
    console.log(`[Link2Chrome] tabs 导航: ${url}`);
    return navigateWithTabs(url, timeout);
  }

  try {
    const tabId = await ensureDebuggerAttached();
    await sendCDP("Page.enable").catch(() => {});
    const navResult = await sendCDP("Page.navigate", { url });
    targetTabId = tabId;
    console.log(`[Link2Chrome] CDP Page.navigate 已发送: tab=${tabId}, url=${url}`);

    if (waitUntil === "commit") {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      return {
        navigated: true,
        url: tab?.url || url,
        status: "committed",
        readyState: "loading",
        tabId,
        method: "cdp",
        frameId: navResult.frameId,
        loaderId: navResult.loaderId,
        errorText: navResult.errorText
      };
    }

    const ready = await waitForNavigationReady(tabId, timeout);
    const finalUrl = ready.url || url;
    return {
      navigated: true,
      url: finalUrl,
      status: ready.status,
      readyState: ready.readyState,
      tabId,
      method: "cdp",
      frameId: navResult.frameId,
      loaderId: navResult.loaderId,
      errorText: navResult.errorText
    };
  } catch (err) {
    console.warn(`[Link2Chrome] CDP 导航失败，回退 tabs 导航: ${err.message}`);
    return navigateWithTabs(url, timeout);
  }
}

// -- get_dom --
async function cmdGetDom(params) {
  const script = `
    (function() {
      const INTERACTIVE_TAGS = new Set([
        'A', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'DETAILS',
        'SUMMARY', 'DIALOG', 'MENU', 'MENUITEM', 'OPTION'
      ]);
      const SKIP_TAGS = new Set([
        'SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'PATH', 'META', 'LINK', 'BR', 'HR'
      ]);
      const IMPORTANT_ATTRS = ['id', 'class', 'href', 'src', 'alt', 'title',
        'placeholder', 'value', 'type', 'name', 'role', 'aria-label',
        'aria-expanded', 'aria-hidden', 'data-testid'];

      function isVisible(el) {
        if (!el.offsetParent && el.tagName !== 'BODY' && el.tagName !== 'HTML') return false;
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
      }

      function compress(node, depth) {
        if (depth > 15) return null;
        if (node.nodeType === Node.TEXT_NODE) {
          const text = node.textContent.trim();
          return text ? { t: text.substring(0, 200) } : null;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return null;
        const tag = node.tagName;
        if (SKIP_TAGS.has(tag)) return null;
        if (!isVisible(node)) return null;

        const el = { tag: tag.toLowerCase() };
        for (const attr of IMPORTANT_ATTRS) {
          const val = node.getAttribute(attr);
          if (val) el[attr] = val.substring(0, 100);
        }
        if (INTERACTIVE_TAGS.has(tag) || node.onclick || node.getAttribute('tabindex')) {
          el.interactive = true;
          const rect = node.getBoundingClientRect();
          el.rect = {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            w: Math.round(rect.width),
            h: Math.round(rect.height)
          };
        }
        const children = [];
        for (const child of node.childNodes) {
          const c = compress(child, depth + 1);
          if (c) children.push(c);
        }
        if (children.length > 0) el.children = children;
        return el;
      }
      return JSON.stringify(compress(document.body, 0));
    })()
  `;

  const result = await sendCDP("Runtime.evaluate", {
    expression: script,
    returnByValue: true
  });

  if (result.exceptionDetails) {
    throw new Error("DOM 提取失败: " + JSON.stringify(result.exceptionDetails));
  }

  return { dom: result.result.value };
}

// -- get_info --
async function cmdGetInfo() {
  // 尝试找到可调试的 tab
  let tabId;
  try {
    tabId = await findUsableTabId();
  } catch (err) {
    // 如果没有可调试的标签页，尝试获取当前活动的标签页（即使可能不可调试）
    console.warn(`[Link2Chrome] cmdGetInfo 未找到可调试标签页，尝试获取活动标签页`);
    const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (activeTab) {
      return {
        url: activeTab.url,
        title: activeTab.title,
        tabId: activeTab.id,
        viewport: null,
        warning: "标签页不可调试，可能需要刷新或等待页面加载完成"
      };
    }
    throw err;
  }

  const tab = await chrome.tabs.get(tabId);

  // 获取 viewport 信息
  const result = await sendCDP("Runtime.evaluate", {
    expression: `JSON.stringify({
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      documentWidth: document.documentElement.scrollWidth,
      documentHeight: document.documentElement.scrollHeight
    })`,
    returnByValue: true
  });

  const viewport = JSON.parse(result.result.value);
  return {
    url: tab.url,
    title: tab.title,
    tabId: tab.id,
    viewport
  };
}

// -- tab_manage --
async function cmdTabManage(params) {
  const { action, tab_index, tabId, url } = params;

  switch (action) {
    case "new": {
      const newTab = await chrome.tabs.create({ url: url || "about:blank" });
      // 跟踪新 tab
      targetTabId = newTab.id;
      attachedTabId = null;

      // 如果提供了 url，等待页面加载完成
      if (url && url !== "about:blank") {
        await new Promise((resolve) => {
          const timeout = setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }, 15000);

          const listener = (updatedTabId, changeInfo, updatedTab) => {
            if (updatedTabId === newTab.id && changeInfo.status === "complete") {
              if (isDebugableUrl(updatedTab.url)) {
                clearTimeout(timeout);
                chrome.tabs.onUpdated.removeListener(listener);
                console.log(`[Link2Chrome] 新标签页加载完成: ${updatedTab.url}`);
                resolve();
              }
            }
          };
          chrome.tabs.onUpdated.addListener(listener);
        });
      }

      return { created: true, tabId: newTab.id };
    }
    case "close": {
      if (tabId !== undefined && tabId !== null) {
        await chrome.tabs.remove(tabId);
        if (tabId === targetTabId) targetTabId = null;
        if (tabId === attachedTabId) attachedTabId = null;
        return { closed: true, tabId };
      }
      if (tab_index !== undefined) {
        const tabs = await chrome.tabs.query({ lastFocusedWindow: true });
        if (tab_index >= 0 && tab_index < tabs.length) {
          const closingId = tabs[tab_index].id;
          await chrome.tabs.remove(closingId);
          if (closingId === targetTabId) targetTabId = null;
          if (closingId === attachedTabId) attachedTabId = null;
          return { closed: true, tabIndex: tab_index };
        }
        throw new Error(`标签索引 ${tab_index} 超出范围 (共 ${tabs.length} 个标签)`);
      }
      // 关闭当前工作 tab
      const closeId = await findUsableTabId();
      await chrome.tabs.remove(closeId);
      targetTabId = null;
      attachedTabId = null;
      return { closed: true, tabId: closeId };
    }
    case "switch": {
      if (tab_index === undefined) throw new Error("切换标签需要 tab_index");
      const tabs = await chrome.tabs.query({ lastFocusedWindow: true });
      if (tab_index >= 0 && tab_index < tabs.length) {
        const switchTab = tabs[tab_index];
        await chrome.tabs.update(switchTab.id, { active: true });
        // 跟踪切换后的 tab
        targetTabId = switchTab.id;
        attachedTabId = null;
        console.log(`[Link2Chrome] 已切换到标签页 ${switchTab.id}, URL: ${switchTab.url}`);
        return { switched: true, tabIndex: tab_index, tabId: switchTab.id, url: switchTab.url };
      }
      throw new Error(`标签索引 ${tab_index} 超出范围 (共 ${tabs.length} 个标签)`);
    }
    case "list": {
      const tabs = await chrome.tabs.query({ lastFocusedWindow: true });
      return {
        tabs: tabs.map((t, i) => ({
          index: i,
          id: t.id,
          url: t.url,
          title: t.title,
          active: t.active,
          debugable: isDebugableUrl(t.url),
          isTarget: t.id === targetTabId
        }))
      };
    }
    default:
      throw new Error(`未知的标签操作: ${action}`);
  }
}

// -- go_back --
async function cmdGoBack() {
  const tabId = await findUsableTabId();
  await chrome.tabs.goBack(tabId);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      attachedTabId = null;
      resolve({ back: true, status: "timeout" });
    }, 10000);
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        attachedTabId = null;
        resolve({ back: true, status: "complete" });
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// -- go_forward --
async function cmdGoForward() {
  const tabId = await findUsableTabId();
  await chrome.tabs.goForward(tabId);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      attachedTabId = null;
      resolve({ forward: true, status: "timeout" });
    }, 10000);
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        attachedTabId = null;
        resolve({ forward: true, status: "complete" });
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// -- drag --
async function cmdDrag(params) {
  const { startX, startY, endX, endY, duration = 500 } = params;
  const steps = Math.max(Math.round(duration / 16), 5);

  await sendCDP("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: startX, y: startY,
    button: "left", clickCount: 1
  });

  for (let i = 1; i <= steps; i++) {
    const ratio = i / steps;
    const cx = startX + (endX - startX) * ratio;
    const cy = startY + (endY - startY) * ratio;
    await sendCDP("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: Math.round(cx), y: Math.round(cy),
      button: "left"
    });
  }

  await sendCDP("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: endX, y: endY,
    button: "left", clickCount: 1
  });

  return { dragged: true, startX, startY, endX, endY };
}

// -- wait --
async function cmdGetAllTabs() {
  const allTabs = await chrome.tabs.query({});
  const windows = {};
  for (const tab of allTabs) {
    if (!windows[tab.windowId]) {
      windows[tab.windowId] = [];
    }
      windows[tab.windowId].push({
        index: tab.index,
        id: tab.id,
        url: tab.url,
        title: tab.title,
        active: tab.active,
        pinned: tab.pinned,
        windowId: tab.windowId,
        status: tab.status,
        favIconUrl: tab.favIconUrl,
        debugable: isDebugableUrl(tab.url)
      });
  }
  return { windows, totalTabs: allTabs.length, currentTarget: targetTabId };
}

// -- extract_content (Readability) --
async function cmdExtractContent(params) {
  const readabilityUrl = chrome.runtime.getURL("lib/Readability.js");
  const resp = await fetch(readabilityUrl);
  const readabilitySrc = await resp.text();

  const extractScript = `
    (function() {
      ${readabilitySrc}

      var docClone = document.cloneNode(true);
      var reader = new Readability(docClone);
      var article = reader.parse();
      if (!article) {
        return JSON.stringify({ error: "Readability 无法解析此页面" });
      }
      return JSON.stringify({
        title: article.title || "",
        byline: article.byline || "",
        excerpt: article.excerpt || "",
        siteName: article.siteName || "",
        content: article.content || "",
        textContent: article.textContent || "",
        length: article.length || 0
      });
    })()
  `;

  const result = await sendCDP("Runtime.evaluate", {
    expression: extractScript,
    returnByValue: true
  });

  if (result.exceptionDetails) {
    throw new Error("内容提取失败: " + JSON.stringify(result.exceptionDetails));
  }

  return JSON.parse(result.result.value);
}

// ==================== 状态广播 ====================

function broadcastStatus() {
  chrome.runtime.sendMessage(getConnectionStatus()).catch(() => {});
}

function getConnectionStatus() {
  const nativeReady = Boolean(nativeConnected || nativeHubStarted || nativeStatus?.ok);
  return {
    type: "status",
    connected: wsConnected,
    wsConnected,
    nativeConnected,
    nativeReady,
    nativeStatus,
    transport: wsConnected ? "websocket" : (nativeReady ? "native-bootstrap" : "websocket"),
    enabled: connectionEnabled
  };
}

function disableConnection() {
  connectionEnabled = false;
  // 停止自动重连
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectAttempts = 0;
  // 关闭现有连接
  if (ws) {
    try { ws.close(1000, "user disabled"); } catch (_) {}
    ws = null;
  }
  wsConnected = false;
  nativeConnected = false;
  nativeHubStarted = false;
  nativeStatus = null;
  if (nativePort) {
    try { nativePort.disconnect(); } catch (_) {}
    nativePort = null;
  }
  stopHeartbeat();
  chrome.alarms?.clear(KEEPALIVE_ALARM).catch(() => {});
  broadcastStatus();
  chrome.storage.local.set({ connectionEnabled: false });
}

function enableConnection() {
  connectionEnabled = true;
  reconnectAttempts = 0;
  chrome.storage.local.set({ connectionEnabled: true });
  setupKeepaliveAlarm();
  connectNativeBootstrap().finally(() => connectWebSocket());
  broadcastStatus();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "getStatus") {
    sendResponse({
      ...getConnectionStatus(),
      targetTabId
    });
    return true;
  }
  if (message.type === "setEnabled") {
    if (message.enabled) {
      enableConnection();
    } else {
      disableConnection();
    }
    sendResponse({ ok: true, enabled: connectionEnabled });
    return true;
  }
  if (message.type === "reconnect") {
    if (!connectionEnabled) {
      sendResponse({ ok: false, reason: "disabled" });
      return true;
    }
    reconnectAttempts = 0;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.close(1000, "manual reconnect"); } catch (_) {}
    }
    ws = null;
    wsConnected = false;
    stopHeartbeat();
    connectNativeBootstrap().finally(() => connectWebSocket());
    sendResponse({ ok: true });
    return true;
  }
});

// ==================== 新增命令实现 ====================

// -- execute_script --
async function cmdExecuteScript(params) {
  const { script, args = [], awaitPromise = false, timeout = 60000 } = params;

  try {
    const result = await sendCDP("Runtime.evaluate", {
      expression: script,
      awaitPromise: awaitPromise,
      returnByValue: true,
      timeout: timeout
    });

    if (result.exceptionDetails) {
      return {
        success: false,
        error: result.exceptionDetails.exception?.description || "脚本执行异常"
      };
    }

    return {
      success: true,
      result: result.result.value
    };
  } catch (err) {
    return {
      success: false,
      error: err.message
    };
  }
}

// -- wait_for_condition --

// ==================== 第二阶段新增命令实现 ====================

// -- scroll_until --
async function cmdSendKeys(params) {
  const { keys, selector } = params;

  // 如果指定了 selector，先点击聚焦
  if (selector) {
    const clickResult = await cmdClick({ selector });
    if (!clickResult.clicked) {
      throw new Error(`无法点击选择器: ${selector}`);
    }
    await new Promise(r => setTimeout(r, 100));
  }

  // 解析按键组合
  const parts = keys.split('+').map(k => k.trim());
  let modifiers = 0;
  let mainKey = parts[parts.length - 1];

  // 规范化常见别名（尤其是 Return -> Enter）
  const keyAliasMap = {
    'Return': 'Enter',
    'return': 'Enter',
    'NumpadEnter': 'Enter',
    'numpadenter': 'Enter'
  };
  const normalizedMainKey = keyAliasMap[mainKey] || keyAliasMap[mainKey.toLowerCase()] || mainKey;

  // 计算 modifiers 位掩码
  // Bit 1: Alt, Bit 2: Ctrl, Bit 4: Meta, Bit 8: Shift
  for (const part of parts.slice(0, -1)) {
    const lowerPart = part.toLowerCase();
    if (lowerPart === 'alt' || lowerPart === 'option') {
      modifiers |= 1;
    } else if (lowerPart === 'control' || lowerPart === 'ctrl') {
      modifiers |= 2;
    } else if (lowerPart === 'meta' || lowerPart === 'command' || lowerPart === 'cmd') {
      modifiers |= 4;
    } else if (lowerPart === 'shift') {
      modifiers |= 8;
    }
  }

  // 获取主按键的 windowsVirtualKeyCode
  const keyCodeMap = {
    'a': 65, 'b': 66, 'c': 67, 'd': 68, 'e': 69, 'f': 70, 'g': 71, 'h': 72,
    'i': 73, 'j': 74, 'k': 75, 'l': 76, 'm': 77, 'n': 78, 'o': 79, 'p': 80,
    'q': 81, 'r': 82, 's': 83, 't': 84, 'u': 85, 'v': 86, 'w': 87, 'x': 88,
    'y': 89, 'z': 90,
    'Enter': 13, 'enter': 13, 'Backspace': 8, 'backspace': 8, 'Tab': 9, 'tab': 9,
    'Escape': 27, 'escape': 27, 'Delete': 46, 'delete': 46,
    'ArrowUp': 38, 'ArrowDown': 40, 'ArrowLeft': 37, 'ArrowRight': 39,
    'arrowup': 38, 'arrowdown': 40, 'arrowleft': 37, 'arrowright': 39,
    'Home': 36, 'End': 35, 'PageUp': 33, 'PageDown': 34,
    'home': 36, 'end': 35, 'pageup': 33, 'pagedown': 34,
    'F1': 112, 'F2': 113, 'F3': 114, 'F4': 115, 'F5': 116,
    'F6': 117, 'F7': 118, 'F8': 119, 'F9': 120, 'F10': 121, 'F11': 122, 'F12': 123,
    'f1': 112, 'f2': 113, 'f3': 114, 'f4': 115, 'f5': 116,
    'f6': 117, 'f7': 118, 'f8': 119, 'f9': 120, 'f10': 121, 'f11': 122, 'f12': 123
  };

  // CDP 的 code 必须是 DOM KeyboardEvent.code（物理键），不能对 Enter/Tab 等用 KeyXXX
  const codeMap = {
    'Enter': 'Enter', 'Tab': 'Tab', 'Backspace': 'Backspace', 'Escape': 'Escape',
    'Delete': 'Delete', 'ArrowUp': 'ArrowUp', 'ArrowDown': 'ArrowDown',
    'ArrowLeft': 'ArrowLeft', 'ArrowRight': 'ArrowRight',
    'Home': 'Home', 'End': 'End', 'PageUp': 'PageUp', 'PageDown': 'PageDown',
    'F1': 'F1', 'F2': 'F2', 'F3': 'F3', 'F4': 'F4', 'F5': 'F5',
    'F6': 'F6', 'F7': 'F7', 'F8': 'F8', 'F9': 'F9', 'F10': 'F10',
    'F11': 'F11', 'F12': 'F12',
    'enter': 'Enter', 'tab': 'Tab', 'backspace': 'Backspace', 'escape': 'Escape',
    'delete': 'Delete', 'arrowup': 'ArrowUp', 'arrowdown': 'ArrowDown',
    'arrowleft': 'ArrowLeft', 'arrowright': 'ArrowRight',
    'home': 'Home', 'end': 'End', 'pageup': 'PageUp', 'pagedown': 'PageDown',
    'f1': 'F1', 'f2': 'F2', 'f3': 'F3', 'f4': 'F4', 'f5': 'F5',
    'f6': 'F6', 'f7': 'F7', 'f8': 'F8', 'f9': 'F9', 'f10': 'F10',
    'f11': 'F11', 'f12': 'F12'
  };
  const mainKeyLower = normalizedMainKey.toLowerCase();
  const code = codeMap[normalizedMainKey] || codeMap[mainKeyLower] ||
    (normalizedMainKey.length === 1 ? `Key${normalizedMainKey.toUpperCase()}` : `Key${normalizedMainKey}`);
  const key = normalizedMainKey.length === 1
    ? normalizedMainKey
    : (codeMap[normalizedMainKey] || codeMap[mainKeyLower] || normalizedMainKey);
  const keyCode = keyCodeMap[normalizedMainKey] || keyCodeMap[mainKeyLower] || 0;

  // 发送 keyDown
  await sendCDP("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: key,
    code: code,
    windowsVirtualKeyCode: keyCode,
    modifiers: modifiers
  });

  // 发送 keyUp
  await sendCDP("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: key,
    code: code,
    windowsVirtualKeyCode: keyCode,
    modifiers: modifiers
  });

  return {
    sent: true,
    keys: keys,
    normalizedKey: normalizedMainKey,
    modifiers: modifiers,
    keyCode: keyCode
  };
}

// -- find_text --
async function cmdFindText(params) {
  const { text, click = false } = params;

  // 在页面中查找包含文本的元素
  const findScript = `
    (function() {
      const searchText = ${JSON.stringify(text)};
      const elements = [];

      // 使用 TreeWalker 遍历所有文本节点
      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
        null
      );

      const foundElements = new Set();
      let node;
      while (node = walker.nextNode()) {
        if (node.textContent.includes(searchText)) {
          let element = node.parentElement;
          // 找到最近的可交互元素
          while (element && !foundElements.has(element)) {
            const tag = element.tagName.toLowerCase();
            if (['a', 'button', 'input', 'textarea', 'select'].includes(tag) ||
                element.onclick || element.getAttribute('role')) {
              foundElements.add(element);
              const rect = element.getBoundingClientRect();
              elements.push({
                text: element.textContent.trim().substring(0, 100),
                tag: tag,
                x: Math.round(rect.x + rect.width / 2),
                y: Math.round(rect.y + rect.height / 2),
                visible: rect.width > 0 && rect.height > 0
              });
              break;
            }
            element = element.parentElement;
          }
        }
      }

      return elements;
    })()
  `;

  const result = await sendCDP("Runtime.evaluate", {
    expression: findScript,
    returnByValue: true
  });

  const elements = result.result.value || [];

  if (elements.length === 0) {
    return {
      found: false,
      text: text,
      elements: []
    };
  }

  // 如果需要点击，点击第一个可见元素
  if (click && elements.length > 0) {
    const firstVisible = elements.find(el => el.visible);
    if (firstVisible) {
      await sendCDP("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: firstVisible.x,
        y: firstVisible.y,
        button: "left",
        clickCount: 1
      });
      await sendCDP("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: firstVisible.x,
        y: firstVisible.y,
        button: "left",
        clickCount: 1
      });

      return {
        found: true,
        clicked: true,
        text: text,
        element: firstVisible,
        total_found: elements.length
      };
    }
  }

  return {
    found: true,
    clicked: false,
    text: text,
    elements: elements,
    total_found: elements.length
  };
}

// -- scrape_with_scroll --
async function cmdScrapeWithScroll(params) {
  const {
    extract_script,
    max_items = 100,
    batch_size = 10,
    scroll_delay = 500,
    dedupe_by = null
  } = params;

  const allItems = dedupe_by ? new Map() : [];
  let scrollCount = 0;
  let noChangeCount = 0;
  let lastHeight = await sendCDP("Runtime.evaluate", {
    expression: "document.body.scrollHeight",
    returnByValue: true
  }).then(r => r.result.value);

  const getItemCount = () => dedupe_by ? allItems.size : allItems.length;

  while (getItemCount() < max_items && noChangeCount < 3 && scrollCount < 200) {
    // 1. 滚动
    await sendCDP("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: 100, y: 100,
      deltaX: 0, deltaY: 500
    });

    await new Promise(r => setTimeout(r, scroll_delay));

    // 2. 提取当前批次
    const batchResult = await sendCDP("Runtime.evaluate", {
      expression: `(${extract_script})`,
      returnByValue: true
    });

    if (batchResult.exceptionDetails) {
      throw new Error(`脚本执行失败: ${JSON.stringify(batchResult.exceptionDetails)}`);
    }

    const batchItems = batchResult.result.value || [];

    // 3. 去重并添加
    if (dedupe_by) {
      for (const item of batchItems) {
        const key = item[dedupe_by];
        if (key && !allItems.has(key)) {
          allItems.set(key, item);
        }
      }
    } else {
      for (const item of batchItems) {
        allItems.push(item);
      }
    }

    scrollCount++;

    // 4. 每 batch_size 次滚动，记录进度
    if (scrollCount % batch_size === 0) {
      console.log(`[ScrapeWithScroll] ${getItemCount()} items, ${scrollCount} scrolls`);
    }

    // 5. 检测是否到底
    const newHeight = await sendCDP("Runtime.evaluate", {
      expression: "document.body.scrollHeight",
      returnByValue: true
    }).then(r => r.result.value);

    if (newHeight === lastHeight) {
      noChangeCount++;
    } else {
      noChangeCount = 0;
      lastHeight = newHeight;
    }

    // 达到目标数量，提前退出
    if (getItemCount() >= max_items) {
      break;
    }
  }

  return {
    items: dedupe_by ? Array.from(allItems.values()) : allItems,
    total: getItemCount(),
    scrolls: scrollCount,
    reached_end: noChangeCount >= 3
  };
}

// ==================== Agent-first commands ====================

async function cmdAgentBrowserTabInfo(params) {
  const tabId = params.tabId || await findUsableTabId();
  const tab = await chrome.tabs.get(tabId);
  let pageState = {};
  let pageStateError = null;
  if (isDebugableUrl(tab.url)) {
    const oldTarget = targetTabId;
    targetTabId = tabId;
    try {
      const result = await sendCDP("Runtime.evaluate", {
        expression: `JSON.stringify({
          readyState: document.readyState,
          scrollY: window.scrollY,
          scrollHeight: document.documentElement.scrollHeight,
          viewportHeight: window.innerHeight,
          canGoBack: history.length > 1
        })`,
        returnByValue: true
      });
      pageState = JSON.parse(result.result.value || "{}");
    } catch (err) {
      pageStateError = err.message || String(err);
      console.warn(`[Link2Chrome] tab info pageState 获取失败: ${pageStateError}`);
    } finally {
      targetTabId = oldTarget || targetTabId;
    }
  }
  return {
    id: tab.id,
    windowId: tab.windowId,
    active: tab.active,
    url: tab.url,
    title: tab.title,
    status: tab.status,
    canGoForward: false,
    ...(pageStateError ? { pageStateError } : {}),
    ...pageState
  };
}

async function cmdAgentBrowserTabSwitch(params) {
  const tabId = params.tabId;
  if (!tabId) throw new Error("tabId is required");
  const tab = await chrome.tabs.get(tabId);
  await chrome.windows.update(tab.windowId, { focused: true });
  await chrome.tabs.update(tabId, { active: true });
  targetTabId = tabId;
  attachedTabId = null;
  return { ok: true, tabId, url: tab.url };
}

async function cmdAgentBrowserTabNew(params) {
  const tab = await chrome.tabs.create({ url: params.url || "about:blank", active: params.active !== false });
  targetTabId = tab.id;
  attachedTabId = null;
  return { ok: true, tabId: tab.id, url: tab.url || params.url || "about:blank" };
}






async function evaluatePageFunction(fn, params = {}) {
  const expression = `(${fn.toString()})(${JSON.stringify(params)})`;
  const result = await sendCDP("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || "page evaluation failed");
  }
  return result.result.value;
}

async function cmdDomOverview(params) {
  return evaluatePageFunction((params) => {
    const include = new Set(params.include || ["headings", "buttons", "inputs", "forms", "tables", "links", "images"]);
    const clean = (s) => (s || "").replace(/\s+/g, " ").trim().slice(0, 160);
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.display !== "none" && st.visibility !== "hidden" && st.opacity !== "0";
    };
    const overview = { url: location.href, title: document.title };
    if (include.has("headings")) {
      overview.headings = Array.from(document.querySelectorAll("h1,h2,h3")).slice(0, 30).map(el => ({ tag: el.tagName, text: clean(el.innerText || el.textContent) }));
    }
    if (include.has("buttons")) {
      overview.buttons = Array.from(document.querySelectorAll("button,[role='button'],input[type='button'],input[type='submit']")).slice(0, 40).map(el => ({ text: clean(el.innerText || el.value || el.getAttribute("aria-label")), visible: visible(el) }));
    }
    if (include.has("inputs")) {
      overview.inputs = Array.from(document.querySelectorAll("input,textarea,select")).slice(0, 40).map(el => ({ tag: el.tagName.toLowerCase(), type: el.type || "", name: el.name || "", placeholder: el.placeholder || "", visible: visible(el) }));
    }
    if (include.has("forms")) overview.forms = document.forms.length;
    if (include.has("tables")) overview.tables = document.querySelectorAll("table").length;
    if (include.has("links")) overview.links = document.links.length;
    if (include.has("images")) overview.images = document.images.length;
    overview.summary = `Page has ${document.querySelectorAll("h1,h2,h3").length} headings, ${document.links.length} links, ${document.querySelectorAll("button,[role='button'],input[type='button'],input[type='submit']").length} buttons, ${document.forms.length} forms.`;
    return overview;
  }, params);
}

async function cmdDomQuery(params) {
  return evaluatePageFunction((params) => {
    const attrs = params.attributes || ["text"];
    const limit = Math.min(params.limit || 50, 200);
    const clean = (s, n = 500) => (s || "").replace(/\s+/g, " ").trim().slice(0, n);
    const uniqueSelector = (el) => {
      if (el.id) return `#${CSS.escape(el.id)}`;
      const parts = [];
      while (el && el.nodeType === 1 && el !== document.body && parts.length < 5) {
        let part = el.localName;
        if (el.classList.length) part += "." + Array.from(el.classList).slice(0, 2).map(c => CSS.escape(c)).join(".");
        const parent = el.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter(e => e.localName === el.localName);
          if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(el) + 1})`;
        }
        parts.unshift(part);
        el = parent;
      }
      return parts.join(" > ");
    };
    const nodes = Array.from(document.querySelectorAll(params.selector));
    const results = nodes.slice(0, limit).map(el => {
      const row = { selector: uniqueSelector(el) };
      for (const attr of attrs) {
        if (attr === "text") row.text = clean(el.innerText || el.textContent, 500);
        else if (attr === "html") row.html = (el.innerHTML || "").slice(0, 1000);
        else if (attr === "href") row.href = el.href || el.getAttribute("href") || "";
        else if (attr === "src") row.src = el.src || el.getAttribute("src") || "";
        else if (attr === "value") row.value = el.value || el.getAttribute("value") || "";
        else if (attr === "ariaLabel") row.ariaLabel = el.getAttribute("aria-label") || "";
        else if (attr === "className") row.className = el.className || "";
        else row[attr] = el.getAttribute(attr) || "";
      }
      if (params.includeHtml && row.html === undefined) row.html = (el.innerHTML || "").slice(0, 1000);
      return row;
    });
    return { results, count: nodes.length, truncated: nodes.length > limit, selector: params.selector };
  }, params);
}

async function cmdDomSearch(params) {
  return evaluatePageFunction((params) => {
    const query = params.caseSensitive ? params.query : params.query.toLowerCase();
    const limit = Math.min(params.limit || 20, 100);
    const contextLines = params.contextLines ?? 2;
    const clean = (s) => (s || "").replace(/\s+/g, " ").trim().slice(0, 220);
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const matches = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const seen = new Set();
    let node;
    while ((node = walker.nextNode()) && matches.length < limit) {
      const text = clean(node.textContent);
      const haystack = params.caseSensitive ? text : text.toLowerCase();
      if (!text || !haystack.includes(query)) continue;
      let el = node.parentElement;
      while (el && el !== document.body && !visible(el)) el = el.parentElement;
      if (!el || seen.has(el)) continue;
      seen.add(el);
      const siblings = Array.from(el.parentElement?.children || []);
      const idx = siblings.indexOf(el);
      matches.push({
        text: clean(el.innerText || el.textContent),
        tag: el.tagName.toLowerCase(),
        selector: el.id ? `#${CSS.escape(el.id)}` : el.tagName.toLowerCase(),
        context: {
          before: siblings.slice(Math.max(0, idx - contextLines), idx).map(s => clean(s.innerText || s.textContent)).filter(Boolean),
          after: siblings.slice(idx + 1, idx + 1 + contextLines).map(s => clean(s.innerText || s.textContent)).filter(Boolean)
        }
      });
    }
    return { matches, count: matches.length, query: params.query };
  }, params);
}


async function cmdDomElementDetail(params) {
  return evaluatePageFunction((params) => {
    const include = new Set(params.include || ["attributes", "accessibility"]);
    const el = document.querySelector(params.selector);
    if (!el) return { ok: false, error: "selector not found", selector: params.selector };
    const clean = (s) => (s || "").replace(/\s+/g, " ").trim().slice(0, 500);
    const out = { ok: true, selector: params.selector, tag: el.tagName.toLowerCase(), text: clean(el.innerText || el.textContent) };
    if (include.has("attributes")) {
      out.attributes = {};
      for (const attr of el.attributes) out.attributes[attr.name] = attr.value;
    }
    if (include.has("position")) {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      out.position = {
        x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height),
        visible: r.width > 0 && r.height > 0 && st.display !== "none" && st.visibility !== "hidden",
        inViewport: r.bottom >= 0 && r.right >= 0 && r.top <= innerHeight && r.left <= innerWidth
      };
    }
    if (include.has("styles")) {
      const st = getComputedStyle(el);
      out.styles = { display: st.display, visibility: st.visibility, color: st.color, backgroundColor: st.backgroundColor, fontSize: st.fontSize };
    }
    if (include.has("accessibility")) {
      out.accessibility = {
        role: el.getAttribute("role") || el.tagName.toLowerCase(),
        name: el.getAttribute("aria-label") || clean(el.innerText || el.value || el.alt || el.title),
        description: el.getAttribute("aria-description") || el.getAttribute("title") || "",
        focusable: typeof el.focus === "function" && !el.disabled,
        focused: document.activeElement === el
      };
    }
    return out;
  }, params);
}

async function cmdDomWaitFor(params) {
  const started = Date.now();
  const state = params.state || "visible";
  const result = await evaluatePageFunction((params) => new Promise((resolve) => {
    const deadline = Date.now() + (params.timeout || 10000);
    const isOk = () => {
      const el = document.querySelector(params.selector);
      if (params.state === "hidden") return !el || getComputedStyle(el).display === "none" || getComputedStyle(el).visibility === "hidden";
      if (!el) return false;
      if (params.state === "present") return true;
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      const visible = r.width > 0 && r.height > 0 && st.display !== "none" && st.visibility !== "hidden" && st.opacity !== "0";
      if (params.state === "enabled") return visible && !el.disabled && el.getAttribute("aria-disabled") !== "true";
      return visible;
    };
    const tick = () => {
      if (isOk()) resolve({ ok: true });
      else if (Date.now() > deadline) resolve({ ok: false, error: "timeout" });
      else setTimeout(tick, 150);
    };
    tick();
  }), { ...params, state });
  return { ...result, selector: params.selector, state, elapsed: Date.now() - started };
}

async function cmdActionClick(params) {
  const target = params.target || {};
  if (typeof target.x === "number" && typeof target.y === "number") {
    const started = Date.now();
    const result = await cmdClick({
      x: target.x,
      y: target.y,
      button: params.button || "left",
      clickCount: params.clickCount || 1
    });
    if (params.waitForSelector) await cmdDomWaitFor({ selector: params.waitForSelector, state: "visible", timeout: params.timeout || 10000 });
    return { ok: true, target, method: "cdp", effects: { domChanged: true }, elapsed: Date.now() - started, ...result };
  }
  let selector = target.selector;
  if (!selector && target.text) {
    const found = await cmdFindText({ text: target.text, click: false });
    const el = found.elements?.find(e => e.visible);
    if (!el) throw new Error(`No visible element found by text: ${target.text}`);
    const started = Date.now();
    await cmdClick({ x: el.x, y: el.y, button: params.button || "left", clickCount: params.clickCount || 1 });
    return { ok: true, target, method: "cdp", effects: { domChanged: true }, elapsed: Date.now() - started };
  }
  if (!selector && target.ariaLabel) selector = `[aria-label*="${cssEscape(target.ariaLabel)}"]`;
  const started = Date.now();
  const result = await cmdClick({ selector, button: params.button || "left", clickCount: params.clickCount || 1 });
  if (params.waitForSelector) await cmdDomWaitFor({ selector: params.waitForSelector, state: "visible", timeout: params.timeout || 10000 });
  return { ok: true, target: { ...target, selector }, method: "cdp", effects: { domChanged: true }, elapsed: Date.now() - started, ...result };
}

async function resolveActionPoint(target) {
  if (typeof target?.x === "number" && typeof target?.y === "number") {
    return { x: target.x, y: target.y, source: "coordinate" };
  }

  if (target?.text) {
    const found = await cmdFindText({ text: target.text, click: false });
    const el = found.elements?.find(e => e.visible);
    if (!el) throw new Error(`No visible element found by text: ${target.text}`);
    return { x: el.x, y: el.y, source: "text" };
  }

  let selector = target?.selector;
  if (!selector && target?.ariaLabel) selector = `[aria-label*="${cssEscape(target.ariaLabel)}"]`;
  if (!selector) throw new Error("target must include selector, text, ariaLabel, or x/y coordinates");

  const detail = await cmdDomElementDetail({ selector, include: ["position"] });
  if (!detail.ok) throw new Error(detail.error || `No element found for selector: ${selector}`);
  return {
    x: Math.round(detail.position.x + detail.position.width / 2),
    y: Math.round(detail.position.y + detail.position.height / 2),
    selector,
    source: "selector"
  };
}

async function cmdActionDrag(params) {
  const started = Date.now();
  const start = await resolveActionPoint(params.target || {});
  let end;

  if (params.to) {
    end = await resolveActionPoint(params.to);
  } else if (params.by && (typeof params.by.x === "number" || typeof params.by.y === "number")) {
    end = {
      x: start.x + (params.by.x || 0),
      y: start.y + (params.by.y || 0),
      source: "offset"
    };
  } else {
    throw new Error("action_drag requires either to or by");
  }

  const result = await cmdDrag({
    startX: start.x,
    startY: start.y,
    endX: end.x,
    endY: end.y,
    duration: params.duration || 500
  });

  return {
    ok: true,
    target: params.target,
    to: params.to || null,
    by: params.by || null,
    start,
    end,
    effects: { dragDispatched: true },
    elapsed: Date.now() - started,
    ...result
  };
}


async function cmdActionScroll(params) {
  const started = Date.now();
  if (params.toSelector) {
    await evaluatePageFunction((params) => {
      document.querySelector(params.toSelector)?.scrollIntoView({ block: "center", behavior: "instant" });
      return true;
    }, params);
  } else if (params.to === "top" || params.to === "bottom") {
    await evaluatePageFunction((params) => {
      window.scrollTo(0, params.to === "top" ? 0 : document.documentElement.scrollHeight);
      return true;
    }, params);
  } else {
    const direction = params.direction || "down";
    const amount = params.amount || 500;
    await cmdScroll({ x: 100, y: 100, deltaX: 0, deltaY: direction === "up" ? -amount : amount });
  }
  await new Promise(r => setTimeout(r, params.waitAfter ?? 500));
  const info = await cmdAgentBrowserTabInfo({});
  return { ok: true, scrollY: info.scrollY, scrollHeight: info.scrollHeight, atBottom: Math.ceil((info.scrollY || 0) + (info.viewportHeight || 0)) >= (info.scrollHeight || 0), elapsed: Date.now() - started };
}


async function cmdActionHover(params) {
  const target = params.target || {};
  const point = await resolveActionPoint(target);
  await sendCDP("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
  return { ok: true, target: { ...target, selector: point.selector || target.selector }, point, effects: { hoverDispatched: true } };
}

async function cmdActionPressKey(params) {
  if (params.target?.selector) await cmdClick({ selector: params.target.selector });
  await cmdSendKeys({ keys: params.key });
  return { ok: true, key: params.key };
}


async function cmdUploadFile(params) {
  const selector = params.selector;
  const paths = Array.isArray(params.paths) ? params.paths : [params.paths].filter(Boolean);
  if (!selector) throw new Error("upload_file requires selector");
  if (!paths.length) throw new Error("upload_file requires at least one path");

  await sendCDP("DOM.enable").catch(() => {});
  const documentResult = await sendCDP("DOM.getDocument", { depth: 1, pierce: true });
  const rootNodeId = documentResult.root?.nodeId;
  const queryResult = await sendCDP("DOM.querySelector", { nodeId: rootNodeId, selector });
  if (!queryResult.nodeId) throw new Error(`file input not found: ${selector}`);
  const describeResult = await sendCDP("DOM.describeNode", { nodeId: queryResult.nodeId });
  const node = describeResult.node || {};
  const attrs = node.attributes || [];
  const attrMap = {};
  for (let i = 0; i < attrs.length; i += 2) attrMap[attrs[i]] = attrs[i + 1];
  if (String(node.nodeName || "").toLowerCase() !== "input" || attrMap.type !== "file") {
    throw new Error(`selector is not an input[type=file]: ${selector}`);
  }
  await sendCDP("DOM.setFileInputFiles", { nodeId: queryResult.nodeId, files: paths });
  return { ok: true, selector, files: paths, count: paths.length };
}

async function cmdHandleDialog(params) {
  const action = params.action || "accept";
  const timeout = params.timeout ?? 5000;
  await sendCDP("Page.enable").catch(() => {});

  const deadline = Date.now() + timeout;
  while (!currentDialog && Date.now() < deadline) {
    await sleep(100);
  }
  if (!currentDialog) {
    return { ok: false, error: "no dialog observed", waited: timeout };
  }

  const dialog = currentDialog;
  await sendCDP("Page.handleJavaScriptDialog", {
    accept: action === "accept",
    promptText: params.promptText || ""
  });
  currentDialog = null;
  return { ok: true, action, dialog };
}

async function cmdWaitForDownload(params) {
  const timeout = params.timeout || 30000;
  const deadline = Date.now() + timeout;
  const pollInterval = 100;

  while (Date.now() < deadline) {
    const firstKey = downloadState.completed.keys().next().value;
    if (firstKey !== undefined) {
      const download = downloadState.completed.get(firstKey);
      downloadState.completed.delete(firstKey);
      return { ok: true, download };
    }
    await sleep(pollInterval);
  }

  throw new Error(`wait_for_download timed out after ${timeout}ms`);
}

async function cmdNetworkCapture(params) {
  const action = params.action || "status";
  if (action === "start") {
    networkCaptureState.enabled = true;
    networkCaptureState.includeResponseBody = !!params.includeResponseBody;
    networkCaptureState.maxEntries = Math.max(1, params.maxEntries || 500);
    await sendCDP("Network.enable", { maxPostDataSize: 200000 }).catch(() => {});
  } else if (action === "stop") {
    networkCaptureState.enabled = false;
    await sendCDP("Network.disable").catch(() => {});
  } else if (action === "clear") {
    networkCaptureState.entries = [];
    networkCaptureState.byRequestId.clear();
  } else if (action !== "status") {
    throw new Error(`unknown network_capture action: ${action}`);
  }
  return {
    ok: true,
    action,
    enabled: networkCaptureState.enabled,
    includeResponseBody: networkCaptureState.includeResponseBody,
    count: networkCaptureState.entries.length,
    maxEntries: networkCaptureState.maxEntries
  };
}

function filterNetworkEntries(params = {}) {
  const limit = Math.max(1, params.limit || 50);
  let entries = [...networkCaptureState.entries];
  if (params.urlContains) entries = entries.filter(e => (e.url || "").includes(params.urlContains));
  if (params.method) entries = entries.filter(e => String(e.method || "").toUpperCase() === String(params.method).toUpperCase());
  if (params.status !== undefined) entries = entries.filter(e => e.status === params.status);
  if (params.resourceType) entries = entries.filter(e => e.resourceType === params.resourceType);
  if (params.hasResponseBody !== undefined) entries = entries.filter(e => !!e.responseBody === !!params.hasResponseBody);
  return entries.slice(-limit).reverse();
}

async function cmdNetworkList(params) {
  const entries = filterNetworkEntries(params).map(e => compactNetworkEntry(e, false));
  return { ok: true, enabled: networkCaptureState.enabled, count: entries.length, requests: entries };
}

async function cmdNetworkQuery(params) {
  const entries = filterNetworkEntries(params).map(e => compactNetworkEntry(e, !!params.includeBody));
  return { ok: true, enabled: networkCaptureState.enabled, count: entries.length, requests: entries };
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function cmdNetworkFetch(params) {
  const started = Date.now();
  const method = params.method || "GET";
  const responseType = params.responseType || "text";
  const init = {
    method,
    headers: params.headers || {},
    credentials: params.credentials || "include"
  };
  if (params.body !== undefined && method.toUpperCase() !== "GET" && method.toUpperCase() !== "HEAD") {
    init.body = params.body;
  }
  const response = await fetch(params.url, init);
  const headers = {};
  response.headers.forEach((value, key) => { headers[key] = value; });
  let body;
  let base64Encoded = false;
  if (responseType === "base64") {
    body = arrayBufferToBase64(await response.arrayBuffer());
    base64Encoded = true;
  } else {
    body = await response.text();
  }
  return {
    ok: true,
    url: response.url,
    status: response.status,
    statusText: response.statusText,
    headers,
    body: String(body).slice(0, 500000),
    base64Encoded,
    elapsed: Date.now() - started
  };
}

async function cmdNetworkReplay(params) {
  const entry = networkCaptureState.entries.find(e =>
    (params.id && e.id === params.id) || (params.requestId && e.requestId === params.requestId)
  );
  if (!entry) return { ok: false, error: "captured request not found" };
  const headers = { ...(entry.requestHeaders || {}), ...(params.overrideHeaders || {}) };
  return cmdNetworkFetch({
    url: entry.url,
    method: entry.method || "GET",
    headers,
    body: params.overrideBody !== undefined ? params.overrideBody : entry.requestBody,
    responseType: params.responseType || "text"
  });
}

async function cmdConsoleCapture(params) {
  const action = params.action || "status";
  if (action === "start") {
    consoleCaptureState.enabled = true;
    consoleCaptureState.maxEntries = Math.max(1, params.maxEntries || 300);
    await sendCDP("Runtime.enable").catch(() => {});
    await sendCDP("Log.enable").catch(() => {});
  } else if (action === "stop") {
    consoleCaptureState.enabled = false;
    await sendCDP("Log.disable").catch(() => {});
  } else if (action === "clear") {
    consoleCaptureState.entries = [];
  } else if (action !== "status") {
    throw new Error(`unknown console_capture action: ${action}`);
  }
  return {
    ok: true,
    action,
    enabled: consoleCaptureState.enabled,
    count: consoleCaptureState.entries.length,
    maxEntries: consoleCaptureState.maxEntries
  };
}

function filterConsoleEntries(params = {}) {
  const limit = Math.max(1, params.limit || 50);
  let entries = [...consoleCaptureState.entries];
  if (Array.isArray(params.types) && params.types.length) {
    const allowed = new Set(params.types.map(t => String(t).toLowerCase()));
    entries = entries.filter(e => allowed.has(String(e.type || "").toLowerCase()));
  }
  return entries.slice(-limit).reverse();
}

async function cmdConsoleList(params) {
  const messages = filterConsoleEntries(params).map(({ stackTrace, args, ...entry }) => ({
    ...entry,
    text: String(entry.text || "").slice(0, 1000)
  }));
  return { ok: true, enabled: consoleCaptureState.enabled, count: messages.length, messages };
}

async function cmdConsoleGet(params) {
  const entry = consoleCaptureState.entries.find(e => e.id === params.id);
  if (!entry) return { ok: false, error: "console message not found", id: params.id };
  return { ok: true, message: entry };
}

async function cmdConsoleClear(params) {
  consoleCaptureState.entries = [];
  return { ok: true, cleared: true };
}

async function cmdScriptEvaluate(params) {
  const started = Date.now();
  const result = await cmdExecuteScript({
    script: params.expression,
    awaitPromise: params.awaitPromise !== false,
    timeout: params.timeout || 5000
  });
  return {
    ok: !!result.success,
    result: result.result,
    error: result.error,
    type: typeof result.result,
    elapsed: Date.now() - started
  };
}

async function cmdFrameEvaluate(params) {
  const { frameSelectors, script } = params;
  if (!Array.isArray(frameSelectors) || frameSelectors.length === 0) {
    throw new Error("frameSelectors is required");
  }
  if (typeof script !== "string") {
    throw new Error("script is required");
  }

  // 按 frameSelectors 逐层下钻，通过 contentDocument 进入同源 iframe
  let drillScript = `
    (function() {
      let doc = document;
  `;
  for (const sel of frameSelectors) {
    drillScript += `
      {
        const frame = doc.querySelector(${JSON.stringify(sel)});
        if (!frame) throw new Error('Frame not found: ' + ${JSON.stringify(sel)});
        const nextDoc = frame.contentDocument;
        if (!nextDoc) throw new Error('cross-origin iframe not supported: ' + ${JSON.stringify(sel)});
        doc = nextDoc;
      }
    `;
  }
  drillScript += `
      return (function(document) { ${script} })(doc);
    })()
  `;

  const result = await cmdExecuteScript({
    script: drillScript,
    awaitPromise: params.awaitPromise !== false,
    timeout: params.timeout || 30000,
  });

  if (!result.success) {
    throw new Error(result.error || "frame_evaluate failed");
  }
  return {
    ok: true,
    result: result.result,
  };
}

// ==================== Phase 2: Session + DOM Observation Commands ====================

async function cmdDomGetText(params) {
  const { selector } = params;
  if (!selector) {
    throw new Error("dom_get_text requires selector");
  }

  const script = `
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return JSON.stringify({ error: "selector not found" });
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return JSON.stringify({
        text: el.innerText || "",
        charCount: (el.innerText || "").length,
        meta: {
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute("role") || "",
          ariaLabel: el.getAttribute("aria-label") || "",
          childCount: el.children.length,
          visible: rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
        }
      });
    })()
  `;

  const result = await sendCDP("Runtime.evaluate", {
    expression: script,
    returnByValue: true
  });

  if (result.exceptionDetails) {
    throw new Error("dom_get_text failed: " + JSON.stringify(result.exceptionDetails));
  }

  const parsed = JSON.parse(result.result.value);
  if (parsed.error) {
    throw new Error(parsed.error);
  }
  return parsed;
}

async function cmdTabGroupCreate(params) {
  const title = params.title || "Link2Chrome Session";
  // 创建标签组需要一个初始 tab。先获取当前目标 tab 或创建一个临时 tab。
  let tabId = targetTabId;
  if (!tabId) {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tabs.length > 0) {
      tabId = tabs[0].id;
    }
  }
  if (!tabId) {
    // 没有可用 tab，创建一个空白标签页
    const newTab = await chrome.tabs.create({ url: "about:blank" });
    tabId = newTab.id;
    targetTabId = tabId;
  }

  const groupId = await chrome.tabs.group({ tabIds: [tabId] });
  await chrome.tabGroups.update(groupId, { title, color: "blue" });
  return { groupId, title };
}

async function cmdTabGroupAdd(params) {
  const { tabId, groupId } = params;
  if (tabId === undefined || groupId === undefined) {
    throw new Error("tab_group_add requires tabId and groupId");
  }
  await chrome.tabs.group({ tabIds: [tabId], groupId });
  return { ok: true, tabId, groupId };
}

async function cmdTabGroupClose(params) {
  const { groupId } = params;
  if (groupId === undefined) {
    throw new Error("tab_group_close requires groupId");
  }
  const tabs = await chrome.tabs.query({ groupId });
  const tabIds = tabs.map(t => t.id);
  if (tabIds.length > 0) {
    await chrome.tabs.remove(tabIds);
  }
  // 清理 targetTabId / attachedTabId
  for (const tid of tabIds) {
    if (tid === targetTabId) targetTabId = null;
    if (tid === attachedTabId) attachedTabId = null;
  }
  return { ok: true, closedCount: tabIds.length };
}

// ==================== Playwright Batch Helpers ====================

async function evalInPage(expression, tabId) {
  const targetId = tabId || await ensureDebuggerAttached();
  const result = await chrome.debugger.sendCommand(
    { tabId: targetId },
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true }
  );
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || String(result.exceptionDetails));
  }
  return result.result?.value;
}

async function waitForSelectorCdp(selector, opts = {}, tabId) {
  const timeout = opts.timeout || 10000;
  const script = `
    new Promise((resolve) => {
      const deadline = Date.now() + ${timeout};
      const check = () => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (el) {
          const r = el.getBoundingClientRect();
          const st = window.getComputedStyle(el);
          const visible = r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0';
          if (visible) { resolve(true); return; }
        }
        if (Date.now() > deadline) resolve(false);
        else setTimeout(check, 150);
      };
      check();
    })
  `;
  return evalInPage(script, tabId);
}

async function captureScreenshot(tabId) {
  return cmdScreenshot({ format: "png", quality: 80 });
}

function escapeJsString(str) {
  return String(str).replace(/["\\]/g, "\\$&");
}

function createLocatorNth(selector, n, tabId) {
  const nthResolve = `document.querySelectorAll(${JSON.stringify(selector)})[${n}]`;
  return createLocator(nthResolve, tabId);
}

function createLocatorByText(text, opts = {}, tabId) {
  const exact = opts.exact === true;
  const scriptBase = exact
    ? `Array.from(document.querySelectorAll('*')).find(el => el.textContent.trim() === ${JSON.stringify(text)})`
    : `Array.from(document.querySelectorAll('*')).find(el => el.textContent.includes(${JSON.stringify(text)}))`;
  const makePoint = `(() => { const el = ${scriptBase}; if (!el) return null; const r = el.getBoundingClientRect(); return {x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2)}; })()`;
  const makeAll = exact
    ? `Array.from(document.querySelectorAll('*')).filter(el => el.textContent.trim() === ${JSON.stringify(text)})`
    : `Array.from(document.querySelectorAll('*')).filter(el => el.textContent.includes(${JSON.stringify(text)}))`;
  return {
    click: async (opts) => {
      const info = await evalInPage(makePoint, tabId);
      if (!info) throw new Error(`getByText(${JSON.stringify(text)}): element not found`);
      return cmdClick({ x: info.x, y: info.y, button: opts?.button || "left", clickCount: opts?.clickCount || 1 });
    },
    fill: async (value) => {
      await evalInPage(`(() => { const el = ${scriptBase}; if (el) { el.focus(); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', {bubbles: true})); el.dispatchEvent(new Event('change', {bubbles: true})); } })()`, tabId);
      return { filled: true };
    },
    type: async (value) => {
      await evalInPage(`(() => { const el = ${scriptBase}; if (el) { el.focus(); el.value = (el.value || '') + ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', {bubbles: true})); } })()`, tabId);
      return { typed: true };
    },
    press: async (key) => cmdSendKeys({ keys: key }),
    textContent: async () => evalInPage(`(() => { const el = ${scriptBase}; return el ? el.textContent : null; })()`, tabId),
    allTextContents: async () => evalInPage(`(() => { const arr = ${makeAll}; return arr.map(el => el?.textContent || ''); })()`, tabId),
    innerText: async () => evalInPage(`(() => { const el = ${scriptBase}; return el ? el.innerText : null; })()`, tabId),
    getAttribute: async (name) => evalInPage(`(() => { const el = ${scriptBase}; return el ? el.getAttribute(${JSON.stringify(name)}) : null; })()`, tabId),
    isVisible: async () => evalInPage(`(() => { const el = ${scriptBase}; if (!el) return false; const r = el.getBoundingClientRect(); const st = window.getComputedStyle(el); return r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0'; })()`, tabId),
    isEnabled: async () => evalInPage(`(() => { const el = ${scriptBase}; if (!el) return false; return !el.disabled && el.getAttribute('aria-disabled') !== 'true'; })()`, tabId),
    count: async () => evalInPage(`Array.from(document.querySelectorAll('*')).filter(el => el.textContent.includes(${JSON.stringify(text)})).length`, tabId),
    first: () => createLocatorByText(text, opts, tabId),
    last: () => createLocatorByText(text, opts, tabId),
    nth: () => createLocatorByText(text, opts, tabId),
    and: (other) => createLocator(`Array.from([(${scriptBase})]).filter(el => el && el.matches(${JSON.stringify(other)}))[0]`, tabId),
    or: (other) => createLocator(`(${scriptBase}) || document.querySelector(${JSON.stringify(other)})`, tabId),
    filter: (opts2 = {}) => {
      const { hasText } = opts2;
      if (hasText !== undefined) {
        return createLocator(`(() => { const el = ${scriptBase}; return (el && el.textContent.includes(${JSON.stringify(hasText)})) ? el : null; })()`, tabId);
      }
      return createLocatorByText(text, opts, tabId);
    },
    check: async () => {
      await evalInPage(`(() => { const el = ${scriptBase}; if (el && el.type === 'checkbox') { el.checked = true; el.dispatchEvent(new Event('input', {bubbles: true})); el.dispatchEvent(new Event('change', {bubbles: true})); } })()`, tabId);
      return { checked: true };
    },
    uncheck: async () => {
      await evalInPage(`(() => { const el = ${scriptBase}; if (el && el.type === 'checkbox') { el.checked = false; el.dispatchEvent(new Event('input', {bubbles: true})); el.dispatchEvent(new Event('change', {bubbles: true})); } })()`, tabId);
      return { unchecked: true };
    },
    setChecked: async (checked) => {
      await evalInPage(`(() => { const el = ${scriptBase}; if (el && el.type === 'checkbox') { el.checked = ${!!checked}; el.dispatchEvent(new Event('input', {bubbles: true})); el.dispatchEvent(new Event('change', {bubbles: true})); } })()`, tabId);
      return { checked: !!checked };
    },
    selectOption: async (value) => {
      await evalInPage(`(() => { const el = ${scriptBase}; if (el && el.tagName === 'SELECT') { el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('change', {bubbles: true})); } })()`, tabId);
      return { selected: value };
    },
    hover: async () => {
      const info = await evalInPage(makePoint, tabId);
      if (!info) throw new Error(`getByText(${JSON.stringify(text)}): element not found`);
      await sendCDP("Input.dispatchMouseEvent", { type: "mouseMoved", x: info.x, y: info.y });
      return { hovered: true };
    },
    dblclick: async () => {
      const info = await evalInPage(makePoint, tabId);
      if (!info) throw new Error(`getByText(${JSON.stringify(text)}): element not found`);
      return cmdClick({ x: info.x, y: info.y, button: "left", clickCount: 2 });
    },
    locator: (childSel) => createLocator(`${childSel}`, tabId)
  };
}

function createLocatorByRole(role, opts = {}, tabId) {
  const name = opts.name;
  let scriptBase = `Array.from(document.querySelectorAll('[role=${JSON.stringify(role)}]'))`;
  if (name !== undefined) {
    scriptBase += `.filter(el => el.textContent.includes(${JSON.stringify(name)}) || el.getAttribute('aria-label') === ${JSON.stringify(name)} || el.getAttribute('title') === ${JSON.stringify(name)}))`;
  }
  scriptBase = `(Array.from(document.querySelectorAll('[role=${JSON.stringify(role)}]')).filter(el => ${name === undefined ? "true" : `(el.textContent.includes(${JSON.stringify(name)}) || el.getAttribute('aria-label') === ${JSON.stringify(name)} || el.getAttribute('title') === ${JSON.stringify(name)})`}))[0]`;
  const makePoint = `(() => { const el = ${scriptBase}; if (!el) return null; const r = el.getBoundingClientRect(); return {x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2)}; })()`;
  const makeAll = `Array.from(document.querySelectorAll('[role=${JSON.stringify(role)}]')).filter(el => ${name === undefined ? "true" : `(el.textContent.includes(${JSON.stringify(name)}) || el.getAttribute('aria-label') === ${JSON.stringify(name)} || el.getAttribute('title') === ${JSON.stringify(name)})`})`;
  return {
    click: async (opts) => {
      const info = await evalInPage(makePoint, tabId);
      if (!info) throw new Error(`getByRole(${JSON.stringify(role)}): element not found`);
      return cmdClick({ x: info.x, y: info.y, button: opts?.button || "left", clickCount: opts?.clickCount || 1 });
    },
    fill: async (value) => {
      await evalInPage(`(() => { const el = ${scriptBase}; if (el) { el.focus(); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', {bubbles: true})); el.dispatchEvent(new Event('change', {bubbles: true})); } })()`, tabId);
      return { filled: true };
    },
    type: async (value) => {
      await evalInPage(`(() => { const el = ${scriptBase}; if (el) { el.focus(); el.value = (el.value || '') + ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', {bubbles: true})); } })()`, tabId);
      return { typed: true };
    },
    press: async (key) => cmdSendKeys({ keys: key }),
    textContent: async () => evalInPage(`(() => { const el = ${scriptBase}; return el ? el.textContent : null; })()`, tabId),
    allTextContents: async () => evalInPage(`(() => { const arr = ${makeAll}; return arr.map(el => el?.textContent || ''); })()`, tabId),
    innerText: async () => evalInPage(`(() => { const el = ${scriptBase}; return el ? el.innerText : null; })()`, tabId),
    getAttribute: async (name) => evalInPage(`(() => { const el = ${scriptBase}; return el ? el.getAttribute(${JSON.stringify(name)}) : null; })()`, tabId),
    isVisible: async () => evalInPage(`(() => { const el = ${scriptBase}; if (!el) return false; const r = el.getBoundingClientRect(); const st = window.getComputedStyle(el); return r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0'; })()`, tabId),
    isEnabled: async () => evalInPage(`(() => { const el = ${scriptBase}; if (!el) return false; return !el.disabled && el.getAttribute('aria-disabled') !== 'true'; })()`, tabId),
    count: async () => evalInPage(`Array.from(document.querySelectorAll('[role=${JSON.stringify(role)}]')).filter(el => ${name === undefined ? "true" : `(el.textContent.includes(${JSON.stringify(name)}) || el.getAttribute('aria-label') === ${JSON.stringify(name)} || el.getAttribute('title') === ${JSON.stringify(name)})`}).length`, tabId),
    first: () => createLocatorByRole(role, opts, tabId),
    last: () => createLocatorByRole(role, opts, tabId),
    nth: () => createLocatorByRole(role, opts, tabId),
    and: (other) => createLocator(`Array.from([(${scriptBase})]).filter(el => el && el.matches(${JSON.stringify(other)}))[0]`, tabId),
    or: (other) => createLocator(`(${scriptBase}) || document.querySelector(${JSON.stringify(other)})`, tabId),
    filter: (opts2 = {}) => {
      const { hasText } = opts2;
      if (hasText !== undefined) {
        return createLocator(`(() => { const el = ${scriptBase}; return (el && el.textContent.includes(${JSON.stringify(hasText)})) ? el : null; })()`, tabId);
      }
      return createLocatorByRole(role, opts, tabId);
    },
    check: async () => {
      await evalInPage(`(() => { const el = ${scriptBase}; if (el && el.type === 'checkbox') { el.checked = true; el.dispatchEvent(new Event('input', {bubbles: true})); el.dispatchEvent(new Event('change', {bubbles: true})); } })()`, tabId);
      return { checked: true };
    },
    uncheck: async () => {
      await evalInPage(`(() => { const el = ${scriptBase}; if (el && el.type === 'checkbox') { el.checked = false; el.dispatchEvent(new Event('input', {bubbles: true})); el.dispatchEvent(new Event('change', {bubbles: true})); } })()`, tabId);
      return { unchecked: true };
    },
    setChecked: async (checked) => {
      await evalInPage(`(() => { const el = ${scriptBase}; if (el && el.type === 'checkbox') { el.checked = ${!!checked}; el.dispatchEvent(new Event('input', {bubbles: true})); el.dispatchEvent(new Event('change', {bubbles: true})); } })()`, tabId);
      return { checked: !!checked };
    },
    selectOption: async (value) => {
      await evalInPage(`(() => { const el = ${scriptBase}; if (el && el.tagName === 'SELECT') { el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('change', {bubbles: true})); } })()`, tabId);
      return { selected: value };
    },
    hover: async () => {
      const info = await evalInPage(makePoint, tabId);
      if (!info) throw new Error(`getByRole(${JSON.stringify(role)}): element not found`);
      await sendCDP("Input.dispatchMouseEvent", { type: "mouseMoved", x: info.x, y: info.y });
      return { hovered: true };
    },
    dblclick: async () => {
      const info = await evalInPage(makePoint, tabId);
      if (!info) throw new Error(`getByRole(${JSON.stringify(role)}): element not found`);
      return cmdClick({ x: info.x, y: info.y, button: "left", clickCount: 2 });
    },
    locator: (childSel) => createLocator(`${childSel}`, tabId)
  };
}

function createLocatorByLabel(text, tabId) {
  const scriptBase = `(Array.from(document.querySelectorAll('label')).filter(lbl => lbl.textContent.includes(${JSON.stringify(text)}) || lbl.getAttribute('for') && (document.querySelector('[id="' + lbl.getAttribute('for') + '"]')?.getAttribute('aria-label') === ${JSON.stringify(text)})))[0]`;
  const targetScript = `(() => { const lbl = ${scriptBase}; if (!lbl) return null; const forId = lbl.getAttribute('for'); return forId ? document.getElementById(forId) : lbl.querySelector('input, textarea, select'); })()`;
  const makePoint = `(() => { const el = (${targetScript}); if (!el) return null; const r = el.getBoundingClientRect(); return {x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2)}; })()`;
  const makeAll = `Array.from(document.querySelectorAll('label')).filter(lbl => lbl.textContent.includes(${JSON.stringify(text)}) || lbl.getAttribute('for') && (document.querySelector('[id="' + lbl.getAttribute('for') + '"]')?.getAttribute('aria-label') === ${JSON.stringify(text)})))`;
  return {
    click: async (opts) => {
      const info = await evalInPage(makePoint, tabId);
      if (!info) throw new Error(`getByLabel(${JSON.stringify(text)}): element not found`);
      return cmdClick({ x: info.x, y: info.y, button: opts?.button || "left", clickCount: opts?.clickCount || 1 });
    },
    fill: async (value) => {
      await evalInPage(`(() => { const el = (${targetScript}); if (el) { el.focus(); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', {bubbles: true})); el.dispatchEvent(new Event('change', {bubbles: true})); } })()`, tabId);
      return { filled: true };
    },
    type: async (value) => {
      await evalInPage(`(() => { const el = (${targetScript}); if (el) { el.focus(); el.value = (el.value || '') + ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', {bubbles: true})); } })()`, tabId);
      return { typed: true };
    },
    press: async (key) => cmdSendKeys({ keys: key }),
    textContent: async () => evalInPage(`(() => { const el = (${targetScript}); return el ? el.textContent : null; })()`, tabId),
    allTextContents: async () => evalInPage(`(() => { const arr = ${makeAll}; return arr.map(el => el?.textContent || ''); })()`, tabId),
    innerText: async () => evalInPage(`(() => { const el = (${targetScript}); return el ? el.innerText : null; })()`, tabId),
    getAttribute: async (name) => evalInPage(`(() => { const el = (${targetScript}); return el ? el.getAttribute(${JSON.stringify(name)}) : null; })()`, tabId),
    isVisible: async () => evalInPage(`(() => { const el = (${targetScript}); if (!el) return false; const r = el.getBoundingClientRect(); const st = window.getComputedStyle(el); return r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0'; })()`, tabId),
    isEnabled: async () => evalInPage(`(() => { const el = (${targetScript}); if (!el) return false; return !el.disabled && el.getAttribute('aria-disabled') !== 'true'; })()`, tabId),
    count: async () => evalInPage(`Array.from(document.querySelectorAll('label')).filter(lbl => lbl.textContent.includes(${JSON.stringify(text)}) || lbl.getAttribute('for') && (document.querySelector('[id="' + lbl.getAttribute('for') + '"]')?.getAttribute('aria-label') === ${JSON.stringify(text)})).length`, tabId),
    first: () => createLocatorByLabel(text, tabId),
    last: () => createLocatorByLabel(text, tabId),
    nth: () => createLocatorByLabel(text, tabId),
    and: (other) => createLocator(`Array.from([(${targetScript})]).filter(el => el && el.matches(${JSON.stringify(other)}))[0]`, tabId),
    or: (other) => createLocator(`(${targetScript}) || document.querySelector(${JSON.stringify(other)})`, tabId),
    filter: (opts2 = {}) => {
      const { hasText } = opts2;
      if (hasText !== undefined) {
        return createLocator(`(() => { const el = (${targetScript}); return (el && el.textContent.includes(${JSON.stringify(hasText)})) ? el : null; })()`, tabId);
      }
      return createLocatorByLabel(text, tabId);
    },
    check: async () => {
      await evalInPage(`(() => { const el = (${targetScript}); if (el && el.type === 'checkbox') { el.checked = true; el.dispatchEvent(new Event('input', {bubbles: true})); el.dispatchEvent(new Event('change', {bubbles: true})); } })()`, tabId);
      return { checked: true };
    },
    uncheck: async () => {
      await evalInPage(`(() => { const el = (${targetScript}); if (el && el.type === 'checkbox') { el.checked = false; el.dispatchEvent(new Event('input', {bubbles: true})); el.dispatchEvent(new Event('change', {bubbles: true})); } })()`, tabId);
      return { unchecked: true };
    },
    setChecked: async (checked) => {
      await evalInPage(`(() => { const el = (${targetScript}); if (el && el.type === 'checkbox') { el.checked = ${!!checked}; el.dispatchEvent(new Event('input', {bubbles: true})); el.dispatchEvent(new Event('change', {bubbles: true})); } })()`, tabId);
      return { checked: !!checked };
    },
    selectOption: async (value) => {
      await evalInPage(`(() => { const el = (${targetScript}); if (el && el.tagName === 'SELECT') { el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('change', {bubbles: true})); } })()`, tabId);
      return { selected: value };
    },
    hover: async () => {
      const info = await evalInPage(makePoint, tabId);
      if (!info) throw new Error(`getByLabel(${JSON.stringify(text)}): element not found`);
      await sendCDP("Input.dispatchMouseEvent", { type: "mouseMoved", x: info.x, y: info.y });
      return { hovered: true };
    },
    dblclick: async () => {
      const info = await evalInPage(makePoint, tabId);
      if (!info) throw new Error(`getByLabel(${JSON.stringify(text)}): element not found`);
      return cmdClick({ x: info.x, y: info.y, button: "left", clickCount: 2 });
    },
    locator: (childSel) => createLocator(`${childSel}`, tabId)
  };
}

function createLocatorByPlaceholder(text, tabId) {
  const scriptBase = `document.querySelector('[placeholder*=${JSON.stringify(text)}]')`;
  return createLocator(scriptBase, tabId);
}

function createLocator(selector, tabId) {
  const isExpression = selector.includes("document.querySelector") || selector.includes("Array.from");
  const resolveScript = isExpression
    ? `(() => { const el = (${selector}); return el ? {x: Math.round(el.getBoundingClientRect().x + el.getBoundingClientRect().width/2), y: Math.round(el.getBoundingClientRect().y + el.getBoundingClientRect().height/2)} : null; })()`
    : `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? {x: Math.round(el.getBoundingClientRect().x + el.getBoundingClientRect().width/2), y: Math.round(el.getBoundingClientRect().y + el.getBoundingClientRect().height/2)} : null; })()`;
  const countScript = isExpression
    ? `(typeof (${selector}) !== 'undefined' && (${selector}) !== null && !Array.isArray(${selector}) ? 1 : (Array.isArray(${selector}) ? (${selector}).length : 0))`
    : `document.querySelectorAll(${JSON.stringify(selector)}).length`;

  const locator = {
    click: async (opts) => {
      const info = await evalInPage(resolveScript, tabId);
      if (!info) throw new Error(`locator.click: element not found for ${selector}`);
      return cmdClick({ x: info.x, y: info.y, button: opts?.button || "left", clickCount: opts?.clickCount || 1 });
    },
    fill: async (value) => {
      if (isExpression) {
        await evalInPage(`(() => { const el = (${selector}); if (el) { el.focus(); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', {bubbles: true})); el.dispatchEvent(new Event('change', {bubbles: true})); } })()`, tabId);
      } else {
        await cmdType({ selector, text: value, clearFirst: true });
      }
      return { filled: true };
    },
    type: async (value) => {
      if (isExpression) {
        await evalInPage(`(() => { const el = (${selector}); if (el) { el.focus(); el.value = (el.value || '') + ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', {bubbles: true})); } })()`, tabId);
      } else {
        await cmdType({ selector, text: value, clearFirst: false });
      }
      return { typed: true };
    },
    press: async (key) => cmdSendKeys({ keys: key }),
    textContent: async () => evalInPage(isExpression
      ? `(() => { const el = (${selector}); return el ? el.textContent : null; })()`
      : `document.querySelector(${JSON.stringify(selector)})?.textContent`, tabId),
    allTextContents: async () => evalInPage(isExpression
      ? `(() => { const arr = Array.isArray(${selector}) ? (${selector}) : ((${selector}) ? [(${selector})] : []); return arr.map(el => el?.textContent || ''); })()`
      : `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).map(el => el.textContent)`, tabId),
    innerText: async () => evalInPage(isExpression
      ? `(() => { const el = (${selector}); return el ? el.innerText : null; })()`
      : `document.querySelector(${JSON.stringify(selector)})?.innerText`, tabId),
    getAttribute: async (name) => evalInPage(isExpression
      ? `(() => { const el = (${selector}); return el ? el.getAttribute(${JSON.stringify(name)}) : null; })()`
      : `document.querySelector(${JSON.stringify(selector)})?.getAttribute(${JSON.stringify(name)})`, tabId),
    isVisible: async () => evalInPage(isExpression
      ? `(() => { const el = (${selector}); if (!el) return false; const r = el.getBoundingClientRect(); const st = window.getComputedStyle(el); return r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0'; })()`
      : `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return !!(el && el.offsetParent !== null && getComputedStyle(el).visibility !== 'hidden'); })()`, tabId),
    isEnabled: async () => evalInPage(isExpression
      ? `(() => { const el = (${selector}); if (!el) return false; return !el.disabled && el.getAttribute('aria-disabled') !== 'true'; })()`
      : `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return !!(el && !el.disabled && el.getAttribute('aria-disabled') !== 'true'); })()`, tabId),
    count: async () => evalInPage(countScript, tabId),
    first: () => {
      if (isExpression) return createLocator(selector, tabId);
      return createLocator(`document.querySelector(${JSON.stringify(selector)})`, tabId);
    },
    last: () => {
      if (isExpression) return createLocator(selector, tabId);
      return createLocator(`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).slice(-1)[0]`, tabId);
    },
    nth: (n) => {
      if (isExpression) {
        return createLocator(selector, tabId);
      }
      return createLocatorNth(selector, n, tabId);
    },
    and: (other) => {
      if (isExpression) {
        return createLocator(`Array.from([(${selector})]).filter(el => el && el.matches(${JSON.stringify(other)}))[0]`, tabId);
      }
      return createLocator(`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).filter(el => el.matches(${JSON.stringify(other)}))[0]`, tabId);
    },
    or: (other) => {
      if (isExpression) {
        return createLocator(`(${selector}) || document.querySelector(${JSON.stringify(other)})`, tabId);
      }
      return createLocator(`${selector}, ${other}`, tabId);
    },
    filter: (opts = {}) => {
      const { hasText } = opts;
      if (hasText !== undefined) {
        if (isExpression) {
          return createLocator(`(() => { const el = (${selector}); return (el && el.textContent.includes(${JSON.stringify(hasText)})) ? el : null; })()`, tabId);
        }
        return createLocator(`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).filter(el => el.textContent.includes(${JSON.stringify(hasText)}))[0]`, tabId);
      }
      return createLocator(selector, tabId);
    },
    check: async () => {
      await evalInPage(isExpression
        ? `(() => { const el = (${selector}); if (el && el.type === 'checkbox') { el.checked = true; el.dispatchEvent(new Event('input', {bubbles: true})); el.dispatchEvent(new Event('change', {bubbles: true})); } })()`
        : `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el && el.type === 'checkbox') { el.checked = true; el.dispatchEvent(new Event('input', {bubbles: true})); el.dispatchEvent(new Event('change', {bubbles: true})); } })()`, tabId);
      return { checked: true };
    },
    uncheck: async () => {
      await evalInPage(isExpression
        ? `(() => { const el = (${selector}); if (el && el.type === 'checkbox') { el.checked = false; el.dispatchEvent(new Event('input', {bubbles: true})); el.dispatchEvent(new Event('change', {bubbles: true})); } })()`
        : `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el && el.type === 'checkbox') { el.checked = false; el.dispatchEvent(new Event('input', {bubbles: true})); el.dispatchEvent(new Event('change', {bubbles: true})); } })()`, tabId);
      return { unchecked: true };
    },
    setChecked: async (checked) => {
      await evalInPage(isExpression
        ? `(() => { const el = (${selector}); if (el && el.type === 'checkbox') { el.checked = ${!!checked}; el.dispatchEvent(new Event('input', {bubbles: true})); el.dispatchEvent(new Event('change', {bubbles: true})); } })()`
        : `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el && el.type === 'checkbox') { el.checked = ${!!checked}; el.dispatchEvent(new Event('input', {bubbles: true})); el.dispatchEvent(new Event('change', {bubbles: true})); } })()`, tabId);
      return { checked: !!checked };
    },
    selectOption: async (value) => {
      await evalInPage(isExpression
        ? `(() => { const el = (${selector}); if (el && el.tagName === 'SELECT') { el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('change', {bubbles: true})); } })()`
        : `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el && el.tagName === 'SELECT') { el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('change', {bubbles: true})); } })()`, tabId);
      return { selected: value };
    },
    hover: async () => {
      const info = await evalInPage(resolveScript, tabId);
      if (!info) throw new Error(`locator.hover: element not found for ${selector}`);
      await sendCDP("Input.dispatchMouseEvent", { type: "mouseMoved", x: info.x, y: info.y });
      return { hovered: true };
    },
    dblclick: async () => {
      const info = await evalInPage(resolveScript, tabId);
      if (!info) throw new Error(`locator.dblclick: element not found for ${selector}`);
      return cmdClick({ x: info.x, y: info.y, button: "left", clickCount: 2 });
    },
    locator: (childSel) => createLocator(isExpression ? `${selector} ${childSel}` : `${selector} ${childSel}`, tabId)
  };
  return locator;
}

function createPageShim(targetTabId) {
  return {
    goto: async (url) => cmdNavigate({ url, timeout: 10000, waitUntil: "dom-ready" }),
    title: async () => evalInPage("document.title", targetTabId),
    url: async () => evalInPage("window.location.href", targetTabId),
    locator: (selector) => createLocator(selector, targetTabId),
    getByText: (text, opts) => createLocatorByText(text, opts, targetTabId),
    getByRole: (role, opts) => createLocatorByRole(role, opts, targetTabId),
    getByLabel: (text) => createLocatorByLabel(text, targetTabId),
    getByPlaceholder: (text) => createLocatorByPlaceholder(text, targetTabId),
    getByTestId: (testId) => createLocator(`[data-testid=${JSON.stringify(testId)}]`, targetTabId),
    waitForSelector: async (sel, opts = {}) => waitForSelectorCdp(sel, opts, targetTabId),
    waitForTimeout: async (ms) => new Promise(r => setTimeout(r, ms)),
    waitForLoadState: async (state) => {
      const targetState = state === "load" ? "complete" : (state === "domcontentloaded" ? "interactive" : "complete");
      const script = `
        new Promise((resolve) => {
          const deadline = Date.now() + 30000;
          const check = () => {
            if (document.readyState === ${JSON.stringify(targetState)}) { resolve(true); return; }
            if (Date.now() > deadline) resolve(false);
            else setTimeout(check, 100);
          };
          check();
        })
      `;
      return evalInPage(script, targetTabId);
    },
    waitForURL: async (pattern) => {
      const script = `
        new Promise((resolve) => {
          const deadline = Date.now() + 30000;
          const pat = ${JSON.stringify(String(pattern))};
          const check = () => {
            if (location.href.includes(pat) || location.href === pat) { resolve(true); return; }
            if (Date.now() > deadline) resolve(false);
            else setTimeout(check, 100);
          };
          check();
        })
      `;
      return evalInPage(script, targetTabId);
    },
    expectNavigation: async (action) => {
      const beforeUrl = await evalInPage("window.location.href", targetTabId);
      await action();
      const script = `
        new Promise((resolve) => {
          const deadline = Date.now() + 30000;
          const before = ${JSON.stringify(beforeUrl)};
          const check = () => {
            if (location.href !== before) { resolve({ navigated: true, url: location.href }); return; }
            if (Date.now() > deadline) resolve({ navigated: false, url: location.href, error: "timeout" });
            else setTimeout(check, 100);
          };
          check();
        })
      `;
      return evalInPage(script, targetTabId);
    },
    evaluate: async (fn) => {
      const expression = typeof fn === "string" ? fn : `(${fn.toString()})()`;
      return evalInPage(expression, targetTabId);
    },
    screenshot: async () => captureScreenshot(targetTabId),
  };
}

async function cmdPlaywrightBatch(params) {
  const { code, timeout = 30000 } = params;
  const tabId = await ensureDebuggerAttached();
  targetTabId = tabId;
  const page = createPageShim(tabId);
  const fn = new Function("page", `return (async (page) => { ${code} })(page)`);
  const result = await Promise.race([
    fn(page),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Playwright timeout")), timeout))
  ]);
  return { ok: true, result };
}

async function cmdSaveAsPdf(params) {
  const {
    format = "a4",
    landscape = false,
    scale = 1.0,
    printBackground = true
  } = params;
  const tabId = await ensureDebuggerAttached();
  await chrome.debugger.sendCommand({ tabId }, "Page.enable").catch(() => {});
  const formatSizes = {
    a4: { paperWidth: 8.27, paperHeight: 11.69 },
    letter: { paperWidth: 8.5, paperHeight: 11.0 },
    legal: { paperWidth: 8.5, paperHeight: 14.0 },
    a3: { paperWidth: 11.69, paperHeight: 16.54 },
    tabloid: { paperWidth: 11.0, paperHeight: 17.0 }
  };
  const size = formatSizes[format] || formatSizes.a4;
  const result = await chrome.debugger.sendCommand(
    { tabId },
    "Page.printToPDF",
    {
      landscape: !!landscape,
      printBackground: !!printBackground,
      scale: Math.max(0.1, Math.min(2.0, scale)),
      paperWidth: size.paperWidth,
      paperHeight: size.paperHeight,
      preferCSSPageSize: false,
      displayHeaderFooter: false
    }
  );
  if (!result || !result.data) {
    throw new Error("Page.printToPDF returned no data");
  }
  return {
    ok: true,
    data: result.data,
    format,
    landscape: !!landscape,
    scale
  };
}

// -- clipboard --
async function cmdClipboardRead() {
  const script = `
    (async () => {
      if (!window.isSecureContext && location.protocol !== "https:" && location.hostname !== "localhost") {
        throw new Error("剪贴板访问被拒绝：需要 HTTPS 或 localhost，且需要用户交互");
      }
      const items = await navigator.clipboard.read();
      const result = [];
      for (const item of items) {
        const entries = [];
        for (const type of item.types) {
          const blob = await item.getType(type);
          if (type.startsWith("text/")) {
            const text = await blob.text();
            entries.push({ mimeType: type, text });
          } else {
            const base64 = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onloadend = () => resolve(reader.result.split(",")[1]);
              reader.onerror = reject;
              reader.readAsDataURL(blob);
            });
            entries.push({ mimeType: type, base64 });
          }
        }
        result.push({ entries });
      }
      return result;
    })()
  `;
  const result = await cmdExecuteScript({ script, awaitPromise: true, timeout: 10000 });
  if (!result.success) {
    const errMsg = result.error || "剪贴板读取失败";
    if (errMsg.includes("NotAllowedError") || errMsg.includes("Permission denied") || errMsg.includes("剪贴板访问被拒绝")) {
      throw new Error("剪贴板访问被拒绝：需要 HTTPS 或 localhost，且需要用户交互");
    }
    throw new Error(errMsg);
  }
  return result.result;
}

async function cmdClipboardWrite(params) {
  const { items } = params;
  if (!Array.isArray(items)) {
    throw new Error("items must be an array");
  }
  const script = `
    (async () => {
      if (!window.isSecureContext && location.protocol !== "https:" && location.hostname !== "localhost") {
        throw new Error("剪贴板访问被拒绝：需要 HTTPS 或 localhost，且需要用户交互");
      }
      const clipboardItems = [];
      const rawItems = ${JSON.stringify(items)};
      for (const item of rawItems) {
        const blobMap = {};
        for (const entry of item.entries) {
          if (entry.text !== undefined) {
            blobMap[entry.mimeType] = new Blob([entry.text], { type: entry.mimeType });
          } else if (entry.base64 !== undefined) {
            const binary = atob(entry.base64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
              bytes[i] = binary.charCodeAt(i);
            }
            blobMap[entry.mimeType] = new Blob([bytes], { type: entry.mimeType });
          }
        }
        clipboardItems.push(new ClipboardItem(blobMap));
      }
      await navigator.clipboard.write(clipboardItems);
      return { ok: true };
    })()
  `;
  const result = await cmdExecuteScript({ script, awaitPromise: true, timeout: 10000 });
  if (!result.success) {
    const errMsg = result.error || "剪贴板写入失败";
    if (errMsg.includes("NotAllowedError") || errMsg.includes("Permission denied") || errMsg.includes("剪贴板访问被拒绝")) {
      throw new Error("剪贴板访问被拒绝：需要 HTTPS 或 localhost，且需要用户交互");
    }
    throw new Error(errMsg);
  }
  return result.result;
}

// -- pageAssets --
async function cmdPageAssetsList(params) {
  const script = `
    (function() {
      const entries = performance.getEntriesByType("resource");
      return entries.map(function(r) {
        return {
          name: r.name,
          type: r.initiatorType,
          size: r.transferSize
        };
      });
    })()
  `;
  const result = await cmdExecuteScript({ script, awaitPromise: false, timeout: 10000 });
  if (!result.success) {
    throw new Error(result.error || "page_assets_list failed");
  }
  return result.result || [];
}

async function cmdPageAssetsBundle(params) {
  const { urls } = params;
  const MAX_TOTAL_SIZE = 50 * 1024 * 1024; // 50MB

  const list = await cmdPageAssetsList(params);
  const targets = urls && urls.length > 0
    ? list.filter(function(item) { return urls.includes(item.name); })
    : list;

  const assets = [];
  const errors = [];
  let totalSize = 0;

  for (const item of targets) {
    try {
      const response = await fetch(item.name, { credentials: "omit" });
      if (!response.ok) {
        errors.push({ name: item.name, reason: "HTTP " + response.status });
        continue;
      }
      const blob = await response.blob();
      const arrayBuffer = await blob.arrayBuffer();
      const size = arrayBuffer.byteLength;

      if (totalSize + size > MAX_TOTAL_SIZE) {
        errors.push({ name: item.name, reason: "exceeds total size limit (50MB)" });
        continue;
      }
      totalSize += size;

      const base64 = arrayBufferToBase64(arrayBuffer);
      assets.push({
        name: item.name,
        base64,
        mimeType: blob.type || "application/octet-stream"
      });
    } catch (err) {
      errors.push({ name: item.name, reason: err.message || "fetch failed" });
    }
  }

  return { assets, errors };
}

// ==================== 初始化 ====================
chrome.storage.local.get("connectionEnabled", (result) => {
  // 未设置过时默认为 true
  connectionEnabled = result.connectionEnabled !== false;
  if (connectionEnabled) {
    setupKeepaliveAlarm();
    connectNativeBootstrap().finally(() => connectWebSocket());
  }
  console.log(`[Link2Chrome] Service Worker 已启动, enabled=${connectionEnabled}`);
});
