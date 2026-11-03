// Built-in GitHub Auto-Update & Multi-Machine Config Sync for Unified Agent Usage Monitor
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const EXT_DIR = __dirname;
const CONFIG_DIR = path.join(EXT_DIR, 'vscode-config');

function runGit(args, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd: EXT_DIR, timeout: timeoutMs, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error((stderr || stdout || err.message || 'git error').trim()));
          return;
        }
        resolve(String(stdout || '').trim());
      }
    );
  });
}

function getVsCodeUserDir() {
  const platform = os.platform();
  if (platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'Code', 'User');
  }
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User');
  }
  return path.join(os.homedir(), '.config', 'Code', 'User');
}

function safeReadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function ensureExtensionRegistered() {
  try {
    const extRoot = path.dirname(EXT_DIR);
    const extJsonPath = path.join(extRoot, 'extensions.json');
    if (!fs.existsSync(extJsonPath)) return;
    const list = safeReadJson(extJsonPath, []);
    if (!Array.isArray(list)) return;

    const obsoleteIds = new Set([
      'jiajilah.agent-usage-monitor',
      'narun-dev.antigravity-monitor',
      'planken.agent-usage',
      'crsx.ag-usage'
    ]);

    let changed = false;
    const filtered = list.filter((item) => {
      const id = String(item?.identifier?.id || '').toLowerCase();
      if (obsoleteIds.has(id)) {
        changed = true;
        return false;
      }
      return true;
    });

    const folderName = path.basename(EXT_DIR);
    const hasUnified = filtered.some(
      (item) => String(item?.identifier?.id || '').toLowerCase() === 'unified.agent-usage-monitor'
    );

    if (!hasUnified) {
      filtered.push({
        identifier: { id: 'unified.agent-usage-monitor' },
        version: '1.0.0',
        location: {
          $mid: 1,
          fsPath: EXT_DIR,
          path: '/' + EXT_DIR.replace(/\\/g, '/').replace(/^\/+/, ''),
          scheme: 'file'
        },
        relativeLocation: folderName,
        metadata: {
          installedTimestamp: Date.now(),
          pinned: false,
          source: 'vsix'
        }
      });
      changed = true;
    }

    if (changed) {
      fs.writeFileSync(extJsonPath, JSON.stringify(filtered, null, 2), 'utf8');
    }
  } catch {
    // Ignore registration errors
  }
}

function mergeAntigravityConfigsToLocal() {
  ensureExtensionRegistered();
  const userDir = getVsCodeUserDir();
  if (!fs.existsSync(userDir)) return false;

  let updated = false;

  // 1. Merge settings.json
  const repoSettingsPath = path.join(CONFIG_DIR, 'settings.json');
  const localSettingsPath = path.join(userDir, 'settings.json');
  const repoSettings = safeReadJson(repoSettingsPath, null);
  if (repoSettings && typeof repoSettings === 'object') {
    const localSettings = safeReadJson(localSettingsPath, {});
    let settingsDiff = false;
    for (const [k, v] of Object.entries(repoSettings)) {
      if (JSON.stringify(localSettings[k]) !== JSON.stringify(v)) {
        localSettings[k] = v;
        settingsDiff = true;
      }
    }
    if (settingsDiff) {
      fs.writeFileSync(localSettingsPath, JSON.stringify(localSettings, null, 2) + '\n', 'utf8');
      updated = true;
    }
  }

  // 2. Merge keybindings.json
  const repoKbPath = path.join(CONFIG_DIR, 'keybindings.json');
  const localKbPath = path.join(userDir, 'keybindings.json');
  const repoKb = safeReadJson(repoKbPath, null);
  if (Array.isArray(repoKb)) {
    const localKb = safeReadJson(localKbPath, []);
    if (Array.isArray(localKb)) {
      let kbDiff = false;
      for (const entry of repoKb) {
        const exists = localKb.some(
          (k) => k.command === entry.command && k.key === entry.key
        );
        if (!exists) {
          localKb.push(entry);
          kbDiff = true;
        }
      }
      if (kbDiff) {
        fs.writeFileSync(localKbPath, JSON.stringify(localKb, null, 2) + '\n', 'utf8');
        updated = true;
      }
    }
  }

  return updated;
}

