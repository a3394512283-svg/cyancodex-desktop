/* ============================================================================
 * electron/tray.js —— 系统托盘
 *
 * 桌面应用和网页最直观的区别之一：关掉窗口不等于退出，东西还在后台待命。
 * 这里提供托盘图标 + 右键菜单 + 单击唤出。
 *
 * ★ 托盘图标用 16/32 的 PNG：Windows 托盘是 16×16，塞 256 的图会被缩放得发糊。
 * ★ 用户可以在设置里关掉「关闭时最小化到托盘」——有人就是不喜欢后台常驻，
 *   这个必须给开关，不能强加。
 * ========================================================================== */
"use strict";

const { Tray, Menu, nativeImage, app } = require("electron");
const path = require("path");

let tray = null;

function iconPath() {
  // 打包后 web/ 在 asar 里，nativeImage 能直接读
  return path.join(__dirname, "..", "web", "icon-32.png");
}

/**
 * @param {object} actions { show, newConv, openLibrary, checkUpdate, toggleAutostart, isAutostart, quit }
 */
function createTray(actions) {
  if (tray) return tray;

  let img = nativeImage.createFromPath(iconPath());
  if (img.isEmpty()) {
    // 图标缺失也要能起来，用一个 16×16 的空图占位
    img = nativeImage.createEmpty();
  }

  tray = new Tray(img);
  tray.setToolTip("CyanCodex —— 基岩版指令助手");

  const rebuild = () => {
    const menu = Menu.buildFromTemplate([
      { label: "打开 CyanCodex", click: () => actions.show() },
      { type: "separator" },
      { label: "新建对话", click: () => actions.newConv() },
      { label: "指令库", click: () => actions.openLibrary() },
      { label: "生成器", click: () => actions.openTools() },
      { type: "separator" },
      { label: "检查更新", click: () => actions.checkUpdate() },
      {
        label: "开机自启",
        type: "checkbox",
        checked: !!actions.isAutostart(),
        click: (item) => {
          actions.toggleAutostart(item.checked);
          rebuild();
        },
      },
      { type: "separator" },
      { label: "退出", click: () => actions.quit() },
    ]);
    tray.setContextMenu(menu);
  };

  rebuild();

  // Windows 上单击托盘图标就唤出窗口，这是用户预期
  tray.on("click", () => actions.show());
  tray.on("double-click", () => actions.show());

  tray._rebuild = rebuild;
  return tray;
}

function rebuild() {
  if (tray && tray._rebuild) tray._rebuild();
}

function destroy() {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}

module.exports = { createTray, rebuild, destroy };
