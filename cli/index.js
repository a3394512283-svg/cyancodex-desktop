#!/usr/bin/env node
/* ============================================================================
 * cli/index.js —— CyanCodex 命令行
 *
 * 设计原则：
 *   · 每个子命令都能管道化：默认输出可直接粘进命令方块，`--json` 给脚本用
 *   · 生成器复用 web/gen.js（和 GUI、网页版同一份实现，不会漂移）
 *   · 免费 AI 走账号令牌，令牌存在 %APPDATA%\CyanCodex\auth.json
 *
 * 典型用法：
 *   cyancodex gen tdisplay --objective coins --name 金币 --line "金币:@s/coins"
 *   cyancodex gen enumerate --template "give @s {item} 1" --var "item=stone,dirt"
 *   cyancodex lib search 计分板 --size 5
 *   cyancodex ai "做一个倒计时计分板" -o timer.mcfunction
 * ========================================================================== */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync, spawn } = require("child_process");

const C = require("../core/config");
const G = require("../core/gen");
const API = require("../core/api");

/* ------------------------------------------------------------------ 输出 */

const USE_COLOR = (() => {
  if (process.env.NO_COLOR) return false;
  if (process.argv.includes("--no-color")) return false;
  return !!process.stdout.isTTY;
})();

const C_ = (code) => (s) => (USE_COLOR ? "\x1b[" + code + "m" + s + "\x1b[0m" : String(s));
const cGreen = C_("32"), cGray = C_("90"), cRed = C_("31"), cYellow = C_("33"),
      cCyan = C_("36"), cBold = C_("1"), cDim = C_("2");

function die(msg, code) {
  process.stderr.write(cRed("✗ ") + msg + "\n");
  process.exit(code === undefined ? 1 : code);
}

function info(msg) { process.stderr.write(cGray(msg) + "\n"); }

/* 把指令数组排版输出：注释灰、指令绿，带序号 */
function renderLines(lines, opts) {
  opts = opts || {};
  const out = [];
  let n = 0;
  lines.forEach((line) => {
    if (line === "") { out.push(""); return; }
    if (String(line).startsWith("#")) {
      out.push(opts.plain ? line : cGray(line));
    } else {
      n++;
      const no = opts.number === false ? "" : cDim(String(n).padStart(2, " ") + "  ");
      out.push(no + (opts.plain ? line : cGreen(line)));
    }
  });
  return out.join("\n");
}

function copyToClipboard(text) {
  try {
    if (process.platform === "win32") {
      const r = spawnSync("clip", [], { input: text, windowsHide: true });
      return r.status === 0;
    }
    if (process.platform === "darwin") {
      return spawnSync("pbcopy", [], { input: text }).status === 0;
    }
    return spawnSync("xclip", ["-selection", "clipboard"], { input: text }).status === 0;
  } catch (_) {
    return false;
  }
}

/* 统一收尾：--json / -o / --copy / 终端输出 */
function emit(lines, opts, meta) {
  const text = lines.join("\n");

  if (opts.out) {
    const file = path.resolve(opts.out);
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, text.replace(/\r?\n/g, "\n") + "\n", "utf8");
    info("已写入 " + file + "（" + lines.filter((l) => l && !String(l).startsWith("#")).length + " 条指令）");
  }

  if (opts.copy) {
    const copied = copyToClipboard(text);
    info(copied ? "已复制到剪贴板" : "复制失败：当前环境没有 clip 命令");
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify({
      ok: true,
      count: lines.filter((l) => l && !String(l).startsWith("#")).length,
      lines,
      text,
      meta: meta || null,
    }, null, 2) + "\n");
  } else if (!opts.out) {
    process.stdout.write(renderLines(lines, { plain: opts.plain, number: opts.number }) + "\n");
  }

  C.appendHistory(Object.assign({ cmd: process.argv[2] || "", lines }, meta || {}));
  return 0;
}

/* ------------------------------------------------------------------ 参数 */

function parseArgs(argv) {
  const out = { _: [], f: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { out._.push(...argv.slice(i + 1)); break; }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) { out.f[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) { out.f[key] = next; i++; }
      else out.f[key] = true;
      continue;
    }
    if (a.length === 2 && a[0] === "-" && a[1] !== "-") {
      const key = a.slice(1);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) { out.f[key] = next; i++; }
      else out.f[key] = true;
      continue;
    }
    out._.push(a);
  }
  return out;
}

