import assert from "node:assert/strict";
import test from "node:test";
import { createLink2ChromeClient } from "../runtime/link2chrome-client.mjs";

function fakeTransport() {
  const calls = [];
  return {
    calls,
    async command(name, args = {}) {
      calls.push({ name, args });
      if (name === "browser_session" && args.action === "create") {
        return { ok: true, session: args.session, groupId: 1, groupTitle: args.group_title };
      }
      if (name === "browser_tabs_list") {
        return { tabs: [{ id: 11, title: "Scoped", url: "https://example.com" }] };
      }
      if (name === "browser_session" && args.action === "claim") {
        return { ok: true, tabId: args.tabId };
      }
      if (name === "browser_session" && args.action === "finalize") {
        return { ok: true, closedTabIds: [], releasedTabIds: [] };
      }
      if (name === "browser_tab") {
        return { id: args.tabId ?? 11, title: "Scoped", url: "https://example.com" };
      }
      return { ok: true };
    },
  };
}

test("browser.nameSession creates server session and scopes tab listing", async () => {
  const transport = fakeTransport();
  const client = createLink2ChromeClient({ transport });
  const browser = await client.browsers.get("extension");

  await browser.nameSession("写报告", { groupTitle: "写报告" });
  await browser.tabs.list();

  assert.deepEqual(transport.calls[0], {
    name: "browser_session",
    args: { action: "create", session: "写报告", group_title: "写报告" },
  });
  assert.equal(transport.calls[1].name, "browser_tabs_list");
  assert.equal(transport.calls[1].args.session, "写报告");
});

test("claimTab and finalize use the active session", async () => {
  const transport = fakeTransport();
  const client = createLink2ChromeClient({ transport });
  const browser = await client.browsers.get("extension");

  await browser.nameSession("调研");
  await browser.user.claimTab({ id: 99 });
  await browser.tabs.finalize({ keep: [{ tabId: 99, status: "handoff" }] });

  assert.equal(transport.calls.some((call) =>
    call.name === "browser_session" &&
    call.args.action === "claim" &&
    call.args.session === "调研" &&
    call.args.tabId === 99
  ), true);
  assert.equal(transport.calls.some((call) =>
    call.name === "browser_session" &&
    call.args.action === "finalize" &&
    call.args.session === "调研"
  ), true);
});

test("claimTab sends claim token when present", async () => {
  const transport = fakeTransport();
  const client = createLink2ChromeClient({ transport });
  const browser = await client.browsers.get("extension");

  await browser.nameSession("接管页面");
  await browser.user.claimTab({ id: 88, claimToken: "token-88" });

  const claimCall = transport.calls.find((call) => call.name === "browser_session" && call.args.action === "claim");
  assert.equal(claimCall.args.claimToken, "token-88");
});

test("locked runtime session prevents nested nameSession from creating a second group", async () => {
  const transport = fakeTransport();
  const client = createLink2ChromeClient({ transport });
  const browser = await client.browsers.get("extension");

  browser._bindSession("outer-session", {
    session: "outer-session",
    groupId: 7,
    groupTitle: "Outer",
    allowedTabIds: [100],
    claimedTabIds: [],
    mode: "session",
  });
  const result = await browser.nameSession("inner-title");
  await browser.tabs.list();

  assert.equal(result.name, "outer-session");
  assert.equal(result.locked, true);
  assert.equal(transport.calls.some((call) => call.name === "browser_session" && call.args.action === "create"), false);
  assert.equal(transport.calls[0].name, "browser_tabs_list");
  assert.equal(transport.calls[0].args.session, "outer-session");
});
