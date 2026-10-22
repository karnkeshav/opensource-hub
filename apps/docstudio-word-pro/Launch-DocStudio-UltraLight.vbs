Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
currentDir = fso.GetParentFolderName(WScript.ScriptFullName)
batPath = currentDir & "\Launch-DocStudio-UltraLight.bat"
WshShell.Run """" & batPath & """", 0, False
