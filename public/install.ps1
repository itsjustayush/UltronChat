# ==============================================================================
# UltronChat Windows PowerShell Installer
# Run in PowerShell: irm https://ultronchat.vercel.app/install.ps1 | iex
# ==============================================================================

$ErrorActionPreference = 'Stop'

Write-Host "=======================================================" -ForegroundColor Cyan
Write-Host " ⚡ UltronChat Windows Terminal Installer" -ForegroundColor Cyan
Write-Host "=======================================================" -ForegroundColor Cyan
Write-Host ""

$installDir = Join-Path $HOME ".ultron\bin"
if (-not (Test-Path $installDir)) {
    New-Item -ItemType Directory -Path $installDir -Force | Out-Null
}

$serverUrl = "https://ultronchat.vercel.app"

# 1. Detect runtime: Node.js (preferred) or Python
$runtime = $null
$nodePath = (Get-Command node -ErrorAction SilentlyContinue)?.Source
$pythonPath = (Get-Command python -ErrorAction SilentlyContinue)?.Source

if ($nodePath) {
    $runtime = "node"
    $downloadUrl = "$serverUrl/ultron.mjs"
    $scriptDest = Join-Path $installDir "ultron.mjs"
    Write-Host "✔ Detected Node.js ($(node -v))" -ForegroundColor Green
} elseif ($pythonPath) {
    $runtime = "python"
    $downloadUrl = "$serverUrl/ultron.py"
    $scriptDest = Join-Path $installDir "ultron.py"
    Write-Host "✔ Detected Python ($(python --version))" -ForegroundColor Green
} else {
    Write-Host "✖ Error: Neither Node.js nor Python was found on your system." -ForegroundColor Red
    Write-Host "  Please install Node.js (https://nodejs.org) or Python (https://python.org) first."
    Exit 1
}

# 2. Download the CLI script
Write-Host "⬇ Downloading Ultron CLI..." -ForegroundColor Yellow
Invoke-RestMethod -Uri $downloadUrl -OutFile $scriptDest

# 3. Create ultron.cmd wrapper
$cmdFile = Join-Path $installDir "ultron.cmd"
if ($runtime -eq "node") {
    "@echo off`r`nnode `"%~dp0\ultron.mjs`" %*" | Set-Content -Path $cmdFile -Encoding ASCII
} else {
    "@echo off`r`npython `"%~dp0\ultron.py`" %*" | Set-Content -Path $cmdFile -Encoding ASCII
}

# 4. Create ultron.ps1 wrapper
$ps1File = Join-Path $installDir "ultron.ps1"
if ($runtime -eq "node") {
    "& node (Join-Path `$PSScriptRoot 'ultron.mjs') `$args" | Set-Content -Path $ps1File -Encoding UTF8
} else {
    "& python (Join-Path `$PSScriptRoot 'ultron.py') `$args" | Set-Content -Path $ps1File -Encoding UTF8
}

# 5. Add to User PATH if not already present
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$installDir*") {
    $newPath = "$installDir;$userPath"
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
}

# Also update current session Path so user can immediately run `ultron`
if ($env:Path -notlike "*$installDir*") {
    $env:Path = "$installDir;$env:Path"
}

Write-Host ""
Write-Host "=======================================================" -ForegroundColor Cyan
Write-Host " 🎉 UltronChat CLI installed successfully!" -ForegroundColor Green
Write-Host "=======================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Installed at: $installDir\ultron.cmd" -ForegroundColor Gray
Write-Host ""
Write-Host "You can now run 'ultron' directly from any terminal window:" -ForegroundColor White
Write-Host "  ultron create                      # Create a room & get share link" -ForegroundColor Yellow
Write-Host "  ultron join C4GQA5                 # Join room (files auto-saved to ./ultron)" -ForegroundColor Yellow
Write-Host "  ultron join https://ultronchat.vercel.app?room=C4GQA5" -ForegroundColor Yellow
Write-Host "  ultron send ./my-dataset.zip       # Send a file to connected peers" -ForegroundColor Yellow
Write-Host "  ultron status                      # Check active room and peers" -ForegroundColor Yellow
Write-Host "  ultron reset                       # Remove local ultron.json config" -ForegroundColor Yellow
Write-Host ""

