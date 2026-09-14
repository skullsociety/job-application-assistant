Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
folder = files.GetParentFolderName(WScript.ScriptFullName)
command = "cmd.exe /d /s /c ""cd /d """ & folder & """ && npm run dashboard"""
shell.Run command, 0, False
