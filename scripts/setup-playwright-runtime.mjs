#!/usr/bin/env node
/**
 * Link2Chrome Playwright Runtime 设置与诊断脚本
 * 参考 Codex Chrome Plugin 的 setup/install 脚本设计
 *
 * 职责：
 * 1. 运行环境检测（Node.js 版本、文件完整性）
 * 2. 检测 Browser Hub / Extension WebSocket 端口状态
 * 3. 输出诊断报告和修复建议
 *
 * 纯 Node.js 内置模块，不依赖外部 npm 包。
 *
 * 使用方式：
 *   node scripts/setup-playwright-runtime.mjs
 *   node scripts/setup-playwright-runtime.mjs --json
 */

import fs from "fs";
import net from "net";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const JSON_MODE = process.argv.includes("--json");

const HUB_PORT = 8766;
const EXTENSION_PORT = 8765;

// ─── 工具函数 ───────────────────────────────────────────

function checkNodeVersion() {
  const major = parseInt(process.version.slice(1).split(".")[0], 10);
  return { ok: major >= 18, actual: process.version, required: ">= 18.0.0" };
}

function checkFile(relativePath) {
  const full = path.join(projectRoot, relativePath);
  return { ok: fs.existsSync(full), path: full };
}

async function checkPortListening(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (err) => {
      if (err.code === "EADDRINUSE") {
        resolve({ open: false, inUse: true });
      } else {
        resolve({ open: false, inUse: false, error: err.message });
      }
    });
    server.once("listening", () => {
      server.close();
      resolve({ open: true, inUse: false });
    });
    server.listen(port, "127.0.0.1");
  });
}

async function attemptConnect(port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ ok: false, error: "connect timeout" });
    }, timeoutMs);

    socket.connect(port, "127.0.0.1", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ ok: true });
    });

    socket.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message });
    });
  });
}

// ─── 主流程 ─────────────────────────────────────────────

async function main() {
  const nodeCheck = checkNodeVersion();
  const runtimeEntry = checkFile("runtime/nodejs-playwright-runtime.mjs");
  const clientModule = checkFile("runtime/link2chrome-client.mjs");

  const hubPortCheck = await checkPortListening(HUB_PORT);
  const extPortCheck = await checkPortListening(EXTENSION_PORT);

  let hubConnect = { ok: false, skipped: true };
  let extConnect = { ok: false, skipped: true };

  if (hubPortCheck.inUse) {
    hubConnect = await attemptConnect(HUB_PORT);
  }
  if (extPortCheck.inUse) {
    extConnect = await attemptConnect(EXTENSION_PORT);
  }

  const report = {
    ok:
      nodeCheck.ok &&
      runtimeEntry.ok &&
      clientModule.ok &&
      hubPortCheck.inUse &&
      extPortCheck.inUse &&
      hubConnect.ok &&
      extConnect.ok,
    platform: process.platform,
    arch: process.arch,
    node: nodeCheck,
    files: { runtimeEntry, clientModule },
    ports: {
      hub: {
        port: HUB_PORT,
        listening: hubPortCheck.inUse,
        connectable: hubConnect.ok,
      },
      extension: {
        port: EXTENSION_PORT,
        listening: extPortCheck.inUse,
        connectable: extConnect.ok,
      },
    },
    recommendations: [],
  };

  if (!nodeCheck.ok) {
    report.recommendations.push(
      "[Node.js] 未安装或版本过低。请访问 https://nodejs.org/ 安装 Node.js 18+。"
    );
  }
  if (!runtimeEntry.ok || !clientModule.ok) {
    report.recommendations.push(
      "[文件] runtime 模块缺失。请确认项目已完整克隆，且 runtime/ 目录存在。"
    );
  }
  if (!hubPortCheck.inUse) {
    report.recommendations.push(
      "[Hub] Browser Hub 未启动。请运行 MCP Server: python -m server.main"
    );
  } else if (!hubConnect.ok) {
    report.recommendations.push(
      "[Hub] 端口被占用但 TCP 连接失败。请检查是否有僵尸进程占用 8766。"
    );
  }
  if (!extPortCheck.inUse) {
    report.recommendations.push(
      "[Extension] Extension WebSocket 未连接。请确认 Chrome Extension 已加载并启用。"
    );
  } else if (!extConnect.ok) {
    report.recommendations.push(
      "[Extension] 端口被占用但 TCP 连接失败。请尝试刷新扩展或重启 Chrome。"
    );
  }

  if (JSON_MODE) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log("=== Link2Chrome Playwright Runtime 诊断 ===\n");
    console.log(`平台: ${report.platform} (${report.arch})`);
    console.log(
      `Node.js: ${nodeCheck.actual} ${nodeCheck.ok ? "✅" : "❌"} (需要 ${nodeCheck.required})`
    );
    console.log(`Runtime 入口: ${runtimeEntry.ok ? "✅" : "❌"} ${runtimeEntry.path}`);
    console.log(`Client 模块: ${clientModule.ok ? "✅" : "❌"} ${clientModule.path}`);
    console.log(
      `Hub (:${HUB_PORT}): ${hubPortCheck.inUse ? "端口占用" : "空闲"} / TCP${hubConnect.ok ? "✅" : "❌"}`
    );
    console.log(
      `Extension (:${EXTENSION_PORT}): ${extPortCheck.inUse ? "端口占用" : "空闲"} / TCP${extConnect.ok ? "✅" : "❌"}`
    );

    if (report.recommendations.length > 0) {
      console.log(`\n修复建议:`);
      for (const rec of report.recommendations) {
        console.log(`  • ${rec}`);
      }
    } else {
      console.log("\n✅ 所有检查通过，Playwright Runtime 环境已就绪。");
    }
  }

  process.exit(report.ok ? 0 : 1);
}

main().catch((err) => {
  console.error("诊断失败:", err.message);
  process.exit(2);
});
