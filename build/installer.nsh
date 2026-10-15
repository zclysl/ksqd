; Suqi - custom NSIS uninstall hook (design doc 4.12 / F5.3).
; This file is intentionally ASCII-only: NSIS include files are compiled with
; the system input charset, so ASCII keeps the compile unambiguous.
;
; Purpose: when uninstalling, delete the "launch at login" registration that
; points at this installation. We enumerate HKCU\...\Run and remove every value
; whose data starts with the install directory ($INSTDIR). Matching by data
; instead of by value name keeps us independent of Electron's internal naming
; and never touches other applications' startup entries.
;
; Electron writes the command as:  "C:\...\Suqi.exe" --autostart
; (quoted only when the path contains spaces), so after stripping one optional
; leading quote the remaining text starts with the executable path inside
; $INSTDIR. StrCmp is case-insensitive in NSIS, matching Windows path semantics.

!macro customUnInstall
  StrCmp $INSTDIR "" suqi_unreg_done  ; no install dir to match against - bail out

  StrCpy $R0 0        ; enumeration index
  StrCpy $R9 0        ; safety counter - never loop forever
  suqi_unreg_loop:
    IntOp $R9 $R9 + 1
    IntCmp $R9 1000 suqi_unreg_done
    EnumRegValue $R1 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" $R0
    StrCmp $R1 "" suqi_unreg_done
    ReadRegStr $R2 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "$R1"

    ; strip one optional leading double quote from the command line
    StrCpy $R3 $R2 1
    StrCmp $R3 '$\"' suqi_unreg_strip 0
    Goto suqi_unreg_check
    suqi_unreg_strip:
      StrCpy $R2 $R2 "" 1

    suqi_unreg_check:
      StrLen $R4 $INSTDIR
      StrCpy $R5 $R2 $R4
      StrCmp $R5 $INSTDIR 0 suqi_unreg_next
      ; boundary check: the character right after the install dir must end the
      ; string, be a path separator or a space - otherwise the value belongs to
      ; another program whose path merely shares the prefix (e.g. "...\Suqi2\x.exe")
      StrCpy $R6 $R2 1 $R4
      StrCmp $R6 "" suqi_unreg_delete
      StrCmp $R6 "\" suqi_unreg_delete
      StrCmp $R6 " " suqi_unreg_delete

    suqi_unreg_next:
      IntOp $R0 $R0 + 1
      Goto suqi_unreg_loop

    suqi_unreg_delete:
      DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "$R1"
      ; the deleted value is gone and the next value moved into the same index,
      ; so keep $R0 unchanged and re-enumerate from the same position
      Goto suqi_unreg_loop

  suqi_unreg_done:
!macroend