function flag(args, ...names) {
  for (const n of names) if (args.f[n] !== undefined) return args.f[n];
  return undefined;
}

function numFlag(args, names, dflt) {
  const v = flag(args, ...names);
  if (v === undefined || v === true) return dflt;
  const n = Number(v);
  return isFinite(n) ? n : dflt;
}

/* 同名参数可以重复给（比如 --line 多次） */
function multi(args, name) {
  const raw = process.argv;
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "--" + name) { if (raw[i + 1] !== undefined) out.push(raw[i + 1]); }
    else if (raw[i].startsWith("--" + name + "=")) out.push(raw[i].slice(name.length + 3));
  }
  if (!out.length && args.f[name] !== undefined && args.f[name] !== true) out.push(args.f[name]);
  return out;
}

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch (_) {
    return "";
  }
}

/* ============================================================== 子命令 */

const HELP = `
${cBold("CyanCodex")} ${cDim("v" + C.VERSION)} —— Minecraft 基岩版指令助手（桌面版）

${cBold("用法")}
  cyancodex                       启动桌面窗口
  cyancodex gui                   同上
  cyancodex serve [--port N]      只起本地服务（浏览器访问）
  cyancodex gen <工具> [选项]     生成指令
  cyancodex lib <子命令>          查指令库
  cyancodex ai <描述>             调免费 AI 生成指令
  cyancodex login <用户> <密码>   登录（AI 需要）
  cyancodex whoami | logout       账号状态
  cyancodex config [get|set] ...  读写配置
  cyancodex history [-n 10]       最近的生成记录
  cyancodex update                检查是否有新版本
  cyancodex version               版本信息

${cBold("生成器")}  ${cDim("全部本地计算，不联网")}
  gen tdisplay   --objective sb --name 金币 --line "金币:@s/coins" [--tpos title]
  gen enumerate  --template "give @s {item} 1" --var "item=stone,dirt" [--limit 100]
  gen scroll     --text "欢迎来到服务器" [--color gold] [--mode banner --x 0 --y 64 --z 0 --gap 2]
  gen music      --events "0:harp:0,4:bell:7" [--loop]
  gen rawjson    --target @a --pos title --segment "text:你好:green"

${cBold("通用选项")}
  -o, --out <文件>    写入 .mcfunction（不打印到终端）
  --copy              复制到剪贴板
  --json              输出 JSON（给脚本用）
  --plain             不带颜色
  --no-color          同上
  --number false      不显示行号

${cBold("例子")}
  cyancodex gen tdisplay --objective coins --name 金币 --line "金币:@s/coins" --copy
  cyancodex ai "做一个倒计时计分板，初始 60 秒" -o timer.mcfunction
  cyancodex lib search 计分板 --size 5 --json
`;

/* ---------------------------------------------------------- gen */

