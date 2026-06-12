import { setupLink2ChromeRuntime } from "../link2chrome-client.mjs";

setupLink2ChromeRuntime({ globals: globalThis });

const readiness = await link2chrome.diagnostics.readiness();
if (!readiness.ok) {
  console.error("Link2Chrome is not ready:", readiness);
  process.exitCode = 1;
  process.exit();
}

const browser = await agent.browsers.get("extension");
await browser.nameSession("Link2Chrome runtime basic navigation");
const tabs = await browser.user.openTabs();
const existing = tabs.find((t) => (t.raw?.url || "").includes("example.com"));
const tab = existing ? await browser.user.claimTab(existing) : await browser.tabs.new("https://example.com");

await tab.goto("https://example.com");
await tab.waitFor({ condition: "dom-ready", timeout: 10000 });
const snapshot = await tab.playwright.domSnapshot();
console.log(snapshot);

const more = tab.playwright.getByText("More information");
console.log("More information matches:", await more.count());
await browser.tabs.finalize({ keep: [{ tab, status: "deliverable" }] });
