(function installSessionTransactions(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  root.Link2ChromeSessionTransactions = api;
})(typeof globalThis !== "undefined" ? globalThis : self, function createTransactionApi() {
  "use strict";

  class SessionTransactionError extends Error {
    constructor(code, message, details = {}) {
      super(message);
      this.name = "SessionTransactionError";
      this.code = code;
      this.details = { ...details };
    }
  }

  class SessionTransactionManager {
    constructor({ chromeApi, contextStore, createBackgroundTab }) {
      if (!chromeApi || !contextStore || typeof createBackgroundTab !== "function") {
        throw new TypeError("SessionTransactionManager requires chromeApi, contextStore, and createBackgroundTab");
      }
      this.chrome = chromeApi;
      this.contextStore = contextStore;
      this.createBackgroundTab = createBackgroundTab;
    }

    async createGroup(params) {
      const beforeFocus = await this.#captureFocus();
      const windowId = await this.#resolveNormalWindow(params.windowId);
      let registeredSession = false;
      let seedTab = null;
      try {
        this.contextStore.registerSession({
          sessionId: params.sessionId,
          ownerId: params.ownerId,
          alias: params.alias,
          groupId: null,
          windowId,
          targetTabId: null,
          revision: 0,
          state: "CREATING",
        });
        registeredSession = true;
        if (params.expectedRevision !== 0) {
          throw new SessionTransactionError(
            "STALE_SESSION_REVISION",
            `Session ${params.sessionId} must start at revision 0`,
            { expectedRevision: params.expectedRevision, actualRevision: 0 },
          );
        }

        seedTab = await this.createBackgroundTab({
          url: "about:blank",
          windowId,
        });
        this.contextStore.registerTab(params.sessionId, seedTab.id, {
          state: "PENDING_GROUP",
          ownershipType: "seed",
        });

        const groupId = await this.chrome.tabs.group({
          tabIds: [seedTab.id],
          createProperties: { windowId },
        });
        await this.chrome.tabGroups.update(groupId, {
          title: params.title || params.alias || "Link2Chrome Session",
          color: params.color || "blue",
        });

        const actualTab = await this.chrome.tabs.get(seedTab.id);
        const actualGroup = await this.chrome.tabGroups.get(groupId);
        this.#assertGroupBinding({
          sessionId: params.sessionId,
          tabId: seedTab.id,
          groupId,
          windowId,
          actualTab,
          actualGroup,
        });

        this.contextStore.bindGroup(params.sessionId, {
          groupId,
          windowId,
          seedTabId: seedTab.id,
          revision: params.revision,
        });
        this.contextStore.activateTab(params.sessionId, seedTab.id);
        const afterFocus = await this.#captureFocus();
        this.#assertFocusPreserved(beforeFocus, afterFocus);

        return {
          sessionId: params.sessionId,
          groupId,
          windowId,
          tabId: seedTab.id,
          focusPreserved: true,
        };
      } catch (error) {
        if (seedTab?.id != null) {
          await this.chrome.tabs.remove(seedTab.id).catch(() => {});
        }
        if (registeredSession) {
          try {
            this.contextStore.closeSession(params.sessionId);
          } catch (_) {
            // The transaction is already rolling back; no guessed recovery.
          }
        }
        throw error;
      }
    }

    async createTab(params) {
      const session = this.contextStore.getSession(params.sessionId);
      if (session.revision !== params.expectedRevision) {
        throw new SessionTransactionError(
          "STALE_SESSION_REVISION",
          `Session ${params.sessionId} revision changed`,
          {
            sessionId: params.sessionId,
            expectedRevision: params.expectedRevision,
            actualRevision: session.revision,
          },
        );
      }
      if (session.state !== "ACTIVE" || session.groupId == null || session.windowId == null) {
        throw new SessionTransactionError(
          "INVALID_SESSION_STATE",
          `Session ${params.sessionId} has no active group`,
          { sessionId: params.sessionId, state: session.state },
        );
      }

      const beforeFocus = await this.#captureFocus();
      let newTab = null;
      try {
        newTab = await this.createBackgroundTab({
          url: params.url || "about:blank",
          windowId: session.windowId,
        });
        this.contextStore.registerTab(params.sessionId, newTab.id, {
          state: "PENDING_GROUP",
          ownershipType: params.ownershipType || "agent",
        });
        await this.chrome.tabs.group({
          tabIds: [newTab.id],
          groupId: session.groupId,
        });

        const actualTab = await this.chrome.tabs.get(newTab.id);
        const actualGroup = await this.chrome.tabGroups.get(session.groupId);
        this.#assertGroupBinding({
          sessionId: params.sessionId,
          tabId: newTab.id,
          groupId: session.groupId,
          windowId: session.windowId,
          actualTab,
          actualGroup,
        });

        this.contextStore.activateTab(params.sessionId, newTab.id);
        this.contextStore.setTarget(params.sessionId, newTab.id);
        this.contextStore.advanceRevision(
          params.sessionId,
          params.expectedRevision,
          params.revision,
        );
        const afterFocus = await this.#captureFocus();
        this.#assertFocusPreserved(beforeFocus, afterFocus);

        return {
          sessionId: params.sessionId,
          groupId: session.groupId,
          windowId: session.windowId,
          tabId: newTab.id,
          focusPreserved: true,
        };
      } catch (error) {
        if (newTab?.id != null) {
          try {
            this.contextStore.removeTab(params.sessionId, newTab.id);
          } catch (_) {
            // Preserve the original transaction error.
          }
          await this.chrome.tabs.remove(newTab.id).catch(() => {});
        }
        throw error;
      }
    }

    async #resolveNormalWindow(explicitWindowId) {
      if (Number.isInteger(explicitWindowId)) return explicitWindowId;
      const current = await this.chrome.windows.getLastFocused({
        windowTypes: ["normal"],
      });
      if (!current || current.type !== "normal" || !Number.isInteger(current.id)) {
        throw new SessionTransactionError(
          "NORMAL_WINDOW_NOT_FOUND",
          "No normal Chrome window is available for a Session group",
        );
      }
      return current.id;
    }

    async #captureFocus() {
      const windows = await this.chrome.windows.getAll({
        populate: true,
        windowTypes: ["normal"],
      });
      const activeTabByWindow = {};
      let focusedWindowId = null;
      for (const window of windows) {
        if (window.focused) focusedWindowId = window.id;
        const activeTab = (window.tabs || []).find((tab) => tab.active);
        activeTabByWindow[String(window.id)] = activeTab?.id ?? null;
      }
      return { focusedWindowId, activeTabByWindow };
    }

    #assertGroupBinding({
      sessionId, tabId, groupId, windowId, actualTab, actualGroup,
    }) {
      if (
        actualTab?.id !== tabId
        || actualTab.groupId !== groupId
        || actualTab.windowId !== windowId
        || actualGroup?.id !== groupId
        || actualGroup.windowId !== windowId
      ) {
        throw new SessionTransactionError(
          "GROUP_VERIFICATION_FAILED",
          `Chrome group verification failed for tab ${tabId}`,
          {
            sessionId,
            tabId,
            expectedGroupId: groupId,
            actualGroupId: actualTab?.groupId ?? null,
            expectedWindowId: windowId,
            actualWindowId: actualTab?.windowId ?? null,
          },
        );
      }
    }

    #assertFocusPreserved(before, after) {
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        throw new SessionTransactionError(
          "FOCUS_CHANGED_BY_AUTOMATION",
          "Session transaction changed the focused window or active tab",
          { before, after },
        );
      }
    }
  }

  return { SessionTransactionError, SessionTransactionManager };
});
