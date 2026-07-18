@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0diagnose.ps1" %*
exit /b %ERRORLEVEL%
