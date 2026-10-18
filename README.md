# CyanCodex Desktop

Minecraft 基岩版指令助手 —— Windows 桌面客户端（GUI + CLI）。

基于 [CyanCodex](https://cyancodex.cn)（原项目：[Diamond-Minec/CyanCodex-Android](https://github.com/Diamond-Minec/CyanCodex-Android)，GPLv3）的**桌面端二改版**，
与官方 Android 版共用同一套账号与接口，但界面与交互按桌面场景重做。

> 本项目由**沧蓝工坊成员**维护，基于官方开源代码继续开发。
> **非官方发布**，不代表沧蓝工坊官方立场或背书。原项目著作权归原作者所有。

## 功能

- **指令库**：平台 / 高质 / 低质 / 我的 / 收藏 / 教程 六个分栏，搜索、上传、一键复制
- **生成器**：T 显（计分板）、穷举、滚动字幕、音乐生成器、T 显 JSON 编辑器
- **AI Agent**：多轮对话、流式输出、会话云端同步
- **工具箱**：网络测速、查询基岩版 ID、MIDI 工具、五子棋
- **广场**：社区动态与评论
- **账号**：登录、签到、积分、充值档位、登录设备、绑定、改密
- **社交**：好友、私信、聊天室
- **桌面集成**：系统托盘、原生通知、开机自启、关闭最小化、拖拽导入、备份/恢复
- **CLI**：`cyancodex gen|lib|ai` 命令行生成与查询，可脚本化

## 架构

```
electron/     主进程：窗口、菜单、托盘、IPC、本地存储
  main.js     生命周期与系统集成
  preload.js  contextBridge 白名单（14 个 IPC 通道）
  store.js    本地 JSON 存储（原子写 + 节流）
  tray.js     系统托盘
server/       本地静态服务（127.0.0.1 随机端口，供渲染进程加载）
web/          渲染层：HTML/CSS/JS（与网页版共用一套，desktop.js 只在桌面壳注入）
core/         业务核心：配置、API 客户端、指令生成
cli/          命令行入口（同一 exe 当 node 用）
build/        打包脚本、NSIS 扩展、图标
```

渲染进程加载的是**本地 HTTP 服务**（`http://127.0.0.1:<随机端口>/web`），不是远程站点，
因此断网时生成器与指令库仍可用。

## 构建

```bash
npm install
npm start                 # 开发运行
node build/pack.js        # 生成安装包（需要 electron-builder）
```

产物在 `dist*/`。

## 本地数据

| 路径 | 内容 |
| --- | --- |
| `%APPDATA%\CyanCodex\config.json` | 应用配置 |
| `%APPDATA%\CyanCodex\auth.json` | 登录态（令牌） |
| `%APPDATA%\CyanCodex\data\*.json` | 对话、设置等业务数据 |
| `%APPDATA%\CyanCodex\runtime\` | Chromium 运行时缓存 |

应用不收集、不上传任何本地数据；对话同步仅在用户主动触发时发生，且只发往用户自己的账号。

## 许可证

[GPL-3.0](LICENSE)。与上游项目一致。

二次修改部分同样以 GPLv3 发布。如果你分发本项目的修改版本，需要同样开源并提供完整源码。

## 致谢

- 原项目：[CyanCodex](https://cyancodex.cn) / [Diamond-Minec/CyanCodex-Android](https://github.com/Diamond-Minec/CyanCodex-Android)
- [Electron](https://www.electronjs.org/)、[electron-builder](https://www.electron.build/)
- 图标：[Material Icons](https://fonts.google.com/icons)（Apache-2.0）

## 免责声明

本项目由沧蓝工坊成员维护，但**不是官方发布**。使用本软件产生的任何问题（包括但不限于账号、积分、
游戏内效果）由使用者自行承担，与原作者及本项目维护者无关。
