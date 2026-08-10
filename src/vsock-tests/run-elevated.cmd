@echo off
REM Run the echo server elevated to set registry values
echo Starting Windows AF_HYPERV echo server (elevated)...
echo.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process '%~dp0windows-hyperv-echo-server.exe' -Verb RunAs -Wait"
echo.
echo Server stopped.
pause
