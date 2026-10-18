/* ============================================================================
 * server/index.js —— 本地 HTTP 服务
 *
 * 职责：
 *   1. 托管 web/ 里的前端（就是网页版那一套，桌面端零重写）
 *   2. 把 /api/v1/* 反向代理到远程服务端（同源，绕开 CORS 与 CSP）
 *   3. 提供 /desktop/* 桌面专用资源
 *
 * ★ 代理必须**流式**转发：AI 对话是 SSE，缓冲整包会让「正在思考」卡到结束才出字。
 * ★ 监听 127.0.0.1，不监听 0.0.0.0 —— 这是个只给本机用的服务，
 *   暴露到局域网等于把免费 AI 额度开放给同网段所有人。
 * ========================================================================== */
"use strict";

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const C = require("../core/config");

const WEB_DIR = path.join(__dirname, "..", "web");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/* 允许的前端文件白名单（都是字面量，路径穿越结构性地不可能发生） */
const ASSETS = {
  "/web": "app.html",
  "/web/": "app.html",
  "/web/app.js": "app.js",
  "/web/app.html": "app.html",
  "/web/style.css": "style.css",
  "/web/gen.js": "gen.js",
  "/web/home.js": "home.js",
  "/web/manifest.json": "manifest.json",
  "/web/icon-32.png": "icon-32.png",
  "/web/icon-180.png": "icon-180.png",
  "/web/icon-192.png": "icon-192.png",
  "/web/icon-512.png": "icon-512.png",
  "/favicon.ico": "favicon.ico",
  "/apple-touch-icon.png": "icon-180.png",
  "/": "index.html",
  "/index.html": "index.html",
};

function sendFile(res, name, extraHeaders) {
  const file = path.join(WEB_DIR, name);
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("404 —— 文件缺失：" + name);
    }
    /* ★ 桌面版不该叫「网页版」。
       前端 desktop.js 里也改过一次，但那个依赖注入时序，实测偶尔会被
       后续渲染覆盖回去。这里在**服务端出字节之前**就换掉，最稳。 */
    if (name === "app.html") {
      const s = buf.toString("utf8")
        .replace("<title>网页版 — CyanCodex</title>", "<title>CyanCodex 桌面版</title>")
        .replace(/<small>网页版<\/small>/, "<small>桌面版</small>");
      buf = Buffer.from(s, "utf8");
    }
    const ext = path.extname(name).toLowerCase();
    res.writeHead(200, Object.assign({
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    }, extraHeaders || {}));
    res.end(buf);
  });
}

function json(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

/**
 * 反向代理到远程服务端。
 * 流式 pipe，不缓冲 —— SSE 才能一段一段出。
 */
function proxy(req, res, targetBase) {
  let u;
  try { u = new URL(targetBase); } catch (_) { return json(res, 500, { ok: false, message: "服务端地址配置有误" }); }

  const mod = u.protocol === "http:" ? http : https;
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase();
    if (lk === "host" || lk === "connection" || lk === "content-length") continue;
    headers[k] = v;
  }
  // 不让上游压缩：我们直接透传字节，压缩头由上游给、浏览器自己解
  headers["host"] = u.host;
  headers["accept-encoding"] = "identity";

  const preq = mod.request({
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port || (u.protocol === "http:" ? 80 : 443),
    path: req.url,               // 原样带上 path + query
    method: req.method,
    headers,
    timeout: 180000,
  }, (pres) => {
    res.writeHead(pres.statusCode || 502, pres.headers);
    pres.pipe(res);              // ★ 流式
  });

  preq.on("timeout", () => {
    preq.destroy();
    if (!res.headersSent) json(res, 504, { ok: false, message: "上游超时" });
  });
  preq.on("error", (e) => {
    if (!res.headersSent) json(res, 502, { ok: false, message: "连不上服务端：" + e.message });
    else try { res.end(); } catch (_) { /* ignore */ }
  });

  req.pipe(preq);                // ★ 请求体也流式转发
}

function createServer() {
  return http.createServer((req, res) => {
    const url = req.url || "/";
    const pathname = url.split("?")[0];

    // 1) 远程 API —— 同源代理
    if (pathname.startsWith("/api/")) {
      return proxy(req, res, C.load().api);
    }

    // 2) 桌面端自检
    if (pathname === "/desktop/info") {
      return json(res, 200, {
        ok: true,
        version: C.VERSION,
        api: C.load().api,
        home: C.HOME,
        loggedIn: C.isLoggedIn(),
        user: C.currentUser(),
        platform: process.platform,
        electron: process.versions.electron || null,
        node: process.versions.node,
      });
    }

    // 3) 静态资源
    const name = ASSETS[pathname];
    if (name) {
      const extra = {};
      // 前端页面允许内联样式/脚本（网页版本身就这么写的），但只对自己
      if (name.endsWith(".html")) {
        extra["Content-Security-Policy"] =
          "default-src 'self'; " +
          "script-src 'self' 'unsafe-inline'; " +
          "style-src 'self' 'unsafe-inline'; " +
          "img-src 'self' data: https:; " +
          "connect-src 'self' https: http://127.0.0.1:* http://localhost:*; " +
          "font-src 'self' data:; " +
          "frame-ancestors 'none'";
      }
      return sendFile(res, name, extra);
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("404 Not Found: " + pathname);
  });
}

/**
 * 启动服务。
 * @param {number} port 0 = 随机可用端口
 * @returns {Promise<{server, port, url}>}
 */
function start(port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(port === undefined ? (C.load().port || 0) : port, "127.0.0.1", () => {
      const p = server.address().port;
      resolve({ server, port: p, url: "http://127.0.0.1:" + p + "/web" });
    });
  });
}

module.exports = { createServer, start, WEB_DIR };