function cmdGen(args) {
  const tool = args._[0];
  const common = {
    out: flag(args, "o", "out"),
    copy: !!flag(args, "copy"),
    json: !!flag(args, "json"),
    plain: !!flag(args, "plain"),
    noColor: !!flag(args, "no-color"),
    number: flag(args, "number"),
  };
  if (common.number === "false") common.number = false;

  if (!tool) die("缺少生成器名称。可用：" + "tdisplay / enumerate / scroll / music / rawjson\n  例：cyancodex gen tdisplay --objective coins --name 金币 --line \"金币:@s/coins\"");

  let lines;
  let meta = { tool };

  if (tool === "tdisplay" || tool === "sb" || tool === "scoreboard") {
    const tlines = multi(args, "line").map((s) => {
      // 支持 "前缀:@s/obj:后缀" 或 "obj" 或 "obj:后缀"
      const m = String(s).match(/^(.*?):@s\/([A-Za-z0-9_]+)(?::(.*))?$/);
      if (m) return { prefix: m[1], objective: m[2], suffix: m[3] || "" };
      const parts = String(s).split(":");
      if (parts.length >= 2) return { objective: parts[0], suffix: parts.slice(1).join(":") };
      return { objective: s };
    });
    const objective = String(flag(args, "objective", "obj") || "coins");
    lines = G.scoreboard({
      mode: "tdisplay",
      objective,
      displayName: String(flag(args, "name", "display") || objective),
      tpos: String(flag(args, "tpos", "pos") || "title"),
      tlines,
    });
    meta.objective = objective;
  } else if (tool === "enumerate" || tool === "enum") {
    const template = String(flag(args, "template", "t") || "");
    if (!template) die("enumerate 需要 --template，例如 --template \"give @s {item} 1\"");
    const variables = {};
    multi(args, "var").forEach((pair) => {
      const i = String(pair).indexOf("=");
      if (i <= 0) return;
      variables[String(pair).slice(0, i)] = String(pair).slice(i + 1).split(",").map((s) => s.trim()).filter(Boolean);
    });
    if (!Object.keys(variables).length) die("enumerate 至少需要一个 --var，例如 --var \"item=stone,dirt\"");
    lines = G.enumerate(template, variables, numFlag(args, ["limit"], 200));
    meta.variables = variables;
  } else if (tool === "scroll" || tool === "scroller") {
    let text = String(flag(args, "text", "t") || "");
    if (text === "-" || text === "") text = readStdin().trim();
    if (!text) die("scroll 需要 --text（可以传 - 从 stdin 读）");
    const mode = String(flag(args, "mode") || "scroll");
    lines = G.scroller({
      text,
      color: String(flag(args, "color") || "gold"),
      mode,
      gap: numFlag(args, ["gap"], 2),
      x: numFlag(args, ["x"], 0),
      y: numFlag(args, ["y"], 64),
      z: numFlag(args, ["z"], 0),
    });
    meta.mode = mode;
  } else if (tool === "music") {
    const raw = String(flag(args, "events", "e") || "");
    const events = [];
    if (raw) {
      raw.split(",").forEach((item) => {
        const p = item.split(":");
        if (p.length < 2) return;
        events.push({
          tick: Number(p[0]) || 0,
          instrument: (p[1] || "harp").trim(),
          note: Number(p[2] || 0) || 0,
        });
      });
    }
    if (!events.length) die("music 需要 --events，格式 tick:乐器:音高，多个用逗号分隔\n  例：--events \"0:harp:0,4:bell:7\"");
    lines = G.music({ events, loop: !!flag(args, "loop") });
    meta.events = events.length;
  } else if (tool === "rawjson" || tool === "titleraw") {
    const segs = multi(args, "segment").map((s) => {
      const p = String(s).split(":");
      const kind = p[0];
      if (kind === "selector") return { kind: "selector", selector: p[1] || "@p" };
      if (kind === "score") return { kind: "score", name: p[1] || "@s", obj: p[2] || "sb" };
      if (kind === "translate") return { kind: "translate", key: p[1] || "item.apple.name" };
      if (kind === "color") return { kind: "color", text: p[1] || "", color: p[2] || "white" };
      return { kind: "text", text: p[1] !== undefined ? p[1] : String(s) };
    });
    if (!segs.length) die("rawjson 需要至少一个 --segment，例如 --segment \"text:你好:green\"");
    lines = [G.titleraw(String(flag(args, "target") || "@a"), String(flag(args, "pos") || "title"), segs)];
  } else if (tool === "instruments") {
    G.instruments().forEach((i) => process.stdout.write(i.key.padEnd(16) + i.name + "\n"));
    return 0;
  } else {
    die("不认识的生成器：" + tool + "。可用：tdisplay / enumerate / scroll / music / rawjson / instruments");
  }

  return emit(lines, common, meta);
}

/* ---------------------------------------------------------- lib */

