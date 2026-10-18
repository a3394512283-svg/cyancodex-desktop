/* ============================================================================
 * web/desktop-update.js —— 应用内自动更新（检查 / 下载 / 安装）
 *
 * 为什么单独一个文件：desktop.js 是公共层且已定稿（多人并行改会冲突），
 * 这里只依赖它挂到 window.__cc 上的工具，自己闭包内完成全部逻辑。
 *
 * 为什么用捕获阶段拦点击：「检查更新 / 下载」这两个按钮是 desktop.js 自己
 * 渲染的，它的处理函数是「弹 toast + 让用户去浏览器下载」。我们要的是应用内
 * 下载安装，又绝不能改那个文件，所以在 document 的捕获阶段先把事件截走 ——
 * 捕获先于冒泡，stopPropagation 后 desktop.js 的委托监听收不到这次点击。
 * ========================================================================== */
(function () {
  "use strict";

  var U = window.__cc;
  if (!U || window.__ccUpdateReady) return;   // desktop.js 没注入成功就别硬跑
  window.__ccUpdateReady = true;

  var CCX = window.cyancodex;
  // 浏览器里没有 IPC 下载/安装能力，挂上去只会报错，直接不启用
  if (!CCX || !CCX.isDesktop) return;

  var esc = U.esc;
  var toast = U.toast;
  var sheet = U.sheet;
  var apiFetch = U.apiFetch;

  var busy = false;        // 下载中：防止连点起多个并发下载
  var unlisten = null;     // 进度事件解绑函数，弹层销毁时必须调用，否则监听越积越多
  var cur = null;          // 服务端版本信息缓存

  var ICON =
    '<svg class="cc-up-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
    ' stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M12 3v10"/><path d="m7.5 9 4.5 4 4.5-4"/>' +
    '<path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>';

  /* ------------------------------------------------------------ 小工具 */

  /* 版本号按 . 分段逐段比数值。不能用浮点或字符串比：
   * 「2.0.2.01」这种四段式，字符串比会认为 "2.0.2.01" < "2.0.2.1" 之外还
   * 会把 "2.0.10" 判成小于 "2.0.9"，段数不同（3 段 vs 4 段）也得能比。 */
  function cmpVer(a, b) {
    var pa = String(a == null ? "" : a).split(".");
    var pb = String(b == null ? "" : b).split(".");
    var n = Math.max(pa.length, pb.length);
    for (var i = 0; i < n; i++) {
      var x = parseInt(pa[i], 10);
      var y = parseInt(pb[i], 10);
      if (isNaN(x)) x = 0;
      if (isNaN(y)) y = 0;
      if (x !== y) return x > y ? 1 : -1;
    }
    return 0;
  }

  /* 字节 → 人类可读。安装包一般几十 MB，所以 1MB 以上保留一位小数就够；
   * 小于 1MB 时用 KB，避免出现 "0.0 MB"。 */
  function fmtSize(bytes) {
    var n = Number(bytes) || 0;
    if (n <= 0) return "未知大小";
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + " KB";
    return (n / 1024 / 1024).toFixed(1) + " MB";
  }

  /* 文件名优先用服务端给的 url 尾段，拿不到就按版本号拼一个。
   * 主进程还会再 basename 一次，这里只是给用户看的和做兜底。 */
  function pickName(url, ver) {
    var s = String(url || "").split("?")[0].split("#")[0];
    var base = s.substring(s.lastIndexOf("/") + 1);
    if (base && /\.\w{2,5}$/.test(base)) return base;
    return "CyanCodex-" + (ver || "update") + ".exe";
  }

  /* 本地版本来自主进程（package.json 的 version），异步拿一次 */
  function localVersion() {
    return CCX.info().then(function (i) {
      return (i && i.version) || "0";
    });
  }

  /* ------------------------------------------------------------ 检查 */

  function check() {
    if (busy) { toast("正在下载中，请稍候…"); return; }
    toast("正在检查更新…");
    Promise.all([apiFetch("/api/v1/app/version"), localVersion()])
      .then(function (r) {
        cur = r[0] || {};
        var mine = r[1];
        if (!cur.latest) throw new Error("服务端没有返回版本号");
        if (cmpVer(cur.latest, mine) > 0) openSheet(cur, mine);
        else toast("已是最新版本 v" + mine);
      })
      .catch(function (e) {
        toast("检查更新失败：" + ((e && e.message) || e), true);
      });
  }

  /* ------------------------------------------------------------ 弹层 */

  function openSheet(v, mine) {
    var notes = v.notes;
    if (typeof notes === "string") notes = notes.split(/\r?\n/);
    if (!notes || !notes.length) notes = [];

    var noteHtml = notes.length
      ? '<ul class="cc-up-notes">' + notes.map(function (t) {
          return "<li>" + esc(t) + "</li>";
        }).join("") + "</ul>"
      : '<div class="cc-up-empty">这次更新没有写说明</div>';

    var html =
      '<div class="cc-up-hd">' + ICON +
        '<div class="cc-up-hd-txt"><b>v' + esc(v.latest) + "</b>" +
        "<small>当前 v" + esc(mine) + "</small></div></div>" +
      noteHtml +
      '<div class="cc-up-meta">' +
        "<span>安装包</span>" +
        "<b>" + esc(pickName(v.url, v.latest)) + " · " + esc(fmtSize(v.size)) + "</b>" +
      "</div>" +
      '<div class="cc-up-prog" hidden>' +
        '<div class="cc-up-bar"><i></i></div>' +
        '<div class="cc-up-pct">准备中…</div>' +
      "</div>" +
      '<div class="cc-up-acts">' +
        '<button class="btn sm pri" data-up="go">下载并安装</button>' +
        '<button class="btn sm" data-up="later">稍后</button>' +
      "</div>";

    var wrap = sheet("发现新版本", html, function (w) {
      w.addEventListener("click", function (e) {
        var b = e.target.closest("[data-up]");
        if (!b) return;
        var act = b.getAttribute("data-up");
        if (act === "go") startDownload(w, v);
        else if (act === "later") closeSheet(w);
        else if (act === "install") doInstall(w, b.getAttribute("data-path") || "");
        else if (act === "web") {
          // 兜底：内网/代理挡掉 https 直连时，退回浏览器下载
          window.open(v.url, "_blank");
          closeSheet(w);
        }
      });
    });

    // 弹层被点掉时把进度监听摘掉，不然下载事件还在往已销毁的节点上写
    wrap.addEventListener("click", function (e) {
      if (e.target === wrap || e.target.hasAttribute("data-sheet-close")) stopListen();
    });
    return wrap;
  }

  function closeSheet(wrap) {
    stopListen();
    if (wrap && wrap.parentNode) wrap.parentNode.removeChild(wrap);
  }

  function stopListen() {
    if (unlisten) {
      try { unlisten(); } catch (e) { /* ignore */ }
      unlisten = null;
    }
  }

  /* ------------------------------------------------------------ 下载 */

  function startDownload(wrap, v) {
    if (busy) return;
    busy = true;

    var name = pickName(v.url, v.latest);
    var prog = wrap.querySelector(".cc-up-prog");
    var bar = wrap.querySelector(".cc-up-bar i");
    var pct = wrap.querySelector(".cc-up-pct");
    var go = wrap.querySelector('[data-up="go"]');
    var later = wrap.querySelector('[data-up="later"]');

    if (prog) prog.hidden = false;
    if (go) { go.disabled = true; go.textContent = "下载中…"; }
    if (later) later.textContent = "后台下载";

    // 进度可能来得非常密（几十毫秒一次），只在节点还活着时才写 DOM
    stopListen();
    unlisten = CCX.onUpdateProgress(function (p) {
      if (!wrap.parentNode) return;
      var percent = Math.max(0, Math.min(100, Math.round(Number(p && p.percent) || 0)));
      if (bar) bar.style.width = percent + "%";
      if (pct) {
        pct.textContent = percent + "%" +
          (p && p.total ? " · " + fmtSize(p.received) + " / " + fmtSize(p.total) : "");
      }
    });

    CCX.downloadUpdate(v.url, v.md5, name)
      .then(function (r) {
        busy = false;
        stopListen();
        if (!r || !r.ok) {
          fail(wrap, (r && r.message) || "下载失败", v);
          return;
        }
        if (!wrap.parentNode) { toast("更新包已下载完成"); return; }
        done(wrap, r.path);
      })
      .catch(function (e) {
        busy = false;
        stopListen();
        fail(wrap, (e && e.message) || "下载失败", v);
      });
  }

  /* 下载完成：把进度条换成「安装并重启」 */
  function done(wrap, filePath) {
    var prog = wrap.querySelector(".cc-up-prog");
    var bar = wrap.querySelector(".cc-up-bar i");
    var pct = wrap.querySelector(".cc-up-pct");
    var acts = wrap.querySelector(".cc-up-acts");
    if (prog) prog.hidden = false;
    if (bar) bar.style.width = "100%";
    if (pct) pct.textContent = "下载完成，已校验安装包";
    if (acts) {
      acts.innerHTML =
        '<button class="btn sm pri" data-up="install" data-path="' + esc(filePath) + '">安装并重启</button>' +
        '<button class="btn sm" data-up="later">稍后</button>';
    }
    toast("更新包已就绪，点「安装并重启」");
  }

  function fail(wrap, msg, v) {
    if (wrap.parentNode) {
      var pct = wrap.querySelector(".cc-up-pct");
      var acts = wrap.querySelector(".cc-up-acts");
      if (pct) pct.textContent = msg;
      if (acts) {
        acts.innerHTML =
          '<button class="btn sm" data-up="web">用浏览器下载</button>' +
          '<button class="btn sm" data-up="later">关闭</button>';
      }
    }
    toast(msg, true);
    void v;
  }

  /* ------------------------------------------------------------ 安装 */

  function doInstall(wrap, filePath) {
    if (!filePath) { toast("安装包路径丢失，请重新下载", true); return; }
    CCX.installUpdate(filePath)
      .then(function (r) {
        if (r && r.ok) {
          if (wrap && wrap.parentNode) wrap.parentNode.removeChild(wrap);
          toast("正在安装，应用即将退出…");
        } else {
          toast("安装失败：" + ((r && r.message) || "未知原因"), true);
        }
      })
      .catch(function (e) {
        toast("安装失败：" + ((e && e.message) || e), true);
      });
  }

  /* ------------------------------------------------------------ 入口 */

  /* 捕获阶段拦截，理由见文件头注释 */
  document.addEventListener("click", function (e) {
    var el = e.target && e.target.closest ? e.target.closest("[data-dsk]") : null;
    if (!el) return;
    var act = el.getAttribute("data-dsk");
    if (act !== "checkupdate" && act !== "download") return;
    e.preventDefault();
    e.stopPropagation();
    check();
  }, true);

  console.log("[CyanCodex] 自动更新模块已加载");
})();
