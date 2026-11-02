' BRO Local AI Assistant - silent desktop launcher.
' Double-click this file (or the "BRO Assistant" shortcut) to start BRO.
' If BRO is already running, this simply brings the popup back up.

Option Explicit

Dim shell, fso, appDir, electron, mainScript, command

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

appDir = fso.GetParentFolderName(WScript.ScriptFullName)
electron = appDir & "\node_modules\electron\dist\electron.exe"
mainScript = appDir & "\desktop\main.js"

If Not fso.FileExists(electron) Then
  MsgBox "BRO's desktop engine is not installed yet." & vbCrLf & vbCrLf & _
         "Open a terminal in:" & vbCrLf & appDir & vbCrLf & vbCrLf & _
         "and run:  npm.cmd install", 16, "BRO Assistant"
  WScript.Quit 1
End If

If Not fso.FileExists(mainScript) Then
  MsgBox "Could not find desktop\main.js in:" & vbCrLf & appDir, 16, "BRO Assistant"
  WScript.Quit 1
End If

shell.CurrentDirectory = appDir
command = """" & electron & """ """ & mainScript & """"
' 0 = hidden console window, False = do not wait for the app to exit.
shell.Run command, 0, False
