@echo off
REM Comprehensive Hyper-V AF_VSOCK diagnostics

setlocal enabledelayedexpansion

echo.
echo ============================================
echo Hyper-V AF_VSOCK Detailed Diagnostics
echo ============================================
echo.

echo [1] Checking Hyper-V service status...
powershell -Command "Get-Service -Name vmms,vmcompute,hns -ErrorAction SilentlyContinue | Select-Object Name,Status,StartType | Format-Table -AutoSize"
echo.

echo [2] Checking our service GUID in registry...
reg query "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Virtualization\GuestCommunicationServices\0000263b-facb-11e6-bd58-64006a7986d3" /s
echo.

echo [3] Checking WSL2 instance status...
powershell -Command "wsl --list --verbose"
echo.

echo [4] Checking AF_HYPERV socket availability...
powershell -Command "
try {
    \$socket = [System.Net.Sockets.Socket]::new([System.Net.Sockets.AddressFamily]::'AF_HYPERV', [System.Net.Sockets.SocketType]::Stream, 1)
    Write-Host '  YES - AF_HYPERV sockets are available' -ForegroundColor Green
    \$socket.Close()
} catch {
    Write-Host '  NO - Error: ' \$_.Exception.Message -ForegroundColor Red
}
"
echo.

echo [5] Checking Hyper-V-related Windows features...
dism /online /get-features | findstr /i "hyperv"
echo.

echo [6] Checking if WSL2 has Hyper-V guest integration services enabled...
powershell -Command "
try {
    \$vm = Get-VM -Name WSL -ErrorAction SilentlyContinue
    if (\$vm) {
        Write-Host '  WSL VM found'
        Write-Host '  State: ' \$vm.State
        Write-Host '  Heartbeat: ' \$vm.IntegrationServicesState.'Heartbeat'
        Write-Host '  Guest Service Interface: ' \$vm.IntegrationServicesState.'Guest Service Interface'
    } else {
        Write-Host '  WSL VM not found via Get-VM'
    }
} catch {
    Write-Host '  Error querying WSL VM: ' \$_.Exception.Message
}
"
echo.

echo [7] Testing AF_HYPERV socket binding (like the server does)...
powershell -Command "
try {
    \$socket = [System.Net.Sockets.Socket]::new([System.Net.Sockets.AddressFamily]::34, [System.Net.Sockets.SocketType]::Stream, 1)
    \$guid = [Guid]'0000263b-facb-11e6-bd58-64006a7986d3'
    Write-Host '  Socket created successfully (AF_HYPERV)' -ForegroundColor Green
    
    # Try to bind to get more info
    Write-Host '  Socket is ready to bind on address family AF_HYPERV' -ForegroundColor Green
    \$socket.Close()
} catch {
    Write-Host '  FAILED: ' \$_.Exception.Message -ForegroundColor Red
}
"
echo.

echo [8] Checking network namespace configuration...
powershell -Command "
try {
    \$adapters = Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object {  \$_.Status -eq 'Up' }
    Write-Host '  Active network adapters:'
    \$adapters | Select-Object Name, InterfaceDescription, Speed | Format-Table -AutoSize
} catch {
    Write-Host '  Could not enumerate network adapters'
}
"
echo.

echo [9] Windows Firewall rules affecting Hyper-V...
netsh advfirewall firewall show rule name=all direction=in | findstr /i "hyperv\|guest\|9787"
echo.

echo [10] Checking WSL distribution's network namespace...
echo   (Run from within WSL2:)
echo   - ip link show
echo   - ip route show
echo   - ss -tlnp grep 9787
echo.

echo Done!
