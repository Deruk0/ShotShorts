# Build the portable ShotShorts executable without touching the workspace.
# Used by CI and for local repro of CI build issues.
#
# Steps:
#   1. clone the requested ref (defaults to HEAD) into a temp dir
#   2. npm ci (as CI does)
#   3. download FFmpeg into app/resources (CI does the same)
#   4. npm run app:build
#
# Usage:  powershell -File scripts/repro-ci-build.ps1 [-Ref v2.1.0] [-Keep]

param(
    [string]$Ref = 'HEAD',
    [switch]$Keep
)

$ErrorActionPreference = 'Stop'

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$temp = Join-Path $env:TEMP ("shotshorts-build-" + [guid]::NewGuid().ToString('N').Substring(0, 8))

Write-Host "[repro] repo : $repo"
Write-Host "[repro] ref  : $Ref"
Write-Host "[repro] dir  : $temp"

git -C $repo clone --quiet $repo $temp
if ($LASTEXITCODE -ne 0) { throw "git clone failed" }
git -C $temp checkout --quiet $Ref
if ($LASTEXITCODE -ne 0) { throw "git checkout $Ref failed" }

Push-Location $temp
try {
    Write-Host "[repro] npm ci"
    npm ci
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }

    Write-Host "[repro] downloading FFmpeg"
    $zip = Join-Path $temp 'ffmpeg.zip'
    Invoke-WebRequest -Uri 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' `
        -OutFile $zip -MaximumRedirection 5
    $dest = Join-Path $temp 'ffmpeg'
    Expand-Archive -Path $zip -DestinationPath $dest
    $bin = Get-ChildItem -Path $dest -Recurse -Filter 'ffmpeg.exe' | Select-Object -First 1
    $probe = Get-ChildItem -Path $dest -Recurse -Filter 'ffprobe.exe' | Select-Object -First 1
    if (-not $bin -or -not $probe) { throw 'ffmpeg.exe or ffprobe.exe not found in the archive' }
    New-Item -ItemType Directory -Force -Path (Join-Path $temp 'app/resources') | Out-Null
    Copy-Item $bin.FullName (Join-Path $temp 'app/resources/ffmpeg.exe') -Force
    Copy-Item $probe.FullName (Join-Path $temp 'app/resources/ffprobe.exe') -Force
    Remove-Item $zip, $dest -Recurse -Force

    Write-Host "[repro] building portable exe"
    npm run app:build
    if ($LASTEXITCODE -ne 0) { throw "app:build failed" }

    Get-ChildItem (Join-Path $temp 'Ready_App_EXE') | Select-Object Name, Length
    Write-Host "[repro] SUCCESS"
}
finally {
    Pop-Location
    if (-not $Keep) {
        Remove-Item $temp -Recurse -Force -ErrorAction SilentlyContinue
    } else {
        Write-Host "[repro] kept temp dir: $temp"
    }
}
