import { setupLink2ChromeRuntime } from "../link2chrome-client.mjs";

setupLink2ChromeRuntime({ globals: globalThis });

const browser = await agent.browsers.get("extension");
await browser.nameSession("Link2Chrome locator search");
const tabs = await browser.user.openTabs();
const existing = tabs.find((t) => (t.raw?.url || "").includes("google.com/search"));
const tab = existing ? await browser.user.claimTab(existing) : await browser.tabs.new("https://www.google.com/search?q=Link2Chrome");

await tab.goto("https://www.google.com/search?q=Link2Chrome");
const input = tab.playwright.locator("textarea[name='q'], input[name='q']");
await input.waitFor({ state: "visible", timeout: 10000 });
console.log("Search inputs:", await input.count());
await browser.tabs.finalize({ keep: [{ tab, status: "handoff" }] });
