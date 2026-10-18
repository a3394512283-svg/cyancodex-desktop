/* ============================================================================
 * core/gen.js —— 在 Node 里复用浏览器版的生成器
 *
 * 为什么这么做：`web/gen.js` 是网页版和 App 共用的纯函数实现（零依赖、零 DOM）。
 * CLI 如果重写一份，两边迟早漂移 —— 网页改一条语法、CLI 还是旧的。
 * 这里用 `vm` 把它放进一个空沙箱跑一遍，拿回 `GEN` 对象直接调用。
 *
 * ★ gen.js 里没有任何 window / document 引用（已 grep 确认），所以沙箱是干净的。
 * ========================================================================== */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const GEN_FILE = path.join(__dirname, "..", "web", "gen.js");

let cached = null;

function load() {
  if (cached) return cached;
  const code = fs.readFileSync(GEN_FILE, "utf8");
  const sandbox = { console, Math, JSON, String, Number, Array, Object, isFinite, parseInt, parseFloat };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: GEN_FILE });
  if (!sandbox.GEN) throw new Error("gen.js 没有导出 GEN —— 文件可能被改坏了");
  cached = sandbox.GEN;
  return cached;
}

/* ---- 便捷包装：统一返回字符串数组（一行一条指令） ---- */

function scoreboard(args) {
  return load().scoreboard(args || {});
}

function enumerate(template, variables, limit) {
  return load().enumerate(template, variables || {}, limit || 200);
}

function scroller(args) {
  return load().scroller(args || {});
}

function music(args) {
  return load().music(args || {});
}

function titleraw(target, pos, segments) {
  return load().titleraw(target || "@a", pos || "title", segments || []);
}

function instruments() {
  const g = load();
  return g.INSTRUMENTS.map((k) => ({ key: k, name: g.INST_CN[k] || k }));
}

function colors() {
  return Object.keys(load().COLORS);
}

module.exports = {
  load, GEN_FILE,
  scoreboard, enumerate, scroller, music, titleraw,
  instruments, colors,
};
