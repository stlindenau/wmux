# Parts of this file are created by genAI.
# This notice needs to remain attached to any reproduction of or excerpt from this file.
# Agent: Claude Code
# AI-assisted: Yes
# See: docs/AGENTS.md for policy and provenance information

<#
.SYNOPSIS
Check AF_HYPERV support on Windows for wmux VSOCK bridge

.DESCRIPTION
This script validates whether Windows supports AF_HYPERV sockets
for communication with WSL2/containers via Hyper-V virtualization.

.EXAMPLE
powershell -ExecutionPolicy Bypass check-hyperv-support.ps1
#>

#Requires -RunAsAdministrator

param(
    [switch]$Save,
    [string]$OutputFile = "hyperv-check-results.json"
)

$ErrorActionPreference = "Continue"

# Results object
$Results = @{
    hyperv_available = $false
    hyperv_enabled = $false
    wsl2_available = $false
    af_hyperv_support = $false
    dotnet_version = $null
    platform_info = @{}
    registry_services = @()
    recommendations = @()
    summary = @{}
}

function Write-Section {
    param([string]$Title)
    Write-Host ""
    Write-Host "=" * 50 -ForegroundColor Cyan
    Write-Host $Title -ForegroundColor Cyan
    Write-Host "=" * 50 -ForegroundColor Cyan
}

function Write-Check {
    param(
        [string]$Message,
        [string]$Status,  # "OK", "WARN", "ERROR"
        [string]$Details = ""
    )

    $color = switch ($Status) {
        "OK" { "Green" }
        "WARN" { "Yellow" }
        "ERROR" { "Red" }
        default { "White" }
    }

    $icon = switch ($Status) {
        "OK" { "✅" }
        "WARN" { "⚠️ " }
        "ERROR" { "❌" }
        default { "ℹ️ " }
    }

    Write-Host "$icon $Message" -ForegroundColor $color
    if ($Details) {
        Write-Host "   $Details" -ForegroundColor Gray
    }
}

function Check-HyperVAvailability {
    Write-Section "🔍 HYPER-V AVAILABILITY CHECK"

    try {
        # Check Windows edition
        $osInfo = Get-CimInstance -ClassName Win32_OperatingSystem
        $edition = $osInfo.Caption
        Write-Check "Windows Edition: $edition" "OK"

        $Results.platform_info.windows_edition = $edition
        $Results.platform_info.windows_version = $osInfo.Version
        $Results.platform_info.windows_build = $osInfo.BuildNumber

        # Check if running on physical hardware vs VM
        $isVirtualMachine = (Get-CimInstance -ClassName Win32_ComputerSystem).Model -like "*Virtual*"
        if ($isVirtualMachine) {
            Write-Check "Running in virtual machine" "WARN" "Nested virtualization may be required"
            $Results.recommendations += "Ensure nested virtualization is enabled"
        } else {
            Write-Check "Running on physical hardware" "OK"
        }

        # Check CPU virtualization support
        $cpu = Get-CimInstance -ClassName Win32_Processor
        if ($cpu.VirtualizationFirmwareEnabled) {
            Write-Check "CPU virtualization enabled in firmware" "OK"
        } else {
            Write-Check "CPU virtualization disabled" "ERROR" "Enable VT-x/AMD-V in BIOS/UEFI"
            $Results.recommendations += "Enable CPU virtualization in BIOS/UEFI settings"
        }

        # Check Hyper-V feature availability
        $hypervFeature = Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All -ErrorAction SilentlyContinue
        if ($hypervFeature) {
            $Results.hyperv_available = $true
            if ($hypervFeature.State -eq "Enabled") {
                Write-Check "Hyper-V feature enabled" "OK"
                $Results.hyperv_enabled = $true
            } else {
                Write-Check "Hyper-V feature available but disabled" "WARN" "Enable with: Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All"
                $Results.recommendations += "Enable Hyper-V: Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All"
            }
        } else {
            Write-Check "Hyper-V feature not available" "ERROR" "Windows edition may not support Hyper-V"
            $Results.recommendations += "Upgrade to Windows Pro/Enterprise for Hyper-V support"
        }

    } catch {
        Write-Check "Error checking Hyper-V availability" "ERROR" $_.Exception.Message
    }
}

