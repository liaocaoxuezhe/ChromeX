(function installPopupOwnership(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.Link2ChromePopupOwnership = api;
})(typeof globalThis !== "undefined" ? globalThis : self, function createPopupOwnershipApi() {
  "use strict";

  class PopupOwnershipManager {
    constructor({ chromeApi, contextStore, emitEvent = () => {} }) {
      this.chrome = chromeApi;
      this.contextStore = contextStore;
      this.emitEvent = emitEvent;
      this.records = new Map();
      this.sequence = 0;
    }

    async handleCreated(createdTab) {
      const operationId = `popup-${Date.now()}-${++this.sequence}`;
      const record = {
        operationId,
        tabId: createdTab?.id ?? null,
        openerTabId: createdTab?.openerTabId ?? null,
        state: "DISCOVERED",
        pageActivated: createdTab?.active === true,
      };
      if (Number.isInteger(record.tabId)) this.records.set(record.tabId, record);

      if (!Number.isInteger(record.tabId) || !Number.isInteger(record.openerTabId)) {
        return this.#quarantine(record, "MISSING_OPENER");
      }
      const sessionId = this.contextStore.ownerOfTab(record.openerTabId);
      if (!sessionId) return this.#quarantine(record, "UNKNOWN_OPENER");

      const session = this.contextStore.getSession(sessionId);
      if (createdTab.windowId !== session.windowId) {
        return this.#quarantine(record, "CROSS_WINDOW_POPUP");
      }

      record.sessionId = sessionId;
      record.groupId = session.groupId;
      record.state = "PENDING_GROUP";
      this.contextStore.registerTab(sessionId, record.tabId, {
        state: "PENDING_GROUP",
        ownershipType: "popup",
      });

      try {
        await this.chrome.tabs.group({ groupId: session.groupId, tabIds: [record.tabId] });
        const [actualTab, actualOpener] = await Promise.all([
          this.chrome.tabs.get(record.tabId),
          this.chrome.tabs.get(record.openerTabId).catch(() => null),
        ]);
        const openerStillOwned = actualOpener && this.contextStore.ownerOfTab(record.openerTabId) === sessionId;
        if (!openerStillOwned) throw new Error("POPUP_OPENER_LOST");
        if (actualTab.groupId !== session.groupId || actualTab.windowId !== session.windowId) {
          throw new Error("POPUP_GROUP_VERIFY_FAILED");
        }
        this.contextStore.activateTab(sessionId, record.tabId);
        const revised = this.contextStore.bumpRevision(sessionId);
        record.state = "ACTIVE";
        await this.emitEvent({
          type: "session_tab_discovered",
          operationId,
          sessionId,
          tabId: record.tabId,
          openerTabId: record.openerTabId,
          groupId: session.groupId,
          windowId: session.windowId,
          pageActivated: record.pageActivated,
          revision: revised.revision,
        });
        return { ...record };
      } catch (error) {
        this.contextStore.removeTab(sessionId, record.tabId);
        await this.chrome.tabs.ungroup([record.tabId]).catch(() => {});
        return this.#quarantine(record, error.message || "POPUP_GROUP_FAILED");
      }
    }

    close(tabId) {
      const record = this.records.get(tabId);
      if (!record) return false;
      record.state = "CLOSED";
      return true;
    }

    snapshot() {
      return [...this.records.values()].map((record) => ({ ...record }));
    }

    #quarantine(record, reason) {
      record.state = "QUARANTINED";
      record.reason = reason;
      return { ...record };
    }
  }

  return { PopupOwnershipManager };
});
