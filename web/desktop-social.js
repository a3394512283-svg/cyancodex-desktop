/* ============================================================================
 * web/desktop-social.js —— 广场互动 / 指令详情 / 插件下载
 *
 * 为什么单独一个文件：
 *   desktop.js 已经定稿，而且还有别的任务在并行改它。所有「新增」的能力都写成
 *   独立脚本，靠 electron/main.js 的 DESKTOP_SCRIPTS 顺序注入，谁也不用动谁。
 *   desktop.js 会把公共工具挂到 window.__cc，这里全部复用，不重复实现。
 *
 * 为什么全是「监听 DOM 变化 → 往渲染结果里插 DOM」：
 *   showFeed() / renderLibList() / openPluginsSheet() 的 HTML 是 desktop.js 生成的，
 *   我们不能改它。所以用 MutationObserver 盯着，等它渲染完再补操作条和按钮。
 *   这样即使 desktop.js 以后调整了内部实现，只要类名不变，这里也不会挂。
 *
 * 三个功能都是「只读增强」：
 *   · 广场：点赞 / 评论 / 发动态（写接口只有这三个）
 *   · 指令详情：看完整指令、复制、点赞、收藏、评论、购买
 *   · 插件：只浏览 + 下载，不做「装进游戏」（那需要游戏端配合）
 * ========================================================================== */
