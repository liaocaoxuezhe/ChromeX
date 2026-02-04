/**
 * Link2Chrome - Background Service Worker
 * 负责 WebSocket 客户端连接、CDP 操作分发、debugger 管理
 */

// ==================== 状态管理 ====================
const BUILD_VERSION = "2025-02-03-v4"; // 用于验证扩展是否加载了新代码
let ws = null;
let wsConnected = false;
let attachedTabId = null;
// 显式跟踪当前工作标签（解决 active tab 返回 chrome-extension:// 页面的问题）
let targetTabId = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const WS_URL = "ws://localhost:8765";
const HEARTBEAT_INTERVAL = 30000;
let heartbeatTimer = null;

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
  if (ws && ws.readyState === WebSocket.OPEN) return;

  try {
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      console.log("[Link2Chrome] WebSocket 已连接");
      wsConnected = true;
      reconnectAttempts = 0;
      broadcastStatus();
      startHeartbeat();
    };

    ws.onmessage = async (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === "pong") return;
        const result = await handleCommand(message);
        ws.send(JSON.stringify(result));
      } catch (err) {
        console.error("[Link2Chrome] 处理消息出错:", err);
        if (event.data) {
          try {
            const msg = JSON.parse(event.data);
            ws.send(JSON.stringify({
              request_id: msg.request_id,
              success: false,
              error: err.message
            }));
          } catch (_) {}
        }
      }
    };

    ws.onclose = () => {
      console.log("[Link2Chrome] WebSocket 已断开");
      wsConnected = false;
      ws = null;
      broadcastStatus();
      stopHeartbeat();
      scheduleReconnect();
    };

    ws.onerror = (err) => {
      console.error("[Link2Chrome] WebSocket 错误:", err);
    };
  } catch (err) {
    console.error("[Link2Chrome] 创建 WebSocket 失败:", err);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.log("[Link2Chrome] 已达最大重连次数，停止重连");
    return;
  }
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 32000);
  reconnectAttempts++;
  console.log(`[Link2Chrome] ${delay / 1000}s 后尝试第 ${reconnectAttempts} 次重连`);
  setTimeout(connectWebSocket, delay);
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
  const tabId = await ensureDebuggerAttached();
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

// 监听 debugger detach 事件
chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId === attachedTabId) {
    console.log(`[Link2Chrome] Debugger 已分离: ${reason}`);
    attachedTabId = null;
  }
});

// 监听 tab 关闭，清理 targetTabId
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === targetTabId) {
    targetTabId = null;
  }
  if (tabId === attachedTabId) {
    attachedTabId = null;
  }
});

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
  const result = await sendCDP("Page.captureScreenshot", {
    format,
    quality,
    fromSurface: true
  });
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
  const { text, clearFirst = false, pressEnter = false, selector } = params;

  if (selector) {
    await cmdClick({ selector });
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
async function cmdNavigate(params) {
  const { url } = params;

  // 优先获取当前活动的标签页，而不是寻找可调试的标签页
  // 这样可以确保我们在正确的标签页上导航
  let tabId;
  let tab;

  // 首先尝试获取当前活动窗口的活动标签页
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (activeTab) {
    tabId = activeTab.id;
    tab = activeTab;
    console.log(`[Link2Chrome] 导航: 使用当前活动标签页 ${tabId}, 当前URL: ${activeTab.url}`);
  } else {
    // 如果没有活动标签页，尝试使用 targetTabId
    if (targetTabId) {
      try {
        tab = await chrome.tabs.get(targetTabId);
        tabId = targetTabId;
        console.log(`[Link2Chrome] 导航: 使用 targetTabId ${tabId}`);
      } catch (err) {
        console.log(`[Link2Chrome] targetTabId ${targetTabId} 无效，将创建新标签页`);
        tabId = null;
      }
    }
  }

  // 如果没有找到标签页，创建一个新标签页
  if (!tabId) {
    console.log(`[Link2Chrome] 没有可用标签页，创建新标签页`);
    const newTab = await chrome.tabs.create({ url });
    tabId = newTab.id;
    targetTabId = tabId;
    attachedTabId = null;
    console.log(`[Link2Chrome] 已创建新标签页 ${tabId} 并导航到 ${url}`);

    // 等待页面加载完成
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve({ navigated: true, url, status: "timeout", tabId });
      }, 15000);

      const listener = (updatedTabId, changeInfo, updatedTab) => {
        if (updatedTabId === tabId && changeInfo.status === "complete") {
          clearTimeout(timeout);
          chrome.tabs.onUpdated.removeListener(listener);
          targetTabId = tabId;
          attachedTabId = null;
          console.log(`[Link2Chrome] 新标签页导航完成: ${updatedTab.url}`);
          resolve({ navigated: true, url: updatedTab.url, status: "complete", tabId });
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
  }

  // 更新现有标签页的 URL
  await chrome.tabs.update(tabId, { url });
  attachedTabId = null; // 重置 attached 状态
  targetTabId = tabId;  // 立即设置 targetTabId
  console.log(`[Link2Chrome] 导航: 已更新标签页 ${tabId} 的 URL 为 ${url}`);

  // 等待页面加载完成
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      targetTabId = tabId;
      resolve({ navigated: true, url, status: "timeout", tabId });
    }, 15000);

    const listener = (updatedTabId, changeInfo, updatedTab) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        targetTabId = tabId;
        attachedTabId = null;
        console.log(`[Link2Chrome] 导航完成: ${updatedTab.url}`);
        resolve({ navigated: true, url: updatedTab.url, status: "complete", tabId });
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
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
  const { action, tab_index, url } = params;

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
    connected: wsConnected
  }).catch(() => {});
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "getStatus") {
    sendResponse({ connected: wsConnected, targetTabId });
    return true;
  }
  if (message.type === "reconnect") {
    reconnectAttempts = 0;
    connectWebSocket();
    sendResponse({ ok: true });
    return true;
  }
});

// ==================== 初始化 ====================
connectWebSocket();
console.log("[Link2Chrome] Service Worker 已启动");
