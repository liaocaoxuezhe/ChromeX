(function installClaimManager(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.Link2ChromeClaimManager = api;
})(typeof globalThis !== "undefined" ? globalThis : self, function createClaimManagerApi() {
  "use strict";

  class SessionClaimError extends Error {
    constructor(code, message, details = {}) {
      super(message);
      this.name = "SessionClaimError";
      this.code = code;
      this.details = details;
    }
  }

  class SessionClaimManager {
    constructor({ chromeApi, contextStore }) {
      this.chrome = chromeApi;
      this.contextStore = contextStore;
    }

    async claim({ sessionId, tabId, expectedRevision, revision }) {
      const session = this.contextStore.getSession(sessionId);
      if (session.revision !== expectedRevision) {
        throw new SessionClaimError("STALE_SESSION_REVISION", `Session ${sessionId} revision changed`, {
          sessionId, expectedRevision, actualRevision: session.revision,
        });
      }
      const owner = this.contextStore.ownerOfTab(tabId);
      if (owner && owner !== sessionId) {
        throw new SessionClaimError("TAB_ALREADY_OWNED", `tab ${tabId} belongs to ${owner}`, { tabId, owner });
      }
      const [tab, focusedWindow] = await Promise.all([
        this.chrome.tabs.get(tabId),
        this.chrome.windows.getLastFocused(),
      ]);
      if (tab.windowId !== session.windowId) {
        throw new SessionClaimError(
          "CLAIM_WOULD_CHANGE_FOCUS",
          `claiming tab ${tabId} across windows is not focus-safe`,
          { tabId, windowId: tab.windowId, sessionWindowId: session.windowId },
        );
      }
      const restore = {
        windowId: tab.windowId,
        groupId: tab.groupId,
        index: tab.index,
        active: tab.active === true,
        focusedWindowId: focusedWindow?.id ?? null,
      };
      this.contextStore.registerTab(sessionId, tabId, {
        state: "PENDING_GROUP",
        ownershipType: "claimed",
        claimRestore: restore,
      });
      try {
        await this.chrome.tabs.group({ groupId: session.groupId, tabIds: [tabId] });
        const [actual, focusedAfter] = await Promise.all([
          this.chrome.tabs.get(tabId),
          this.chrome.windows.getLastFocused(),
        ]);
        if (actual.groupId !== session.groupId || actual.windowId !== session.windowId) {
          throw new SessionClaimError("CLAIM_RESTORE_CONFLICT", "claimed tab did not enter the Session group", { tabId });
        }
        if (focusedAfter?.id !== restore.focusedWindowId) {
          throw new SessionClaimError("CLAIM_WOULD_CHANGE_FOCUS", "claim changed the focused window", { tabId });
        }
        this.contextStore.activateTab(sessionId, tabId);
        if (Number.isInteger(revision)) {
          this.contextStore.advanceRevision(sessionId, expectedRevision, revision);
        }
        return { ok: true, sessionId, tabId, groupId: session.groupId, restore };
      } catch (error) {
        this.contextStore.removeTab(sessionId, tabId);
        await this.#restore(tabId, restore).catch(() => {});
        throw error;
      }
    }

    async release({ sessionId, tabId, expectedRevision, revision }) {
      const session = this.contextStore.getSession(sessionId);
      if (Number.isInteger(expectedRevision) && session.revision !== expectedRevision) {
        throw new SessionClaimError("STALE_SESSION_REVISION", `Session ${sessionId} revision changed`, {
          sessionId, expectedRevision, actualRevision: session.revision,
        });
      }
      const tabContext = this.contextStore.getTab(tabId);
      if (!tabContext || tabContext.sessionId !== sessionId || tabContext.ownershipType !== "claimed") {
        throw new SessionClaimError("TAB_NOT_CLAIMED", `tab ${tabId} is not claimed by ${sessionId}`, { tabId, sessionId });
      }
      const focusedBefore = await this.chrome.windows.getLastFocused();
      try {
        await this.#restore(tabId, tabContext.claimRestore || {});
        const focusedAfter = await this.chrome.windows.getLastFocused();
        if (focusedAfter?.id !== focusedBefore?.id) {
          throw new SessionClaimError("CLAIM_RESTORE_CONFLICT", "release changed the focused window", { tabId });
        }
        if (Number.isInteger(revision)) {
          this.contextStore.advanceRevision(sessionId, expectedRevision, revision);
        }
        this.contextStore.removeTab(sessionId, tabId);
        return { ok: true, sessionId, tabId, restored: tabContext.claimRestore || {} };
      } catch (error) {
        await this.chrome.tabs.group({ groupId: session.groupId, tabIds: [tabId] }).catch(() => {});
        throw error;
      }
    }

    async abortClaim({ sessionId, tabId, expectedRevision, revision }) {
      const tabContext = this.contextStore.getTab(tabId);
      if (!tabContext || tabContext.sessionId !== sessionId || tabContext.ownershipType !== "claimed") {
        throw new SessionClaimError("SESSION_ROLLBACK_CONFLICT", `claim ${tabId} is not available to abort`, { sessionId, tabId });
      }
      await this.#restore(tabId, tabContext.claimRestore || {});
      this.contextStore.removeTab(sessionId, tabId);
      this.contextStore.restoreRevision(sessionId, expectedRevision, revision);
      return { ok: true, sessionId, tabId, aborted: "claim" };
    }

    async abortRelease({ sessionId, tabId, restore, expectedRevision, revision }) {
      const session = this.contextStore.getSession(sessionId);
      if (this.contextStore.ownerOfTab(tabId)) {
        throw new SessionClaimError("SESSION_ROLLBACK_CONFLICT", `tab ${tabId} already has an owner`, { sessionId, tabId });
      }
      this.contextStore.registerTab(sessionId, tabId, {
        state: "PENDING_GROUP",
        ownershipType: "claimed",
        claimRestore: restore || {},
      });
      try {
        await this.chrome.tabs.group({ groupId: session.groupId, tabIds: [tabId] });
        const actual = await this.chrome.tabs.get(tabId);
        if (actual.groupId !== session.groupId || actual.windowId !== session.windowId) {
          throw new SessionClaimError("SESSION_ROLLBACK_CONFLICT", "released tab could not re-enter Session group", { sessionId, tabId });
        }
        this.contextStore.activateTab(sessionId, tabId);
        this.contextStore.restoreRevision(sessionId, expectedRevision, revision);
        return { ok: true, sessionId, tabId, aborted: "release" };
      } catch (error) {
        this.contextStore.removeTab(sessionId, tabId);
        throw error;
      }
    }

    async #restore(tabId, restore) {
      if (Number.isInteger(restore.groupId) && restore.groupId >= 0) {
        const group = await this.chrome.tabGroups.get(restore.groupId).catch(() => null);
        if (group) {
          await this.chrome.tabs.group({ groupId: restore.groupId, tabIds: [tabId] });
          const actual = await this.chrome.tabs.get(tabId);
          if (Number.isInteger(restore.index) && actual.index !== restore.index) {
            await this.chrome.tabs.move(tabId, { windowId: actual.windowId, index: restore.index });
          }
          return;
        }
      }
      await this.chrome.tabs.ungroup([tabId]).catch(() => {});
      const actual = await this.chrome.tabs.get(tabId);
      if (Number.isInteger(restore.windowId) &&
          (actual.windowId !== restore.windowId || actual.index !== restore.index)) {
        const window = await this.chrome.windows.get(restore.windowId).catch(() => null);
        if (window) {
          await this.chrome.tabs.move(tabId, { windowId: restore.windowId, index: restore.index ?? -1 });
        }
      }
    }
  }

  return { SessionClaimError, SessionClaimManager };
});
