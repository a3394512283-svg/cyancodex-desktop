/* ==========================================================================
   CyanCodex 二改版 · 网页版主逻辑
   --------------------------------------------------------------------------
   设计约束：
     · CSP 是 script-src 'self'，页面里没有任何内联 <script>/onclick ——
       所有交互都走 addEventListener 或 data-* 事件委托。
     · 不引用任何 CDN：CSP 不允许，Cloudflare 环境下第三方资源也不可靠。
     · AI 返回的内容插入 DOM 前一律转义，Markdown 只做白名单式最小渲染。
     · 生成器与指令库是**纯前端**的，不发任何网络请求，内容不出浏览器。
   ========================================================================== */
(function () {
  "use strict";

  var API_CHAT = "/api/v1/ai/chat/completions";
  var API_VER = "/api/v1/app/version";
  var API_CFG = "/api/v1/app/config";

  var S_CONVS = "cc_web_convs_v2";
  var S_CUR = "cc_web_cur_v2";
  var S_THEME = "cc_web_theme_v1";
  var S_FORM = "cc_web_form_v1";
  var S_AICFG = "cc_web_aicfg_v1";
  var MAX_MSGS = 60;        // 单会话最多保留的消息条数
  var SEND_CTX = 14;        // 每次请求带上的上下文条数

  var $main = document.getElementById("main");
  var $toast = document.getElementById("toast");
  var $verBadge = document.getElementById("verBadge");
  var $themeIcon = document.getElementById("themeIcon");
  var $btnTheme = document.getElementById("btnTheme");

  var page = "home";
  var busy = false;
  var abortCtl = null;
  var aiAttach = [];   // 当前待发送的文本附件 [{name,text}]
  var aiSideOpen = false;   // 移动端侧栏是否展开（桌面端恒为展开）

  /* ================================================================ 工具 */

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  var toastTimer = null;
  function toast(msg) {
    $toast.textContent = msg;
    $toast.classList.add("on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { $toast.classList.remove("on"); }, 1800);
  }

  function copyText(txt, okMsg) {
    var done = function () { toast(okMsg || "已复制"); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(done).catch(function () { fallback(txt, done); });
    } else {
      fallback(txt, done);
    }
  }

  function fallback(txt, done) {
    var ta = document.createElement("textarea");
    ta.value = txt;
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); done(); } catch (e) { toast("复制失败，请手动选择"); }
    document.body.removeChild(ta);
  }

  function lsGet(k, dflt) {
    try {
      var v = localStorage.getItem(k);
      return v == null ? dflt : JSON.parse(v);
    } catch (e) { return dflt; }
  }
  function lsSet(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 配额满 / 隐私模式 */ }
  }
  function lsDel(k) {
    try { localStorage.removeItem(k); } catch (e) { /* ignore */ }
  }

  function fmtSize(n) {
    n = Number(n) || 0;
    if (n <= 0) return "—";
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / 1024 / 1024).toFixed(2) + " MB";
  }

  function fmtTime(ts) {
    var d = new Date((Number(ts) || 0) * 1000);
    if (!Number(ts)) return "—";
    var p = function (x) { return x < 10 ? "0" + x : "" + x; };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
      " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  /* 极简 Markdown：围栏代码块 / 行内代码 / 粗体。
     顺序很重要 —— 先把代码块挖出来换成占位符，剩下的文本才做行内替换，
     否则代码里的 * 和 ` 会被误当成格式标记。 */
  function md(text) {
    var blocks = [];
    // ★ 语言标识放宽到「行内任意字符」：模型经常写成 ``` Minecraft命令（带中文），
    //   原来的 [a-zA-Z0-9+#._-]* 匹配不到，整段围栏会被当普通文本显示。
    var s = String(text == null ? "" : text).replace(
      /```([^\r\n]*)\r?\n([\s\S]*?)(?:```|$)/g,
      function (_, lang, code) {
        blocks.push(code.replace(/\r?\n$/, ""));
        return "\u0000B" + (blocks.length - 1) + "\u0000";
      });

    s = esc(s);
    s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
    s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/\n{2,}/g, "\u0000P\u0000");
    s = s.replace(/\n/g, "<br>");

    var html = s.split("\u0000P\u0000").map(function (p) {
      return p.replace(/^\s+|\s+$/g, "") ? "<p>" + p + "</p>" : "";
    }).join("");

    html = html.replace(/\u0000B(\d+)\u0000/g, function (_, i) {
      return '<div class="codewrap"><button class="cp" type="button" data-copy-code>复制</button>' +
        "<pre><code>" + esc(blocks[+i]) + "</code></pre></div>";
    });
    return html;
  }

  /* ================================================================ 主题 */

  var THEMES = ["system", "dark", "light"];
  var THEME_ICON = {
    system: "M3 4h18v12H3z M8 20h8 M12 16v4",
    dark: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z",
    light: "M12 4.5v-2 M12 21.5v-2 M4.5 12h-2 M21.5 12h-2 M6.3 6.3 5 5 M18.9 19 17.6 17.7 M17.7 6.3 19 5 M5 19l1.3-1.3 M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z"
  };

  function applyTheme(t) {
    var mode = THEMES.indexOf(t) >= 0 ? t : "system";
    var dark = mode === "dark" ||
      (mode === "system" && window.matchMedia &&
       window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    $themeIcon.setAttribute("d", THEME_ICON[mode]);
    var tc = dark ? "#0E1512" : "#F4F7F5";
    var mt = document.querySelector('meta[name="theme-color"]');
    if (mt) mt.setAttribute("content", tc);
    return mode;
  }

  function cycleTheme() {
    var cur = lsGet(S_THEME, "system");
    var next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
    lsSet(S_THEME, next);
    applyTheme(next);
    toast(next === "system" ? "主题：跟随系统" : next === "dark" ? "主题：深色" : "主题：浅色");
  }

  /* ============================================================ 远端配置 */

  /* -------------------------------------------------------- AI 通道配置
     与 App 的「AI 设置」对齐，但只保留网页版能实现的两种通道：
       free   —— 本项目的限时免费通道，走服务端代理，**必须登录**
       custom —— 用户自己的 Base URL + Key，浏览器直连，不经过我们的服务端
     App 里的「官方 AI · 消耗积分」依赖官方账号积分体系，网页版没有对应接口，
     所以不提供；思考强度 / 工具轮数 / 语法核对 同理（依赖 App 侧的工具链）。
  */
  var aiCfgCache = null;

  function aiCfg() {
    if (aiCfgCache) return aiCfgCache;
    var d = { channel: "free", base: "", key: "", model: "" };
    var v = lsGet(S_AICFG, null);
    if (v && typeof v === "object") {
      if (v.channel === "custom") d.channel = "custom";
      if (typeof v.base === "string") d.base = v.base;
      if (typeof v.key === "string") d.key = v.key;
      if (typeof v.model === "string") d.model = v.model;
    }
    aiCfgCache = d;
    return d;
  }

  function saveAiCfg(patch) {
    var d = aiCfg();
    for (var k in patch) {
      if (Object.prototype.hasOwnProperty.call(patch, k)) d[k] = patch[k];
    }
    lsSet(S_AICFG, d);
    aiCfgCache = d;
    return d;
  }

  /* 自定义通道是否填全了 */
  function customReady() {
    var c = aiCfg();
    return !!(c.base.trim() && c.key.trim() && c.model.trim());
  }

  /* 把 base 和路径拼起来，容忍用户填没填结尾的斜杠、或直接填到 /chat/completions */
  function joinUrl(base, path) {
    var b = String(base || "").trim().replace(/\/+$/, "");
    if (/\/chat\/completions$/i.test(b) && path === "chat/completions") return b;
    if (/\/models$/i.test(b) && path === "models") return b;
    return b + "/" + path;
  }

  var remote = { version: null, config: null };

  /* ==================================================== 账号（登录 / 注册）

     ★★ 关键决策：走**浏览器直连**官方 API，不经本站服务端转发。

     原因（用户明确提出的约束）：服务端集中代发登录请求，只要同时有几十个人
     在网页版登录，我们的服务器 IP 就会变成官方风控的靶子 —— 一旦被拉黑，
     所有人的登录和令牌校验都会挂。浏览器直连时每个用户用各自的出口 IP，
     风险被摊到用户侧，服务端不背这个锅。

     可行性：官方 API 的 CORS 是 `Access-Control-Allow-Origin: *`
     （已实测 OPTIONS / GET 都带这个头），所以跨域直连是通的。
     我们的 CSP 也已放开 `connect-src https:`。

     服务端只在**令牌校验**时接触官方接口（/api/auth/me），而且带 600 秒缓存，
     每人十分钟最多一次，量级和登录请求不是一个数量级。
  */
  var AUTH_BASE = "https://cyancodex.cn";
  var S_TOKEN = "cc_web_token";
  var S_USER = "cc_web_user";

  function authToken() {
    var t = lsGet(S_TOKEN, "");
    return typeof t === "string" ? t : "";
  }
  function authUser() {
    var u = lsGet(S_USER, null);
    return u && typeof u === "object" ? u : null;
  }
  function isLogin() { return !!authToken(); }

  /* 统一的请求封装：无论 HTTP 状态码是多少，都尝试解析 JSON 体，
     因为官方接口在 401/400 时也会带 {ok:false, error:"..."} 这种可读信息。 */
  function authReq(method, path, body) {
    var opt = {
      method: method,
      headers: { "Accept": "application/json" },
      cache: "no-store"
    };
    if (body !== undefined) {
      opt.headers["Content-Type"] = "application/json";
      opt.body = JSON.stringify(body);
    }
    return fetch(AUTH_BASE + path, opt).then(function (r) {
      return r.text().then(function (t) {
        var d = null;
        try { d = JSON.parse(t); } catch (e) { /* 非 JSON */ }
        if (!d || typeof d !== "object") {
          return { ok: false, error: "服务返回异常（HTTP " + r.status + "）" };
        }
        return d;
      });
    }).catch(function (e) {
      return { ok: false, error: "网络错误：" + ((e && e.message) || e) };
    });
  }

  function setLogin(token, user) {
    lsSet(S_TOKEN, token || "");
    lsSet(S_USER, user || null);
    renderAuthSlot();
  }

  function logout() {
    lsDel(S_TOKEN);
    lsDel(S_USER);
    renderAuthSlot();
    render();
    toast("已退出登录");
  }

  /* 顶栏右侧：未登录显示「登录」，已登录显示首字母头像 */
  function renderAuthSlot() {
    var $s = document.getElementById("authSlot");
    if (!$s) return;
    var u = authUser();
    if (isLogin() && u) {
      var name = u.nickname || u.username || "我";
      $s.innerHTML = '<button class="icon-btn" id="btnUser" title="' +
        esc(name) + '"><span style="font-size:12px;font-weight:800">' +
        esc(String(name).slice(0, 1).toUpperCase()) + "</span></button>";
      var b = document.getElementById("btnUser");
      if (b) b.addEventListener("click", openAccount);
    } else {
      $s.innerHTML = '<button class="btn sm" id="btnLoginTop">登录</button>';
      var b2 = document.getElementById("btnLoginTop");
      if (b2) b2.addEventListener("click", function () { openAuth("login"); });
    }
  }

  /* 通用弹层：createSheet(内部 HTML) -> {el, close} */
  function createSheet(inner, maxWidth) {
    var d = document.createElement("div");
    d.className = "sheet on";
    d.innerHTML = '<div class="sheet-box"' +
      (maxWidth ? ' style="max-width:' + maxWidth + 'px"' : "") + ">" + inner + "</div>";
    document.body.appendChild(d);
    var close = function () { d.remove(); };
    d.addEventListener("click", function (e) {
      if (e.target === d || (e.target.closest && e.target.closest("[data-x]"))) close();
    });
    return { el: d, close: close };
  }

  /* ------------------------------------------------------------ 登录 / 注册 */
  function openAuth(tab) {
    var isReg = tab === "register";
    var inner =
      '<div class="sheet-hd"><span>账号</span><div class="sp"></div>' +
      '<button class="x" data-x="1">×</button></div>' +
      '<div class="fld"><div class="row tight">' +
      '<button class="mode' + (isReg ? "" : " on") + '" data-atab="login">登录</button>' +
      '<button class="mode' + (isReg ? " on" : "") + '" data-atab="register">注册</button>' +
      "</div></div>" +

      /* 登录 */
      '<div id="paneLogin"' + (isReg ? ' style="display:none"' : "") + ">" +
      '<div class="fld"><label>用户名 / 邮箱</label>' +
      '<input id="auIdent" type="text" autocomplete="username" placeholder="用户名或邮箱"></div>' +
      '<div class="fld"><label>密码</label>' +
      '<input id="auPass" type="password" autocomplete="current-password" placeholder="密码"></div>' +
      '<div id="auErr" class="tip" style="color:var(--red);min-height:16px"></div>' +
      '<button class="btn pri block" id="auLogin">登录</button>' +
      '<div class="tip" style="margin-top:10px">登录走官方接口（cyancodex.cn），' +
      "请求由你的浏览器直接发出，不经过本站服务器。登录后可用限时免费 AI 通道。</div>" +
      "</div>" +

      /* 注册 */
      '<div id="paneReg"' + (isReg ? "" : ' style="display:none"') + ">" +
      '<div class="fld"><label>用户名</label>' +
      '<input id="rgUser" type="text" placeholder="2-20 位，中文/字母/数字/下划线"></div>' +
      '<div class="fld"><label>昵称（可选）</label>' +
      '<input id="rgNick" type="text" placeholder="显示名称"></div>' +
      '<div class="fld"><label>邮箱</label>' +
      '<input id="rgMail" type="email" placeholder="用于接收验证码"></div>' +
      '<div class="fld"><label>密码</label>' +
      '<input id="rgPass" type="password" placeholder="至少 6 位"></div>' +
      '<div class="fld"><label>图形验证码</label>' +
      '<div class="row" style="align-items:center">' +
      '<input id="rgCap" type="text" placeholder="看图输入" style="flex:1;padding:9px 12px;' +
      'border-radius:10px;background:var(--card);border:1px solid var(--line);outline:none">' +
      '<img id="rgCapImg" alt="验证码" title="点击刷新" style="height:38px;border-radius:8px;' +
      'cursor:pointer;border:1px solid var(--line);background:var(--card)">' +
      "</div></div>" +
      '<div class="fld"><label>邮箱验证码</label>' +
      '<div class="row" style="align-items:center">' +
      '<input id="rgCode" type="text" placeholder="6 位验证码" style="flex:1;padding:9px 12px;' +
      'border-radius:10px;background:var(--card);border:1px solid var(--line);outline:none">' +
      '<button class="btn sm" id="rgSend">发送验证码</button>' +
      "</div></div>" +
      '<div id="rgErr" class="tip" style="color:var(--red);min-height:16px"></div>' +
      '<button class="btn pri block" id="rgDo">注册并登录</button>' +
      "</div>";

    var sheet = createSheet(inner, 430);
    var $el = sheet.el;
    var captchaId = "";

    /* tab 切换 */
    Array.prototype.forEach.call($el.querySelectorAll("[data-atab]"), function (b) {
      b.addEventListener("click", function () {
        var t = b.getAttribute("data-atab");
        Array.prototype.forEach.call($el.querySelectorAll("[data-atab]"), function (x) {
          x.classList.toggle("on", x === b);
        });
        var pl = $el.querySelector("#paneLogin");
        var pr = $el.querySelector("#paneReg");
        if (pl) pl.style.display = t === "login" ? "" : "none";
        if (pr) pr.style.display = t === "register" ? "" : "none";
        if (t === "register" && !captchaId) loadCaptcha();
      });
    });

    /* 图形验证码 */
    function loadCaptcha() {
      var img = $el.querySelector("#rgCapImg");
      if (img) img.alt = "加载中…";
      authReq("GET", "/api/auth/captcha").then(function (d) {
        if (d && d.ok && d.data && d.data.image) {
          captchaId = d.data.id || "";
          if (img) { img.src = d.data.image; img.alt = "验证码"; }
        } else {
          if (img) img.alt = "加载失败";
        }
      });
    }
    var capImg = $el.querySelector("#rgCapImg");
    if (capImg) capImg.addEventListener("click", loadCaptcha);
    if (isReg) loadCaptcha();

    /* 发送邮箱验证码（带 60 秒倒计时） */
    var $send = $el.querySelector("#rgSend");
    if ($send) $send.addEventListener("click", function () {
      var mail = ($el.querySelector("#rgMail") || {}).value || "";
      if (!mail.trim()) { setErr("rgErr", "先填邮箱"); return; }
      $send.disabled = true;
      authReq("POST", "/api/auth/send-email-code", { email: mail.trim() }).then(function (d) {
        if (d && d.ok) {
          toast("验证码已发送，请查收邮箱");
          var n = 60;
          $send.textContent = n + "s";
          var iv = setInterval(function () {
            n--;
            $send.textContent = n + "s";
            if (n <= 0) { clearInterval(iv); $send.disabled = false; $send.textContent = "发送验证码"; }
          }, 1000);
        } else {
          setErr("rgErr", (d && d.error) || "发送失败");
          $send.disabled = false;
        }
      });
    });

    function setErr(id, msg) {
      var e = $el.querySelector("#" + id);
      if (e) e.textContent = msg || "";
    }

    /* 登录 */
    var $login = $el.querySelector("#auLogin");
    if ($login) $login.addEventListener("click", function () {
      var ident = (($el.querySelector("#auIdent") || {}).value || "").trim();
      var pass = ($el.querySelector("#auPass") || {}).value || "";
      if (!ident || !pass) { setErr("auErr", "请输入用户名和密码"); return; }
      $login.disabled = true;
      $login.textContent = "登录中…";
      setErr("auErr", "");
      authReq("POST", "/api/auth/login", { username: ident, password: pass }).then(function (d) {
        $login.disabled = false;
        $login.textContent = "登录";
        if (d && d.ok && d.data && d.data.token) {
          setLogin(d.data.token, d.data.user);
          sheet.close();
          render();
          toast("登录成功");
        } else {
          setErr("auErr", (d && d.error) || "登录失败");
        }
      });
    });

    /* 注册 */
    var $reg = $el.querySelector("#rgDo");
    if ($reg) $reg.addEventListener("click", function () {
      var body = {
        username: (($el.querySelector("#rgUser") || {}).value || "").trim(),
        nickname: (($el.querySelector("#rgNick") || {}).value || "").trim(),
        email: (($el.querySelector("#rgMail") || {}).value || "").trim(),
        password: (($el.querySelector("#rgPass") || {}).value || ""),
        captcha_id: captchaId,
        captcha_text: (($el.querySelector("#rgCap") || {}).value || "").trim(),
        email_code: (($el.querySelector("#rgCode") || {}).value || "").trim()
      };
      if (!body.username || !body.email || !body.password) {
        setErr("rgErr", "用户名、邮箱、密码都要填");
        return;
      }
      $reg.disabled = true;
      $reg.textContent = "提交中…";
      setErr("rgErr", "");
      authReq("POST", "/api/auth/register", body).then(function (d) {
        $reg.disabled = false;
        $reg.textContent = "注册并登录";
        if (d && d.ok && d.data && d.data.token) {
          setLogin(d.data.token, d.data.user);
          sheet.close();
          render();
          toast("注册成功");
        } else {
          setErr("rgErr", (d && d.error) || "注册失败");
          loadCaptcha();
        }
      });
    });

    /* 回车提交 */
    $el.addEventListener("keydown", function (e) {
      if (e.key !== "Enter") return;
      var pl = $el.querySelector("#paneLogin");
      if (pl && pl.style.display !== "none" && $login) $login.click();
    });
  }

  /* 已登录时的账号面板 */
  function openAccount() {
    var u = authUser() || {};
    var name = u.nickname || u.username || "我";
    var inner =
      '<div class="sheet-hd"><span>账号</span><div class="sp"></div>' +
      '<button class="x" data-x="1">×</button></div>' +
      '<div class="fld"><label>当前账号</label>' +
      '<div class="card" style="margin:0"><h3><span class="dot"></span>' + esc(name) + "</h3>" +
      '<dl class="kv">' +
      "<dt>用户名</dt><dd>" + esc(u.username || "—") + "</dd>" +
      "<dt>邮箱</dt><dd>" + esc(u.email || "—") + "</dd>" +
      (u.points != null ? "<dt>积分</dt><dd>" + esc(u.points) + "</dd>" : "") +
      "</dl></div></div>" +
      '<div class="tip" style="margin-bottom:12px">令牌保存在这台设备的浏览器里，' +
      "只用于调用本站的免费 AI 通道；退出后立即失效。</div>" +
      '<button class="btn block" id="auLogout">退出登录</button>';

    var sheet = createSheet(inner, 420);
    var b = sheet.el.querySelector("#auLogout");
    if (b) b.addEventListener("click", function () {
      sheet.close();
      logout();
    });
  }


  function pullRemote() {
    // 两个接口各自 try —— 任一失败都不影响另一个，也不影响页面可用性。
    fetchJson(API_VER).then(function (d) {
      if (d && d.ok !== false) {
        remote.version = d.data || d;
        var v = remote.version;
        if (v && v.latest) {
          $verBadge.textContent = "v" + v.latest;
          $verBadge.title = "网页版跟随 App 最新版本 " + v.latest;
        }
        // ★ 首页/更多的「下载 App」卡片是在 render() 里读 remote.version 拼的，
        //   只改顶栏徽标的话卡片会一直显示 v— / 大小 — / MD5 —（实测踩过）。
        if (page === "home" || page === "more") render();
      }
    }).catch(function () { /* 离线也能用 */ });

    fetchJson(API_CFG).then(function (d) {
      if (d && d.ok !== false) {
        remote.config = d.data || d;
        if (page === "home" || page === "more") render();
      }
    }).catch(function () { /* ignore */ });
  }

  function fetchJson(url) {
    return fetch(url, { headers: { "Accept": "application/json" }, cache: "no-store" })
      .then(function (r) { return r.json(); });
  }

  /* ============================================================== 指令库

     数据来源分两路：

       · 官方库 https://cyancodex.cn/api/commands
         官方接口公开、响应头带 Access-Control-Allow-Origin: *，所以由
         **浏览器直连**。不在我们服务端中转，避免服务器 IP 被官方拉黑。

       · 本地库 /api/v1/cmds
         官方库不可用（网络错误 / 非 JSON / ok:false / 超时）时的兜底，
         内容是我们自己维护的 125 条基岩版基础指令。

     官方数据里 command 可能为空：付费内容（price>0）或作者未公开。
     这类条目不渲染空代码块，只显示提示，避免用户复制到空字符串。
  */

  var LIB_API = "https://cyancodex.cn/api/commands";
  var LIB_LOCAL = "/api/v1/cmds";
  var LIB_TIMEOUT = 9000;

  /* 官方库的分类是英文 slug，这里映射成中文标签 */
  var LIB_CATS = [
    { k: "other", n: "其他" },
    { k: "adventure", n: "冒险" },
    { k: "scoreboard", n: "计分板" },
    { k: "survival", n: "生存" },
    { k: "redstone", n: "红石" },
    { k: "gamerule", n: "游戏规则" }
  ];
  var LIB_CAT_NAME = {};
  LIB_CATS.forEach(function (c) { LIB_CAT_NAME[c.k] = c.n; });

  var libState = {
    src: "official",   // official | local
    q: "",
    cat: "",           // 空 = 全部分类；官方是 slug，本地是中文分类名
    quality: "",       // 空 | high | low（仅官方库支持）
    page: 1,
    size: 20,
    total: 0,
    pages: 0,
    data: [],
    loading: false,
    loaded: false,
    err: "",
    notice: "",
    favOnly: false,
    detail: null
  };

  /* 把两种数据源统一成同一个结构，渲染层只认这一套字段 */
  function normOfficial(x) {
    return {
      id: x.id,
      title: x.title || "未命名指令",
      description: x.description || "",
      command: x.command || "",
      category: x.category || "",
      quality: x.quality || "",
      mc_version: x.mc_version || "",
      view_count: Number(x.view_count) || 0,
      like_count: Number(x.like_count) || 0,
      price: Number(x.price) || 0,
      author: x.author || "",
      author_official: Number(x.author_official) || 0
    };
  }

  function normLocal(x) {
    return {
      id: x.id,
      title: x.title || "未命名指令",
      description: x.descr || "",
      command: x.code || "",
      category: x.category || "",
      quality: "",
      mc_version: "",
      view_count: 0,
      like_count: 0,
      price: 0,
      author: "",
      author_official: 0
    };
  }

  function loadLib(done) {
    libState.loading = true;
    libState.err = "";
    libState.notice = "";
    renderLibrary();

    var url = LIB_API +
      "?page=" + libState.page +
      "&size=" + libState.size +
      "&q=" + encodeURIComponent(libState.q) +
      "&category=" + encodeURIComponent(libState.cat) +
      "&quality=" + encodeURIComponent(libState.quality) +
      "&source=all&mine=";

    var opts = { headers: { "Accept": "application/json" }, cache: "no-store" };
    var ctl = null;
    var timer = null;
    if (typeof AbortController !== "undefined") {
      ctl = new AbortController();
      opts.signal = ctl.signal;
      timer = setTimeout(function () { ctl.abort(); }, LIB_TIMEOUT);
    }

    fetch(url, opts).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function (d) {
      if (timer) clearTimeout(timer);
      if (!d || d.ok !== true || !d.data || !Array.isArray(d.data.list)) {
        throw new Error("官方库返回格式异常");
      }
      var dd = d.data;
      libState.loading = false;
      libState.loaded = true;
      libState.data = dd.list.map(normOfficial);
      libState.total = Number(dd.total) || 0;
      libState.pages = Math.ceil(libState.total / libState.size) || 0;
      renderLibrary();
      if (done) done();
    }).catch(function (e) {
      if (timer) clearTimeout(timer);
      /* 官方库失败 → 直接报错 + 重试，不再回退本地基础指令 */
      libState.loading = false;
      libState.loaded = true;
      libState.data = [];
      libState.total = 0;
      libState.pages = 0;
      libState.err = "官方指令库暂不可用：" + ((e && e.message) || "网络错误");
      renderLibrary();
    });
  }

  function libChip(label, on, kind, val) {
    return '<button class="cat' + (on ? " on" : "") + '" data-chip="' + kind +
      '" data-val="' + esc(val) + '">' + esc(label) + "</button>";
  }

  var S_LIB_FAV = "cc_web_lib_fav";

  function libFavs() {
    var a = lsGet(S_LIB_FAV, []);
    return Array.isArray(a) ? a : [];
  }

  function isLibFav(x) {
    var id = String(x.id || "");
    return libFavs().some(function (f) { return String(f.id) === id; });
  }

  function toggleLibFav(x) {
    var a = libFavs();
    var id = String(x.id || "");
    var idx = -1;
    for (var i = 0; i < a.length; i++) if (String(a[i].id) === id) { idx = i; break; }
    if (idx >= 0) a.splice(idx, 1);
    else a.unshift({
      id: x.id, title: x.title, description: x.description, command: x.command,
      category: x.category, quality: x.quality, author: x.author,
      mc_version: x.mc_version, price: x.price, source: x.source,
      view_count: x.view_count, like_count: x.like_count
    });
    lsSet(S_LIB_FAV, a);
  }

  function openLibDetail(i) {
    var x = (libState.favOnly ? libFavs() : libState.data)[i];
    if (!x) return;
    libState.detail = x;
    var $sheet = document.getElementById("libSheet");
    var $title = document.getElementById("libSheetTitle");
    var $body = document.getElementById("libSheetBody");
    if (!$sheet || !$body) return;
    if ($title) $title.textContent = x.title || "指令详情";
    var cat = LIB_CAT_NAME[x.category] || x.category || "未分类";
    var h = '<div class="lib-detail-meta"><span class="tag">' + esc(cat) + "</span>";
    if (x.quality === "high") h += '<span class="tag hi">高质</span>';
    if (x.price > 0) h += '<span class="tag paid">付费 ' + esc(x.price) + " 积分</span>";
    if (x.mc_version) h += '<span class="tag v">' + esc(x.mc_version) + "</span>";
    h += "</div>";
    if (x.command) {
      h += '<pre class="lib-full-code">' + esc(x.command) + "</pre>" +
        '<div class="row" style="margin-top:10px"><button class="btn pri" data-libcopy-sheet="1">复制指令</button></div>';
    } else {
      h += '<div class="nolock">' +
        (x.price > 0 ? "付费内容，购买后请在 App 内查看" : "作者未公开指令，请在 App 内查看") +
        "</div>";
    }
    if (x.description) h += '<p class="desc" style="margin-top:10px">' + esc(x.description) + "</p>";
    $body.innerHTML = h;
    $sheet.classList.add("on");
    var $cp = $body.querySelector("[data-libcopy-sheet]");
    if ($cp) $cp.addEventListener("click", function () {
      if (x.command) copyText(x.command, "指令已复制");
    });
  }

  function renderLibrary() {
    var h = '<div class="page">';

    /* 搜索框 */
    h += '<div class="searchbar"><div class="field">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>' +
      '<input id="libQ" placeholder="搜索指令、功能或关键词" value="' +
      esc(libState.q) + '"></div></div>';

    /* 筛选 chips：全部 / 高质 / 低质 / 分类 */
    h += '<div class="cats">';
    h += libChip("全部", !libState.cat && !libState.quality && !libState.favOnly, "all", "");
    h += libChip("收藏", libState.favOnly, "fav", "");
    h += libChip("高质", libState.quality === "high", "quality", "high");
    h += libChip("低质", libState.quality === "low", "quality", "low");
    LIB_CATS.forEach(function (c) {
      h += libChip(c.n, !libState.quality && libState.cat === c.k, "cat", c.k);
    });
    h += "</div>";

    /* 兜底提示：不打扰，只在列表顶部占一行小字 */
    if (libState.notice) {
      h += '<div class="libnotice">' + esc(libState.notice) + "</div>";
    }

    /* 列表 */
    if (libState.loading && !libState.data.length) {
      h += '<div class="empty"><div class="big">···</div>正在加载指令库</div>';
    } else if (libState.err) {
      h += '<div class="empty"><div class="big">!</div>' + esc(libState.err) +
        '<div style="margin-top:14px"><button class="btn sm" data-reload>重试</button></div></div>';
    } else if (!libState.data.length) {
      h += '<div class="empty"><div class="big">∅</div>没有匹配的指令，换个关键词试试</div>';
    } else {
      var list = libState.favOnly ? libFavs() : libState.data;
      var total = libState.favOnly ? list.length : libState.total;

      h += '<div class="libmeta">共 ' + esc(total) + " 条 · " +
        (libState.favOnly ? "我的收藏" : "数据来自官方指令库") +
        " · 基岩版语法</div>";

      if (!list.length) {
        h += '<div class="empty"><div class="big">∅</div>' +
          (libState.favOnly ? "还没有收藏，点卡片右下角的 ☆ 收藏" : "没有匹配的指令，换个关键词试试") +
          "</div>";
      } else {
        h += '<div class="lib-list">';
        list.forEach(function (x, i) {
          var catName = LIB_CAT_NAME[x.category] || x.category || "未分类";
          var paid = x.price > 0;
          var firstLine = String(x.command || "").split("\n")[0] || "";
          var fav = isLibFav(x);
          h += '<div class="cmd" data-open-cmd="' + i + '">' +
            '<div class="hd"><b>' + esc(x.title) + "</b>" +
            '<span class="tag">' + esc(catName) + "</span>" +
            (paid ? '<span class="tag paid">付费 ' + esc(x.price) + " 积分</span>" : "") +
            (x.quality === "high" ? '<span class="tag hi">高质</span>' : "") +
            "</div>";
          if (x.description) {
            h += '<div class="desc">' + esc(x.description) + "</div>";
          }
          if (x.command) {
            h += '<div class="code-prev">' + esc(firstLine) + "</div>";
          } else {
            h += '<div class="nolock">' +
              (paid ? "付费内容，购买后请在 App 内查看" : "作者未公开指令，请在 App 内查看") +
              "</div>";
          }
          h += '<div class="meta">';
          if (x.author) h += "<span>@" + esc(x.author) + (x.author_official ? " ✓" : "") + "</span>";
          if (x.mc_version) h += '<span class="tag v">' + esc(x.mc_version) + "</span>";
          if (x.view_count) h += "<span>浏览 " + esc(x.view_count) + "</span>";
          if (x.like_count) h += "<span>点赞 " + esc(x.like_count) + "</span>";
          h += "</div>";
          h += '<div class="acts">' +
            '<button class="fav' + (fav ? " on" : "") + '" data-fav="' + i + '" title="收藏">' +
            (fav ? "★" : "☆") + "</button>" +
            (x.command ? '<button class="btn sm" data-libcopy="' + i + '">复制</button>' : "") +
            '<button class="btn sm ghost" data-open="' + i + '">详情</button>' +
            "</div>";
          h += "</div>";
        });
        h += "</div>";
      }

      if (!libState.favOnly && libState.pages > 1) {
        h += '<div class="row" style="justify-content:center;align-items:center;margin:16px 0 4px">' +
          '<button class="btn sm" data-pg="' + (libState.page - 1) + '"' +
          (libState.page <= 1 ? " disabled" : "") + ">上一页</button>" +
          '<span style="font-size:12px;color:var(--text3);padding:0 4px">' +
          libState.page + " / " + libState.pages + "</span>" +
          '<button class="btn sm" data-pg="' + (libState.page + 1) + '"' +
          (libState.page >= libState.pages ? " disabled" : "") + ">下一页</button></div>";
      }

    }

    h += "</div>";
    h += '<div class="sheet" id="libSheet"><div class="sheet-box">' +
      '<div class="sheet-hd"><span id="libSheetTitle">指令详情</span><div class="sp"></div>' +
      '<button class="x" id="libSheetClose" title="关闭">×</button></div>' +
      '<div id="libSheetBody"></div></div></div>';
    $main.innerHTML = h;

    /* ---- 事件 ---- */
    var $q = document.getElementById("libQ");
    var tmr = null;
    if ($q) {
      $q.addEventListener("input", function () {
        libState.q = $q.value;
        libState.page = 1;
        // 输入防抖 300ms：不然每敲一个字就是一次请求
        clearTimeout(tmr);
        tmr = setTimeout(function () { loadLib(); }, 300);
      });
    }

    Array.prototype.forEach.call($main.querySelectorAll("[data-chip]"), function (b) {
      b.addEventListener("click", function () {
        var kind = b.getAttribute("data-chip");
        var val = b.getAttribute("data-val") || "";
        if (kind === "fav") {
          libState.favOnly = true;
          libState.cat = "";
          libState.quality = "";
          renderLibrary();
          return;
        }
        libState.favOnly = false;
        if (kind === "all") {
          libState.cat = "";
          libState.quality = "";
        } else if (kind === "quality") {
          libState.quality = val;
          libState.cat = "";
        } else {
          libState.cat = val;
          libState.quality = "";
        }
        libState.page = 1;
        loadLib();
      });
    });

    function curLibList() { return libState.favOnly ? libFavs() : libState.data; }

    Array.prototype.forEach.call($main.querySelectorAll("[data-libcopy]"), function (b) {
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        var i = parseInt(b.getAttribute("data-libcopy"), 10);
        var hit = curLibList()[i];
        if (hit && hit.command) copyText(hit.command, "指令已复制");
      });
    });

    Array.prototype.forEach.call($main.querySelectorAll("[data-fav]"), function (b) {
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        var i = parseInt(b.getAttribute("data-fav"), 10);
        var hit = curLibList()[i];
        if (!hit) return;
        var was = isLibFav(hit);
        toggleLibFav(hit);
        renderLibrary();
        toast(was ? "已取消收藏" : "已收藏");
      });
    });

    Array.prototype.forEach.call($main.querySelectorAll("[data-open], [data-open-cmd]"), function (b) {
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        var i = parseInt(b.getAttribute("data-open") || b.getAttribute("data-open-cmd"), 10);
        openLibDetail(i);
      });
    });

    var $libSheet = document.getElementById("libSheet");
    var $libSheetClose = document.getElementById("libSheetClose");
    if ($libSheetClose && $libSheet) {
      $libSheetClose.addEventListener("click", function () { $libSheet.classList.remove("on"); });
    }
    if ($libSheet) {
      $libSheet.addEventListener("click", function (e) {
        if (e.target === $libSheet) $libSheet.classList.remove("on");
      });
    }


    Array.prototype.forEach.call($main.querySelectorAll("[data-pg]"), function (b) {
      b.addEventListener("click", function () {
        var p = parseInt(b.getAttribute("data-pg"), 10);
        if (!p || p < 1) return;
        if (libState.pages && p > libState.pages) return;
        libState.page = p;
        loadLib(function () { $main.scrollTop = 0; });
      });
    });

    var $rl = $main.querySelector("[data-reload]");
    if ($rl) $rl.addEventListener("click", function () { loadLib(); });
  }

  /* ============================================================ 生成器页 */

  var GEN_TOOLS = [
    { k: "scoreboard", ico: "T", n: "T显 / 计分板", d: "侧边栏计分板与 titleraw T 显字幕，填参数直接出指令" },
    { k: "enumerate", ico: "举", n: "穷举生成", d: "模板里写 {变量}，一次展开上百条指令" },
    { k: "scroller", ico: "幕", n: "滚动字幕", d: "轮播公告或逐字横幅，服务器活动提示随手做" },
    { k: "music", ico: "音", n: "音乐生成", d: "音符网格转命令方块音乐，16 种乐器" },
    { k: "titleraw", ico: "J", n: "T显 JSON", d: "可视化拼装 rawtext，文字/选择器/计分板自由组合" }
  ];

  var genCur = null;   // 当前打开的子工具 key

  function formGet() { return lsGet(S_FORM, {}); }
  function formSet(k, v) {
    var o = formGet();
    o[k] = v;
    lsSet(S_FORM, o);
  }

  function renderTools() {
    if (genCur) { renderGenTool(genCur); return; }

    var h = '<div class="page">';
    h += '<div class="sec-title">指令生成器</div>';
    h += '<div class="card"><p>所有生成器都在你的浏览器里算，不联网、不上传。' +
      "生成的指令是<strong>基岩版</strong>语法，可直接粘进命令方块。</p></div>";
    h += '<div class="gen-grid">' + GEN_TOOLS.map(function (t) {
      return '<button class="gcard" data-tool="' + t.k + '">' +
        '<div class="ico">' + t.ico + "</div>" +
        "<b>" + esc(t.n) + "</b><span>" + esc(t.d) + "</span></button>";
    }).join("") + "</div>";
    h += "</div>";
    $main.innerHTML = h;

    Array.prototype.forEach.call($main.querySelectorAll("[data-tool]"), function (b) {
      b.addEventListener("click", function () {
        genCur = b.getAttribute("data-tool");
        renderTools();
        $main.scrollTop = 0;
      });
    });
  }

  /* 统一的工具页外壳：标题 + 返回 + 表单容器 + 结果容器 */
  function toolShell(title, bodyHtml) {
    return '<div class="page">' +
      '<div class="row" style="margin-bottom:12px;align-items:center">' +
      '<button class="btn sm" data-back>← 返回</button>' +
      '<div style="font-size:15px;font-weight:750;letter-spacing:-.2px">' + esc(title) + "</div>" +
      "</div>" +
      '<div class="card gen-form">' + bodyHtml + "</div>" +
      '<div id="genOut"></div></div>';
  }

  function bindBack() {
    var b = $main.querySelector("[data-back]");
    if (b) b.addEventListener("click", function () { genCur = null; renderTools(); });
  }

  /* 结果区渲染：cmds 是字符串数组，注释行（# 开头）灰显 */
  function showResult(cmds, fileHint) {
    var $out = document.getElementById("genOut");
    if (!$out) return;
    if (!cmds || !cmds.length) {
      $out.innerHTML = '<div class="card"><p style="color:var(--text3)">还没有可生成的内容，先把上面的参数填一下。</p></div>';
      return;
    }
    var txt = cmds.join("\n");
    var body = cmds.map(function (l) {
      if (/^#/.test(l)) return '<span class="cmt">' + esc(l) + "</span>";
      if (l === "") return "";
      return esc(l);
    }).join("\n");

    $out.innerHTML = '<div class="result">' +
      '<div class="rhd"><span>' + cmds.length + " 行</span><div class=\"sp\"></div>" +
      '<button class="btn sm" data-copyall>复制全部</button>' +
      '<button class="btn sm" data-dl>下载 .mcfunction</button></div>' +
      "<pre>" + body + "</pre></div>";

    var b1 = $out.querySelector("[data-copyall]");
    if (b1) b1.addEventListener("click", function () { copyText(txt, "全部指令已复制"); });
    var b2 = $out.querySelector("[data-dl]");
    if (b2) b2.addEventListener("click", function () {
      var name = (fileHint || "cyancodex") + ".mcfunction";
      var blob = new Blob([txt + "\n"], { type: "text/plain;charset=utf-8" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 800);
      toast("已下载 " + name);
    });
  }

  function renderGenTool(k) {
    var f = formGet();
    var tool = null;
    GEN_TOOLS.forEach(function (t) { if (t.k === k) tool = t; });
    if (!tool) { genCur = null; renderTools(); return; }

    var html = "";

    /* ---------------- T显 / 计分板 ---------------- */
    if (k === "scoreboard") {
      var mode = f.sbMode || "side";
      html = '<label>模式</label>' +
        '<div class="row tight" style="margin-bottom:2px">' +
        '<button class="mode' + (mode === "side" ? " on" : "") + '" data-sbmode="side">侧边栏计分板</button>' +
        '<button class="mode' + (mode === "tdisplay" ? " on" : "") + '" data-sbmode="tdisplay">T 显字幕</button>' +
        "</div>" +
        '<label>计分项内部名（英文）</label>' +
        '<input type="text" id="g_obj" value="' + esc(f.sbObj || "coins") + '" placeholder="coins">' +
        '<label>显示名称（中文）</label>' +
        '<input type="text" id="g_disp" value="' + esc(f.sbDisp || "金币") + '" placeholder="金币">';

      if (mode === "side") {
        html += '<label>显示位置</label>' +
          '<select id="g_slot">' +
          ["sidebar|右侧边栏", "list|Tab 列表", "belowName|名字下方", "|不自动显示"].map(function (o) {
            var p = o.split("|");
            return '<option value="' + p[0] + '"' + ((f.sbSlot || "sidebar") === p[0] ? " selected" : "") +
              ">" + p[1] + "</option>";
          }).join("") + "</select>" +
          '<label>玩家与初始分数（每行一个：玩家名 分数）</label>' +
          '<textarea id="g_entries" rows="3" placeholder="Steve 10&#10;Alex 5">' +
          esc(f.sbEntries || "Steve 10\nAlex 5") + "</textarea>" +
          '<div class="hintline">玩家名写 @p / @a 也可以，但建议写死名字方便测试。</div>';
      } else {
        html += '<label>标题位置</label>' +
          '<select id="g_tpos">' +
          ["title|屏幕中央（title）", "subtitle|副标题（subtitle）", "actionbar|物品栏上方（actionbar）"].map(function (o) {
            var p = o.split("|");
            return '<option value="' + p[0] + '"' + ((f.sbTpos || "actionbar") === p[0] ? " selected" : "") +
              ">" + p[1] + "</option>";
          }).join("") + "</select>" +
          '<label>每行内容（前缀 / 计分项 / 后缀，每行一个，用 | 分隔）</label>' +
          '<textarea id="g_tlines" rows="3" placeholder="金币：|coins| 个">' +
          esc(f.sbTlines || "金币：|coins| 个\n等级：|level|") + "</textarea>" +
          '<div class="hintline">格式：前缀|计分项名|后缀。计分项名必须已经用 /scoreboard objectives add 建过。</div>';
      }
      html += '<div class="row" style="margin-top:14px"><button class="btn pri" id="g_go">生成指令</button></div>';
    }

    /* ---------------- 穷举 ---------------- */
    else if (k === "enumerate") {
      html = '<label>指令模板（变量用 {名称} 占位）</label>' +
        '<textarea id="g_tpl" rows="2" placeholder="give @p {item} {n}">' +
        esc(f.enTpl || "give @p {item} {n}") + "</textarea>" +
        '<label>变量取值（每行一个：名称 = 值1, 值2, 值3）</label>' +
        '<textarea id="g_vars" rows="4" placeholder="item = apple, bread&#10;n = 1, 2, 3">' +
        esc(f.enVars || "item = apple, bread\nn = 1, 2") + "</textarea>" +
        '<label>最多生成条数</label>' +
        '<input type="number" id="g_lim" min="1" max="5000" value="' + esc(f.enLim || 100) + '">' +
        '<div class="hintline">做笛卡尔积展开，上限 5000 条。变量名要和模板里的 {名称} 完全一致。</div>' +
        '<div class="row" style="margin-top:14px"><button class="btn pri" id="g_go">生成指令</button></div>';
    }

    /* ---------------- 滚动字幕 ---------------- */
    else if (k === "scroller") {
      var sm = f.scMode || "roll";
      html = '<label>模式</label>' +
        '<div class="row tight" style="margin-bottom:2px">' +
        '<button class="mode' + (sm === "roll" ? " on" : "") + '" data-scmode="roll">轮播字幕</button>' +
        '<button class="mode' + (sm === "banner" ? " on" : "") + '" data-scmode="banner">逐字横幅</button>' +
        "</div>";
      if (sm === "banner") {
        html += '<div class="two"><div><label>X 起点</label>' +
          '<input type="number" id="g_x" value="' + esc(f.scX || 0) + '"></div>' +
          '<div><label>Y 高度</label><input type="number" id="g_y" value="' + esc(f.scY || 64) + '"></div></div>' +
          '<div class="two"><div><label>Z 起点</label>' +
          '<input type="number" id="g_z" value="' + esc(f.scZ || 0) + '"></div>' +
          '<div><label>字间距</label><input type="number" id="g_gap" value="' + esc(f.scGap || 2) + '"></div></div>';
      } else {
        html += '<label>颜色</label><select id="g_color">' +
          Object.keys(GEN.COLORS).map(function (cn) {
            return '<option value="' + cn + '"' + ((f.scColor || "金色") === cn ? " selected" : "") +
              ">" + cn + "</option>";
          }).join("") + "</select>";
      }
      html += '<label>文字内容（每行一条）</label>' +
        '<textarea id="g_text" rows="4" placeholder="欢迎来到服务器&#10;今晚八点活动">' +
        esc(f.scText || "欢迎来到服务器\n今晚八点活动") + "</textarea>" +
        '<div class="hintline">轮播模式会生成一套「节拍器 + 条件显示 + 复位」的命令方块组合。</div>' +
        '<div class="row" style="margin-top:14px"><button class="btn pri" id="g_go">生成指令</button></div>';
    }

    /* ---------------- 音乐 ---------------- */
    else if (k === "music") {
      var notes = f.muNotes || {};
      var ticks = 16;
      var rows = GEN.INSTRUMENTS.length;
      var g = '<div class="grid-wrap"><table class="mgrid"><thead><tr><th>乐器 \\ 拍</th>';
      for (var t = 0; t < ticks; t++) g += "<th>" + t + "</th>";
      g += "</tr></thead><tbody>";
      GEN.INSTRUMENTS.forEach(function (inst) {
        g += '<tr><th title="' + esc(inst) + '">' + esc(GEN.INST_CN[inst] || inst) + "</th>";
        for (var t2 = 0; t2 < ticks; t2++) {
          var on = notes[inst + ":" + t2];
          g += '<td><button type="button" data-note="' + inst + ":" + t2 + '"' +
            (on ? ' class="on" title="音高 ' + on + '"' : "") + "></button></td>";
        }
        g += "</tr>";
      });
      g += "</tbody></table></div>";
      html = g +
        '<div class="hintline">点格子放音符，再点一次取消。默认音高 12（中音），' +
        "放上后可拖动下方滑杆调整全局音高。</div>" +
        '<label>全局音高（0-24，12 为基准）</label>' +
        '<input type="number" id="g_pitch" min="0" max="24" value="' + esc(f.muPitch == null ? 12 : f.muPitch) + '">' +
        '<label style="display:flex;align-items:center;gap:8px;margin-top:12px">' +
        '<input type="checkbox" id="g_loop" style="width:auto"' + (f.muLoop ? " checked" : "") +
        "> 循环播放（末尾自动复位）</label>" +
        '<div class="row" style="margin-top:14px"><button class="btn pri" id="g_go">生成指令</button>' +
        '<button class="btn" id="g_clear">清空网格</button></div>';
    }

    /* ---------------- T显 JSON ---------------- */
    else if (k === "titleraw") {
      var segs = f.trSegs || [
        { kind: "text", text: "你好，" },
        { kind: "selector", selector: "@s" }
      ];
      html = '<div class="two"><div><label>目标</label>' +
        '<input type="text" id="g_target" value="' + esc(f.trTarget || "@a") + '"></div>' +
        '<div><label>位置</label><select id="g_pos">' +
        ["title|title", "subtitle|subtitle", "actionbar|actionbar"].map(function (o) {
          var p = o.split("|");
          return '<option value="' + p[0] + '"' + ((f.trPos || "title") === p[0] ? " selected" : "") +
            ">" + p[1] + "</option>";
        }).join("") + "</select></div></div>";

      html += '<label>片段（按顺序拼接）</label><div id="segList">';
      segs.forEach(function (s, i) {
        html += '<div class="card" style="margin-bottom:8px;padding:11px" data-seg="' + i + '">' +
          '<div class="row" style="align-items:center;margin-bottom:8px">' +
          '<select data-segkind="' + i + '" style="flex:1;padding:6px 9px;border-radius:8px;' +
          'background:var(--bg2);border:1px solid var(--line)">' +
          [["text", "文字"], ["selector", "玩家名"], ["score", "计分板"], ["color", "彩色文字"], ["translate", "翻译键"]]
            .map(function (o) {
              return '<option value="' + o[0] + '"' + (s.kind === o[0] ? " selected" : "") + ">" + o[1] + "</option>";
            }).join("") + "</select>" +
          '<button class="btn sm" data-segdel="' + i + '">删除</button></div>';

        if (s.kind === "selector") {
          html += '<input type="text" data-segval="' + i + '" value="' + esc(s.selector || "@s") +
            '" placeholder="@s / @p / 玩家名">';
        } else if (s.kind === "score") {
          html += '<div class="two"><input type="text" data-segval="' + i + '" value="' +
            esc(s.name || "@s") + '" placeholder="名字"><input type="text" data-segval2="' + i +
            '" value="' + esc(s.obj || "coins") + '" placeholder="计分项"></div>';
        } else if (s.kind === "translate") {
          html += '<input type="text" data-segval="' + i + '" value="' + esc(s.key || "item.apple.name") +
            '" placeholder="item.apple.name">';
        } else {
          html += '<div class="two"><input type="text" data-segval="' + i + '" value="' +
            esc(s.text || "") + '" placeholder="文字内容">';
          if (s.kind === "color") {
            html += '<select data-segval2="' + i + '">' +
              ["white", "yellow", "gold", "red", "green", "aqua", "blue", "light_purple", "gray", "black"]
                .map(function (c) {
                  return '<option value="' + c + '"' + ((s.color || "white") === c ? " selected" : "") +
                    ">" + c + "</option>";
                }).join("") + "</select>";
          } else {
            html += '<div></div>';
          }
          html += "</div>";
        }
        html += "</div>";
      });
      html += "</div>";
      html += '<div class="row" style="margin-top:4px">' +
        '<button class="btn sm" id="g_addseg">+ 添加片段</button></div>' +
        '<div class="row" style="margin-top:14px"><button class="btn pri" id="g_go">生成指令</button></div>';
    }

    $main.innerHTML = toolShell(tool.n, html);
    bindBack();

    /* ---- 子工具内部的模式切换 ---- */
    Array.prototype.forEach.call($main.querySelectorAll("[data-sbmode]"), function (b) {
      b.addEventListener("click", function () {
        formSet("sbMode", b.getAttribute("data-sbmode"));
        renderGenTool("scoreboard");
      });
    });
    Array.prototype.forEach.call($main.querySelectorAll("[data-scmode]"), function (b) {
      b.addEventListener("click", function () {
        formSet("scMode", b.getAttribute("data-scmode"));
        renderGenTool("scroller");
      });
    });

    /* ---- 音乐网格 ---- */
    if (k === "music") {
      Array.prototype.forEach.call($main.querySelectorAll("[data-note]"), function (b) {
        b.addEventListener("click", function () {
          var key = b.getAttribute("data-note");
          var notes2 = formGet().muNotes || {};
          if (notes2[key]) delete notes2[key];
          else notes2[key] = Number((document.getElementById("g_pitch") || {}).value || 12);
          formSet("muNotes", notes2);
          renderGenTool("music");
        });
      });
      var $clr = document.getElementById("g_clear");
      if ($clr) $clr.addEventListener("click", function () {
        formSet("muNotes", {});
        renderGenTool("music");
        toast("网格已清空");
      });
    }

    /* ---- T显 JSON 片段编辑 ---- */
    if (k === "titleraw") {
      var segs2 = formGet().trSegs || f.trSegs;
      Array.prototype.forEach.call($main.querySelectorAll("[data-segkind]"), function (sel) {
        sel.addEventListener("change", function () {
          var i = +sel.getAttribute("data-segkind");
          var arr = (formGet().trSegs || segs2).slice();
          arr[i] = { kind: sel.value, text: "", selector: "@s", name: "@s", obj: "coins" };
          formSet("trSegs", arr);
          renderGenTool("titleraw");
        });
      });
      Array.prototype.forEach.call($main.querySelectorAll("[data-segdel]"), function (b) {
        b.addEventListener("click", function () {
          var i = +b.getAttribute("data-segdel");
          var arr = (formGet().trSegs || segs2).slice();
          arr.splice(i, 1);
          formSet("trSegs", arr);
          renderGenTool("titleraw");
        });
      });
      var $add = document.getElementById("g_addseg");
      if ($add) $add.addEventListener("click", function () {
        var arr = (formGet().trSegs || segs2).slice();
        arr.push({ kind: "text", text: "" });
        formSet("trSegs", arr);
        renderGenTool("titleraw");
      });
    }

    /* ---- 生成按钮 ---- */
    var $go = document.getElementById("g_go");
    if ($go) $go.addEventListener("click", function () { doGen(k); });
  }

  /* 读表单 -> 存偏好 -> 生成 */
  function doGen(k) {
    var g = function (id) {
      var el = document.getElementById(id);
      return el ? el.value : "";
    };

    if (k === "scoreboard") {
      var mode = formGet().sbMode || "side";
      formSet("sbObj", g("g_obj"));
      formSet("sbDisp", g("g_disp"));
      var args = { mode: mode, objective: g("g_obj"), displayName: g("g_disp") };
      if (mode === "side") {
        formSet("sbSlot", g("g_slot"));
        formSet("sbEntries", g("g_entries"));
        args.slot = g("g_slot");
        args.entries = g("g_entries").split(/\r?\n/).map(function (l) {
          var m = l.trim().match(/^(\S+)\s+(-?\d+)$/);
          return m ? { player: m[1], value: +m[2] } : null;
        }).filter(Boolean);
      } else {
        formSet("sbTpos", g("g_tpos"));
        formSet("sbTlines", g("g_tlines"));
        args.tpos = g("g_tpos");
        args.tlines = g("g_tlines").split(/\r?\n/).map(function (l) {
          if (!l.trim()) return null;
          var p = l.split("|");
          return { prefix: (p[0] || "").trim(), objective: (p[1] || "").trim(), suffix: (p[2] || "").trim() };
        }).filter(Boolean);
      }
      showResult(GEN.scoreboard(args), "scoreboard");
      return;
    }

    if (k === "enumerate") {
      formSet("enTpl", g("g_tpl"));
      formSet("enVars", g("g_vars"));
      formSet("enLim", g("g_lim"));
      var vars = {};
      g("g_vars").split(/\r?\n/).forEach(function (line) {
        var m = line.match(/^\s*([^=]+?)\s*=\s*(.*)$/);
        if (!m) return;
        vars[m[1].trim()] = m[2].split(",").map(function (s) { return s.trim(); }).filter(Boolean);
      });
      var out = GEN.enumerate(g("g_tpl"), vars, Number(g("g_lim")) || 100);
      showResult(out, "enumerate");
      if (out.length) toast("已生成 " + out.length + " 条");
      return;
    }

    if (k === "scroller") {
      var sm = formGet().scMode || "roll";
      formSet("scText", g("g_text"));
      var sa = { mode: sm, text: g("g_text") };
      if (sm === "banner") {
        formSet("scX", g("g_x")); formSet("scY", g("g_y"));
        formSet("scZ", g("g_z")); formSet("scGap", g("g_gap"));
        sa.x = Number(g("g_x")); sa.y = Number(g("g_y"));
        sa.z = Number(g("g_z")); sa.gap = Number(g("g_gap"));
      } else {
        formSet("scColor", g("g_color"));
        sa.color = g("g_color");
      }
      showResult(GEN.scroller(sa), "scroller");
      return;
    }

    if (k === "music") {
      var notes = formGet().muNotes || {};
      var pitch = Number(g("g_pitch"));
      if (isFinite(pitch)) formSet("muPitch", pitch);
      formSet("muLoop", !!document.getElementById("g_loop").checked);
      var events = Object.keys(notes).map(function (key) {
        var p = key.split(":");
        return { instrument: p[0], tick: Number(p[1]), note: isFinite(pitch) ? pitch : 12 };
      });
      showResult(GEN.music({ events: events, loop: document.getElementById("g_loop").checked }), "music");
      return;
    }

    if (k === "titleraw") {
      formSet("trTarget", g("g_target"));
      formSet("trPos", g("g_pos"));
      var segs = (formGet().trSegs || []).slice();
      // 从 DOM 回收当前编辑值（用户可能改过输入框但还没点别的地方）
      Array.prototype.forEach.call($main.querySelectorAll("[data-segval]"), function (el) {
        var i = +el.getAttribute("data-segval");
        if (!segs[i]) return;
        if (segs[i].kind === "selector") segs[i].selector = el.value;
        else if (segs[i].kind === "translate") segs[i].key = el.value;
        else if (segs[i].kind === "score") segs[i].name = el.value;
        else segs[i].text = el.value;
      });
      Array.prototype.forEach.call($main.querySelectorAll("[data-segval2]"), function (el) {
        var i = +el.getAttribute("data-segval2");
        if (!segs[i]) return;
        if (segs[i].kind === "score") segs[i].obj = el.value;
        else if (segs[i].kind === "color") segs[i].color = el.value;
      });
      formSet("trSegs", segs);
      showResult([GEN.titleraw(g("g_target"), g("g_pos"), segs)], "titleraw");
      return;
    }
  }

  /* ================================================================ AI 页 */

  var convs = [];
  var curId = null;

  function loadConvs() {
    var a = lsGet(S_CONVS, []);
    convs = Array.isArray(a) ? a.filter(function (c) {
      return c && typeof c.id === "string" && Array.isArray(c.msgs);
    }) : [];
    curId = lsGet(S_CUR, null);
    if (!convs.length) {
      newConv(true);
    } else if (!curId || !findConv(curId)) {
      curId = convs[0].id;
      lsSet(S_CUR, curId);
    }
  }

  function findConv(id) {
    for (var i = 0; i < convs.length; i++) if (convs[i].id === id) return convs[i];
    return null;
  }

  function curConv() { return findConv(curId); }

  function saveConvs() {
    // 按更新时间倒序保存，侧栏顺序即"最近在用"
    convs.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
    lsSet(S_CONVS, convs);
    lsSet(S_CUR, curId);
  }

  function newConv(silent, mode) {
    var c = {
      id: "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      title: "新对话",
      mode: mode || "chat",
      msgs: [],
      ts: Date.now()
    };
    convs.unshift(c);
    curId = c.id;
    saveConvs();
    if (!silent) { render(); }
    return c;
  }

  var MODES = [
    ["chat", "通用"],
    ["scoreboard", "计分板 / T显"],
    ["enumerate", "批量指令"],
    ["scroller", "滚动字幕"],
    ["titleraw", "T显 JSON"]
  ];

  function modeDesc(k) {
    return ({
      chat: "通用问答，按需给指令",
      scoreboard: "优先给计分板 / T 显指令",
      enumerate: "按模板批量展开全部组合",
      scroller: "滚动字幕 / 轮播公告",
      titleraw: "直接给 titleraw JSON"
    })[k] || "";
  }

  function newConvSheetHtml() {
    return '<div class="sheet" id="newConvSheet"><div class="sheet-box">' +
      '<div class="sheet-hd"><span>新建对话</span><div class="sp"></div>' +
      '<button class="x" id="newConvClose" title="关闭">×</button></div>' +
      '<div class="tip" style="margin-bottom:8px">选择这条对话的回答模式，之后可在设置里改。</div>' +
      MODES.map(function (m) {
        return '<button class="mode-row" data-newmode="' + m[0] + '">' +
          '<b>' + esc(m[1]) + '</b><span>' + esc(modeDesc(m[0])) + '</span></button>';
      }).join("") +
      '</div></div>';
  }

  function renderAttachList() {
    var $l = document.getElementById("attachList");
    if (!$l) return;
    $l.innerHTML = aiAttach.map(function (f, i) {
      return '<span class="attach-chip">' + esc(f.name) +
        '<button data-rm-attach="' + i + '" title="移除">×</button></span>';
    }).join("");
    Array.prototype.forEach.call($l.querySelectorAll("[data-rm-attach]"), function (b) {
      b.addEventListener("click", function () {
        aiAttach.splice(+b.getAttribute("data-rm-attach"), 1);
        renderAttachList();
      });
    });
  }

  function renderAi() {
    var c = curConv();
    if (!c) { newConv(true); c = curConv(); }

    var ac = aiCfg();
    var logged = isLogin();
    var u = authUser() || {};
    var uname = u.nickname || u.username || "";

    var stText, stOff;
    if (ac.channel === "custom") {
      stText = "自定义 · " + (ac.model || "未配置");
      stOff = !customReady();
    } else if (logged) {
      stText = "限时免费 · " + uname;
      stOff = false;
    } else {
      stText = "限时免费 · 未登录";
      stOff = true;
    }

    var modeLabel = "通用";
    MODES.forEach(function (m) { if (m[0] === (c.mode || "chat")) modeLabel = m[1]; });

    var h = '<div class="ai-wrap">';

    /* ---- 侧边栏：对话记录直接列在这里（不另开"服务器历史"页） ---- */
    h += '<aside class="ai-side' + (aiSideOpen ? "" : " hide") + '" id="aiSide">' +
      '<div class="shd"><b>对话记录</b>' +
      '<button class="btn sm" id="btnNewConv">+ 新建</button>' +
      '<button class="icon-btn" id="btnSideClose" title="收起" style="width:26px;height:26px">×</button>' +
      '</div>' +
      '<div class="ai-search"><input id="convSearch" placeholder="搜索标题或对话内容…" autocomplete="off"></div>' +
      '<div class="convs" id="convList">' + convListHtml() + '</div>' +
      '</aside>';

    /* ---- 主区 ---- */
    h += '<div class="ai-main">' +
      '<div class="ai-topbar">' +
      '<button class="icon-btn" id="btnSide" title="对话列表">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg></button>' +
      '<div class="ai-title"><b>AI 助手</b><small id="aiSub">' + esc(c.title || "新对话") +
      ' · ' + esc(modeLabel) + '</small></div>' +
      '<div class="sp"></div>' +
      '<button class="icon-btn" id="btnNewConvTop" title="新建对话">＋</button>' +
      '<button class="icon-btn" id="btnShareConv" title="分享整段对话">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/>' +
      '<circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>' +
      '<path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/></svg></button>' +
      '<button class="icon-btn" id="btnAiCfg" title="AI 设置">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ' +
      'stroke-linecap="round" stroke-linejoin="round">' +
      '<circle cx="12" cy="12" r="3"/>' +
      '<path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 ' +
      '1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1' +
      'a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1' +
      'A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3' +
      'H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1' +
      'a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1' +
      'a1.6 1.6 0 0 0-1.5 1z"/></svg></button>' +
      '</div>' +
      '<div class="ai-status"><i class="' + (stOff ? "off" : "") + '"></i><span>' + esc(stText) + '</span></div>' +
      '<div class="ai-scroll" id="aiScroll"><div class="ai-inner" id="aiList">' +
      messagesHtml(c) +
      '</div></div>';

    /* 输入区 */
    h += '<div class="composer"><div class="inner">' +
      '<div class="box"><button class="attach" id="aiAttachBtn" title="添加文本附件">📎</button>' +
      '<input type="file" id="aiFile" accept=".txt,.md,.json,.mcfunction,.log,.csv" multiple hidden>' +
      '<textarea id="aiInput" rows="1" placeholder="描述你要的指令…"></textarea>' +
      '<button class="send" id="aiSend" disabled title="发送">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ' +
      'stroke-linecap="round" stroke-linejoin="round"><path d="M4 12l16-8-6 8 6 8z"/></svg>' +
      '</button></div>' +
      '<div class="attach-list" id="attachList"></div>' +
      '<div class="ai-hint"><span>Enter 发送 · Shift+Enter 换行</span>' +
      '<span class="kbd">模式与通道在右上角 ⚙</span></div>' +
      '</div></div>';

    h += '</div></div>';

    h += aiCfgSheetHtml();
    h += newConvSheetHtml();

    $main.innerHTML = h;
    $main.classList.add("ai-mode");

    bindAi();
    bindAiCfg();
    scrollBottom(true);
    setSendState();
  }

  function dateGroup(ts) {
    var d = new Date(ts || 0).getTime();
    var now = new Date();
    var start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (d >= start) return "今天";
    if (d >= start - 86400000) return "昨天";
    if (d >= start - 7 * 86400000) return "7 天内";
    return "更早";
  }

  function convListHtml() {
    var q = (window._convQuery || "").trim().toLowerCase();
    var arr = convs.slice();
    if (q) {
      arr = arr.filter(function (x) {
        if (String(x.title || "").toLowerCase().indexOf(q) >= 0) return true;
        return (x.msgs || []).some(function (m) {
          return String(m.content || "").toLowerCase().indexOf(q) >= 0;
        });
      });
    }
    var groups = {};
    arr.forEach(function (x) {
      var g = dateGroup(x.ts);
      (groups[g] = groups[g] || []).push(x);
    });
    var out = "";
    ["今天", "昨天", "7 天内", "更早"].forEach(function (g) {
      if (!groups[g] || !groups[g].length) return;
      out += '<div class="conv-group">' + g + '</div>';
      groups[g].forEach(function (x) {
        out += '<div class="conv-item' + (x.id === curId ? " on" : "") + '" data-conv="' + esc(x.id) + '">' +
          '<span class="t">' + esc(x.title || "新对话") + '</span>' +
          '<button class="ren" data-renconv="' + esc(x.id) + '" title="重命名">✎</button>' +
          '<button class="del" data-delconv="' + esc(x.id) + '" title="删除">×</button></div>';
      });
    });
    return out || '<div class="conv-empty">没有匹配的对话</div>';
  }

  function refreshConvList() {
    var $cl = document.getElementById("convList");
    if ($cl) $cl.innerHTML = convListHtml();
  }

  function helloHtml() {
    return '<div class="hello"><img src="/web/icon-192.png" alt="">' +
      "<h2>想做什么指令？</h2>" +
      "<p>描述需求，AI 直接给能用的命令方块指令 · 基岩版</p></div>" +
      '<div class="quick" style="margin-top:18px">' +
      [
        ["计分板", "做一个侧边栏计分板，显示金币数量，初始 0 分"],
        ["批量生成", "批量生成 10 种颜色羊毛的 give 指令，目标 @p，数量 1"],
        ["滚动字幕", "做一段循环滚动的公告：欢迎来到服务器 · 今晚八点活动"],
        ["语法问答", "execute 和 scoreboard 有什么区别？各自适合什么场景？"]
      ].map(function (e, i) {
        return '<button class="qcard" data-ask="' + i + '">' +
          '<div class="ico">' + esc(e[0].slice(0, 1)) + "</div>" +
          "<div><b>" + esc(e[0]) + "</b><span>" + esc(e[1]) + "</span></div></button>";
      }).join("") + "</div>";
  }

  function msgActions(idx, isAi) {
    return '<div class="acts">' +
      '<button data-copy-msg="' + idx + '">复制</button>' +
      (isAi
        ? '<button data-regen-msg="' + idx + '">重新生成</button>'
        : '<button data-edit-msg="' + idx + '">修改</button>') +
      '<button data-del-msg="' + idx + '">删除</button>' +
      '</div>';
  }

  function messagesHtml(c) {
    if (!c.msgs.length) return helloHtml();
    return c.msgs.map(function (m, i) { return msgHtml(m.role, m.content, i); }).join("");
  }


  /* ------------------------------------------------- AI 设置面板 HTML */
  function aiCfgSheetHtml() {
    var c = aiCfg();
    var h = '<div class="sheet" id="aiCfgSheet"><div class="sheet-box">' +
      '<div class="sheet-hd"><span>AI 设置</span><div class="sp"></div>' +
      '<button class="x" id="aiCfgClose" title="关闭">×</button></div>';

    h += '<div class="fld"><label>通道</label>' +
      '<div class="row tight">' +
      '<button class="mode' + (c.channel === "free" ? " on" : "") + '" data-ch="free">限时免费</button>' +
      '<button class="mode' + (c.channel === "custom" ? " on" : "") + '" data-ch="custom">自定义</button>' +
      "</div></div>";

    /* --- 回答模式（原来挂在输入框上方，占一整行；现在收进设置里） --- */
    var curMode = (curConv() || {}).mode || "chat";
    h += '<div class="fld"><label>回答模式</label><div class="row tight">' +
      MODES.map(function (m) {
        return '<button class="mode' + (curMode === m[0] ? " on" : "") +
          '" data-setmode="' + m[0] + '">' + esc(m[1]) + "</button>";
      }).join("") + "</div>" +
      '<div class="tip">只影响 AI 的回答倾向（比如「计分板」会直接给 scoreboard 指令），' +
      "不改变通道。</div></div>";

    /* --- 限时免费 --- */
    var logged = isLogin();
    var uname = (authUser() || {}).nickname || (authUser() || {}).username || "";
    h += '<div id="paneFree"' + (c.channel === "free" ? "" : ' style="display:none"') + ">";
    if (logged) {
      h += '<div class="lockbox" style="border-color:color-mix(in srgb,var(--green) 36%,var(--line));' +
        'background:color-mix(in srgb,var(--green) 8%,var(--card))">' +
        "<b>已登录 · " + esc(uname) + "</b>" +
        "免费通道可用，按账号每日计额度。请求经本站服务端转发，所以必须能识别到账号。" +
        "</div>";
    } else {
      h += '<div class="lockbox"><b>使用免费 AI 必须登录</b>' +
        "免费通道按账号计额度，需要先登录。登录请求由你的浏览器直接发往官方接口" +
        "（cyancodex.cn），不经过本站服务器 —— 这样不会把本站 IP 暴露给官方风控。" +
        "</div>" +
        '<div class="row" style="margin-bottom:12px">' +
        '<button class="btn pri sm" data-gologin="1">登录 / 注册</button></div>';
    }
    h += '<div class="fld"><div class="tip">' +
      "说明：免费通道的请求经本站服务端转发，所以必须能识别到账号；" +
      "自定义通道的请求由浏览器直连你的服务商，本站不接触你的 Key 与内容。" +
      "</div></div></div>";

    /* --- 自定义 --- */
    h += '<div id="paneCustom"' + (c.channel === "custom" ? "" : ' style="display:none"') + ">" +
      '<div class="fld"><label>API 地址</label>' +
      '<input id="aiBase" type="text" placeholder="https://api.deepseek.com/v1/" value="' +
      esc(c.base) + '">' +
      '<div class="tip">要填到版本号那一层，通常以 /v1/ 结尾。填到 /chat/completions 也能识别。</div></div>' +
      '<div class="fld"><label>API Key</label>' +
      '<input id="aiKey" type="password" placeholder="sk-..." value="' + esc(c.key) + '">' +
      '<div class="tip">只存在这台设备的浏览器里（localStorage），不会上传到本站。</div></div>' +
      '<div class="fld"><label>模型</label>' +
      '<input id="aiModel" type="text" placeholder="deepseek-chat" value="' + esc(c.model) + '">' +
      '<div class="tip">留空可先点「获取模型」，从服务商返回的列表里挑一个。</div></div>' +
      '<div class="row" style="margin-bottom:12px">' +
      '<button class="btn sm" id="aiFetchModels">获取模型</button>' +
      '<button class="btn sm" id="aiTest">测试连接</button>' +
      '<div class="sp" style="flex:1"></div>' +
      '<button class="btn sm pri" id="aiCfgSave">保存</button></div>' +
      '<div id="aiModelList"></div>' +
      '<div id="aiTestOut"></div>' +
      "</div>";

    h += "</div></div>";
    return h;
  }

  function msgHtml(role, content, idx) {
    return '<div class="msg ' + (role === "user" ? "me" : "ai") + '">' +
      '<div class="av">' + (role === "user" ? "你" : "AI") + "</div>" +
      '<div class="bubble">' + md(content || "") +
      (idx == null ? "" : msgActions(idx, role !== "user")) +
      "</div></div>";
  }


  function bindAi() {
    var $input = document.getElementById("aiInput");
    var $send = document.getElementById("aiSend");

    if ($input) {
      $input.addEventListener("input", function () {
        autosize($input);
        if (!busy) $send.disabled = !$input.value.trim();
      });
      $input.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          if (busy) return;
          send();
        }
      });
      if (window.innerWidth > 760) $input.focus();
    }
    if ($send) $send.addEventListener("click", function () {
      if (busy) stopGen(); else send();
    });

    /* ---- 移动端侧栏开关 ---- */
    var openSide = function (v) {
      aiSideOpen = v;
      var $s = document.getElementById("aiSide");
      if ($s) $s.classList.toggle("hide", !v);
      var old = document.getElementById("aiScrim");
      if (v && window.innerWidth <= 760) {
        if (!old) {
          var sc = document.createElement("div");
          sc.className = "ai-scrim";
          sc.id = "aiScrim";
          var $w = document.querySelector(".ai-wrap");
          if ($w) $w.appendChild(sc);
          sc.addEventListener("click", function () { openSide(false); });
        }
      } else if (old) {
        old.remove();
      }
    };

    var $bs = document.getElementById("btnSide");
    if ($bs) $bs.addEventListener("click", function () { openSide(true); });
    var $bsc = document.getElementById("btnSideClose");
    if ($bsc) $bsc.addEventListener("click", function () { openSide(false); });
    var $scrim = document.getElementById("aiScrim");
    if ($scrim) $scrim.addEventListener("click", function () { openSide(false); });

    var openNew = function () {
      if (busy) return;
      var s = document.getElementById("newConvSheet");
      if (s) s.classList.add("on");
    };
    var $nc = document.getElementById("btnNewConv");
    if ($nc) $nc.addEventListener("click", openNew);
    var $nct = document.getElementById("btnNewConvTop");
    if ($nct) $nct.addEventListener("click", openNew);
    var $ncs = document.getElementById("newConvSheet");
    var $ncc = document.getElementById("newConvClose");
    if ($ncc && $ncs) $ncc.addEventListener("click", function () { $ncs.classList.remove("on"); });
    if ($ncs) $ncs.addEventListener("click", function (e) { if (e.target === $ncs) $ncs.classList.remove("on"); });
    Array.prototype.forEach.call($main.querySelectorAll("[data-newmode]"), function (b) {
      b.addEventListener("click", function () {
        if ($ncs) $ncs.classList.remove("on");
        newConv(false, b.getAttribute("data-newmode"));
        var i2 = document.getElementById("aiInput");
        if (i2) i2.focus();
      });
    });

    /* 文本附件 */
    var $file = document.getElementById("aiFile");
    var $ab = document.getElementById("aiAttachBtn");
    if ($ab && $file) {
      $ab.addEventListener("click", function () { $file.click(); });
      $file.addEventListener("change", function () {
        Array.prototype.slice.call($file.files || []).forEach(function (f) {
          if (f.size > 200 * 1024) { toast("附件太大（上限 200KB）：" + f.name); return; }
          var r = new FileReader();
          r.onload = function () {
            aiAttach.push({ name: f.name, text: String(r.result || "") });
            renderAttachList();
          };
          r.readAsText(f);
        });
        $file.value = "";
      });
    }
    renderAttachList();

    /* 侧栏搜索 */
    var $cs = document.getElementById("convSearch");
    if ($cs) {
      $cs.value = window._convQuery || "";
      $cs.addEventListener("input", function () {
        window._convQuery = $cs.value;
        refreshConvList();
      });
    }

    /* 侧栏列表：事件委托（重命名/删除/切换） */
    var $cl = document.getElementById("convList");
    if ($cl) {
      $cl.addEventListener("click", function (e) {
        var del = e.target.closest && e.target.closest("[data-delconv]");
        if (del) {
          e.stopPropagation();
          var id = del.getAttribute("data-delconv");
          if (!window.confirm("删除这条对话？不可恢复。")) return;
          convs = convs.filter(function (x) { return x.id !== id; });
          if (curId === id) {
            if (convs.length) curId = convs[0].id;
            else newConv(true);
          }
          saveConvs(); render(); toast("对话已删除");
          return;
        }
        var ren = e.target.closest && e.target.closest("[data-renconv]");
        if (ren) {
          e.stopPropagation();
          var rid = ren.getAttribute("data-renconv");
          var cv = findConv(rid);
          if (!cv) return;
          var t = window.prompt("重命名对话", cv.title || "新对话");
          if (t == null) return;
          t = t.trim().slice(0, 40);
          if (!t) return;
          cv.title = t; saveConvs(); render(); toast("已重命名");
          return;
        }
        var item = e.target.closest && e.target.closest("[data-conv]");
        if (item) {
          if (busy) return;
          curId = item.getAttribute("data-conv");
          saveConvs();
          if (window.innerWidth <= 760) aiSideOpen = false;
          render();
        }
      });
    }

    /* 消息操作：复制 / 重新生成 */
    var $list = document.getElementById("aiList");
    if ($list) {
      $list.addEventListener("click", function (e) {
        var cp = e.target.closest && e.target.closest("[data-copy-msg]");
        if (cp) {
          var i = +cp.getAttribute("data-copy-msg");
          var c = curConv();
          if (c && c.msgs[i]) copyText(c.msgs[i].content, "已复制");
          return;
        }
        var rg = e.target.closest && e.target.closest("[data-regen-msg]");
        if (rg) {
          regenerate(+rg.getAttribute("data-regen-msg"));
          return;
        }
        var ed = e.target.closest && e.target.closest("[data-edit-msg]");
        if (ed) {
          var ei = +ed.getAttribute("data-edit-msg");
          var c2 = curConv();
          if (!c2 || !c2.msgs[ei]) return;
          var content = c2.msgs[ei].content;
          c2.msgs = c2.msgs.slice(0, ei);
          saveConvs();
          render();
          var $in2 = document.getElementById("aiInput");
          if ($in2) { $in2.value = content; autosize($in2); $in2.focus(); }
          return;
        }
        var dl = e.target.closest && e.target.closest("[data-del-msg]");
        if (dl) {
          var di = +dl.getAttribute("data-del-msg");
          var c3 = curConv();
          if (!c3 || !c3.msgs[di]) return;
          c3.msgs.splice(di, 1);
          if (di < c3.msgs.length && c3.msgs[di] && c3.msgs[di].role === "assistant") {
            c3.msgs.splice(di, 1);
          }
          saveConvs();
          render();
          toast("已删除");
          return;
        }
      });
    }

    /* 分享整段对话 */
    var $sh = document.getElementById("btnShareConv");
    if ($sh) $sh.addEventListener("click", shareConv);

    /* 欢迎页快捷问题 */
    Array.prototype.forEach.call($main.querySelectorAll("[data-ask]"), function (b) {
      b.addEventListener("click", function () {
        var i = +b.getAttribute("data-ask");
        var texts = [
          "做一个侧边栏计分板，显示金币数量，初始 0 分",
          "批量生成 10 种颜色羊毛的 give 指令，目标 @p，数量 1",
          "做一段循环滚动的公告：欢迎来到服务器 · 今晚八点活动",
          "execute 和 scoreboard 有什么区别？各自适合什么场景？"
        ];
        if ($input) {
          $input.value = texts[i] || "";
          autosize($input);
          $send.disabled = false;
          $input.focus();
        }
      });
    });
  }


  /* ------------------------------------------------- AI 设置面板交互 */
  function bindAiCfg() {
    var $sheet = document.getElementById("aiCfgSheet");
    var $open = document.getElementById("btnAiCfg");
    var $close = document.getElementById("aiCfgClose");
    if ($open && $sheet) {
      $open.addEventListener("click", function () { $sheet.classList.add("on"); });
    }
    if ($close && $sheet) {
      $close.addEventListener("click", function () { $sheet.classList.remove("on"); });
    }
    if ($sheet) {
      // 点遮罩关闭（只认遮罩本身，点面板内部不关）
      $sheet.addEventListener("click", function (e) {
        if (e.target === $sheet) $sheet.classList.remove("on");
      });
    }

    /* 免费面板里的「登录 / 注册」 */
    var $gl = $main.querySelector("[data-gologin]");
    if ($gl) $gl.addEventListener("click", function () {
      if ($sheet) $sheet.classList.remove("on");
      openAuth("login");
    });

    /* 回答模式：只切按钮状态，不重绘（重绘会把 sheet 关掉） */
    Array.prototype.forEach.call($main.querySelectorAll("[data-setmode]"), function (b) {
      b.addEventListener("click", function () {
        var c = curConv();
        if (!c) return;
        c.mode = b.getAttribute("data-setmode");
        saveConvs();
        Array.prototype.forEach.call($main.querySelectorAll("[data-setmode]"), function (x) {
          x.classList.toggle("on", x === b);
        });
        toast("模式：" + (b.textContent || ""));
      });
    });

    /* 通道切换：只切 UI，点「保存」才落盘 */
    var pending = { channel: aiCfg().channel };
    Array.prototype.forEach.call($main.querySelectorAll("[data-ch]"), function (b) {
      b.addEventListener("click", function () {
        pending.channel = b.getAttribute("data-ch");
        Array.prototype.forEach.call($main.querySelectorAll("[data-ch]"), function (x) {
          x.classList.toggle("on", x.getAttribute("data-ch") === pending.channel);
        });
        var pf = document.getElementById("paneFree");
        var pc = document.getElementById("paneCustom");
        if (pf) pf.style.display = pending.channel === "free" ? "" : "none";
        if (pc) pc.style.display = pending.channel === "custom" ? "" : "none";
      });
    });

    /* 获取模型列表 */
    var $fetch = document.getElementById("aiFetchModels");
    if ($fetch) $fetch.addEventListener("click", function () {
      var base = (document.getElementById("aiBase") || {}).value || "";
      var key = (document.getElementById("aiKey") || {}).value || "";
      var $out = document.getElementById("aiModelList");
      if (!base.trim() || !key.trim()) {
        toast("先填 API 地址和 Key");
        return;
      }
      $fetch.disabled = true;
      $fetch.textContent = "获取中…";
      fetch(joinUrl(base, "models"), {
        headers: { "Authorization": "Bearer " + key.trim(), "Accept": "application/json" }
      }).then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      }).then(function (d) {
        var ids = (d && d.data ? d.data : []).map(function (m) {
          return m && m.id ? String(m.id) : "";
        }).filter(Boolean);
        if (!ids.length) {
          $out.innerHTML = '<div class="tip">服务商没有返回模型列表，直接手填模型名即可。</div>';
          return;
        }
        $out.innerHTML = '<div class="tip">点一个填入模型名：</div><div class="modellist">' +
          ids.map(function (id) {
            return '<button type="button" data-pick="' + esc(id) + '">' + esc(id) + "</button>";
          }).join("") + "</div>";
        Array.prototype.forEach.call($out.querySelectorAll("[data-pick]"), function (b) {
          b.addEventListener("click", function () {
            var $m = document.getElementById("aiModel");
            if ($m) $m.value = b.getAttribute("data-pick");
            Array.prototype.forEach.call($out.querySelectorAll("[data-pick]"), function (x) {
              x.classList.toggle("on", x === b);
            });
          });
        });
      }).catch(function (e) {
        $out.innerHTML = '<div class="tip" style="color:var(--red)">获取失败：' + esc(e.message) +
          "。检查地址是否可访问、Key 是否正确（部分服务商禁用了 /models）。</div>";
      }).then(function () {
        $fetch.disabled = false;
        $fetch.textContent = "获取模型";
      });
    });

    /* 测试连接：发一条极短的对话，确认端到端可用 */
    var $test = document.getElementById("aiTest");
    if ($test) $test.addEventListener("click", function () {
      var base = (document.getElementById("aiBase") || {}).value || "";
      var key = (document.getElementById("aiKey") || {}).value || "";
      var model = (document.getElementById("aiModel") || {}).value || "";
      var $out = document.getElementById("aiTestOut");
      if (!base.trim() || !key.trim() || !model.trim()) {
        toast("地址 / Key / 模型三项都要填");
        return;
      }
      $test.disabled = true;
      $test.textContent = "测试中…";
      $out.innerHTML = "";
      var t0 = Date.now();
      fetch(joinUrl(base, "chat/completions"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + key.trim()
        },
        body: JSON.stringify({
          model: model.trim(),
          stream: false,
          max_tokens: 32,
          messages: [{ role: "user", content: "回复两个字：可用" }]
        })
      }).then(function (r) {
        return r.text().then(function (t) {
          var d = null;
          try { d = JSON.parse(t); } catch (e) { /* ignore */ }
          if (!r.ok) {
            var msg = (d && d.error && (d.error.message || d.error)) || ("HTTP " + r.status);
            throw new Error(typeof msg === "string" ? msg : ("HTTP " + r.status));
          }
          var c = d && d.choices && d.choices[0];
          var txt = (c && ((c.message && c.message.content) || (c.delta && c.delta.content))) || "";
          return txt;
        });
      }).then(function (txt) {
        var ms = Date.now() - t0;
        $out.innerHTML = '<div class="lockbox" style="border-color:color-mix(in srgb,var(--green) 40%,var(--line));' +
          'background:color-mix(in srgb,var(--green) 9%,var(--card))">' +
          "<b>连接成功</b>" + ms + " ms · 模型返回：" +
          esc(txt ? txt.slice(0, 60) : "（空内容，但接口通了）") + "</div>";
      }).catch(function (e) {
        $out.innerHTML = '<div class="lockbox" style="border-color:color-mix(in srgb,var(--red) 40%,var(--line));' +
          'background:color-mix(in srgb,var(--red) 9%,var(--card))">' +
          "<b>连接失败</b>" + esc(e.message) + "</div>";
      }).then(function () {
        $test.disabled = false;
        $test.textContent = "测试连接";
      });
    });

    /* 保存 */
    var $save = document.getElementById("aiCfgSave");
    if ($save) $save.addEventListener("click", function () {
      var patch = { channel: pending.channel };
      if (pending.channel === "custom") {
        patch.base = ((document.getElementById("aiBase") || {}).value || "").trim();
        patch.key = ((document.getElementById("aiKey") || {}).value || "").trim();
        patch.model = ((document.getElementById("aiModel") || {}).value || "").trim();
        if (!patch.base || !patch.key || !patch.model) {
          toast("地址 / Key / 模型三项都要填");
          return;
        }
      }
      saveAiCfg(patch);
      if ($sheet) $sheet.classList.remove("on");
      render();
      toast(patch.channel === "custom" ? "已切到自定义通道" : "已切到限时免费通道");
    });
  }


  function autosize(el) {
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 150) + "px";
  }

  function scrollBottom(force) {
    var $s = document.getElementById("aiScroll");
    if (!$s) return;
    if (force || $s.scrollHeight - $s.scrollTop - $s.clientHeight < 140) {
      $s.scrollTop = $s.scrollHeight;
    }
  }

  function errText(status, data) {
    if (data && data.error) {
      if (typeof data.error === "string") return data.error;
      if (data.error.message) return data.error.message;
    }
    if (status === 401) return "使用免费 AI 必须登录。请在 App 里登录账号，或在 AI 设置里配置自定义 AI。";
    if (status === 429) return "今日额度已用完，明天再来，或者配置自定义 AI 用自己的 Key。";
    if (status === 503) return "该功能当前未开放。";
    if (status === 0) return "网络连接失败，请检查网络后重试。";
    return "请求失败（HTTP " + status + "）";
  }

  /* 未登录提示层 —— 比 toast 显眼，且给出两条出路 */
  function showLoginWall(onGoCfg) {
    var d = document.createElement("div");
    d.className = "sheet on";
    d.innerHTML = '<div class="sheet-box" style="max-width:430px">' +
      '<div class="sheet-hd"><span>需要登录</span><div class="sp"></div>' +
      '<button class="x" data-x="1">×</button></div>' +
      '<div class="lockbox"><b>使用免费 AI 必须登录</b>' +
      "免费通道按账号计额度，需要先登录账号。登录请求由你的浏览器直接发往官方接口，" +
      "不经过本站服务器。不想登录的话，也可以配置自己的 API Key。</div>" +
      '<div class="row"><button class="btn pri" data-login="1">登录 / 注册</button>' +
      '<button class="btn" data-cfg="1">配置自定义 AI</button></div></div>';
    document.body.appendChild(d);
    var close = function () { d.remove(); };
    d.addEventListener("click", function (e) {
      if (e.target === d || (e.target.closest && e.target.closest("[data-x]"))) { close(); return; }
      if (e.target.closest && e.target.closest("[data-login]")) {
        close();
        openAuth("login");
        return;
      }
      if (e.target.closest && e.target.closest("[data-cfg]")) {
        close();
        if (onGoCfg) onGoCfg();
      }
    });
  }

  function send() {
    var $input = document.getElementById("aiInput");
    if (!$input) return;
    var text = $input.value.trim();
    if (!text) return;
    sendText(text, false);
  }

  function sendText(text, isRegen) {
    var $input = document.getElementById("aiInput");
    var $list = document.getElementById("aiList");
    var c = curConv();
    if (!c || busy || !text) return;

    var ac = aiCfg();
    var webToken = authToken();
    if (ac.channel === "free" && !webToken) {
      showLoginWall(function () {
        var s = document.getElementById("aiCfgSheet");
        if (s) s.classList.add("on");
      });
      return;
    }
    if (ac.channel === "custom" && !customReady()) {
      toast("自定义通道还没填全，打开 AI 设置补一下");
      var s2 = document.getElementById("aiCfgSheet");
      if (s2) s2.classList.add("on");
      return;
    }

    if ($input) { $input.value = ""; autosize($input); }

    var full = text;
    if (aiAttach.length) {
      full = text + "\n\n" + aiAttach.map(function (f) {
        return "【附件：" + f.name + "】\n```\n" + f.text + "\n```";
      }).join("\n\n");
    }

    if (!isRegen) {
      if (!c.msgs.length) {
        c.title = text.slice(0, 18) + (text.length > 18 ? "…" : "");
      }
      c.ts = Date.now();
      c.msgs.push({ role: "user", content: full });
      if (c.msgs.length > MAX_MSGS) c.msgs = c.msgs.slice(-MAX_MSGS);
      saveConvs();
      if ($list) {
        if (c.msgs.length === 1) $list.innerHTML = "";
        $list.insertAdjacentHTML("beforeend", msgHtml("user", full, c.msgs.length - 1));
      }
    } else {
      c.ts = Date.now();
      saveConvs();
    }
    aiAttach = [];
    renderAttachList();
    scrollBottom(true);

    var wrap = document.createElement("div");
    wrap.className = "msg ai";
    wrap.innerHTML = '<div class="av">AI</div><div class="bubble typing">' +
      '<span class="think">正在思考… 0s</span></div>';
    if ($list) $list.appendChild(wrap);
    var bubble = wrap.querySelector(".bubble");
    scrollBottom(true);

    var t0 = Date.now();
    var thinkTimer = setInterval(function () {
      var el = bubble.querySelector(".think");
      if (!el) { clearInterval(thinkTimer); return; }
      el.textContent = "正在思考… " + Math.floor((Date.now() - t0) / 1000) + "s";
    }, 500);

    busy = true;
    setSendState();

    var acc = "";
    var gotAny = false;

    var isCustom = ac.channel === "custom";
    var reqUrl, reqHeaders, payload;
    var ctxMsgs = c.msgs.slice(-SEND_CTX).map(function (m) {
      return { role: m.role, content: m.content };
    });

    if (isCustom) {
      reqUrl = joinUrl(ac.base, "chat/completions");
      reqHeaders = {
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
        "Authorization": "Bearer " + ac.key
      };
      payload = { model: ac.model, stream: true, messages: ctxMsgs };
    } else {
      reqUrl = API_CHAT;
      reqHeaders = {
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
        "X-Cyan-Web": "1",
        "Authorization": "Bearer " + webToken
      };
      payload = {
        model: "CyanFree",
        stream: true,
        mode: c.mode || "chat",
        messages: ctxMsgs
      };
    }

    abortCtl = (typeof AbortController !== "undefined") ? new AbortController() : null;
    var fetchOpt = {
      method: "POST",
      headers: reqHeaders,
      body: JSON.stringify(payload)
    };
    if (abortCtl) fetchOpt.signal = abortCtl.signal;

    fetch(reqUrl, fetchOpt).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) {
          var d = null;
          try { d = JSON.parse(t); } catch (e) { /* 非 JSON */ }
          throw { status: res.status, data: d };
        });
      }
      if (!res.body || !res.body.getReader) {
        return res.text().then(function (t) {
          acc = parseWhole(t);
          paint();
        });
      }

      var reader = res.body.getReader();
      var dec = new TextDecoder("utf-8");
      var buf = "";

      function pump() {
        return reader.read().then(function (r) {
          if (r.done) { finish(); return; }
          buf += dec.decode(r.value, { stream: true });
          var lines = buf.split("\n");
          buf = lines.pop() || "";
          lines.forEach(function (line) {
            line = line.trim();
            if (!line || line.indexOf("data:") !== 0) return;
            var p = line.slice(5).trim();
            if (p === "[DONE]") return;
            try {
              var o = JSON.parse(p);
              var ch = o.choices && o.choices[0];
              if (!ch) return;
              var d = ch.delta || ch.message || {};
              if (d.content) { acc += d.content; gotAny = true; paint(); }
            } catch (e) { /* 半行，等下一次 */ }
          });
          return pump();
        });
      }
      return pump();
    }).catch(function (e) {
      clearInterval(thinkTimer);
      bubble.classList.remove("typing");
      busy = false;
      setSendState();
      if (e && (e.name === "AbortError" || e.code === 20)) {
        if (acc.trim()) { finish(); }
        else { wrap.remove(); }
        toast("已停止生成");
        return;
      }
      if (acc.trim()) { finish(); return; }
      wrap.remove();
      var box = document.createElement("div");
      box.className = "err";
      box.innerHTML = "<b>没能生成</b>" + esc(errText((e && e.status) || 0, e && e.data)) +
        '<br><a href="/#download">下载 App 用完整功能 →</a>';
      if ($list) $list.appendChild(box);
      scrollBottom(true);
    });

    function paint() {
      clearInterval(thinkTimer);
      bubble.innerHTML = md(acc);
      scrollBottom(false);
    }

    function finish() {
      clearInterval(thinkTimer);
      bubble.classList.remove("typing");
      busy = false;
      setSendState();
      if (!acc.trim()) {
        wrap.remove();
        if (!gotAny) {
          var box = document.createElement("div");
          box.className = "err";
          box.innerHTML = "<b>没有收到内容</b>AI 没有返回内容，稍后再试一次。";
          if ($list) $list.appendChild(box);
        }
        return;
      }
      c.msgs.push({ role: "assistant", content: acc });
      c.ts = Date.now();
      if (c.msgs.length > MAX_MSGS) c.msgs = c.msgs.slice(-MAX_MSGS);
      saveConvs();
      bubble.insertAdjacentHTML("beforeend", msgActions(c.msgs.length - 1, true));
      scrollBottom(false);
    }
  }

  function stopGen() {
    if (abortCtl) {
      try { abortCtl.abort(); } catch (e) { /* ignore */ }
    }
  }

  function regenerate(idx) {
    var c = curConv();
    if (!c || busy) return;
    if (idx == null || idx < 0 || idx >= c.msgs.length) return;
    c.msgs = c.msgs.slice(0, idx);
    saveConvs();
    var lastUser = null;
    for (var i = c.msgs.length - 1; i >= 0; i--) {
      if (c.msgs[i].role === "user") { lastUser = c.msgs[i]; break; }
    }
    render();
    if (lastUser) sendText(lastUser.content, true);
  }

  function shareConv() {
    var c = curConv();
    if (!c || !c.msgs.length) { toast("当前对话还没有内容"); return; }
    var token = authToken();
    if (!token) {
      showLoginWall(function () {
        var s = document.getElementById("aiCfgSheet");
        if (s) s.classList.add("on");
      });
      return;
    }
    toast("正在生成分享链接…");
    fetch("/api/v1/share", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": "Bearer " + token
      },
      body: JSON.stringify({
        title: c.title || "对话分享",
        messages: c.msgs.map(function (m) {
          return { role: m.role, content: m.content };
        })
      })
    }).then(function (r) {
      return r.text().then(function (t) {
        var d = null;
        try { d = JSON.parse(t); } catch (e) { /* ignore */ }
        return { ok: r.ok, d: d };
      });
    }).then(function (x) {
      if (!x.ok || !x.d || x.d.ok === false) {
        throw new Error((x.d && x.d.error && x.d.error.message) || "分享失败");
      }
      copyText(x.d.url, "链接已复制，可直接粘贴");
    }).catch(function (e) {
      toast("分享失败：" + ((e && e.message) || e));
    });
  }


  function setSendState() {
    var $send = document.getElementById("aiSend");
    var $input = document.getElementById("aiInput");
    if (!$send) return;
    if (busy) {
      $send.disabled = false;
      $send.classList.add("stop");
      $send.title = "停止生成";
      $send.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg>';
    } else {
      $send.disabled = !$input || !$input.value.trim();
      $send.classList.remove("stop");
      $send.title = "发送";
      $send.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12l16-8-6 8 6 8z"/></svg>';
    }
  }


  /* 非流式响应兜底：可能是普通 JSON（OpenAI 格式）或 SSE 整段 */
  function parseWhole(t) {
    var out = "";
    t.split("\n").forEach(function (line) {
      line = line.trim();
      if (line.indexOf("data:") !== 0) return;
      var p = line.slice(5).trim();
      if (p === "[DONE]") return;
      try {
        var o = JSON.parse(p);
        var c = o.choices && o.choices[0];
        if (c) out += (c.delta && c.delta.content) || (c.message && c.message.content) || "";
      } catch (e) { /* ignore */ }
    });
    if (out) return out;
    try {
      var j = JSON.parse(t);
      return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "";
    } catch (e) { return ""; }
  }

  /* ============================================================== 首页 */

  function renderHome() {
    var v = remote.version || {};
    var notes = Array.isArray(v.notes) ? v.notes : (v.notes ? String(v.notes).split("\n") : []);
    var apkUrl = v.url || "/#download";

    var h = '<div class="page">';

    h += '<div class="hero">' +
      '<img src="/web/icon-192.png" alt="CyanCodex">' +
      "<h1>CyanCodex</h1>" +
      "<p>Minecraft 基岩版指令助手 —— 指令库、T显生成器、穷举、滚动字幕、音乐生成、AI 助手，网页打开就能用。</p>" +
      '<div class="tags">' +
      '<span class="badge">基岩版</span>' +
      '<span class="badge">免安装</span>' +
      '<span class="badge">开源二改</span>' +
      "</div></div>";

    /* 快捷入口 */
    h += '<div class="quick">' +
      [["T显 / 计分板", "填参数出指令", "scoreboard"],
       ["指令库", "按分类检索常用指令", "library"],
       ["AI 助手", "描述需求直接生成", "ai"],
       ["穷举生成", "一次展开上百条", "enumerate"]]
        .map(function (x, i) {
          return '<button class="qcard" data-quick="' + x[2] + '">' +
            '<div class="ico">' + esc(x[0].slice(0, 1)) + "</div>" +
            "<div><b>" + esc(x[0]) + "</b><span>" + esc(x[1]) + "</span></div></button>";
        }).join("") + "</div>";

    /* 下载卡 */
    h += '<div class="sec-title">下载 App</div>';
    h += '<div class="card">' +
      "<h3><span class=\"dot\"></span>Android · 二改版 v" + esc(v.latest || "—") + "</h3>" +
      '<p>包名与官方版不同，<strong>不需要卸载官方版本</strong>，两个版本可以同时安装、同时保留，' +
      "数据互不影响。</p>" +
      '<dl class="kv" style="margin:10px 0 12px">' +
      "<dt>安装包大小</dt><dd>" + esc(fmtSize(v.size)) + "</dd>" +
      "<dt>MD5</dt><dd style=\"font-family:ui-monospace,Menlo,monospace;font-size:11.5px\">" +
      esc(v.md5 || "—") + "</dd>" +
      "<dt>发布时间</dt><dd>" + esc(v.published_at ? fmtTime(v.published_at) : "—") + "</dd>" +
      "</dl>" +
      '<a class="btn pri block" href="' + esc(apkUrl) + '" rel="noopener">下载 APK</a>' +
      "</div>";

    if (notes.length) {
      h += '<div class="card"><h3><span class="dot"></span>更新说明</h3>' +
        '<ul class="notes-list">' + notes.map(function (n) {
          return "<li>" + esc(n) + "</li>";
        }).join("") + "</ul></div>";
    }

    /* 二改说明 */
    h += '<div class="sec-title">关于这个版本</div>';
    h += '<div class="card">' +
      "<h3><span class=\"dot\"></span>这是二改版，不是官方版</h3>" +
      "<p>本应用是 CyanCodex 开源项目的<strong>二次修改版</strong>，" +
      "按 GPLv3 协议发布。原项目的著作权归原作者所有；本版本只增加了云备份、" +
      "免费 AI 通道、免费搜索等自建服务端能力，没有改动原版的收费体系。</p>" +
      '<div class="note green" style="margin-top:10px">' +
      "<b>可以和官方版同时装。</b>本版使用独立包名（com.canglan.cyancodex.com），" +
      "Android 会把它当成另一个应用 —— 装它不会覆盖官方版，卸载任意一个也不影响另一个。</div>" +
      '<p style="margin-top:10px">想用原版、看完整功能、或者给作者反馈，请访问官方主页：' +
      '<a href="https://cyancodex.cn" target="_blank" rel="noopener">cyancodex.cn</a></p>' +
      "</div>";

    /* 网页版能力说明 */
    h += '<div class="sec-title">网页版能做什么</div>';
    h += '<div class="card"><p>' +
      "指令库、5 个生成器全部在浏览器本地运行，<strong>不联网、不上传</strong>。" +
      "AI 助手支持两种通道：<strong>限时免费</strong>需要登录账号（走本站服务端），" +
      "<strong>自定义</strong>填自己的 API Key 直接由浏览器连服务商（本站不接触你的 Key 与内容）。" +
      "聊天室、好友、积分、指令上传这些需要账号体系的功能只在 App 里提供。</p></div>";

    h += "</div>";
    $main.innerHTML = h;

    Array.prototype.forEach.call($main.querySelectorAll("[data-quick]"), function (b) {
      b.addEventListener("click", function () {
        var q = b.getAttribute("data-quick");
        if (q === "scoreboard") { genCur = "scoreboard"; go("tools"); }
        else if (q === "enumerate") { genCur = "enumerate"; go("tools"); }
        else go(q);
      });
    });
  }

  /* ============================================================== 更多 */

  function renderMore() {
    var cfg = remote.config || {};
    var v = remote.version || {};

    var h = '<div class="page">';
    h += '<div class="sec-title">应用</div>';
    h += '<div class="list">' +
      li("下", "下载 App", "Android 二改版，可与官方版共存", "https://cyancodex.bluestudio.cn/#download") +
      li("官", "官方主页", "cyancodex.cn · 原项目与完整功能", "https://cyancodex.cn") +
      li("源", "开源仓库", "GPLv3 · 原项目源码", "https://github.com/Diamond-Minec/CyanCodex-Android") +
      "</div>";

    h += '<div class="sec-title">设置</div>';
    h += '<div class="list">' +
      '<div class="li" data-act="theme"><div class="ico">◐</div>' +
      '<div class="t">主题<small>当前：' + esc(themeLabel(lsGet(S_THEME, "system"))) + "</small></div>" +
      '<span class="arrow">›</span></div>' +
      '<div class="li" data-act="clearcache"><div class="ico">⌫</div>' +
      '<div class="t">清空本地数据<small>删除全部对话与生成器参数，不可恢复</small></div>' +
      '<span class="arrow">›</span></div>' +
      "</div>";

    h += '<div class="sec-title">关于</div>';
    h += '<div class="card">' +
      "<h3><span class=\"dot\"></span>版本信息</h3>" +
      '<dl class="kv">' +
      "<dt>网页版</dt><dd>v" + esc(v.latest || "—") + "（跟随 App 版本）</dd>" +
      "<dt>服务端</dt><dd>" + esc(cfg.server_time ? fmtTime(cfg.server_time) : "—") + " 在线</dd>" +
      "<dt>协议</dt><dd>GPLv3（原项目）</dd>" +
      "</dl></div>";

    h += '<div class="card">' +
      "<h3><span class=\"dot\"></span>数据说明</h3>" +
      "<p>网页版的<strong>对话记录只存在你自己的浏览器</strong>（localStorage），" +
      "不会上传到服务器，换设备或清缓存后就没了。想跨设备同步请用 App 的云端同步功能。</p>" +
      "<p>生成器与指令库完全离线运行，服务端不接触你输入的任何内容。</p>" +
      "</div>";

    h += '<div class="card"><p style="font-size:12px;color:var(--text3)">' +
      "本页面是 CyanCodex 开源项目的二改版网页端。原项目著作权归原作者所有。" +
      "二改部分按 GPLv3 同样开源。</p></div>";

    h += "</div>";
    $main.innerHTML = h;

    Array.prototype.forEach.call($main.querySelectorAll("[data-act]"), function (el) {
      el.addEventListener("click", function () {
        var a = el.getAttribute("data-act");
        if (a === "theme") { cycleTheme(); render(); }
        if (a === "clearcache") {
          if (window.confirm("确定清空全部本地数据？对话记录和生成器参数都会删除，不可恢复。")) {
            lsDel(S_CONVS); lsDel(S_CUR); lsDel(S_FORM);
            convs = []; curId = null; loadConvs();
            toast("本地数据已清空");
            render();
          }
        }
      });
    });
  }

  function li(ico, title, sub, href) {
    return '<a class="li" href="' + esc(href) + '" target="_blank" rel="noopener">' +
      '<div class="ico">' + esc(ico) + "</div>" +
      '<div class="t">' + esc(title) + "<small>" + esc(sub) + "</small></div>" +
      '<span class="arrow">›</span></a>';
  }

  function themeLabel(t) {
    return t === "dark" ? "深色" : t === "light" ? "浅色" : "跟随系统";
  }

  /* ============================================================== 路由 */

  function go(p) {
    if (["home", "library", "tools", "ai", "more"].indexOf(p) < 0) p = "home";
    page = p;
    genCur = null;
    // 每次进 AI 页都收起侧栏（App 的 AI 页本身没有侧栏，对话列表是独立页）
    aiSideOpen = false;

    $main.classList.remove("ai-mode");
    Array.prototype.forEach.call(document.querySelectorAll(".nav-item"), function (b) {
      b.classList.toggle("active", b.getAttribute("data-page") === p);
    });
    $main.scrollTop = 0;
    render();
  }

  function render() {
    if (page === "home") renderHome();
    else if (page === "library") {
      // 首次进入才打接口；之后切回来直接复用已加载的数据
      if (!libState.loaded && !libState.loading) {
        loadLib();
      } else {
        renderLibrary();
      }
    }
    else if (page === "tools") renderTools();
    else if (page === "ai") renderAi();
    else renderMore();
  }

  /* ========================================================== 全局事件 */

  Array.prototype.forEach.call(document.querySelectorAll(".nav-item"), function (b) {
    b.addEventListener("click", function () { go(b.getAttribute("data-page")); });
  });

  Array.prototype.forEach.call(document.querySelectorAll("[data-go]"), function (b) {
    b.addEventListener("click", function () { go(b.getAttribute("data-go")); });
  });

  $btnTheme.addEventListener("click", function () { cycleTheme(); });

  /* 代码块复制（事件委托，避免为每个块单独绑定） */
  document.addEventListener("click", function (e) {
    var btn = e.target.closest && e.target.closest("[data-copy-code]");
    if (!btn) return;
    var code = btn.parentNode.querySelector("code");
    if (!code) return;
    var old = btn.textContent;
    copyText(code.textContent, "代码已复制");
    btn.textContent = "已复制";
    setTimeout(function () { btn.textContent = old; }, 1400);
  });

  /* 系统主题变化时，若当前是"跟随系统"则实时切换 */
  if (window.matchMedia) {
    var mq = window.matchMedia("(prefers-color-scheme: dark)");
    var onMq = function () {
      if (lsGet(S_THEME, "system") === "system") applyTheme("system");
    };
    if (mq.addEventListener) mq.addEventListener("change", onMq);
    else if (mq.addListener) mq.addListener(onMq);
  }

  /* ================================================================ 启动 */

  applyTheme(lsGet(S_THEME, "system"));
  loadConvs();
  renderAuthSlot();
  go("home");
  pullRemote();
})();
