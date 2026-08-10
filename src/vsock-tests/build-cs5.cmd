@echo off
REM Parts of this file are created by genAI.
REM This notice needs to remain attached to any reproduction of or excerpt from this file.
REM Agent: Claude Code
REM AI-assisted: Yes
REM See: docs/AGENTS.md for policy and provenance information

REM Build C# 5 compatible bridge

echo.
echo ==============================================
echo wmux Bridge Builder - C# 5 Compatible
echo ==============================================
echo.

if not exist "windows-hyperv-bridge-cs5.cs" (
    echo [ERROR] Source file not found: windows-hyperv-bridge-cs5.cs
    exit /b 1
)

echo [INFO] Using C# 5 compatible source file
echo [INFO] Locating .NET Framework compiler...

set CSC_PATH=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe

if not exist "%CSC_PATH%" (
    echo [ERROR] .NET Framework compiler not found
    echo        Expected: %CSC_PATH%
    echo        Install .NET Framework 4.0+
    exit /b 1
)

echo [OK] Found .NET Framework compiler
echo     Version: C# 5 (.NET Framework 4.0+)
echo.

echo [INFO] Compiling bridge (C# 5 compatible)...
"%CSC_PATH%" /out:wmux-hyperv-bridge.exe windows-hyperv-bridge-cs5.cs

if %errorlevel% neq 0 (
    echo [ERROR] Compilation failed
    echo.
    echo Troubleshooting:
    echo   * Check if antivirus is blocking compiler
    echo   * Ensure you have write permissions
    echo   * Try running as Administrator
    exit /b 1
)

echo [OK] Bridge compiled successfully!
echo     Output: wmux-hyperv-bridge.exe
echo.
echo ==============================================
echo READY TO TEST - C# 5 VERSION
echo ==============================================
echo.
echo 1. Start bridge (as Administrator):
echo    wmux-hyperv-bridge.exe
echo.
echo 2. Test from WSL2:
echo    node wsl-vsock-client.js --message "Hello!"
echo.
echo 3. Check named pipe:
echo    Bridge creates: \\.\pipe\wmux-bridge-poc
echo.
echo Features:
echo   * Compatible with older .NET Framework
echo   * No string interpolation (C# 5 safe)
echo   * Same functionality as modern version
echo.
echo [OK] C# 5 bridge ready for testing!