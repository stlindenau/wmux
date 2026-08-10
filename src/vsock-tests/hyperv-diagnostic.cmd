@echo off
REM Check Hyper-V guest communication configuration on Windows host

echo Hyper-V Guest Communication Diagnostics
echo ======================================
echo.

echo [1] Checking Guest Communication Services registry...
reg query "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Virtualization\GuestCommunicationServices\0000263b-facb-11e6-bd58-64006a7986d3"
echo.

echo [2] Checking Hyper-V Integration Services...
echo (Should see "Heartbeat", "Key-Value Pair Exchange", "Shutdown", "Time Synchronization", "Guest Service Interface")
wmic service where name like "vmms" get name,state,status
echo.

echo [3] Checking if WSL2 VM has guest communication enabled...
echo Running: Get-VM -Name WSL
powershell -Command "Get-VM -Name WSL -ErrorAction SilentlyContinue | Select-Object -Property Name,State"
echo.

echo [4] Checking Hyper-V socket support...
powershell -Command "Get-NetAdapterBinding -ComponentID ms_tcpip6 | Where-Object { \$_.Name -like '*Hyper*' }"
echo.

echo [5] Listing all registered guest communication services...
reg query "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Virtualization\GuestCommunicationServices"
echo.

echo [6] Checking for AF_HYPERV socket support...
echo Testing: socket(34, 1, 1) call in native code...
echo (If you see error 10041, AF_HYPERV is not available)
