const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const policy = require(path.join(root, "extension", "connection-policy.js"));

test("仅将服务端明确拒绝的重复扩展连接识别为待机冲突", () => {
  assert.equal(policy.isDuplicateConnectionClose({
    code: 1008,
    reason: "duplicate Link2Chrome extension connection",
  }), true);
  assert.equal(policy.isDuplicateConnectionClose({
    code: 1008,
    reason: "another policy error",
  }), false);
  assert.equal(policy.isDuplicateConnectionClose({
    code: 1006,
    reason: "duplicate Link2Chrome extension connection",
  }), false);
});

test("待机状态提供稳定且可手动恢复的 Popup 文案", () => {
  assert.deepEqual(policy.standbyDisplay(), {
    dotClass: "status-dot standby",
    statusText: "待机",
    statusDetail: "其他 Chrome 实例正在使用",
    reconnectDisabled: false,
    toggleHint: "可手动尝试接管",
  });
});

test("扩展后台接入冲突策略并阻止待机状态自动重连", () => {
  const source = fs.readFileSync(path.join(root, "extension", "background.js"), "utf8");

  assert.match(source, /importScripts\("connection-policy\.js"\)/);
  assert.match(source, /let connectionConflict = false/);
  assert.match(source, /isDuplicateConnectionClose\(event\)/);
  assert.match(source, /if \(connectionConflict\) return/);
  assert.match(source, /connectionConflict,/);
});

test("待机冲突跨 Service Worker 重启持久化", () => {
  const source = fs.readFileSync(path.join(root, "extension", "background.js"), "utf8");

  assert.match(source, /chrome\.storage\.local\.set\(\{ connectionConflict: true \}\)/);
  assert.match(source, /chrome\.storage\.local\.set\(\{ connectionConflict: false \}\)/);
  assert.match(source, /chrome\.storage\.local\.get\(\["connectionEnabled", "connectionConflict"\]/);
  assert.match(source, /connectionConflict = result\.connectionConflict === true/);
});

test("Popup 加载连接策略并渲染待机状态", () => {
  const html = fs.readFileSync(path.join(root, "extension", "popup.html"), "utf8");
  const source = fs.readFileSync(path.join(root, "extension", "popup.js"), "utf8");

  assert.match(html, /<script src="connection-policy\.js"><\/script>/);
  assert.match(html, /\.status-dot\.standby/);
  assert.match(source, /status\.connectionConflict/);
  assert.match(source, /standbyDisplay\(\)/);
});
