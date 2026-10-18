@echo off
rem ===========================================================================
rem  add-to-path.cmd —— 把 CyanCodex 目录加入当前用户的 PATH
rem
rem  安装程序**不会**自动改环境变量（未签名的安装包静默改 PATH 容易被杀软判为
rem  持久化行为）。需要命令行全局可用时，双击本文件即可。
rem
rem  只写 HKCU，不需要管理员权限；写的是 REG_EXPAND_SZ，不会破坏已有的
rem  %USERPROFILE% 这类变量。
rem ===========================================================================
setlocal
set "DIR=%~dp0"
if "%DIR:~-1%"=="\" set "DIR=%DIR:~0,-1%"

echo 即将把下面这个目录加入当前用户的 PATH：
echo   %DIR%
echo.
pause

powershell -NoProfile -Command ^
  "$d='%DIR%'; $p=[Environment]::GetEnvironmentVariable('Path','User'); if ($null -eq $p) { $p='' }; if ($p -split ';' -contains $d) { Write-Host '已经在 PATH 里了，无需重复添加。' } else { $n = if ($p -eq '') { $d } else { $p.TrimEnd(';') + ';' + $d }; [Environment]::SetEnvironmentVariable('Path', $n, 'User'); Write-Host '已加入 PATH。请重新打开终端后生效。' }"

echo.
pause
