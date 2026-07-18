@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0migrate-installation.ps1" %*
exit /b %ERRORLEVEL%
