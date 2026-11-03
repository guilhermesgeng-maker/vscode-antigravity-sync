# ==============================================================================
# Antigravity VS Code Style + Unified AG Usage Monitor — Bootstrap & Auto-Sync
# Repositório: https://github.com/guilhermesgeng-maker/vscode-antigravity-sync
# ==============================================================================
$ErrorActionPreference = "Stop"

$RepoUrl = "https://github.com/guilhermesgeng-maker/vscode-antigravity-sync.git"
$ExtRoot = Join-Path $env:USERPROFILE ".vscode\extensions"
$TargetDir = Join-Path $ExtRoot "unified.agent-usage-monitor-1.0.0"

Write-Host "`n[1/4] Sincronizando extensao Unified Agent Usage Monitor do GitHub..." -ForegroundColor Cyan
if (-not (Test-Path $ExtRoot)) {
    New-Item -ItemType Directory -Path $ExtRoot -Force | Out-Null
}

if (Test-Path (Join-Path $TargetDir ".git")) {
    Push-Location $TargetDir
    git fetch origin main
    git pull --rebase --autostash origin main
    Pop-Location
} else {
    if (Test-Path $TargetDir) {
        Remove-Item -Path $TargetDir -Recurse -Force
    }
    git clone $RepoUrl $TargetDir
}

Write-Host "[2/4] Removendo extensoes antigas duplicadas (se existirem)..." -ForegroundColor Cyan
$Obsolete = @(
    "jiajilah.agent-usage-monitor*",
    "narun-dev.antigravity-monitor*",
    "planken.agent-usage*",
    "crsx.ag-usage*"
)
foreach ($pattern in $Obsolete) {
    Get-ChildItem -Path $ExtRoot -Directory -Filter $pattern -ErrorAction SilentlyContinue | ForEach-Object {
        Write-Host "  -> Removendo $($_.Name)" -ForegroundColor Yellow
        Remove-Item -Path $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Host "[3/4] Aplicando settings.json, keybindings.json e registrando no VS Code..." -ForegroundColor Cyan
$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($NodeCmd) {
    & node -e "require(process.argv[1]).mergeAntigravityConfigsToLocal()" (Join-Path $TargetDir "auto_sync.js")
} else {
    $UserDir = Join-Path $env:APPDATA "Code\User"
    if (-not (Test-Path $UserDir)) { New-Item -ItemType Directory -Path $UserDir -Force | Out-Null }
    Copy-Item -Path (Join-Path $TargetDir "vscode-config\settings.json") -Destination (Join-Path $UserDir "settings.json") -Force
    Copy-Item -Path (Join-Path $TargetDir "vscode-config\keybindings.json") -Destination (Join-Path $UserDir "keybindings.json") -Force
}

Write-Host "[4/4] Verificando extensoes visuais do Antigravity IDE no VS Code..." -ForegroundColor Cyan
$CodeBin = "$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd"
if (-not (Test-Path $CodeBin)) {
    $CodeCmd = Get-Command code -ErrorAction SilentlyContinue
    if ($CodeCmd) { $CodeBin = $CodeCmd.Source }
}

if (Test-Path $CodeBin) {
    $ManifestPath = Join-Path $TargetDir "vscode-config\extensions-manifest.json"
    if (Test-Path $ManifestPath) {
        $Manifest = Get-Content $ManifestPath -Raw | ConvertFrom-Json
        $Installed = & $CodeBin --list-extensions
        foreach ($ext in $Manifest.install) {
            if ($Installed -notcontains $ext) {
                Write-Host "  -> Instalando $ext..." -ForegroundColor Gray
                & $CodeBin --install-extension $ext --force | Out-Null
            }
        }
    }
}

Write-Host "`nConcluido! A partir de agora o VS Code sincroniza e atualiza automaticamente via GitHub sempre que abrir." -ForegroundColor Green
Write-Host "Se o VS Code estiver aberto, pressione Ctrl+Shift+P -> 'Developer: Reload Window'." -ForegroundColor Green
