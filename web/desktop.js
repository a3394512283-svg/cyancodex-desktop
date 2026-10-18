/* ============================================================================
 * web/desktop.js —— 桌面壳专属能力层
 *
 * 网页版不带这个文件（server 的静态白名单里没有它），浏览器打开时一行都不执行。
 * 这里放的全是「浏览器做不到、桌面版必须有」的东西：
 *
 *   · 账号中心：资料 / 积分 / 签到 / 云同步
 *   · 本地数据：备份、恢复、打开数据目录（走主进程写 JSON 文件，不是 localStorage）
 *   · 系统集成：开机自启、关闭最小化到托盘、原生通知
 *   · 桌面交互：拖拽 .mcfunction 导入、Ctrl+S 导出、Ctrl+Enter 发送
 *
 * ★ 不改 app.js：所有扩展都通过「监听 #main 变化 → 往渲染结果里插 DOM」实现。
 *   这样网页版和桌面版共用同一份前端，网页版永远看不到这些代码。
 * ========================================================================== */
(function () {
  "use strict";

  var CC = window.cyancodex;
  if (!CC || !CC.isDesktop) return;
  if (window.__ccDesktopReady) return;
  window.__ccDesktopReady = true;

  document.documentElement.dataset.desktop = "1";

  var API_BASE = "https://cyancodex.cn";     // 官方接口（账号、签到、积分）
  var LOCAL_BASE = "";                        // 自建服务（AI、指令库、云同步）走同源代理
  var S_TOKEN = "cc_web_token";
  var S_USER = "cc_web_user";
  var S_CONVS = "cc_web_convs_v2";

  var info = null;      // 主进程信息
  var overview = null;  // 账号总览
  var checkin = null;   // 签到状态 { checked_today, streak, points, today_gain }
  var notices = null;   // 公告列表
  var latestVer = null; // 服务端最新版本信息

  /* ------------------------------------------------------------ 小工具 */

  function lsGet(k, dflt) {
    try {
      var v = localStorage.getItem(k);
      return v === null ? dflt : JSON.parse(v);
    } catch (e) { return dflt; }
  }

  function token() {
    var t = lsGet(S_TOKEN, null);
    return typeof t === "string" ? t : null;
  }

  function user() {
    return lsGet(S_USER, null);
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function toast(msg, bad) {
    var el = document.getElementById("cc-dsk-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "cc-dsk-toast";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.borderColor = bad ? "rgba(248,113,113,.55)" : "";
    el.classList.add("on");
    clearTimeout(el.__t);
    el.__t = setTimeout(function () { el.classList.remove("on"); }, 2400);
  }

  function fmtTime(ts) {
    if (!ts) return "—";
    var d = new Date(ts);
    function p(n) { return n < 10 ? "0" + n : "" + n; }
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
      " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  function fmtNum(n) {
    n = Number(n) || 0;
    return n.toLocaleString("zh-CN");
  }

  /* ------------------------------------------------------------ 接口 */

  function apiFetch(path, opts) {
    opts = opts || {};
    var headers = { Accept: "application/json" };
    var t = token();
    if (t) headers.Authorization = "Bearer " + t;
    if (opts.body) headers["Content-Type"] = "application/json";
    return fetch(path, {
      method: opts.method || (opts.body ? "POST" : "GET"),
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      cache: "no-store",
    }).then(function (r) {
      return r.text().then(function (t2) {
        var j = null;
        try { j = JSON.parse(t2); } catch (e) { /* 非 JSON */ }
        if (!r.ok || (j && j.ok === false)) {
          var msg = (j && (j.message || j.error)) || ("HTTP " + r.status);
          var err = new Error(msg);
          err.status = r.status;
          throw err;
        }
        return j && j.data !== undefined ? j.data : j;
      });
    });
  }

  function loadOverview() {
    if (!token()) { overview = null; checkin = null; return Promise.resolve(null); }
    // 两个接口并行拉：overview 给积分，checkin 给签到状态
    return Promise.all([
      apiFetch(API_BASE + "/api/account/overview").catch(function () { return null; }),
      apiFetch(API_BASE + "/api/checkin").catch(function () { return null; }),
    ]).then(function (r) {
      overview = r[0];
      checkin = r[1];
      return overview;
    });
  }

  function loadNotices() {
    return apiFetch(API_BASE + "/api/announcements")
      .then(function (d) {
        notices = Array.isArray(d) ? d : (d && (d.list || d.items)) || [];
        return notices;
      })
      .catch(function () { notices = null; return null; });
  }

  function cmpVer(a, b) {
    var pa = String(a || "0").split(".").map(Number);
    var pb = String(b || "0").split(".").map(Number);
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
      var x = pa[i] || 0, y = pb[i] || 0;
      if (x !== y) return x > y ? 1 : -1;
    }
    return 0;
  }

  function checkUpdate() {
    toast("正在检查更新…");
    apiFetch("/api/v1/app/version")
      .then(function (v) {
        latestVer = v || {};
        var cur = (info && info.version) || "0";
        if (cmpVer(latestVer.latest, cur) > 0) {
          toast("发现新版本 v" + latestVer.latest + "，点「关于」里的下载按钮获取");
          injectMoreRefresh();
        } else {
          toast("已是最新版本 v" + cur);
        }
      })
      .catch(function (e) { toast("检查失败：" + e.message, true); });
  }

  /* ------------------------------------------------------------ 工具条 */

  var bar = document.createElement("div");
  bar.id = "cc-dsk-tools";
  bar.innerHTML =
    '<button data-act="copy" title="复制本页所有指令">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
      '<rect x="9" y="9" width="12" height="12" rx="2.5"/><path d="M5 15V5.5A2.5 2.5 0 0 1 7.5 3H15"/></svg><span>复制</span></button>' +
    '<button data-act="export" title="导出为 .mcfunction（Ctrl+S）">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M12 3v11"/><path d="m7.5 10 4.5 4 4.5-4"/><path d="M4 20h16"/></svg><span>导出</span></button>' +
    '<button data-act="sync" title="云同步对话记录">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M21 12a9 9 0 0 1-9 9 8.9 8.9 0 0 1-6.4-2.6L3 16"/><path d="M3 12a9 9 0 0 1 9-9 8.9 8.9 0 0 1 6.4 2.6L21 8"/>' +
      '<path d="M3 21v-5h5"/><path d="M21 3v5h-5"/></svg><span>同步</span></button>' +
    '<button data-act="cfg" title="打开数据目录">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
      '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/></svg><span>配置</span></button>';
  document.body.appendChild(bar);

  bar.addEventListener("click", function (e) {
    var btn = e.target.closest("button");
    if (!btn) return;
    var act = btn.getAttribute("data-act");
    if (act === "copy") doCopy();
    else if (act === "export") doExport();
    else if (act === "sync") doSync();
    else if (act === "cfg") CC.openDataDir();
  });

  /* ---------------------------------------------------- 收集本页指令 */

  function collectCommands() {
    var out = [];
    var seen = Object.create(null);
    var sel = ".codewrap pre, #genOut, .lib-full-code, .bubble pre, .cmd .code-prev";
    document.querySelectorAll(sel).forEach(function (el) {
      var txt = el.innerText || "";
      txt.split(/\r?\n/).forEach(function (line) {
        var t = line.trim();
        if (!t || t.charAt(0) !== "/" || t.length < 2) return;
        if (seen[t]) return;
        seen[t] = 1;
        out.push(t);
      });
    });
    return out;
  }

  function doCopy() {
    var cmds = collectCommands();
    if (!cmds.length) return toast("这一页没有可复制的指令", true);
    CC.copy(cmds.join("\n")).then(function () {
      toast("已复制 " + cmds.length + " 条指令");
    });
  }

  function doExport() {
    var cmds = collectCommands();
    if (!cmds.length) return toast("这一页没有可导出的指令", true);
    var stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    CC.saveFile("commands-" + stamp + ".mcfunction", cmds.join("\n"))
      .then(function (r) {
        if (r && r.ok) toast("已导出 " + cmds.length + " 条 → " + r.path);
        else if (r && !r.canceled) toast("导出失败：" + (r.message || "未知错误"), true);
      });
  }

  /* ------------------------------------------------------------ 云同步 */

  function localConvs() {
    var a = lsGet(S_CONVS, []);
    return Array.isArray(a) ? a.filter(function (c) {
      return c && typeof c.id === "string" && Array.isArray(c.msgs);
    }) : [];
  }

  function toServer(c) {
    return {
      cid: c.id,
      updated_at: c.ts || Date.now(),
      title: c.title || "新对话",
      mode: c.mode || "chat",
      payload: { msgs: c.msgs || [] },
      deleted: false,
    };
  }

  function fromServer(s) {
    var msgs = [];
    if (s.payload && Array.isArray(s.payload.msgs)) msgs = s.payload.msgs;
    else if (Array.isArray(s.msgs)) msgs = s.msgs;
    return {
      id: s.cid || s.id,
      title: s.title || "新对话",
      mode: s.mode || "chat",
      msgs: msgs,
      ts: s.updated_at || s.ts || Date.now(),
    };
  }

  var syncing = false;

  function doSync(silent) {
    if (syncing) return;
    if (!token()) {
      if (!silent) toast("云同步需要先登录", true);
      return;
    }
    syncing = true;
    if (!silent) toast("正在同步…");

    var local = localConvs();
    var since = Number(lsGet("cc_dsk_sync_since", 0)) || 0;

    apiFetch(LOCAL_BASE + "/api/v1/convs", {
      method: "POST",
      body: { convs: local.map(toServer), since: since },
    }).then(function (d) {
      var remote = (d && d.convs) || [];
      var byId = {};
      local.forEach(function (c) { byId[c.id] = c; });

      var changed = 0;
      remote.forEach(function (s) {
        var incoming = fromServer(s);
        if (!incoming.id) return;
        var cur = byId[incoming.id];
        // last-write-wins by ts，和服务端策略一致
        if (!cur || (incoming.ts || 0) > (cur.ts || 0)) {
          byId[incoming.id] = incoming;
          changed++;
        }
      });

      var merged = Object.keys(byId).map(function (k) { return byId[k]; })
        .filter(function (c) { return c && !c.deleted; })
        .sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });

      try {
        localStorage.setItem(S_CONVS, JSON.stringify(merged));
      } catch (e) {
        toast("本地空间不足，同步结果未能保存", true);
      }

      if (d && d.server_time) localStorage.setItem("cc_dsk_sync_since", JSON.stringify(d.server_time));
      localStorage.setItem("cc_dsk_sync_at", JSON.stringify(Date.now()));

      syncing = false;
      toast("同步完成：推送 " + local.length + " 条，收到 " + changed + " 条更新");
      if (changed) setTimeout(function () { location.reload(); }, 900);
    }).catch(function (e) {
      syncing = false;
      toast("同步失败：" + e.message, true);
    });
  }

  /* ---------------------------------------------------- 首页（对齐 App 首页） */

  /* Material Icons 24×24 路径（与 App 的 Icons.Default.* 同名同形） */
  var MI = {
    bar_chart: "M5 9.2h3V19H5zM10.6 5h2.8v14h-2.8zm5.6 8H19v6h-2.8z",
    book: "M18 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 4h5v8l-2.5-1.5L6 12V4z",
    campaign: "M18 11v2h4v-2h-4zm-2 6.61c.96.71 2.21 1.65 3.2 2.39.4-.53.8-1.07 1.2-1.6-.99-.74-2.24-1.68-3.2-2.4-.4.54-.8 1.08-1.2 1.61zM20.4 5.6c-.4-.53-.8-1.07-1.2-1.6-.99.74-2.24 1.68-3.2 2.4.4.53.8 1.07 1.2 1.6.96-.72 2.21-1.65 3.2-2.4zM4 9c-1.1 0-2 .9-2 2v2c0 1.1.9 2 2 2h1v4h2v-4h1l5 3V6L8 9H4zm11.5 3c0-1.33-.58-2.53-1.5-3.35v6.69c.92-.81 1.5-2.01 1.5-3.34z",
    casino: "M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM7.5 18c-.83 0-1.5-.67-1.5-1.5S6.67 15 7.5 15s1.5.67 1.5 1.5S8.33 18 7.5 18zm0-9C6.67 9 6 8.33 6 7.5S6.67 6 7.5 6 9 6.67 9 7.5 8.33 9 7.5 9zm4.5 4.5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm4.5 4.5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm0-9c-.83 0-1.5-.67-1.5-1.5S15.67 6 16.5 6s1.5.67 1.5 1.5S17.33 9 16.5 9z",
    code: "M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z",
    edit: "M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z",
    extension: "M20.5 11H19V7c0-1.1-.9-2-2-2h-4V3.5C13 2.12 11.88 1 10.5 1S8 2.12 8 3.5V5H4c-1.1 0-1.99.9-1.99 2v3.8H3.5c1.49 0 2.7 1.21 2.7 2.7s-1.21 2.7-2.7 2.7H2V20c0 1.1.9 2 2 2h3.8v-1.5c0-1.49 1.21-2.7 2.7-2.7 1.49 0 2.7 1.21 2.7 2.7V22H17c1.1 0 2-.9 2-2v-4h1.5c1.38 0 2.5-1.12 2.5-2.5S21.88 11 20.5 11z",
    favorite: "M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z",
    feedback: "M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-7 12h-2v-2h2v2zm0-4h-2V6h2v4z",
    forum: "M21 6h-2v9H6v2c0 .55.45 1 1 1h11l4 4V7c0-.55-.45-1-1-1zm-4 6V3c0-.55-.45-1-1-1H3c-.55 0-1 .45-1 1v14l4-4h10c.55 0 1-.45 1-1z",
    music_note: "M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z",
    person: "M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z",
    search: "M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z",
    speed: "M20.38 8.57l-1.23 1.85a8 8 0 0 1-.22 7.58H5.07A8 8 0 0 1 15.58 6.85l1.85-1.23A10 10 0 0 0 3.35 19a2 2 0 0 0 1.72 1h13.85a2 2 0 0 0 1.74-1 10 10 0 0 0-.27-10.44zm-9.79 6.84a2 2 0 0 0 2.83 0l5.66-8.49-8.49 5.66a2 2 0 0 0 0 2.83z",
    star: "M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z",
    swap_horiz: "M6.99 11L3 15l3.99 4v-3H14v-2H6.99v-3zM21 9l-3.99-4v3H10v2h7.01v3L21 9z",
    widgets: "M13 13v8h8v-8h-8zM3 21h8v-8H3v8zM3 3v8h8V3H3zm13.66-1.31L11 7.34 16.66 13l5.66-5.66-5.66-5.65z",
    smart_toy: "M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z",
  };

  /* 模块清单对齐 App 的 homeModules：桌面版去掉 Android 专属的
     输入法模式 / 悬浮窗 / 优化（那三个在桌面上没有意义），
     其余按 App 的顺序与描述照搬。 */
  var MODULES = [
    { n: "指令库", d: "平台 + 用户上传", ico: "book", c: "#4ADE80", go: "library" },
    { n: "工具箱", d: "生成器 / 网络测速", ico: "widgets", c: "#2DD4BF", go: "tools" },
    { n: "AI Agent", d: "AI 智能编写", ico: "smart_toy", c: "#60A5FA", go: "ai" },
    { n: "T显生成器", d: "计分板 / T 显示", ico: "bar_chart", c: "#FBBF24", go: "tools", tool: "scoreboard" },
    { n: "穷举", d: "批量生成指令", ico: "swap_horiz", c: "#A78BFA", go: "tools", tool: "enumerate" },
    { n: "滚动字幕", d: "公告 / 字幕指令", ico: "campaign", c: "#F472B6", go: "tools", tool: "scroller" },
    { n: "音乐生成器", d: "命令方块音乐", ico: "music_note", c: "#34D399", go: "tools", tool: "music" },
    { n: "T显 JSON", d: "rawtext 可视化编辑", ico: "code", c: "#22D3EE", go: "tools", tool: "titleraw" },
    { n: "指令编辑器", d: "快捷编辑指令", ico: "edit", c: "#38BDF8", go: "editor" },
    { n: "网络测速", d: "延迟 / 下载 / 上传", ico: "speed", c: "#38BDF8", go: "speed" },
    { n: "五子棋", d: "人机对战", ico: "casino", c: "#F59E0B", go: "gomoku" },
    { n: "意见申诉", d: "反馈问题 / 申诉", ico: "feedback", c: "#C084FC", go: "feedback" },
  ];

  /* 渲染一个 Material 图标（颜色走 App 里每个模块自己的 tint） */
  function mi(name, color, size) {
    var d = MI[name];
    if (!d) return "";
    var s2 = size || 22;
    return '<svg viewBox="0 0 24 24" width="' + s2 + '" height="' + s2 +
      '" fill="' + color + '" aria-hidden="true"><path d="' + d + '"/></svg>';
  }

  function buildHomeHtml() {
    var u = user();
    var t = token();
    var ov = overview || {};
    var ck = checkin || {};
    var points = ov.points !== undefined ? ov.points
      : (ck.points !== undefined ? ck.points : (u && u.points) || 0);
    var checked = !!(ck.checked_today || ov.checked_today);
    var banner = notices && notices.length ? notices[0] : null;

    var h = '<div class="cc-dsk-hero">';
    h += '<div class="cc-dsk-hero-top">';
    if (t && u) {
      h += '<div class="cc-dsk-avatar lg">' +
        esc(String(u.nickname || u.username || "?").slice(0, 1).toUpperCase()) + "</div>";
      h += '<div class="cc-dsk-hero-id"><b>CyanCodex</b>' +
        '<div class="cc-dsk-badges">' +
        '<button class="cc-dsk-badge" data-dsk="account">积分 ' + fmtNum(points) + "</button>" +
        '<button class="cc-dsk-badge' + (checked ? " done" : "") + '" data-dsk="checkin">' +
        (checked ? "今日已签到" : "签到") + "</button>" +
        "</div></div>";
    } else {
      h += '<div class="cc-dsk-avatar lg">C</div>' +
        '<div class="cc-dsk-hero-id"><b>CyanCodex</b>' +
        '<div class="cc-dsk-badges"><button class="cc-dsk-badge" data-dsk="login">登录账号</button></div>' +
        "</div>";
    }
    h += "</div>";
    h += '<p class="cc-dsk-hero-sub">一站式我的世界指令创作 · 沧蓝工坊开发</p>';
    if (banner) {
      h += '<button class="cc-dsk-banner" data-dsk="notice"><b>' + esc(banner.title || "公告") + "</b>" +
        (banner.content ? "<span>" + esc(String(banner.content).slice(0, 40)) + "</span>" : "") + "</button>";
    }
    h += "</div>";

    /* 聊天室：App 首页主卡下面这块，桌面版保留（接口 api/chat 可用）。
       ★ 开发者功能/插件工坊**不放** —— 它依赖 Android 端的插件运行时，
         桌面版做不了，摆一个点了报错的入口不如不摆。 */
    h += '<button class="cc-dsk-row chat" data-mod="chat">' +
      '<span class="ico" style="background:#4ADE8024;color:#4ADE80">' + mi("forum", "#4ADE80", 20) + "</span>" +
      '<span class="t"><b>聊天室</b><small>和玩家实时交流指令</small></span>' +
      '<span class="tail">▤</span></button>';

    h += '<div class="sec-title">功能</div>';
    h += '<div class="cc-dsk-grid">' + MODULES.map(function (m) {
      return '<button class="cc-dsk-mod" data-mod="' + esc(m.go) + '"' +
        (m.tool ? ' data-tool="' + esc(m.tool) + '"' : "") + ">" +
        '<span class="ico" style="background:' + m.c + '1f;color:' + m.c + '">' + mi(m.ico, m.c) + "</span>" +
        "<b>" + esc(m.n) + "</b><small>" + esc(m.d) + "</small></button>";
    }).join("") + "</div>";

    /* 宝贝回家跑马灯：App 每个页面底部都挂着，桌面版首页保留 */
    var kids = [
      "孟桂霞（照片是大姐）· 1988-04-01 · 河南省新乡市红旗区庄岩村",
      "王余香 · 1997-02-15 · 重庆市万州区巫溪县菱角乡店子街138号",
      "潘清海（照片是父亲）· 1999-01-01 · 云南省昭通市永善县大兴乡骆丘村",
      "徐孔威 · 1988-04-12 · 陕西省商洛市柞水县县医院",
    ];
    h += '<button class="cc-dsk-kids" data-mod="kids">' +
      mi("favorite", "#4ADE80", 14) +
      '<b>宝贝回家</b><span id="cc-kids-txt">' + esc(kids[0]) + "</span><i>查看 ›</i></button>";

    if (notices && notices.length) {
      h += '<div class="sec-title">公告</div>';
      h += '<div class="card cc-dsk-notice-card">' + notices.slice(0, 3).map(function (n) {
        var cls = n.type === "warning" ? "warn" : (n.type === "danger" ? "danger" : "");
        return '<div class="cc-dsk-notice-item ' + cls + '"><b>' + esc(n.title || "公告") + "</b>" +
          "<p>" + esc(n.content || "") + "</p>" +
          (n.created_at ? "<small>" + esc(n.created_at) + "</small>" : "") + "</div>";
      }).join("") + "</div>";
    }

    return h;
  }

  /* ---------------------------------------------------- 底部导航补「广场」 */

  /* App 底部是 6 个：首页 / 指令库 / 广场 / 工具箱 / AI / 我的。
     网页版只有 5 个，这里补一个「广场」，并把「更多」改成「我的」。
     新按钮自己绑 click（app.js 的绑定在初始化时已执行完，不会管到它）。 */
  function patchNav() {
    var nav = document.querySelector(".bottom-nav");
    if (!nav) return;
    var moreTxt = nav.querySelector('[data-page="more"] .nav-txt');
    if (moreTxt) moreTxt.textContent = "我的";
    var toolsTxt = nav.querySelector('[data-page="tools"] .nav-txt');
    if (toolsTxt) toolsTxt.textContent = "工具箱";
    var aiTxt = nav.querySelector('[data-page="ai"] .nav-txt');
    if (aiTxt) aiTxt.textContent = "AI";
    if (nav.querySelector('[data-page="feed"]')) return;

    var lib = nav.querySelector('[data-page="library"]');
    var btn = document.createElement("button");
    btn.className = "nav-item";
    btn.dataset.page = "feed";
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ' +
      'stroke-linecap="round" stroke-linejoin="round">' +
      '<rect x="3" y="4.5" width="18" height="15" rx="2.6"/><path d="M7 9.5h10M7 13.5h10M7 17h6"/></svg>' +
      '<span class="nav-txt">广场</span>';
    if (lib && lib.nextSibling) nav.insertBefore(btn, lib.nextSibling);
    else nav.appendChild(btn);
    nav.style.gridTemplateColumns = "repeat(6, 1fr)";
    btn.addEventListener("click", function () { showFeed(); });
  }

  function showFeed() {
    var main = document.getElementById("main");
    if (!main) return;
    Array.prototype.forEach.call(document.querySelectorAll(".nav-item"), function (b) {
      b.classList.toggle("active", b.getAttribute("data-page") === "feed");
    });
    main.scrollTop = 0;
    main.innerHTML = '<div class="page"><div class="sec-title">广场</div>' +
      '<div id="cc-feed" class="cc-dsk-feed"><div class="cc-dsk-loading">正在加载…</div></div></div>';

    apiFetch(API_BASE + "/api/feed?page=1&size=30")
      .then(function (d) {
        var list = (d && (d.list || d.items)) || [];
        var box = document.getElementById("cc-feed");
        if (!box) return;
        if (!list.length) {
          box.innerHTML = '<div class="cc-dsk-empty">广场还没有内容</div>';
          return;
        }
        box.innerHTML = list.map(function (it) {
          var isComment = it.type === "comment";
          var who = it.author || "匿名";
          var head = '<div class="hd"><b>' + esc(who) + "</b><small>" + esc(it.created_at || "") + "</small></div>";
          if (isComment) {
            return '<div class="cc-dsk-feed-item">' + head +
              '<p class="sub">评论了「' + esc(it.command_title || "指令") + "」</p>" +
              '<p class="body">' + esc(it.content || "") + "</p></div>";
          }
          return '<div class="cc-dsk-feed-item">' + head +
            '<b class="tt">' + esc(it.title || "未命名") + "</b>" +
            (it.description ? '<p class="sub">' + esc(it.description) + "</p>" : "") +
            '<div class="meta"><span>❤ ' + (it.like_count || 0) + "</span>" +
            "<span>👁 " + (it.view_count || 0) + "</span>" +
            "<span>💬 " + (it.comment_count || 0) + "</span></div></div>";
        }).join("");
        window.__ccFeed = list;
        Array.prototype.forEach.call(box.querySelectorAll(".cc-dsk-feed-item"), function (el, i) {
          el.style.cursor = "pointer";
          el.addEventListener("click", function () { openFeedDetail(list[i]); });
        });
      })
      .catch(function (e) {
        var box = document.getElementById("cc-feed");
        if (box) box.innerHTML = '<div class="cc-dsk-empty">加载失败：' + esc(e.message) + "</div>";
      });
  }

  /* ---------------------------------------------------- 指令库（对齐 App） */

  var libTab = "platform";
  var libQ = "";

  var LIB_TABS = [
    { k: "platform", n: "平台" },
    { k: "high", n: "高质" },
    { k: "low", n: "低质" },
    { k: "mine", n: "我的" },
    { k: "fav", n: "收藏" },
    { k: "tutorial", n: "教程" },
  ];

  function libUrl() {
    if (libTab === "fav") return API_BASE + "/api/commands/favorites/list?page=1&size=40";
    if (libTab === "tutorial") return API_BASE + "/api/tutorials?page=1&size=40";
    var p = ["page=1", "size=40"];
    if (libQ) p.push("q=" + encodeURIComponent(libQ));
    if (libTab === "platform") p.push("source=platform");
    else if (libTab === "high") p.push("quality=high");
    else if (libTab === "low") p.push("quality=low");
    else if (libTab === "mine") p.push("mine=1");
    return API_BASE + "/api/commands?" + p.join("&");
  }

  function buildLibHtml() {
    var h = '<div class="cc-lib-top">' +
      '<div class="cc-lib-search">' + mi("search", "currentColor", 18) +
      '<input id="cc-lib-q" type="text" placeholder="搜索指令…" value="' + esc(libQ) + '"></div>' +
      '<button class="btn sm pri" data-lib="upload">上传</button></div>';
    h += '<div class="cc-lib-tabs">' + LIB_TABS.map(function (t) {
      return '<button class="cc-lib-tab' + (t.k === libTab ? " on" : "") +
        '" data-libt="' + t.k + '">' + t.n + "</button>";
    }).join("") + "</div>";
    h += '<div id="cc-lib-list" class="cc-lib-list"><div class="cc-dsk-loading">正在加载…</div></div>';
    return h;
  }

  function renderLibList() {
    var box = document.getElementById("cc-lib-list");
    if (!box) return;
    box.innerHTML = '<div class="cc-dsk-loading">正在加载…</div>';

    apiFetch(libUrl()).then(function (d) {
      var list = Array.isArray(d) ? d : ((d && (d.list || d.items)) || []);
      if (!list.length) {
        box.innerHTML = '<div class="cc-dsk-empty">' +
          (libTab === "mine" ? "你还没有上传过指令" : libTab === "fav" ? "还没有收藏" : "没有内容") + "</div>";
        return;
      }
      if (libTab === "tutorial") {
        box.innerHTML = list.map(function (t) {
          return '<div class="cc-lib-card tut"><b>' + esc(t.title || "教程") + "</b>" +
            "<p>" + esc(t.summary || t.description || "") + "</p>" +
            (t.created_at ? '<div class="meta"><span>' + esc(t.created_at) + "</span></div>" : "") + "</div>";
        }).join("");
        return;
      }
      box.innerHTML = list.map(function (c) {
        var tags = [];
        if (c.source === "platform") tags.push('<i class="t-plat">平台</i>');
        if (c.quality === "high") tags.push('<i class="t-hi">高质</i>');
        if (c.price > 0) tags.push('<i class="t-paid">' + c.price + " 积分</i>");
        if (c.status === "pending") tags.push('<i class="t-pend">待审核</i>');
        if (c.status === "rejected") tags.push('<i class="t-rej">已驳回</i>');
        var code = String(c.command || "").split(/\r?\n/)[0].slice(0, 90);
        return '<div class="cc-lib-card" data-cid="' + esc(c.id) + '">' +
          "<b>" + esc(c.title || "未命名") + "</b>" +
          (c.description ? "<p>" + esc(c.description) + "</p>" : "") +
          (tags.length ? '<div class="tags">' + tags.join("") + "</div>" : "") +
          (code ? '<pre class="code">' + esc(code) + "</pre>" : "") +
          '<div class="meta"><span>' + esc(c.category || "其他") +
            (c.mc_version ? " · " + esc(c.mc_version) : "") + "</span>" +
            '<span class="r">' + (c.author ? "@" + esc(c.author) : "") +
            " ❤ " + (c.like_count || 0) + " 💬 " + (c.comment_count || 0) +
            ' <button class="cc-lib-cp" data-cp="' + esc(c.id) + '">复制</button></span></div></div>';
      }).join("");
    }).catch(function (e) {
      box.innerHTML = '<div class="cc-dsk-empty">加载失败：' + esc(e.message) + "</div>";
    });
  }

  function renderDesktopLibrary() {
    var page = document.querySelector("#main .page");
    if (!page) return;
    var nav = document.querySelector(".nav-item.active");
    if (!nav || nav.getAttribute("data-page") !== "library") return;
    if (page.dataset.dskLib === "1") return;
    page.dataset.dskLib = "1";
    page.innerHTML = buildLibHtml();
    renderLibList();
  }

  /* 指令库事件 */
  document.addEventListener("click", function (e) {
    var t = e.target.closest("[data-libt]");
    if (t) {
      libTab = t.getAttribute("data-libt");
      Array.prototype.forEach.call(document.querySelectorAll(".cc-lib-tab"), function (b) {
        b.classList.toggle("on", b.getAttribute("data-libt") === libTab);
      });
      renderLibList();
      return;
    }
    if (e.target.closest('[data-lib="upload"]')) return openUploadSheet();
    var cp = e.target.closest("[data-cp]");
    if (cp) {
      var id = cp.getAttribute("data-cp");
      apiFetch(API_BASE + "/api/commands/" + id).then(function (c) {
        var code = (c && (c.command || (c.cmd && c.cmd.command))) || "";
        if (!code) return toast("这条指令需要购买后才能查看", true);
        CC.copy(code).then(function () { toast("已复制指令"); });
      }).catch(function (err) { toast("获取失败：" + err.message, true); });
      return;
    }
  });

  document.addEventListener("input", function (e) {
    if (e.target && e.target.id === "cc-lib-q") {
      libQ = e.target.value.trim();
      clearTimeout(window.__ccLibT);
      window.__ccLibT = setTimeout(renderLibList, 420);
    }
  });

  /* 上传指令 */
  function openUploadSheet() {
    if (!token()) return toast("上传需要先登录", true);
    sheet("上传指令",
      '<div class="cc-dsk-fld"><label>标题</label><input id="up-title" maxlength="60" placeholder="给指令起个名字"></div>' +
      '<div class="cc-dsk-fld"><label>说明（可选）</label><input id="up-desc" maxlength="120" placeholder="一句话说明用途"></div>' +
      '<div class="cc-dsk-fld"><label>指令内容</label><textarea id="up-cmd" class="cc-dsk-ta" rows="6" placeholder="/scoreboard objectives add coins dummy &quot;金币&quot;"></textarea></div>' +
      '<div class="cc-dsk-fld"><label>分类</label><select id="up-cat"><option value="other">其他</option>' +
      '<option value="scoreboard">计分板</option><option value="entity">实体</option>' +
      '<option value="item">物品</option><option value="effect">效果</option><option value="world">世界</option></select></div>' +
      '<div class="cc-dsk-fld"><label>标签（逗号分隔）</label><input id="up-tags" placeholder="脉冲,无连锁"></div>' +
      '<div class="cc-dsk-sheet-acts"><button class="btn sm pri" data-up="send">提交</button></div>' +
      '<div class="cc-dsk-hint">提交后需要管理员审核，通过后才会出现在「平台」里。</div>',
      function (wrap) {
        wrap.addEventListener("click", function (e) {
          if (!e.target.closest('[data-up="send"]')) return;
          var title = wrap.querySelector("#up-title").value.trim();
          var command = wrap.querySelector("#up-cmd").value.trim();
          if (!title || !command) return toast("标题和指令内容必填", true);
          apiFetch(API_BASE + "/api/commands", {
            method: "POST",
            body: {
              title: title,
              description: wrap.querySelector("#up-desc").value.trim(),
              command: command,
              category: wrap.querySelector("#up-cat").value,
              mc_version: "",
              tags: wrap.querySelector("#up-tags").value.trim(),
              price: "0",
            },
          }).then(function () {
            toast("已提交，等待审核");
            var s = document.getElementById("cc-dsk-sheet");
            if (s && s.parentNode) s.parentNode.removeChild(s);
            libTab = "mine";
            renderLibList();
          }).catch(function (err) { toast("提交失败：" + err.message, true); });
        });
      });
  }

  /* ---------------------------------------------------- 工具箱（分组补充） */

  /* 不替换 app.js 的工具列表（它的按钮已绑好事件），而是在它前后补：
     「生成器」标题 + 「实用工具」分组（网络测速 / MIDI / 查询 ID）。 */
  function injectTools() {
    var page = document.querySelector("#main .page");
    if (!page) return;
    var nav = document.querySelector(".nav-item.active");
    if (!nav || nav.getAttribute("data-page") !== "tools") return;
    if (page.querySelector("#cc-tool-extra")) return;
    var grid = page.querySelector(".gen-grid");
    if (!grid) return;   // 已经进了具体工具页，不处理

    var t = document.createElement("div");
    t.className = "sec-title";
    t.textContent = "生成器";
    page.insertBefore(t, grid);

    var extra = document.createElement("div");
    extra.id = "cc-tool-extra";
    extra.innerHTML = '<div class="sec-title">实用工具</div>' +
      '<div class="gen-grid">' +
      toolCard("speed", "网络测速", "延迟 / 下载 / 上传") +
      toolCard("mcref", "查询 ID", "输入中文查基岩版 ID") +
      toolCard("midi", "MIDI 工具", "曲库与音乐生成") +
      "</div>";
    grid.parentNode.insertBefore(extra, grid.nextSibling);
  }

  function toolCard(act, name, desc) {
    return '<button class="gcard" data-toolact="' + act + '">' +
      '<div class="ico">' + esc(name.slice(0, 1)) + "</div>" +
      "<b>" + esc(name) + "</b><span>" + esc(desc) + "</span></button>";
  }

  document.addEventListener("click", function (e) {
    var b = e.target.closest("[data-toolact]");
    if (!b) return;
    var act = b.getAttribute("data-toolact");
    if (act === "speed") return openSpeedSheet();
    if (act === "mcref") return openMcRefSheet();
    if (act === "midi") return openMidiSheet();
  });

  /* ---------------------------------------------------- 查询 ID */

  function openMcRefSheet() {
    sheet("查询 ID",
      '<div class="cc-lib-search" style="margin-bottom:12px">' + mi("search", "currentColor", 18) +
      '<input id="cc-ref-q" type="text" placeholder="输入中文，如 钻石剑 / 附魔台"></div>' +
      '<div id="cc-ref-list" class="cc-ref-list"><div class="cc-dsk-empty">输入关键词开始查询</div></div>',
      function (wrap) {
        var input = wrap.querySelector("#cc-ref-q");
        var box = wrap.querySelector("#cc-ref-list");
        var timer = null;

        function run() {
          var q = input.value.trim();
          if (!q) { box.innerHTML = '<div class="cc-dsk-empty">输入关键词开始查询</div>'; return; }
          box.innerHTML = '<div class="cc-dsk-loading">查询中…</div>';
          apiFetch(API_BASE + "/api/mcref/search?q=" + encodeURIComponent(q))
            .then(function (d) {
              var list = Array.isArray(d) ? d : ((d && (d.list || d.items)) || []);
              if (!list.length) { box.innerHTML = '<div class="cc-dsk-empty">没有匹配的 ID</div>'; return; }
              box.innerHTML = list.slice(0, 40).map(function (it) {
                var ids = Array.isArray(it.ids) ? it.ids : (it.id ? [it.id] : []);
                return '<div class="cc-ref-row"><b>' + esc(it.name || "") + "</b>" +
                  '<small>' + esc(it.kind || "") + "</small>" +
                  '<div class="ids">' + ids.map(function (id) {
                    return '<code data-copy="' + esc(id) + '">' + esc(id) + "</code>";
                  }).join("") + "</div></div>";
              }).join("");
            })
            .catch(function (e) {
              box.innerHTML = '<div class="cc-dsk-empty">查询失败：' + esc(e.message) + "</div>";
            });
        }

        input.addEventListener("input", function () {
          clearTimeout(timer);
          timer = setTimeout(run, 350);
        });
        box.addEventListener("click", function (e) {
          var c = e.target.closest("[data-copy]");
          if (!c) return;
          CC.copy(c.getAttribute("data-copy")).then(function () { toast("已复制 " + c.textContent); });
        });
        input.focus();
      });
  }

  /* ---------------------------------------------------- MIDI 工具 */

  function openMidiSheet() {
    sheet("MIDI 工具",
      '<div class="cc-dsk-hint" style="margin-top:0;margin-bottom:12px">' +
      "桌面版不做音频转 MIDI（需要采样与音高识别，效果不如手机端），" +
      "但可以直接用音符网格写曲子并生成命令方块音乐。</div>" +
      '<div class="cc-dsk-sheet-acts">' +
      '<button class="btn sm pri" data-midi="open">打开音乐生成器</button>' +
      "</div>",
      function (wrap) {
        wrap.addEventListener("click", function (e) {
          if (!e.target.closest('[data-midi="open"]')) return;
          var s2 = document.getElementById("cc-dsk-sheet");
          if (s2 && s2.parentNode) s2.parentNode.removeChild(s2);
          clickNav("tools");
          setTimeout(function () {
            var b = document.querySelector('[data-tool="music"]');
            if (b) b.click();
          }, 350);
        });
      });
  }

  /* ---------------------------------------------------- 广场详情 / 评论 */

  function openFeedDetail(item) {
    var isComment = item.type === "comment";
    var head = '<div class="cc-dsk-feed-item" style="margin-bottom:12px">' +
      '<div class="hd"><b>' + esc(item.author || "匿名") + "</b><small>" +
      esc(item.created_at || "") + "</small></div>" +
      (isComment
        ? '<p class="sub">评论了「' + esc(item.command_title || "指令") + "」</p>" +
          '<p class="body">' + esc(item.content || "") + "</p>"
        : '<b class="tt">' + esc(item.title || "未命名") + "</b>" +
          (item.description ? '<p class="sub">' + esc(item.description) + "</p>" : "") +
          '<div class="meta"><span>❤ ' + (item.like_count || 0) + "</span>" +
          "<span>👁 " + (item.view_count || 0) + "</span>" +
          "<span>💬 " + (item.comment_count || 0) + "</span></div>") +
      "</div>";

    var cmdId = item.command_id;
    if (!cmdId) {
      sheet("详情", head + '<div class="cc-dsk-empty">这条动态没有关联指令</div>');
      return;
    }

    sheet("详情", head + '<div id="cc-cmt-list"><div class="cc-dsk-loading">加载评论…</div></div>',
      function (wrap) {
        var box = wrap.querySelector("#cc-cmt-list");
        apiFetch(API_BASE + "/api/comments/command/" + cmdId + "?page=1&size=50")
          .then(function (d) {
            var list = Array.isArray(d) ? d : ((d && (d.list || d.items)) || []);
            if (!list.length) { box.innerHTML = '<div class="cc-dsk-empty">还没有评论</div>'; return; }
            box.innerHTML = list.map(function (c) {
              return '<div class="cc-dsk-chat-row"><b>' + esc(c.nickname || c.username || "玩家") +
                "</b>" + esc(c.content || "") + "<small>" + esc(c.created_at || "") + "</small></div>";
            }).join("");
          })
          .catch(function (e) {
            box.innerHTML = '<div class="cc-dsk-empty">评论加载失败：' + esc(e.message) + "</div>";
          });
      });
  }

  /* ---------------------------------------------------- 个人中心 / 设备 / 绑定 */

  function openProfileSheet() {
    var u = user() || {};
    sheet("个人中心",
      '<div class="cc-dsk-fld"><label>昵称</label><input id="pf-nick" maxlength="20" value="' + esc(u.nickname || "") + '"></div>' +
      '<div class="cc-dsk-fld"><label>邮箱</label><input id="pf-mail" value="' + esc(u.email || "") + '"></div>' +
      '<div class="cc-dsk-fld"><label>性别</label><select id="pf-gender">' +
      ["secret:保密", "male:男", "female:女"].map(function (o) {
        var kv = o.split(":");
        return '<option value="' + kv[0] + '"' + (u.gender === kv[0] ? " selected" : "") + ">" + kv[1] + "</option>";
      }).join("") + "</select></div>" +
      '<div class="cc-dsk-sheet-acts">' +
      '<button class="btn sm pri" data-pf="save">保存资料</button>' +
      '<button class="btn sm" data-pf="pwd">修改密码</button>' +
      "</div>" +
      '<div class="cc-dsk-hint">头像需要图片上传，请用手机 App 或网页版修改。</div>',
      function (wrap) {
        wrap.addEventListener("click", function (e) {
          if (e.target.closest('[data-pf="save"]')) {
            apiFetch(API_BASE + "/api/auth/profile", {
              method: "PUT",
              body: {
                nickname: wrap.querySelector("#pf-nick").value.trim(),
                email: wrap.querySelector("#pf-mail").value.trim(),
                gender: wrap.querySelector("#pf-gender").value,
              },
            }).then(function () { toast("资料已保存"); })
              .catch(function (err) { toast("保存失败：" + err.message, true); });
          } else if (e.target.closest('[data-pf="pwd"]')) {
            openPasswordSheet();
          }
        });
      });
  }

  function openPasswordSheet() {
    sheet("修改密码",
      '<div class="cc-dsk-fld"><label>当前密码</label><input id="pw-old" type="password"></div>' +
      '<div class="cc-dsk-fld"><label>新密码</label><input id="pw-new" type="password"></div>' +
      '<div class="cc-dsk-fld"><label>确认新密码</label><input id="pw-new2" type="password"></div>' +
      '<div class="cc-dsk-sheet-acts"><button class="btn sm pri" data-pw="save">修改</button></div>',
      function (wrap) {
        wrap.addEventListener("click", function (e) {
          if (!e.target.closest('[data-pw="save"]')) return;
          var a = wrap.querySelector("#pw-old").value;
          var b = wrap.querySelector("#pw-new").value;
          var c = wrap.querySelector("#pw-new2").value;
          if (!a || !b) return toast("密码不能为空", true);
          if (b !== c) return toast("两次输入的新密码不一致", true);
          apiFetch(API_BASE + "/api/auth/password", {
            method: "PUT", body: { old_password: a, new_password: b },
          }).then(function () { toast("密码已修改"); })
            .catch(function (err) { toast("修改失败：" + err.message, true); });
        });
      });
  }

  function openDevicesSheet() {
    sheet("我的 ID 与登录设备", '<div id="cc-dev-list"><div class="cc-dsk-loading">加载中…</div></div>',
      function (wrap) {
        var box = wrap.querySelector("#cc-dev-list");
        apiFetch(API_BASE + "/api/account/devices?size=30")
          .then(function (d) {
            var list = (d && (d.list || d.items)) || [];
            var head = '<div class="cc-dsk-hint" style="margin-top:0;margin-bottom:10px">账号 ID：' +
              esc((user() || {}).id || "—") + " · 共 " + ((d && d.total) || list.length) + " 台设备</div>";
            if (!list.length) { box.innerHTML = head + '<div class="cc-dsk-empty">没有设备记录</div>'; return; }
            box.innerHTML = head + list.map(function (x) {
              return '<div class="cc-ref-row"><b>' + esc(x.device_name || x.name || "未知设备") + "</b>" +
                "<small>" + esc(x.last_ip || x.ip || "") + " · " + esc(x.last_active || x.created_at || "") + "</small>" +
                (x.current ? '<div class="ids"><code>当前设备</code></div>' : "") + "</div>";
            }).join("");
          })
          .catch(function (e) { box.innerHTML = '<div class="cc-dsk-empty">加载失败：' + esc(e.message) + "</div>"; });
      });
  }

  function openBindingsSheet() {
    sheet("绑定账号", '<div id="cc-bind-list"><div class="cc-dsk-loading">加载中…</div></div>',
      function (wrap) {
        var box = wrap.querySelector("#cc-bind-list");
        apiFetch(API_BASE + "/api/account/bindings")
          .then(function (d) {
            var list = (d && (d.list || d.items)) || [];
            if (!list.length) { box.innerHTML = '<div class="cc-dsk-empty">还没有绑定任何账号</div>'; return; }
            box.innerHTML = list.map(function (b) {
              return '<div class="cc-ref-row"><b>' + esc(b.platform_label || b.platform) + "</b>" +
                "<small>" + esc(b.nickname || "") + " · " + esc(b.openid_masked || "") + "</small>" +
                '<div class="ids"><button class="btn sm" data-unbind="' + esc(b.id) + '">解绑</button></div></div>';
            }).join("");
          })
          .catch(function (e) { box.innerHTML = '<div class="cc-dsk-empty">加载失败：' + esc(e.message) + "</div>"; });

        box.addEventListener("click", function (e) {
          var b = e.target.closest("[data-unbind]");
          if (!b) return;
          apiFetch(API_BASE + "/api/account/bindings/" + b.getAttribute("data-unbind") + "/unbind", { method: "POST", body: {} })
            .then(function () { toast("已解绑"); openBindingsSheet(); })
            .catch(function (err) { toast("解绑失败：" + err.message, true); });
        });
      });
  }

  /* ---------------------------------------------------- 充值 */

  function openRechargeSheet() {
    sheet("积分充值", '<div id="cc-rc-list"><div class="cc-dsk-loading">加载中…</div></div>',
      function (wrap) {
        var box = wrap.querySelector("#cc-rc-list");
        apiFetch(API_BASE + "/api/recharge/plans")
          .then(function (d) {
            var list = (d && (d.list || d.plans)) || (Array.isArray(d) ? d : []);
            if (!list.length) { box.innerHTML = '<div class="cc-dsk-empty">暂时没有可用的充值档位</div>'; return; }
            box.innerHTML = list.filter(function (p) { return p.active !== false; }).map(function (p) {
              var yuan = ((p.price_cents || 0) / 100).toFixed(2);
              var total = p.total_points || ((p.points || 0) + (p.bonus_points || 0));
              return '<div class="cc-rc-row"><div class="l"><b>' + esc(p.title || (total + " 积分")) + "</b>" +
                "<small>到账 " + total + " 积分" + (p.bonus_points ? "（含赠送 " + p.bonus_points + "）" : "") +
                "</small></div><div class=\"r\">¥" + yuan + "</div></div>";
            }).join("") +
              '<div class="cc-dsk-hint">支付流程需要唤起微信/支付宝，桌面版暂不支持直接下单。' +
              "请在手机 App 内完成充值，积分会同步到账号。</div>";
          })
          .catch(function (e) { box.innerHTML = '<div class="cc-dsk-empty">加载失败：' + esc(e.message) + "</div>"; });
      });
  }

  /* ---------------------------------------------------- 好友 / 私信 */

  function openFriendsSheet() {
    if (!token()) return toast("请先登录", true);
    sheet("好友", '<div id="cc-fr-list"><div class="cc-dsk-loading">加载中…</div></div>',
      function (wrap) {
        var box = wrap.querySelector("#cc-fr-list");
        apiFetch(API_BASE + "/api/friends")
          .then(function (d) {
            var list = Array.isArray(d) ? d : ((d && (d.list || d.items)) || []);
            if (!list.length) { box.innerHTML = '<div class="cc-dsk-empty">还没有好友</div>'; return; }
            box.innerHTML = list.map(function (f) {
              var pending = f.status === "pending";
              var peer = f.peer_id || f.friend_id || f.user_id;
              return '<div class="cc-ref-row"><b>' + esc(f.nickname || f.username || ("用户 " + peer)) + "</b>" +
                "<small>" + (pending ? "待处理" : "好友") + " · " + esc(f.created_at || "") + "</small>" +
                '<div class="ids">' +
                (pending
                  ? '<button class="btn sm" data-fr="accept:' + esc(f.id) + '">同意</button>' +
                    '<button class="btn sm" data-fr="reject:' + esc(f.id) + '">拒绝</button>'
                  : '<button class="btn sm" data-fr="dm:' + esc(peer) + '">私信</button>' +
                    '<button class="btn sm" data-fr="del:' + esc(peer) + '">删除</button>') +
                "</div></div>";
            }).join("");
          })
          .catch(function (e) { box.innerHTML = '<div class="cc-dsk-empty">加载失败：' + esc(e.message) + "</div>"; });

        box.addEventListener("click", function (e) {
          var b = e.target.closest("[data-fr]");
          if (!b) return;
          var v = b.getAttribute("data-fr").split(":");
          var act = v[0], id = v[1];
          if (act === "dm") return openDmSheet(id);
          if (act === "accept" || act === "reject") {
            apiFetch(API_BASE + "/api/friends/handle", {
              method: "POST", body: { id: id, action: act === "accept" ? "accept" : "reject" },
            }).then(function () { toast("已处理"); openFriendsSheet(); })
              .catch(function (err) { toast("操作失败：" + err.message, true); });
          } else if (act === "del") {
            apiFetch(API_BASE + "/api/friends/remove", { method: "POST", body: { friend_id: id } })
              .then(function () { toast("已删除"); openFriendsSheet(); })
              .catch(function (err) { toast("删除失败：" + err.message, true); });
          }
        });
      });
  }

  function openDmSheet(peer) {
    sheet("私信",
      '<div id="cc-dm-list" class="cc-dsk-chat"><div class="cc-dsk-loading">加载中…</div></div>' +
      '<div class="cc-dsk-chat-bar"><input id="cc-dm-in" type="text" maxlength="200" placeholder="发消息…">' +
      '<button class="btn sm pri" data-dm="send">发送</button></div>',
      function (wrap) {
        var list = wrap.querySelector("#cc-dm-list");
        var input = wrap.querySelector("#cc-dm-in");

        function load() {
          apiFetch(API_BASE + "/api/dm/messages?peer_id=" + encodeURIComponent(peer) + "&size=50")
            .then(function (d) {
              var items = Array.isArray(d) ? d : ((d && (d.list || d.items || d.messages)) || []);
              if (!items.length) { list.innerHTML = '<div class="cc-dsk-empty">还没有消息</div>'; return; }
              var me = (user() || {}).id;
              list.innerHTML = items.map(function (m) {
                var mine = String(m.from_id) === String(me);
                return '<div class="cc-dsk-chat-row' + (mine ? " me" : "") + '">' +
                  "<span>" + esc(m.content || "") + "</span>" +
                  "<small>" + esc(m.created_at || "") + "</small></div>";
              }).join("");
              list.scrollTop = list.scrollHeight;
            })
            .catch(function (e) { list.innerHTML = '<div class="cc-dsk-empty">加载失败：' + esc(e.message) + "</div>"; });
        }

        wrap.addEventListener("click", function (e) {
          if (!e.target.closest('[data-dm="send"]')) return;
          var text = input.value.trim();
          if (!text) return;
          apiFetch(API_BASE + "/api/dm/messages", { method: "POST", body: { to_id: peer, content: text } })
            .then(function () { input.value = ""; load(); })
            .catch(function (err) { toast("发送失败：" + err.message, true); });
        });
        input.addEventListener("keydown", function (e) {
          if (e.key === "Enter") { var b = wrap.querySelector('[data-dm="send"]'); if (b) b.click(); }
        });
        load();
      });
  }

  /* ---------------------------------------------------- 插件库 */

  function openPluginsSheet() {
    sheet("插件库", '<div id="cc-pl-list"><div class="cc-dsk-loading">加载中…</div></div>',
      function (wrap) {
        var box = wrap.querySelector("#cc-pl-list");
        apiFetch(API_BASE + "/api/plugins?page=1&size=40")
          .then(function (d) {
            var list = Array.isArray(d) ? d : ((d && (d.list || d.items)) || []);
            if (!list.length) { box.innerHTML = '<div class="cc-dsk-empty">还没有插件</div>'; return; }
            box.innerHTML = list.map(function (p) {
              return '<div class="cc-ref-row"><b>' + esc(p.title || "未命名插件") + "</b>" +
                "<small>v" + esc(p.version || "1.0.0") + " · " +
                (p.platform === "bedrock" ? "基岩版" : "Java 版") + " · 下载 " + (p.downloads || 0) +
                " · " + esc(p.author || "") + "</small>" +
                (p.description ? '<div class="ids"><span style="font-size:12px;color:var(--text2)">' +
                  esc(p.description) + "</span></div>" : "") + "</div>";
            }).join("") +
              '<div class="cc-dsk-hint">插件需要在游戏端安装（Java 版放 mods，基岩版用行为包），桌面版只做浏览。</div>';
          })
          .catch(function (e) { box.innerHTML = '<div class="cc-dsk-empty">加载失败：' + esc(e.message) + "</div>"; });
      });
  }

  var homeBound = false;

  function renderDesktopHome() {
    var page = document.querySelector("#main .page");
    if (!page) return;
    var nav = document.querySelector(".nav-item.active");
    if (!nav || nav.getAttribute("data-page") !== "home") return;
    if (page.dataset.dskHome === "1") return;
    page.dataset.dskHome = "1";
    page.innerHTML = buildHomeHtml();
  }

  /* 首页模块点击：先切 tab，再（可选）打开具体生成器 */
  document.addEventListener("click", function (e) {
    var m = e.target.closest("[data-mod]");
    if (!m) return;
    var go = m.getAttribute("data-mod");
    var tool = m.getAttribute("data-tool");

    if (go === "library" || go === "tools" || go === "ai") {
      clickNav(go);
      if (tool) {
        setTimeout(function () {
          var b = document.querySelector('[data-tool="' + tool + '"]');
          if (b) b.click();
        }, 500);
      }
      return;
    }
    if (go === "editor") return openEditorSheet();
    if (go === "speed") return openSpeedSheet();
    if (go === "gomoku") return openGomokuSheet();
    if (go === "feedback") return openFeedbackSheet();
    if (go === "chat") return openChatSheet();
    if (go === "kids") return openKidsSheet();
  });

  /* ---------------------------------------------------- 更多页：桌面区块 */

  function sectionTitle(text) {
    var d = document.createElement("div");
    d.className = "sec-title";
    d.textContent = text;
    return d;
  }

  function row(icon, title, sub, act) {
    return '<div class="li" data-dsk="' + esc(act) + '"><div class="ico">' + icon + "</div>" +
      '<div class="t">' + esc(title) + (sub ? "<small>" + esc(sub) + "</small>" : "") + "</div>" +
      '<span class="arrow">›</span></div>';
  }

  function buildAccountBlock() {
    var u = user();
    var t = token();
    var wrap = document.createElement("div");
    wrap.id = "cc-dsk-account";

    if (!t || !u) {
      wrap.appendChild(sectionTitle("账号"));
      var list = document.createElement("div");
      list.className = "list";
      list.innerHTML = row("👤", "登录账号", "登录后可用免费 AI、云同步、积分签到", "login");
      wrap.appendChild(list);
      return wrap;
    }

    var ov = overview || {};
    var ck = checkin || {};
    var points = ov.points !== undefined ? ov.points
      : (ck.points !== undefined ? ck.points : (u.points || 0));
    // ★ 字段名是 checked_today（服务端 snake_case），不是 checked_in
    var checked = !!(ck.checked_today || ov.checked_today);
    var streak = ck.streak !== undefined ? ck.streak : (ov.streak || 0);

    wrap.appendChild(sectionTitle("账号"));
    var card = document.createElement("div");
    card.className = "card cc-dsk-acc-card";
    card.innerHTML =
      '<div class="cc-dsk-acc-head">' +
        '<div class="cc-dsk-avatar">' + esc(String(u.nickname || u.username || "?").slice(0, 1).toUpperCase()) + "</div>" +
        '<div class="cc-dsk-acc-id"><b>' + esc(u.nickname || u.username || "?") + "</b>" +
        "<small>ID " + esc(u.id || "—") + " · 积分 " + fmtNum(points) + "</small></div>" +
        '<button class="btn sm" data-dsk="account">账号中心</button>' +
      "</div>" +
      '<div class="cc-dsk-acc-actions">' +
        '<button class="btn sm' + (checked ? "" : " pri") + '" data-dsk="checkin"' + (checked ? " disabled" : "") + ">" +
        (checked ? "今日已签到" : "签到") + "</button>" +
        '<button class="btn sm" data-dsk="sync">同步对话</button>' +
        '<button class="btn sm" data-dsk="points">积分记录</button>' +
      "</div>" +
      (streak ? '<div class="cc-dsk-acc-foot">连续签到 ' + esc(streak) + " 天</div>" : "");
    wrap.appendChild(card);
    return wrap;
  }

  /* 公告：来自官方 api/announcements，只显示最近 3 条 */
  function buildNoticeBlock() {
    var wrap = document.createElement("div");
    wrap.id = "cc-dsk-notice";
    if (!notices || !notices.length) return wrap;

    wrap.appendChild(sectionTitle("公告"));
    var card = document.createElement("div");
    card.className = "card cc-dsk-notice-card";
    card.innerHTML = notices.slice(0, 3).map(function (n) {
      var cls = n.type === "warning" ? "warn" : (n.type === "danger" ? "danger" : "");
      return '<div class="cc-dsk-notice-item ' + cls + '">' +
        "<b>" + esc(n.title || "公告") + "</b>" +
        "<p>" + esc(n.content || "") + "</p>" +
        (n.created_at ? "<small>" + esc(n.created_at) + "</small>" : "") +
        "</div>";
    }).join("");
    wrap.appendChild(card);
    return wrap;
  }

  function buildDesktopBlock() {
    var wrap = document.createElement("div");
    wrap.id = "cc-dsk-block";
    wrap.appendChild(sectionTitle("桌面"));

    var list = document.createElement("div");
    list.className = "list";
    var auto = info && info.autostart;
    var tray = info ? info.minimizeToTray : true;
    var lastSync = lsGet("cc_dsk_sync_at", 0);

    list.innerHTML =
      row("⤓", "备份全部数据", "导出对话、设置与登录态到 JSON", "backup") +
      row("⤒", "从备份恢复", "覆盖当前数据，恢复前会自动提示", "restore") +
      row("🗁", "打开数据目录", (info && info.dataDir) || "本地数据文件位置", "datadir") +
      '<div class="li" data-dsk="autostart"><div class="ico">⚡</div>' +
        '<div class="t">开机自启<small>' + (auto ? "已开启" : "已关闭") + "</small></div>" +
        '<span class="cc-dsk-switch' + (auto ? " on" : "") + '"></span></div>' +
      '<div class="li" data-dsk="tray"><div class="ico">▣</div>' +
        '<div class="t">关闭时最小化到托盘<small>' + (tray ? "已开启" : "已关闭") + "</small></div>" +
        '<span class="cc-dsk-switch' + (tray ? " on" : "") + '"></span></div>' +
      row("⟳", "云同步", lastSync ? "上次同步 " + fmtTime(lastSync) : "尚未同步过", "sync") +
      row("👤", "个人中心", "昵称 / 邮箱 / 性别 / 密码", "profile") +
      row("📱", "我的 ID 与登录设备", "账号 ID 与最近登录", "devices") +
      row("🔗", "绑定账号", "QQ 等第三方账号", "bindings") +
      row("💰", "积分充值", "查看充值档位", "recharge") +
      row("👥", "好友", "好友列表与私信", "friends") +
      row("🧩", "插件库", "浏览已发布的插件", "plugins");
    wrap.appendChild(list);

    var about = document.createElement("div");
    about.className = "card";
    var hasNew = latestVer && cmpVer(latestVer.latest, (info && info.version) || "0") > 0;
    about.innerHTML =
      '<h3><span class="dot"></span>桌面版</h3><dl class="kv">' +
      "<dt>版本</dt><dd>v" + esc((info && info.version) || "—") +
        (hasNew ? ' <span class="cc-dsk-newver">→ v' + esc(latestVer.latest) + " 可用</span>" : "") + "</dd>" +
      "<dt>内核</dt><dd>Electron " + esc((info && info.electron) || "—") +
        " · Chromium " + esc((info && (info.chrome || "").split(".")[0]) || "—") + "</dd>" +
      "<dt>命令行</dt><dd>cyancodex --help</dd>" +
      "</dl>" +
      '<div class="cc-dsk-about-acts">' +
      '<button class="btn sm" data-dsk="checkupdate">检查更新</button>' +
      (hasNew ? '<button class="btn sm pri" data-dsk="download">下载 v' + esc(latestVer.latest) + "</button>" : "") +
      '<button class="btn sm" data-dsk="datadir">数据目录</button>' +
      "</div>";
    wrap.appendChild(about);
    return wrap;
  }

  function injectMore() {
    var page = document.querySelector("#main .page");
    if (!page) return;
    var nav = document.querySelector(".nav-item.active");
    if (!nav || nav.getAttribute("data-page") !== "more") return;

    // 桌面版不需要「下载 App」——这是给手机准备的入口，放在桌面版里没有意义
    Array.prototype.forEach.call(page.querySelectorAll(".li"), function (li) {
      if (!li.closest("#cc-dsk-block") && /下载 App/.test(li.textContent || "")) {
        li.parentNode.removeChild(li);
      }
    });

    var titles = Array.prototype.slice.call(page.querySelectorAll(".sec-title"));
    var aboutTitle = titles.filter(function (t) { return /^关于/.test(t.textContent); })[0];
    var appTitle = titles.filter(function (t) { return /^应用/.test(t.textContent); })[0];

    if (!page.querySelector("#cc-dsk-account")) {
      var acc = buildAccountBlock();
      if (appTitle) page.insertBefore(acc, appTitle);
      else page.insertBefore(acc, page.firstChild);
    }
    if (!page.querySelector("#cc-dsk-notice") && notices && notices.length) {
      var nt = buildNoticeBlock();
      if (appTitle) page.insertBefore(nt, appTitle);
      else page.insertBefore(nt, page.firstChild);
    }
    if (!page.querySelector("#cc-dsk-block")) {
      var blk = buildDesktopBlock();
      if (aboutTitle) page.insertBefore(blk, aboutTitle);
      else page.appendChild(blk);
    }
  }

  /* ---------------------------------------------------- 更多页事件委托 */

  document.addEventListener("click", function (e) {
    var el = e.target.closest("[data-dsk]");
    if (!el) return;
    var act = el.getAttribute("data-dsk");

    if (act === "login") {
      var b = document.querySelector("#btnLoginTop");
      if (b) b.click();
    } else if (act === "account") {
      openAccountSheet();
    } else if (act === "checkin") {
      doCheckin();
    } else if (act === "points") {
      openPointsSheet();
    } else if (act === "sync") {
      doSync();
    } else if (act === "backup") {
      CC.backup().then(function (r) {
        if (r && r.ok) toast("已备份到 " + r.path);
        else if (r && !r.canceled) toast("备份失败：" + (r.message || ""), true);
      });
    } else if (act === "restore") {
      CC.restore().then(function (r) {
        if (r && r.ok) toast("已恢复，正在重新加载…");
        else if (r && !r.canceled) toast("恢复失败：" + (r.message || ""), true);
      });
    } else if (act === "datadir") {
      CC.openDataDir();
    } else if (act === "profile") {
      openProfileSheet();
    } else if (act === "devices") {
      openDevicesSheet();
    } else if (act === "bindings") {
      openBindingsSheet();
    } else if (act === "recharge") {
      openRechargeSheet();
    } else if (act === "friends") {
      openFriendsSheet();
    } else if (act === "plugins") {
      openPluginsSheet();
    } else if (act === "checkupdate") {
      checkUpdate();
    } else if (act === "download") {
      if (latestVer && latestVer.url) {
        window.open(latestVer.url, "_blank");
        toast("已在浏览器打开安装包下载");
      } else {
        toast("没有拿到下载地址", true);
      }
    } else if (act === "autostart") {
      var on = !(info && info.autostart);
      CC.autostart(on).then(function (r) {
        if (info) info.autostart = r.value;
        toast(r.value ? "已开启开机自启" : "已关闭开机自启");
        injectMoreRefresh();
      });
    } else if (act === "tray") {
      var cur = info ? info.minimizeToTray : true;
      CC.minimizeToTray(!cur).then(function (r) {
        if (info) info.minimizeToTray = r.value;
        toast(r.value ? "关闭窗口时会最小化到托盘" : "关闭窗口即退出");
        injectMoreRefresh();
      });
    } else if (act === "logout") {
      try {
        localStorage.removeItem(S_TOKEN);
        localStorage.removeItem(S_USER);
      } catch (err) { /* ignore */ }
      var sh = document.getElementById("cc-dsk-sheet");
      if (sh && sh.parentNode) sh.parentNode.removeChild(sh);
      toast("已退出登录");
      location.reload();
    }
  });

  function injectMoreRefresh() {
    var a = document.getElementById("cc-dsk-account");
    var b = document.getElementById("cc-dsk-block");
    var n = document.getElementById("cc-dsk-notice");
    if (a && a.parentNode) a.parentNode.removeChild(a);
    if (b && b.parentNode) b.parentNode.removeChild(b);
    if (n && n.parentNode) n.parentNode.removeChild(n);
    injectMore();
  }

  /* ------------------------------------------------------------ 签到 */

  function doCheckin() {
    if (!token()) return toast("请先登录", true);
    apiFetch(API_BASE + "/api/checkin", { method: "POST", body: {} })
      .then(function (d) {
        // 响应字段：gained（本次获得）/ bonus（连续奖励）/ streak
        var got = (d && (d.gained || d.today_gain)) || 0;
        var bonus = (d && d.bonus) || 0;
        var msg = "签到成功";
        if (got) msg += "，+" + got + " 积分";
        if (bonus) msg += "（连续奖励 +" + bonus + "）";
        toast(msg);
        return loadOverview();
      })
      .then(function () { injectMoreRefresh(); })
      .catch(function (e) { toast("签到失败：" + e.message, true); });
  }

  /* ------------------------------------------------------------ 弹层 */

  function sheet(title, html, onMount) {
    var old = document.getElementById("cc-dsk-sheet");
    if (old && old.parentNode) old.parentNode.removeChild(old);

    var wrap = document.createElement("div");
    wrap.id = "cc-dsk-sheet";
    wrap.className = "sheet on";
    wrap.innerHTML =
      '<div class="sheet-box"><div class="sheet-hd"><b>' + esc(title) + "</b>" +
      '<div class="sp"></div><button class="x" data-sheet-close>×</button></div>' +
      '<div class="cc-dsk-sheet-body">' + html + "</div></div>";
    document.body.appendChild(wrap);

    wrap.addEventListener("click", function (e) {
      if (e.target === wrap || e.target.hasAttribute("data-sheet-close")) {
        if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
      }
    });
    if (onMount) onMount(wrap);
    return wrap;
  }

  function openAccountSheet() {
    var u = user() || {};
    var ov = overview || {};
    var html =
      '<dl class="kv">' +
      "<dt>昵称</dt><dd>" + esc(u.nickname || "—") + "</dd>" +
      "<dt>用户名</dt><dd>" + esc(u.username || "—") + "</dd>" +
      "<dt>邮箱</dt><dd>" + esc(u.email || "—") + "</dd>" +
      "<dt>积分</dt><dd>" + fmtNum(ov.points !== undefined ? ov.points : u.points) + "</dd>" +
      "<dt>AI 权限</dt><dd>" + (u.ai_unlocked ? "已解锁" : "免费通道") + "</dd>" +
      "<dt>注册时间</dt><dd>" + esc(u.created_at || "—") + "</dd>" +
      "</dl>" +
      '<div class="cc-dsk-sheet-acts">' +
      '<button class="btn sm" data-dsk="checkin">签到</button>' +
      '<button class="btn sm" data-dsk="sync">同步对话</button>' +
      '<button class="btn sm" data-dsk="logout">退出登录</button>' +
      "</div>";
    sheet("账号中心", html);
  }

  function openPointsSheet() {
    sheet("积分记录", '<div class="cc-dsk-loading">正在读取积分记录…</div>', function (wrap) {
      var box = wrap.querySelector(".cc-dsk-sheet-body");
      // ★ 路径是 api/points（不是 api/account/points），返回 { list:[{delta,balance,reason,created_at}] }
      apiFetch(API_BASE + "/api/points?page=1&size=30")
        .then(function (d) {
          var list = (d && (d.list || d.items)) || [];
          if (!list.length) {
            box.innerHTML = '<div class="cc-dsk-empty">还没有积分记录</div>';
            return;
          }
          box.innerHTML = '<div class="cc-dsk-points">' + list.map(function (it) {
            var n = Number(it.delta || 0);
            var bal = it.balance !== undefined ? " · 余额 " + fmtNum(it.balance) : "";
            return '<div class="cc-dsk-pt-row"><div class="t">' + esc(it.reason || "积分变动") +
              "<small>" + esc(it.created_at || "") + esc(bal) + "</small></div>" +
              '<div class="v ' + (n >= 0 ? "up" : "down") + '">' + (n >= 0 ? "+" : "") + n + "</div></div>";
          }).join("") + "</div>";
        })
        .catch(function (e) {
          box.innerHTML = '<div class="cc-dsk-empty">读取失败：' + esc(e.message) + "</div>";
        });
    });
  }

  /* ---------------------------------------------------- 菜单 / 外部文件 */

  function clickNav(page) {
    var b = document.querySelector('.nav-item[data-page="' + page + '"]');
    if (b) b.click();
  }

  CC.onMenu(function (payload) {
    if (!payload) return;
    if (payload.action === "go") {
      clickNav(payload.page === "account" ? "more" : payload.page);
      if (payload.page === "account") setTimeout(openAccountSheet, 300);
    } else if (payload.action === "export") doExport();
    else if (payload.action === "import") importFile();
    else if (payload.action === "new-conv") {
      clickNav("ai");
      setTimeout(function () {
        var b = document.querySelector("#btnNewConvTop") || document.querySelector("#btnNewConv");
        if (b) b.click();
      }, 200);
    } else if (payload.action === "update") {
      clickNav("more");
      setTimeout(function () {
        var hit = Array.prototype.slice.call(document.querySelectorAll(".row, button, .item, .li"))
          .filter(function (el) { return /检查更新/.test(el.innerText || ""); })[0];
        if (hit) hit.click();
        else toast("在「更多 → 关于」里可以检查更新");
      }, 300);
    } else if (payload.action === "about") {
      clickNav("more");
    }
  });

  function importFile() {
    CC.openFile().then(function (r) {
      if (!r || !r.ok) return;
      clickNav("ai");
      setTimeout(function () {
        var box = document.querySelector("#aiInput");
        if (box) {
          box.value = (box.value ? box.value + "\n" : "") + r.content.slice(0, 20000);
          box.dispatchEvent(new Event("input", { bubbles: true }));
          box.focus();
          toast("已导入 " + r.name);
        }
      }, 260);
    });
  }

  /* 命令行带文件启动（把 .mcfunction 拖到 exe 上打开时） */
  CC.onFiles(function (list) {
    if (!list || !list.length) return;
    toast("收到 " + list.length + " 个文件，正在导入…");
    clickNav("ai");
    setTimeout(function () {
      var box = document.querySelector("#aiInput");
      if (box) {
        box.value = (box.value ? box.value + "\n" : "") + "/* " + list[0].split(/[\\/]/).pop() + " */";
        box.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }, 400);
  });

  /* ---------------------------------------------------- 拖拽导入 */

  var dragOver = false;
  document.addEventListener("dragover", function (e) {
    e.preventDefault();
    if (!dragOver) {
      dragOver = true;
      document.body.classList.add("cc-dsk-dragging");
    }
  });
  document.addEventListener("dragleave", function (e) {
    if (e.relatedTarget === null) {
      dragOver = false;
      document.body.classList.remove("cc-dsk-dragging");
    }
  });
  document.addEventListener("drop", function (e) {
    e.preventDefault();
    dragOver = false;
    document.body.classList.remove("cc-dsk-dragging");
    var files = e.dataTransfer && e.dataTransfer.files;
    if (!files || !files.length) return;
    var f = files[0];
    if (f.size > 2 * 1024 * 1024) return toast("文件太大（上限 2MB）", true);
    var reader = new FileReader();
    reader.onload = function () {
      clickNav("ai");
      setTimeout(function () {
        var box = document.querySelector("#aiInput");
        if (box) {
          box.value = (box.value ? box.value + "\n" : "") + String(reader.result).slice(0, 20000);
          box.dispatchEvent(new Event("input", { bubbles: true }));
          box.focus();
        }
        toast("已导入 " + f.name);
      }, 240);
    };
    reader.readAsText(f);
  });

  /* ---------------------------------------------------- 快捷键 */

  document.addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      doExport();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      var box = document.querySelector("#aiInput");
      if (box && document.activeElement === box) {
        e.preventDefault();
        var send = document.querySelector("#aiSend");
        if (send && !send.disabled) send.click();
      }
    }
  });

  document.addEventListener("dragstart", function (e) {
    if (e.target && e.target.tagName === "IMG") e.preventDefault();
  });

  /* ---------------------------------------------------- 指令编辑器 */

  function openEditorSheet() {
    sheet("指令编辑器",
      '<textarea id="cc-editor" class="cc-dsk-ta" spellcheck="false" ' +
      'placeholder="粘贴指令，一行一条…"></textarea>' +
      '<div class="cc-dsk-sheet-acts">' +
      '<button class="btn sm" data-ed="clean">清空行</button>' +
      '<button class="btn sm" data-ed="dedup">去重</button>' +
      '<button class="btn sm" data-ed="sort">排序</button>' +
      '<button class="btn sm" data-ed="slash">补 /</button>' +
      '<button class="btn sm pri" data-ed="copy">复制</button>' +
      "</div>" +
      '<div class="cc-dsk-ed-stat" id="cc-ed-stat">0 行 · 0 条指令</div>',
      function (wrap) {
        var ta = wrap.querySelector("#cc-editor");
        var stat = wrap.querySelector("#cc-ed-stat");

        function lines() {
          return ta.value.split(/\r?\n/);
        }
        function update() {
          var ls = lines().filter(function (l) { return l.trim(); });
          var cmds = ls.filter(function (l) { return l.trim().charAt(0) === "/"; });
          stat.textContent = ls.length + " 行 · " + cmds.length + " 条指令";
        }
        ta.addEventListener("input", update);

        wrap.addEventListener("click", function (e) {
          var b = e.target.closest("[data-ed]");
          if (!b) return;
          var act = b.getAttribute("data-ed");
          var ls = lines();
          if (act === "clean") {
            ta.value = ls.filter(function (l) { return l.trim(); }).join("\n");
          } else if (act === "dedup") {
            var seen = {};
            ta.value = ls.filter(function (l) {
              var t = l.trim();
              if (!t || seen[t]) return false;
              seen[t] = 1;
              return true;
            }).join("\n");
          } else if (act === "sort") {
            ta.value = ls.filter(function (l) { return l.trim(); }).sort().join("\n");
          } else if (act === "slash") {
            ta.value = ls.map(function (l) {
              var t = l.trim();
              if (!t) return l;
              return t.charAt(0) === "/" || t.charAt(0) === "#" ? l : "/" + t;
            }).join("\n");
          } else if (act === "copy") {
            var cmds = ls.filter(function (l) { return l.trim().charAt(0) === "/"; });
            if (!cmds.length) return toast("没有可复制的指令", true);
            CC.copy(cmds.join("\n")).then(function () {
              toast("已复制 " + cmds.length + " 条");
            });
            return;
          }
          update();
          toast("已处理");
        });
        update();
        ta.focus();
      });
  }

  /* ---------------------------------------------------- 网络测速 */

  function openSpeedSheet() {
    sheet("网络测速",
      '<div class="cc-dsk-speed">' +
      '<div class="row"><span>延迟</span><b id="cc-sp-ping">—</b></div>' +
      '<div class="row"><span>服务端响应</span><b id="cc-sp-api">—</b></div>' +
      '<div class="row"><span>下载</span><b id="cc-sp-dl">—</b></div>' +
      "</div>" +
      '<div class="cc-dsk-sheet-acts"><button class="btn sm pri" data-sp="run">开始测速</button></div>' +
      '<div class="cc-dsk-hint">延迟为到服务端 HTTP 往返，下载测的是本机拉取 1 个静态资源的速度。</div>',
      function (wrap) {
        var elPing = wrap.querySelector("#cc-sp-ping");
        var elApi = wrap.querySelector("#cc-sp-api");
        var elDl = wrap.querySelector("#cc-sp-dl");

        wrap.addEventListener("click", function (e) {
          if (!e.target.closest('[data-sp="run"]')) return;
          elPing.textContent = "测量中…";
          elApi.textContent = "—";
          elDl.textContent = "—";

          var times = [];
          var chain = Promise.resolve();
          for (var i = 0; i < 5; i++) {
            chain = chain.then(function () {
              var t0 = performance.now();
              return fetch("/api/v1/app/version?t=" + Date.now(), { cache: "no-store" })
                .then(function (r) { return r.text(); })
                .then(function () { times.push(performance.now() - t0); });
            });
          }
          chain.then(function () {
            var avg = times.reduce(function (a, b) { return a + b; }, 0) / times.length;
            var min = Math.min.apply(null, times);
            elPing.textContent = Math.round(avg) + " ms（最快 " + Math.round(min) + " ms）";
            elApi.textContent = Math.round(avg) + " ms";

            // 下载：拉一个约 100KB 的静态资源
            var t0 = performance.now();
            return fetch("/web/style.css?t=" + Date.now(), { cache: "no-store" })
              .then(function (r) { return r.arrayBuffer(); })
              .then(function (buf) {
                var sec = (performance.now() - t0) / 1000;
                var kbps = buf.byteLength / 1024 / Math.max(sec, 0.001);
                elDl.textContent = kbps > 1024
                  ? (kbps / 1024).toFixed(2) + " MB/s"
                  : Math.round(kbps) + " KB/s";
              });
          }).catch(function (e) {
            elPing.textContent = "失败：" + e.message;
          });
        });
      });
  }

  /* ---------------------------------------------------- 五子棋 */

  function openGomokuSheet() {
    var N = 15;
    var board = new Array(N * N).fill(0); // 0 空 1 黑(玩家) 2 白(AI)
    var over = false;

    sheet("五子棋", '<div class="cc-dsk-gomoku"><div id="cc-gm-board" class="cc-gm-board"></div>' +
      '<div class="cc-gm-foot"><span id="cc-gm-tip">你执黑先行</span>' +
      '<button class="btn sm" data-gm="reset">重开</button></div></div>',
      function (wrap) {
        var host = wrap.querySelector("#cc-gm-board");
        var tip = wrap.querySelector("#cc-gm-tip");

        host.style.gridTemplateColumns = "repeat(" + N + ", 1fr)";
        for (var i = 0; i < N * N; i++) {
          var d = document.createElement("button");
          d.className = "cc-gm-cell";
          d.dataset.i = i;
          host.appendChild(d);
        }

        function win(b, x, y, p) {
          var dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
          for (var k = 0; k < 4; k++) {
            var dx = dirs[k][0], dy = dirs[k][1], n = 1;
            for (var s = 1; s < 5; s++) {
              var nx = x + dx * s, ny = y + dy * s;
              if (nx < 0 || ny < 0 || nx >= N || ny >= N || b[ny * N + nx] !== p) break;
              n++;
            }
            for (var s2 = 1; s2 < 5; s2++) {
              var nx2 = x - dx * s2, ny2 = y - dy * s2;
              if (nx2 < 0 || ny2 < 0 || nx2 >= N || ny2 >= N || b[ny2 * N + nx2] !== p) break;
              n++;
            }
            if (n >= 5) return true;
          }
          return false;
        }

        function paint() {
          var cells = host.children;
          for (var i = 0; i < board.length; i++) {
            cells[i].className = "cc-gm-cell" +
              (board[i] === 1 ? " black" : board[i] === 2 ? " white" : "");
          }
        }

        // 简单评分：只看「这一格四个方向能连多少」
        function score(b, i, p) {
          var x = i % N, y = Math.floor(i / N);
          var dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
          var total = 0;
          for (var k = 0; k < 4; k++) {
            var cnt = 1;
            for (var s = 1; s < 5; s++) {
              var nx = x + dirs[k][0] * s, ny = y + dirs[k][1] * s;
              if (nx < 0 || ny < 0 || nx >= N || ny >= N) break;
              var v = b[ny * N + nx];
              if (v === p) cnt++;
              else if (v === 0) break;
              else { cnt = -99; break; }
            }
            for (var s2 = 1; s2 < 5; s2++) {
              var nx2 = x - dirs[k][0] * s2, ny2 = y - dirs[k][1] * s2;
              if (nx2 < 0 || ny2 < 0 || nx2 >= N || ny2 >= N) break;
              var v2 = b[ny2 * N + nx2];
              if (v2 === p) cnt++;
              else if (v2 === 0) break;
              else { cnt = -99; break; }
            }
            if (cnt > 0) total += cnt * cnt;
          }
          return total;
        }

        function aiMove() {
          var best = -1, bestScore = -1;
          for (var i = 0; i < board.length; i++) {
            if (board[i] !== 0) continue;
            // 空棋盘中心优先
            var sc = score(board, i, 2) * 1.05 + score(board, i, 1);
            var x = i % N, y = Math.floor(i / N);
            sc += (7 - Math.abs(x - 7)) * 0.1 + (7 - Math.abs(y - 7)) * 0.1;
            if (sc > bestScore) { bestScore = sc; best = i; }
          }
          if (best >= 0) board[best] = 2;
          return best;
        }

        host.addEventListener("click", function (e) {
          var cell = e.target.closest(".cc-gm-cell");
          if (!cell || over) return;
          var i = Number(cell.dataset.i);
          if (board[i] !== 0) return;

          board[i] = 1;
          paint();
          if (win(board, i % N, Math.floor(i / N), 1)) {
            over = true;
            tip.textContent = "你赢了 🎉";
            return;
          }
          tip.textContent = "AI 思考中…";
          setTimeout(function () {
            var m = aiMove();
            paint();
            if (m >= 0 && win(board, m % N, Math.floor(m / N), 2)) {
              over = true;
              tip.textContent = "AI 赢了";
              return;
            }
            tip.textContent = "轮到你了";
          }, 160);
        });

        wrap.addEventListener("click", function (e) {
          if (!e.target.closest('[data-gm="reset"]')) return;
          board = new Array(N * N).fill(0);
          over = false;
          paint();
          tip.textContent = "你执黑先行";
        });
      });
  }

  /* ---------------------------------------------------- 意见申诉 */

  function openFeedbackSheet() {
    if (!token()) return toast("反馈需要先登录", true);
    sheet("意见申诉",
      '<div class="cc-dsk-fld"><label>类型</label>' +
      '<select id="cc-fb-cat"><option value="feedback">意见 / 建议</option>' +
      '<option value="appeal">申诉</option></select></div>' +
      '<div class="cc-dsk-fld"><label>标题</label>' +
      '<input id="cc-fb-title" type="text" maxlength="60" placeholder="一句话概括"></div>' +
      '<div class="cc-dsk-fld"><label>内容</label>' +
      '<textarea id="cc-fb-body" class="cc-dsk-ta" rows="6" maxlength="2000" ' +
      'placeholder="详细描述你遇到的问题或建议…"></textarea></div>' +
      '<div class="cc-dsk-sheet-acts"><button class="btn sm pri" data-fb="send">提交</button></div>',
      function (wrap) {
        wrap.addEventListener("click", function (e) {
          if (!e.target.closest('[data-fb="send"]')) return;
          var cat = wrap.querySelector("#cc-fb-cat").value;
          var title = wrap.querySelector("#cc-fb-title").value.trim();
          var content = wrap.querySelector("#cc-fb-body").value.trim();
          if (!title || !content) return toast("标题和内容都要填", true);
          apiFetch(API_BASE + "/api/feedback", {
            method: "POST",
            body: { category: cat, title: title, content: content },
          }).then(function () {
            toast("已提交，感谢反馈");
            var s = document.getElementById("cc-dsk-sheet");
            if (s && s.parentNode) s.parentNode.removeChild(s);
          }).catch(function (err) {
            toast("提交失败：" + err.message, true);
          });
        });
      });
  }

  /* ---------------------------------------------------- 聊天室 */

  function openChatSheet() {
    if (!token()) return toast("聊天室需要先登录", true);
    sheet("聊天室",
      '<div id="cc-chat-list" class="cc-dsk-chat"><div class="cc-dsk-loading">正在加载…</div></div>' +
      '<div class="cc-dsk-chat-bar"><input id="cc-chat-in" type="text" maxlength="200" placeholder="说点什么…">' +
      '<button class="btn sm pri" data-chat="send">发送</button></div>',
      function (wrap) {
        var list = wrap.querySelector("#cc-chat-list");
        var input = wrap.querySelector("#cc-chat-in");

        function load() {
          apiFetch(API_BASE + "/api/chat?page=1&size=40")
            .then(function (d) {
              // ★ api/chat 直接返回数组（data 已被 apiFetch 解包），不是 {list}
              var items = Array.isArray(d) ? d : ((d && (d.list || d.items || d.messages)) || []);
              if (!items.length) {
                list.innerHTML = '<div class="cc-dsk-empty">还没有人说话</div>';
                return;
              }
              list.innerHTML = items.slice().reverse().map(function (m) {
                var me = (user() && String(m.user_id) === String(user().id));
                return '<div class="cc-dsk-chat-row' + (me ? " me" : "") + '">' +
                  '<b>' + esc(m.nickname || m.username || "玩家") + "</b>" +
                  "<span>" + esc(m.content || "") + "</span>" +
                  "<small>" + esc(m.created_at || "") + "</small></div>";
              }).join("");
              list.scrollTop = list.scrollHeight;
            })
            .catch(function (e) {
              list.innerHTML = '<div class="cc-dsk-empty">加载失败：' + esc(e.message) + "</div>";
            });
        }

        wrap.addEventListener("click", function (e) {
          if (!e.target.closest('[data-chat="send"]')) return;
          var text = input.value.trim();
          if (!text) return;
          apiFetch(API_BASE + "/api/chat", { method: "POST", body: { content: text } })
            .then(function () { input.value = ""; load(); })
            .catch(function (err) { toast("发送失败：" + err.message, true); });
        });
        input.addEventListener("keydown", function (e) {
          if (e.key === "Enter") {
            var b = wrap.querySelector('[data-chat="send"]');
            if (b) b.click();
          }
        });
        load();
      });
  }

  /* ---------------------------------------------------- 宝贝回家 */

  function openKidsSheet() {
    var kids = [
      { name: "孟桂霞（照片是大姐）", birth: "1988-04-01", place: "河南省新乡市红旗区庄岩村" },
      { name: "王余香", birth: "1997-02-15", place: "重庆市万州区巫溪县菱角乡店子街138号" },
      { name: "潘清海（照片是父亲）", birth: "1999-01-01", place: "云南省昭通市永善县大兴乡骆丘村" },
      { name: "徐孔威", birth: "1988-04-12", place: "陕西省商洛市柞水县县医院" },
      { name: "王锋", birth: "1988-10-09", place: "河南省濮阳县吴城镇" },
      { name: "焦彬彬", birth: "1990-09-01", place: "湖南省永州市道县" },
    ];
    sheet("宝贝回家",
      '<div class="cc-dsk-kids-list">' + kids.map(function (k) {
        return '<div class="cc-dsk-kid"><b>' + esc(k.name) + "</b>" +
          "<small>" + esc(k.birth) + "</small><p>" + esc(k.place) + "</p></div>";
      }).join("") + "</div>" +
      '<div class="cc-dsk-hint">公益寻亲信息。如有线索请联系「宝贝回家」公益组织，或拨打 110。</div>');
  }

  /* ---------------------------------------------------- 启动 */

  /* 顶栏 / 侧栏去手机化：
     · 「下载 App」图标是给手机准备的，桌面版点它没有意义，直接移除
     · 副标题「网页版」改成「桌面版」—— 这是桌面客户端，不是浏览器页面 */
  function cleanChrome() {
    var dl = document.querySelector('.topbar a[href*="#download"]');
    if (dl && dl.parentNode) dl.parentNode.removeChild(dl);
    var small = document.querySelector(".brand small");
    if (small) small.textContent = "桌面版";
    var title = document.querySelector(".brand b");
    if (title) title.textContent = "CyanCodex";
  }
  cleanChrome();
  patchNav();
  /* ★ cleanChrome 只跑一次不够：某些时序下 .brand small 会被后续渲染覆盖回「网页版」。
     这里在前 8 秒内每秒复查一次，之后停。 */
  var chromeTries = 0;
  var chromeTimer = setInterval(function () {
    cleanChrome();
    if (++chromeTries >= 8) clearInterval(chromeTimer);
  }, 1000);

  /* 宝贝回家轮播：App 底部这条是滚动的，这里 6 秒换一条 */
  var KID_LINES = [
    "孟桂霞（照片是大姐）· 1988-04-01 · 河南省新乡市红旗区庄岩村",
    "王余香 · 1997-02-15 · 重庆市万州区巫溪县菱角乡店子街138号",
    "潘清海（照片是父亲）· 1999-01-01 · 云南省昭通市永善县大兴乡骆丘村",
    "徐孔威 · 1988-04-12 · 陕西省商洛市柞水县县医院",
  ];
  var kidIdx = 0;
  setInterval(function () {
    var el = document.getElementById("cc-kids-txt");
    if (!el) return;
    kidIdx = (kidIdx + 1) % KID_LINES.length;
    el.textContent = KID_LINES[kidIdx];
  }, 6000);

  CC.info().then(function (i) {
    info = i;
    injectMoreRefresh();
    renderDesktopHome();
  });

  loadOverview().then(function () { injectMoreRefresh(); renderHomeRefresh(); });
  loadNotices().then(function () { injectMoreRefresh(); renderHomeRefresh(); });

  function renderHomeRefresh() {
    var page = document.querySelector("#main .page");
    if (page) delete page.dataset.dskHome;
    renderDesktopHome();
  }

  // 页面重绘后自动补回桌面区块 / 重做首页
  var mainEl = document.getElementById("main");
  if (mainEl) {
    new MutationObserver(function () {
      injectMore();
      renderDesktopHome();
      renderDesktopLibrary();
      injectTools();
    }).observe(mainEl, { childList: true, subtree: false });
  }

  // 启动后静默同步一次（只在已登录时）
  setTimeout(function () { if (token()) doSync(true); }, 3500);

  /* ★ 把公共工具挂到 window，供后续注入的 desktop-*.js 复用。
     注入顺序见 electron/main.js 的 DESKTOP_SCRIPTS：desktop.js 必须最先跑。
     这些模块各自独立文件，避免多人/多任务并行改同一个大文件时冲突。 */
  window.__cc = {
    CC: CC,
    API_BASE: API_BASE,
    S_CONVS: S_CONVS,
    esc: esc,
    toast: toast,
    sheet: sheet,
    mi: mi,
    apiFetch: apiFetch,
    clickNav: clickNav,
    token: token,
    user: user,
    fmtNum: fmtNum,
    fmtTime: fmtTime,
    injectMoreRefresh: injectMoreRefresh,
    renderHomeRefresh: renderHomeRefresh,
    renderLibList: renderLibList,
    openProfileSheet: openProfileSheet,
    openPointsSheet: openPointsSheet,
    openFeedDetail: openFeedDetail,
  };

  console.log("[CyanCodex] 桌面增强层已加载");
})();