async function cmdLib(args) {
  const sub = args._[0] || "search";
  const json = !!flag(args, "json");

  if (sub === "cat" || sub === "categories") {
    const cats = await API.categories();
    if (json) { process.stdout.write(JSON.stringify(cats, null, 2) + "\n"); return 0; }
    const list = Array.isArray(cats) ? cats : (cats.categories || []);
    list.forEach((c) => {
      const name = c.name || c.cat || c;
      const n = c.count !== undefined ? cDim("  " + c.count + " 条") : "";
      process.stdout.write(cCyan(String(name)) + n + "\n");
    });
    return 0;
  }

  if (sub === "get" || sub === "show") {
    const id = args._[1];
    if (!id) die("用法：cyancodex lib get <id>");
    const d = await API.cmd(id);
    const item = d.cmd || d.item || d;
    if (json) { process.stdout.write(JSON.stringify(item, null, 2) + "\n"); return 0; }
    process.stdout.write(cBold(item.title || item.name || id) + "\n");
    if (item.desc) process.stdout.write(cGray(item.desc) + "\n");
    const code = item.code || item.command || "";
    if (code) process.stdout.write("\n" + renderLines(String(code).split(/\r?\n/), {}) + "\n");
    return 0;
  }

  // 默认 search
  const q = args._[1] !== undefined ? args._[1] : "";
  const res = await API.cmds({
    q,
    cat: flag(args, "cat", "c"),
    size: numFlag(args, ["size", "n"], 10),
    page: numFlag(args, ["page"], 1),
  });
  const list = res.items || res.list || res.cmds || res.data || (Array.isArray(res) ? res : []);
  if (json) { process.stdout.write(JSON.stringify(res, null, 2) + "\n"); return 0; }
  if (!list.length) { info("没有匹配的指令"); return 0; }
  list.forEach((it, i) => {
    const title = it.title || it.name || "(无标题)";
    const tags = [it.cat, it.paid ? "付费" : null, it.quality ? "高质" : null].filter(Boolean).join(" · ");
    process.stdout.write(
      cDim(String(i + 1).padStart(2, " ") + ". ") + cBold(title) +
      (tags ? cDim("   [" + tags + "]") : "") + "\n"
    );
    if (it.desc) process.stdout.write("    " + cGray(String(it.desc).slice(0, 70)) + "\n");
    if (it.code) process.stdout.write("    " + cGreen(String(it.code).split(/\r?\n/)[0].slice(0, 70)) + "\n");
    process.stdout.write(cDim("    id: " + (it.id || it._id || "?")) + "\n");
  });
  const total = res.total !== undefined ? res.total : list.length;
  info("共 " + total + " 条，显示 " + list.length + " 条。详情：cyancodex lib get <id>");
  return 0;
}

/* ---------------------------------------------------------- ai */

async function cmdAi(args) {
  const prompt = args._.join(" ").trim() || readStdin().trim();
  if (!prompt) die("用法：cyancodex ai \"描述你要的指令\"");
  if (!C.isLoggedIn()) die("免费 AI 需要登录。先运行：cyancodex login <用户名> <密码>");

  const mode = String(flag(args, "mode") || "chat");
  const common = {
    out: flag(args, "o", "out"),
    copy: !!flag(args, "copy"),
    json: !!flag(args, "json"),
    plain: !!flag(args, "plain"),
    number: flag(args, "number"),
  };

  const stream = !common.json && !common.out && process.stdout.isTTY;
  let acc = "";
  if (stream) process.stdout.write(cGray("… 生成中\n"));

  try {
    acc = await API.chat({
      mode,
      messages: [{ role: "user", content: prompt }],
      onDelta: stream ? (piece) => process.stdout.write(piece) : null,
    });
  } catch (e) {
    if (e.status === 401) die("登录已过期，重新运行：cyancodex login <用户名> <密码>");
    die("AI 调用失败：" + e.message);
  }

  // 从回复里抽出代码块里的指令；没有代码块就把整段里 / 开头的行当指令
  const cmds = [];
  const re = /```[a-zA-Z]*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(acc)) !== null) {
    m[1].split(/\r?\n/).forEach((l) => {
      const t = l.trim();
      if (t.startsWith("/")) cmds.push(t);
    });
  }
  if (!cmds.length) {
    acc.split(/\r?\n/).forEach((l) => {
      const t = l.trim();
      if (t.startsWith("/")) cmds.push(t);
    });
  }

  // 说明文字：去掉围栏行、去掉指令行，剩下的就是模型给的解释
  const explain = acc.split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("```") && !l.startsWith("/"));

  if (stream) process.stdout.write("\n");

  if (common.json) {
    process.stdout.write(JSON.stringify({
      ok: true, prompt, mode, reply: acc, commands: cmds, explain,
    }, null, 2) + "\n");
    C.appendHistory({ cmd: "ai", prompt, lines: cmds });
    return 0;
  }
  if (common.out) {
    const file = path.resolve(common.out);
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, cmds.join("\n") + "\n", "utf8");
    info("已写入 " + file + "（" + cmds.length + " 条指令）");
    C.appendHistory({ cmd: "ai", prompt, lines: cmds });
    return 0;
  }
  if (!stream) {
    if (cmds.length) {
      process.stdout.write(cBold("指令 " + cmds.length + " 条") + "\n");
      process.stdout.write(renderLines(cmds, { plain: common.plain, number: common.number }) + "\n");
    }
    if (explain.length) {
      process.stdout.write("\n" + cBold("说明") + "\n");
      explain.forEach((l) => process.stdout.write("  " + cGray(l) + "\n"));
    }
    if (!cmds.length && !explain.length) {
      process.stdout.write(cYellow("模型没有返回内容，重试一次看看") + "\n");
    }
  }
  if (common.copy && cmds.length) {
    info(copyToClipboard(cmds.join("\n")) ? "已复制 " + cmds.length + " 条指令到剪贴板" : "复制失败");
  }
  C.appendHistory({ cmd: "ai", prompt, lines: cmds });
  return 0;
}

