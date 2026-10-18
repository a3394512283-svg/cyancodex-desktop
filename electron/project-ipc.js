/* ============================================================================
 * electron/project-ipc.js —— 本地 Minecraft 数据包（datapack）项目管理
 *
 * 这是「手机端根本做不到」的那一类能力：直接读写用户磁盘上的项目目录、
 * 原子保存、调系统命令打包 .mcpack。浏览器里连目录路径都拿不到。
 *
 * 设计要点：
 *   · 根目录只认「用户亲手在原生对话框里选过」的那一个，存在模块变量里。
 *     渲染层是 web 页面，理论上可以被注入/被改，所以任何路径参数都必须先过
 *     assertInside() —— 否则一句 ../../windows/system32 就能读到系统文件。
 *   · 读文件只放行文本后缀 + 嗅探 NUL 字节，避免把 png/zip 当文本读进内存
 *     再塞给 textarea（既卡又没意义）。
 *   · 写文件走「同目录 .tmp → rename」，中途崩溃不会留下半个文件。
 *   · 打包用系统自带工具（Windows 的 Compress-Archive / 其他平台的 zip），
 *     不引入任何第三方依赖。
 * ========================================================================== */
"use strict";

const fs = require("fs");
const path = require("path");
const { app, dialog } = require("electron");
const { spawn } = require("child_process");

/* 扫描时整个跳过的目录：版本库、依赖、构建产物，翻它们没有意义还会拖慢扫描 */
const SKIP_DIRS = { ".git": 1, "node_modules": 1, ".gradle": 1, "build": 1 };

const MAX_DEPTH = 12;                     // 深度上限：防符号链接/恶意目录把栈打爆
const MAX_NODES = 8000;                   // 节点数上限：超大目录树不把 IPC 通道灌满
const MAX_READ = 8 * 1024 * 1024;         // 单文件 8MB 以上不在编辑器里打开

/* 允许当文本编辑的后缀（与 web/desktop-project.js 里的 TEXT_RE 保持一致） */
const TEXT_EXT = {
  ".mcfunction": 1, ".json": 1, ".mcmeta": 1, ".txt": 1,
  ".md": 1, ".yml": 1, ".yaml": 1, ".lang": 1,
};

/* ★ 只记住最近一次 pick-dir 的根目录。
   放模块变量而不是配置文件：进程重启即失效，等于每次都重新征求用户授权，
   比「永久记住一个路径」安全得多。 */
let rootDir = null;    // 用户选中的原始路径（展示用）
let rootReal = null;   // 同上，但已经过 realpath（比较用）

/* ------------------------------------------------------------ 路径安全 */

/* 取「真实路径」：目标可能还不存在（新建文件 / 写新文件），
   所以从它往上找到最近一个存在的祖先做 realpath，再把剩余段接回去。
   为什么必须 realpath：不解析符号链接的话，root 里放一个指向 C:\Windows 的
   链接就能绕过「前缀比较」—— 前缀比的是字面路径，链接指向哪儿它不知道。 */
