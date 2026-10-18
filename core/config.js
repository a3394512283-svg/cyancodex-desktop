/* ============================================================================
 * core/config.js —— 本地配置与路径
 *
 * 配置目录优先级：
 *   1. 环境变量 CYANCODEX_HOME
 *   2. %APPDATA%\CyanCodex        （Electron / Windows 常规位置）
 *   3. ~/.cyancodex               （兜底，非 Windows 或 APPDATA 缺失）
 *
 * ★ 令牌单独存 auth.json，且写入后立刻 chmod 600（Windows 上是 no-op，
 *   但 Unix 上有意义）。config.json 里绝不存密码。
 * ========================================================================== */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const VERSION = require("../package.json").version;

/* 默认远程服务：与网页版同一个后端，账号体系统一 */
const DEFAULT_API = "https://cyancodex.bluestudio.cn";

function homeDir() {
  if (process.env.CYANCODEX_HOME) return path.resolve(process.env.CYANCODEX_HOME);
  if (process.env.APPDATA) return path.join(process.env.APPDATA, "CyanCodex");
  return path.join(os.homedir(), ".cyancodex");
}

const HOME = homeDir();
const CONFIG_FILE = path.join(HOME, "config.json");
const AUTH_FILE = path.join(HOME, "auth.json");
const HISTORY_FILE = path.join(HOME, "history.jsonl");

const DEFAULTS = {
  api: DEFAULT_API,
  theme: "system",
  language: "zh-CN",
  // GUI 窗口
  window: { width: 1280, height: 840, x: null, y: null, maximized: false },
  // 生成器最近一次的参数，方便 GUI 恢复
  lastGen: null,
  // 本地服务端口，0 = 随机
  port: 0,
};

function ensureDir() {
  if (!fs.existsSync(HOME)) fs.mkdirSync(HOME, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, obj, mode) {
  ensureDir();
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  fs.renameSync(tmp, file);
  if (mode) {
    try { fs.chmodSync(file, mode); } catch (_) { /* Windows 上是 no-op */ }
  }
}

function load() {
  const raw = readJson(CONFIG_FILE, {});
  return Object.assign({}, DEFAULTS, raw, {
    window: Object.assign({}, DEFAULTS.window, raw.window || {}),
  });
}

function save(patch) {
  const next = Object.assign(load(), patch || {});
  writeJson(CONFIG_FILE, next);
  return next;
}

function get(key) {
  const cfg = load();
  if (!key) return cfg;
  return key.split(".").reduce((o, k) => (o == null ? o : o[k]), cfg);
}

function set(key, value) {
  const cfg = load();
  const parts = String(key).split(".");
  let cur = cfg;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== "object" || cur[parts[i]] === null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
  writeJson(CONFIG_FILE, cfg);
  return cfg;
}

/* ---------------------------------------------------------------- 登录态 */

function loadAuth() {
  return readJson(AUTH_FILE, null);
}

function saveAuth(auth) {
  if (!auth) {
    try { fs.unlinkSync(AUTH_FILE); } catch (_) { /* ignore */ }
    return null;
  }
  writeJson(AUTH_FILE, auth, 0o600);
  return auth;
}

function clearAuth() {
  return saveAuth(null);
}

function isLoggedIn() {
  const a = loadAuth();
  return !!(a && a.token);
}

/* ---------------------------------------------------------------- 历史记录 */
/* 每次 CLI 生成都记一行，方便 `cyancodex history` 回看与重新导出 */

function appendHistory(entry) {
  ensureDir();
  const line = JSON.stringify(Object.assign({ ts: Date.now() }, entry));
  fs.appendFileSync(HISTORY_FILE, line + "\n", "utf8");
}

function readHistory(limit) {
  try {
    const lines = fs.readFileSync(HISTORY_FILE, "utf8").trim().split("\n").filter(Boolean);
    const out = lines.slice(-(limit || 20)).map((l) => {
      try { return JSON.parse(l); } catch (_) { return null; }
    }).filter(Boolean);
    return out.reverse();
  } catch (_) {
    return [];
  }
}

module.exports = {
  VERSION, HOME, CONFIG_FILE, AUTH_FILE, HISTORY_FILE, DEFAULTS,
  ensureDir, load, save, get, set,
  loadAuth, saveAuth, clearAuth, isLoggedIn,
  appendHistory, readHistory,
};
