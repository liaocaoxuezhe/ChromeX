import { setupLink2ChromeRuntime } from "../link2chrome-client.mjs";

setupLink2ChromeRuntime({ globals: globalThis });

const readiness = await link2chrome.diagnostics.readiness();
if (!readiness.ok) {
  console.error("Link2Chrome is not ready:", readiness);
  process.exitCode = 1;
  process.exit();
}

const result = await link2chrome.scripts.run(`
await browser.nameSession("Link2Chrome model-authored script");
const tab = await browser.tabs.selected();
await tab.goto("https://example.com");
await tab.waitFor({ condition: "dom-ready", timeout: 10000 });
const snapshot = await tab.playwright.domSnapshot();
return {
  title: (await tab.info()).title,
  hasMoreInformation: snapshot.includes("More information"),
};
`, { sessionName: "model-authored script" });

console.log(result);
