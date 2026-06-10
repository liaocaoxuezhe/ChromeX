#!/usr/bin/env node
/**
 * Link2Chrome Playwright Runtime 设置与诊断脚本
 * 参考 Codex Chrome Plugin 的 setup/install 脚本设计
 *
 * 职责：
 * 1. 运行环境检测（Node.js 版本、文件完整性）
 * 2. 检测 Browser Hub / Extension WebSocket 端口状态
 * 3. 尝试连接 Browser Hub 并发送 __hub_status__ 命令查询状态
 * 4. 检查 Extension 是否已连接到 Hub
 * 5. 输出诊断报告和修复建议
 *
 * 纯 Node.js 内置模块，不依赖外部 npm 包。
 *
 * 使用方式：
 *   node scripts/setup-playwright-runtime.mjs
 *   node scripts/setup-playwright-runtime.mjs --json
 */

import crypto from "crypto";
import fs from "fs";
import net from "net";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const JSON_MODE = process.argv.includes("--json");

const HUB_PORT = 8766;
const EXTENSION_PORT = 8765;
const HUB_WS_URL = `ws://localhost:${HUB_PORT}`;

// ─── 工具函数 ───────────────────────────────────────────

function checkNodeVersion() {
  const major = parseInt(process.version.slice(1).split(".")[0], 10);
  return { ok: major >= 18, actual: process.version, required: ">= 18.0.0" };
}

function checkFile(relativePath) {
  const full = path.join(projectRoot, relativePath);
  return { ok: fs.existsSync(full), path: full };
}

/**
 * 使用 net.connect 检测端口是否可连通。
 * 连接成功 → 端口被占用（服务在运行）
 * ECONNREFUSED → 端口未运行
 */
async function checkPortConnectable(port, timeoutMs = 2000) {
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
      socket.destroy();
      resolve({ ok: false, error: err.message });
    });
  });
}

/**
 * 构建 WebSocket 文本帧（客户端 → 服务器，带 mask）。
 */
function buildWebSocketTextFrame(payload) {
  const payloadBuf = Buffer.from(payload, "utf8");
  const len = payloadBuf.length;
  const mask = crypto.randomBytes(4);

  let frame;
  if (len < 126) {
    frame = Buffer.allocUnsafe(6 + len);
    frame[0] = 0x81; // FIN=1, opcode=text
    frame[1] = 0x80 | len; // MASK=1, length
    mask.copy(frame, 2);
    for (let i = 0; i < len; i++) {
      frame[6 + i] = payloadBuf[i] ^ mask[i % 4];
    }
  } else if (len < 65536) {
    frame = Buffer.allocUnsafe(8 + len);
    frame[0] = 0x81;
    frame[1] = 0x80 | 126;
    frame.writeUInt16BE(len, 2);
    mask.copy(frame, 4);
    for (let i = 0; i < len; i++) {
      frame[8 + i] = payloadBuf[i] ^ mask[i % 4];
    }
  } else {
    // 超长 payload，理论上不会发生
    frame = Buffer.allocUnsafe(14 + len);
    frame[0] = 0x81;
    frame[1] = 0x80 | 127;
    frame.writeBigUInt64BE(BigInt(len), 2);
    mask.copy(frame, 10);
    for (let i = 0; i < len; i++) {
      frame[14 + i] = payloadBuf[i] ^ mask[i % 4];
    }
  }
  return frame;
}

/**
 * 解析 WebSocket 数据帧（服务器 → 客户端，不带 mask）。
 * 返回 { payload: string, remainder: Buffer } 或 null（数据不足）。
 */
function parseWebSocketFrame(buffer) {
  if (buffer.length < 2) return null;

  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let len = buffer[1] & 0x7f;
  let offset = 2;

  if (len === 126) {
    if (buffer.length < 4) return null;
    len = buffer.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buffer.length < 10) return null;
    len = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }

  if (masked) {
    if (buffer.length < offset + 4) return null;
    const maskKey = buffer.slice(offset, offset + 4);
    offset += 4;
    if (buffer.length < offset + len) return null;
    const maskedPayload = buffer.slice(offset, offset + len);
    const payload = Buffer.alloc(len);
    for (let i = 0; i < len; i++) {
      payload[i] = maskedPayload[i] ^ maskKey[i % 4];
    }
    return {
      opcode,
      payload: payload.toString("utf8"),
      remainder: buffer.slice(offset + len),
    };
  } else {
    if (buffer.length < offset + len) return null;
    const payload = buffer.slice(offset, offset + len);
    return {
      opcode,
      payload: payload.toString("utf8"),
      remainder: buffer.slice(offset + len),
    };
  }
}

/**
 * 通过原始 TCP socket 与 Browser Hub 建立 WebSocket 连接，
 * 发送 __hub_status__ 命令并解析返回结果。
 *
 * 使用 Node.js 内置 net + crypto 模块，零外部依赖。
 */
