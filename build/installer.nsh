; ============================================================================
;  build/installer.nsh —— electron-builder 的 NSIS 扩展点
;
;  ★★ 2026-10-18：安装器**完全不碰环境变量**。
;
;  背景：这套安装包未做代码签名，360 / 奇安信 对「未签名 NSIS + 静默修改用户 PATH」
;  判得很重（静态特征像持久化），实测会被报成风险程序。
;
;  现在改成：
;    · 安装：只解压文件 + 建快捷方式，不写任何注册表环境变量
;    · CLI 全局可用：安装目录里放一个 add-to-path.cmd，用户需要时自己双击
;    · 卸载：仍然清理 PATH（防止旧版本装过留下残留）
;
;  ★ 用 HKCU 而不是 HKLM：perMachine=false，写系统 Path 需要管理员权限。
;  ★ 用 WriteRegExpandStr（REG_EXPAND_SZ）而不是 REG_SZ：用户原 Path 里通常含
;    %USERPROFILE% 这类变量，用 REG_SZ 写回去会把变量变成字面量，搞坏环境变量。
;  ★ 改完 Path 必须广播 WM_SETTINGCHANGE。
;  ★★ 安装段/卸载段用不同字符串函数：卸载段只允许调用 un. 开头的函数。
;  ★★ 不要在这里用 MessageBox / IfSilent：实测会让 NSIS 在
;     installApplicationFiles 阶段报 "macroline 91" 并整体失败。
; ============================================================================

!include "LogicLib.nsh"
!include "StrFunc.nsh"

!ifdef BUILD_UNINSTALLER
  ${UnStrLoc}
  ${UnStrRep}
!endif

!macro customInstall
  ; 有意留空：不写环境变量、不写自启、不动注册表。
  ; CLI 入口靠安装目录里的 add-to-path.cmd。
!macroend

!macro customUnInstall
  ReadRegStr $0 HKCU "Environment" "Path"
  ${UnStrLoc} $1 "$0" "$INSTDIR" ">"
  ${If} $1 != ""
    ${UnStrRep} $0 "$0" ";$INSTDIR" ""
    ${UnStrRep} $0 "$0" "$INSTDIR;" ""
    ${UnStrRep} $0 "$0" "$INSTDIR" ""
    WriteRegExpandStr HKCU "Environment" "Path" "$0"
    SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000
    DetailPrint "已从用户 Path 移除安装目录"
  ${EndIf}
!macroend
