# Parts of this file are created by genAI.
# This notice needs to remain attached to any reproduction of or excerpt from this file.
# Agent: Claude Code
# AI-assisted: Yes
# See: docs/AGENTS.md for policy and provenance information

<#
.SYNOPSIS
End-to-end test for the wmux AF_HYPERV bridge PoC

.DESCRIPTION
This script performs automated testing of the bridge components:
1. Named pipe connectivity
2. Bridge relay functionality
3. WSL2 integration (if available)

.EXAMPLE
powershell -ExecutionPolicy Bypass test-bridge-e2e.ps1
#>

param(
    [switch]$SkipWSL
)

$ErrorActionPreference = "Continue"

function Write-TestSection {
    param([string]$Title)
    Write-Host ""
    Write-Host "🧪 $Title" -ForegroundColor Blue
    Write-Host "=" * ($Title.Length + 3) -ForegroundColor Blue
}

function Write-TestStep {
    param([string]$Message)
    Write-Host "   $Message" -ForegroundColor Yellow
}

function Write-TestResult {
    param([string]$Message, [bool]$Success)
    $icon = if ($Success) { "✅" } else { "❌" }
    $color = if ($Success) { "Green" } else { "Red" }
    Write-Host "   $icon $Message" -ForegroundColor $color
}

function Test-NamedPipeConnectivity {
    Write-TestSection "Named Pipe Connectivity Test"

    $pipeName = "wmux-bridge-poc"
    $testMessage = "Test message from PowerShell at $(Get-Date)"

    Write-TestStep "Testing named pipe connection..."

    try {
        # Test connection timeout
        $pipe = New-Object System.IO.Pipes.NamedPipeClientStream('.', $pipeName, 'InOut')
        $connectTask = $pipe.ConnectAsync(3000) # 3 second timeout
        $connectTask.Wait()

        if ($pipe.IsConnected) {
            Write-TestResult "Named pipe connection established" $true

            # Test write
            $writer = New-Object System.IO.StreamWriter($pipe)
            $writer.WriteLine($testMessage)
            $writer.Flush()
            Write-TestResult "Message sent to named pipe" $true

            $writer.Dispose()
            $pipe.Dispose()
        } else {
            Write-TestResult "Named pipe connection failed" $false
        }
    } catch {
        if ($_.Exception.Message -like "*timeout*" -or $_.Exception.Message -like "*timed out*") {
            Write-TestResult "Named pipe connection timeout (bridge not running?)" $false
        } else {
            Write-TestResult "Named pipe error: $($_.Exception.Message)" $false
        }
    }
}

function Test-BridgeProcess {
    Write-TestSection "Bridge Process Test"

    Write-TestStep "Checking for running bridge process..."

    $bridgeProcess = Get-Process -Name "wmux-hyperv-bridge" -ErrorAction SilentlyContinue

    if ($bridgeProcess) {
        Write-TestResult "Bridge process is running (PID: $($bridgeProcess.Id))" $true
        Write-TestStep "Process details:"
        Write-Host "      Start Time: $($bridgeProcess.StartTime)" -ForegroundColor Gray
        Write-Host "      CPU Time: $($bridgeProcess.TotalProcessorTime)" -ForegroundColor Gray
        Write-Host "      Memory: $([math]::Round($bridgeProcess.WorkingSet64 / 1MB, 2)) MB" -ForegroundColor Gray
    } else {
        Write-TestResult "Bridge process not running" $false
        Write-TestStep "To start the bridge:"
        Write-Host "      .\wmux-hyperv-bridge.exe" -ForegroundColor White
    }
}

function Test-HypervRegistration {
    Write-TestSection "AF_HYPERV Service Registration Test"

    $serviceGuid = "3049197C-FACB-11E6-BD58-64006A7986D3"
    $registryPath = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Virtualization\GuestCommunicationServices\$serviceGuid"

    Write-TestStep "Checking AF_HYPERV service registration..."

    try {
        $regKey = Get-ItemProperty -Path $registryPath -ErrorAction Stop

        if ($regKey.ElementName) {
            Write-TestResult "AF_HYPERV service registered: $($regKey.ElementName)" $true
            Write-TestStep "Service GUID: $serviceGuid"
        } else {
            Write-TestResult "AF_HYPERV service found but missing ElementName" $false
        }
    } catch {
        Write-TestResult "AF_HYPERV service not registered" $false
        Write-TestStep "Bridge will register it automatically when run as Administrator"
    }
}

function Test-TcpConnectivity {
    Write-TestSection "TCP Connectivity Test (AF_HYPERV Simulation)"

    Write-TestStep "Testing TCP connection to 127.0.0.1:9787..."

    try {
        $tcpClient = New-Object System.Net.Sockets.TcpClient
        $connectTask = $tcpClient.ConnectAsync("127.0.0.1", 9787)
        $connectTask.Wait(5000) # 5 second timeout

        if ($tcpClient.Connected) {
            Write-TestResult "TCP connection successful" $true

            # Send test message
            $stream = $tcpClient.GetStream()
            $testData = [System.Text.Encoding]::UTF8.GetBytes("PowerShell test message`n")
            $stream.Write($testData, 0, $testData.Length)
            $stream.Flush()

            # Try to read response
            $buffer = New-Object byte[] 1024
            $bytesRead = $stream.Read($buffer, 0, 1024)

            if ($bytesRead -gt 0) {
                $response = [System.Text.Encoding]::UTF8.GetString($buffer, 0, $bytesRead)
                Write-TestResult "Received response: $($response.Trim())" $true
            }

            $tcpClient.Close()
        } else {
            Write-TestResult "TCP connection failed" $false
        }
    } catch {
        Write-TestResult "TCP connection error: $($_.Exception.Message)" $false
    }
}

