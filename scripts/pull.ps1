# Updates this checkout to the latest commit on the extension's branch.
# Usage: right-click -> Run with PowerShell, or:  powershell -ExecutionPolicy Bypass -File scripts\pull.ps1
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

$branch = git rev-parse --abbrev-ref HEAD
Write-Host "Repository: $repo"
Write-Host "Branch:     $branch"

git pull --ff-only origin $branch

$hash = git rev-parse --short HEAD
$date = git log -1 --format=%cI
Write-Host ""
Write-Host "Now at $hash ($date)" -ForegroundColor Green
Write-Host ""
Write-Host "Next: open chrome://extensions, click the reload icon on Foreword," -ForegroundColor Yellow
Write-Host "then open its options page and confirm it shows commit $hash." -ForegroundColor Yellow
if ($Host.Name -eq "ConsoleHost") { Read-Host "Press Enter to close" }
