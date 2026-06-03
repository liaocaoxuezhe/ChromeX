import { setupLink2ChromeRuntime } from "../link2chrome-client.mjs";

setupLink2ChromeRuntime({ globals: globalThis });

const task = await link2chrome.tasks.run("Link2Chrome prepared task", `
const tab = await browser.tabs.selected();
await tab.goto("https://example.com");
await tab.waitFor({ condition: "dom-ready", timeout: 10000 });
return {
  title: (await tab.info()).title,
  tabId: tab.id,
  leaseToken: lease.lease_token,
};
`, {
  timeoutMs: 15000,
});

console.log(task.result);
