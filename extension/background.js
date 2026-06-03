/**
 * Link2Chrome - Background Service Worker
 * 负责 WebSocket 客户端连接、CDP 操作分发、debugger 管理
 */

// ==================== 状态管理 ====================
const BUILD_VERSION = "2025-02-10-sendkeys"; // 用于验证扩展是否加载了新代码（send_keys code 修复）
let ws = null;
let wsConnected = false;
let connectionEnabled = true; // 用户可通过 popup 开关控制
let attachedTabId = null;
// 显式跟踪当前工作标签（解决 active tab 返回 chrome-extension:// 页面的问题）
let targetTabId = null;
let reconnectAttempts = 0;
let reconnectTimer = null;
const MAX_RECONNECT_ATTEMPTS = 10;
const WS_URL = "ws://localhost:8765";
const HEARTBEAT_INTERVAL = 30000;
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

// ==================== WebSocket 管理 ====================

function connectWebSocket() {
  if (!connectionEnabled) return;
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
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "ping" }));
    }
  }, HEARTBEAT_INTERVAL);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

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
      console.log(`[Link2Chrome] Debugger 已附加到 tab ${tabId} (${tab.url})`);
      return tabId;
    } catch (err) {
      console.error(`[Link2Chrome] attach tab ${tabId} (${tab.url}) 失败: ${err.message}`);
      failedIds.add(tabId);
      if (tabId === targetTabId) targetTabId = null;
      attachedTabId = null;
      // 如果不是 chrome-extension 相关错误，直接抛出
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
      case "wait":
        response.data = await cmdWait(params);
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
      case "wait_for_condition":
        response.data = await cmdWaitForCondition(params);
        break;
      case "detach_debugger":
        response.data = await cmdDetachDebugger(params);
        break;
      case "scroll_until":
        response.data = await cmdScrollUntil(params);
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
      case "agent_browser_tabs_finalize":
        response.data = await cmdAgentBrowserTabsFinalize(params);
        break;
      case "agent_browser_history":
        response.data = await cmdAgentBrowserHistory(params);
        break;
      case "clipboard_read":
        response.data = await cmdClipboardRead(params);
        break;
      case "clipboard_write":
        response.data = await cmdClipboardWrite(params);
        break;
      case "agent_browser_wait":
        response.data = await cmdAgentBrowserWait(params);
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
      case "dom_structured_data":
        response.data = await cmdDomStructuredData(params);
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
      case "action_type":
        response.data = await cmdActionType(params);
        break;
      case "action_scroll":
        response.data = await cmdActionScroll(params);
        break;
      case "action_select":
        response.data = await cmdActionSelect(params);
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
      case "action_press_key":
        response.data = await cmdActionPressKey(params);
        break;
      case "action_fill_form":
        response.data = await cmdActionFillForm(params);
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
      case "ping_version":
        response.data = {
          version: BUILD_VERSION,
          targetTabId,
          attachedTabId,
          wsConnected
        };
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

  await chrome.tabs.update(tabId, { url });
  targetTabId = tabId;
  attachedTabId = null;
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
async function cmdWait(params) {
  const { seconds, selector, text, timeout = 10000 } = params;

  if (seconds) {
    await new Promise(r => setTimeout(r, seconds * 1000));
    return { waited: true, type: "time", seconds };
  }

  if (selector) {
    const pollScript = `
      new Promise((resolve) => {
        const deadline = Date.now() + ${timeout};
        const check = () => {
          if (document.querySelector(${JSON.stringify(selector)})) {
            resolve(true);
          } else if (Date.now() > deadline) {
            resolve(false);
          } else {
            setTimeout(check, 200);
          }
        };
        check();
      })
    `;
    const result = await sendCDP("Runtime.evaluate", {
      expression: pollScript,
      awaitPromise: true,
      returnByValue: true
    });
    const found = result.result.value;
    return { waited: true, type: "selector", selector, found };
  }

  if (text) {
    const pollScript = `
      new Promise((resolve) => {
        const deadline = Date.now() + ${timeout};
        const check = () => {
          if (document.body.innerText.includes(${JSON.stringify(text)})) {
            resolve(true);
          } else if (Date.now() > deadline) {
            resolve(false);
          } else {
            setTimeout(check, 200);
          }
        };
        check();
      })
    `;
    const result = await sendCDP("Runtime.evaluate", {
      expression: pollScript,
      awaitPromise: true,
      returnByValue: true
    });
    const found = result.result.value;
    return { waited: true, type: "text", text, found };
  }

  await new Promise(r => setTimeout(r, 1000));
  return { waited: true, type: "default" };
}

// -- get_all_tabs --
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
  chrome.runtime.sendMessage({
    type: "status",
    connected: wsConnected,
    enabled: connectionEnabled
  }).catch(() => {});
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
  stopHeartbeat();
  broadcastStatus();
  chrome.storage.local.set({ connectionEnabled: false });
}

