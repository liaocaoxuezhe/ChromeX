import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const RUNTIME_PATH = join(__dirname, "..", "runtime", "nodejs-playwright-runtime.mjs");
const STARTUP_TIMEOUT = 15000;
const EXECUTE_TIMEOUT = 5000;

/**
 * 启动 Node.js Runtime 子进程并返回控制句柄。
 */
function startRuntime(env = {}) {
  const proc = spawn("node", [RUNTIME_PATH], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });

  const messages = [];
  const resolvers = [];

  const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
  rl.on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      // 忽略非法 JSON 行（通常是调试输出）
      return;
    }
    messages.push(msg);
    // 将消息广播给所有解析器；匹配的解析器自行清理并 resolve
    const snapshot = [...resolvers];
    for (const r of snapshot) {
      r(msg);
    }
  });

  const stderrLines = [];
  const stderrRl = createInterface({ input: proc.stderr, crlfDelay: Infinity });
  stderrRl.on("line", (line) => {
    stderrLines.push(line);
  });

  function send(msg) {
    proc.stdin.write(JSON.stringify(msg) + "\n");
  }

  function waitFor(filter, timeoutMs = EXECUTE_TIMEOUT) {
    return new Promise((resolve, reject) => {
      // 先检查已收到的消息
      const found = messages.find(filter);
      if (found) {
        resolve(found);
        return;
      }

      const onMessage = (msg) => {
        if (filter(msg)) {
          cleanup();
          resolve(msg);
        }
      };

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`waitFor 超时 (${timeoutMs}ms)`));
      }, timeoutMs);

      function cleanup() {
        clearTimeout(timer);
        const idx = resolvers.indexOf(onMessage);
        if (idx !== -1) resolvers.splice(idx, 1);
      }

      resolvers.push(onMessage);
    });
  }

  function shutdown() {
    send({ type: "shutdown" });
  }

  return { proc, send, waitFor, shutdown, messages, stderrLines };
}

describe("进程启动与停止", () => {
  it("启动后收到 ready 信号，包含 version 和 hubConnected", async () => {
    const rt = startRuntime();

    try {
      const ready = await rt.waitFor((m) => m.type === "ready", STARTUP_TIMEOUT);
      assert.equal(ready.type, "ready");
      assert.equal(typeof ready.version, "string");
      assert.ok(ready.version.length > 0);
      assert.equal(typeof ready.hubConnected, "boolean");
    } finally {
      rt.shutdown();
      await new Promise((resolve) => rt.proc.on("exit", resolve));
      assert.equal(rt.proc.exitCode, 0);
    }
  });

  it("发送 shutdown 后进程以退出码 0 结束", async () => {
    const rt = startRuntime();

    await rt.waitFor((m) => m.type === "ready", STARTUP_TIMEOUT);
    rt.shutdown();

    const msg = await rt.waitFor((m) => m.type === "shutdown", EXECUTE_TIMEOUT);
    assert.equal(msg.type, "shutdown");
    assert.equal(msg.ok, true);

    await new Promise((resolve) => rt.proc.on("exit", resolve));
    assert.equal(rt.proc.exitCode, 0);
  });
});

describe("IPC 通信协议", () => {
  it("execute 请求返回正确格式 {id, ok, result, meta}", async () => {
    const rt = startRuntime();
    await rt.waitFor((m) => m.type === "ready", STARTUP_TIMEOUT);

    try {
      const reqId = "test-req-1";
      rt.send({ id: reqId, type: "execute", code: "return 1 + 1", timeout: 5000 });

      const res = await rt.waitFor((m) => m.id === reqId, EXECUTE_TIMEOUT);
      assert.equal(res.id, reqId);
      assert.equal(res.ok, true);
      assert.equal(res.result, 2);
      assert.ok(typeof res.meta === "object" && res.meta !== null);
      assert.equal(typeof res.meta.elapsedMs, "number");
      assert.ok(res.meta.elapsedMs >= 0);
    } finally {
      rt.shutdown();
      await new Promise((resolve) => rt.proc.on("exit", resolve));
    }
  });

  it("并发请求各自的 req_id 正确匹配", async () => {
    const rt = startRuntime();
    await rt.waitFor((m) => m.type === "ready", STARTUP_TIMEOUT);

    try {
      const reqA = "req-a";
      const reqB = "req-b";

      rt.send({ id: reqA, type: "execute", code: "return 'A'", timeout: 5000 });
      rt.send({ id: reqB, type: "execute", code: "return 'B'", timeout: 5000 });

      const resA = await rt.waitFor((m) => m.id === reqA, EXECUTE_TIMEOUT);
      const resB = await rt.waitFor((m) => m.id === reqB, EXECUTE_TIMEOUT);

      assert.equal(resA.result, "A");
      assert.equal(resB.result, "B");
    } finally {
      rt.shutdown();
      await new Promise((resolve) => rt.proc.on("exit", resolve));
    }
  });
});