(function () {
  "use strict";

  var CC = window.cyancodex;
  if (!CC || !CC.isDesktop) return;              // 网页版没有这个文件，双保险
  var X = window.__cc;
  if (!X) return;                                // desktop.js 必须先生效
  if (window.__ccSocialReady) return;
  window.__ccSocialReady = true;

  var esc = X.esc;
  var toast = X.toast;
  var sheet = X.sheet;
  var mi = X.mi;
  var token = X.token;

  /* ★ 注意：__cc.apiFetch 内部是 fetch(path)，裸路径不会自动拼域名。
     只传 "/api/feed" 会打到本地 127.0.0.1 的静态服务（404），
     所以这里统一包一层，永远带 API_BASE。 */
  function api(path, opts) {
    return X.apiFetch(X.API_BASE + path, opts);
  }

  /* 未登录统一入口：toast + 点顶栏登录按钮（app.js 只在未登录时生成 #btnLoginTop）。
     延迟 400ms 是等 toast 先露个脸，别让登录框盖住提示。 */
  function needLogin(tip) {
    if (token()) return false;
    toast(tip || "请先登录", true);
    var b = document.getElementById("btnLoginTop");
    if (b) setTimeout(function () { b.click(); }, 400);
    return true;
  }

  function num(v) { return Number(v) || 0; }

  /* 服务端 tags 可能是数组，也可能是逗号串，两种都吃 */
  function tagList(t) {
    if (!t) return [];
    if (Object.prototype.toString.call(t) === "[object Array]") return t;
    return String(t).split(/[,，\s]+/).filter(function (s) { return !!s; });
  }

  /* 评论接口的 command_id 用数字更保险（JSON 里字符串/数字后端行为不一致），
     能转数字就转，转不了就原样发。 */
  function idBody(v) {
    var s = String(v == null ? "" : v);
    return /^\d+$/.test(s) ? Number(s) : s;
  }

  function fmtSize(v) {
    var n = Number(v);
    if (v == null || v === "" || isNaN(n) || n <= 0) {
      return v == null || v === "" ? "—" : String(v);
    }
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    return (n / 1048576).toFixed(1) + " MB";
  }

  /* ========================================================================
   * 1. 广场互动
   * ====================================================================== */

  /* 给每张卡片补一条操作条。desktop.js 已经把列表存在 window.__ccFeed 里，
     所以用「卡片在列表中的下标」就能拿回原始数据（含 command_id）。 */
  function decorateFeed() {
    var box = document.getElementById("cc-feed");
    if (!box) return;
    var list = window.__ccFeed || [];
    var items = box.querySelectorAll(".cc-dsk-feed-item");

    for (var i = 0; i < items.length; i++) {
      var el = items[i];
      if (el.getAttribute("data-so") === "1") continue;   // 已经补过，别重复插
      el.setAttribute("data-so", "1");

      var it = list[i] || {};
      var cid = it.command_id ? String(it.command_id) : "";
      var dis = cid ? "" : " disabled";

      var bar = document.createElement("div");
      bar.className = "cc-so-bar";
      bar.innerHTML =
        '<button class="cc-so-act" data-so-like="' + esc(cid) + '"' + dis + ' title="点赞">' +
          '<span class="cc-so-heart">❤</span><b data-so-like-n>' + num(it.like_count) + "</b></button>" +
        '<button class="cc-so-act" data-so-cmt="' + esc(cid) + '"' + dis + ' title="评论">' +
          '<span>💬</span><b data-so-cmt-n>' + num(it.comment_count) + "</b></button>";

      /* ★ 必须绑在 bar 自己身上并 stopPropagation：
         desktop.js 给整张卡片绑了「打开详情」，事件从 bar 冒泡到卡片就会连带触发。
         在 document 上做委托再 stop 已经来不及（卡片的监听先执行）。 */
      bar.addEventListener("click", function (e) {
        e.stopPropagation();
        var likeBtn = e.target.closest("[data-so-like]");
        if (likeBtn) return doFeedLike(likeBtn);
        var cmtBtn = e.target.closest("[data-so-cmt]");
        if (cmtBtn) {
          var id = cmtBtn.getAttribute("data-so-cmt");
          if (!id) return;
          return openFeedComments(id, "");
        }
      });

      el.appendChild(bar);
    }
  }

  function doFeedLike(btn) {
    var cid = btn.getAttribute("data-so-like");
    if (!cid) return;
    if (needLogin("登录后才能点赞")) return;
    if (btn.getAttribute("data-busy") === "1") return;   // 防连点
    btn.setAttribute("data-busy", "1");

    api("/api/commands/" + encodeURIComponent(cid) + "/like", { method: "POST", body: {} })
      .then(function (d) {
        var n = btn.querySelector("[data-so-like-n]");
        // 服务端如果回了新计数就用它，没回就本地 +1（乐观更新）
        var v = d && (d.like_count != null ? d.like_count : d.count);
        n.textContent = v != null ? num(v) : num(n.textContent) + 1;
        btn.classList.add("on");
        toast("已点赞");
      })
      .catch(function (e) { toast("点赞失败：" + e.message, true); })
      .then(function () { btn.setAttribute("data-busy", ""); });
  }

  /* 广场顶部「发动态」：登录后才出现（未登录发不了，接口一定 401） */
  function ensureComposer() {
    var box = document.getElementById("cc-feed");
    if (!box || !box.parentNode) return;
    var old = document.getElementById("cc-so-compose");

    if (!token()) {
      if (old && old.parentNode) old.parentNode.removeChild(old);
      return;
    }
    if (old) return;

    var btn = document.createElement("button");
    btn.id = "cc-so-compose";
    btn.className = "cc-so-compose";
    btn.innerHTML = mi("edit", "currentColor", 17) + "<span>发动态</span>";
    btn.addEventListener("click", openCompose);
    box.parentNode.insertBefore(btn, box);
  }

  function openCompose() {
    if (needLogin("登录后才能发动态")) return;
    sheet("发动态",
      '<div class="cc-dsk-fld"><label>内容</label>' +
      '<textarea id="cc-so-cp" class="cc-dsk-ta" rows="5" maxlength="500" ' +
      'placeholder="分享一条指令、一个坑、或者今天摸到的鱼…"></textarea></div>' +
      '<div class="cc-dsk-sheet-acts">' +
      '<button class="btn sm pri" data-so-post="1">发布</button></div>' +
      '<div class="cc-dsk-hint">发布后会出现在广场，所有人都能看到。</div>',
      function (wrap) {
        var ta = wrap.querySelector("#cc-so-cp");
        if (ta) ta.focus();

        wrap.addEventListener("click", function (e) {
          var b = e.target.closest("[data-so-post]");
          if (!b || b.disabled) return;
          var txt = (ta.value || "").trim();
          if (!txt) return toast("写点什么再发", true);

          b.disabled = true;
          api("/api/feed", { method: "POST", body: { content: txt } })
            .catch(function (err) {
              /* ★ 未验证的假设：接口清单里没写「发动态」到底存不存在。
                 如果 api/feed 不接受 POST（404/405），退回 api/chat —— 它同样收
                 {content}，服务端会顺带落一条动态记录。这条路是猜的，
                 真机上如果两条都 404，说明后端还没做这个功能。 */
              if (err && (err.status === 404 || err.status === 405)) {
                return api("/api/chat", { method: "POST", body: { content: txt } });
              }
              throw err;
            })
            .then(function () {
              toast("已发布");
              var s = document.getElementById("cc-dsk-sheet");
              if (s && s.parentNode) s.parentNode.removeChild(s);
              // showFeed 没导出，点一下底部导航让它自己重渲染，再等 observer 补操作条
              X.clickNav("feed");
            })
            .catch(function (err) {
              b.disabled = false;
              toast("发布失败：" + err.message, true);
            });
        });
      });
  }

  /* ========================================================================
   * 2. 指令详情页
   * ====================================================================== */

  /* 事件委托：指令库卡片由 desktop.js 渲染，卡片上没有绑定，这里统一接管。
     注意放行 desktop.js 自己的「复制」小按钮（data-cp），否则会同时弹详情。 */
  document.addEventListener("click", function (e) {
    var card = e.target.closest(".cc-lib-card");
    if (!card) return;
    if (e.target.closest("[data-cp]")) return;
    var cid = card.getAttribute("data-cid");
    if (!cid) return;                       // 教程卡片（.cc-lib-card.tut）没有 data-cid
    openCommandDetail(cid);
  });

  function openCommandDetail(cid) {
    sheet("指令详情",
      '<div id="cc-so-detail"><div class="cc-dsk-loading">正在加载…</div></div>',
      function (wrap) {
        var box = wrap.querySelector("#cc-so-detail");
        var cur = null;                     // 当前指令对象，操作按钮都靠它

        function render(c) {
          cur = c || {};
          box.innerHTML = detailHtml(cur);
        }

        function reload() {
          api("/api/commands/" + encodeURIComponent(cid)).then(render)
            .catch(function (e) {
              box.innerHTML = '<div class="cc-dsk-empty">加载失败：' + esc(e.message) + "</div>";
            });
        }

        reload();

        wrap.addEventListener("click", function (e) {
          var act = e.target.closest("[data-so-act]");
          if (!act || act.disabled) return;
          var a = act.getAttribute("data-so-act");

          if (a === "copy") {
            var code = (cur && cur.command) || "";
            if (!code) return toast("这条指令还没解锁", true);
            CC.copy(code).then(function () { toast("已复制指令"); });
            return;
          }

          if (a === "like") {
            if (needLogin("登录后才能点赞")) return;
            act.disabled = true;
            api("/api/commands/" + encodeURIComponent(cid) + "/like", { method: "POST", body: {} })
              .then(function (d) {
                var v = d && (d.like_count != null ? d.like_count : d.count);
                cur.like_count = v != null ? num(v) : num(cur.like_count) + 1;
                setStat(box, "like", cur.like_count);
                toast("已点赞");
              })
              .catch(function (err) { toast("点赞失败：" + err.message, true); })
              .then(function () { act.disabled = false; });
            return;
          }

          if (a === "fav") {
            if (needLogin("登录后才能收藏")) return;
            act.disabled = true;
            api("/api/commands/" + encodeURIComponent(cid) + "/favorite", { method: "POST", body: {} })
              .then(function () { toast("已收藏，可在指令库「收藏」里找到"); })
              .catch(function (err) { toast("收藏失败：" + err.message, true); })
              .then(function () { act.disabled = false; });
            return;
          }

          if (a === "buy") {
            if (needLogin("登录后才能购买")) return;
            act.disabled = true;
            api("/api/commands/" + encodeURIComponent(cid) + "/purchase", { method: "POST", body: {} })
              .then(function () { toast("购买成功，正在刷新…"); reload(); })
              .catch(function (err) {
                act.disabled = false;
                toast("购买失败：" + err.message, true);
              });
            return;
          }

          if (a === "cmt") {
            var slot = box.querySelector("#cc-so-dt-cmt");
            if (!slot) return;
            if (slot.getAttribute("data-open") === "1") {   // 再点一次收起
              slot.innerHTML = "";
              slot.setAttribute("data-open", "0");
              return;
            }
            slot.setAttribute("data-open", "1");
            slot.innerHTML = commentsHtml(cid);
            loadComments(slot.querySelector("[data-so-cmtbox]"));
          }
        });
      });
  }

  function setStat(scope, key, v) {
    var el = scope.querySelector('[data-so-st="' + key + '"]');
    if (el) el.textContent = num(v);
  }

  function detailHtml(c) {
    // locked 是「付费且没买过」；已经买过的即使 locked 也应放行，两个字段都看
    var locked = !!c.locked && !c.purchased;
    var tags = tagList(c.tags);

    var h = '<div class="cc-so-dt">';
    h += '<div class="cc-so-dt-tt">' + esc(c.title || "未命名指令") + "</div>";
    if (c.description) h += '<p class="cc-so-dt-desc">' + esc(c.description) + "</p>";

    if (tags.length) {
      h += '<div class="cc-so-tags">' + tags.map(function (t) {
        return "<i>" + esc(t) + "</i>";
      }).join("") + "</div>";
    }

    h += '<div class="cc-so-dt-meta">' +
      "<span>" + esc(c.category || "其他") +
      (c.mc_version ? " · " + esc(c.mc_version) : "") + "</span>" +
      '<span class="r">' + (c.author ? "@" + esc(c.author) : "匿名") + "</span></div>";

    if (locked) {
      h += '<div class="cc-so-locked">' + mi("star", "currentColor", 20) +
        "<span>需要 " + num(c.price) + " 积分购买后查看完整指令</span>" +
        '<button class="btn sm pri" data-so-act="buy">购买</button></div>';
    } else {
      h += '<div class="cc-so-code-hd"><span>指令</span>' +
        '<button class="btn sm" data-so-act="copy">复制</button></div>' +
        '<pre class="cc-so-code">' + esc(c.command || "（这条指令没有内容）") + "</pre>";
    }

    h += '<div class="cc-so-stats">' +
      '<span>❤ <b data-so-st="like">' + num(c.like_count) + "</b></span>" +
      '<span>💬 <b data-so-st="cmt">' + num(c.comment_count) + "</b></span>" +
      '<span>👁 <b data-so-st="view">' + num(c.view_count) + "</b></span></div>";

    h += '<div class="cc-so-acts">' +
      '<button class="btn sm" data-so-act="like">点赞</button>' +
      '<button class="btn sm" data-so-act="fav">收藏</button>' +
      '<button class="btn sm" data-so-act="cmt">查看评论</button></div>';

    h += '<div id="cc-so-dt-cmt"></div>';
    h += "</div>";
    return h;
  }

  /* ========================================================================
   * 评论（广场和指令详情共用一套）
   * ====================================================================== */

  function commentsHtml(cmdId) {
    return '<div class="cc-so-cmt" data-so-cmtbox="' + esc(cmdId) + '">' +
      '<div class="cc-so-cmt-list"><div class="cc-dsk-loading">加载评论…</div></div>' +
      '<div class="cc-so-cmt-bar">' +
      '<input class="cc-so-cmt-in" maxlength="200" placeholder="说点什么…（Ctrl+Enter 发送）">' +
      '<button class="btn sm pri" data-so-send>发送</button></div></div>';
  }

  function loadComments(box) {
    if (!box) return;
    var cmdId = box.getAttribute("data-so-cmtbox");
    var list = box.querySelector(".cc-so-cmt-list");
    api("/api/comments/command/" + encodeURIComponent(cmdId) + "?page=1&size=50")
      .then(function (d) {
        var arr = Object.prototype.toString.call(d) === "[object Array]"
          ? d : ((d && (d.list || d.items)) || []);
        if (!arr.length) {
          list.innerHTML = '<div class="cc-dsk-empty">还没有评论，来说第一句</div>';
          return;
        }
        list.innerHTML = arr.map(function (c) {
          return '<div class="cc-dsk-chat-row"><b>' +
            esc(c.nickname || c.username || "玩家") + "</b>" +
            esc(c.content || "") +
            "<small>" + esc(c.created_at || "") + "</small></div>";
        }).join("");
        list.scrollTop = list.scrollHeight;
      })
      .catch(function (e) {
        list.innerHTML = '<div class="cc-dsk-empty">评论加载失败：' + esc(e.message) + "</div>";
      });
  }

  function sendComment(box) {
    var cmdId = box.getAttribute("data-so-cmtbox");
    var inp = box.querySelector(".cc-so-cmt-in");
    var txt = (inp.value || "").trim();
    if (!txt) return toast("评论不能为空", true);
    if (needLogin("登录后才能评论")) return;

    var btn = box.querySelector("[data-so-send]");
    if (btn.disabled) return;
    btn.disabled = true;

    api("/api/comments", {
      method: "POST",
      body: { command_id: idBody(cmdId), content: txt },
    }).then(function () {
      inp.value = "";
      toast("评论已发布");
      loadComments(box);            // 发完刷新列表，拿到服务端的时间/昵称
    })
      .catch(function (e) { toast("评论失败：" + e.message, true); })
      .then(function () { btn.disabled = false; });
  }

  /* 发评论按钮 / Ctrl+Enter：弹层挂在 body 上，document 级委托最省事 */
  document.addEventListener("click", function (e) {
    var b = e.target.closest("[data-so-send]");
    if (!b) return;
    var box = b.closest("[data-so-cmtbox]");
    if (box) sendComment(box);
  });

  document.addEventListener("keydown", function (e) {
    if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey)) return;
    var t = e.target;
    if (!t || !t.closest) return;
    var inp = t.closest(".cc-so-cmt-in");
    if (!inp) return;
    e.preventDefault();
    var box = inp.closest("[data-so-cmtbox]");
    if (box) sendComment(box);
  });

  /* 广场卡片的 💬 单独开一个弹层 */
  function openFeedComments(cmdId, title) {
    sheet(title ? "评论 · " + title : "评论",
      commentsHtml(cmdId),
      function (wrap) {
        loadComments(wrap.querySelector("[data-so-cmtbox]"));
      });
  }

  /* ========================================================================
   * 3. 插件下载
   * ====================================================================== */

  /* desktop.js 的插件库只有文字，没有 id 也没有按钮。它没把 openPluginsSheet
     导出来，所以这里抢在它后面（同一轮点击结束后）自己重开一个同名弹层：
     sheet() 会先删掉旧弹层，等于整体替换，旧弹层里那次 fetch 的写入会落到
     已经被移除的节点上，无害。 */
  document.addEventListener("click", function (e) {
    if (!e.target.closest('[data-dsk="plugins"]')) return;
    setTimeout(openPluginSheet, 0);
  });

  function openPluginSheet() {
    sheet("插件库",
      '<div id="cc-so-pl"><div class="cc-dsk-loading">加载中…</div></div>' +
      '<div class="cc-dsk-hint">只提供下载：Java 版放进 mods，基岩版导入 .mcpack。' +
      "桌面版不做「装进游戏」，那一步要游戏端配合。</div>",
      function (wrap) {
        var box = wrap.querySelector("#cc-so-pl");

        api("/api/plugins?page=1&size=40")
          .then(function (d) {
            var list = Object.prototype.toString.call(d) === "[object Array]"
              ? d : ((d && (d.list || d.items)) || []);
            if (!list.length) {
              box.innerHTML = '<div class="cc-dsk-empty">还没有插件</div>';
              return;
            }
            box.innerHTML = list.map(function (p) {
              return '<div class="cc-so-pl-row">' +
                '<div class="cc-so-pl-hd"><b>' + esc(p.title || "未命名插件") + "</b>" +
                "<small>v" + esc(p.version || "1.0.0") + " · " +
                (p.platform === "bedrock" ? "基岩版" : "Java 版") + " · " +
                esc(fmtSize(p.size)) + " · 下载 " + num(p.downloads) + "</small></div>" +
                (p.description ? '<p class="cc-so-pl-desc">' + esc(p.description) + "</p>" : "") +
                '<div class="cc-so-pl-ft">' +
                '<span class="cc-so-pl-author">' + (p.author ? "@" + esc(p.author) : "—") + "</span>" +
                '<button class="btn sm pri cc-so-dl" data-so-dl="' + esc(p.id) + '">下载</button>' +
                "</div></div>";
            }).join("");
          })
          .catch(function (e) {
            box.innerHTML = '<div class="cc-dsk-empty">加载失败：' + esc(e.message) + "</div>";
          });

        wrap.addEventListener("click", function (e) {
          var b = e.target.closest("[data-so-dl]");
          if (!b || b.disabled) return;
          downloadPlugin(b.getAttribute("data-so-dl"), b);
        });
      });
  }

  function downloadPlugin(id, btn) {
    btn.disabled = true;
    btn.textContent = "获取中…";

    api("/api/plugins/" + encodeURIComponent(id))
      .then(function (p) {
        var url = (p && (p.download_url || p.url || p.file_url)) || "";
        if (!url) {
          toast("这个插件没有提供下载地址", true);
          btn.disabled = false;
          btn.textContent = "下载";
          return;
        }

        /* ★ 为什么不用 window.cyancodex.saveFile：
           preload 的 saveFile 走 IPC「desktop:save」，主进程是
           fs.writeFileSync(path, String(content), "utf8") —— 只写文本，
           二进制（.mcpack / .mcaddon / .jar）会直接损坏；而且那个保存对话框
           的标题和过滤器都是给 .mcfunction 用的。要真正存二进制得加新 IPC，
           但本次不改 electron/，所以退一步交给系统浏览器下载：
           主进程的 setWindowOpenHandler 会把外链丢给 shell.openExternal，
           下载与落盘由浏览器负责，不需要我们碰文件系统。 */
        window.open(url, "_blank");
        toast("已交给系统浏览器下载");
        btn.disabled = false;
        btn.textContent = "下载";
      })
      .catch(function (e) {
        toast("获取下载地址失败：" + e.message, true);
        btn.disabled = false;
        btn.textContent = "下载";
      });
  }

  /* ========================================================================
   * 启动：盯着 #main 的变化，渲染完就补东西
   * ====================================================================== */

  var scanT = 0;
  function scheduleScan() {
    if (scanT) return;
    scanT = setTimeout(function () { scanT = 0; scan(); }, 80);
  }

  function scan() {
    decorateFeed();
    ensureComposer();
  }

  /* 观察整个 body 而不是只有 #main：登录成功后顶栏重绘、弹层开合都不会碰 #main，
     但「发动态」按钮的显隐要跟着登录状态走。scan() 里没有 #cc-feed 就直接返回，
     开销可以忽略。 */
  new MutationObserver(scheduleScan).observe(document.body, {
    childList: true,
    subtree: true,
  });

  /* 兜底：登录/退出有可能只改 localStorage、不碰 DOM（比如别的脚本直接写 token），
     那样 observer 不会触发。用户下一次点击时补扫一次，成本可以忽略。 */
  document.addEventListener("click", scheduleScan, true);

  scheduleScan();

  console.log("[CyanCodex] 广场互动 / 指令详情 / 插件下载 已加载");
})();
