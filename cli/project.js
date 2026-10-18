/* ============================================================================
 * cli/project.js —— 面向「本地工程」的三个命令：lint / pack / watch
 *
 * 为什么单独放一个文件：
 *   index.js 已经有 600+ 行，再塞工程管理会看不清主次。而且这三个命令是
 *   **桌面端独有的价值** —— 手机上没有文件系统，做不了「打开一个 datapack
 *   目录、批量校验、一键打包」。
 *
 * 三个命令的定位：
 *   lint  —— 把「游戏里试错」提前到「保存时就知道」。基岩版命令报错只会
 *            在聊天栏吐一行看不懂的话，函数里几百条指令根本没法定位。
 *   pack  —— 把目录打成 .mcpack / .zip，直接丢进游戏就能用，不用手动压。
 *   watch —— 改文件自动重新 lint/pack，配合编辑器等于「保存即部署」。
 *
 * 设计约束：
 *   · 不引第三方依赖。zip 用系统自带的 PowerShell Compress-Archive（Windows）
 *     或 zip 命令（Linux/macOS），都没有就退回「只校验不打包」并说明原因。
 *   · 所有输出默认给人看，`--json` 给脚本用。
 * ========================================================================== */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

/* ------------------------------------------------------------------ 输出 */

const USE_COLOR = (() => {
  if (process.env.NO_COLOR) return false;
  if (process.argv.includes("--no-color")) return false;
  return !!process.stdout.isTTY;
})();

const wrap = (code) => (s) => (USE_COLOR ? "\x1b[" + code + "m" + s + "\x1b[0m" : String(s));
const red = wrap("31"), green = wrap("32"), yellow = wrap("33"),
      cyan = wrap("36"), gray = wrap("90"), bold = wrap("1");

function ok(msg) { process.stdout.write(green("✓ ") + msg + "\n"); }
function warn(msg) { process.stdout.write(yellow("! ") + msg + "\n"); }
function fail(msg) { process.stderr.write(red("✗ ") + msg + "\n"); }
function info(msg) { process.stdout.write(msg + "\n"); }

/* ------------------------------------------------------------------ 参数 */

/**
 * 极简参数解析：`--key value` 和 `--flag`，剩下的当位置参数。
 * 不引 yargs/minimist —— 三个命令不值得加依赖。
 */
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

/* ------------------------------------------------------------------ lint */

/**
 * 单行检查。返回 {level: "error"|"warn", msg} 或 null。
 *
 * ★ 只做**静态可判**的检查。命令是否存在、参数类型对不对，得连服务器或查
 *   版本表，这里不做 —— 假阳性比不检查更烦人。
 */
function checkLine(raw, lineNo, isMcFunction) {
  const line = raw.replace(/\s+$/, "");
  if (!line.trim()) return null;

  // 函数文件里的注释：基岩版用 #（Java 版是 //，但基岩版只认 #）
  if (line.trim().startsWith("#")) return null;

  if (!line.trim().startsWith("/")) {
    // .mcfunction 里每条都必须是命令，缺 / 是最常见的错误
    if (isMcFunction) {
      return { level: "error", msg: "缺少开头的 /（函数文件里每行都必须是完整命令）" };
    }
    return null;
  }

  // 引号配对：基岩版的 tellraw/titleraw 里 JSON 引号没闭合，游戏只报
  // "Unexpected token"，完全看不出是哪一行
  const dq = (line.match(/"/g) || []).length;
  if (dq % 2 !== 0) {
    return { level: "error", msg: "双引号数量是奇数，可能有未闭合的字符串" };
  }

  // 常见的「中文标点混进命令」—— 从聊天框复制粘贴时高发
  if (/[，。；：（）【】“”‘’]/.test(line)) {
    return { level: "warn", msg: "含中文标点（，。；：等），游戏会当成普通字符处理" };
  }

  // 连续空格
  if (/  +/.test(line)) {
    return { level: "warn", msg: "有多余的连续空格" };
  }

  // execute 后面必须有子命令，否则等于空转
  if (/^\/execute\s+(@[a-z]|as\s|at\s|if\s|unless\s)/.test(line) && !/\srun\s/.test(line)) {
    return { level: "warn", msg: "execute 里没有 run，可能少了要执行的子命令" };
  }

  return null;
}

function lintFile(file) {
  const isMcFunction = file.toLowerCase().endsWith(".mcfunction");
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    return [{ line: 0, level: "error", msg: "读不了文件：" + e.message }];
  }

  const lines = text.split(/\r?\n/);
  const issues = [];
  lines.forEach((raw, i) => {
    const r = checkLine(raw, i + 1, isMcFunction);
    if (r) issues.push({ line: i + 1, level: r.level, msg: r.msg });
  });
  return issues;
}

/** 递归收集要检查的文件 */
function collectFiles(target) {
  const stat = fs.statSync(target);
  if (stat.isFile()) return [target];

  const out = [];
  (function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      if (name === ".git" || name === "node_modules" || name === ".gradle") continue;
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else if (/\.(mcfunction|json|mcmeta)$/i.test(name)) out.push(p);
    }
  })(target);
  return out;
}