describe("代码执行与结果序列化", () => {
  async function withRuntime(fn) {
    const rt = startRuntime();
    await rt.waitFor((m) => m.type === "ready", STARTUP_TIMEOUT);
    try {
      await fn(rt);
    } finally {
      rt.shutdown();
      await new Promise((resolve) => rt.proc.on("exit", resolve));
    }
  }

  async function execute(rt, code, timeout = 5000) {
    const id = `exec-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    rt.send({ id, type: "execute", code, timeout });
    return rt.waitFor((m) => m.id === id, timeout + 2000);
  }

  it("return 1+1 → number 2", async () => {
    await withRuntime(async (rt) => {
      const res = await execute(rt, "return 1 + 1");
      assert.equal(res.ok, true);
      assert.equal(res.result, 2);
    });
  });

  it("return 'hello' → string 'hello'", async () => {
    await withRuntime(async (rt) => {
      const res = await execute(rt, "return 'hello'");
      assert.equal(res.ok, true);
      assert.equal(res.result, "hello");
    });
  });

  it("return {a:1, b:'test'} → object", async () => {
    await withRuntime(async (rt) => {
      const res = await execute(rt, "return {a:1, b:'test'}");
      assert.equal(res.ok, true);
      assert.deepEqual(res.result, { a: 1, b: "test" });
    });
  });

  it("return undefined → {__type: 'undefined'}", async () => {
    await withRuntime(async (rt) => {
      const res = await execute(rt, "return undefined");
      assert.equal(res.ok, true);
      assert.deepEqual(res.result, { __type: "undefined" });
    });
  });

  it("return [1,2,3] → array", async () => {
    await withRuntime(async (rt) => {
      const res = await execute(rt, "return [1,2,3]");
      assert.equal(res.ok, true);
      assert.deepEqual(res.result, [1, 2, 3]);
    });
  });

  it("无 return 语句 → {__type: 'undefined'}", async () => {
    await withRuntime(async (rt) => {
      const res = await execute(rt, "const x = 42;");
      assert.equal(res.ok, true);
      assert.deepEqual(res.result, { __type: "undefined" });
    });
  });
});

describe("变量持久化（跨调用）", () => {
  it("第一次用顶层 const 声明变量，第二次可直接读取", async () => {
    const rt = startRuntime();
    await rt.waitFor((m) => m.type === "ready", STARTUP_TIMEOUT);

    try {
      const id1 = `persist-const-${Date.now()}-1`;
      rt.send({ id: id1, type: "execute", code: "const persistedConst = 42; return persistedConst", timeout: 5000 });
      const res1 = await rt.waitFor((m) => m.id === id1, EXECUTE_TIMEOUT);
      assert.equal(res1.ok, true);
      assert.equal(res1.result, 42);

      const id2 = `persist-const-${Date.now()}-2`;
      rt.send({ id: id2, type: "execute", code: "return persistedConst", timeout: 5000 });
      const res2 = await rt.waitFor((m) => m.id === id2, EXECUTE_TIMEOUT);
      assert.equal(res2.ok, true);
      assert.equal(res2.result, 42);
    } finally {
      rt.shutdown();
      await new Promise((resolve) => rt.proc.on("exit", resolve));
    }
  });

  it("第一次设置 globalThis.testVar，第二次可读取", async () => {
    const rt = startRuntime();
    await rt.waitFor((m) => m.type === "ready", STARTUP_TIMEOUT);

    try {
      const id1 = `persist-${Date.now()}-1`;
      rt.send({ id: id1, type: "execute", code: "globalThis.testVar = 42; return 'set'", timeout: 5000 });
      const res1 = await rt.waitFor((m) => m.id === id1, EXECUTE_TIMEOUT);
      assert.equal(res1.ok, true);
      assert.equal(res1.result, "set");

      const id2 = `persist-${Date.now()}-2`;
      rt.send({ id: id2, type: "execute", code: "return globalThis.testVar", timeout: 5000 });
      const res2 = await rt.waitFor((m) => m.id === id2, EXECUTE_TIMEOUT);
      assert.equal(res2.ok, true);
      assert.equal(res2.result, 42);
    } finally {
      rt.shutdown();
      await new Promise((resolve) => rt.proc.on("exit", resolve));
    }
  });
});

describe("超时处理", () => {
  it("死循环/永久等待在 timeout 后返回错误", async () => {
    const rt = startRuntime();
    await rt.waitFor((m) => m.type === "ready", STARTUP_TIMEOUT);

    try {
      const id = `timeout-${Date.now()}`;
      const code = "await new Promise(() => {})";
      rt.send({ id, type: "execute", code, timeout: 1000 });

      const res = await rt.waitFor((m) => m.id === id, 4000);
      assert.equal(res.ok, false);
      assert.ok(res.error.includes("Timeout"), `期望错误包含 'Timeout'，实际: ${res.error}`);
      assert.ok(typeof res.meta.elapsedMs === "number");
    } finally {
      rt.shutdown();
      await new Promise((resolve) => rt.proc.on("exit", resolve));
    }
  });
});

describe("错误处理", () => {
  async function withRuntime(fn) {
    const rt = startRuntime();
    await rt.waitFor((m) => m.type === "ready", STARTUP_TIMEOUT);
    try {
      await fn(rt);
    } finally {
      rt.shutdown();
      await new Promise((resolve) => rt.proc.on("exit", resolve));
    }
  }

  async function execute(rt, code, timeout = 5000) {
    const id = `err-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    rt.send({ id, type: "execute", code, timeout });
    return rt.waitFor((m) => m.id === id, timeout + 2000);
  }

  it("throw new Error('test error') 返回 ok:false 并携带 message 和 stack", async () => {
    await withRuntime(async (rt) => {
      const res = await execute(rt, "throw new Error('test error')");
      assert.equal(res.ok, false);
      assert.ok(res.error.includes("test error"), `期望错误包含 'test error'，实际: ${res.error}`);
      assert.ok(typeof res.stack === "string" && res.stack.length > 0, "期望存在 stack");
    });
  });

  it("page is not defined 返回指向 page facade 的修复提示", async () => {
    await withRuntime(async (rt) => {
      const res = await execute(rt, "throw new ReferenceError('page is not defined')");
      assert.equal(res.ok, false);
      assert.equal(res.errorType, "ReferenceError");
      assert.match(res.hint, /page facade/);
      assert.match(res.hint, /const tab = await browser\.tabs\.selected\(\)/);
      assert.match(res.hint, /const page = tab\.playwright/);
    });
  });

  it("未定义变量返回 ReferenceError 类型和修复提示", async () => {
    await withRuntime(async (rt) => {
      const res = await execute(rt, "missingValue;");
      assert.equal(res.ok, false);
      assert.equal(res.errorType, "ReferenceError");
      assert.ok(res.error.includes("missingValue"), `期望错误包含变量名，实际: ${res.error}`);
      assert.ok(res.hint.includes("未定义"), `期望 hint 提醒未定义变量，实际: ${res.hint}`);
      assert.ok(typeof res.stack === "string" && res.stack.length > 0, "期望存在 stack");
      assert.ok(typeof res.meta === "object" && res.meta !== null, "期望存在 meta");
    });
  });

  it("语法错误返回 ok:false 并携带错误信息", async () => {
    await withRuntime(async (rt) => {
      const res = await execute(rt, "return { a: 1");
      assert.equal(res.ok, false);
      assert.ok(typeof res.error === "string" && res.error.length > 0, "期望存在 error 字符串");
    });
  });
});

