; TickTask 自定义 NSIS 钩子
; 官方模板默认只在「静默/被动安装」或用户勾选完成页复选框时才创建桌面快捷方式,
; 普通图形化安装走完向导后桌面上没有任何图标,容易被误判为「没装上」。
; 这里改为安装结束后始终创建桌面快捷方式。
!macro NSIS_HOOK_POSTINSTALL
  CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
!macroend