function realResolve(p) {
  const abs = path.resolve(String(p || ""));
  const tail = [];
  let cur = abs;
  for (let i = 0; i < 64; i++) {
    try {
      const real = fs.realpathSync(cur);
      return tail.length ? path.join.apply(path, [real].concat(tail.reverse())) : real;
    } catch (_) {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;     // 到盘根了还没找到，退回字面路径
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
  return abs;
}

/* 把渲染层传来的任意路径钉死在 rootReal 之内。
   path.relative 在 Windows 上是大小写不敏感的，所以 C:\Foo 与 c:\foo 不会被误判；
   跨盘符时 relative 会返回绝对路径，用 isAbsolute 兜住。 */
function assertInside(p) {
  if (!rootDir || !rootReal) {
    const e = new Error("还没有选择项目目录");
    e.code = "NO_ROOT";
    throw e;
  }
  if (typeof p !== "string" || !p.trim()) throw new Error("路径为空");
  const abs = realResolve(p);
  const rel = path.relative(rootReal, abs);
  if (rel === "") return abs;                              // root 自己
  const head = rel.split(path.sep)[0];
  if (head === ".." || path.isAbsolute(rel)) {
    throw new Error("路径越界：只能访问所选目录内的文件");
  }
  return abs;
}

/* 统一的错误包装：IPC handler 里抛异常会变成渲染层的 reject，
   但那样看不到 message 之外的东西，所以自己 catch 成 { ok:false, message }。 */
function fail(e) {
  return { ok: false, message: (e && e.message) || String(e) };
}

/* ------------------------------------------------------------ 扫描 */

function byName(a, b) {
  return String(a.name).toLowerCase().localeCompare(String(b.name).toLowerCase());
}

/* 递归扫描。目录在前、文件在后，各自按名称排序。
   budget 是个共享计数对象：一旦超预算就停止深入，返回部分结果 ——
   比直接抛错好，用户至少还能看到已经扫到的部分。 */
function scanDir(abs, depth, budget) {
  const out = [];
  if (depth > MAX_DEPTH || budget.n <= 0) return out;

  let list;
  try {
    list = fs.readdirSync(abs, { withFileTypes: true });
  } catch (_) {
    return out;      // 没权限 / 被别的程序占用：跳过这个目录，别让整次扫描失败
  }

  const dirs = [];
  const files = [];
  for (let i = 0; i < list.length; i++) {
    const d = list[i];
    if (d.isDirectory()) {
      if (SKIP_DIRS[d.name]) continue;
      // 隐藏目录（.git 上面已挡，这里挡 .idea / .vscode / .cache 之类）
      if (d.name.charAt(0) === ".") continue;
      dirs.push(d);
    } else if (d.isFile()) {
      files.push(d);   // 符号链接既不是 isDirectory 也不是 isFile，天然被跳过（不会成环）
    }
  }
  dirs.sort(byName);
  files.sort(byName);

  for (let i = 0; i < dirs.length && budget.n > 0; i++) {
    budget.n--;
    const dp = path.join(abs, dirs[i].name);
    out.push({ name: dirs[i].name, path: dp, type: "dir", children: scanDir(dp, depth + 1, budget) });
  }
  for (let i = 0; i < files.length && budget.n > 0; i++) {
    budget.n--;
    const fp = path.join(abs, files[i].name);
    let size = 0;
    try { size = fs.statSync(fp).size; } catch (_) { size = 0; }
    out.push({ name: files[i].name, path: fp, type: "file", size: size });
  }
  return out;
}

/* ------------------------------------------------------------ 小工具 */

/* 文件名清洗：去掉 Windows 非法字符与前导点，避免 ".." / "a/b" 这类越界写法。
   注意这只处理「名字」，最终路径仍要过 assertInside。 */
function safeName(name) {
  let s = String(name == null ? "" : name).trim();
  s = s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "");
  s = s.replace(/^\.+/, "");
  if (!s) throw new Error("文件名不合法");
  return s.slice(0, 120);
}

/* 重名时自动加 _1 / _2 …，保留扩展名（a.mcfunction → a_1.mcfunction） */
function uniquePath(dirAbs, name) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let p = path.join(dirAbs, name);
  let i = 1;
  while (fs.existsSync(p)) {
    p = path.join(dirAbs, base + "_" + i + ext);
    i++;
    if (i > 999) throw new Error("同名文件太多了");
  }
  return p;
}

function isTextName(name) {
  return !!TEXT_EXT[path.extname(String(name)).toLowerCase()];
}

/* ------------------------------------------------------------ 打包 */

/* 调系统命令打包。Windows 用 PowerShell 自带的 Compress-Archive，
   其他平台用 zip —— 两者都是系统自带，不引入依赖。 */
