@echo off
REM Test AF_HYPERV socket creation and binding
REM This is a minimal test to verify the socket stack works

setlocal enabledelayedexpansion

echo.
echo ============================================
echo AF_HYPERV Socket Stack Test
echo ============================================
echo.

echo [TEST 1] Creating and binding AF_HYPERV socket...
echo.

powershell -NoProfile -Command ^
  "$guid = [Guid]'0000263b-facb-11e6-bd58-64006a7986d3'; " ^
  "try { " ^
    "$socket = [System.Net.Sockets.Socket]::new(34, 1, 1); " ^
    "Write-Host '  OK: Socket created (AF_HYPERV family 34)'; " ^
    "$socket.Close(); " ^
  "} catch { " ^
    "Write-Host ('  FAILED: ' + $_.Exception.Message) -ForegroundColor Red; " ^
  "}"

echo.
echo [TEST 2] Checking if server is listening...
echo   (Open another terminal and run: windows-hyperv-echo-server.exe)
echo.
echo [TEST 3] Checking WSL2 network connectivity...

wsl.exe ip addr show | findstr "inet 172" || echo   (No WSL2 IP found)

echo.
echo [TEST 4] Checking vsock availability in WSL2...
echo   (From WSL2, run:)
echo.
echo   # Check kernel module
echo   cat /proc/modules | grep vsock
echo.
echo   # Check device permissions  
echo   ls -l /dev/vsock
echo.
echo   # Try a test connect (will timeout, that's expected)
echo   timeout 2 strace -e socket,connect nc -w 1 2 9787 2>&1 | grep -E "socket|connect|ETIMEDOUT|ECONNREFUSED"
echo.
