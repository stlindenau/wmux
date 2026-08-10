# Parts of this file are created by genAI.
# This notice needs to remain attached to any reproduction of or excerpt from this file.
# Agent: Claude Code
# AI-assisted: Yes
# See: docs/AGENTS.md for policy and provenance information

<#
.SYNOPSIS
Build and test the wmux AF_HYPERV bridge PoC

.DESCRIPTION
This script compiles the C# bridge and provides testing instructions
for the AF_HYPERV to Named Pipe bridge proof of concept.

.EXAMPLE
powershell -ExecutionPolicy Bypass build-and-test-bridge.ps1
#>

#Requires -RunAsAdministrator

param(
    [switch]$SkipBuild,
    [switch]$TestOnly
)

$ErrorActionPreference = "Stop"

function Write-Section {
    param([string]$Title)
    Write-Host ""
    Write-Host "=" * 50 -ForegroundColor Cyan
    Write-Host $Title -ForegroundColor Cyan
    Write-Host "=" * 50 -ForegroundColor Cyan
}

function Write-Step {
    param([string]$Message)
    Write-Host "🔧 $Message" -ForegroundColor Yellow
}

function Write-Success {
    param([string]$Message)
    Write-Host "✅ $Message" -ForegroundColor Green
}

function Write-Error {
    param([string]$Message)
    Write-Host "❌ $Message" -ForegroundColor Red
}

function Write-Info {
    param([string]$Message)
    Write-Host "ℹ️  $Message" -ForegroundColor Blue
}

Write-Section "wmux AF_HYPERV Bridge - PoC Builder"

