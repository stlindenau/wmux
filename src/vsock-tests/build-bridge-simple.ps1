# Parts of this file are created by genAI.
# This notice needs to remain attached to any reproduction of or excerpt from this file.
# Agent: Claude Code
# AI-assisted: Yes
# See: docs/AGENTS.md for policy and provenance information

# Simple bridge builder - Windows compatible (no UTF-8 chars)

param(
    [switch]$SkipBuild,
    [switch]$TestOnly
)

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "=================================================="
Write-Host "wmux AF_HYPERV Bridge - PoC Builder"
Write-Host "=================================================="
Write-Host ""

try {
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $sourceFile = Join-Path $scriptDir "windows-hyperv-bridge.cs"
    $outputFile = Join-Path $scriptDir "wmux-hyperv-bridge.exe"

    # Check if source file exists
    if (-not (Test-Path $sourceFile)) {
        Write-Host "[ERROR] Source file not found: $sourceFile" -ForegroundColor Red
        exit 1
    }

    if (-not $SkipBuild) {
        Write-Host ""
        Write-Host "BUILDING BRIDGE"
        Write-Host "==============="

        Write-Host "[INFO] Locating C# compiler..." -ForegroundColor Yellow

        # Find C# compiler - simplified search
        $cscPath = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"

        if (-not (Test-Path $cscPath)) {
            # Try .NET Core/5+ CLI
            $dotnetPath = where.exe dotnet 2>$null
            if ($dotnetPath) {
                $cscPath = "dotnet"
            } else {
                Write-Host "[ERROR] C# compiler not found" -ForegroundColor Red
                Write-Host "        Install .NET Framework 4.0+ or .NET 6+" -ForegroundColor Yellow
                Write-Host "        Download: https://dotnet.microsoft.com/download" -ForegroundColor Yellow
                exit 1
            }
        }

        Write-Host "[OK] Found compiler: $cscPath" -ForegroundColor Green

        Write-Host "[INFO] Compiling bridge..." -ForegroundColor Yellow

        if ($cscPath -eq "dotnet") {
            # Use dotnet CLI - create minimal project
            $tempProject = @"
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net6.0</TargetFramework>
    <AssemblyName>wmux-hyperv-bridge</AssemblyName>
  </PropertyGroup>
</Project>
"@
            $tempProject | Out-File -FilePath (Join-Path $scriptDir "temp.csproj") -Encoding ASCII
            Copy-Item $sourceFile (Join-Path $scriptDir "Program.cs")

            dotnet build temp.csproj -c Release -o $scriptDir

            # Cleanup
            Remove-Item (Join-Path $scriptDir "temp.csproj") -ErrorAction SilentlyContinue
            Remove-Item (Join-Path $scriptDir "Program.cs") -ErrorAction SilentlyContinue
            Remove-Item (Join-Path $scriptDir "bin") -Recurse -ErrorAction SilentlyContinue
            Remove-Item (Join-Path $scriptDir "obj") -Recurse -ErrorAction SilentlyContinue
        } else {
            # Use .NET Framework csc
            & $cscPath /out:$outputFile $sourceFile
        }

        if ($LASTEXITCODE -ne 0) {
            Write-Host "[ERROR] Compilation failed" -ForegroundColor Red
            exit 1
        }

        Write-Host "[OK] Bridge compiled: $outputFile" -ForegroundColor Green
    }

    if (-not (Test-Path $outputFile)) {
        Write-Host "[ERROR] Bridge executable not found: $outputFile" -ForegroundColor Red
        exit 1
    }

    Write-Host ""
    Write-Host "TESTING INSTRUCTIONS"
    Write-Host "===================="
    Write-Host ""

    Write-Host "1. Start the bridge (as Administrator):" -ForegroundColor Cyan
    Write-Host "   .\wmux-hyperv-bridge.exe"
    Write-Host ""

    Write-Host "2. Test from WSL2:" -ForegroundColor Cyan
    Write-Host "   node wsl-vsock-client.js --message ""Hello Bridge!"""
    Write-Host ""

    Write-Host "3. Test named pipe (Windows):" -ForegroundColor Cyan
    Write-Host "   echo ""test"" | powershell -c ""Add-Type -AN System.Core; `$p = New-Object System.IO.Pipes.NamedPipeClientStream('wmux-bridge-poc'); `$p.Connect(5000); `$w = New-Object System.IO.StreamWriter(`$p); `$w.WriteLine('test'); `$w.Dispose(); `$p.Dispose()"""
    Write-Host ""

    Write-Host ""
    Write-Host "ARCHITECTURE"
    Write-Host "============"
    Write-Host "WSL2 (AF_VSOCK) <-> Windows Bridge <-> Named Pipe"
    Write-Host ""
    Write-Host "Benefits:"
    Write-Host "  * No firewall issues"
    Write-Host "  * No changing IP addresses"
    Write-Host "  * VM-level security"
    Write-Host "  * Direct wmux integration"
    Write-Host ""

    Write-Host "[OK] Bridge PoC ready for testing!" -ForegroundColor Green

} catch {
    Write-Host "[ERROR] Build failed: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host ""
    Write-Host "Troubleshooting:" -ForegroundColor Yellow
    Write-Host "  * Run as Administrator"
    Write-Host "  * Install .NET Framework 4.0+ or .NET 6+"
    Write-Host "  * Check antivirus blocking"
    exit 1
}