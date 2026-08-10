@echo off
REM Parts of this file are created by genAI.
REM This notice needs to remain attached to any reproduction of or excerpt from this file.
REM Agent: Claude Code
REM AI-assisted: Yes
REM See: docs/AGENTS.md for policy and provenance information

REM Build the Windows host AF_HYPERV echo server.
REM Usage: build-echo-server.cmd

setlocal
set SRC=windows-hyperv-echo-server.cs
set OUT=windows-hyperv-echo-server.exe

echo.
echo ==============================================
echo   Windows AF_HYPERV echo server builder
echo ==============================================
echo.

if not exist "%SRC%" (
    echo [ERROR] Source not found: %SRC%
    exit /b 1
)

REM Prefer csc on PATH (VS / Roslyn); fall back to the .NET Framework compiler.
set CSC=
where csc >nul 2>nul && set CSC=csc

if "%CSC%"=="" (
    set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
)

if not exist "%CSC%" (
    if /I not "%CSC%"=="csc" (
        echo [ERROR] No C# compiler found ^(csc on PATH or .NET Framework v4.0.30319^).
        exit /b 1
    )
)

echo [INFO] Using compiler: %CSC%
echo [INFO] Compiling %SRC% -^> %OUT%
"%CSC%" /nologo /out:%OUT% %SRC%
if %errorlevel% neq 0 (
    echo [ERROR] Compilation failed
    exit /b 1
)

echo.
echo [OK] Built %OUT%
echo.
echo Next steps:
echo   1. Run elevated ^(first run registers the service GUID^):
echo        %OUT%
echo   2. From WSL2:
echo        node wsl-vsock-echo-client.js --message "Hello vsock"
echo.
endlocal
