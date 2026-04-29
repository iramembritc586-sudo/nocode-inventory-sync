$ErrorActionPreference = 'Stop'

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $projectRoot

$outputPath = Join-Path $projectRoot 'nocode\nocode.exe'
$outputDir = Split-Path -Parent $outputPath
New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
$diagnosticBatPath = Join-Path $outputDir 'start-nocode-diagnostic.bat'

$legacyPkgTag = 'v3.4'
$legacyNodeRuntime = 'node-v12.22.11-win-x64'
$legacyCacheDir = Join-Path $env:USERPROFILE ".pkg-cache\$legacyPkgTag"
$legacyCacheFile = Join-Path $legacyCacheDir 'fetched-v12.22.11-win-x64'
$legacyDownloadUrl = "https://github.com/vercel/pkg-fetch/releases/download/$legacyPkgTag/$legacyNodeRuntime"

$oldHttpProxy = $env:http_proxy
$oldHttpsProxy = $env:https_proxy
$oldHttpProxyUpper = $env:HTTP_PROXY
$oldHttpsProxyUpper = $env:HTTPS_PROXY

$env:http_proxy = ''
$env:https_proxy = ''
$env:HTTP_PROXY = ''
$env:HTTPS_PROXY = ''

try {
  New-Item -ItemType Directory -Path $legacyCacheDir -Force | Out-Null
  if (-not (Test-Path $legacyCacheFile)) {
    $tempRuntimePath = Join-Path $env:TEMP $legacyNodeRuntime
    Write-Host "Downloading Win7-Win11 runtime: $legacyDownloadUrl"
    Invoke-WebRequest -Uri $legacyDownloadUrl -OutFile $tempRuntimePath
    Move-Item -Path $tempRuntimePath -Destination $legacyCacheFile -Force
  }

  npx pkg@5.8.1 --config pkg.exe.json scripts/exe-server.cjs --targets node12-win-x64 --output $outputPath
  if (-not (Test-Path $outputPath)) {
    throw "EXE was not generated: $outputPath"
  }

  $diagnosticScript = @'
@echo off
setlocal
cd /d "%~dp0"
echo.
echo [NoCode] Starting nocode.exe (diagnostic mode)...
echo.
"%~dp0nocode.exe" --no-open
set EXIT_CODE=%ERRORLEVEL%
echo.
echo [NoCode] Process exited with code: %EXIT_CODE%
echo [NoCode] Runtime log: %APPDATA%\nocode-inventory-sync\nocode-runtime.log
if exist "%APPDATA%\nocode-inventory-sync\nocode-runtime.log" (
  echo.
  echo [NoCode] Last 40 log lines:
  powershell -NoProfile -Command "Get-Content -Path \"$env:APPDATA\nocode-inventory-sync\nocode-runtime.log\" -Tail 40"
)
echo.
pause
'@
  Set-Content -Path $diagnosticBatPath -Value $diagnosticScript -Encoding ASCII

  Write-Host "EXE generated at: $outputPath"
  Write-Host "Diagnostic launcher: $diagnosticBatPath"
} finally {
  $env:http_proxy = $oldHttpProxy
  $env:https_proxy = $oldHttpsProxy
  $env:HTTP_PROXY = $oldHttpProxyUpper
  $env:HTTPS_PROXY = $oldHttpsProxyUpper
}
