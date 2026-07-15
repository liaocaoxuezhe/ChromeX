(function installSessionContext(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  root.Link2ChromeSessionContext = api;
})(typeof globalThis !== "undefined" ? globalThis : self, function createSessionContextApi() {
  "use strict";

  const TAB_STATE = Object.freeze({
    DISCOVERED: "DISCOVERED",
    PENDING_GROUP: "PENDING_GROUP",
    ACTIVE: "ACTIVE",
    QUARANTINED: "QUARANTINED",
    CLOSED: "CLOSED",
  });

  class SessionContextError extends Error {
    constructor(code, message, details = {}) {
      super(message);
      this.name = "SessionContextError";
      this.code = code;
      this.details = { ...details };
    }
  }

  class SessionContextStore {
    constructor() {
      this.sessions = new Map();
      this.tabs = new Map();
      this.groupOwners = new Map();
      this.tabOwners = new Map();
    }

    registerSession(input) {
      this.#requireText(input?.sessionId, "sessionId");
      if (this.sessions.has(input.sessionId)) {
        throw new SessionContextError(
          "SESSION_ALREADY_EXISTS",
          `Session ${input.sessionId} is already registered`,
          { sessionId: input.sessionId },
        );
      }
      if (input.groupId != null) {
        const owner = this.groupOwners.get(input.groupId);
        if (owner && owner !== input.sessionId) {
          throw new SessionContextError(
            "GROUP_ALREADY_OWNED",
            `group ${input.groupId} is already owned by another session`,
            { groupId: input.groupId, sessionId: owner },
          );
        }
      }

      const context = {
        sessionId: input.sessionId,
        ownerId: input.ownerId || null,
        alias: input.alias || input.sessionId,
        groupId: input.groupId ?? null,
        windowId: input.windowId ?? null,
        targetTabId: input.targetTabId ?? null,
        revision: this.#requireRevision(input.revision),
        state: input.state || "CREATING",
        tabIds: new Set(),
      };
      this.sessions.set(context.sessionId, context);
      if (context.groupId != null) {
        this.groupOwners.set(context.groupId, context.sessionId);
      }
      return this.#cloneSession(context);
    }

    bindGroup(sessionId, { groupId, windowId, seedTabId, revision }) {
      const session = this.#requireSession(sessionId);
      const owner = this.groupOwners.get(groupId);
      if (owner && owner !== sessionId) {
        throw new SessionContextError(
          "GROUP_ALREADY_OWNED",
          `group ${groupId} is already owned by another session`,
          { groupId, sessionId: owner },
        );
      }
      if (session.groupId != null && session.groupId !== groupId) {
        throw new SessionContextError(
          "SESSION_GROUP_IMMUTABLE",
          `Session ${sessionId} is already bound to group ${session.groupId}`,
          { sessionId, groupId: session.groupId },
        );
      }
      session.groupId = groupId;
      session.windowId = windowId;
      session.targetTabId = seedTabId;
      session.revision = this.#requireRevision(revision);
      session.state = "ACTIVE";
      this.groupOwners.set(groupId, sessionId);
      return this.#cloneSession(session);
    }

    registerTab(sessionId, tabId, options = {}) {
      const session = this.#requireSession(sessionId);
      this.#requireTabId(tabId);
      const owner = this.tabOwners.get(tabId);
      if (owner && owner !== sessionId) {
        throw new SessionContextError(
          "TAB_ALREADY_OWNED",
          `tab ${tabId} is already owned by another session`,
          { tabId, sessionId: owner },
        );
      }
      const existing = this.tabs.get(tabId);
      if (existing && owner === sessionId) {
        return { ...existing };
      }
      const tabContext = {
        tabId,
        sessionId,
        ownershipType: options.ownershipType || "agent",
        state: options.state || TAB_STATE.PENDING_GROUP,
        claimRestore: options.claimRestore ? { ...options.claimRestore } : null,
      };
      this.tabs.set(tabId, tabContext);
      this.tabOwners.set(tabId, sessionId);
      session.tabIds.add(tabId);
      return { ...tabContext };
    }

    activateTab(sessionId, tabId) {
      const session = this.#requireSession(sessionId);
      const tab = this.#requireOwnedTab(session, tabId);
      tab.state = TAB_STATE.ACTIVE;
      return { ...tab };
    }

    setTarget(sessionId, tabId) {
      const session = this.#requireSession(sessionId);
      const tab = this.#requireOwnedTab(session, tabId);
      if (tab.state !== TAB_STATE.ACTIVE) {
        throw new SessionContextError(
          "TAB_PENDING_GROUP",
          `tab ${tabId} is not active in its session group`,
          { tabId, sessionId, state: tab.state },
        );
      }
      session.targetTabId = tabId;
      return this.#cloneSession(session);
    }

    updateRevision(sessionId, revision) {
      const session = this.#requireSession(sessionId);
      session.revision = this.#requireRevision(revision);
      return this.#cloneSession(session);
    }

    advanceRevision(sessionId, expectedRevision, nextRevision) {
      const session = this.#requireSession(sessionId);
      if (session.revision !== expectedRevision) {
        throw new SessionContextError(
          "STALE_SESSION_REVISION",
          `Session ${session.alias} revision changed`,
          { sessionId, expectedRevision, actualRevision: session.revision },
        );
      }
      if (nextRevision !== expectedRevision + 1) {
        throw new SessionContextError(
          "INVALID_SESSION_REVISION",
          "Session revision must advance by exactly one",
          { sessionId, expectedRevision, nextRevision },
        );
      }
      session.revision = nextRevision;
      return this.#cloneSession(session);
    }

    bumpRevision(sessionId) {
      const session = this.#requireSession(sessionId);
      session.revision += 1;
      return this.#cloneSession(session);
    }

    restoreRevision(sessionId, expectedCurrentRevision, previousRevision) {
      const session = this.#requireSession(sessionId);
      if (
        session.revision !== expectedCurrentRevision
        || expectedCurrentRevision !== previousRevision + 1
      ) {
        throw new SessionContextError(
          "SESSION_ROLLBACK_CONFLICT",
          `Session ${session.alias} cannot restore revision safely`,
          {
            sessionId,
            expectedCurrentRevision,
            actualRevision: session.revision,
            previousRevision,
          },
        );
      }
      session.revision = previousRevision;
      return this.#cloneSession(session);
    }

    assertSessionTab(messageContext, actualTab) {
      const session = this.#requireSession(messageContext?.sessionId);
      const tabId = messageContext?.tabId;
      this.#requireTabId(tabId);
      if (messageContext.revision !== session.revision) {
        throw new SessionContextError(
          "STALE_SESSION_REVISION",
          `Session ${session.alias} revision changed`,
          {
            sessionId: session.sessionId,
            expectedRevision: messageContext.revision,
            actualRevision: session.revision,
          },
        );
      }
      if (messageContext.groupId !== session.groupId) {
        throw new SessionContextError(
          "GROUP_MISMATCH",
          `group ${messageContext.groupId} does not belong to session ${session.alias}`,
          {
            sessionId: session.sessionId,
            expectedGroupId: session.groupId,
            actualGroupId: messageContext.groupId,
          },
        );
      }
      const tab = this.#requireOwnedTab(session, tabId);
      if (tab.state !== TAB_STATE.ACTIVE) {
        throw new SessionContextError(
          "TAB_PENDING_GROUP",
          `tab ${tabId} is not active in its session group`,
          { tabId, sessionId: session.sessionId, state: tab.state },
        );
      }
      if (!actualTab || actualTab.id !== tabId) {
        throw new SessionContextError(
          "TAB_ID_MISMATCH",
          `Chrome returned a different tab for ${tabId}`,
          { tabId, actualTabId: actualTab?.id ?? null },
        );
      }
      if (actualTab.groupId !== session.groupId) {
        throw new SessionContextError(
          "GROUP_MISMATCH",
          `tab ${tabId} is outside session ${session.alias}`,
          {
            tabId,
            sessionId: session.sessionId,
            expectedGroupId: session.groupId,
            actualGroupId: actualTab.groupId,
          },
        );
      }
      if (actualTab.windowId !== session.windowId) {
        throw new SessionContextError(
          "WINDOW_MISMATCH",
          `tab ${tabId} is outside the Session window`,
          {
            tabId,
            sessionId: session.sessionId,
            expectedWindowId: session.windowId,
            actualWindowId: actualTab.windowId,
          },
        );
      }
      return { ...tab };
    }

    removeTab(sessionId, tabId) {
      const session = this.#requireSession(sessionId);
      if (this.tabOwners.get(tabId) !== sessionId) return false;
      this.tabOwners.delete(tabId);
      this.tabs.delete(tabId);
      session.tabIds.delete(tabId);
      if (session.targetTabId === tabId) {
        session.targetTabId = [...session.tabIds]
          .find((candidate) => this.tabs.get(candidate)?.state === TAB_STATE.ACTIVE) ?? null;
      }
      return true;
    }

    closeSession(sessionId) {
      const session = this.#requireSession(sessionId);
      for (const tabId of [...session.tabIds]) {
        this.tabOwners.delete(tabId);
        this.tabs.delete(tabId);
      }
      if (session.groupId != null && this.groupOwners.get(session.groupId) === sessionId) {
        this.groupOwners.delete(session.groupId);
      }
      this.sessions.delete(sessionId);
    }

    getSession(sessionId) {
      return this.#cloneSession(this.#requireSession(sessionId));
    }

    getTab(tabId) {
      const tab = this.tabs.get(tabId);
      return tab ? { ...tab } : null;
    }

    ownerOfGroup(groupId) {
      return this.groupOwners.get(groupId) || null;
    }

    ownerOfTab(tabId) {
      return this.tabOwners.get(tabId) || null;
    }

    snapshot() {
      return {
        sessions: [...this.sessions.values()].map((session) => ({
          ...this.#cloneSession(session),
          tabIds: [...session.tabIds].sort((a, b) => a - b),
        })),
        tabs: [...this.tabs.values()].map((tab) => ({ ...tab })),
      };
    }

    #requireSession(sessionId) {
      const session = this.sessions.get(sessionId);
      if (!session) {
        throw new SessionContextError(
          "SESSION_NOT_FOUND",
          `Session ${sessionId} is not registered in the Extension`,
          { sessionId },
        );
      }
      return session;
    }

    #requireOwnedTab(session, tabId) {
      if (this.tabOwners.get(tabId) !== session.sessionId) {
        throw new SessionContextError(
          "TAB_OUTSIDE_SESSION",
          `tab ${tabId} is outside session ${session.alias}`,
          { tabId, sessionId: session.sessionId },
        );
      }
      return this.tabs.get(tabId);
    }

    #cloneSession(session) {
      return { ...session, tabIds: new Set(session.tabIds) };
    }

    #requireText(value, field) {
      if (typeof value !== "string" || !value) {
        throw new SessionContextError(
          "INVALID_SESSION_CONTEXT",
          `Session context requires ${field}`,
          { field },
        );
      }
      return value;
    }

    #requireRevision(value) {
      if (!Number.isInteger(value) || value < 0) {
        throw new SessionContextError(
          "INVALID_SESSION_CONTEXT",
          "Session context requires a non-negative revision",
          { field: "revision" },
        );
      }
      return value;
    }

    #requireTabId(value) {
      if (!Number.isInteger(value)) {
        throw new SessionContextError(
          "INVALID_SESSION_CONTEXT",
          "Session context requires an integer tabId",
          { field: "tabId" },
        );
      }
      return value;
    }
  }

  return {
    SessionContextError,
    SessionContextStore,
    TAB_STATE,
  };
});
