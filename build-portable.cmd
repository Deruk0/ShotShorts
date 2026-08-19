@echo off
setlocal

cd /d "%~dp0"

where npm >nul 2>&1
if errorlevel 1 (
    echo Build failed: npm was not found. Install Node.js and try again.
    exit /b 1
)

tasklist /FO CSV /NH 2>nul | findstr /I /C:"ShotShorts" >nul
if not errorlevel 1 (
    echo Build stopped: ShotShorts is currently running.
    echo Close every ShotShorts window, then run this builder again.
    exit /b 2
)

echo Building the portable ShotShorts executable...
call npm run app:build
if errorlevel 1 (
    echo.
    echo Build failed. Review the error above.
    exit /b 1
)

echo.
echo Build complete. The updated portable executable is in:
echo %~dp0Ready_App_EXE
exit /b 0
