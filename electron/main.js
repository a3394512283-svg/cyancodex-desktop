/* ============================================================================
 * electron/main.js —— 桌面壳主进程
 *
 * 这一层负责「桌面应用该有、浏览器给不了」的东西：
 *   窗口状态记忆 / 原生菜单 / 托盘常驻 / 原生通知 / 开机自启 /
 *   本地数据文件（可备份可恢复）/ 系统文件对话框 / 剪贴板
 *
 * 业务逻辑仍然留在 web/ 前端和 server/ 本地服务里 —— 但和网页版不同的是，
 * 前端在桌面壳里会走 IPC 把数据落到 %APPDATA%\CyanCodex\data\*.json，
 * 而不是塞在浏览器 localStorage 里。
 *
 * ★ 前端加载 http://127.0.0.1:<随机端口>/web，不是 file://
 *   file:// 下相对路径 fetch、CSP、localStorage 分区都会出问题，
 *   而且 AI 的 SSE 流式请求需要同源代理。
 * ========================================================================== */
"use strict";

const {
  app, BrowserWindow, Menu, shell, dialog, ipcMain, clipboard,
  nativeTheme, Notification, globalShortcut, session,
} = require("electron");
const fs = require("fs");
const path = require("path");

const C = require("../core/config");
const server = require("../server");
const store = require("./store");
const trayMod = require("./tray");

let win = null;
let localUrl = null;
let httpServer = null;
let quitting = false;
let pendingFiles = [];   // 命令行 / 拖进来的文件，等窗口 ready 再发过去

/* ★★ 把 Electron 的运行时数据（Cache / GPUCache / Local State / DIPS…）挪到
 *    %APPDATA%\CyanCodex\runtime 下，别和我们的 config.json / auth.json 混在一起。
 *    必须在 app ready 之前调用。 */
try {
  app.setPath("userData", path.join(app.getPath("appData"), "CyanCodex", "runtime"));
} catch (_) { /* 拿不到 appData 就退回默认 */ }

/* ------------------------------------------------------ 单实例 + 文件参数 */

function filesFromArgv(argv) {
  return (argv || []).filter((a) => /\.(mcfunction|txt|json|md)$/i.test(a) && fs.existsSync(a));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  pendingFiles = filesFromArgv(process.argv.slice(1));
  app.on("second-instance", (_e, argv) => {
    const files = filesFromArgv(argv.slice(1));
    if (win) {
      if (win.isMinimized()) win.restore();
      if (!win.isVisible()) win.show();
      win.focus();
      if (files.length) send("files", files);
    }
  });
}

/* ---------------------------------------------------------------- 窗口 */

function restoreBounds() {
  const w = C.get("window") || {};
  const out = { width: w.width || 1280, height: w.height || 840 };
  if (typeof w.x === "number" && typeof w.y === "number") {
    const { screen } = require("electron");
    const ok = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return w.x >= a.x - 50 && w.y >= a.y - 50 &&
        w.x < a.x + a.width - 100 && w.y < a.y + a.height - 100;
    });
    if (ok) { out.x = w.x; out.y = w.y; }
  }
  return out;
}

