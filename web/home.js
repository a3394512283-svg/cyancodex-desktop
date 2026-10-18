/* ==========================================================================
   CyanCodex 二改版 · 主页脚本
   --------------------------------------------------------------------------
   主页只做两件事：
     1. h1 里那个功能词循环打字（打字 → 停 1.6s → 逐字删除 → 下一个）
     2. 顶栏滚动时加一条下边框 + 阴影

   为什么主页原来"零 JS"现在又有 JS 了：
     纯 CSS 也能做打字机，但多句**循环**要给每一句单独算关键帧时间轴
     （每句字数不同、删除耗时不同），改一个字就得重算一遍，维护成本太高。
     改成外链 JS 之后文案就是一个数组，改词不用碰样式。
     CSP 相应放开 script-src 'self' —— 仍然禁止内联脚本，风险没有实质变化。
   ========================================================================== */
(function () {
  "use strict";

  /* ------------------------------------------------------------ 打字机 */
  var WORDS = ["一条指令", "一个计分板", "一段 T 显", "一首曲子", "一个插件"];
  var TYPE = 90;    // 每字打字间隔
  var DEL = 40;     // 每字删除间隔
  var HOLD = 1600;  // 打完停留
  var GAP = 260;    // 删空后到下一次打字的间隔

  var el = document.getElementById("tw");
  if (el) {
    var reduced = window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (reduced) {
      // 尊重系统设置：不动的用户直接看第一句
      el.textContent = WORDS[0];
    } else {
      var i = 0;        // 当前词下标
      var n = 0;        // 当前已显示字符数
      var deleting = false;

      var tick = function () {
        var w = WORDS[i];

        if (!deleting) {
          n++;
          el.textContent = w.slice(0, n);
          if (n >= w.length) {
            deleting = true;
            return setTimeout(tick, HOLD);
          }
          return setTimeout(tick, TYPE);
        }

        n--;
        el.textContent = w.slice(0, n);
        if (n <= 0) {
          deleting = false;
          i = (i + 1) % WORDS.length;
          return setTimeout(tick, GAP);
        }
        return setTimeout(tick, DEL);
      };

      // 首屏先留半秒空着，让标题自然出现，不要一进来就在闪
      setTimeout(tick, 420);
    }
  }

  /* ------------------------------------------------------- 顶栏滚动状态 */
  var nav = document.querySelector(".nav");
  if (nav) {
    var onScroll = function () {
      nav.classList.toggle("scrolled", window.scrollY > 8);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }
})();
