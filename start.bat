@echo off
setlocal
title CogView Local Server
chcp 65001 >nul
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Python not found. Please install Python first: https://www.python.org/downloads/
  echo         and check "Add python.exe to PATH".
  pause
  exit /b 1
)

echo Starting CogView local server ...
echo Browser will open automatically. Close this window to stop.
echo.
python server.py
echo.
pause