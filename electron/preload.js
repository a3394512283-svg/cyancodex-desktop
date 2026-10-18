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

  /* ---- 系统设置 ---- */
  autostart: (on) => ipcRenderer.invoke("desktop:autostart", on),
  minimizeToTray: (on) => ipcRenderer.invoke("desktop:minimize-to-tray", on),
  openConfigDir: () => ipcRenderer.invoke("desktop:open-home"),
  openDataDir: () => ipcRenderer.invoke("desktop:open-data"),
  hide: () => ipcRenderer.invoke("desktop:hide"),
  quit: () => ipcRenderer.invoke("desktop:quit"),

  /* ---- 主进程 → 页面事件 ---- */
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
