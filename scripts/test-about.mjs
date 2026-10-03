/*
 * 「关于」窗口纯逻辑单测：node --test scripts/test-about.mjs
 *
 * 被测逻辑就是 src/about.js 顶部那段**纯函数区**（无 DOM 依赖），
 * 运行时用的同一份代码 —— 不是复制一份到测试里。
 * 直接 import 真实文件：Node 里没有 document/window，文件底部的 boot() 会自行跳过。
 *
 * 覆盖不到的部分（诚实声明）：
 *   - 真实的 fetch → api.github.com（本容器无外网）
 *   - WebView2 里的渲染 / 点击 / 系统浏览器跳转（无 Windows UI）
 *   - Rust 侧 app_version / app_channel 的返回值本身
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

await import(new URL("../src/about.js", import.meta.url).href);

const A = globalThis.__aboutInternals;
assert.ok(A, "src/about.js 必须通过 globalThis.__aboutInternals 暴露纯逻辑");

const { CHANNEL_RELEASE, CHANNEL_RC } = A;

/** 造一个 GitHub Release 形状的最小对象。 */
function rel(tag, { prerelease = false, name = "", published = "2026-01-01T00:00:00Z", assets = [] } = {}) {
  return { tag_name: tag, name, prerelease, published_at: published, html_url: `https://github.com/x/${tag}`, assets };
}

/* ------------------------------------------------------------ 版本解析 */

test("parseVersion：v.A.B.C / v0.3.2 / 纯数字都能拆", () => {
  assert.deepEqual(A.parseVersion("v.0.3.2"), [0, 3, 2]);
  assert.deepEqual(A.parseVersion("v0.3.2"), [0, 3, 2]);
  assert.deepEqual(A.parseVersion("1.2.10"), [1, 2, 10]);
});

test("parseVersion：RC 后缀不参与数字比较", () => {
  assert.deepEqual(A.parseVersion("v.0.3.2 RC"), [0, 3, 2]);
  assert.deepEqual(A.parseVersion("v.0.3.2-rc"), [0, 3, 2]);
  assert.deepEqual(A.parseVersion("v.0.3.2-rc1"), [0, 3, 2]);
});

test("parseVersion：空值/垃圾输入退化为 0，不抛异常", () => {
  assert.deepEqual(A.parseVersion(""), [0]);
  assert.deepEqual(A.parseVersion(null), [0]);
  assert.deepEqual(A.parseVersion("abc"), [0]);
});

test("compareVersion：数字段比较，不是字符串比较", () => {
  assert.ok(A.compareVersion("v.0.3.10", "v.0.3.9") > 0);
  assert.ok(A.compareVersion("v.0.4.0", "v.0.3.99") > 0);
  assert.ok(A.compareVersion("v.0.3.2", "v.0.3.2") === 0);
  assert.ok(A.compareVersion("v.0.3.2", "v.0.3.2 RC") === 0);
  assert.ok(A.compareVersion("v.0.2.9", "v.0.3.0") < 0);
});

test("compareVersion：缺位补 0（v.1 与 v.1.0.0 相等）", () => {
  assert.equal(A.compareVersion("v.1", "v.1.0.0"), 0);
});

/* ------------------------------------------------- 通道识别 / 分区 */

test("channelOfText：RC 的几种写法都认出来", () => {
  assert.equal(A.channelOfText("v.0.3.2 RC"), CHANNEL_RC);
  assert.equal(A.channelOfText("v.0.3.2-rc"), CHANNEL_RC);
  assert.equal(A.channelOfText("v.0.3.2-rc1"), CHANNEL_RC);
});

test("channelOfText：发布版不带 RC 后缀", () => {
  assert.equal(A.channelOfText("v.0.3.2"), CHANNEL_RELEASE);
  assert.equal(A.channelOfText("v.0.3.2 GenX"), CHANNEL_RELEASE); // Gen 已取消，不得被当成 RC
});

