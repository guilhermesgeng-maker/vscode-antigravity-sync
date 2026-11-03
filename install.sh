#!/usr/bin/env bash
set -e

REPO_URL="https://github.com/guilhermesgeng-maker/vscode-antigravity-sync.git"
EXT_ROOT="$HOME/.vscode/extensions"
TARGET_DIR="$EXT_ROOT/unified.agent-usage-monitor-1.0.0"

echo "[1/3] Sincronizando Unified Agent Usage Monitor do GitHub..."
mkdir -p "$EXT_ROOT"

if [ -d "$TARGET_DIR/.git" ]; then
  git -C "$TARGET_DIR" pull --rebase --autostash origin main
else
  rm -rf "$TARGET_DIR"
  git clone "$REPO_URL" "$TARGET_DIR"
fi

echo "[2/3] Aplicando configuracoes do Antigravity IDE (settings.json e keybindings.json)..."
if command -v node >/dev/null 2>&1; then
  node -e 'require(process.argv[1]).mergeAntigravityConfigsToLocal()' "$TARGET_DIR/auto_sync.js"
fi

echo "[3/3] Concluido! Recarregue a janela do VS Code (Developer: Reload Window)."
