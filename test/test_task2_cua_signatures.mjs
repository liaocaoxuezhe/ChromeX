import { createLink2ChromeClient } from "../runtime/link2chrome-client.mjs";

function createMockTransport() {
  const commands = [];
  return {
    commands,
    async command(name, args = {}) {
      if (name === "browser_tabs_list") {
        return {
          tabs: [{
            id: "tab-1",
            url: "https://example.com",
            title: "Example",
            active: true,
          }],
        };
      }
      if (name === "browser_tab_info") {
        return {
          id: "tab-1",
          url: "https://example.com",
          title: "Example",
          active: true,
        };
      }
      commands.push({ name, args });
      return { ok: true };
    },
  };
}

function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${message}: expected ${e}, got ${a}`);
  }
}

function assertTrue(value, message) {
  if (!value) throw new Error(message || "Assertion failed");
}

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (error) {
    console.error(`✗ ${name}: ${error.message}`);
    failed++;
  }
}

async function main() {
  const mock = createMockTransport();
  const client = createLink2ChromeClient({ transport: mock });
  const browser = await client.browsers.get("extension");
  const tabs = await browser.tabs.list();
  const tab = tabs[0];

  // === 存在性断言 ===
  await test("CuaSurface has double_click", () => {
    assertTrue(typeof tab.cua.double_click === "function", "double_click missing");
  });
  await test("CuaSurface has keypress", () => {
    assertTrue(typeof tab.cua.keypress === "function", "keypress missing");
  });
  await test("DomCuaSurface has get_visible_dom", () => {
    assertTrue(typeof tab.dom_cua.get_visible_dom === "function", "get_visible_dom missing");
  });
  await test("DomCuaSurface has double_click", () => {
    assertTrue(typeof tab.dom_cua.double_click === "function", "dom_cua.double_click missing");
  });
  await test("DomCuaSurface has keypress", () => {
    assertTrue(typeof tab.dom_cua.keypress === "function", "dom_cua.keypress missing");
  });
  await test("DomCuaSurface has scroll", () => {
    assertTrue(typeof tab.dom_cua.scroll === "function", "dom_cua.scroll missing");
  });
  await test("DomCuaSurface has type", () => {
    assertTrue(typeof tab.dom_cua.type === "function", "dom_cua.type missing");
  });

  // === CUA click 等价性 ===
  await test("cua.click({x,y}) produces same command as cua.click(x,y)", async () => {
    mock.commands.length = 0;
    await tab.cua.click(10, 20);
    const cmd1 = mock.commands.pop();

    mock.commands.length = 0;
    await tab.cua.click({ x: 10, y: 20 });
    const cmd2 = mock.commands.pop();

    assertEqual(cmd1.name, "browser.cua.click", "command name mismatch");
    assertEqual(cmd2.name, "browser.cua.click", "command name mismatch");
    assertEqual(cmd1.args.x, 10, "x mismatch");
    assertEqual(cmd1.args.y, 20, "y mismatch");
    assertEqual(cmd2.args.x, 10, "x mismatch");
    assertEqual(cmd2.args.y, 20, "y mismatch");
  });

  await test("cua.click({x,y,button:3}) maps button to right", async () => {
    mock.commands.length = 0;
    await tab.cua.click({ x: 10, y: 20, button: 3 });
    const cmd = mock.commands.pop();
    assertEqual(cmd.args.button, "right", "button should map to 'right'");
    assertEqual(cmd.args.keypress, undefined, "keypress should be undefined");
  });

  await test("cua.click({x,y,button:2,keypress:['Shift']}) passes keypress", async () => {
    mock.commands.length = 0;
    await tab.cua.click({ x: 10, y: 20, button: 2, keypress: ["Shift"] });
    const cmd = mock.commands.pop();
    assertEqual(cmd.args.button, "middle", "button should map to 'middle'");
    assertEqual(cmd.args.keypress, ["Shift"], "keypress mismatch");
  });

  // === CUA double_click ===
  await test("cua.double_click({x,y}) sends browser.cua.double_click", async () => {
    mock.commands.length = 0;
    await tab.cua.double_click({ x: 5, y: 6 });
    const cmd = mock.commands.pop();
    assertEqual(cmd.name, "browser.cua.double_click", "command name mismatch");
    assertEqual(cmd.args.x, 5, "x mismatch");
    assertEqual(cmd.args.y, 6, "y mismatch");
  });

  await test("cua.doubleClick(x,y) sends browser.cua.double_click", async () => {
    mock.commands.length = 0;
    await tab.cua.doubleClick(7, 8);
    const cmd = mock.commands.pop();
    assertEqual(cmd.name, "browser.cua.double_click", "command name mismatch");
    assertEqual(cmd.args.x, 7, "x mismatch");
    assertEqual(cmd.args.y, 8, "y mismatch");
  });

  // === CUA keypress ===
  await test("cua.keypress({keys}) sends browser.cua.key with combo", async () => {
    mock.commands.length = 0;
    await tab.cua.keypress({ keys: ["Control", "A"] });
    const cmd = mock.commands.pop();
    assertEqual(cmd.name, "browser.cua.key", "command name mismatch");
    assertEqual(cmd.args.combo, "Control+A", "combo mismatch");
  });

  await test("cua.key(combo) sends browser.cua.key", async () => {
    mock.commands.length = 0;
    await tab.cua.key("Enter");
    const cmd = mock.commands.pop();
    assertEqual(cmd.name, "browser.cua.key", "command name mismatch");
    assertEqual(cmd.args.combo, "Enter", "combo mismatch");
  });

  // === CUA move ===
  await test("cua.move({x,y}) sends browser.cua.move", async () => {
    mock.commands.length = 0;
    await tab.cua.move({ x: 1, y: 2, keys: ["Shift"] });
    const cmd = mock.commands.pop();
    assertEqual(cmd.name, "browser.cua.move", "command name mismatch");
    assertEqual(cmd.args.x, 1, "x mismatch");
    assertEqual(cmd.args.y, 2, "y mismatch");
    assertEqual(cmd.args.keys, ["Shift"], "keys mismatch");
  });

  // === CUA scroll ===
  await test("cua.scroll({x,y,scrollX,scrollY}) maps correctly", async () => {
    mock.commands.length = 0;
    await tab.cua.scroll({ x: 10, y: 20, scrollX: 100, scrollY: 200, keypress: ["Alt"] });
    const cmd = mock.commands.pop();
    assertEqual(cmd.name, "browser.cua.scroll", "command name mismatch");
    assertEqual(cmd.args.x, 10, "x mismatch");
    assertEqual(cmd.args.y, 20, "y mismatch");
    assertEqual(cmd.args.dx, 100, "dx mismatch");
    assertEqual(cmd.args.dy, 200, "dy mismatch");
    assertEqual(cmd.args.keypress, ["Alt"], "keypress mismatch");
  });

  await test("cua.scroll(dx,dy) old signature works", async () => {
    mock.commands.length = 0;
    await tab.cua.scroll(50, 100);
    const cmd = mock.commands.pop();
    assertEqual(cmd.name, "browser.cua.scroll", "command name mismatch");
    assertEqual(cmd.args.dx, 50, "dx mismatch");
    assertEqual(cmd.args.dy, 100, "dy mismatch");
  });

  // === CUA type ===
  await test("cua.type({text}) sends browser.cua.type", async () => {
    mock.commands.length = 0;
    await tab.cua.type({ text: "hello" });
    const cmd = mock.commands.pop();
    assertEqual(cmd.name, "browser.cua.type", "command name mismatch");
    assertEqual(cmd.args.text, "hello", "text mismatch");
  });

  await test("cua.type(text) old signature works", async () => {
    mock.commands.length = 0;
    await tab.cua.type("world");
    const cmd = mock.commands.pop();
    assertEqual(cmd.name, "browser.cua.type", "command name mismatch");
    assertEqual(cmd.args.text, "world", "text mismatch");
  });

  // === CUA drag ===
  await test("cua.drag({path:2}) sends browser.cua.drag with start/end", async () => {
    mock.commands.length = 0;
    await tab.cua.drag({ path: [{ x: 1, y: 2 }, { x: 3, y: 4 }], keys: ["Shift"] });
    const cmd = mock.commands.pop();
    assertEqual(cmd.name, "browser.cua.drag", "command name mismatch");
    assertEqual(cmd.args.x1, 1, "x1 mismatch");
    assertEqual(cmd.args.y1, 2, "y1 mismatch");
    assertEqual(cmd.args.x2, 3, "x2 mismatch");
    assertEqual(cmd.args.y2, 4, "y2 mismatch");
    assertEqual(cmd.args.keys, ["Shift"], "keys mismatch");
    assertTrue(cmd.args.path === undefined, "path should not exist for 2-point path");
  });

  await test("cua.drag({path:3}) includes full path", async () => {
    mock.commands.length = 0;
    const path = [{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 6 }];
    await tab.cua.drag({ path });
    const cmd = mock.commands.pop();
    assertEqual(cmd.args.path, path, "path mismatch");
    assertEqual(cmd.args.x1, 1, "x1 mismatch");
    assertEqual(cmd.args.y2, 6, "y2 mismatch");
  });

  await test("cua.drag(x1,y1,x2,y2) old signature works", async () => {
    mock.commands.length = 0;
    await tab.cua.drag(1, 2, 3, 4);
    const cmd = mock.commands.pop();
    assertEqual(cmd.name, "browser.cua.drag", "command name mismatch");
    assertEqual(cmd.args.x1, 1, "x1 mismatch");
    assertEqual(cmd.args.y1, 2, "y1 mismatch");
    assertEqual(cmd.args.x2, 3, "x2 mismatch");
    assertEqual(cmd.args.y2, 4, "y2 mismatch");
  });

  // === DomCUA get_visible_dom ===
  await test("dom_cua.get_visible_dom() sends browser.dom.overview", async () => {
    mock.commands.length = 0;
    await tab.dom_cua.get_visible_dom();
    const cmd = mock.commands.pop();
    assertEqual(cmd.name, "browser.dom.overview", "command name mismatch");
  });

  await test("dom_cua.visibleDom() alias works", async () => {
    mock.commands.length = 0;
    await tab.dom_cua.visibleDom();
    const cmd = mock.commands.pop();
    assertEqual(cmd.name, "browser.dom.overview", "command name mismatch");
  });

  // === DomCUA click ===
  await test("dom_cua.click({node_id}) sends browser.dom.click with node_id target", async () => {
    mock.commands.length = 0;
    await tab.dom_cua.click({ node_id: "n123" });
    const cmd = mock.commands.pop();
    assertEqual(cmd.name, "browser.dom.click", "command name mismatch");
    assertEqual(cmd.args.target, { node_id: "n123" }, "target mismatch");
  });

  await test("dom_cua.click(target,options) old signature works", async () => {
    mock.commands.length = 0;
    await tab.dom_cua.click({ selector: "#btn" }, { safety: null });
    const cmd = mock.commands.pop();
    assertEqual(cmd.name, "browser.dom.click", "command name mismatch");
    assertEqual(cmd.args.target, { selector: "#btn" }, "target mismatch");
  });

  // === DomCUA double_click ===
  await test("dom_cua.double_click({node_id}) sends browser.dom.click with clickCount:2", async () => {
    mock.commands.length = 0;
    await tab.dom_cua.double_click({ node_id: "n456" });
    const cmd = mock.commands.pop();
    assertEqual(cmd.name, "browser.dom.click", "command name mismatch");
    assertEqual(cmd.args.target, { node_id: "n456" }, "target mismatch");
    assertEqual(cmd.args.clickCount, 2, "clickCount mismatch");
  });

  // === DomCUA keypress ===
  await test("dom_cua.keypress({keys}) sends browser.cua.key with combo", async () => {
    mock.commands.length = 0;
    await tab.dom_cua.keypress({ keys: ["Escape"] });
    const cmd = mock.commands.pop();
    assertEqual(cmd.name, "browser.cua.key", "command name mismatch");
    assertEqual(cmd.args.combo, "Escape", "combo mismatch");
  });

  // === DomCUA scroll ===
  await test("dom_cua.scroll({node_id,x,y}) sends script_evaluate", async () => {
    mock.commands.length = 0;
    await tab.dom_cua.scroll({ node_id: "n789", x: 10, y: 20 });
    const cmd = mock.commands.pop();
    assertEqual(cmd.name, "script_evaluate", "command name mismatch");
    assertTrue(cmd.args.script.includes("scrollBy"), "script should contain scrollBy");
    assertTrue(cmd.args.script.includes("n789"), "script should contain node_id");
  });

  await test("dom_cua.scroll({x,y}) without node_id sends browser.cua.scroll", async () => {
    mock.commands.length = 0;
    await tab.dom_cua.scroll({ x: 30, y: 40 });
    const cmd = mock.commands.pop();
    assertEqual(cmd.name, "browser.cua.scroll", "command name mismatch");
    assertEqual(cmd.args.dx, 30, "dx mismatch");
    assertEqual(cmd.args.dy, 40, "dy mismatch");
  });

  // === DomCUA type ===
  await test("dom_cua.type({text}) sends browser.cua.type", async () => {
    mock.commands.length = 0;
    await tab.dom_cua.type({ text: "hello dom" });
    const cmd = mock.commands.pop();
    assertEqual(cmd.name, "browser.cua.type", "command name mismatch");
    assertEqual(cmd.args.text, "hello dom", "text mismatch");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