function cmdLint(argv) {
  const args = parseArgs(argv);
  const target = args._[0];
  if (!target) {
    fail("用法：cyancodex lint <文件或目录> [--json] [--strict]");
    return 2;
  }
  if (!fs.existsSync(target)) {
    fail("路径不存在：" + target);
    return 2;
  }

  const files = collectFiles(target);
  if (!files.length) {
    warn("没有找到 .mcfunction / .json / .mcmeta 文件");
    return 0;
  }

  const results = [];
  let errors = 0, warns = 0;
  for (const f of files) {
    const issues = lintFile(f);
    for (const it of issues) {
      if (it.level === "error") errors++;
      else warns++;
      results.push({ file: f, line: it.line, level: it.level, msg: it.msg });
    }
  }

  if (args.json) {
    info(JSON.stringify({ files: files.length, errors, warns, results }, null, 2));
    return errors ? 1 : 0;
  }

  for (const r of results) {
    const tag = r.level === "error" ? red("错误") : yellow("警告");
    info(`${gray(path.relative(process.cwd(), r.file))}:${cyan(String(r.line))}  ${tag}  ${r.msg}`);
  }

  const summary = `检查 ${files.length} 个文件，${errors} 个错误，${warns} 个警告`;
  if (errors) { fail(summary); return 1; }
  if (warns && args.strict) { fail(summary + "（--strict 模式下警告也算失败）"); return 1; }
  ok(summary);
  return 0;
}

/* ------------------------------------------------------------------ pack */

/**
 * 打 zip。优先用系统自带工具，避免引依赖。
 * 返回 {ok, message}。
 */
function zipDir(srcDir, outFile) {
  const isWin = process.platform === "win32";

  if (isWin) {
    // Compress-Archive 在 Win10+ 自带；-Force 覆盖同名文件
    const ps = [
      "-NoProfile", "-NonInteractive", "-Command",
      `Compress-Archive -Path '${srcDir.replace(/'/g, "''")}\\*' -DestinationPath '${outFile.replace(/'/g, "''")}' -Force`,
    ];
    const r = spawnSync("powershell", ps, { encoding: "utf8" });
    if (r.status !== 0) return { ok: false, message: (r.stderr || r.stdout || "Compress-Archive 失败").slice(0, 200) };
    return { ok: true };
  }

  // Linux / macOS
  const r = spawnSync("zip", ["-r", "-q", outFile, "."], { cwd: srcDir, encoding: "utf8" });
  if (r.error) return { ok: false, message: "没有 zip 命令，请先安装 zip" };
  if (r.status !== 0) return { ok: false, message: (r.stderr || "").slice(0, 200) };
  return { ok: true };
}

