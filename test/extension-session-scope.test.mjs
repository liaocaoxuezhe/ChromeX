import assert from "node:assert/strict";
import test from "node:test";

function isAllowedByScope(tab, scope) {
  if (!scope || scope.mode !== "session") return false;
  if (Array.isArray(scope.allowedTabIds) && scope.allowedTabIds.includes(tab.id)) return true;
  if (scope.groupId !== undefined && scope.groupId !== null && tab.groupId === scope.groupId) return true;
  return false;
}

test("scope allows tabs in explicit allowedTabIds", () => {
  assert.equal(isAllowedByScope({ id: 5, groupId: -1 }, { mode: "session", allowedTabIds: [5], groupId: 9 }), true);
});

test("scope allows tabs in group", () => {
  assert.equal(isAllowedByScope({ id: 6, groupId: 9 }, { mode: "session", allowedTabIds: [], groupId: 9 }), true);
});

test("scope denies tabs outside session", () => {
  assert.equal(isAllowedByScope({ id: 7, groupId: 3 }, { mode: "session", allowedTabIds: [5], groupId: 9 }), false);
});
