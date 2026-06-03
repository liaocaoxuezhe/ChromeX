import { setupLink2ChromeRuntime } from "../link2chrome-client.mjs";

setupLink2ChromeRuntime({ globals: globalThis });

const browser = await agent.browsers.get("extension");
const tab = await browser.tabs.selected();

await tab.goto("https://www.google.com/search?q=Link2Chrome");
const input = tab.playwright.locator("textarea[name='q'], input[name='q']");
await input.waitFor({ state: "visible", timeout: 10000 });
console.log("Search inputs:", await input.count());
await browser.tabs.finalize({ keep: [{ tab, status: "handoff" }] });