/* ---------------------------------------------------------- 账号 */

async function cmdLogin(args) {
  const user = args._[0];
  const pass = args._[1];
  if (!user || !pass) die("用法：cyancodex login <用户名> <密码>");
  const auth = await API.login(user, pass);
  const u = auth.user || {};
  process.stdout.write(cGreen("✓ ") + "已登录 " + cBold(u.nickname || u.username || user) +
    (u.points !== undefined ? cDim("  （积分 " + u.points + "）") : "") + "\n");
  info("令牌保存在 " + C.AUTH_FILE);
  return 0;
}

async function cmdWhoami() {
  if (!C.isLoggedIn()) {
    process.stdout.write(cYellow("未登录") + cDim("  免费 AI 需要账号：cyancodex login <用户名> <密码>") + "\n");
    return 0;
  }
  const cached = API.currentUser() || {};
  process.stdout.write(cGreen("✓ ") + "已登录 " + cBold(cached.nickname || cached.username || "?") + "\n");
  try {
    const fresh = await API.me();
    process.stdout.write(cDim("  id " + fresh.id + " · 积分 " + (fresh.points || 0) +
      " · AI " + (fresh.ai_unlocked ? "已解锁" : "未解锁") + "\n"));
  } catch (e) {
    process.stdout.write(cYellow("  （令牌可能已过期：" + e.message + "）") + "\n");
  }
  return 0;
}

function cmdLogout() {
  C.clearAuth();
  process.stdout.write(cGreen("✓ ") + "已退出登录\n");
  return 0;
}

/* ---------------------------------------------------------- config */

function cmdConfig(args) {
  const sub = args._[0] || "list";
  if (sub === "list" || sub === "ls") {
    process.stdout.write(JSON.stringify(C.load(), null, 2) + "\n");
    return 0;
  }
  if (sub === "get") {
    const v = C.get(args._[1]);
    process.stdout.write((typeof v === "object" ? JSON.stringify(v, null, 2) : String(v)) + "\n");
    return 0;
  }
  if (sub === "set") {
    const key = args._[1];
    let val = args._[2];
    if (!key) die("用法：cyancodex config set <key> <value>");
    if (val === "true") val = true;
    else if (val === "false") val = false;
    else if (val !== undefined && /^-?\d+$/.test(val)) val = Number(val);
    C.set(key, val);
    process.stdout.write(cGreen("✓ ") + key + " = " + JSON.stringify(val) + "\n");
    return 0;
  }
  if (sub === "path") {
    process.stdout.write(C.HOME + "\n");
    return 0;
  }
  die("config 子命令：list | get <key> | set <key> <value> | path");
}

/* ---------------------------------------------------------- history */

function cmdHistory(args) {
  const n = numFlag(args, ["n", "limit"], 10);
  const rows = C.readHistory(n);
  if (!rows.length) { info("还没有生成记录"); return 0; }
  rows.forEach((r) => {
    const when = new Date(r.ts).toLocaleString("zh-CN");
    const n2 = (r.lines || []).filter((l) => l && !String(l).startsWith("#")).length;
    process.stdout.write(cDim(when) + "  " + cBold(r.cmd || "gen") + "  " + n2 + " 条\n");
    (r.lines || []).slice(0, 2).forEach((l) => process.stdout.write("    " + cGray(String(l).slice(0, 72)) + "\n"));
  });
  info("完整记录：" + C.HISTORY_FILE);
  return 0;
}