try {
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $sourceFile = Join-Path $scriptDir "windows-hyperv-bridge.cs"
    $outputFile = Join-Path $scriptDir "wmux-hyperv-bridge.exe"

    # Check if source file exists
    if (-not (Test-Path $sourceFile)) {
        Write-Error "Source file not found: $sourceFile"
        exit 1
    }

    if (-not $SkipBuild) {
        Write-Section "🛠️  BUILDING BRIDGE"

        Write-Step "Locating C# compiler..."

        # Find C# compiler
        $cscPaths = @(
            "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
            "$env:ProgramFiles\dotnet\dotnet.exe"
        )

        $cscPath = $null
        foreach ($path in $cscPaths) {
            if (Test-Path $path) {
                $cscPath = $path
                break
            }
        }

        if (-not $cscPath) {
            Write-Error "C# compiler not found. Install .NET Framework or .NET SDK."
            Write-Info "Download from: https://dotnet.microsoft.com/download"
            exit 1
        }

        Write-Success "Found compiler: $cscPath"

        Write-Step "Compiling C# bridge..."

        if ($cscPath -like "*dotnet.exe") {
            # Use dotnet CLI
            $tempProject = @"
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net6.0</TargetFramework>
    <AssemblyName>wmux-hyperv-bridge</AssemblyName>
  </PropertyGroup>
</Project>
"@
            $tempDir = [System.IO.Path]::GetTempPath() + [System.Guid]::NewGuid().ToString()
            New-Item -ItemType Directory -Path $tempDir | Out-Null

            $tempProject | Out-File -FilePath (Join-Path $tempDir "bridge.csproj") -Encoding utf8
            Copy-Item $sourceFile (Join-Path $tempDir "Program.cs")

            Push-Location $tempDir
            try {
                & $cscPath build -c Release
                Copy-Item "bin\Release\net6.0\wmux-hyperv-bridge.exe" $outputFile
            } finally {
                Pop-Location
                Remove-Item -Recurse -Force $tempDir -ErrorAction SilentlyContinue
            }
        } else {
            # Use .NET Framework csc
            & $cscPath /out:$outputFile $sourceFile
        }

        if ($LASTEXITCODE -ne 0) {
            Write-Error "Compilation failed"
            exit 1
        }

        Write-Success "Bridge compiled: $outputFile"
    }

    if (-not (Test-Path $outputFile)) {
        Write-Error "Bridge executable not found: $outputFile"
        exit 1
    }

    Write-Section "🧪 TESTING INSTRUCTIONS"

    Write-Host ""
    Write-Host "1. Start the bridge (run as Administrator):" -ForegroundColor Cyan
    Write-Host "   .\wmux-hyperv-bridge.exe" -ForegroundColor White
    Write-Host ""

    Write-Host "2. Test from WSL2 (in another terminal):" -ForegroundColor Cyan
    Write-Host "   cd /workspaces/ms-container-feature-agent1/.tmp/wmux-fork/src/vsock-tests" -ForegroundColor White
    Write-Host "   node wsl-vsock-client.js --message `"Hello Bridge!`"" -ForegroundColor White
    Write-Host ""

    Write-Host "3. Test named pipe directly (from Windows):" -ForegroundColor Cyan
    Write-Host "   echo `"pipe test`" | powershell -c `"`$p = New-Object System.IO.Pipes.NamedPipeClientStream('.', 'wmux-bridge-poc'); `$p.Connect(); `$w = New-Object System.IO.StreamWriter(`$p); `$w.WriteLine('test'); `$w.Flush(); `$p.Close()`"" -ForegroundColor White
    Write-Host ""

    Write-Host "4. Alternative named pipe test:" -ForegroundColor Cyan
    Write-Host "   powershell -c `"Add-Type -AssemblyName System.Core; `$pipe = New-Object System.IO.Pipes.NamedPipeClientStream('wmux-bridge-poc'); `$pipe.Connect(5000); `$sw = New-Object System.IO.StreamWriter(`$pipe); `$sw.WriteLine('Hello from PowerShell'); `$sw.Dispose(); `$pipe.Dispose()`"" -ForegroundColor White
    Write-Host ""

    if (-not $TestOnly) {
        Write-Section "🚀 QUICK START"

        Write-Host "Ready to test the bridge! Follow these steps:" -ForegroundColor Green
        Write-Host ""
        Write-Host "Terminal 1 (Windows, as Administrator):" -ForegroundColor Yellow
        Write-Host "  .\wmux-hyperv-bridge.exe" -ForegroundColor White
        Write-Host ""
        Write-Host "Terminal 2 (WSL2):" -ForegroundColor Yellow
        Write-Host "  node wsl-vsock-client.js --message `"Test from WSL2`"" -ForegroundColor White
        Write-Host ""
        Write-Host "You should see message flow: WSL2 → AF_HYPERV → Named Pipe" -ForegroundColor Green
    }

    Write-Section "📋 ARCHITECTURE"

    Write-Host ""
    Write-Host "Data Flow:" -ForegroundColor Cyan
    Write-Host "  WSL2 Client (AF_VSOCK)" -ForegroundColor White
    Write-Host "       ↓" -ForegroundColor Gray
    Write-Host "  Windows Bridge (AF_HYPERV ← TCP simulation)" -ForegroundColor White
    Write-Host "       ↓" -ForegroundColor Gray
    Write-Host "  Named Pipe (\\\\.\\pipe\\wmux-bridge-poc)" -ForegroundColor White
    Write-Host "       ↓" -ForegroundColor Gray
    Write-Host "  [Future: wmux main process]" -ForegroundColor Gray
    Write-Host ""

    Write-Host "Benefits:" -ForegroundColor Cyan
    Write-Host "  ✅ No firewall issues" -ForegroundColor Green
    Write-Host "  ✅ No changing IP addresses" -ForegroundColor Green
    Write-Host "  ✅ Hypervisor-level security" -ForegroundColor Green
    Write-Host "  ✅ Integration with existing wmux named pipe" -ForegroundColor Green
    Write-Host ""

    Write-Success "Bridge PoC ready for testing!"

} catch {
    Write-Error "Build script failed: $($_.Exception.Message)"
    exit 1
}