test("normalizeChannel：rc 的写法归一，未知值退回 release", () => {
  assert.equal(A.normalizeChannel("rc"), CHANNEL_RC);
  assert.equal(A.normalizeChannel("RC"), CHANNEL_RC);
  assert.equal(A.normalizeChannel("prerelease"), CHANNEL_RC);
  assert.equal(A.normalizeChannel("release"), CHANNEL_RELEASE);
  assert.equal(A.normalizeChannel(undefined), CHANNEL_RELEASE);
  assert.equal(A.normalizeChannel("whatever"), CHANNEL_RELEASE);
});

test("partitionReleases：严格按 prerelease 布尔值分区", () => {
  const parts = A.partitionReleases([
    rel("v.0.3.2"),
    rel("v.0.3.2 RC", { prerelease: true }),
    rel("v.0.3.1"),
    rel("v.0.3.1-rc", { prerelease: true }),
  ]);
  assert.deepEqual(parts[CHANNEL_RELEASE].map((r) => r.tag_name), ["v.0.3.2", "v.0.3.1"]);
  assert.deepEqual(parts[CHANNEL_RC].map((r) => r.tag_name), ["v.0.3.2 RC", "v.0.3.1-rc"]);
});

test("partitionReleases：prerelease 缺失/false 都算 Release（RC 名字不算数）", () => {
  const parts = A.partitionReleases([
    { tag_name: "v.0.3.2 RC" }, // 没有 prerelease 字段
    rel("v.0.3.2-rc", { prerelease: false }), // 显式 false
  ]);
  assert.equal(parts[CHANNEL_RELEASE].length, 2);
  assert.equal(parts[CHANNEL_RC].length, 0);
});

test("partitionReleases：空列表 / 非数组输入 ⇒ 两个通道都是空数组", () => {
  for (const input of [[], null, undefined, "nope", {}]) {
    const parts = A.partitionReleases(input);
    assert.deepEqual(parts[CHANNEL_RELEASE], []);
    assert.deepEqual(parts[CHANNEL_RC], []);
  }
});

test("partitionReleases：跳过 null / 非对象元素", () => {
  const parts = A.partitionReleases([null, 42, rel("v.0.3.2")]);
  assert.deepEqual(parts[CHANNEL_RELEASE].map((r) => r.tag_name), ["v.0.3.2"]);
});

/* --------------------------------------------- 每通道最高版本选择 */

test("highestPerChannel：两个通道各取最高版本", () => {
  const best = A.highestPerChannel([
    rel("v.0.3.2"),
    rel("v.0.3.1"),
    rel("v.0.2.9"),
    rel("v.0.3.2 RC", { prerelease: true }),
    rel("v.0.3.10 RC", { prerelease: true }),
    rel("v.0.3.9-rc", { prerelease: true }),
  ]);
  assert.equal(best[CHANNEL_RELEASE].tag_name, "v.0.3.2");
  assert.equal(best[CHANNEL_RC].tag_name, "v.0.3.10 RC");
});

test("highestPerChannel：tag 是 v.0.3.2-rc、标题是 v.0.3.2 RC 的两种形态都取得到", () => {
  const byTag = A.highestPerChannel([rel("v.0.3.2-rc", { prerelease: true })]);
  assert.equal(byTag[CHANNEL_RC].tag_name, "v.0.3.2-rc");

  const byName = A.highestPerChannel([
    rel("", { prerelease: true, name: "v.0.3.2 RC" }),
  ]);
  assert.equal(A.releaseVersion(byName[CHANNEL_RC]), "v.0.3.2 RC");
});

test("highestPerChannel：没有 RC 预发布时 RC 为 null（不是错误）", () => {
  const best = A.highestPerChannel([rel("v.0.3.2")]);
  assert.equal(best[CHANNEL_RELEASE].tag_name, "v.0.3.2");
  assert.equal(best[CHANNEL_RC], null);
});