async function queryHubStatus(port, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ ok: false, error: "WebSocket handshake timeout" });
    }, timeoutMs);

    let state = "handshake"; // handshake -> connected -> done
    let buffer = Buffer.alloc(0);
    let handshakeBuffer = "";

    socket.connect(port, "127.0.0.1");

    socket.on("connect", () => {
      const key = crypto.randomBytes(16).toString("base64");
      const request = [
        `GET / HTTP/1.1`,
        `Host: localhost:${port}`,
        `Upgrade: websocket`,
        `Connection: Upgrade`,
        `Sec-WebSocket-Key: ${key}`,
        `Sec-WebSocket-Version: 13`,
        ``,
        ``,
      ].join("\r\n");
      socket.write(request);
    });

    socket.on("data", (chunk) => {
      if (state === "handshake") {
        handshakeBuffer += chunk.toString("utf8");
        const headerEnd = handshakeBuffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;

        const headers = handshakeBuffer.slice(0, headerEnd);
        const remainder = handshakeBuffer.slice(headerEnd + 4);

        if (!headers.includes("101") || !headers.includes("Switching Protocols")) {
          clearTimeout(timer);
          socket.destroy();
          resolve({ ok: false, error: "Hub did not accept WebSocket upgrade" });
          return;
        }

        state = "connected";
        if (remainder.length > 0) {
          buffer = Buffer.from(remainder, "utf8");
        }

        // 发送 __hub_status__ 命令
        const command = JSON.stringify({
          request_id: `setup-${Date.now()}`,
          command: "__hub_status__",
          params: {},
        });
        socket.write(buildWebSocketTextFrame(command));
        return;
      }

      if (state === "connected") {
        buffer = Buffer.concat([buffer, chunk]);
        const frame = parseWebSocketFrame(buffer);
        if (!frame) return; // 数据不足，继续等待

        clearTimeout(timer);
        socket.destroy();

        if (frame.opcode === 0x08) {
          // Close frame
          resolve({ ok: false, error: "Hub closed connection" });
          return;
        }

        try {
          const response = JSON.parse(frame.payload);
          if (response.success === false) {
            resolve({
              ok: false,
              error: response.error || "Hub command failed",
            });
            return;
          }
          resolve({ ok: true, data: response.data || {} });
        } catch (err) {
          resolve({ ok: false, error: `Invalid JSON response: ${err.message}` });
        }
      }
    });

    socket.on("error", (err) => {
      clearTimeout(timer);
      socket.destroy();
      if (err.code === "ECONNREFUSED") {
        resolve({ ok: false, error: "Browser Hub 未启动 (ECONNREFUSED)" });
      } else {
        resolve({ ok: false, error: err.message });
      }
    });

    socket.on("close", () => {
      clearTimeout(timer);
      if (state !== "done") {
        resolve({ ok: false, error: "Connection closed unexpectedly" });
      }
    });
  });
}

// ─── 主流程 ─────────────────────────────────────────────

async function main() {
  const nodeCheck = checkNodeVersion();
  const runtimeEntry = checkFile("runtime/nodejs-playwright-runtime.mjs");
  const clientModule = checkFile("runtime/link2chrome-client.mjs");

  const hubPortCheck = await checkPortConnectable(HUB_PORT);
  const extPortCheck = await checkPortConnectable(EXTENSION_PORT);

  let hubStatus = { ok: false, skipped: true, data: {} };
  let extConnected = false;

  if (hubPortCheck.ok) {
    hubStatus = await queryHubStatus(HUB_PORT);
    if (hubStatus.ok && hubStatus.data) {
      extConnected = Boolean(hubStatus.data.extension_connected);
    }
  }

  const report = {
    ok:
      nodeCheck.ok &&
      runtimeEntry.ok &&
      clientModule.ok &&
      hubPortCheck.ok &&
      extPortCheck.ok &&
      hubStatus.ok &&
      extConnected,
    platform: process.platform,
    arch: process.arch,
    node: nodeCheck,
    files: { runtimeEntry, clientModule },
    ports: {
      hub: {
        port: HUB_PORT,
        connectable: hubPortCheck.ok,
        status: hubStatus.ok ? hubStatus.data : null,
        error: hubStatus.error || null,
      },
      extension: {
        port: EXTENSION_PORT,
        connectable: extPortCheck.ok,
        error: extPortCheck.error || null,
      },
    },
    extensionConnected: extConnected,
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
  if (!hubPortCheck.ok) {
    report.recommendations.push(
      "[Hub] Browser Hub 未启动。请运行 MCP Server: python -m server.main"
    );
  } else if (!hubStatus.ok) {
    report.recommendations.push(
      `[Hub] 端口可连通但 WebSocket 握手失败: ${hubStatus.error}。请检查是否有僵尸进程占用 ${HUB_PORT}。`
    );
  } else if (!extConnected) {
    report.recommendations.push(
      "[Extension] Extension 未连接到 Hub。请确认 Chrome Extension 已加载、启用，并且 Chrome 浏览器已打开。"
    );
  }
  if (!extPortCheck.ok && hubStatus.ok) {
    // Hub 运行但 Extension 端口不通（这种情况通常不会发生，因为 Hub 会代理 Extension）
    report.recommendations.push(
      "[Extension] Extension WebSocket 端口无法连接。请尝试刷新扩展或重启 Chrome。"
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

    const hubLabel = hubPortCheck.ok
      ? hubStatus.ok
        ? "✅ 已连接"
        : `⚠️ 端口通但握手失败`
      : "❌ 未运行";
    console.log(`Hub (:${HUB_PORT}): ${hubLabel}`);

    if (hubStatus.ok && hubStatus.data) {
      const status = hubStatus.data;
      console.log(`  ├─ adapter_connections: ${status.adapter_connections ?? "unknown"}`);
      console.log(`  ├─ extension_connected: ${status.extension_connected ? "✅" : "❌"}`);
      console.log(`  ├─ queue_locked: ${status.queue_locked ? "是" : "否"}`);
      console.log(`  └─ lease_name: ${status.lease_name ?? "无"}`);
    } else if (hubStatus.error) {
      console.log(`  └─ 错误: ${hubStatus.error}`);
    }

    const extLabel = extPortCheck.ok ? "✅ 可连通" : "❌ 未运行";
    console.log(`Extension (:${EXTENSION_PORT}): ${extLabel}`);
    console.log(`Extension 已连接 Hub: ${extConnected ? "✅" : "❌"}`);

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
