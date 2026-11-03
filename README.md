# 🚀 VS Code Antigravity Setup & Unified AI Usage Monitor (`vscode-antigravity-sync`)

Repositório de sincronização automática para deixar o **VS Code** idêntico ao **Antigravity IDE** e instalar/atualizar automaticamente a extensão unificada **`unified.agent-usage-monitor`** (combinando **AG Usage** + **Antigravity/Gemini/Argon** + **OpenAI Codex/Astra** + **Claude Code**).

---

## ⚡ Instalação em 1 Comando (Em qualquer computador novo)

### No Windows (PowerShell):
```powershell
irm https://raw.githubusercontent.com/guilhermesgeng-maker/vscode-antigravity-sync/main/install.ps1 | iex
```

### No Linux / macOS (Terminal):
```bash
curl -fsSL https://raw.githubusercontent.com/guilhermesgeng-maker/vscode-antigravity-sync/main/install.sh | bash
```

---

## 🔄 Como funciona a Atualização Automática entre PCs

Depois de rodar o comando acima **uma única vez** em cada computador:
1. **Auto-Update ao abrir o VS Code (e a cada 30 min)**:
   - A própria extensão (`auto_sync.js`) executa `git fetch origin main` em segundo plano dentro de `~/.vscode/extensions/unified.agent-usage-monitor-1.0.0`.
   - Sempre que houver uma nova atualização no GitHub, ela faz `git pull`, atualiza o `settings.json` e `keybindings.json` locais e exibe um aviso com botão **`Recarregar Agora`**.
2. **Enviar alterações feitas em um PC para todos os outros (`Push`)**:
   - Pelo Dashboard (**botão `⬆ Push`** no topo), pelo Hover da Status Bar (**link `Sync`**) ou pela paleta de comandos (`Ctrl+Shift+P` → **`AG Usage: Push Local Changes & Configs to GitHub`**), qualquer ajuste feito em um computador é enviado para o GitHub e baixado automaticamente nos outros computadores.
