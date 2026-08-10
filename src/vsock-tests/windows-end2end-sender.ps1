# Parts of this file are created by genAI.
# This notice needs to remain attached to any reproduction of or excerpt from this file.
# Agent: Claude Code
# AI-assisted: Yes
# See: docs/AGENTS.md for policy and provenance information

# End-to-End Sender - Send data from Windows Named Pipe to WSL2 VSOCK

param(
    [string]$PipeName = "wmux-bridge-poc",
    [switch]$Interactive
)

Write-Host ""
Write-Host "===============================================" -ForegroundColor Cyan
Write-Host "End-to-End VSOCK Bridge Test" -ForegroundColor Cyan
Write-Host "===============================================" -ForegroundColor Cyan
Write-Host "Flow: Named Pipe → Bridge → AF_HYPERV → AF_VSOCK → WSL2" -ForegroundColor Yellow
Write-Host "Target: \\.\pipe\$PipeName" -ForegroundColor Yellow
Write-Host ""

function Send-TestMessage {
    param([string]$Message)

    try {
        Write-Host "[INFO] Connecting to named pipe..." -ForegroundColor Gray

        $pipeClient = New-Object System.IO.Pipes.NamedPipeClientStream('.', $PipeName, 'InOut')
        $pipeClient.Connect(5000)

        if ($pipeClient.IsConnected) {
            Write-Host "[OK] Connected to named pipe" -ForegroundColor Green

            $writer = New-Object System.IO.StreamWriter($pipeClient)
            $reader = New-Object System.IO.StreamReader($pipeClient)
            $writer.AutoFlush = $true

            # Send message
            $timestamp = Get-Date -Format "HH:mm:ss.fff"
            Write-Host "[$timestamp] SENDING: $Message" -ForegroundColor Yellow
            $writer.WriteLine($Message)

            # Wait for response from WSL2
            Write-Host "[$timestamp] Waiting for WSL2 response..." -ForegroundColor Gray

            $timeout = 10000 # 10 seconds
            $start = Get-Date

            while ((Get-Date) - $start -lt [TimeSpan]::FromMilliseconds($timeout)) {
                if ($pipeClient.IsConnected) {
                    try {
                        $response = $reader.ReadLine()
                        if ($response) {
                            $responseTime = Get-Date -Format "HH:mm:ss.fff"
                            Write-Host "[$responseTime] RECEIVED FROM WSL2: $response" -ForegroundColor Green

                            # Try to parse JSON response
                            try {
                                $jsonResponse = $response | ConvertFrom-Json
                                Write-Host "                     Response Details:" -ForegroundColor Cyan
                                Write-Host "                       Status: $($jsonResponse.status)" -ForegroundColor Cyan
                                Write-Host "                       Client: $($jsonResponse.clientId)" -ForegroundColor Cyan
                                Write-Host "                       Received at: $($jsonResponse.receivedAt)" -ForegroundColor Cyan
                            } catch {
                                # Not JSON, just display as text
                            }
                            return $true
                        }
                    } catch {
                        break
                    }
                }
                Start-Sleep -Milliseconds 100
            }

            Write-Host "[WARN] No response from WSL2 within timeout" -ForegroundColor Yellow
            return $false

        } else {
            Write-Host "[ERROR] Failed to connect to named pipe" -ForegroundColor Red
            return $false
        }

    } catch {
        Write-Host "[ERROR] Connection failed: $($_.Exception.Message)" -ForegroundColor Red
        return $false
    } finally {
        if ($pipeClient) {
            $pipeClient.Dispose()
        }
    }
}

# Main execution
if ($Interactive) {
    Write-Host "[INFO] Interactive mode - type messages to send to WSL2" -ForegroundColor Cyan
    Write-Host "       Press Enter on empty line to exit" -ForegroundColor Cyan
    Write-Host ""

    while ($true) {
        $input = Read-Host "Message"
        if ([string]::IsNullOrWhiteSpace($input)) {
            break
        }

        $success = Send-TestMessage $input
        if (-not $success) {
            Write-Host "[ERROR] Message failed - check bridge is running" -ForegroundColor Red
        }
        Write-Host ""
    }
} else {
    # Send test sequence
    Write-Host "[INFO] Sending test message sequence..." -ForegroundColor Cyan
    Write-Host ""

    $testMessages = @(
        "Hello from Windows Named Pipe!",
        '{"type":"test","source":"windows","destination":"wsl2"}',
        "End-to-end bridge test message",
        "Unicode test: 🚀🔗📡",
        '{"command":"status","requestId":"12345"}'
    )

    $successCount = 0

    foreach ($message in $testMessages) {
        $success = Send-TestMessage $message
        if ($success) {
            $successCount++
        }
        Start-Sleep -Seconds 1
        Write-Host ""
    }

    Write-Host "===============================================" -ForegroundColor Cyan
    Write-Host "End-to-End Test Results" -ForegroundColor Cyan
    Write-Host "===============================================" -ForegroundColor Cyan
    Write-Host "Messages sent: $($testMessages.Count)" -ForegroundColor Yellow
    Write-Host "Responses received: $successCount" -ForegroundColor Yellow

    if ($successCount -eq $testMessages.Count) {
        Write-Host "Status: SUCCESS - Full end-to-end connectivity!" -ForegroundColor Green
        Write-Host ""
        Write-Host "✅ Named Pipe → Bridge → AF_HYPERV → AF_VSOCK → WSL2" -ForegroundColor Green
        Write-Host "✅ WSL2 → AF_VSOCK → AF_HYPERV → Bridge → Named Pipe" -ForegroundColor Green
    } else {
        Write-Host "Status: PARTIAL - Some messages failed" -ForegroundColor Yellow
        Write-Host "Check that bridge and WSL2 server are running" -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "End-to-end test completed." -ForegroundColor Gray