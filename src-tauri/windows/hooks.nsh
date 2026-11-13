; Windows 只登记「打开方式」和目录右键「用 Openfile 打开」，永不当默认打开程序。
;
; 不用 tauri.conf.json 的 fileAssociations：Tauri 的 NSIS 模板用 APP_ASSOCIATE 改写 .ext 的默认 ProgID，
; 从没设过默认的扩展名会直接变成 Openfile 打开。这里只加自己的键和值，任何默认值都不碰：
;   Applications\<exe>           程序名、打开命令、SupportedTypes（「选择其他应用」里列出）
;   Openfile.Document            ProgID：图标与打开命令
;   .<ext>\OpenWithProgids       加一个值 Openfile.Document（右键「打开方式」里列出）
;   Directory\shell\Openfile、Directory\Background\shell\Openfile    目录与目录空白处右键
; 卸载只删自己加的；父键用 /ifempty，只在整个空了时才删（makensis 3.11 实测：有任何值或子键都保留，
; 别家的 OpenWithProgids 值、扩展名键的默认值都不会被带走）。
; installMode 是 currentUser，SHCTX = HKCU，不要管理员权限。
; 本文件带 UTF-8 BOM：makensis 按 BOM 认编码，没有 BOM 时中文会按系统代码页读成乱码。

!define OF_PROGID "Openfile.Document"

!macro OF_ADD_TYPE EXT
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" "${EXT}" ""
  WriteRegStr SHCTX "Software\Classes\${EXT}\OpenWithProgids" "${OF_PROGID}" ""
!macroend

!macro OF_REMOVE_TYPE EXT
  DeleteRegValue SHCTX "Software\Classes\${EXT}\OpenWithProgids" "${OF_PROGID}"
  DeleteRegKey /ifempty SHCTX "Software\Classes\${EXT}\OpenWithProgids"
  DeleteRegKey /ifempty SHCTX "Software\Classes\${EXT}"
!macroend

; LABEL 是菜单文字所在的寄存器
!macro OF_FOLDER_VERB KEY LABEL
  WriteRegStr SHCTX "Software\Classes\${KEY}\shell\Openfile" "" "${LABEL}"
  WriteRegStr SHCTX "Software\Classes\${KEY}\shell\Openfile" "Icon" "$INSTDIR\${MAINBINARYNAME}.exe,0"
  WriteRegStr SHCTX "Software\Classes\${KEY}\shell\Openfile\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%V"'
!macroend

!macro NSIS_HOOK_POSTINSTALL
  Push $0
  Push $1
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe" "FriendlyAppName" "${PRODUCTNAME}"
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\DefaultIcon" "" "$INSTDIR\${MAINBINARYNAME}.exe,0"
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
  WriteRegStr SHCTX "Software\Classes\${OF_PROGID}" "" "${PRODUCTNAME}"
  WriteRegStr SHCTX "Software\Classes\${OF_PROGID}\DefaultIcon" "" "$INSTDIR\${MAINBINARYNAME}.exe,0"
  WriteRegStr SHCTX "Software\Classes\${OF_PROGID}\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
  !insertmacro OF_ADD_TYPE ".md"
  !insertmacro OF_ADD_TYPE ".markdown"
  !insertmacro OF_ADD_TYPE ".txt"
  !insertmacro OF_ADD_TYPE ".docx"
  !insertmacro OF_ADD_TYPE ".pdf"
  !insertmacro OF_ADD_TYPE ".html"
  ; 右键文字跟系统界面语言：英文界面用英文，其余用中文（与应用首次启动选界面语言的规则一致）
  StrCpy $1 "用 Openfile 打开"
  System::Call 'kernel32::GetUserDefaultUILanguage() i .r0'
  IntOp $0 $0 & 0x3FF
  IntCmp $0 9 0 +2 +2
    StrCpy $1 "Open with Openfile"
  !insertmacro OF_FOLDER_VERB "Directory" "$1"
  !insertmacro OF_FOLDER_VERB "Directory\Background" "$1"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  Pop $1
  Pop $0
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro OF_REMOVE_TYPE ".md"
  !insertmacro OF_REMOVE_TYPE ".markdown"
  !insertmacro OF_REMOVE_TYPE ".txt"
  !insertmacro OF_REMOVE_TYPE ".docx"
  !insertmacro OF_REMOVE_TYPE ".pdf"
  !insertmacro OF_REMOVE_TYPE ".html"
  DeleteRegKey SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe"
  DeleteRegKey /ifempty SHCTX "Software\Classes\Applications"
  DeleteRegKey SHCTX "Software\Classes\${OF_PROGID}"
  DeleteRegKey SHCTX "Software\Classes\Directory\shell\Openfile"
  DeleteRegKey /ifempty SHCTX "Software\Classes\Directory\shell"
  DeleteRegKey SHCTX "Software\Classes\Directory\Background\shell\Openfile"
  DeleteRegKey /ifempty SHCTX "Software\Classes\Directory\Background\shell"
  DeleteRegKey /ifempty SHCTX "Software\Classes\Directory\Background"
  DeleteRegKey /ifempty SHCTX "Software\Classes\Directory"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
