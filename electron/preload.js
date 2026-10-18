/* ============================================================================
 * electron/preload.js —— 上下文隔离下的安全桥
 *
 * 只暴露必要的方法，不把 ipcRenderer 整个丢给页面。
 * 页面侧通过 window.cyancodex 判断自己跑在桌面壳里还是浏览器里。
 * ========================================================================== */
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cyancodex", {
  isDesktop: true,
  platform: process.platform,

  /* ---- 基础 ---- */
  info: () => ipcRenderer.invoke("desktop:info"),
  copy: (text) => ipcRenderer.invoke("desktop:copy", text),
  notify: (title, body) => ipcRenderer.invoke("desktop:notify", title, body),

  /* ---- 文件 ---- */
  saveFile: (defaultName, content) => ipcRenderer.invoke("desktop:save", defaultName, content),
  openFile: () => ipcRenderer.invoke("desktop:open"),

  /* ---- 本地数据（替代 localStorage，可备份可同步） ---- */
  store: {
    get: (name, key, dflt) => ipcRenderer.invoke("store:get", name, key, dflt),
    set: (name, key, value) => ipcRenderer.invoke("store:set", name, key, value),
    all: (name) => ipcRenderer.invoke("store:all", name),
    clear: (name) => ipcRenderer.invoke("store:clear", name),
    flush: () => ipcRenderer.invoke("store:flush"),
  },

  /* ---- 备份 / 恢复 ---- */
  backup: () => ipcRenderer.invoke("desktop:backup"),
  restore: () => ipcRenderer.invoke("desktop:restore"),

  /* ---- 本地项目（datapack）管理 ----
   * ★ 只有 pickDir 能让用户「授权」一个根目录，主进程记住它；
   *   后面几个方法的路径参数都会被主进程钉在这个根目录里，越界直接拒绝。 */
  projectPickDir: () => ipcRenderer.invoke("project:pick-dir"),
  projectScan: (root) => ipcRenderer.invoke("project:scan", root),
  projectRead: (p) => ipcRenderer.invoke("project:read", p),
  projectWrite: (p, content) => ipcRenderer.invoke("project:write", p, content),
  projectNewFile: (dir, name) => ipcRenderer.invoke("project:new-file", dir, name),
  projectZip: (dir, out) => ipcRenderer.invoke("project:zip", dir, out),

  /* ---- 系统设置 ---- */
  autostart: (on) => ipcRenderer.invoke("desktop:autostart", on),
  minimizeToTray: (on) => ipcRenderer.invoke("desktop:minimize-to-tray", on),
  openConfigDir: () => ipcRenderer.invoke("desktop:open-home"),
  openDataDir: () => ipcRenderer.invoke("desktop:open-data"),
  hide: () => ipcRenderer.invoke("desktop:hide"),
  quit: () => ipcRenderer.invoke("desktop:quit"),

  /* ---- 应用内更新 ---- */
  downloadUpdate: (url, md5, filename) => ipcRenderer.invoke("desktop:download-update", url, md5, filename),
  installUpdate: (path) => ipcRenderer.invoke("desktop:install-update", path),

  /* ---- 主进程 → 页面事件 ---- */
  onUpdateProgress: (cb) => {
    const fn = (_e, p) => cb(p);
    ipcRenderer.on("update-progress", fn);
    return () => ipcRenderer.removeListener("update-progress", fn);
  },
  onMenu: (handler) => {
    const fn = (_e, payload) => handler(payload);
    ipcRenderer.on("menu", fn);
    return () => ipcRenderer.removeListener("menu", fn);
  },
  onFiles: (handler) => {
    const fn = (_e, list) => handler(list);
    ipcRenderer.on("files", fn);
    return () => ipcRenderer.removeListener("files", fn);
  },
});
