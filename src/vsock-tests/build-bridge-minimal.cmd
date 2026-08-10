@echo off
REM Parts of this file are created by genAI.
REM This notice needs to remain attached to any reproduction of or excerpt from this file.
REM Agent: Claude Code
REM AI-assisted: Yes
REM See: docs/AGENTS.md for policy and provenance information

REM Minimal Windows batch file to compile C# bridge - zero encoding issues

echo.
echo ==============================================
echo wmux AF_HYPERV Bridge Builder (Batch)
echo ==============================================
echo.

if not exist "windows-hyperv-bridge.cs" (
    echo [ERROR] Source file not found: windows-hyperv-bridge.cs
    exit /b 1
)

echo [INFO] Locating C# compiler...

set CSC_PATH=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe

if exist "%CSC_PATH%" (
    echo [OK] Found .NET Framework compiler
    goto :compile
)

echo [INFO] Trying .NET CLI...
where dotnet >nul 2>&1
if %errorlevel% equ 0 (
    echo [OK] Found .NET CLI
    goto :dotnet_build
)

echo [ERROR] No C# compiler found
echo        Install .NET Framework 4.0+ or .NET 6+
echo        Download: https://dotnet.microsoft.com/download
exit /b 1

:compile
echo [INFO] Compiling with .NET Framework...
"%CSC_PATH%" /out:wmux-hyperv-bridge.exe windows-hyperv-bridge.cs
if %errorlevel% neq 0 (
    echo [ERROR] Compilation failed
    exit /b 1
)
goto :success

:dotnet_build
echo [INFO] Compiling with .NET CLI...
echo ^<Project Sdk="Microsoft.NET.Sdk"^> > temp.csproj
echo   ^<PropertyGroup^> >> temp.csproj
echo     ^<OutputType^>Exe^</OutputType^> >> temp.csproj
echo     ^<TargetFramework^>net6.0^</TargetFramework^> >> temp.csproj
echo     ^<AssemblyName^>wmux-hyperv-bridge^</AssemblyName^> >> temp.csproj
echo   ^</PropertyGroup^> >> temp.csproj
echo ^</Project^> >> temp.csproj

copy windows-hyperv-bridge.cs Program.cs >nul
dotnet build temp.csproj -c Release -o .
del temp.csproj Program.cs >nul 2>&1
rmdir /s /q bin obj >nul 2>&1

if %errorlevel% neq 0 (
    echo [ERROR] Compilation failed
    exit /b 1
)

:success
echo [OK] Bridge compiled successfully: wmux-hyperv-bridge.exe
echo.
echo ==============================================
echo READY TO TEST
echo ==============================================
echo.
echo 1. Start bridge (as Administrator):
echo    wmux-hyperv-bridge.exe
echo.
echo 2. Test from WSL2:
echo    node wsl-vsock-client.js --message "Hello Bridge!"
echo.
echo 3. Test named pipe (Windows):
echo    Simple connectivity test available
echo.
echo Architecture: WSL2 ^<-^> Windows Bridge ^<-^> Named Pipe
echo Benefits: No firewall, No changing IPs, VM security
echo.
echo [OK] Ready for testing!