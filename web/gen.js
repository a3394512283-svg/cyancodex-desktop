/* ==========================================================================
   CyanCodex 二改版 · 网页版生成器
   --------------------------------------------------------------------------
   纯前端、零依赖：所有指令在这里拼装，不经过服务端，不上传任何内容。
   输出目标是《Minecraft》**基岩版**（Bedrock），不是 Java 版 —— 两者语法不同，
   这里刻意不使用 /data、NBT 花括号这些 Java 专有写法。

   对外暴露 GEN 一个对象，其余都是内部函数。
   ========================================================================== */
var GEN = (function () {
  "use strict";

  /* 16 种音符盒乐器 —— 基岩版 note.<instrument> 音效名，顺序与游戏一致 */
  var INSTRUMENTS = [
    "harp", "bd", "snare", "hat", "bass", "flute", "bell", "guitar",
    "chime", "xylophone", "iron_xylophone", "cow_bell", "didgeridoo",
    "bit", "banjo", "pling"
  ];
  var INST_CN = {
    harp: "钢琴", bd: "大鼓", snare: "小鼓", hat: "击鼓沿", bass: "贝斯",
    flute: "长笛", bell: "铃铛", guitar: "吉他", chime: "钟琴",
    xylophone: "木琴", iron_xylophone: "钢片琴", cow_bell: "牛铃",
    didgeridoo: "迪吉里杜管", bit: "比特", banjo: "班卓琴", pling: "通电声"
  };

  var COLORS = {
    "白色": "white", "黄色": "yellow", "金色": "gold", "红色": "red",
    "绿色": "green", "深绿": "dark_green", "蓝色": "blue", "深蓝": "dark_blue",
    "天蓝": "aqua", "紫色": "light_purple", "深紫": "dark_purple",
    "灰色": "gray", "深灰": "dark_gray", "黑色": "black"
  };

  /* ---------------------------------------------------------------- 工具 */

  /* 计分项/标签名只允许 ASCII 安全字符 —— 中文或空格会让 /scoreboard 直接报错。
     长度压到 16（基岩版计分项名上限就是 16 字符）。 */
  function safeName(s, dflt) {
    var v = String(s || "").replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 16);
    return v || dflt || "sb";
  }

  /* 放进 JSON 字符串里的转义：反斜杠、双引号、换行、制表 */
  function jesc(s) {
    return String(s == null ? "" : s)
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "")
      .replace(/\t/g, "\\t");
  }

  /* 放进指令参数的双引号字符串（如 objectives add 的显示名） */
  function qesc(s) {
    return String(s == null ? "" : s).replace(/"/g, '\\"').replace(/\n/g, " ");
  }

  /* 音符 -> playsound 的 pitch。基岩版 0.5 为基准，每 12 个半音翻一倍，
     可用范围 0-24（0.5 ~ 2.0）。 */
  function pitchOf(note) {
    var n = Math.max(0, Math.min(24, parseInt(note, 10) || 0));
    return (0.5 * Math.pow(2, n / 12)).toFixed(3);
  }

  /* 数值兜底：非数字 / 空 -> 默认值 */
  function num(v, dflt) {
    var n = Number(v);
    return isFinite(n) ? n : dflt;
  }

  /* ---------------------------------------------------- 一、T显 / 计分板 */

  /*
    两种模式：
      side  —— 侧边栏计分板：建计分项 + setdisplay sidebar + 给玩家设分
      tdisplay —— T 显字幕：建计分项 + setdisplay sidebar + 每行用 titleraw
                  把「前缀 + 计分板变量 + 后缀」拼成一行（这就是"T显"的核心）
    args = {
      mode: "side" | "tdisplay",
      objective, displayName, slot,
      entries: [{player, value}],
      tlines: [{prefix, objective, suffix}],
      tpos: "title" | "subtitle" | "actionbar"
    }
  */
  function scoreboard(args) {
    args = args || {};
    var out = [];
    var obj = safeName(args.objective, "sb");
    var disp = qesc(args.displayName || obj);

    out.push('/scoreboard objectives add ' + obj + ' dummy "' + disp + '"');

    if (args.mode === "tdisplay") {
      out.push("/scoreboard objectives setdisplay sidebar " + obj);
      var lines = (args.tlines || []).filter(function (l) {
        return l && String(l.objective || "").trim();
      });
      if (!lines.length) {
        out.push("# 提示：至少填一行的计分项名，才能生成 T 显");
      }
      lines.forEach(function (l) {
        var parts = [];
        if (l.prefix && String(l.prefix).trim()) {
          parts.push('{"text":"' + jesc(l.prefix) + '"}');
        }
        parts.push('{"score":{"name":"@s","objective":"' +
          safeName(l.objective, "sb") + '"}}');
        if (l.suffix && String(l.suffix).trim()) {
          parts.push('{"text":"' + jesc(l.suffix) + '"}');
        }
        out.push('/titleraw @a ' + (args.tpos || "title") +
          ' {"rawtext":[' + parts.join(",") + "]}");
      });
    } else {
      var slot = String(args.slot || "").trim();
      if (slot) out.push("/scoreboard objectives setdisplay " + slot + " " + obj);
      (args.entries || []).forEach(function (e) {
        if (!e || !String(e.player || "").trim()) return;
        out.push("/scoreboard players set " + String(e.player).trim() +
          " " + obj + " " + num(e.value, 0));
      });
    }
    return out;
  }

  /* ------------------------------------------------------- 二、穷举批量 */

  /*
    模板里写 {变量名}，variables 是 {变量名: [候选值...]}，做笛卡尔积展开。
    limit 上限 5000（再多浏览器也会卡，且实际粘贴也没意义）。
  */
  function enumerate(template, variables, limit) {
    if (!template || !variables) return [];
    var keys = Object.keys(variables).filter(function (k) {
      return (variables[k] || []).filter(function (v) { return v !== ""; }).length > 0;
    });
    if (!keys.length) return [];

    var combos = [{}];
    keys.forEach(function (k) {
      var vals = variables[k].filter(function (v) { return v !== ""; });
      var next = [];
      combos.forEach(function (base) {
        vals.forEach(function (v) {
          var o = {};
          for (var kk in base) if (Object.prototype.hasOwnProperty.call(base, kk)) o[kk] = base[kk];
          o[k] = v;
          next.push(o);
        });
      });
      combos = next;
    });

    var cap = Math.max(1, Math.min(5000, num(limit, 100)));
    var out = [];
    for (var i = 0; i < combos.length && out.length < cap; i++) {
      var s = String(template);
      for (var k2 in combos[i]) {
        if (!Object.prototype.hasOwnProperty.call(combos[i], k2)) continue;
        s = s.split("{" + k2 + "}").join(combos[i][k2]);
      }
      s = s.replace(/^\s+|\s+$/g, "");
      if (s) out.push(s);
    }
    return out;
  }

  /* ------------------------------------------------------- 三、滚动字幕 */

  /*
    轮播模式（默认）：计分板当节拍器，每 tick 自增 1，用 execute if score 匹配
      命中某一行就 titleraw 显示该行，到末尾复位。
    逐字横幅模式（banner）：一排盔甲架，每个顶着一个字，靠命名牌显示。
  */
  function scroller(args) {
    args = args || {};
    var text = String(args.text || "CyanCodex");
    var color = COLORS[args.color] || args.color || "gold";
    var out = [];

    if (args.mode === "banner") {
      var gap = num(args.gap, 2);
      var x = num(args.x, 0), y = num(args.y, 64), z = num(args.z, 0);
      out.push("# 逐字横幅：每个字一个盔甲架（盔甲架名字会显示出来）");
      var chars = Array.from(text);
      var placed = 0;
      chars.forEach(function (ch) {
        if (ch === " ") { placed++; return; }
        out.push('/summon armor_stand ' + (x + placed * gap) + " " + y + " " + z +
          ' "' + jesc(ch) + '"');
        placed++;
      });
      out.push("# 隐藏盔甲架本体（可选，执行一次即可）：");
      out.push("/effect @e[type=armor_stand] invisibility 999999 1 true");
      return out;
    }

    var lines = text.split(/\r?\n/).map(function (s) { return s.trim(); })
      .filter(function (s) { return s; });
    if (!lines.length) return [];

    var obj = "cyx_scroll";
    var max = lines.length + 1;
    out.push('# 滚动字幕（' + lines.length + ' 行轮播）');
    out.push('/scoreboard objectives add ' + obj + ' dummy "滚动字幕"');
    out.push("/scoreboard players set @a " + obj + " 0");
    out.push("");
    out.push("# [循环 / 保持开启] 节拍器，每 tick 走一格：");
    out.push("/execute as @a run scoreboard players add @s " + obj + " 1");
    out.push("");
    lines.forEach(function (line, i) {
      var json = '{"rawtext":[{"text":"' + jesc(line) + '","color":"' + color + '"}]}';
      out.push("# [链式 / 条件开启] 第 " + (i + 1) + " 行：");
      out.push("/execute as @a if score @s " + obj + " matches " + (i + 1) +
        " run titleraw @a actionbar " + json);
    });
    out.push("");
    out.push("# [链式 / 条件开启] 走到末尾后复位：");
    out.push("/execute as @a if score @s " + obj + " matches " + max +
      " run scoreboard players set @s " + obj + " 0");
    return out;
  }

  /* ------------------------------------------------------- 四、音乐生成 */

  /*
    events = [{tick, instrument, note}]
    tick 是节拍序号（0 起），每个 tick 一帧，可以同一 tick 放多个音（和弦）。
  */
  function music(args) {
    args = args || {};
    var events = args.events || [];
    if (!events.length) return ["# 请先在音符网格里点几下，放上音符"];

    var obj = "cyx_music";
    var maxTick = 0;
    events.forEach(function (e) { maxTick = Math.max(maxTick, num(e.tick, 0)); });
    maxTick += 1;

    var out = [];
    out.push("# 音符盒音乐（" + events.length + " 个音符，共 " + maxTick + " 拍）");
    out.push('/scoreboard objectives add ' + obj + ' dummy "音乐"');
    out.push("/scoreboard players set @a " + obj + " 0");
    out.push("");
    out.push("# [循环 / 保持开启] 节拍器：");
    out.push("/execute as @a run scoreboard players add @s " + obj + " 1");
    out.push("");

    var byTick = {};
    events.forEach(function (e) {
      var t = num(e.tick, 0);
      (byTick[t] = byTick[t] || []).push(e);
    });

    Object.keys(byTick).map(Number).sort(function (a, b) { return a - b; })
      .forEach(function (t) {
        out.push("# [链式 / 条件开启] 第 " + t + " 拍：");
        byTick[t].forEach(function (e) {
          var inst = INSTRUMENTS.indexOf(e.instrument) >= 0 ? e.instrument : "harp";
          out.push("/execute as @a if score @s " + obj + " matches " + t +
            " run playsound note." + inst + " @s ~ ~ ~ 1 " + pitchOf(e.note));
        });
      });

    if (args.loop) {
      out.push("");
      out.push("# [链式 / 条件开启] 循环复位：");
      out.push("/execute as @a if score @s " + obj + " matches " + maxTick +
        " run scoreboard players set @s " + obj + " 0");
    }
    return out;
  }

  /* --------------------------------------------------- 五、T显 JSON 拼装 */

  /*
    segments = [{kind:"text"|"selector"|"score"|"color"|"translate", ...}]
    生成一行 titleraw 指令（基岩版 rawtext 支持 text/selector/score/translate）。
  */
  function titleraw(target, pos, segments) {
    var arr = (segments || []).map(function (s) {
      s = s || {};
      if (s.kind === "selector") {
        return { selector: String(s.selector || "@p") };
      }
      if (s.kind === "score") {
        return { score: { name: String(s.name || "@s"), objective: safeName(s.obj, "sb") } };
      }
      if (s.kind === "translate") {
        return { translate: String(s.key || "item.apple.name") };
      }
      if (s.kind === "color") {
        return { text: String(s.text || ""), color: String(s.color || "white") };
      }
      return { text: String(s.text || "") };
    });
    if (!arr.length) arr = [{ text: "" }];
    return "/titleraw " + String(target || "@a") + " " + String(pos || "title") +
      ' {"rawtext":' + JSON.stringify(arr) + "}";
  }

  /* --------------------------------------------------------- 对外接口 */
  return {
    INSTRUMENTS: INSTRUMENTS,
    INST_CN: INST_CN,
    COLORS: COLORS,
    pitchOf: pitchOf,
    scoreboard: scoreboard,
    enumerate: enumerate,
    scroller: scroller,
    music: music,
    titleraw: titleraw
  };
})();