function saveBounds() {
  if (!win || win.isDestroyed()) return;
  const b = win.getNormalBounds ? win.getNormalBounds() : win.getBounds();
  C.set("window", {
    width: b.width, height: b.height, x: b.x, y: b.y,
    maximized: win.isMaximized(),
  });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function showWindow() {
  if (!win || win.isDestroyed()) return createWindow();
  if (!win.isVisible()) win.show();
  if (win.isMinimized()) win.restore();
  win.focus();
}

function createWindow() {
  const bounds = restoreBounds();
  win = new BrowserWindow({
    ...bounds,
    minWidth: 940,
    minHeight: 620,
    show: false,
    backgroundColor: "#0E1512",
    title: "CyanCodex",
    icon: path.join(__dirname, "..", "build", "icon.ico"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  if ((C.get("window") || {}).maximized) win.maximize();

  win.once("ready-to-show", () => {
    win.show();
    win.focus();
  });

  win.on("close", (e) => {
    saveBounds();
    // 关窗口 ≠ 退出：默认最小化到托盘，可在设置里关掉
    if (!quitting && C.get("minimizeToTray") !== false) {
      e.preventDefault();
      win.hide();
      if (!C.get("trayHintShown")) {
        C.set("trayHintShown", true);
        notify("CyanCodex 仍在后台运行", "点托盘图标可以随时唤出，右键菜单里可以退出。");
      }
    }
  });
  win.on("closed", () => { win = null; });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) && !url.startsWith(localUrl.replace("/web", ""))) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  win.webContents.on("will-navigate", (e, url) => {
    if (localUrl && !url.startsWith(localUrl.replace("/web", ""))) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  /* ★ URL 带时间戳：即使 session 缓存没清干净，也能保证拿到最新的 app.html。
     server 的静态路由按 pathname 匹配（/web），query 不影响。 */
  win.loadURL(localUrl + "?t=" + Date.now());
  win.webContents.on("did-finish-load", () => {
    injectDesktopLayer(win);
    if (pendingFiles.length) {
      setTimeout(() => { send("files", pendingFiles); pendingFiles = []; }, 1200);
    }
  });

  if (process.env.CYANCODEX_SCREENSHOT) {
    win.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        try {
          const probe = await win.webContents.executeJavaScript(
            "(async()=>{const o={title:document.title,desktop:document.documentElement.dataset.desktop||null," +
            "tools:!!document.getElementById('cc-dsk-tools'),bridge:!!window.cyancodex," +
            "store:!!(window.cyancodex&&window.cyancodex.store)};" +
            "try{const r=await fetch('/api/v1/app/version');const j=await r.json();" +
            "o.api=r.status;o.latest=j&&j.latest;}catch(e){o.apiErr=String(e).slice(0,80);}" +
            "return o;})()", true
          );
          console.log("SELFTEST " + JSON.stringify(probe));
        } catch (e) {
          console.log("SELFTEST_FAIL " + e.message);
        }
        try {
          const img = await win.webContents.capturePage();
          fs.writeFileSync(process.env.CYANCODEX_SCREENSHOT, img.toPNG());
          console.log("SCREENSHOT_OK " + process.env.CYANCODEX_SCREENSHOT);
        } catch (e) {
          console.error("SCREENSHOT_FAIL " + e.message);
        }
        quitting = true;
        app.quit();
      }, Number(process.env.CYANCODEX_SCREENSHOT_DELAY || 4500));
    });
  }

  return win;
}

/* ---------------------------------------------------- 桌面层（CSS + JS） */

function injectDesktopLayer(w) {
  try {
    const css = fs.readFileSync(path.join(__dirname, "..", "web", "desktop.css"), "utf8");
    w.webContents.insertCSS(css);
  } catch (_) { /* 没有就用默认样式 */ }

  try {
    const js = fs.readFileSync(path.join(__dirname, "..", "web", "desktop.js"), "utf8");
    w.webContents.executeJavaScript(js, true).catch(() => {});
  } catch (_) { /* ignore */ }
}

/* ---------------------------------------------------------------- 通知 */

function notify(title, body) {
  if (!Notification.isSupported()) return false;
  try {
    const n = new Notification({
      title: title || "CyanCodex",
      body: body || "",
      icon: path.join(__dirname, "..", "web", "icon-192.png"),
      silent: false,
    });
    n.on("click", showWindow);
    n.show();
    return true;
  } catch (_) {
    return false;
  }
}

/* ---------------------------------------------------------------- 自启 */

function isAutostart() {
  if (process.platform !== "win32") return false;
  try {
    return app.getLoginItemSettings().openAtLogin;
  } catch (_) {
    return false;
  }
}