function Check-WSL2Support {
    Write-Section "🐧 WSL2 SUPPORT CHECK"

    try {
        # Check WSL installation
        $wslVersion = wsl --version 2>$null
        if ($LASTEXITCODE -eq 0) {
            Write-Check "WSL installed" "OK"
            Write-Host "   Version info:" -ForegroundColor Gray
            $wslVersion | ForEach-Object { Write-Host "     $_" -ForegroundColor Gray }

            # Check for WSL2 distributions
            $wslList = wsl --list --verbose 2>$null | Where-Object { $_ -match "VERSION" -or $_ -match "^\s*\*?\s*\S+" }
            if ($wslList) {
                $wsl2Distros = $wslList | Where-Object { $_ -match "\s+2\s*$" }
                if ($wsl2Distros) {
                    Write-Check "WSL2 distributions found" "OK"
                    $Results.wsl2_available = $true
                    $wsl2Distros | ForEach-Object {
                        $distro = $_.Trim() -replace '\s+', ' '
                        Write-Host "     $distro" -ForegroundColor Gray
                    }
                } else {
                    Write-Check "No WSL2 distributions found" "WARN" "Install a WSL2 distribution"
                    $Results.recommendations += "Install WSL2 distribution: wsl --install -d Ubuntu"
                }
            }
        } else {
            Write-Check "WSL not installed" "WARN" "Install with: wsl --install"
            $Results.recommendations += "Install WSL2: wsl --install"
        }

        # Check Virtual Machine Platform
        $vmpFeature = Get-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform -ErrorAction SilentlyContinue
        if ($vmpFeature -and $vmpFeature.State -eq "Enabled") {
            Write-Check "Virtual Machine Platform enabled" "OK"
        } else {
            Write-Check "Virtual Machine Platform disabled" "WARN"
            $Results.recommendations += "Enable Virtual Machine Platform for WSL2"
        }

    } catch {
        Write-Check "Error checking WSL2 support" "ERROR" $_.Exception.Message
    }
}

function Check-AFHypervSupport {
    Write-Section "🔌 AF_HYPERV SOCKET SUPPORT CHECK"

    try {
        # Check .NET availability for AF_HYPERV testing
        $dotnetVersions = @()

        # Check .NET Framework
        try {
            $netFxVersion = Get-ItemProperty "HKLM:SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full\" -Name Release -ErrorAction SilentlyContinue
            if ($netFxVersion) {
                $release = $netFxVersion.Release
                if ($release -ge 533320) { $version = "4.8.1" }
                elseif ($release -ge 528040) { $version = "4.8" }
                elseif ($release -ge 461808) { $version = "4.7.2" }
                else { $version = "4.x" }
                $dotnetVersions += ".NET Framework $version"
            }
        } catch {}

        # Check .NET (Core/5+)
        try {
            $dotnetInfo = dotnet --version 2>$null
            if ($LASTEXITCODE -eq 0) {
                $dotnetVersions += ".NET $dotnetInfo"
            }
        } catch {}

        if ($dotnetVersions.Count -gt 0) {
            Write-Check ".NET runtime available" "OK"
            $dotnetVersions | ForEach-Object { Write-Host "   $_" -ForegroundColor Gray }
            $Results.dotnet_version = $dotnetVersions -join ", "
            $Results.af_hyperv_support = $true
        } else {
            Write-Check ".NET runtime not found" "ERROR" "Install .NET for AF_HYPERV support"
            $Results.recommendations += "Install .NET: https://dotnet.microsoft.com/download"
        }

        # Check for existing Hyper-V socket services in registry
        $hypervServicesPath = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Virtualization\GuestCommunicationServices"
        if (Test-Path $hypervServicesPath) {
            $services = Get-ChildItem $hypervServicesPath -ErrorAction SilentlyContinue
            if ($services) {
                Write-Check "Existing AF_HYPERV services found" "OK"
                $Results.registry_services = @()
                $services | ForEach-Object {
                    $serviceName = Split-Path $_.Name -Leaf
                    $elementName = (Get-ItemProperty $_.PSPath -Name ElementName -ErrorAction SilentlyContinue).ElementName
                    $serviceInfo = @{
                        guid = $serviceName
                        name = $elementName
                    }
                    $Results.registry_services += $serviceInfo
                    Write-Host "   $serviceName`: $elementName" -ForegroundColor Gray
                }
            } else {
                Write-Check "No existing AF_HYPERV services" "WARN" "Services must be registered before use"
            }
        } else {
            Write-Check "AF_HYPERV registry path missing" "ERROR"
            $Results.recommendations += "Hyper-V integration may not be properly installed"
        }

    } catch {
        Write-Check "Error checking AF_HYPERV support" "ERROR" $_.Exception.Message
    }
}

