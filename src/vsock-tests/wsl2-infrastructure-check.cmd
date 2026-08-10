@echo off
REM Investigate WSL2 actual infrastructure

echo.
echo ============================================
echo WSL2 Infrastructure Investigation
echo ============================================
echo.

echo [1] WSL2 running instances...
wsl.exe --list --verbose
echo.

echo [2] WSL2 distributions available...
wsl.exe --list --all
echo.

echo [3] Check if WSL2 is using Hyper-V or native virtualization...
powershell -Command "
Get-WmiObject -Class Win32_VirtualMachine -ErrorAction SilentlyContinue | Format-Table Name, State
if (\$?) {
    Write-Host '  (No traditional Hyper-V VMs found - this is expected for WSL2)'
}
"
echo.

echo [4] Checking Windows Subsystem for Linux service...
powershell -Command "
Get-Service -Name LxssManager, WslService -ErrorAction SilentlyContinue | Format-Table Name, Status
"
echo.

echo [5] Checking Hyper-V Compute services...
powershell -Command "
Get-Service -Name vmms, vmcompute, hns -ErrorAction SilentlyContinue | Format-Table Name, Status
"
echo.

echo [6] WSL2 network configuration from inside...
echo Running from WSL2:
echo.
wsl.exe ip addr show
echo.
wsl.exe ip route show
echo.

echo [7] WSL2 vsock configuration...
echo From WSL2:
echo.
wsl.exe cat /proc/net/vsock 2^>NUL || echo "  (vsock not available)"
echo.

echo [8] Checking if WSL2 has Hyper-V guest service support...
echo From WSL2:
echo.
wsl.exe cat /proc/modules ^| grep -i hyper || echo "  (hyper-related modules not loaded)"
echo.

echo [9] Check WSL2 kernel version...
wsl.exe uname -a
echo.

echo [10] Check WSL config...
type "%USERPROFILE%\.wslconfig" 2^>NUL || echo "  (No .wslconfig found - using defaults)"
echo.

echo [11] Listing Hyper-V utilities on Windows...
powershell -Command "
Get-Command -CommandType Application | Where-Object { \$_.Name -like '*hyper*' -or \$_.Name -like '*vm*' } | Select-Object Name | Sort-Object
"
echo.

echo [12] Checking WSL2 actual VM name internally...
echo From WSL2:
wsl.exe hostname
echo.
wsl.exe cat /proc/sys/kernel/hostname
echo.
