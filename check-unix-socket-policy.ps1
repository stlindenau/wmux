$ErrorActionPreference = 'Continue'

Write-Host "=== Windows Unix Socket Policy and Capability Report ===" -ForegroundColor Cyan
Write-Host ""

function Add-Section($title) {
  Write-Host ""
  Write-Host ("--- " + $title + " ---") -ForegroundColor Yellow
}

function Safe-Run($name, [scriptblock]$block) {
  try {
    & $block
  } catch {
    Write-Host ($name + ": FAILED - " + $_.Exception.Message) -ForegroundColor Red
  }
}

$report = [ordered]@{
  Timestamp = (Get-Date).ToString("s")
  Computer = $env:COMPUTERNAME
  User = $env:USERNAME
  PSVersion = $PSVersionTable.PSVersion.ToString()
  OSVersion = $null
  WindowsBuild = $null
  AFUnixBuildEligible = $false
  DotNetUnixEndpointType = $false
  DefenderAvailable = $false
  ControlledFolderAccessEnabled = $null
  AsrBlockRuleCount = 0
  AsrAuditRuleCount = 0
  ActiveAV = @()
  AppLockerCmdletAvailable = $false
  AppLockerPolicyRead = $false
  NodeFound = $false
  NodeVersion = $null
  NodeUnixSocketBind = "NotRun"
  NodeUnixSocketError = $null
}

Add-Section "OS and Runtime"
Safe-Run "OS version check" {
  $osv = [System.Environment]::OSVersion.Version
  $report.OSVersion = $osv.ToString()
  $report.WindowsBuild = $osv.Build
  $report.AFUnixBuildEligible = ($osv.Build -ge 17063)

  Write-Host ("PowerShell: " + $report.PSVersion)
  Write-Host ("OS Version: " + $report.OSVersion)
  Write-Host ("Windows Build: " + $report.WindowsBuild)
  Write-Host ("AF_UNIX build eligible (>=17063): " + $report.AFUnixBuildEligible)
}

Safe-Run ".NET UnixDomainSocketEndPoint type check" {
  $t = [System.Net.Sockets.Socket].Assembly.GetType('System.Net.Sockets.UnixDomainSocketEndPoint')
  $report.DotNetUnixEndpointType = [bool]$t
  Write-Host ("UnixDomainSocketEndPoint type available: " + $report.DotNetUnixEndpointType)
}

Add-Section "Defender and Security Policy"
Safe-Run "Defender preference check" {
  if (Get-Command Get-MpPreference -ErrorAction SilentlyContinue) {
    $report.DefenderAvailable = $true
    $mp = Get-MpPreference

    $cfa = $mp.ControlledFolderAccessEnabled
    if ($null -eq $cfa) { $cfa = "Unknown" }
    $report.ControlledFolderAccessEnabled = $cfa

    $ids = @($mp.AttackSurfaceReductionRules_Ids)
    $actions = @($mp.AttackSurfaceReductionRules_Actions)
    $min = [Math]::Min($ids.Count, $actions.Count)

    $blockCount = 0
    $auditCount = 0
    for ($i = 0; $i -lt $min; $i++) {
      if ($actions[$i] -eq 1) { $blockCount++ }
      if ($actions[$i] -eq 2) { $auditCount++ }
    }
    $report.AsrBlockRuleCount = $blockCount
    $report.AsrAuditRuleCount = $auditCount

    Write-Host ("Defender cmdlets available: True")
    Write-Host ("Controlled Folder Access: " + $report.ControlledFolderAccessEnabled)
    Write-Host ("ASR rules in Block mode: " + $report.AsrBlockRuleCount)
    Write-Host ("ASR rules in Audit mode: " + $report.AsrAuditRuleCount)
  } else {
    Write-Host "Defender cmdlets available: False"
  }
}

Safe-Run "Active AV provider check" {
  $av = Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct -ErrorAction Stop |
    Select-Object -Property displayName, productState, pathToSignedProductExe
  if ($av) {
    $report.ActiveAV = @($av.displayName)
    Write-Host "Active AV products:"
    $av | Format-Table -AutoSize
  } else {
    Write-Host "No AV products returned by SecurityCenter2."
  }
}

