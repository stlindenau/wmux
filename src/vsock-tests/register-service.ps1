#!/usr/bin/env powershell
# Register AF_HYPERV service with required registry values

$guid = '0000263b-facb-11e6-bd58-64006a7986d3'
$regPath = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Virtualization\GuestCommunicationServices\$guid"

Write-Host "Setting AF_HYPERV service registry values..." -ForegroundColor Cyan
Write-Host "GUID: $guid" -ForegroundColor Gray
Write-Host ""

# Ensure the key exists
if (!(Test-Path $regPath)) {
    Write-Host "ERROR: Registry key does not exist. Run the server elevated first to create it." -ForegroundColor Red
    exit 1
}

# Set GuestDefinedCapabilities with curly braces (GUID format)
Write-Host "Setting GuestDefinedCapabilities..." -ForegroundColor Yellow
$capabilities = "{$guid}"
Set-ItemProperty -Path $regPath -Name "GuestDefinedCapabilities" -Value $capabilities -Type String -Force
Write-Host "  GuestDefinedCapabilities = $capabilities" -ForegroundColor Green

# Optional: Set Owner
Write-Host "Setting Owner..." -ForegroundColor Yellow
$owner = "ComputeSystem"
Set-ItemProperty -Path $regPath -Name "Owner" -Value $owner -Type String -Force
Write-Host "  Owner = $owner" -ForegroundColor Green

# Display all values
Write-Host ""
Write-Host "Registry values set:" -ForegroundColor Cyan
Get-ItemProperty -Path $regPath | Select-Object ElementName, GuestDefinedCapabilities, Owner | Format-Table -AutoSize

Write-Host "Done!" -ForegroundColor Green
