#!/usr/bin/env node
/**
 * Link2Chrome Node.js 环境检测脚本
 * 参考 Codex Chrome Plugin 的 check-extension-installed.js / check-native-host-manifest.js 设计
 *
 * 检测项：
 * 1. Node.js 版本 >= 18
 * 2. runtime 入口文件存在
 * 3. link2chrome-client.mjs 存在
 * 4. WebSocket 端口状态（Hub 是否运行）
 * 5. Extension WebSocket 端口状态
 *
 * 使用方式：
 *   node scripts/check-node-env.mjs
 *   node scripts/check-node-env.mjs --json
 */

import { execSync } from "child_process";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const JSON_MODE = process.argv.includes("--json");

const checks = {
  nodeVersion: {
    ok: false,
    required: ">= 18.0.0",
    actual: process.version,
    hint: "请安装 Node.js 18 或更高版本: https://nodejs.org/",
  },
  runtimeEntry: {
    ok: false,
    path: path.join(projectRoot, "runtime", "nodejs-playwright-runtime.mjs"),
    hint: "runtime/nodejs-playwright-runtime.mjs 不存在。请确认项目已完整克隆/安装。",
  },
  clientModule: {
    ok: false,
    path: path.join(projectRoot, "runtime", "link2chrome-client.mjs"),
    hint: "runtime/link2chrome-client.mjs 不存在。请确认项目已完整克隆/安装。",
  },
  hubPort: {
    ok: false,
    port: 8766,
    hint: "Browser Hub 未在 ws://localhost:8766 运行。请启动 MCP Server。",
  },
  extensionPort: {
    ok: false,
    port: 8765,
    hint: "Extension WebSocket Server 未在 ws://localhost:8765 运行。请确保 Extension 已连接。",
  },
};

function checkNodeVersion() {
  const major = parseInt(process.version.slice(1).split(".")[0], 10);
  checks.nodeVersion.ok = major >= 18;
}

function checkFiles() {
  checks.runtimeEntry.ok = fs.existsSync(checks.runtimeEntry.path);
  checks.clientModule.ok = fs.existsSync(checks.clientModule.path);
}

async function checkPort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (err) => {
      if (err.code === "EADDRINUSE") {
        resolve(true); // 端口被占用 = 服务在运行
      } else {
        resolve(false);
      }
    });
    server.once("listening", () => {
      server.close();
      resolve(false); // 端口空闲 = 服务未运行
    });
    server.listen(port, "127.0.0.1");
  });
}

async function runChecks() {
  checkNodeVersion();
  checkFiles();
  checks.hubPort.ok = await checkPort(checks.hubPort.port);
  checks.extensionPort.ok = await checkPort(checks.extensionPort.port);

  const allOk = Object.values(checks).every((c) => c.ok);

  if (JSON_MODE) {
    console.log(
      JSON.stringify(
        {
          ok: allOk,
          platform: process.platform,
          arch: process.arch,
          checks,
        },
        null,
        2
      )
    );
  } else {
    console.log("=== Link2Chrome Node.js 环境检测 ===\n");
    console.log(`平台: ${process.platform} (${process.arch})`);
    console.log(`Node.js: ${checks.nodeVersion.actual} ${checks.nodeVersion.ok ? "✅" : "❌"}`);
    console.log(`Runtime 入口: ${checks.runtimeEntry.ok ? "✅" : "❌"} ${checks.runtimeEntry.path}`);
    console.log(`Client 模块: ${checks.clientModule.ok ? "✅" : "❌"} ${checks.clientModule.path}`);
    console.log(
      `Hub 端口 (8766): ${checks.hubPort.ok ? "✅ 运行中" : "❌ 未运行"}`
    );
    console.log(
      `Extension 端口 (8765): ${checks.extensionPort.ok ? "✅ 运行中" : "❌ 未运行"}`
    );
    console.log("");

    if (allOk) {
      console.log("✅ 所有检测通过，Node.js Playwright Runtime 环境已就绪。");
    } else {
      console.log("❌ 部分检测未通过:\n");
      for (const [key, value] of Object.entries(checks)) {
        if (!value.ok && value.hint) {
          console.log(`  [${key}] ${value.hint}`);
        }
      }
    }
  }

  process.exit(allOk ? 0 : 1);
}

runChecks().catch((err) => {
  console.error("检测失败:", err.message);
  process.exit(2);
});