Add-Section "AppLocker and Code Integrity"
Safe-Run "AppLocker availability" {
  $hasAppLocker = [bool](Get-Command Get-AppLockerPolicy -ErrorAction SilentlyContinue)
  $report.AppLockerCmdletAvailable = $hasAppLocker
  Write-Host ("Get-AppLockerPolicy available: " + $hasAppLocker)

  if ($hasAppLocker) {
    try {
      $null = Get-AppLockerPolicy -Effective -ErrorAction Stop
      $report.AppLockerPolicyRead = $true
      Write-Host "AppLocker effective policy: readable"
    } catch {
      Write-Host ("AppLocker effective policy: not readable - " + $_.Exception.Message)
    }
  }
}

Safe-Run "Recent Code Integrity events" {
  $ci = Get-WinEvent -LogName "Microsoft-Windows-CodeIntegrity/Operational" -MaxEvents 50 -ErrorAction Stop |
    Select-Object TimeCreated, Id, LevelDisplayName, Message
  if ($ci) {
    Write-Host "Recent Code Integrity events (last 50):"
    $ci | Select-Object -First 10 | Format-Table -AutoSize
  } else {
    Write-Host "No Code Integrity events found."
  }
}

Add-Section "ACL check on likely socket directories"
Safe-Run "Directory ACLs" {
  $paths = @(
    $env:TEMP,
    $env:APPDATA,
    $env:USERPROFILE,
    [System.IO.Path]::GetTempPath()
  ) | Where-Object { $_ } | Select-Object -Unique

  foreach ($p in $paths) {
    Write-Host ""
    Write-Host ("Path: " + $p) -ForegroundColor Gray
    try {
      (Get-Acl -Path $p).Access |
        Select-Object IdentityReference, FileSystemRights, AccessControlType, IsInherited |
        Format-Table -AutoSize
    } catch {
      Write-Host ("ACL read failed: " + $_.Exception.Message) -ForegroundColor Red
    }
  }
}

Add-Section "Node Unix socket bind probe"
Safe-Run "Node check and bind test" {
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $nodeCmd) {
    $report.NodeFound = $false
    $report.NodeUnixSocketBind = "Skipped"
    Write-Host "Node not found, skipping Node bind probe."
    return
  }

  $report.NodeFound = $true
  $report.NodeVersion = (& node -v 2>$null)
  Write-Host ("Node found: " + $report.NodeVersion)

  $tmp = [System.IO.Path]::GetTempPath()
  $sock = Join-Path $tmp ("wmux-policy-probe-" + [guid]::NewGuid().ToString("N") + ".sock")
  $nodeScript = @"
const net = require('net');
const fs = require('fs');
const p = process.argv[1];
try { fs.unlinkSync(p); } catch {}
const s = net.createServer();
s.once('error', (e) => {
  console.log('FAIL|' + (e.code || '') + '|' + e.message);
  process.exit(1);
});
s.listen(p, () => {
  console.log('PASS|' + p);
  s.close(() => {
    try { fs.unlinkSync(p); } catch {}
    process.exit(0);
  });
});
"@

  $out = & node -e $nodeScript $sock 2>&1
  $text = ($out | Out-String).Trim()

  if ($LASTEXITCODE -eq 0 -and $text -like "PASS*") {
    $report.NodeUnixSocketBind = "Pass"
    Write-Host ("Node Unix socket bind: PASS (" + $sock + ")") -ForegroundColor Green
  } else {
    $report.NodeUnixSocketBind = "Fail"
    $report.NodeUnixSocketError = $text
    Write-Host ("Node Unix socket bind: FAIL -> " + $text) -ForegroundColor Red
  }
}

Add-Section "Verdict"
if (-not $report.AFUnixBuildEligible) {
  Write-Host "Result: Platform too old for AF_UNIX support." -ForegroundColor Red
} elseif ($report.NodeUnixSocketBind -eq "Pass") {
  Write-Host "Result: Unix socket capability is working on this machine." -ForegroundColor Green
  if ($report.AsrBlockRuleCount -gt 0) {
    Write-Host "Note: ASR block rules exist, but current bind probe still succeeded."
  }
} elseif ($report.NodeUnixSocketBind -eq "Fail") {
  Write-Host "Result: Unix socket bind failed in Node." -ForegroundColor Red
  Write-Host "Most likely causes: endpoint security policy outside Defender, ACL/path issue, or runtime-specific behavior."
} else {
  Write-Host "Result: Inconclusive (Node probe not run)." -ForegroundColor Yellow
}

Add-Section "Machine-readable summary (JSON)"
$report | ConvertTo-Json -Depth 5