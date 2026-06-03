import { createLink2ChromeClient, createWebSocketTransport } from "../link2chrome-client.mjs";

const link2chrome = createLink2ChromeClient({
  transport: createWebSocketTransport({ url: process.env.LINK2CHROME_WS_URL || "ws://localhost:8766" }),
});

const diagnosis = await link2chrome.diagnose();
if (!diagnosis.ok || !diagnosis.hub?.extension_connected) {
  console.error("Link2Chrome is not ready:", diagnosis);
  process.exitCode = 1;
  process.exit();
}

const browser = await link2chrome.browsers.get("extension");
await browser.nameSession("Link2Chrome runtime basic navigation");
const tab = await browser.tabs.selected();

await tab.goto("https://example.com");
const snapshot = await tab.playwright.domSnapshot();
console.log(snapshot);

const more = tab.playwright.getByText("More information");
console.log("More information matches:", await more.count());
await browser.tabs.finalize({ keep: [{ tab, status: "deliverable" }] });
