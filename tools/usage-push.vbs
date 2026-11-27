' Murim AI room usage push: runs usage-push.ps1 without a console window (for Task Scheduler)
Dim fso, dir, sh
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & dir & "\usage-push.ps1""", 0, True
