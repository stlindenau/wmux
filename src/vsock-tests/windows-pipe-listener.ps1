# Parts of this file are created by genAI.
# This notice needs to remain attached to any reproduction of or excerpt from this file.
# Agent: Claude Code
# AI-assisted: Yes
# See: docs/AGENTS.md for policy and provenance information

# Named Pipe Data Listener - See data coming through the bridge

param(
    [string]$PipeName = "wmux-bridge-poc"
)

Write-Host ""
Write-Host "===============================================" -ForegroundColor Cyan
Write-Host "Named Pipe Data Listener" -ForegroundColor Cyan
Write-Host "===============================================" -ForegroundColor Cyan
Write-Host "Pipe: \\.\pipe\$PipeName" -ForegroundColor Yellow
Write-Host "Listening for data from VSOCK bridge..." -ForegroundColor Yellow
Write-Host "Press Ctrl+C to stop" -ForegroundColor Yellow
Write-Host ""

$pipeClient = $null

try {
    while ($true) {
        try {
            Write-Host "[INFO] Connecting to named pipe..." -ForegroundColor Gray

            # Create named pipe client
            $pipeClient = New-Object System.IO.Pipes.NamedPipeClientStream('.', $PipeName, 'InOut')
            $pipeClient.Connect(5000)  # 5 second timeout

            Write-Host "[OK] Connected to named pipe!" -ForegroundColor Green
            Write-Host ""

            # Create reader
            $reader = New-Object System.IO.StreamReader($pipeClient)

            # Read data from pipe
            while ($pipeClient.IsConnected) {
                try {
                    $line = $reader.ReadLine()
                    if ($line -ne $null) {
                        $timestamp = Get-Date -Format "HH:mm:ss.fff"
                        Write-Host "[$timestamp] " -ForegroundColor Cyan -NoNewline
                        Write-Host "PIPE DATA: " -ForegroundColor Yellow -NoNewline
                        Write-Host $line -ForegroundColor White
                    }
                } catch {
                    break
                }
            }

        } catch [System.TimeoutException] {
            Write-Host "[WARN] No bridge running - retrying in 3 seconds..." -ForegroundColor Yellow
            Start-Sleep -Seconds 3
        } catch {
            Write-Host "[ERROR] Pipe error: $($_.Exception.Message)" -ForegroundColor Red
            Start-Sleep -Seconds 2
        } finally {
            if ($pipeClient) {
                $pipeClient.Dispose()
                $pipeClient = $null
            }
        }
    }
} catch {
    Write-Host "[ERROR] Listener failed: $($_.Exception.Message)" -ForegroundColor Red
} finally {
    if ($pipeClient) {
        $pipeClient.Dispose()
    }
    Write-Host ""
    Write-Host "Named pipe listener stopped." -ForegroundColor Gray
}