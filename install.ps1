# kilo-gateway installer for Windows (PowerShell 5.1+ or PowerShell 7).
#
#   irm https://raw.githubusercontent.com/dumbzombies/kilo-gateway/main/install.ps1 | iex
#
# Installs Bun if missing, clones the repo, builds a self-contained .exe and
# prints the dashboard URL. Re-running upgrades in place.
#
# Environment overrides:
#   $env:KG_DIR      install directory   (default: $HOME\.kilo-gateway)
#   $env:KG_PORT     port for the URL    (default: 8080)
#   $env:KG_NO_BUILD 1 to run from source instead of compiling

$ErrorActionPreference = "Stop"

$Repo   = "https://github.com/dumbzombies/kilo-gateway.git"
$Dir    = if ($env:KG_DIR) { $env:KG_DIR } else { Join-Path $HOME ".kilo-gateway" }
$Port   = if ($env:KG_PORT) { $env:KG_PORT } else { 8080 }
$BinDir = Join-Path $HOME ".kilo-gateway\bin"

function Info($msg) { Write-Host "==> $msg" -ForegroundColor Yellow }
function Warn($msg) { Write-Host "warn: $msg" -ForegroundColor Red }

# ---- prerequisites ---------------------------------------------------------

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Warn "git is required. Install it first: https://git-scm.com/download/win"
    Warn "or run: winget install --id Git.Git"
    exit 1
}

function Add-ToPath($path) {
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($userPath -split ";" -notcontains $path) {
        [Environment]::SetEnvironmentVariable("Path", "$userPath;$path", "User")
    }
    $env:Path = "$env:Path;$path"
}

# ---- bun -------------------------------------------------------------------

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    Info "installing Bun"
    irm bun.sh/install.ps1 | iex
    $bunBin = Join-Path $HOME ".bun\bin"
    if (Test-Path $bunBin) { Add-ToPath $bunBin }
}

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    Warn "Bun installed but is not on PATH. Open a new terminal and re-run."
    exit 1
}
Info "bun $(bun --version)"

# ---- source ----------------------------------------------------------------

if (Test-Path (Join-Path $Dir ".git")) {
    Info "updating $Dir"
    git -C $Dir pull --ff-only --quiet
} else {
    Info "cloning into $Dir"
    New-Item -ItemType Directory -Force -Path (Split-Path $Dir) | Out-Null
    git clone --depth 1 --quiet $Repo $Dir
}

Push-Location $Dir
try {
    Info "installing dependencies"
    bun install --silent

    New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

    if ($env:KG_NO_BUILD -eq "1") {
        $launcher = Join-Path $BinDir "kilo-gateway.cmd"
        "@echo off`r`n bun `"$Dir\src\server.ts`" %*" | Set-Content -Path $launcher -Encoding ASCII
        Info "installed launcher (source mode) at $launcher"
    } else {
        Info "compiling a self-contained kilo-gateway.exe (about 90 MB)"
        bun build --compile src/server.ts --outfile (Join-Path $BinDir "kilo-gateway.exe") | Out-Null
        Info "installed $(Join-Path $BinDir 'kilo-gateway.exe')"
    }
} finally {
    Pop-Location
}

Add-ToPath $BinDir

$DataDir = Join-Path $HOME ".kilo-gateway-data"
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

Write-Host ""
Write-Host "kilo-gateway is installed." -ForegroundColor Green
Write-Host ""
Write-Host "Start it:"
Write-Host "  `$env:DATA_DIR = `"$DataDir`"; kilo-gateway"
Write-Host ""
Write-Host "Then open:"
Write-Host "  http://127.0.0.1:$Port/"
Write-Host ""
Write-Host "Notes:" -ForegroundColor Yellow
Write-Host "  - The dashboard is open until you set ADMIN_TOKEN. For anything reachable"
Write-Host "    from a network, set one first:"
Write-Host "        `$env:ADMIN_TOKEN = -join ((48..57)+(97..102) | Get-Random -Count 48 | % {[char]`$_})"
Write-Host "  - Upstream credentials are pooled in $HOME\.kilo-gateway\keys.json,"
Write-Host "    or add them at runtime under Settings -> Upstream accounts."
Write-Host "  - WARP egress rotation needs an HTTP CONNECT proxy and is Bun-only; see README."