/* ---------------------------------------------------------- update */

async function cmdUpdate() {
  const v = await API.version();
  const cur = C.VERSION;
  process.stdout.write("当前版本 " + cBold("v" + cur) + "，服务端最新 " + cBold("v" + (v.latest || "?")) + "\n");
  const cmp = compareVer(v.latest || "0", cur);
  if (cmp > 0) {
    process.stdout.write(cYellow("有新版本：") + (v.notes || []).join("\n  ") + "\n");
    if (v.url) process.stdout.write(cDim("下载：" + v.url) + "\n");
  } else {
    process.stdout.write(cGreen("✓ ") + "已是最新\n");
  }
  return 0;
}

function compareVer(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/* ---------------------------------------------------------- serve / gui */

async function cmdServe(args) {
  const port = numFlag(args, ["port", "p"], 0);
  const server = require("../server");
  const { url } = await server.start(port);
  process.stdout.write(cGreen("✓ ") + "本地服务已启动 " + cBold(url) + "\n");
  info("Ctrl+C 停止。这个地址只对本机可见。");
  if (flag(args, "open")) {
    const cmd = process.platform === "win32" ? "explorer" : process.platform === "darwin" ? "open" : "xdg-open";
    spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
  }
  // 保持前台运行
  await new Promise(() => {});
}

function cmdGui(args) {
  // 打包后：直接拉起同目录的 CyanCodex.exe（不带参数 = GUI）
  // 开发时：拉起 electron .
  const root = path.join(__dirname, "..");
  const isPackaged = !!process.env.CYANCODEX_PACKAGED;
  if (isPackaged) {
    const exe = path.join(path.dirname(process.execPath), "CyanCodex.exe");
    spawn(exe, [], { detached: true, stdio: "ignore" }).unref();
  } else {
    const electronBin = require("electron");
    spawn(electronBin, [root], { detached: true, stdio: "ignore" }).unref();
  }
  process.stdout.write(cGreen("✓ ") + "正在启动 CyanCodex 桌面窗口…\n");
  return 0;
}

/* ============================================================== 入口 */

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  // ★ 把命令名从位置参数里摘掉，后面的子命令才能直接读 args._[0]
  const cmd = args._.shift() || "";

  if (!cmd) {
    if (!process.stdout.isTTY && !argv.length) return 0;
    process.stdout.write(HELP);
    return 0;
  }

  switch (cmd) {
    case "-h": case "--help": case "help":
      process.stdout.write(HELP); return 0;
    case "-v": case "--version": case "version":
      process.stdout.write("CyanCodex " + C.VERSION + "  (node " + process.versions.node + ", " + process.platform + ")\n");
      process.stdout.write("配置目录 " + C.HOME + "\n");
      return 0;
    case "gui": case "app": case "start":
      return cmdGui(args);
    case "serve":
      return cmdServe(args);
    case "gen": case "g":
      return cmdGen(args);
    case "lib": case "library":
      return cmdLib(args);
    case "ai": case "ask":
      return cmdAi(args);
    case "login":
      return cmdLogin(args);
    case "logout":
      return cmdLogout();
    case "whoami": case "me":
      return cmdWhoami();
    case "config": case "cfg":
      return cmdConfig(args);
    case "history": case "hist":
      return cmdHistory(args);
    case "update":
      return cmdUpdate();
    default:
      // 兼容 `cyancodex tdisplay ...` 这种省略 gen 的写法
      if (["tdisplay", "enumerate", "scroll", "music", "rawjson", "instruments"].includes(cmd)) {
        return cmdGen(args);
      }
      process.stderr.write(cRed("✗ ") + "不认识的命令：" + cmd + "\n");
      process.stdout.write(HELP);
      return 1;
  }
}

main().then((code) => {
  if (typeof code === "number") process.exitCode = code;
}).catch((e) => {
  die(e && e.message ? e.message : String(e));
});
