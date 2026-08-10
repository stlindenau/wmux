# Parts of this file are created by genAI.
# This notice needs to remain attached to any reproduction of or excerpt from this file.
# Agent: Claude Code
# AI-assisted: Yes
# See: docs/AGENTS.md for policy and provenance information

# Simple pipe test client to debug connection issues

param(
    [string]$PipeName = "wmux-bridge-poc",
    [string]$Message = "Test message from PowerShell"
)

Write-Host ""
Write-Host "===============================================" -ForegroundColor Cyan
Write-Host "Named Pipe Test Client" -ForegroundColor Cyan
Write-Host "===============================================" -ForegroundColor Cyan
Write-Host "Target pipe: \\.\pipe\$PipeName" -ForegroundColor Yellow
Write-Host ""

try {
    Write-Host "[INFO] Connecting to named pipe..." -ForegroundColor Gray

    # Create pipe client
    $pipeClient = New-Object System.IO.Pipes.NamedPipeClientStream('.', $PipeName, 'InOut')

    # Connect with timeout
    $pipeClient.Connect(5000)

    if ($pipeClient.IsConnected) {
        Write-Host "[OK] Connected successfully!" -ForegroundColor Green

        # Create reader and writer
        $writer = New-Object System.IO.StreamWriter($pipeClient)
        $reader = New-Object System.IO.StreamReader($pipeClient)

        $writer.AutoFlush = $true

        # Send message
        Write-Host "[INFO] Sending: $Message" -ForegroundColor Yellow
        $writer.WriteLine($Message)

        # Wait for response
        Write-Host "[INFO] Waiting for response..." -ForegroundColor Gray

        $timeout = 5000 # 5 seconds
        $start = Get-Date

        while ((Get-Date) - $start -lt [TimeSpan]::FromMilliseconds($timeout)) {
            if ($pipeClient.IsConnected) {
                try {
                    $response = $reader.ReadLine()
                    if ($response) {
                        Write-Host "[OK] Received: $response" -ForegroundColor Green
                        break
                    }
                } catch {
                    break
                }
            }
            Start-Sleep -Milliseconds 100
        }

        # Send a few more test messages
        Write-Host ""
        Write-Host "[INFO] Sending additional test messages..." -ForegroundColor Yellow

        $testMessages = @(
            "Message 1",
            "Message 2",
            '{"type":"json","data":"test"}',
            "Final message"
        )

        foreach ($msg in $testMessages) {
            Write-Host "   Sending: $msg" -ForegroundColor Gray
            $writer.WriteLine($msg)
            Start-Sleep -Milliseconds 200

            # Try to read response
            try {
                $response = $reader.ReadLine()
                if ($response) {
                    Write-Host "   Response: $response" -ForegroundColor Green
                }
            } catch {
                Write-Host "   No response" -ForegroundColor Yellow
            }
        }

        $writer.Dispose()
        $reader.Dispose()

    } else {
        Write-Host "[ERROR] Failed to connect" -ForegroundColor Red
    }

} catch {
    Write-Host "[ERROR] Connection failed: $($_.Exception.Message)" -ForegroundColor Red

    if ($_.Exception.Message -like "*timeout*") {
        Write-Host "   Possible causes:" -ForegroundColor Yellow
        Write-Host "   - Bridge not running" -ForegroundColor Yellow
        Write-Host "   - Pipe name mismatch" -ForegroundColor Yellow
        Write-Host "   - Permission issues" -ForegroundColor Yellow
    }
} finally {
    if ($pipeClient) {
        $pipeClient.Dispose()
    }
}

Write-Host ""
Write-Host "Pipe test completed." -ForegroundColor Gray