function runZip(dirAbs, outAbs) {
  return new Promise((resolve) => {
    let cmd;
    let args;
    let opts;

    if (process.platform === "win32") {
      // 单引号在 PowerShell 里是字面量，内部单引号翻倍转义即可
      const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
      // 用 dir\* 而不是 dir：zip 根下要直接是 pack.mcmeta / data，多一层目录游戏不认
      const script = "Compress-Archive -Path " + q(path.join(dirAbs, "*")) +
        " -DestinationPath " + q(outAbs) + " -Force";
      cmd = "powershell.exe";
      args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script];
      opts = { windowsHide: true, stdio: "ignore" };
    } else {
      cmd = "zip";
      args = ["-r", "-q", outAbs, "."];
      opts = { cwd: dirAbs, stdio: "ignore" };
    }

    let child;
    try {
      child = spawn(cmd, args, opts);
    } catch (e) {
      resolve({ ok: false, message: "打包命令启动失败：" + e.message });
      return;
    }

    let done = false;
    // 上万个小文件的 datapack 打包可能要几十秒，给 2 分钟；超时就杀掉，别挂住主进程
    const timer = setTimeout(() => {
      if (done) return;
      try { child.kill(); } catch (_) { /* ignore */ }
    }, 120000);

    child.on("error", (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: false, message: "打包失败：" + e.message });
    });
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: true, code: code });
    });
  });
}

/* ------------------------------------------------------------ 注册 */

