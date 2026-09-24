@echo off
rem The Windows shim for `library`. The dispatcher is library.ps1 beside this file; %~dp0 keeps
rem the pair together wherever the program is installed, so nothing here names a machine.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0library.ps1" %*