function exportLocalConfigsToRepo() {
  const userDir = getVsCodeUserDir();
  const localSettingsPath = path.join(userDir, 'settings.json');
  const repoSettingsPath = path.join(CONFIG_DIR, 'settings.json');

  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }

  const localSettings = safeReadJson(localSettingsPath, null);
  if (localSettings && typeof localSettings === 'object') {
    fs.writeFileSync(repoSettingsPath, JSON.stringify(localSettings, null, 2) + '\n', 'utf8');
  }

  const localKbPath = path.join(userDir, 'keybindings.json');
  const repoKbPath = path.join(CONFIG_DIR, 'keybindings.json');
  const localKb = safeReadJson(localKbPath, null);
  if (Array.isArray(localKb)) {
    fs.writeFileSync(repoKbPath, JSON.stringify(localKb, null, 2) + '\n', 'utf8');
  }
}

async function pullAndApplyUpdates(vscode, { silent = true } = {}) {
  try {
    if (!fs.existsSync(path.join(EXT_DIR, '.git'))) {
      mergeAntigravityConfigsToLocal();
      if (!silent) {
        vscode.window.showWarningMessage('Unified Usage: Repositório Git não encontrado na pasta da extensão.');
      }
      return { updated: false };
    }

    await runGit(['fetch', 'origin', 'main', '--quiet']);
    const behindStr = await runGit(['rev-list', 'HEAD..origin/main', '--count']);
    const behind = parseInt(behindStr, 10) || 0;

    if (behind > 0) {
      await runGit(['pull', '--rebase', '--autostash', 'origin', 'main']);
      mergeAntigravityConfigsToLocal();
      const choice = await vscode.window.showInformationMessage(
        `Antigravity & Unified Usage Monitor: ${behind} atualização(ões) sincronizada(s) do GitHub! Recarregar janela para aplicar?`,
        'Recarregar Agora',
        'Depois'
      );
      if (choice === 'Recarregar Agora') {
        vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
      return { updated: true, commits: behind };
    } else {
      const cfgChanged = mergeAntigravityConfigsToLocal();
      if (!silent) {
        vscode.window.showInformationMessage(
          cfgChanged
            ? 'Configurações do Antigravity aplicadas com sucesso! Extensão já está na versão mais recente.'
            : 'Antigravity & Unified Usage Monitor já está 100% sincronizado com o GitHub.'
        );
      }
      return { updated: cfgChanged, commits: 0 };
    }
  } catch (err) {
    if (!silent) {
      vscode.window.showErrorMessage(`Falha ao sincronizar com o GitHub: ${err.message}`);
    }
    return { updated: false, error: err.message };
  }
}

async function pushChangesToGitHub(vscode, { silent = false } = {}) {
  try {
    if (!fs.existsSync(path.join(EXT_DIR, '.git'))) {
      if (!silent) {
        vscode.window.showWarningMessage('Unified Usage: Repositório Git não inicializado na pasta da extensão.');
      }
      return { pushed: false };
    }

    exportLocalConfigsToRepo();
    const status = await runGit(['status', '--porcelain']);
    if (!status) {
      if (!silent) {
        vscode.window.showInformationMessage('Nenhuma alteração local pendente — GitHub já está atualizado!');
      }
      return { pushed: false };
    }

    await runGit(['add', '-A']);
    const host = os.hostname() || 'PC';
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    await runGit(['commit', '-m', `Auto-sync from ${host} (${stamp})`]);
    await runGit(['pull', '--rebase', 'origin', 'main']);
    await runGit(['push', 'origin', 'main']);

    if (!silent) {
      vscode.window.showInformationMessage('Alterações da extensão e configurações enviadas para o GitHub com sucesso!');
    }
    return { pushed: true };
  } catch (err) {
    if (!silent) {
      vscode.window.showErrorMessage(`Erro ao enviar alterações para o GitHub: ${err.message}`);
    }
    return { pushed: false, error: err.message };
  }
}

module.exports = {
  pullAndApplyUpdates,
  pushChangesToGitHub,
  mergeAntigravityConfigsToLocal,
  exportLocalConfigsToRepo
};
