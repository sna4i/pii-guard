#Requires -Version 5.1
<#
.SYNOPSIS
  Register a Windows scheduled task that brings up the local-mask-mcp
  gateway on user login via WSL + Docker Compose.

.DESCRIPTION
  Chrome extensions cannot start processes on the host, so the best
  we can do is have Windows bring the gateway up for us on every
  login. This script registers a Task Scheduler job that runs:

      wsl.exe -d <distro> -- bash -c "cd <repo> && docker compose up -d"

  on login of the current user. The Docker container's
  ``restart: unless-stopped`` policy then keeps it alive across
  Docker daemon restarts.

.PARAMETER WslDistro
  WSL distribution to run docker in. Default: the first installed
  distro reported by ``wsl -l -v``.

.PARAMETER RepoPath
  WSL path to the masking-mcp repo. Default: tries to locate the
  repo from the script's own location under /mnt/*.

.PARAMETER Uninstall
  Remove the scheduled task.

.EXAMPLE
  # install on first-time setup
  PS> .\install-autostart.ps1

.EXAMPLE
  # remove
  PS> .\install-autostart.ps1 -Uninstall
#>
param(
  [string]$WslDistro = "",
  [string]$RepoPath = "",
  [switch]$Uninstall
)

$TaskName = "MaskMcpGatewayAutostart"

function Resolve-WslDistro {
  $distros = & wsl.exe -l -q 2>$null
  if (-not $distros) {
    throw "wsl.exe did not list any distribution. Install WSL first (wsl --install)."
  }
  ($distros -split "`n" | Where-Object { $_.Trim() -ne "" })[0].Trim()
}

function Resolve-RepoPath {
  # Infer from $PSScriptRoot — expect script to live in <repo>\scripts\.
  $repoRoot = Split-Path -Parent $PSScriptRoot
  if (-not (Test-Path (Join-Path $repoRoot "docker-compose.yml"))) {
    throw "docker-compose.yml not found at $repoRoot; pass -RepoPath <wsl-path>."
  }
  # Convert Windows path to WSL mount path.
  # C:\Users\<you>\workspace\mask-mcp -> /mnt/c/Users/<you>/workspace/mask-mcp
  $winPath = $repoRoot
  if ($winPath -match '^([A-Za-z]):\\(.*)$') {
    $drive = $matches[1].ToLower()
    $rest = $matches[2] -replace '\\','/'
    return "/mnt/$drive/$rest"
  }
  # Already a UNC / WSL-style path; pass through unchanged.
  return $winPath
}

if ($Uninstall) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "[autostart] scheduled task '$TaskName' removed."
  } else {
    Write-Host "[autostart] scheduled task '$TaskName' was not present."
  }
  exit 0
}

if (-not $WslDistro) { $WslDistro = Resolve-WslDistro }
if (-not $RepoPath)  { $RepoPath  = Resolve-RepoPath }

Write-Host "[autostart] distro : $WslDistro"
Write-Host "[autostart] repo   : $RepoPath"

$cmd = "cd $RepoPath && docker compose up -d"
# /C keeps the process alive only until the command completes; the
# container itself is managed by Docker's restart policy from then on.
$action  = New-ScheduledTaskAction `
  -Execute "wsl.exe" `
  -Argument "-d $WslDistro -- bash -lc `"$cmd`""

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RunOnlyIfNetworkAvailable:$false `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Description "Starts the local-mask-mcp gateway via WSL on login." `
  -Force | Out-Null

Write-Host "[autostart] task '$TaskName' registered."
Write-Host "[autostart] test by running it once now:"
Write-Host "            Start-ScheduledTask -TaskName $TaskName"
Write-Host "[autostart] remove with:"
Write-Host "            .\install-autostart.ps1 -Uninstall"
