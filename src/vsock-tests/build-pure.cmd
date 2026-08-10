@echo off
REM Pure VSOCK bridge builder - NO TCP

echo.
echo ==============================================
echo Pure AF_HYPERV VSOCK Bridge Builder
echo ==============================================
echo NO TCP - Pure VSOCK only
echo.

if not exist "windows-hyperv-bridge-pure.cs" (
    echo [ERROR] Source file not found: windows-hyperv-bridge-pure.cs
    exit /b 1
)

echo [INFO] Building pure VSOCK bridge (NO TCP)
echo [INFO] Locating .NET Framework compiler...

set CSC_PATH=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe

if not exist "%CSC_PATH%" (
    echo [ERROR] .NET Framework compiler not found
    exit /b 1
)

echo [OK] Found .NET Framework compiler

echo [INFO] Compiling pure VSOCK bridge...
"%CSC_PATH%" /out:wmux-hyperv-bridge-pure.exe windows-hyperv-bridge-pure.cs

if %errorlevel% neq 0 (
    echo [ERROR] Compilation failed
    exit /b 1
)

echo [OK] Pure VSOCK bridge compiled successfully!
echo.
echo ==============================================
echo PURE VSOCK DEMO READY
echo ==============================================
echo.
echo 1. Start pure bridge (as Administrator):
echo    wmux-hyperv-bridge-pure.exe
echo.
echo 2. Install node-vsock in WSL2:
echo    ./install-node-vsock.sh
echo.
echo 3. Test pure VSOCK:
echo    node wsl-vsock-pure.js --message "Live VSOCK test!"
echo.
echo ARCHITECTURE: WSL2 (AF_VSOCK) ^<-^> Windows (AF_HYPERV) ^<-^> Named Pipe
echo BENEFITS: No TCP, No firewall, No changing IPs, Pure VM communication
echo.
echo [OK] Ready for live VSOCK demonstration!