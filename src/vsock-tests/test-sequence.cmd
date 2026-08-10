@echo off
REM Step-by-step test sequence for AF_VSOCK connectivity

setlocal enabledelayedexpansion

echo.
echo ============================================
echo AF_VSOCK Connection Test Sequence
echo ============================================
echo.

echo STEP 1: Delete old registry entry to force re-registration...
echo.
reg delete "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Virtualization\GuestCommunicationServices\0000263b-facb-11e6-bd58-64006a7986d3" /f
echo.

echo STEP 2: Starting windows-hyperv-echo-server.exe elevated...
echo         (This will re-register the service with correct registry values)
echo.
powershell -NoProfile -Command "Start-Process -FilePath '%~dp0windows-hyperv-echo-server.exe' -Verb RunAs -Wait" 
echo.

echo Server stopped. Now test from WSL2:
echo.
echo STEP 3: From WSL2 terminal, run:
echo.
echo   cd /mnt/c/Users/lsi2abt/git/wmux/src/vsock-tests
echo   node wsl-vsock-echo-client.js --message "Hello vsock" --port 9787
echo.
echo If that times out, run diagnostics:
echo.
echo   bash wsl-diagnostic.sh 9787 "Hello vsock"
echo   (Output will be saved to vsock-strace.log)
echo.
pause