describe("Playwright page facade", () => {
  async function withRuntime(fn) {
    const rt = startRuntime();
    await rt.waitFor((m) => m.type === "ready", STARTUP_TIMEOUT);
    try {
      await fn(rt);
    } finally {
      rt.shutdown();
      await new Promise((resolve) => rt.proc.on("exit", resolve));
    }
  }

  async function execute(rt, code, timeout = 5000) {
    const id = `page-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    rt.send({ id, type: "execute", code, timeout });
    return rt.waitFor((m) => m.id === id, timeout + 2000);
  }

  it("预注入 page，并将 evaluate 委托给当前 tab.playwright", async () => {
    await withRuntime(async (rt) => {
      const res = await execute(rt, `
        globalThis.tab = {
          playwright: {
            async evaluate(fn) {
              return fn();
            }
          }
        };
        return await page.evaluate(() => "page-ok");
      `);

      assert.equal(res.ok, true);
      assert.equal(res.result, "page-ok");
    });
  });

  it("page.locator 链式调用会延迟委托给当前 tab.playwright locator", async () => {
    await withRuntime(async (rt) => {
      const res = await execute(rt, `
        globalThis.tab = {
          playwright: {
            locator(selector) {
              return {
                nth(index) {
                  return {
                    async textContent() {
                      return selector + ":" + index;
                    }
                  };
                }
              };
            }
          }
        };
        return await page.locator(".item").nth(2).textContent();
      `);

      assert.equal(res.ok, true);
      assert.equal(res.result, ".item:2");
    });
  });
});

describe("console.log 转发", () => {
  it("console.log('hello') 在 stdout 产生 {type:'log', level:'log', message:'hello'}", async () => {
    const rt = startRuntime();
    await rt.waitFor((m) => m.type === "ready", STARTUP_TIMEOUT);

    try {
      const id = `log-${Date.now()}`;
      rt.send({ id, type: "execute", code: "console.log('hello'); return 'done'", timeout: 5000 });

      // 等待执行完成
      const res = await rt.waitFor((m) => m.id === id, EXECUTE_TIMEOUT);
      assert.equal(res.ok, true);
      assert.equal(res.result, "done");

      // 在已收消息中查找 log 消息
      const logMsg = rt.messages.find((m) => m.type === "log" && m.message === "hello");
      assert.ok(logMsg, "未找到 console.log 转发消息");
      assert.equal(logMsg.level, "log");
    } finally {
      rt.shutdown();
      await new Promise((resolve) => rt.proc.on("exit", resolve));
    }
  });

  it("console.error 以 level='error' 转发", async () => {
    const rt = startRuntime();
    await rt.waitFor((m) => m.type === "ready", STARTUP_TIMEOUT);

    try {
      const id = `errlog-${Date.now()}`;
      rt.send({ id, type: "execute", code: "console.error('oops'); return 'done'", timeout: 5000 });

      const res = await rt.waitFor((m) => m.id === id, EXECUTE_TIMEOUT);
      assert.equal(res.ok, true);

      const logMsg = rt.messages.find((m) => m.type === "log" && m.message === "oops");
      assert.ok(logMsg, "未找到 console.error 转发消息");
      assert.equal(logMsg.level, "error");
    } finally {
      rt.shutdown();
      await new Promise((resolve) => rt.proc.on("exit", resolve));
    }
  });
});

describe("Hub 连接", () => {
  it.skip("需要真实 Hub 运行，验证 hubConnected=true", async () => {
    // 当 Browser Hub (ws://localhost:8766) 真实运行时，
    // ready 消息的 hubConnected 应为 true。
    // 此测试默认跳过，避免在无 Hub 环境中失败。
  });
});
