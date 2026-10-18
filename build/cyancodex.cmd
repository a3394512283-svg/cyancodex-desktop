@echo off
rem ===========================================================================
rem  cyancodex.cmd —— 安装后的 CLI 入口
rem
rem  原理：Electron 的可执行文件在 ELECTRON_RUN_AS_NODE=1 时就是一个纯 node。
rem  所以不需要额外带一份 node.exe（省 80MB），直接用应用自己的 exe 跑 CLI。
rem  安装时会把安装目录写进用户 Path，装完在任意终端里直接 `cyancodex ...`。
rem ===========================================================================
setlocal
set ELECTRON_RUN_AS_NODE=1
set CYANCODEX_PACKAGED=1
"%~dp0CyanCodex.exe" "%~dp0resources\app.asar\cli\index.js" %*
