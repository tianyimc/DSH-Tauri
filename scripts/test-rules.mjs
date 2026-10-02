/*
 * 配置规则单元测试：node --test scripts/test-rules.mjs
 *
 * 重点覆盖需求里明确要求的一条：**本地和远程允许只配一个**。
 * 被测逻辑就是 src/config-rules.js —— 前端运行时用的同一份代码。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  CHAT_MODES,
  DEFAULT_CONFIG,
  EXAMPLES,
  buildConfig,
  chatDockedOf,
  chatModeOf,
  isHttpUrl,
  normalizeUrl,
  urlOf,
  validateConfig,
} from "../src/config-rules.js";

/* ------------------------------------------------------- 只配一个是合法的 */

test("只配本地地址可以通过", () => {
  assert.equal(validateConfig({ localUrl: "http://127.0.0.1:3080", remoteUrl: "" }), null);
});

test("只配远程地址可以通过", () => {
  assert.equal(validateConfig({ localUrl: "", remoteUrl: "https://dsh.example.com" }), null);
});

test("两个都配也可以", () => {
  assert.equal(
    validateConfig({ localUrl: "http://127.0.0.1:3080", remoteUrl: "https://dsh.example.com" }),
    null,
  );
});

test("留空的一侧用空白字符也算没配", () => {
  assert.equal(validateConfig({ localUrl: "   ", remoteUrl: "https://a.com" }), null);
});

/* ------------------------------------------------------------ 非法的情况 */

test("两个都空要报错", () => {
  const err = validateConfig({ localUrl: "", remoteUrl: "" });
  assert.match(err, /至少要填一个/);
});

test("本地 URL 非法要报错，并提示可以留空", () => {
  const err = validateConfig({ localUrl: "127.0.0.1:3080", remoteUrl: "" });
  assert.match(err, /本地 URL 无效/);
  assert.match(err, /留空/);
});

test("远程 URL 非法要报错", () => {
  const err = validateConfig({ localUrl: "", remoteUrl: "ftp://x" });
  assert.match(err, /远程 URL 无效/);
});

test("没配本地地址却勾了自动启动服务，要报错", () => {
  const err = validateConfig({
    localUrl: "",
    remoteUrl: "https://dsh.example.com",
    autoStartLocal: true,
    localStartCommand: "dsh web",
  });
  assert.match(err, /没有配置本地地址/);
});

test("勾了自动启动但命令为空，要报错", () => {
  const err = validateConfig({
    localUrl: "http://127.0.0.1:3080",
    autoStartLocal: true,
    localStartCommand: "  ",
  });
  assert.match(err, /启动命令为空/);
});

test("本地 + 自动启动 + 有命令，通过", () => {
  assert.equal(
    validateConfig({
      localUrl: "http://127.0.0.1:3080",
      autoStartLocal: true,
      localStartCommand: "dsh web",
    }),
    null,
  );
});

/* --------------------------------------------------------------- 工具函数 */

test("normalizeUrl 去掉首尾空白和结尾斜杠", () => {
  assert.equal(normalizeUrl("  http://127.0.0.1:3080///  "), "http://127.0.0.1:3080");
  assert.equal(normalizeUrl(null), "");
  assert.equal(normalizeUrl(undefined), "");
});

test("isHttpUrl 只接受 http/https", () => {
  assert.ok(isHttpUrl("http://127.0.0.1:3080"));
  assert.ok(isHttpUrl("https://dsh.example.com"));
  assert.ok(isHttpUrl("HTTPS://DSH.EXAMPLE.COM"));
  assert.ok(!isHttpUrl("ftp://x"));
  assert.ok(!isHttpUrl("file:///C:/x"));
  assert.ok(!isHttpUrl("127.0.0.1:3080"));
});

test("urlOf 按模式取地址", () => {
  const config = { localUrl: "http://l", remoteUrl: "https://r" };
  assert.equal(urlOf(config, "local"), "http://l");
  assert.equal(urlOf(config, "remote"), "https://r");
});

test("buildConfig 归一化并标记 configured", () => {
  const built = buildConfig({
    localUrl: " http://127.0.0.1:3080/ ",
    remoteUrl: "",
    autoStartLocal: false,
    localStartCommand: "  ",
  });
  assert.deepEqual(built, {
    configured: true,
    localUrl: "http://127.0.0.1:3080",
    remoteUrl: "",
    autoStartLocal: false,
    localStartCommand: "",
  });
  // 字段名必须是 camelCase —— Rust 侧靠 serde(rename_all = "camelCase") 映射。
  assert.deepEqual(Object.keys(built).sort(), [
    "autoStartLocal",
    "configured",
    "localStartCommand",
    "localUrl",
    "remoteUrl",
  ]);
});

/* ------------------------------------------------------------------ 默认值 */

test("默认配置的两个地址都是空的", () => {
  assert.equal(DEFAULT_CONFIG.localUrl, "");
  assert.equal(DEFAULT_CONFIG.remoteUrl, "");
  assert.equal(DEFAULT_CONFIG.configured, false);
});

test("示例值与需求一致", () => {
  assert.equal(EXAMPLES.localUrl, "http://127.0.0.1:3080");
  assert.equal(EXAMPLES.remoteUrl, "https://dsh.example.com");
  assert.equal(EXAMPLES.localCommand, "dsh web");
});

test("默认配置本身校验不通过（强制用户至少填一个）", () => {
  assert.match(validateConfig(DEFAULT_CONFIG), /至少要填一个/);
});

/* ------------------------------------------------- 网页对话加载模式（task-4） */

test("chatDocked 默认 false = overlay（保持升级前的行为）", () => {
  assert.equal(DEFAULT_CONFIG.chatDocked, false);
  assert.equal(chatModeOf(DEFAULT_CONFIG), "overlay");
  assert.equal(chatModeOf({}), "overlay");
  assert.equal(chatModeOf({ chatDocked: false }), "overlay");
});

test("chatDocked 为 true 时是 docked", () => {
  assert.equal(chatModeOf({ chatDocked: true }), "docked");
});

test("chatModeOf 对 null/undefined 也安全（按 overlay）", () => {
  assert.equal(chatModeOf(null), "overlay");
  assert.equal(chatModeOf(undefined), "overlay");
});

test("chatDockedOf 把模式 id 映射回布尔值，未知 id 一律 overlay", () => {
  assert.equal(chatDockedOf("docked"), true);
  assert.equal(chatDockedOf("overlay"), false);
  assert.equal(chatDockedOf("bogus"), false);
  assert.equal(chatDockedOf(undefined), false);
});

test("CHAT_MODES 的 id 与 docked 布尔值自洽", () => {
  assert.equal(CHAT_MODES.overlay.docked, false);
  assert.equal(CHAT_MODES.docked.docked, true);
  for (const key of ["overlay", "docked"]) {
    assert.equal(CHAT_MODES[key].id, key);
    assert.equal(chatDockedOf(CHAT_MODES[key].id), CHAT_MODES[key].docked);
    assert.equal(chatModeOf({ chatDocked: CHAT_MODES[key].docked }), key);
  }
});

test("buildConfig 刻意不产出 chatDocked（靠 Rust save_config 的补丁语义保留）", () => {
  const built = buildConfig({ localUrl: "http://x:1" });
  assert.ok(
    !Object.prototype.hasOwnProperty.call(built, "chatDocked"),
    "地址表单不该带上 chatDocked —— 若带上，用户在设置里选的模式会被重置",
  );
});
