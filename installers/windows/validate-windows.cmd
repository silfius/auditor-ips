@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "RC5=0"
set "RC7=0"

echo.
echo === Windows PowerShell 5.1 ===
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tests\validate.ps1"
set "RC5=!ERRORLEVEL!"

where pwsh.exe >nul 2>&1
if errorlevel 1 (
  echo.
  echo PowerShell 7 no encontrado; solo se ejecuto Windows PowerShell 5.1.
) else (
  echo.
  echo === PowerShell 7 ===
  pwsh.exe -NoProfile -File "%~dp0tests\validate.ps1"
  set "RC7=!ERRORLEVEL!"
)

echo.
echo VALIDATION_RC_WINDOWS_POWERSHELL=!RC5!
echo VALIDATION_RC_POWERSHELL_7=!RC7!

if not "!RC5!"=="0" exit /b !RC5!
if not "!RC7!"=="0" exit /b !RC7!
exit /b 0
