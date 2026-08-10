@echo off
REM Test the simple bridge to fix named pipe issues

echo.
echo ==============================================
echo Simple Named Pipe Bridge Test
echo ==============================================
echo.

echo [INFO] Compiling simple bridge test...
%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe /out:bridge-test-simple.exe bridge-test-simple.cs

if %errorlevel% neq 0 (
    echo [ERROR] Compilation failed
    exit /b 1
)

echo [OK] Compiled successfully
echo.
echo [INFO] Starting simple bridge test...
echo       This will create: \\.\pipe\wmux-bridge-poc
echo       Test with: powershell windows-pipe-listener.ps1
echo.

bridge-test-simple.exe