test("highestPerChannel：空列表 ⇒ 两个通道都是 null", () => {
  const best = A.highestPerChannel([]);
  assert.equal(best[CHANNEL_RELEASE], null);
  assert.equal(best[CHANNEL_RC], null);
});

test("highestPerChannel：忽略没有版本号的条目", () => {
  const best = A.highestPerChannel([{ tag_name: "", name: "", prerelease: false }]);
  assert.equal(best[CHANNEL_RELEASE], null);
});

test("highestPerChannel：同版本重发时取发布时间更新的那个", () => {
  const older = rel("v.0.3.2", { published: "2026-01-01T00:00:00Z" });
  const newer = rel("v.0.3.2", { published: "2026-02-01T00:00:00Z" });
  assert.equal(A.highestPerChannel([older, newer])[CHANNEL_RELEASE].published_at, newer.published_at);
});

test("highestPerChannel：数字比较而非字典序（v.0.3.10 > v.0.3.9）", () => {
  const best = A.highestPerChannel([rel("v.0.3.9"), rel("v.0.3.10")]);
  assert.equal(best[CHANNEL_RELEASE].tag_name, "v.0.3.10");
});

/* --------------------------------------------------- 安装包 / 日期 */

test("pickInstallerAsset：优先 setup 类 exe", () => {
  const asset = A.pickInstallerAsset(
    rel("v.0.3.2", {
      assets: [
        { name: "notes.txt", browser_download_url: "u0" },
        { name: "DSHTauri_0.3.2_x64_en-US.msi", browser_download_url: "u1" },
        { name: "DSHTauri_0.3.2_x64-setup.exe", browser_download_url: "u2" },
      ],
    }),
  );
  assert.equal(asset.browser_download_url, "u2");
});

test("pickInstallerAsset：没有 exe/msi 时返回 null", () => {
  assert.equal(A.pickInstallerAsset(rel("v.0.3.2", { assets: [{ name: "a.txt", browser_download_url: "u" }] })), null);
  assert.equal(A.pickInstallerAsset(rel("v.0.3.2")), null);
  assert.equal(A.pickInstallerAsset(null), null);
});

test("formatDate：ISO ⇒ YYYY-MM-DD，空值/垃圾有兜底", () => {
  assert.equal(A.formatDate("2026-03-04T05:06:07Z"), "2026-03-04");
  assert.equal(A.formatDate(""), "未知日期");
  assert.equal(A.formatDate(null), "未知日期");
  assert.equal(A.formatDate("不是日期"), "不是日期");
});

test("escapeHtml：转义 HTML 元字符（版本/资产名来自外部）", () => {
  assert.equal(A.escapeHtml('<img src=x onerror="a">'), "&lt;img src=x onerror=&quot;a&quot;&gt;");
  assert.equal(A.escapeHtml("v.0.3.2 & RC"), "v.0.3.2 &amp; RC");
  assert.equal(A.escapeHtml(null), "");
});

/* ------------------------------------------------- 跨通道下载守卫 */

test("needsCrossChannelConfirm：跨通道 = true", () => {
  assert.equal(A.needsCrossChannelConfirm(CHANNEL_RELEASE, CHANNEL_RC), true);
  assert.equal(A.needsCrossChannelConfirm(CHANNEL_RC, CHANNEL_RELEASE), true);
  assert.equal(A.needsCrossChannelConfirm("release", "rc"), true);
});

test("needsCrossChannelConfirm：同通道 = false（含大小写/未知值归一）", () => {
  assert.equal(A.needsCrossChannelConfirm(CHANNEL_RELEASE, CHANNEL_RELEASE), false);
  assert.equal(A.needsCrossChannelConfirm(CHANNEL_RC, CHANNEL_RC), false);
  assert.equal(A.needsCrossChannelConfirm("RELEASE", "release"), false);
  assert.equal(A.needsCrossChannelConfirm(undefined, CHANNEL_RELEASE), false);
});

