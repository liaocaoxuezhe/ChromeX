(function installDebuggerContext(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  root.Link2ChromeDebuggerContext = api;
})(typeof globalThis !== "undefined" ? globalThis : self, function createDebuggerContextApi() {
  "use strict";

  class DebuggerContextError extends Error {
    constructor(code, message, details = {}) {
      super(message);
      this.name = "DebuggerContextError";
      this.code = code;
      this.details = { ...details };
    }
  }

  function createTabDebuggerContext(tabId) {
    return {
      tabId,
      attached: false,
      attachPromise: null,
      networkCapture: {
        enabled: false,
        includeResponseBody: false,
        maxEntries: 500,
        entries: [],
        byRequestId: new Map(),
        sequence: 0,
      },
      consoleCapture: {
        enabled: false,
        maxEntries: 300,
        entries: [],
        sequence: 0,
      },
      dialog: null,
      downloads: {
        pending: new Map(),
        completed: new Map(),
      },
    };
  }

  class MultiTargetDebuggerManager {
    constructor({ chromeApi, sessionContextStore = null, protocolVersion = "1.3" }) {
      if (!chromeApi?.debugger) {
        throw new TypeError("MultiTargetDebuggerManager requires chrome.debugger");
      }
      this.chrome = chromeApi;
      this.sessionContextStore = sessionContextStore;
      this.protocolVersion = protocolVersion;
      this.contexts = new Map();
      this.eventListeners = new Set();
    }

    async ensureAttached(tabId, expectedSessionId = null) {
      this.#assertOwnership(tabId, expectedSessionId);
      const context = this.#getOrCreate(tabId);
      if (context.attached) return tabId;
      if (context.attachPromise) return context.attachPromise;

      context.attachPromise = (async () => {
        await this.chrome.debugger.attach({ tabId }, this.protocolVersion);
        context.attached = true;
        return tabId;
      })();
      try {
        return await context.attachPromise;
      } finally {
        context.attachPromise = null;
      }
    }

    async send(tabId, expectedSessionId, method, params = {}) {
      await this.ensureAttached(tabId, expectedSessionId);
      return this.chrome.debugger.sendCommand({ tabId }, method, params);
    }

    async detach(tabId) {
      const context = this.contexts.get(tabId);
      if (!context?.attached) return false;
      await this.chrome.debugger.detach({ tabId });
      context.attached = false;
      context.attachPromise = null;
      return true;
    }

    handleDetach(source) {
      const context = this.contexts.get(source?.tabId);
      if (!context) return false;
      context.attached = false;
      context.attachPromise = null;
      return true;
    }

    onEvent(listener) {
      this.eventListeners.add(listener);
      return () => this.eventListeners.delete(listener);
    }

    routeEvent(source, method, params) {
      if (!Number.isInteger(source?.tabId)) return false;
      const context = this.#getOrCreate(source.tabId);
      for (const listener of this.eventListeners) {
        listener(context, method, params, source);
      }
      return true;
    }

    getContext(tabId) {
      return this.contexts.get(tabId) || null;
    }

    getOrCreateContext(tabId) {
      return this.#getOrCreate(tabId);
    }

    allContexts() {
      return [...this.contexts.values()];
    }

    remove(tabId) {
      return this.contexts.delete(tabId);
    }

    snapshot() {
      return [...this.contexts.values()].map((context) => ({
        tabId: context.tabId,
        attached: context.attached,
        networkEnabled: context.networkCapture.enabled,
        networkEntries: context.networkCapture.entries.length,
        consoleEnabled: context.consoleCapture.enabled,
        consoleEntries: context.consoleCapture.entries.length,
        hasDialog: context.dialog != null,
        pendingDownloads: context.downloads.pending.size,
        completedDownloads: context.downloads.completed.size,
      }));
    }

    #getOrCreate(tabId) {
      if (!Number.isInteger(tabId)) {
        throw new DebuggerContextError(
          "INVALID_TAB_ID",
          "Debugger target requires an integer tabId",
          { tabId },
        );
      }
      let context = this.contexts.get(tabId);
      if (!context) {
        context = createTabDebuggerContext(tabId);
        this.contexts.set(tabId, context);
      }
      return context;
    }

    #assertOwnership(tabId, expectedSessionId) {
      if (!expectedSessionId || !this.sessionContextStore) return;
      const actualSessionId = this.sessionContextStore.ownerOfTab(tabId);
      if (actualSessionId !== expectedSessionId) {
        throw new DebuggerContextError(
          "TAB_OUTSIDE_SESSION",
          `tab ${tabId} is outside session ${expectedSessionId}`,
          { tabId, sessionId: expectedSessionId, actualSessionId },
        );
      }
    }
  }

  return {
    DebuggerContextError,
    MultiTargetDebuggerManager,
    createTabDebuggerContext,
  };
});