function enableConnection() {
  connectionEnabled = true;
  reconnectAttempts = 0;
  chrome.storage.local.set({ connectionEnabled: true });
  connectWebSocket();
  broadcastStatus();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "getStatus") {
    sendResponse({ connected: wsConnected, enabled: connectionEnabled, targetTabId });
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
    connectWebSocket();
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
async function cmdWaitForCondition(params) {
  const { condition_type, selector, script, timeout = 10000 } = params;

  if (condition_type === "visible") {
    // 等待元素可见
    const pollScript = `
      new Promise((resolve) => {
        const deadline = Date.now() + ${timeout};
        const check = () => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (el) {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            const isVisible = rect.width > 0 && rect.height > 0
              && style.display !== 'none'
              && style.visibility !== 'hidden'
              && style.opacity !== '0';
            if (isVisible) {
              resolve({ found: true, visible: true });
              return;
            }
          }
          if (Date.now() > deadline) {
            resolve({ found: false, visible: false });
          } else {
            setTimeout(check, 200);
          }
        };
        check();
      })
    `;

    const result = await sendCDP("Runtime.evaluate", {
      expression: pollScript,
      awaitPromise: true,
      returnByValue: true
    });

    return {
      condition_type: "visible",
      selector: selector,
      ...result.result.value
    };

  } else if (condition_type === "custom") {
    // 自定义 JS 条件
    const pollScript = `
      new Promise((resolve) => {
        const deadline = Date.now() + ${timeout};
        const check = () => {
          const condition = ${script};
          if (condition) {
            resolve({ satisfied: true });
          } else if (Date.now() > deadline) {
            resolve({ satisfied: false, timeout: true });
          } else {
            setTimeout(check, 200);
          }
        };
        check();
      })
    `;

    const result = await sendCDP("Runtime.evaluate", {
      expression: pollScript,
      awaitPromise: true,
      returnByValue: true
    });

    return {
      condition_type: "custom",
      ...result.result.value
    };
  }

  throw new Error(`未知的等待条件类型: ${condition_type}`);
}

// -- detach_debugger --
async function cmdDetachDebugger(params) {
  const { tab_id } = params;
  const targetId = tab_id !== undefined ? tab_id : attachedTabId;

  if (targetId === null) {
    return { success: false, error: "没有已附加的 debugger" };
  }

  try {
    await chrome.debugger.detach({ tabId: targetId });
    if (targetId === attachedTabId) {
      attachedTabId = null;
    }
    console.log(`[Link2Chrome] 已主动 detach debugger from tab ${targetId}`);
    return { success: true, tabId: targetId };
  } catch (err) {
    console.error(`[Link2Chrome] Detach 失败: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// ==================== 第二阶段新增命令实现 ====================

// -- scroll_until --
async function cmdScrollUntil(params) {
  const { condition, selector, max_scrolls = 20, scroll_delay = 500 } = params;

  let scrollCount = 0;
  let lastHeight = await sendCDP("Runtime.evaluate", {
    expression: "document.body.scrollHeight",
    returnByValue: true
  }).then(r => r.result.value);

  let noChangeCount = 0;
  let foundElement = false;

  while (scrollCount < max_scrolls) {
    // 根据条件类型检查
    if (condition === "element_visible" && selector) {
      // 检查元素是否可见
      const checkScript = `
        (function() {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 &&
                 style.display !== 'none' &&
                 style.visibility !== 'hidden' &&
                 style.opacity !== '0';
        })()
      `;
      const result = await sendCDP("Runtime.evaluate", {
        expression: checkScript,
        returnByValue: true
      });
      if (result.result.value === true) {
        foundElement = true;
        break;
      }
    } else if (condition === "no_more_content") {
      // 检查页面高度是否不再变化
      const newHeight = await sendCDP("Runtime.evaluate", {
        expression: "document.body.scrollHeight",
        returnByValue: true
      }).then(r => r.result.value);

      if (newHeight === lastHeight) {
        noChangeCount++;
        if (noChangeCount >= 3) {
          // 高度连续3次不变，认为到底了
          break;
        }
      } else {
        noChangeCount = 0;
        lastHeight = newHeight;
      }
    }

    // 滚动
    await sendCDP("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: 100, y: 100,
      deltaX: 0, deltaY: 500
    });

    scrollCount++;
    await new Promise(r => setTimeout(r, scroll_delay));
  }

  return {
    scrolled: scrollCount,
    condition: condition,
    reached_condition: condition === "element_visible" ? foundElement : noChangeCount >= 3,
    final_height: lastHeight
  };
}

// -- send_keys --
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

async function cmdAgentBrowserTabsFinalize(params) {
  const keep = Array.isArray(params.keep) ? params.keep : [];
  const grouped = [];
  const closed = [];

  for (const item of keep) {
    const tabId = Number(item.tabId);
    const status = item.status || "handoff";
    if (!Number.isInteger(tabId)) continue;
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch (_) {
      continue;
    }

    if (status === "deliverable" || status === "handoff") {
      const groupId = await chrome.tabs.group({ tabIds: [tabId] });
      await chrome.tabGroups.update(groupId, {
        title: status === "deliverable" ? "Link2Chrome Deliverable" : "Link2Chrome Handoff",
        color: status === "deliverable" ? "green" : "blue"
      });
      grouped.push({ tabId, groupId, status, windowId: tab.windowId, url: tab.url });
      continue;
    }

    if (status === "close" || status === "temporary") {
      await chrome.tabs.remove(tabId);
      closed.push({ tabId, status });
    }
  }

  return { ok: true, action: "finalize", grouped, closed };
}

async function cmdAgentBrowserHistory(params) {
  const maxResults = Math.min(Math.max(Number(params.maxResults ?? params.limit ?? 20), 1), 100);
  const query = {
    text: String(params.text ?? ""),
    maxResults
  };
  if (params.startTime !== undefined) query.startTime = Number(params.startTime);
  if (params.endTime !== undefined) query.endTime = Number(params.endTime);

  const items = await chrome.history.search(query);
  const entries = items.map((item) => ({
    id: item.id,
    url: item.url,
    title: item.title || "",
    lastVisitTime: item.lastVisitTime || null,
    visitCount: item.visitCount || 0,
    typedCount: item.typedCount || 0
  }));
  return { ok: true, entries, count: entries.length };
}

async function cmdClipboardRead(params) {
  const result = await sendCDP("Runtime.evaluate", {
    expression: "navigator.clipboard.readText()",
    awaitPromise: true,
    returnByValue: true,
    timeout: params.timeout || 5000
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || "clipboard read failed");
  }
  return { ok: true, text: result.result?.value || "" };
}

async function cmdClipboardWrite(params) {
  const text = String(params.text ?? "");
  const result = await sendCDP("Runtime.evaluate", {
    expression: `navigator.clipboard.writeText(${JSON.stringify(text)})`,
    awaitPromise: true,
    returnByValue: true,
    timeout: params.timeout || 5000
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || "clipboard write failed");
  }
  return { ok: true, textLength: text.length };
}

async function cmdAgentBrowserWait(params) {
  const started = Date.now();
  const condition = params.condition || "dom-ready";
  if (condition === "timeout") {
    await new Promise(r => setTimeout(r, params.timeout || 1000));
  } else if (condition === "dom-ready") {
    if (params.selector) {
      await cmdDomWaitFor({ selector: params.selector, state: "present", timeout: params.timeout || 10000 });
    } else {
      await cmdWait({ selector: "body", timeout: params.timeout || 10000 });
    }
  } else {
    throw new Error(`Unsupported wait condition: ${condition}`);
  }
  return { ok: true, elapsed: Date.now() - started, condition };
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

async function cmdDomStructuredData(params) {
  return evaluatePageFunction(() => {
    const jsonLd = Array.from(document.querySelectorAll('script[type="application/ld+json"]')).map(s => {
      try { return JSON.parse(s.textContent); } catch (_) { return null; }
    }).filter(Boolean);
    const openGraph = {};
    document.querySelectorAll('meta[property^="og:"]').forEach(m => {
      openGraph[m.getAttribute("property").replace(/^og:/, "")] = m.getAttribute("content") || "";
    });
    const twitter = {};
    document.querySelectorAll('meta[name^="twitter:"]').forEach(m => {
      twitter[m.getAttribute("name").replace(/^twitter:/, "")] = m.getAttribute("content") || "";
    });
    const meta = {};
    document.querySelectorAll("meta[name]").forEach(m => {
      const name = m.getAttribute("name");
      if (["description", "keywords", "author", "robots", "viewport"].includes(name)) meta[name] = m.getAttribute("content") || "";
    });
    return { jsonLd, openGraph, twitter, meta };
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
    await cmdClick({ x: el.x, y: el.y });
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

async function cmdActionType(params) {
  const target = params.target || {};
  let selector = target.selector;
  if (!selector && target.name) selector = `[name="${cssEscape(target.name)}"]`;
  if (!selector && target.placeholder) selector = `[placeholder*="${cssEscape(target.placeholder)}"]`;
  await cmdType({ selector, text: params.text || "", clearFirst: params.clearFirst !== false, pressEnter: params.submitAfter === "enter" });
  if (params.submitAfter === "tab") await cmdSendKeys({ keys: "Tab" });
  return { ok: true, target: { ...target, selector }, value: params.text || "", effects: { inputEventFired: true } };
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

async function cmdActionSelect(params) {
  return evaluatePageFunction((params) => {
    const target = params.target || {};
    const selector = target.selector || (target.name ? `[name="${cssEscape(target.name)}"]` : null) || (target.ariaLabel ? `[aria-label*="${cssEscape(target.ariaLabel)}"]` : null);
    const el = document.querySelector(selector);
    if (!el) return { ok: false, error: "select not found", selector };
    const options = Array.from(el.options || []);
    const match = options.find(o => (params.by !== "text" && o.value === params.value) || (params.by !== "value" && o.text.trim() === params.value));
    if (!match) return { ok: false, error: "option not found", optionsCount: options.length };
    el.value = match.value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, selected: match.value, text: match.text, optionsCount: options.length };
  }, params);
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

async function cmdActionFillForm(params) {
  const failed = [];
  let filled = 0;
  for (const field of params.fields || []) {
    try {
      if (field.type === "select") {
        const result = await cmdActionSelect({ target: { selector: field.selector, name: field.name }, value: field.value, by: "value" });
        if (!result.ok) throw new Error(result.error);
      } else if (field.type === "checkbox" || field.type === "radio") {
        await cmdClick({ selector: field.selector || `[name="${cssEscape(field.name)}"]` });
      } else {
        await cmdActionType({ target: { selector: field.selector, name: field.name }, text: field.value, clearFirst: true });
      }
      filled++;
    } catch (err) {
      failed.push({ field, error: err.message });
    }
  }
  if (params.submit) {
    const formSelector = params.formSelector || "form";
    await evaluatePageFunction((params) => {
      const form = document.querySelector(params.formSelector);
      if (form) form.requestSubmit ? form.requestSubmit() : form.submit();
      return true;
    }, { formSelector });
  }
  return { ok: failed.length === 0, filled, failed, submitted: !!params.submit };
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

// ==================== 初始化 ====================
chrome.storage.local.get("connectionEnabled", (result) => {
  // 未设置过时默认为 true
  connectionEnabled = result.connectionEnabled !== false;
  if (connectionEnabled) {
    connectWebSocket();
  }
  console.log(`[Link2Chrome] Service Worker 已启动, enabled=${connectionEnabled}`);
});