test("crossChannelPrompt：两个通道名都出现在文案里", () => {
  const text = A.crossChannelPrompt(CHANNEL_RELEASE, CHANNEL_RC);
  assert.match(text, /Release/);
  assert.match(text, /RC/);
  assert.match(text, /是否继续/);

  const back = A.crossChannelPrompt(CHANNEL_RC, CHANNEL_RELEASE);
  assert.match(back, /RC/);
  assert.match(back, /Release/);
});

test("emptyChannelText：RC 空态是友好「暂无」，不是错误", () => {
  const rc = A.emptyChannelText(CHANNEL_RC);
  assert.match(rc, /暂无/);
  assert.doesNotMatch(rc, /失败|错误|error/i);
  assert.match(A.emptyChannelText(CHANNEL_RELEASE), /暂无/);
});

/* --------------------------------------------- API / 静态约束（防回归） */

test("API 端点：使用 /releases 列表，不再用 /releases/latest", () => {
  assert.equal(A.RELEASES_API, "https://api.github.com/repos/tianyimc/DSH-Tauri/releases?per_page=30");
  assert.doesNotMatch(A.RELEASES_API, /\/latest/);
});

const aboutJs = readFileSync(new URL("../src/about.js", import.meta.url), "utf8");
const aboutHtml = readFileSync(new URL("../src/about.html", import.meta.url), "utf8");
/* 注释里提到旧端点属于文档说明，断言只针对真正的代码。 */
const aboutJsCode = aboutJs.replace(/\/\*[\s\S]*?\*\//g, "");

test("src/about.js：不再引用 /releases/latest，且带 Accept 头", () => {
  assert.doesNotMatch(aboutJsCode, /releases\/latest/);
  assert.match(aboutJs, /Accept:\s*"application\/vnd\.github\+json"/);
  assert.match(aboutJs, /invoke\("app_channel"\)/);
});

/*
 * 下载必须走 Rust 的 open_external（交给系统默认浏览器）。
 *
 * 为什么这条重要：早先的实现直接 `window.location.href = url`，
 * 会让**「关于」窗口自己导航走** —— 点一次「下载」界面就回不来了。
 * 这里断言「调用了 open_external」，且它**不是**唯一的打开方式之前那条
 * 「优先 opener 插件」的猜测式代码（本项目没有启用任何插件）。
 */
test("src/about.js：下载走 open_external 命令（不让关于窗口自己被导航走）", () => {
  assert.match(aboutJs, /invoke\("open_external",\s*\{\s*url\s*\}\)/);
  // 不能把 location.href 当主路径：它只应出现在 catch 降级分支里。
  const hrefUses = aboutJsCode.match(/window\.location\.href/g) ?? [];
  assert.equal(hrefUses.length, 1, "location.href 只允许作为 open_external 失败后的降级路径");
  // 不应再猜测 opener / shell 插件（本项目未启用插件）。
  assert.doesNotMatch(aboutJsCode, /__TAURI__\?\.opener/);
  assert.doesNotMatch(aboutJsCode, /__TAURI__\?\.shell/);
});

test("src/about.js：全文不出现 Gen（GenX 已取消）", () => {
  assert.doesNotMatch(aboutJs, /Gen/);
});

test("src/about.html：版本规则已更新为 v.A.B.C，且不再出现 GenX", () => {
  assert.doesNotMatch(aboutHtml, /Gen/);
  assert.match(aboutHtml, /v\.A\.B\.C/);
  assert.match(aboutHtml, /RC/);
  assert.match(aboutHtml, /CHANGELOG\.md/);
});

test("src/about.html：确认面板与通道容器节点存在（about.js 依赖这些 id）", () => {
  for (const id of ["update", "channels", "confirm", "confirm-text", "confirm-ok", "confirm-cancel", "channel-badge"]) {
    assert.match(aboutHtml, new RegExp(`id="${id}"`), `about.html 缺少 #${id}`);
  }
});
