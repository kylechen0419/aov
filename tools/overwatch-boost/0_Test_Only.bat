@echo off
REM Test mode: health check only, changes NOTHING. Saves log to Desktop\OWBoost_log.txt
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Requesting administrator rights...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0OW_Boost.ps1" -Check
pause