module.exports = function registerProjectIpc(ipcMain, getWin) {
  /* ---- 样式表 ----
     ★ 为什么由这里注入：main.js 的 DESKTOP_STYLES 里只有 desktop.css /
       desktop-extra.css，没有 desktop-project.css；而 server 的静态白名单
       也只放行 app.html / style.css 那几个字面量，页面里 <link> 会 404。
       本模块又是 main.js 里唯一允许新增的一行，所以由它在窗口加载完成后
       自己 insertCSS —— 做法和 main.js 处理 desktop.css 完全一致。
       好处：样式仍是独立 CSS 文件，不需要动任何别人正在改的文件。 */
  const CSS_FILE = path.join(__dirname, "..", "web", "desktop-project.css");
  app.on("browser-window-created", (_e, w) => {
    w.webContents.on("did-finish-load", () => {
      try {
        w.webContents.insertCSS(fs.readFileSync(CSS_FILE, "utf8"));
      } catch (_) { /* 样式缺失只影响观感，不阻断功能 */ }
    });
  });

  /* 对话框的父窗口：拿不到就退化成无父窗口的模态，不至于直接抛错 */
  function parent() {
    let w = null;
    try { w = getWin ? getWin() : null; } catch (_) { w = null; }
    return w && !w.isDestroyed() ? w : null;
  }

  /* ---- 选目录：唯一一次授权入口 ---- */
  ipcMain.handle("project:pick-dir", async () => {
    const opts = {
      title: "选择数据包（datapack）目录",
      properties: ["openDirectory"],
      buttonLabel: "使用这个目录",
    };
    const w = parent();
    let r;
    try {
      r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts);
    } catch (e) {
      return fail(e);
    }
    if (!r || r.canceled || !r.filePaths || !r.filePaths.length) {
      return { ok: false, canceled: true };
    }
    const picked = r.filePaths[0];
    rootDir = picked;
    try { rootReal = fs.realpathSync(picked); } catch (_) { rootReal = path.resolve(picked); }
    return { ok: true, path: picked };
  });

  /* ---- 扫描目录树 ---- */
  ipcMain.handle("project:scan", (_e, rootPath) => {
    let abs;
    try {
      // 传空表示「用上次选的那个」；传值也要过校验，防止渲染层指向别处
      abs = (rootPath === undefined || rootPath === null || rootPath === "")
        ? (rootDir ? assertInside(rootDir) : null)
        : assertInside(rootPath);
      if (!abs) return { ok: false, message: "还没有选择项目目录" };
      if (!fs.statSync(abs).isDirectory()) return { ok: false, message: "不是目录：" + abs };
    } catch (e) {
      return fail(e);
    }
    const budget = { n: MAX_NODES };
    try {
      const tree = scanDir(abs, 0, budget);
      return { ok: true, root: abs, tree: tree, truncated: budget.n <= 0 };
    } catch (e) {
      return fail(e);
    }
  });

  /* ---- 读文本文件 ---- */
  ipcMain.handle("project:read", (_e, filePath) => {
    let abs;
    try {
      abs = assertInside(filePath);
    } catch (e) {
      return fail(e);
    }
    if (!isTextName(abs)) {
      const ext = path.extname(abs).toLowerCase() || "（无后缀）";
      return { ok: false, message: "这是二进制文件 " + ext + "，不能用文本编辑器打开" };
    }
    let st;
    try { st = fs.statSync(abs); } catch (e) { return fail(e); }
    if (!st.isFile()) return { ok: false, message: "不是文件" };
    if (st.size > MAX_READ) {
      return { ok: false, message: "文件太大（" + Math.round(st.size / 1024 / 1024) + "MB），不在编辑器里打开" };
    }
    let buf;
    try { buf = fs.readFileSync(abs); } catch (e) { return fail(e); }
    // 后缀对但内容是二进制（比如被人改名的图片）：前 4KB 里出现 NUL 就当二进制
    const head = buf.slice(0, Math.min(4096, buf.length));
    for (let i = 0; i < head.length; i++) {
      if (head[i] === 0) return { ok: false, message: "文件内容不是纯文本，已拒绝打开" };
    }
    let content = buf.toString("utf8");
    if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);   // 去 BOM，否则第一行会被校验器判成不以 / 开头
    return { ok: true, content: content, path: abs };
  });

  /* ---- 写文件（原子写） ---- */
  ipcMain.handle("project:write", (_e, filePath, content) => {
    let abs;
    try {
      abs = assertInside(filePath);
      if (!isTextName(abs)) return { ok: false, message: "只允许写文本类文件" };
      fs.mkdirSync(path.dirname(abs), { recursive: true });
    } catch (e) {
      return fail(e);
    }
    // .tmp 必须落在同一个目录：跨盘的 rename 不是原子操作，会退化成复制
    const tmp = abs + ".cc-tmp-" + process.pid + "-" + Date.now();
    try {
      fs.writeFileSync(tmp, String(content == null ? "" : content), "utf8");
      fs.renameSync(tmp, abs);          // 同目录 rename：要么旧文件，要么新文件，不会出现半截
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (_) { /* 清不掉就算了 */ }
      return fail(e);
    }
    let size = 0;
    try { size = fs.statSync(abs).size; } catch (_) { size = 0; }
    return { ok: true, path: abs, size: size };
  });

  /* ---- 新建空文件（重名自动加 _1 _2） ---- */
  ipcMain.handle("project:new-file", (_e, dirPath, name) => {
    let dirAbs;
    let finalPath;
    try {
      dirAbs = assertInside(dirPath);
      if (!fs.existsSync(dirAbs) || !fs.statSync(dirAbs).isDirectory()) {
        return { ok: false, message: "目录不存在" };
      }
      finalPath = uniquePath(dirAbs, safeName(name));
      assertInside(finalPath);           // 再校验一次：清洗过的名字也不能跑出 root
    } catch (e) {
      return fail(e);
    }
    try {
      fs.writeFileSync(finalPath, "", { encoding: "utf8", flag: "wx" });   // wx：已存在就报错，绝不覆盖
    } catch (e) {
      return fail(e);
    }
    return { ok: true, path: finalPath, name: path.basename(finalPath) };
  });

  /* ---- 打包成 .mcpack / .zip ---- */
  ipcMain.handle("project:zip", async (_e, dirPath, outPath) => {
    let dirAbs;
    let outAbs;
    try {
      dirAbs = assertInside(dirPath);
      outAbs = assertInside(outPath);
      if (!fs.statSync(dirAbs).isDirectory()) return { ok: false, message: "要打包的不是目录" };
      fs.mkdirSync(path.dirname(outAbs), { recursive: true });
    } catch (e) {
      return fail(e);
    }
    // 旧包先删：zip 是「追加」语义，Compress-Archive 在旧包被占用时也会直接失败
    try { fs.unlinkSync(outAbs); } catch (_) { /* 本来就没有 */ }

    const r = await runZip(dirAbs, outAbs);
    if (!r.ok) return r;
    if (r.code !== 0) {
      return { ok: false, message: "打包命令返回 " + r.code + "（目录可能是空的，或文件被占用）" };
    }
    let size = 0;
    try { size = fs.statSync(outAbs).size; } catch (_) { size = 0; }
    if (!size) return { ok: false, message: "打包没有产出文件" };
    return { ok: true, out: outAbs, size: size };
  });
};