function setAutostart(on) {
  if (process.platform !== "win32") return false;
  try {
    app.setLoginItemSettings({
      openAtLogin: !!on,
      // 自启时静默进托盘，不弹窗口打扰
      args: on ? ["--silent"] : [],
    });
    C.set("autostart", !!on);
    trayMod.rebuild();
    return true;
  } catch (_) {
    return false;
  }
}

/* ---------------------------------------------------------------- 菜单 */

function buildMenu() {
  const template = [
    {
      label: "文件",
      submenu: [
        { label: "新建对话", accelerator: "CmdOrCtrl+N", click: () => send("menu", { action: "new-conv" }) },
        { type: "separator" },
        { label: "导出当前页指令…", accelerator: "CmdOrCtrl+S", click: () => send("menu", { action: "export" }) },
        { label: "导入文本文件…", accelerator: "CmdOrCtrl+O", click: () => send("menu", { action: "import" }) },
        { type: "separator" },
        { label: "备份全部数据…", click: () => doBackup() },
        { label: "从备份恢复…", click: () => doRestore() },
        { type: "separator" },
        { label: "打开数据目录", click: () => shell.openPath(C.HOME) },
        { type: "separator" },
        { label: "退出", accelerator: "Alt+F4", click: () => { quitting = true; app.quit(); } },
      ],
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { role: "selectAll", label: "全选" },
      ],
    },
    {
      label: "视图",
      submenu: [
        { label: "刷新", accelerator: "CmdOrCtrl+R", click: () => win && win.reload() },
        { type: "separator" },
        { role: "resetZoom", label: "实际大小" },
        { role: "zoomIn", label: "放大" },
        { role: "zoomOut", label: "缩小" },
        { type: "separator" },
        { role: "togglefullscreen", label: "全屏" },
        { label: "开发者工具", accelerator: "F12", click: () => win && win.webContents.toggleDevTools() },
      ],
    },
    {
      label: "工具",
      submenu: [
        { label: "指令库", click: () => send("menu", { action: "go", page: "library" }) },
        { label: "生成器", click: () => send("menu", { action: "go", page: "tools" }) },
        { label: "AI 助手", click: () => send("menu", { action: "go", page: "ai" }) },
        { label: "账号中心", click: () => send("menu", { action: "go", page: "account" }) },
        { type: "separator" },
        { label: "检查更新", click: () => send("menu", { action: "update" }) },
        {
          label: "开机自启",
          type: "checkbox",
          checked: isAutostart(),
          click: (item) => setAutostart(item.checked),
        },
        {
          label: "关闭窗口时最小化到托盘",
          type: "checkbox",
          checked: C.get("minimizeToTray") !== false,
          click: (item) => C.set("minimizeToTray", item.checked),
        },
        { type: "separator" },
        { label: "关于 CyanCodex", click: () => send("menu", { action: "about" }) },
      ],
    },
    {
      label: "帮助",
      submenu: [
        { label: "官方网站", click: () => shell.openExternal("https://cyancodex.cn") },
        { label: "开源仓库", click: () => shell.openExternal("https://git.cyancodex.cn") },
        { label: "网页版", click: () => shell.openExternal("https://cyancodex.bluestudio.cn/web") },
        { type: "separator" },
        {
          label: "命令行帮助",
          click: () => {
            dialog.showMessageBox(win, {
              type: "info",
              title: "CLI",
              message: "命令行用法",
              detail:
                "在任意终端里（安装时已把目录加入 Path）：\n\n" +
                "  cyancodex gen tdisplay --objective coins --name 金币 --line \"金币:@s/coins\"\n" +
                "  cyancodex lib search 计分板\n" +
                "  cyancodex ai \"做一个倒计时计分板\" -o timer.mcfunction\n" +
                "  cyancodex --help\n\n" +
                "配置目录：" + C.HOME,
              buttons: ["好"],
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ---------------------------------------------------------------- 备份 */

function doBackup() {
  return (async () => {
    const r = await dialog.showSaveDialog(win, {
      title: "备份 CyanCodex 数据",
      defaultPath: "cyancodex-backup-" + new Date().toISOString().slice(0, 10) + ".json",
      filters: [{ name: "CyanCodex 备份", extensions: ["json"] }],
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    const payload = {
      kind: "cyancodex-backup",
      version: C.VERSION,
      ts: Date.now(),
      config: C.load(),
      auth: C.loadAuth(),
      data: {
        convs: store.open("convs").dump().data,
        settings: store.open("settings").dump().data,
        library: store.open("library").dump().data,
      },
    };
    try {
      fs.writeFileSync(r.filePath, JSON.stringify(payload, null, 2), "utf8");
      return { ok: true, path: r.filePath, size: fs.statSync(r.filePath).size };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  })();
}

function doRestore() {
  return (async () => {
    const r = await dialog.showOpenDialog(win, {
      title: "从备份恢复",
      properties: ["openFile"],
      filters: [{ name: "CyanCodex 备份", extensions: ["json"] }],
    });
    if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(r.filePaths[0], "utf8"));
    } catch (e) {
      return { ok: false, message: "文件不是合法 JSON" };
    }
    if (!payload || payload.kind !== "cyancodex-backup") {
      return { ok: false, message: "这不是 CyanCodex 的备份文件" };
    }
    const confirm = await dialog.showMessageBox(win, {
      type: "warning",
      title: "确认恢复",
      message: "恢复会覆盖当前的数据",
      detail: "对话记录、设置与登录态都会被备份内容替换。建议先做一次备份。",
      buttons: ["取消", "覆盖恢复"],
      defaultId: 0,
      cancelId: 0,
    });
    if (confirm.response !== 1) return { ok: false, canceled: true };

    try {
      if (payload.data) {
        for (const k of Object.keys(payload.data)) {
          store.open(k).setAll(payload.data[k]);
        }
        store.flushAll();
      }
      if (payload.config) {
        const keep = { window: C.get("window") };
        C.save(Object.assign(payload.config, keep));
      }
      if (payload.auth) C.saveAuth(payload.auth);
      if (win) win.reload();
      return { ok: true, path: r.filePaths[0] };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  })();
}

/* ---------------------------------------------------------------- IPC */

ipcMain.handle("desktop:save", async (_e, defaultName, content) => {
  const r = await dialog.showSaveDialog(win, {
    title: "导出指令",
    defaultPath: defaultName || "commands.mcfunction",
    filters: [
      { name: "Minecraft 函数", extensions: ["mcfunction"] },
      { name: "文本文件", extensions: ["txt"] },
      { name: "全部文件", extensions: ["*"] },
    ],
  });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(r.filePath, String(content).replace(/\r?\n/g, "\n") + "\n", "utf8");
    return { ok: true, path: r.filePath };
  } catch (e) {
    return { ok: false, message: e.message };
  }
});

ipcMain.handle("desktop:open", async () => {
  const r = await dialog.showOpenDialog(win, {
    title: "导入文本",
    properties: ["openFile"],
    filters: [
      { name: "文本 / 函数", extensions: ["mcfunction", "txt", "md", "json", "log", "csv"] },
      { name: "全部文件", extensions: ["*"] },
    ],
  });
  if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
  try {
    const content = fs.readFileSync(r.filePaths[0], "utf8");
    return { ok: true, path: r.filePaths[0], name: path.basename(r.filePaths[0]), content };
  } catch (e) {
    return { ok: false, message: e.message };
  }
});

ipcMain.handle("desktop:copy", (_e, text) => {
  clipboard.writeText(String(text || ""));
  return { ok: true };
});

ipcMain.handle("desktop:notify", (_e, title, body) => ({ ok: notify(title, body) }));

ipcMain.handle("desktop:info", () => ({
  ok: true,
  version: C.VERSION,
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  platform: process.platform,
  home: C.HOME,
  dataDir: store.DATA_DIR,
  api: C.load().api,
  dark: nativeTheme.shouldUseDarkColors,
  autostart: isAutostart(),
  minimizeToTray: C.get("minimizeToTray") !== false,
}));

ipcMain.handle("desktop:open-home", () => shell.openPath(C.HOME));
ipcMain.handle("desktop:open-data", () => shell.openPath(store.DATA_DIR));

ipcMain.handle("desktop:autostart", (_e, on) => {
  if (on === undefined) return { ok: true, value: isAutostart() };
  return { ok: setAutostart(on), value: isAutostart() };
});

ipcMain.handle("desktop:minimize-to-tray", (_e, on) => {
  if (on === undefined) return { ok: true, value: C.get("minimizeToTray") !== false };
  C.set("minimizeToTray", !!on);
  return { ok: true, value: !!on };
});

ipcMain.handle("desktop:backup", () => doBackup());
ipcMain.handle("desktop:restore", () => doRestore());

ipcMain.handle("desktop:hide", () => { if (win) win.hide(); return { ok: true }; });
ipcMain.handle("desktop:quit", () => { quitting = true; app.quit(); return { ok: true }; });

/* ---- 本地存储 ---- */
ipcMain.handle("store:get", (_e, name, key, dflt) => store.open(name).get(key, dflt));
ipcMain.handle("store:set", (_e, name, key, value) => store.open(name).set(key, value));
ipcMain.handle("store:all", (_e, name) => store.open(name).get());
ipcMain.handle("store:clear", (_e, name) => store.open(name).clear());
ipcMain.handle("store:flush", () => { store.flushAll(); return { ok: true }; });

/* ---------------------------------------------------------------- 启动 */

app.whenReady().then(async () => {
  nativeTheme.themeSource = "system";

  /* ★ 清一次 HTTP 缓存：app.html 的「网页版 → 桌面版」是服务端出字节时替换的，
     但 Chromium 会把上一次的 app.html 留在 disk cache 里，导致改完还显示旧文案。 */
  try { await session.defaultSession.clearCache(); } catch (_) { /* ignore */ }

  try {
    const started = await server.start(0);
    httpServer = started.server;
    localUrl = started.url;
  } catch (e) {
    dialog.showErrorBox("启动失败", "本地服务起不来：" + e.message);
    app.quit();
    return;
  }

  buildMenu();

  // 静默启动（开机自启带的 --silent）：只进托盘不弹窗
  const silent = process.argv.includes("--silent");
  createWindow();
  if (silent && win) win.hide();

  trayMod.createTray({
    show: showWindow,
    newConv: () => { showWindow(); send("menu", { action: "new-conv" }); },
    openLibrary: () => { showWindow(); send("menu", { action: "go", page: "library" }); },
    openTools: () => { showWindow(); send("menu", { action: "go", page: "tools" }); },
    checkUpdate: () => { showWindow(); send("menu", { action: "update" }); },
    isAutostart,
    toggleAutostart: setAutostart,
    quit: () => { quitting = true; app.quit(); },
  });

  // 全局快捷键：随时唤出
  try {
    globalShortcut.register("Control+Shift+Space", showWindow);
  } catch (_) { /* 被别的软件占了就算了 */ }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showWindow();
  });
});

app.on("before-quit", () => {
  quitting = true;
  store.flushAll();
});

app.on("will-quit", () => {
  try { globalShortcut.unregisterAll(); } catch (_) { /* ignore */ }
});

app.on("window-all-closed", () => {
  // 托盘模式下不退出；用户从托盘菜单退出时走 app.quit()
  if (C.get("minimizeToTray") === false) {
    if (httpServer) try { httpServer.close(); } catch (_) { /* ignore */ }
    app.quit();
  }
});

process.on("uncaughtException", (e) => {
  try { console.error("[main]", e); } catch (_) { /* ignore */ }
});
