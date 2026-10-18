/* ============================================================================
 * build/pack.js —— 手工组装 Windows 目录版
 *
 * 为什么不用 electron-builder：
 *   它会在打包时再去下载 winCodeSign / nsis 等一堆资源，国内网络下经常卡死，
 *   而且这台机器装了 360 + 奇安信，解压签名工具时容易被拦。
 *   手工组装只做三件事：复制 Electron 运行时 → 放 app 目录 → 改名 exe，
 *   全程离线、可重复、出问题一眼能看出是哪一步。
 *
 * 产物：
 *   dist/CyanCodex/CyanCodex.exe      双击即用（GUI）
 *   dist/CyanCodex/cyancodex.cmd      CLI 入口（把 Electron 当 node 用）
 * ========================================================================== */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const ELECTRON_DIST = path.join(ROOT, "node_modules", "electron", "dist");
const OUT = path.join(ROOT, "dist", "CyanCodex");
const APP = path.join(OUT, "resources", "app");

const COPY = ["package.json", "electron", "server", "cli", "core", "web"];

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function main() {
  if (!fs.existsSync(ELECTRON_DIST)) {
    console.error("✗ 找不到 Electron 运行时，先执行 npm install");
    process.exit(1);
  }

  console.log("→ 清理 dist");
  rmrf(OUT);
  fs.mkdirSync(OUT, { recursive: true });

  console.log("→ 复制 Electron 运行时");
  fs.cpSync(ELECTRON_DIST, OUT, { recursive: true });

  console.log("→ 移除默认应用");
  rmrf(path.join(OUT, "resources", "default_app.asar"));

  // 只保留中英文语言包：Electron 自带 55 个 .pak，共 44 MB，
  // 我们只服务中文用户，删掉其余能省下 ~42 MB
  const localesDir = path.join(OUT, "locales");
  if (fs.existsSync(localesDir)) {
    const keep = new Set(["zh-CN.pak", "zh-TW.pak", "en-US.pak", "en-GB.pak"]);
    let removed = 0;
    for (const f of fs.readdirSync(localesDir)) {
      if (!keep.has(f)) {
        try { fs.unlinkSync(path.join(localesDir, f)); removed++; } catch (_) { /* ignore */ }
      }
    }
    console.log("  语言包保留 4 / " + (removed + 4) + " 个");
  }

  console.log("→ 放入应用代码");
  fs.mkdirSync(APP, { recursive: true });
  for (const item of COPY) {
    const src = path.join(ROOT, item);
    const dst = path.join(APP, item);
    if (!fs.existsSync(src)) continue;
    fs.cpSync(src, dst, { recursive: true });
  }

  console.log("→ 重命名可执行文件");
  const exeSrc = path.join(OUT, "electron.exe");
  const exeDst = path.join(OUT, "CyanCodex.exe");
  if (fs.existsSync(exeSrc)) fs.renameSync(exeSrc, exeDst);

  console.log("→ 生成 CLI 入口");
  // ELECTRON_RUN_AS_NODE=1 让同一个 exe 以纯 node 模式跑 CLI，
  // 好处是不需要用户另外装 Node，也不用把 node.exe 再打一份进来。
  const cmd = [
    "@echo off",
    "setlocal",
    "set ELECTRON_RUN_AS_NODE=1",
    "set CYANCODEX_PACKAGED=1",
    "\"%~dp0CyanCodex.exe\" \"%~dp0resources\\app\\cli\\index.js\" %*",
    "",
  ].join("\r\n");
  fs.writeFileSync(path.join(OUT, "cyancodex.cmd"), cmd, "utf8");

  // 顺手把 README 放进去，用户拿到文件夹不至于一头雾水
  const readme = [
    "CyanCodex 桌面版",
    "================",
    "",
    "双击 CyanCodex.exe 启动图形界面。",
    "",
    "命令行（在本目录打开终端）：",
    "  cyancodex --help",
    "  cyancodex gen tdisplay --objective coins --name 金币 --line \"金币:@s/coins\"",
    "  cyancodex lib search 计分板",
    "  cyancodex ai \"做一个倒计时计分板\" -o timer.mcfunction",
    "",
    "配置与登录信息保存在 %APPDATA%\\CyanCodex\\",
    "",
  ].join("\r\n");
  fs.writeFileSync(path.join(OUT, "README.txt"), readme, "utf8");

  // 体积统计
  let bytes = 0;
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else bytes += fs.statSync(p).size;
    }
  })(OUT);

  console.log("");
  console.log("✓ 打包完成");
  console.log("  " + OUT);
  console.log("  体积 " + (bytes / 1048576).toFixed(1) + " MB");
  console.log("  GUI  " + path.join(OUT, "CyanCodex.exe"));
  console.log("  CLI  " + path.join(OUT, "cyancodex.cmd"));
}

main();
