/* ============================================================================
 * core/api.js —— 与服务端通信（零依赖，只用 Node 内置 http/https）
 *
 * 三类接口：
 *   1. 账号：官方 cyancodex.cn 的 /api/auth/*（与网页版一致，浏览器/Node 直连）
 *   2. 免费 AI：自建服务器 /api/v1/ai/chat/completions（SSE 流式）
 *   3. 指令库 / 版本：自建服务器 /api/v1/cmds、/api/v1/app/version
 *
 * ★ 所有请求都走 `request()`，统一处理：超时、gzip、重定向、JSON 解析。
 *   不引第三方库是刻意的 —— 桌面版要能单文件打包，少一个依赖少一个坑。
 * ========================================================================== */
"use strict";

const http = require("http");
const https = require("https");
const zlib = require("zlib");
const { URL } = require("url");
const C = require("./config");

const OFFICIAL = "https://cyancodex.cn";
const UA = "CyanCodex-Desktop/" + C.VERSION + " (+https://cyancodex.bluestudio.cn)";

function baseUrl() {
  const cfg = C.load();
  return String(cfg.api || "").replace(/\/+$/, "");
}

/**
 * 发一个请求，拿完整响应。
 * @returns {Promise<{status:number, headers:object, body:Buffer}>}
 */
function request(url, options) {
  options = options || {};
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error("地址不合法: " + url)); }
    const mod = u.protocol === "http:" ? http : https;

    const headers = Object.assign({
      "User-Agent": UA,
      "Accept-Encoding": "gzip, deflate",
    }, options.headers || {});

    let bodyBuf = null;
    if (options.body !== undefined && options.body !== null) {
      bodyBuf = Buffer.isBuffer(options.body) ? options.body : Buffer.from(String(options.body), "utf8");
      headers["Content-Length"] = bodyBuf.length;
    }

    const req = mod.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === "http:" ? 80 : 443),
      path: u.pathname + u.search,
      method: options.method || (bodyBuf ? "POST" : "GET"),
      headers,
      timeout: options.timeout || 60000,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        let buf = Buffer.concat(chunks);
        const enc = String(res.headers["content-encoding"] || "").toLowerCase();
        try {
          if (enc === "gzip") buf = zlib.gunzipSync(buf);
          else if (enc === "deflate") buf = zlib.inflateSync(buf);
          else if (enc === "br" && zlib.brotliDecompressSync) buf = zlib.brotliDecompressSync(buf);
        } catch (_) { /* 解压失败就用原始字节 */ }
        resolve({ status: res.statusCode || 0, headers: res.headers, body: buf });
      });
    });

    req.on("timeout", () => {
      req.destroy(new Error("请求超时（" + Math.round((options.timeout || 60000) / 1000) + "s）"));
    });
    req.on("error", reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

function parseJson(buf) {
  try { return JSON.parse(buf.toString("utf8")); } catch (_) { return null; }
}

async function getJson(url, headers) {
  const r = await request(url, { headers: Object.assign({ Accept: "application/json" }, headers || {}) });
  const j = parseJson(r.body);
  if (r.status < 200 || r.status >= 300) {
    const msg = (j && (j.message || j.error || j.msg)) || ("HTTP " + r.status);
    const err = new Error(msg);
    err.status = r.status;
    err.data = j;
    throw err;
  }
  if (j === null) throw new Error("服务端返回的不是 JSON（HTTP " + r.status + "）");
  return j;
}

/* ------------------------------------------------------------------ 账号 */

async function login(username, password) {
  const r = await request(OFFICIAL + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ username, password }),
    timeout: 30000,
  });
  const j = parseJson(r.body) || {};
  if (r.status < 200 || r.status >= 300 || j.ok === false) {
    throw new Error(j.message || j.error || ("登录失败（HTTP " + r.status + "）"));
  }
  const data = j.data || j;
  if (!data.token) throw new Error("登录成功但没拿到 token，接口可能变了");
  const auth = {
    token: data.token,
    user: data.user || null,
    api: baseUrl(),
    ts: Date.now(),
  };
  C.saveAuth(auth);
  return auth;
}

