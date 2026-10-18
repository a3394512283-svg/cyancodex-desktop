/* ============================================================================
 * web/desktop-project.js —— 「我的 → 本地项目」datapack 编辑器
 *
 * 为什么单独一个文件：desktop.js 已定稿（多人/多任务并行改必然冲突），
 * 这里只依赖它挂到 window.__cc 上的公共工具（esc / toast / sheet / mi），
 * 全部逻辑收在自己的闭包里。
 *
 * 为什么这是桌面版专属：浏览器拿不到目录路径、读不了本地文件、更没法调
 * PowerShell 打包。手机端「根本做不到」的差异化就在这里。
 *
 * 安全分工：渲染层只负责「把用户点的那条路径原样传给主进程」，
 * 真正的越界校验在 electron/project-ipc.js 的 assertInside() 里 ——
 * 前端做校验只是体验优化，不能当安全边界。
 * ========================================================================== */
(function () {
  "use strict";

  var U = window.__cc;
  if (!U || window.__ccProjectReady) return;      // desktop.js 没注入成功就别硬跑
  window.__ccProjectReady = true;

  var CCX = window.cyancodex;
  // 浏览器里没有 IPC 能力，挂上去只会报错，直接不启用
  if (!CCX || !CCX.isDesktop || !CCX.projectScan) return;

  var esc = U.esc;
  var toast = U.toast;
  var sheet = U.sheet;

  /* 与主进程 TEXT_EXT 保持一致：这些后缀才允许进编辑器 */
  var TEXT_RE = /\.(mcfunction|json|mcmeta|txt|md|yml|yaml|lang)$/i;
  /* 中文标点：游戏只认 ASCII，全角符号「看着对、跑起来无效」，所以给警告 */
  var CN_PUNCT = /[，。；：！？（）【】“”‘’、《》—…·￥]/;
  /* 编辑器的行高（px），必须与 desktop-project.css 里 .cc-pj-editor 的
     line-height 一致 —— 跳行时用它估算 scrollTop，不依赖 DOM 测量 */
  var LINE_H = 22;

  /* 模块级状态：弹层关掉再打开还要能接着编辑，所以不放局部变量 */
  var state = {
    root: "",
    tree: [],
    file: null,       // { path, name, content }
    dirty: false,
  };

  /* ------------------------------------------------------------ 样式 */

  /* 样式表不由这里加载：desktop-project.css 是独立文件，由主进程
     electron/project-ipc.js 在 did-finish-load 时 insertCSS 注入
     （server 的静态白名单不放行 /web/*.css，页面里 <link> 会 404）。
     这样样式文件独立，也不必去动别人正在并行修改的文件。 */

  /* ------------------------------------------------------------ 小工具 */

  function el(id) { return document.getElementById(id); }

  function fmtSize(bytes) {
    var n = Number(bytes) || 0;
    if (!n) return "";
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / 1024 / 1024).toFixed(1) + " MB";
  }

  /* 路径拆解不依赖主进程：Windows 反斜杠、POSIX 斜杠都要认 */
  function dirName(p) {
    var s = String(p || "");
    var i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
    return i > 0 ? s.slice(0, i) : s;
  }

  function baseName(p) {
    var s = String(p || "");
    var i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
    return i >= 0 ? s.slice(i + 1) : s;
  }

  function joinPath(dir, name) {
    var d = String(dir || "");
    var sep = d.indexOf("\\") >= 0 ? "\\" : "/";
    if (d.charAt(d.length - 1) === sep) return d + name;
    return d + sep + name;
  }

  /* ------------------------------------------------------------ 入口项 */

  /* 复制一份 desktop.js 里 row() 生成的 .li 结构（不能改那个文件，也不引用它的
     私有函数），保证「我的」页里这一项和旁边的原生项长得一模一样。 */
  function entryHtml() {
    var sub = state.root || "编辑本机 datapack 文件、打包 .mcpack";
    return '<div class="li" data-pj="open"><div class="ico">🗂</div>' +
      '<div class="t">本地项目<small>' + esc(sub) + "</small></div>" +
      '<span class="arrow">›</span></div>';
  }

  function injectEntry() {
    var nav = document.querySelector(".nav-item.active");
    if (!nav || nav.getAttribute("data-page") !== "more") return;   // 只在「我的」页出现
    var page = document.querySelector("#main .page");
    if (!page) return;

    var box = page.querySelector("#cc-pj-entry");
    if (box) {
      // 已存在就只刷新副标题（选完目录后要显示路径），不重建节点免得闪
      var small = box.querySelector(".li .t small");
      if (small) small.textContent = state.root || "编辑本机 datapack 文件、打包 .mcpack";
      return;
    }

    box = document.createElement("div");
    box.id = "cc-pj-entry";
    var t = document.createElement("div");
    t.className = "sec-title";
    t.textContent = "本地";
    var list = document.createElement("div");
    list.className = "list";
    list.innerHTML = entryHtml();
    box.appendChild(t);
    box.appendChild(list);

    // 插在 desktop.js 的「桌面」区块前面：文件操作比系统设置更常用，放上面
    var anchor = page.querySelector("#cc-dsk-block");
    if (!anchor) {
      var titles = page.querySelectorAll(".sec-title");
      for (var i = 0; i < titles.length; i++) {
        if (/^关于/.test(titles[i].textContent || "")) { anchor = titles[i]; break; }
      }
    }
    if (anchor && anchor.parentNode === page) page.insertBefore(box, anchor);
    else page.appendChild(box);
  }

  /* ------------------------------------------------------------ 校验 */

  /* 规则（都是「手机端没法现场发现、但进游戏就报错」的那类问题）：
     1. 非空、非注释行必须以 / 开头 —— Bedrock 的 .mcfunction 每行一条带斜杠指令
     2. 引号总数必须是偶数 —— 奇数说明有字符串没闭合
     3. 含中文标点给警告 —— 看着像标点，游戏解析器只认 ASCII
     返回 [{ line, level:"err"|"warn", msg }] */
  function validate(text) {
    var list = [];
    var lines = String(text == null ? "" : text).split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i];
      var s = raw.replace(/^\s+/, "").replace(/\s+$/, "");
      if (!s) continue;                       // 空行
      if (s.charAt(0) === "#") continue;      // 注释行
      var ln = i + 1;

      if (s.charAt(0) !== "/") {
        list.push({ line: ln, level: "err", msg: "指令必须以 / 开头（每行一条带斜杠的指令）" });
        continue;   // 已经错了就别再叠引号/标点的噪音，一行只报最要紧的
      }
      var q = s.split('"').length - 1;
      if (q % 2 !== 0) {
        list.push({ line: ln, level: "err", msg: "引号数量是奇数（" + q + " 个），可能有字符串没闭合" });
      }
      if (CN_PUNCT.test(s)) {
        list.push({ line: ln, level: "warn", msg: "含中文标点，游戏里不认，请换成英文符号" });
      }
    }
    return list;
  }

  function countErrors(list) {
    var n = 0;
    for (var i = 0; i < list.length; i++) if (list[i].level === "err") n++;
    return n;
  }

  /* ------------------------------------------------------------ 文件树 */

  function renderTree(nodes, depth) {
    var out = "";
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.type === "dir") {
        // 第一层默认展开：datapack 一打开就要看到 data / functions 在哪
        out += '<div class="cc-pj-node cc-pj-dir' + (depth < 1 ? " open" : "") +
          '" data-path="' + esc(n.path) + '" data-type="dir">' +
          '<div class="cc-pj-row"><span class="cc-pj-tw">▸</span>' +
          '<span class="cc-pj-nm">' + esc(n.name) + "</span></div>" +
          '<div class="cc-pj-kids">' + renderTree(n.children || [], depth + 1) + "</div>" +
          "</div>";
      } else {
        var txt = TEXT_RE.test(n.name);
        out += '<div class="cc-pj-node cc-pj-file' + (txt ? "" : " cc-pj-bin") +
          '" data-path="' + esc(n.path) + '" data-type="file" data-txt="' + (txt ? 1 : 0) + '">' +
          '<div class="cc-pj-row"><span class="cc-pj-tw"></span>' +
          '<span class="cc-pj-nm">' + esc(n.name) + "</span>" +
          '<span class="cc-pj-sz">' + esc(fmtSize(n.size)) + "</span></div>" +
          "</div>";
      }
    }
    return out;
  }

  function refreshTree() {
    var box = el("cc-pj-tree");
    if (!box) return Promise.resolve();
    if (!state.root) {
      box.innerHTML = '<div class="cc-pj-empty">点「选择文件夹」打开一个数据包目录</div>';
      return Promise.resolve();
    }
    box.innerHTML = '<div class="cc-pj-empty">正在扫描…</div>';
    return CCX.projectScan(state.root).then(function (r) {
      if (!r || !r.ok) {
        box.innerHTML = '<div class="cc-pj-empty">扫描失败：' + esc((r && r.message) || "未知错误") + "</div>";
        return;
      }
      state.root = r.root || state.root;
      state.tree = r.tree || [];
      box.innerHTML = state.tree.length
        ? renderTree(state.tree, 0)
        : '<div class="cc-pj-empty">这个目录是空的</div>';
      var rt = el("cc-pj-root");
      if (rt) rt.textContent = state.root;
      markActive();
      if (r.truncated) toast("目录太大，只显示了前一部分", true);
    }).catch(function (e) {
      box.innerHTML = '<div class="cc-pj-empty">扫描失败：' + esc(e.message) + "</div>";
    });
  }

  /* 当前打开的文件在树里高亮 */
  function markActive() {
    var box = el("cc-pj-tree");
    if (!box) return;
    var all = box.querySelectorAll(".cc-pj-file.on");
    for (var i = 0; i < all.length; i++) all[i].classList.remove("on");
    if (!state.file) return;
    var nodes = box.querySelectorAll(".cc-pj-file");
    for (var j = 0; j < nodes.length; j++) {
      if (nodes[j].getAttribute("data-path") === state.file.path) nodes[j].classList.add("on");
    }
  }

  /* ------------------------------------------------------------ 状态栏 */

  function updateStatus() {
    var s = el("cc-pj-status");
    if (!s) return;
    var ta = el("cc-pj-editor");
    var val = ta ? ta.value : "";
    var lines = val ? val.split(/\r?\n/).length : 0;
    var errs = countErrors(validate(val));
    var path = state.file ? state.file.path : "未打开文件";

    s.innerHTML =
      '<span title="' + esc(path) + '">' + esc(path) + "</span>" +
      "<span>" + lines + " 行</span>" +
      '<span class="' + (errs ? "bad" : "") + '">' + errs + " 个错误</span>" +
      (state.dirty ? '<span class="bad">未保存</span>' : "");
  }

  /* ------------------------------------------------------------ 校验结果 */

  function showIssues(list) {
    var box = el("cc-pj-issues");
    if (!box) return;
    if (!list || !list.length) {
      box.innerHTML = '<div class="cc-pj-ok">✓ 没发现问题，可以打包了</div>';
      return;
    }
    var name = state.file ? state.file.name : "—";
    var html = "";
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      // 格式：文件名:行号  错误/警告  说明
      html += '<div class="cc-pj-iss ' + (it.level === "err" ? "err" : "warn") +
        '" data-line="' + it.line + '">' +
        '<span class="f">' + esc(name) + ":" + it.line + "</span>" +
        '<span class="lv">' + (it.level === "err" ? "错误" : "警告") + "</span>" +
        '<span class="m">' + esc(it.msg) + "</span></div>";
    }
    box.innerHTML = html;
  }

  function clearIssues() {
    var box = el("cc-pj-issues");
    if (box) box.innerHTML = "";
  }

  function runCheck() {
    if (!state.file) { toast("先打开一个文件", true); return; }
    var ta = el("cc-pj-editor");
    var val = ta ? ta.value : state.file.content;
    var list = validate(val);
    showIssues(list);
    var errs = countErrors(list);
    if (!list.length) toast("校验通过");
    else toast("校验完成：" + errs + " 个错误，" + (list.length - errs) + " 个警告", errs > 0);
    updateStatus();
  }

  /* 点结果跳到对应行：textarea 没有「行」的概念，只能算字符偏移 */
  function gotoLine(n) {
    var ta = el("cc-pj-editor");
    if (!ta) return;
    var lines = ta.value.split(/\r?\n/);
    var idx = Math.max(0, Math.min(lines.length - 1, (Number(n) || 1) - 1));
    var start = 0;
    for (var i = 0; i < idx; i++) start += lines[i].length + 1;
    ta.focus();
    try { ta.setSelectionRange(start, start + lines[idx].length); } catch (_) { /* ignore */ }
    // 让目标行落在可视区靠上的位置，而不是贴着底边
    ta.scrollTop = Math.max(0, (idx - 3) * LINE_H);
  }

  /* ------------------------------------------------------------ 动作 */

  function pickDir() {
    CCX.projectPickDir().then(function (r) {
      if (!r || !r.ok) {
        if (r && !r.canceled) toast("打开文件夹失败：" + (r.message || ""), true);
        return;
      }
      state.root = r.path;
      state.file = null;
      state.dirty = false;
      var ta = el("cc-pj-editor");
      if (ta) { ta.value = ""; ta.disabled = true; }
      clearIssues();
      var rt = el("cc-pj-root");
      if (rt) rt.textContent = state.root;
      updateStatus();
      injectEntry();          // 入口项副标题跟着显示新路径
      refreshTree();
    }).catch(function (e) { toast("打开文件夹失败：" + e.message, true); });
  }

  function openFile(p, name) {
    if (state.dirty && !window.confirm("当前文件还没保存，确定切换？")) return;
    CCX.projectRead(p).then(function (r) {
      if (!r || !r.ok) { toast((r && r.message) || "读取失败", true); return; }
      state.file = { path: p, name: name, content: r.content };
      state.dirty = false;
      var ta = el("cc-pj-editor");
      if (ta) {
        ta.disabled = false;
        ta.value = r.content;
        ta.focus();
      }
      clearIssues();
      updateStatus();
      markActive();
    }).catch(function (e) { toast("读取失败：" + e.message, true); });
  }

  function save() {
    if (!state.file) { toast("先打开一个文件", true); return; }
    var ta = el("cc-pj-editor");
    var content = ta ? ta.value : state.file.content;
    CCX.projectWrite(state.file.path, content).then(function (r) {
      if (!r || !r.ok) { toast("保存失败：" + ((r && r.message) || ""), true); return; }
      state.file.content = content;
      state.dirty = false;
      updateStatus();
      toast("已保存 " + state.file.name);
    }).catch(function (e) { toast("保存失败：" + e.message, true); });
  }

  /* 自己实现输入框：Electron 不支持 window.prompt（它只会打印一条警告） */
  function askName(dflt, cb) {
    var mask = document.createElement("div");
    mask.className = "cc-pj-mask";
    mask.innerHTML =
      '<div class="cc-pj-dlg"><b>新建文件</b>' +
      '<input class="cc-pj-inp" spellcheck="false" value="' + esc(dflt) + '">' +
      '<div class="cc-pj-dlg-act">' +
      '<button class="btn sm" data-x="0">取消</button>' +
      '<button class="btn sm pri" data-x="1">创建</button></div></div>';
    document.body.appendChild(mask);

    var inp = mask.querySelector("input");
    inp.focus();
    try { inp.select(); } catch (_) { /* ignore */ }

    function close() { if (mask.parentNode) mask.parentNode.removeChild(mask); }
    function ok() {
      var v = String(inp.value || "").trim();
      close();
      if (v) cb(v);
    }
    mask.addEventListener("click", function (e) {
      if (e.target === mask) { close(); return; }
      var b = e.target.closest("[data-x]");
      if (!b) return;
      if (b.getAttribute("data-x") === "1") ok(); else close();
    });
    inp.addEventListener("keydown", function (e) {
      // 输入框里的回车/ESC 归自己处理，别冒泡去触发全局快捷键
      if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); ok(); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    });
  }

  function newFile() {
    if (!state.root) { toast("先选择目录", true); return; }
    var dir = state.file ? dirName(state.file.path) : state.root;
    askName("new.mcfunction", function (name) {
      CCX.projectNewFile(dir, name).then(function (r) {
        if (!r || !r.ok) { toast("新建失败：" + ((r && r.message) || ""), true); return; }
        toast("已创建 " + r.name);
        return refreshTree().then(function () { openFile(r.path, r.name); });
      }).catch(function (e) { toast("新建失败：" + e.message, true); });
    });
  }

  function pack() {
    if (!state.root) { toast("先选择目录", true); return; }
    var out = joinPath(state.root, baseName(state.root) + ".mcpack");
    toast("正在打包，请稍候…");
    CCX.projectZip(state.root, out).then(function (r) {
      if (!r || !r.ok) { toast("打包失败：" + ((r && r.message) || ""), true); return; }
      toast("已打包：" + baseName(r.out) + "（" + fmtSize(r.size) + "）");
      refreshTree();
    }).catch(function (e) { toast("打包失败：" + e.message, true); });
  }

  /* ------------------------------------------------------------ 弹层 */

  function openProject() {
    var html =
      '<div class="cc-pj-bar">' +
        '<button class="btn sm" data-pj="pick">选择文件夹</button>' +
        '<button class="btn sm" data-pj="new">新建文件</button>' +
        '<button class="btn sm" data-pj="save">保存</button>' +
        '<button class="btn sm" data-pj="check">校验</button>' +
        '<button class="btn sm pri" data-pj="pack">打包 .mcpack</button>' +
        '<div class="sp"></div>' +
        '<span class="cc-pj-root" id="cc-pj-root">' + esc(state.root || "未选择目录") + "</span>" +
      "</div>" +
      '<div class="cc-pj-body">' +
        '<div class="cc-pj-side" id="cc-pj-tree"><div class="cc-pj-empty">点「选择文件夹」打开一个数据包目录</div></div>' +
        '<div class="cc-pj-main">' +
          '<textarea class="cc-pj-editor" id="cc-pj-editor" spellcheck="false" ' +
            'placeholder="在左侧点一个 .mcfunction 文件开始编辑"></textarea>' +
          '<div class="cc-pj-status" id="cc-pj-status">未打开文件</div>' +
        "</div>" +
      "</div>" +
      '<div class="cc-pj-issues" id="cc-pj-issues"></div>';

    sheet("本地项目 · datapack", html, function (wrap) {
      // 默认弹层只有 540px 宽，塞不下「左树 + 右编辑器」，这里单独放宽
      wrap.classList.add("cc-pj-sheet");

      var ta = wrap.querySelector("#cc-pj-editor");
      ta.addEventListener("input", function () {
        state.dirty = true;
        updateStatus();
      });
      ta.disabled = !state.file;

      // 重开弹层时接着上次的现场
      if (state.file) {
        ta.value = state.file.content;
        ta.disabled = false;
      }
      updateStatus();
      if (state.root) refreshTree();
    });
  }

  /* ------------------------------------------------------------ 事件 */

  /* 树 / 工具栏 / 校验结果的点击都走一个委托：弹层是动态生成的，
     逐个绑监听在重绘后就会失效 */
  document.addEventListener("click", function (e) {
    var act = e.target.closest("[data-pj]");
    if (act) {
      var a = act.getAttribute("data-pj");
      if (a === "open") { openProject(); return; }
      if (a === "pick") { pickDir(); return; }
      if (a === "new") { newFile(); return; }
      if (a === "save") { save(); return; }
      if (a === "check") { runCheck(); return; }
      if (a === "pack") { pack(); return; }
    }

    // 点校验结果 → 跳到那一行
    var iss = e.target.closest(".cc-pj-iss");
    if (iss) { gotoLine(iss.getAttribute("data-line")); return; }

    var node = e.target.closest(".cc-pj-node");
    if (!node) return;
    var type = node.getAttribute("data-type");
    if (type === "dir") {
      // 只有点行本身才折叠，点里面的子节点不该把父目录收起来
      if (!e.target.closest(".cc-pj-row")) return;
      if (e.target.closest(".cc-pj-kids")) return;
      node.classList.toggle("open");
      return;
    }
    if (type === "file") {
      var p = node.getAttribute("data-path");
      if (node.getAttribute("data-txt") === "1") openFile(p, baseName(p));
      else toast("二进制文件（" + baseName(p) + "）不能在编辑器里打开", true);
    }
  });

  /* Ctrl+S 保存。放在捕获阶段：先于页面里其它 keydown 处理。
     ★ 应用菜单里也有一个 CmdOrCtrl+S（导出当前页指令），它是浏览器层的
     快捷键，页面里 preventDefault 不一定能拦住；万一两个都触发，
     用户看到的是「多弹一个导出对话框」，关掉即可，数据不会丢。 */
  document.addEventListener("keydown", function (e) {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.key !== "s" && e.key !== "S") return;
    if (!el("cc-pj-editor")) return;        // 弹层没开就不抢这个键
    e.preventDefault();
    e.stopPropagation();
    save();
  }, true);

  /* 切换底部导航后要补回入口项（app.js 会整页重绘） */
  document.addEventListener("click", function (e) {
    if (e.target.closest(".nav-item")) setTimeout(injectEntry, 60);
  });

  /* ------------------------------------------------------------ 启动 */

  /* CSS 由主进程 injectDesktopLayer 统一注入（见 electron/main.js 的 DESKTOP_STYLES），
     这里不再自己插 style —— 早先这里调了一个不存在的 injectCss()，导致整个模块
     在启动时抛错、入口项根本没挂上。 */

  var mainEl = document.getElementById("main");
  if (mainEl) {
    // 只监听 #main 的子树增删：app.js 换页时整块替换，这里补回入口项。
    // injectEntry() 自己会判重，所以「插入 → 触发观察 → 再插入」不会死循环。
    new MutationObserver(function () { injectEntry(); })
      .observe(mainEl, { childList: true, subtree: true });
  }
  injectEntry();
})();