function cmdPack(argv) {
  const args = parseArgs(argv);
  const dir = args._[0];
  if (!dir) {
    fail("用法：cyancodex pack <datapack 目录> [-o 输出文件] [--json]");
    return 2;
  }
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    fail("不是目录：" + dir);
    return 2;
  }

  // 结构检查：datapack 必须有 pack.mcmeta，否则游戏直接忽略
  const hasMeta = fs.existsSync(path.join(dir, "pack.mcmeta"));
  const hasData = fs.existsSync(path.join(dir, "data"));
  if (!hasMeta) warn("缺少 pack.mcmeta —— 游戏会忽略这个包");
  if (!hasData) warn("缺少 data/ 目录 —— 里面应该放 functions/ 等");

  // 打包前先 lint 一遍，有错误就不打
  const files = collectFiles(dir).filter((f) => f.toLowerCase().endsWith(".mcfunction"));
  let errors = 0;
  for (const f of files) errors += lintFile(f).filter((i) => i.level === "error").length;
  if (errors) {
    fail(`有 ${errors} 个语法错误，先跑 cyancodex lint 修完再打包`);
    return 1;
  }

  const out = args.o || args.output || path.basename(path.resolve(dir)) + ".mcpack";
  const outAbs = path.resolve(out);
  const r = zipDir(path.resolve(dir), outAbs);
  if (!r.ok) {
    fail("打包失败：" + r.message);
    return 1;
  }

  const size = fs.statSync(outAbs).size;
  if (args.json) {
    info(JSON.stringify({ ok: true, out: outAbs, size, functions: files.length }, null, 2));
  } else {
    ok(`已打包 → ${outAbs}  (${(size / 1024).toFixed(1)} KB, ${files.length} 个函数文件)`);
    info(gray("  把 .mcpack 丢进游戏即可导入；改扩展名为 .zip 可以直接看内容"));
  }
  return 0;
}

/* ------------------------------------------------------------------ watch */

function cmdWatch(argv) {
  const args = parseArgs(argv);
  const dir = args._[0];
  if (!dir) {
    fail("用法：cyancodex watch <目录> [--pack] [--out 输出.mcpack]");
    return 2;
  }
  if (!fs.existsSync(dir)) {
    fail("路径不存在：" + dir);
    return 2;
  }

  info(bold("监听 ") + dir + gray("  （Ctrl+C 退出）"));

  let timer = null;
  const run = () => {
    const files = collectFiles(dir).filter((f) => f.toLowerCase().endsWith(".mcfunction"));
    let errors = 0, warns = 0;
    for (const f of files) {
      for (const it of lintFile(f)) {
        if (it.level === "error") {
          errors++;
          fail(`${path.relative(dir, f)}:${it.line}  ${it.msg}`);
        } else warns++;
      }
    }
    const ts = new Date().toTimeString().slice(0, 8);
    if (errors) fail(`[${ts}] ${files.length} 文件 · ${errors} 错误 · ${warns} 警告`);
    else ok(`[${ts}] ${files.length} 文件 · 0 错误 · ${warns} 警告`);

    if (args.pack && !errors) {
      const out = path.resolve(args.out || path.basename(path.resolve(dir)) + ".mcpack");
      const r = zipDir(path.resolve(dir), out);
      if (r.ok) ok("  已重新打包 → " + out);
      else fail("  打包失败：" + r.message);
    }
  };

  run();

  // ★ 递归监听：fs.watch 的 recursive 在 Windows/macOS 可用，Linux 早期不支持，
  //   所以再对每个子目录单独 watch 一次兜底。
  const watchers = [];
  const add = (d) => {
    try {
      const w = fs.watch(d, { persistent: true }, () => {
        // 编辑器保存常触发多次事件，合并成一次
        clearTimeout(timer);
        timer = setTimeout(run, 300);
      });
      watchers.push(w);
    } catch (_) { /* ignore */ }
  };
  add(dir);
  (function walk(d) {
    for (const name of fs.readdirSync(d)) {
      if (name === ".git" || name === "node_modules") continue;
      const p = path.join(d, name);
      if (fs.statSync(p).isDirectory()) { add(p); walk(p); }
    }
  })(dir);

  process.on("SIGINT", () => {
    watchers.forEach((w) => { try { w.close(); } catch (_) {} });
    info(gray("\n已停止监听"));
    process.exit(0);
  });
  return 0;   // 不返回，靠 SIGINT 退出
}

module.exports = { cmdLint, cmdPack, cmdWatch };