function Test-WSLIntegration {
    Write-TestSection "WSL2 Integration Test"

    if ($SkipWSL) {
        Write-TestStep "Skipping WSL tests (--SkipWSL specified)"
        return
    }

    Write-TestStep "Checking WSL availability..."

    try {
        $wslVersion = wsl --version 2>$null
        if ($LASTEXITCODE -eq 0) {
            Write-TestResult "WSL is available" $true

            Write-TestStep "Testing VSOCK client from WSL..."

            # Check if the test script exists in WSL
            $scriptPath = "/workspaces/ms-container-feature-agent1/.tmp/wmux-fork/src/vsock-tests/wsl-vsock-client.js"
            $nodeTest = wsl bash -c "test -f '$scriptPath' && echo 'exists' || echo 'missing'"

            if ($nodeTest -like "*exists*") {
                Write-TestResult "WSL test script found" $true

                Write-TestStep "Running VSOCK client test..."
                $wslResult = wsl bash -c "cd '/workspaces/ms-container-feature-agent1/.tmp/wmux-fork/src/vsock-tests' && timeout 10 node wsl-vsock-client.js --message 'E2E test from WSL'"

                if ($LASTEXITCODE -eq 0) {
                    Write-TestResult "WSL VSOCK client test completed" $true
                } else {
                    Write-TestResult "WSL VSOCK client test failed (exit code: $LASTEXITCODE)" $false
                }
            } else {
                Write-TestResult "WSL test script not found: $scriptPath" $false
            }
        } else {
            Write-TestResult "WSL not available" $false
        }
    } catch {
        Write-TestResult "WSL test error: $($_.Exception.Message)" $false
    }
}

function Test-EndToEnd {
    Write-TestSection "End-to-End Bridge Test"

    Write-TestStep "Performing full bridge test..."

    $allTestsPassed = $true

    # Test sequence: TCP → Named Pipe
    try {
        Write-TestStep "Step 1: Send message via TCP (simulating AF_HYPERV)..."

        $tcpClient = New-Object System.Net.Sockets.TcpClient
        $tcpClient.Connect("127.0.0.1", 9787)

        if ($tcpClient.Connected) {
            $stream = $tcpClient.GetStream()
            $message = "E2E-Test-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
            $testData = [System.Text.Encoding]::UTF8.GetBytes("$message`n")
            $stream.Write($testData, 0, $testData.Length)
            $stream.Flush()

            Write-TestResult "Message sent via TCP" $true

            # Read response
            $buffer = New-Object byte[] 1024
            $bytesRead = $stream.Read($buffer, 0, 1024)

            if ($bytesRead -gt 0) {
                $response = [System.Text.Encoding]::UTF8.GetString($buffer, 0, $bytesRead)
                Write-TestResult "Bridge responded with: $($response.Trim())" $true
            }

            $tcpClient.Close()
        } else {
            Write-TestResult "TCP connection failed" $false
            $allTestsPassed = $false
        }

    } catch {
        Write-TestResult "E2E test failed: $($_.Exception.Message)" $false
        $allTestsPassed = $false
    }

    if ($allTestsPassed) {
        Write-TestResult "End-to-end test PASSED" $true
    } else {
        Write-TestResult "End-to-end test FAILED" $false
    }
}

# Main execution
Write-Host "🔍 wmux AF_HYPERV Bridge - End-to-End Test Suite" -ForegroundColor Cyan
Write-Host "===============================================" -ForegroundColor Cyan

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$bridgeExe = Join-Path $scriptDir "wmux-hyperv-bridge.exe"

if (-not (Test-Path $bridgeExe)) {
    Write-Host ""
    Write-Host "❌ Bridge executable not found: $bridgeExe" -ForegroundColor Red
    Write-Host "   Run build-and-test-bridge.ps1 first to compile the bridge" -ForegroundColor Yellow
    exit 1
}

# Run all tests
Test-BridgeProcess
Test-HypervRegistration
Test-TcpConnectivity
Test-NamedPipeConnectivity
Test-EndToEnd

if (-not $SkipWSL) {
    Test-WSLIntegration
}

Write-Host ""
Write-Host "🏁 Test suite completed!" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  • If bridge is not running: .\wmux-hyperv-bridge.exe" -ForegroundColor White
Write-Host "  • To test from WSL2: node wsl-vsock-client.js --message 'test'" -ForegroundColor White
Write-Host "  • Integration with wmux: Replace 'wmux-bridge-poc' with 'wmux' pipe" -ForegroundColor White