function Test-HypervSocketCreation {
    Write-Section "🧪 AF_HYPERV SOCKET TEST"

    if (-not $Results.af_hyperv_support) {
        Write-Check "Skipping socket test - AF_HYPERV not supported" "WARN"
        return
    }

    try {
        # Create test .NET code to verify AF_HYPERV socket creation
        $testCode = @'
using System;
using System.Net.Sockets;

public class HypervSocketTest
{
    public static void Main()
    {
        try
        {
            // AF_HYPERV = 34
            var socket = new Socket((AddressFamily)34, SocketType.Stream, ProtocolType.Unspecified);
            Console.WriteLine("SUCCESS: AF_HYPERV socket created");
            socket.Close();
        }
        catch (Exception ex)
        {
            Console.WriteLine("ERROR: " + ex.Message);
        }
    }
}
'@

        # Save and compile test
        $testFile = [System.IO.Path]::GetTempFileName() + ".cs"
        $exeFile = [System.IO.Path]::ChangeExtension($testFile, ".exe")

        $testCode | Out-File -FilePath $testFile -Encoding utf8

        # Try to compile and run
        $cscPath = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
        if (Test-Path $cscPath) {
            $compileResult = & $cscPath /out:$exeFile $testFile 2>&1
            if ($LASTEXITCODE -eq 0) {
                $runResult = & $exeFile 2>&1
                if ($runResult -like "*SUCCESS*") {
                    Write-Check "AF_HYPERV socket creation test passed" "OK"
                } else {
                    Write-Check "AF_HYPERV socket creation failed" "ERROR" $runResult
                }
            } else {
                Write-Check "Failed to compile test code" "WARN" "Manual testing required"
            }
        } else {
            Write-Check ".NET Framework compiler not found" "WARN" "Manual testing required"
        }

        # Cleanup
        Remove-Item $testFile -ErrorAction SilentlyContinue
        Remove-Item $exeFile -ErrorAction SilentlyContinue

    } catch {
        Write-Check "Error during socket test" "ERROR" $_.Exception.Message
    }
}

function Generate-Summary {
    Write-Section "📊 SUMMARY AND RECOMMENDATIONS"

    $summary = @{
        hyperv_ready = $false
        major_blockers = @()
        minor_issues = @()
        next_steps = @()
    }

    # Check overall readiness
    if ($Results.hyperv_enabled -and $Results.wsl2_available -and $Results.af_hyperv_support) {
        $summary.hyperv_ready = $true
        Write-Check "AF_HYPERV is ready for wmux integration!" "OK"
    } else {
        Write-Check "AF_HYPERV is NOT ready" "ERROR"
    }

    # Identify blockers
    if (-not $Results.hyperv_available) {
        $summary.major_blockers += "Hyper-V not available (Windows edition)"
    }
    if (-not $Results.hyperv_enabled) {
        $summary.major_blockers += "Hyper-V not enabled"
    }
    if (-not $Results.wsl2_available) {
        $summary.major_blockers += "WSL2 not available"
    }
    if (-not $Results.af_hyperv_support) {
        $summary.major_blockers += ".NET runtime not available"
    }

    # Display blockers and recommendations
    if ($summary.major_blockers.Count -gt 0) {
        Write-Host ""
        Write-Host "🚫 Major blockers:" -ForegroundColor Red
        $summary.major_blockers | ForEach-Object { Write-Host "   • $_" -ForegroundColor Red }
    }

    if ($Results.recommendations.Count -gt 0) {
        Write-Host ""
        Write-Host "🔧 Recommendations:" -ForegroundColor Yellow
        $summary.next_steps = $Results.recommendations
        $Results.recommendations | ForEach-Object { Write-Host "   • $_" -ForegroundColor Yellow }
    }

    if ($summary.hyperv_ready) {
        Write-Host ""
        Write-Host "🚀 Ready to test AF_HYPERV connection!" -ForegroundColor Green
        Write-Host "   Run: node windows-hyperv-server.js" -ForegroundColor Green
    } else {
        Write-Host ""
        Write-Host "🔄 After fixing issues, run this script again to recheck" -ForegroundColor Yellow
    }

    $Results.summary = $summary
    return $summary
}

function Save-Results {
    param([string]$FilePath)

    try {
        $Results | ConvertTo-Json -Depth 10 | Out-File -FilePath $FilePath -Encoding utf8
        Write-Host ""
        Write-Host "📄 Results saved to: $FilePath" -ForegroundColor Green
    } catch {
        Write-Host ""
        Write-Host "⚠️  Could not save results: $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

# Main execution
try {
    Write-Host "🔍 AF_HYPERV Support Checker for Windows" -ForegroundColor Cyan
    Write-Host "=======================================" -ForegroundColor Cyan

    Check-HyperVAvailability
    Check-WSL2Support
    Check-AFHypervSupport
    Test-HypervSocketCreation
    $summary = Generate-Summary

    if ($Save) {
        Save-Results -FilePath $OutputFile
    }

    # Exit with appropriate code
    if ($summary.hyperv_ready) {
        exit 0
    } else {
        exit 1
    }

} catch {
    Write-Host ""
    Write-Host "❌ Unexpected error: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}