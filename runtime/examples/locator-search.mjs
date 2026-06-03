import { createLink2ChromeClient, createWebSocketTransport } from "../link2chrome-client.mjs";

const link2chrome = createLink2ChromeClient({
  transport: createWebSocketTransport({ url: process.env.LINK2CHROME_WS_URL || "ws://localhost:8766" }),
});

const browser = await link2chrome.browsers.get("extension");
const tab = await browser.tabs.selected();

await tab.goto("https://www.google.com/search?q=Link2Chrome");
const input = tab.playwright.locator("textarea[name='q'], input[name='q']");
console.log("Search inputs:", await input.count());
await browser.tabs.finalize({ keep: [{ tab, status: "handoff" }] });