async function me(token) {
  const t = token || (C.loadAuth() || {}).token;
  if (!t) throw new Error("未登录，先运行：cyancodex login <用户名> <密码>");
  const j = await getJson(OFFICIAL + "/api/auth/me", { Authorization: "Bearer " + t });
  return j.data || j;
}

function token() {
  const a = C.loadAuth();
  return a ? a.token : null;
}

function currentUser() {
  const a = C.loadAuth();
  return a ? a.user : null;
}

/* --------------------------------------------------------------- 指令库 */

async function categories() {
  const j = await getJson(baseUrl() + "/api/v1/cmds/meta/categories");
  return j.data || j.categories || j;
}

async function cmds(params) {
  params = params || {};
  const q = new URLSearchParams();
  if (params.q) q.set("q", params.q);
  if (params.cat) q.set("cat", params.cat);
  if (params.page) q.set("page", String(params.page));
  if (params.size) q.set("size", String(params.size));
  const qs = q.toString();
  const j = await getJson(baseUrl() + "/api/v1/cmds" + (qs ? "?" + qs : ""));
  return j.data || j;
}

async function cmd(id) {
  const j = await getJson(baseUrl() + "/api/v1/cmds/" + encodeURIComponent(id));
  return j.data || j;
}

/* --------------------------------------------------------------- 版本 */

async function version() {
  const j = await getJson(baseUrl() + "/api/v1/app/version");
  return j.data || j;
}

async function appConfig() {
  const j = await getJson(baseUrl() + "/api/v1/app/config");
  return j.data || j;
}

/* ------------------------------------------------------------------ AI */

/**
 * 流式对话。onDelta 每收到一段文字调用一次。
 * 返回完整文本。
 */
async function chat(opts) {
  opts = opts || {};
  const t = opts.token || token();
  if (!t) throw new Error("未登录。免费 AI 通道需要账号，先运行：cyancodex login <用户名> <密码>");

  const payload = {
    model: "CyanFree",
    stream: true,
    mode: opts.mode || "chat",
    messages: opts.messages || [],
  };

  const url = baseUrl() + "/api/v1/ai/chat/completions";
  const u = new URL(url);
  const mod = u.protocol === "http:" ? http : https;
  const bodyBuf = Buffer.from(JSON.stringify(payload), "utf8");

  return new Promise((resolve, reject) => {
    const req = mod.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === "http:" ? 80 : 443),
      path: u.pathname + u.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "X-Cyan-Web": "1",
        Authorization: "Bearer " + t,
        "Content-Length": bodyBuf.length,
        "User-Agent": UA,
      },
      timeout: 180000,
    }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const j = parseJson(Buffer.concat(chunks));
          const msg = (j && (j.message || j.error)) || ("AI 接口返回 HTTP " + res.statusCode);
          const err = new Error(msg);
          err.status = res.statusCode;
          reject(err);
        });
        return;
      }

      let acc = "";
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).replace(/\r$/, "");
          buf = buf.slice(idx + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          let obj;
          try { obj = JSON.parse(data); } catch (_) { continue; }
          const c = obj.choices && obj.choices[0];
          const piece =
            (c && c.delta && c.delta.content) ||
            (c && c.message && c.message.content) ||
            obj.delta || "";
          if (piece) { acc += piece; if (opts.onDelta) opts.onDelta(piece); }
        }
      });
      res.on("end", () => resolve(acc));
      res.on("error", reject);
    });

    req.on("timeout", () => req.destroy(new Error("AI 请求超时（180s）")));
    req.on("error", reject);
    req.write(bodyBuf);
    req.end();
  });
}

/* ------------------------------------------------------------------ 分享 */

async function share(payload) {
  const t = token();
  const r = await request(baseUrl() + "/api/v1/share", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(t ? { Authorization: "Bearer " + t } : {}),
    },
    body: JSON.stringify(payload || {}),
  });
  const j = parseJson(r.body);
  if (r.status < 200 || r.status >= 300) throw new Error((j && j.message) || ("HTTP " + r.status));
  return j;
}

module.exports = {
  OFFICIAL, baseUrl, request,
  login, me, token, currentUser,
  categories, cmds, cmd,
  version, appConfig,
  chat, share,
};
