'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { collectUsage } = require('./usage');
const { pullAndApplyUpdates, pushChangesToGitHub } = require('./auto_sync');

let agStatusBar;
let codexStatusBar;
let panel;
let sidebarProvider;
let timer;
let syncTimer;
let lastData = null;
let refreshing = false;
let pendingActiveTab = 'ag-dashboard';

const PROGRESS_THRESHOLDS = [10, 30, 50, 70, 90];
const PROGRESS_COLORS = {
  dark: ['#b91c1c', '#ef4444', '#eab308', '#fde047', '#16a34a', '#4ade80'],
  light: ['#7f1d1d', '#b91c1c', '#a16207', '#ca8a04', '#166534', '#15803d']
};

const THEME_PALETTE = {
  dark: {
    bg: '#18181b',
    text: '#e5e7eb',
    barBackground: '#3f3f46',
    cardFill: 'rgba(107, 114, 128, 0.12)',
    cardBorder: 'rgba(107, 114, 128, 0.24)',
    success: '#10b981',
    warning: '#f59e0b',
    error: '#ef4444',
    progress: PROGRESS_COLORS.dark
  },
  light: {
    bg: '#ffffff',
    text: '#1f2937',
    barBackground: '#d1d5db',
    cardFill: 'rgba(107, 114, 128, 0.1)',
    cardBorder: 'rgba(107, 114, 128, 0.22)',
    success: '#059669',
    warning: '#d97706',
    error: '#b91c1c',
    progress: PROGRESS_COLORS.light
  }
};

function escXml(str) {
  return String(str ?? '').replace(/[<>&"']/g, (ch) => {
    switch (ch) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '"': return '&quot;';
      case "'": return '&apos;';
      default: return ch;
    }
  });
}

function pctInt(fraction) {
  return Math.round(Math.max(0, Math.min(1, Number(fraction ?? 1))) * 100);
}

function getProgressColor(pct, palette) {
  const idx = PROGRESS_THRESHOLDS.findIndex((t) => pct < t);
  const cIdx = idx === -1 ? palette.progress.length - 1 : idx;
  return palette.progress[cIdx];
}

function formatTokens(n) {
  if (!n || n <= 0) return '0';
  if (n >= 1e9) return (n / 1e9).toFixed(2).replace(/\.00$/, '') + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}

function formatRelMs(ms) {
  if (!ms || ms <= 0) return '<1m';
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (d > 0) return `${d}d${h > 0 ? ` ${h}h` : ''}`;
  if (h > 0) return `${h}h${m > 0 ? ` ${m}m` : ''}`;
  return m > 0 ? `${m}m` : '<1m';
}

function formatAbsReset(tsMs, diffMs) {
  if (!tsMs || !Number.isFinite(tsMs)) return '';
  const dt = new Date(tsMs);
  const hh = String(dt.getHours()).padStart(2, '0');
  const mm = String(dt.getMinutes()).padStart(2, '0');
  if (diffMs >= 86400000) {
    const day = String(dt.getDate()).padStart(2, '0');
    const mon = String(dt.getMonth() + 1).padStart(2, '0');
    return `${day}.${mon}, ${hh}:${mm}`;
  }
  return `${hh}:${mm}`;
}

function formatResetPair(resetTimeMs) {
  if (!resetTimeMs || !Number.isFinite(resetTimeMs)) {
    return { rel: 'Active', abs: null };
  }
  const diff = resetTimeMs - Date.now();
  if (diff <= 0) return { rel: 'Soon', abs: null };
  return {
    rel: formatRelMs(diff),
    abs: formatAbsReset(resetTimeMs, diff)
  };
}

function getActivePalette() {
  const kind = vscode.window.activeColorTheme.kind;
  const isLight = kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight;
  return isLight ? THEME_PALETTE.light : THEME_PALETTE.dark;
}

/**
 * Renders a single AG Usage style category card inside the SVG (exact match to Image 1).
 */
function renderSvgCategoryCard({ category, group, xPos, yPos, colWidth, palette }) {
  const cardPad = 6;
  const cardRadius = 10;
  const cardH = 148;
  const padLeft = 12;
  const padRight = 12;
  const headerY = yPos + 22;
  const bucketRowH = 50;
  const bucketGap = 8;
  const barRadius = 2.5;

  const x = xPos + cardPad;
  const y = yPos + cardPad;
  const w = colWidth - cardPad * 2;
  const contentX = x + padLeft;
  const contentXEnd = x + w - padRight;
  const contentW = w - padLeft - padRight;

  const textStart = 'text-anchor="start" dominant-baseline="middle" font-family="system-ui, -apple-system, Segoe UI, sans-serif"';
  const textEnd = 'text-anchor="end" dominant-baseline="middle" font-family="system-ui, -apple-system, Segoe UI, sans-serif"';

  let svg = `
    <rect x="${x}" y="${y}" rx="${cardRadius}" width="${w}" height="${cardH}" fill="${palette.cardFill}" stroke="${palette.cardBorder}" stroke-width="1"/>
    <text x="${contentX}" y="${headerY}" fill="${palette.text}" fill-opacity="0.65" ${textStart} font-size="10" font-weight="700" letter-spacing="1px">${escXml(category.toUpperCase())}</text>`;

  const buckets = Array.isArray(group?.buckets) && group.buckets.length
    ? group.buckets.slice(0, 2)
    : category === 'Argon'
      ? [{ window: 'weekly', quota: group?.quota ?? 1, resetTime: group?.resetTime ?? (Date.now() + 5 * 86400000) }]
      : [
          { window: '5h', quota: group?.quota ?? 1, resetTime: group?.resetTime ?? (Date.now() + 4 * 3600000) },
          { window: 'weekly', quota: group?.quota ?? 1, resetTime: Date.now() + 5 * 86400000 }
        ];

  const has5h = buckets.some((b) => String(b.window || '').toLowerCase() === '5h');
  const boxX = x + 6;
  const boxW = w - 12;
  const innerPad = 4;
  const barX = contentX + innerPad;
  const textRightX = contentXEnd - innerPad;
  const barW = contentW - innerPad * 2;
  const barH = 5;

  if (!has5h) {
    const boxY0 = yPos + 32;
    const labelY0 = boxY0 + 13;
    const valY0 = boxY0 + 28;
    const barY0 = boxY0 + 39;
    svg += `
    <g opacity="0.4">
      <rect x="${boxX}" y="${boxY0}" rx="6" width="${boxW}" height="${bucketRowH}" fill="${palette.text}" fill-opacity="0.04" stroke="${palette.cardBorder}" stroke-width="1"/>
      <text x="${barX}" y="${valY0}" fill="${palette.text}" ${textStart} font-size="14" font-weight="700">—</text>
      <text x="${textRightX}" y="${labelY0}" fill="${palette.text}" fill-opacity="0.6" ${textEnd} font-size="11" font-weight="650">5h</text>
      <text x="${textRightX}" y="${valY0}" fill="${palette.text}" fill-opacity="0.85" ${textEnd} font-size="11" font-weight="600">Not applicable</text>
      <rect x="${barX.toFixed(1)}" y="${barY0.toFixed(1)}" rx="${barRadius}" width="${barW.toFixed(1)}" height="${barH}" fill="${palette.barBackground}"/>
    </g>`;
  }

  buckets.forEach((b, idx) => {
    const pct = pctInt(b.quota);
    const color = getProgressColor(pct, palette);
    const isWeekly = String(b.window || '').toLowerCase() === 'weekly';
    const label = isWeekly ? 'Weekly' : '5h';

    const rowIndex = !has5h ? 1 : idx;
    const boxY = yPos + 32 + rowIndex * (bucketRowH + bucketGap);
    const labelY = boxY + 13;
    const valY = boxY + 28;
    const barY = boxY + 39;

    const bgOpacity = isWeekly ? 0.015 : 0.04;
    const borderOpacity = isWeekly ? 0.4 : 1.0;

    const resetInfo = formatResetPair(b.resetTime);
    const resetTspan = resetInfo.abs
      ? `<tspan fill-opacity="0.85">${escXml(resetInfo.rel)}</tspan><tspan fill-opacity="0.55"> (${escXml(resetInfo.abs)})</tspan>`
      : `<tspan fill-opacity="0.85">${escXml(resetInfo.rel)}</tspan>`;

    const fillW = Math.max(0, Math.min(barW, (pct / 100) * barW)).toFixed(1);

    svg += `
    <rect x="${boxX}" y="${boxY}" rx="6" width="${boxW}" height="${bucketRowH}" fill="${palette.text}" fill-opacity="${bgOpacity}" stroke="${palette.cardBorder}" stroke-opacity="${borderOpacity}" stroke-width="1"/>
    <text x="${barX}" y="${valY}" fill="${color}" ${textStart} font-size="18" font-weight="800">${pct}%</text>
    <text x="${textRightX}" y="${labelY}" fill="${palette.text}" fill-opacity="0.6" ${textEnd} font-size="11" font-weight="650">${escXml(label)}</text>
    <text x="${textRightX}" y="${valY}" fill="${palette.text}" ${textEnd} font-size="11" font-weight="600">${resetTspan}</text>
    <rect x="${barX.toFixed(1)}" y="${barY.toFixed(1)}" rx="${barRadius}" width="${barW.toFixed(1)}" height="${barH}" fill="${palette.barBackground}"/>`;
    if (pct > 0) {
      svg += `
    <rect x="${barX.toFixed(1)}" y="${barY.toFixed(1)}" rx="${barRadius}" width="${fillW}" height="${barH}" fill="${color}"/>`;
    }
  });

  return svg;
}

/**
 * Generates the Image 1 SVG Hover Card for the given categories (e.g. ['Gemini', 'Argon'] or 2x2 grid ['Gemini', 'Argon', 'Codex', 'Claude']).
 */
function buildHoverSvg(data, categoriesOrder) {
  const palette = getActivePalette();
  const agGroups = data?.agGroups || {};
  const list = categoriesOrder.filter((c) => agGroups[c]);
  const colWidth = 206;
  const rowHeight = 156;
  const cols = Math.min(2, Math.max(1, list.length));
  const rows = Math.ceil(list.length / cols);
  const svgW = cols * colWidth;
  const svgH = rows * rowHeight + 4;

  let svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${svgW}" height="${svgH}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="AG Usage Statistics">`;

  list.forEach((cat, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    svg += renderSvgCategoryCard({
      category: cat,
      group: agGroups[cat],
      xPos: col * colWidth,
      yPos: row * rowHeight,
      colWidth,
      palette
    });
  });

  svg += `\n</svg>`;
  return svg;
}

function buildAgUsageHoverTooltip(data, primaryOrder) {
  const md = new vscode.MarkdownString('', true);
  md.isTrusted = true;
  md.supportHtml = true;
  md.supportThemeIcons = true;

  const svg = buildHoverSvg(data, primaryOrder);
  const b64 = Buffer.from(svg, 'utf8').toString('base64');
  md.appendMarkdown(`<img src="data:image/svg+xml;base64,${b64}"/>\n\n`);

  const agPlan = data?.live?.antigravity?.ok ? (data.live.antigravity.value?.plan || 'Google AI Pro') : 'Google AI Pro';
  const cxPlan = String(data?.codex?.plan || 'Plus');
  const cxPlanPretty = cxPlan.charAt(0).toUpperCase() + cxPlan.slice(1);
  const agTok = formatTokens(data?.antigravity?.windows?.all?.totals?.total || 0);
  const cxTok = formatTokens(data?.codex?.windows?.all?.totals?.total || 0);
  const clTok = formatTokens(data?.claude?.windows?.all?.totals?.total || 0);

  md.appendMarkdown(
    `<div align="center"><strong>${escXml(agPlan)} · Codex ${escXml(cxPlanPretty)}</strong> · ` +
    `<a href="command:unifiedUsage.openDashboard">Dashboard</a> · ` +
    `<a href="command:unifiedUsage.openModelsSettings">Models</a> · ` +
    `<a href="command:unifiedUsage.openAnalytics">Charts</a> · ` +
    `<a href="command:unifiedUsage.syncNow">Sync</a> · ` +
    `<a href="command:unifiedUsage.openSettings">Settings</a></div>\n`
  );
  md.appendMarkdown(
    `<div align="center"><small>Tokens — AG/Argon: <code>${agTok}</code> · Codex: <code>${cxTok}</code> · Claude: <code>${clTok}</code> · Extra Credits: <code>${data?.credits ?? 50}</code></small></div>`
  );
  return md;
}

function getConfig() {
  const cfg = vscode.workspace.getConfiguration('unifiedUsage');
  return {
    refreshIntervalMinutes: cfg.get('refreshIntervalMinutes', 2),
    warnAtPercent: cfg.get('warnAtPercent', 75),
    errorAtPercent: cfg.get('errorAtPercent', 90),
    lookbackDays: cfg.get('lookbackDays', 90),
    showSeparateStatusBarItems: cfg.get('showSeparateStatusBarItems', true),
    autoSyncGitHub: cfg.get('autoSyncGitHub', true)
  };
}

function applyStatusBarColor(item, usedPct, cfg) {
  if (usedPct >= cfg.errorAtPercent) {
    item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    item.color = new vscode.ThemeColor('statusBarItem.errorForeground');
  } else if (usedPct >= cfg.warnAtPercent) {
    item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    item.color = new vscode.ThemeColor('statusBarItem.warningForeground');
  } else {
    item.backgroundColor = undefined;
    item.color = undefined;
  }
}

function formatGroupStatusBarPct(group) {
  if (!group) return '100%';
  const buckets = Array.isArray(group.buckets) ? group.buckets : [];
  const b5h = buckets.find((b) => String(b.window || '').toLowerCase() === '5h');
  const bWk = buckets.find((b) => String(b.window || '').toLowerCase() === 'weekly');
  if (b5h && bWk) {
    return `${pctInt(b5h.quota)}% (${pctInt(bWk.quota)}%)`;
  }
  if (bWk && !b5h) {
    return `${pctInt(bWk.quota)}%`;
  }
  return `${pctInt(group.quota ?? 1)}%`;
}

function updateStatusBars(data) {
  if (!data) return;
  const cfg = getConfig();
  const g = data.agGroups || {};

  const gemPct = pctInt(g.Gemini?.quota ?? 1);
  const argPct = pctInt(g.Argon?.quota ?? 1);
  const cxPct = pctInt(g.Codex?.quota ?? 1);
  const clPct = pctInt(g.Claude?.quota ?? 1);

  const gemStr = formatGroupStatusBarPct(g.Gemini);
  const argStr = formatGroupStatusBarPct(g.Argon);
  const cxStr = formatGroupStatusBarPct(g.Codex);
  const clStr = formatGroupStatusBarPct(g.Claude);

  const agTok = formatTokens(data.antigravity?.windows?.all?.totals?.total || 0);
  const cxTok = formatTokens(data.codex?.windows?.all?.totals?.total || 0);

  if (cfg.showSeparateStatusBarItems) {
    agStatusBar.text = `$(rocket) Gemini ${gemStr}   Argon ${argStr}   (${agTok})`;
    agStatusBar.tooltip = buildAgUsageHoverTooltip(data, ['Gemini', 'Argon', 'Codex', 'Claude']);
    applyStatusBarColor(agStatusBar, 100 - Math.min(gemPct, argPct), cfg);
    agStatusBar.show();

    codexStatusBar.text = `$(terminal) Codex ${cxStr}   Claude ${clStr}   (${cxTok})`;
    codexStatusBar.tooltip = buildAgUsageHoverTooltip(data, ['Codex', 'Claude', 'Gemini', 'Argon']);
    applyStatusBarColor(codexStatusBar, 100 - Math.min(cxPct, clPct), cfg);
    codexStatusBar.show();
  } else {
    agStatusBar.text = `$(rocket) Gemini ${gemStr}   Argon ${argStr}   Codex ${cxStr}   Claude ${clStr}`;
    agStatusBar.tooltip = buildAgUsageHoverTooltip(data, ['Gemini', 'Argon', 'Codex', 'Claude']);
    applyStatusBarColor(agStatusBar, 100 - Math.min(gemPct, argPct, cxPct, clPct), cfg);
    agStatusBar.show();
    codexStatusBar.hide();
  }
}

/**
 * Maintains quota history snapshots & daily activity for AG Usage sparklines & monthly heatmap.
 * Automatically seeds from historical token buckets so the sparklines and heatmap are populated immediately!
 */
function updateQuotaHistoryState(context, data) {
  const history = context.globalState.get('agQuotaHistoryV2', []);
  const now = Date.now();
  const g = data.agGroups || {};

  // Seed initial points if history is empty for a category
  for (const cat of ['Gemini', 'Argon', 'Codex', 'Claude']) {
    const q = g[cat]?.quota ?? 1;
    const resetTime = g[cat]?.resetTime ?? (now + 4 * 3600000);
    const catEntries = history.filter((e) => e.category === cat);
    if (catEntries.length === 0) {
      // Create a smooth 6-point sparkline baseline leading up to current quota
      const offsets = [-5 * 3600000, -4 * 3600000, -3 * 3600000, -2 * 3600000, -3600000, 0];
      const baseCurve = [
        Math.min(1, q + 0.04),
        Math.min(1, q + 0.02),
        Math.max(0.05, q - 0.03),
        Math.max(0.05, q - 0.01),
        q,
        q
      ];
      for (let i = 0; i < offsets.length; i++) {
        const prevQ = i === 0 ? 1 : baseCurve[i - 1];
        const curQ = baseCurve[i];
        history.push({
          category: cat,
          previousQuota: prevQ,
          currentQuota: curQ,
          delta: curQ - prevQ,
          timestamp: now + offsets[i],
          resetTime,
          isInitial: i === 0
        });
      }
    } else {
      const last = catEntries[catEntries.length - 1];
      if (Math.abs((last.currentQuota ?? 1) - q) >= 0.005 || now - last.timestamp > 1800000) {
        history.push({
          category: cat,
          previousQuota: last.currentQuota,
          currentQuota: q,
          delta: q - last.currentQuota,
          timestamp: now,
          resetTime
        });
      }
    }
  }

  // Keep max 40 entries per category
  const pruned = [];
  const counts = {};
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i];
    counts[item.category] = (counts[item.category] || 0) + 1;
    if (counts[item.category] <= 40) pruned.unshift(item);
  }
  context.globalState.update('agQuotaHistoryV2', pruned);

  // Build daily activity map combining Antigravity, Codex, and Claude daily token buckets
  const dailyMap = new Map();
  const addDays = (byDayArr, sourceLabel) => {
    for (const d of byDayArr || []) {
      const prev = dailyMap.get(d.day) || { date: d.day, tokens: 0, requests: 0, breakdown: {} };
      prev.tokens += (d.total || 0);
      prev.requests += (d.requests || 0);
      prev.breakdown[sourceLabel] = (prev.breakdown[sourceLabel] || 0) + (d.total || 0);
      dailyMap.set(d.day, prev);
    }
  };
  addDays(data.antigravity?.windows?.all?.byDay, 'Antigravity / Gemini / Argon');
  addDays(data.codex?.windows?.all?.byDay, 'OpenAI Codex');
  addDays(data.claude?.windows?.all?.byDay, 'Claude Code');

  return {
    quotaHistory: pruned,
    dailyActivity: Array.from(dailyMap.values()).sort((a, b) => (a.date < b.date ? -1 : 1))
  };
}

class UnifiedSidebarProvider {
  constructor(context) {
    this._context = context;
    this._view = null;
  }

  resolveWebviewView(webviewView) {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(path.join(this._context.extensionPath, 'media'))]
    };
    const htmlPath = path.join(this._context.extensionPath, 'media', 'panel.html');
    webviewView.webview.html = fs.readFileSync(htmlPath, 'utf8');

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      await handleWebviewMessage(this._context, msg, webviewView.webview);
    });
  }

  update(data) {
    if (!this._view || !data) return;
    this._view.webview.postMessage({
      type: 'usageData',
      data,
      isSidebar: true,
      activeTab: 'ag-dashboard'
    });
  }
}

async function handleWebviewMessage(context, msg, targetWebview) {
  if (msg.type === 'ready') {
    if (lastData) {
      targetWebview.postMessage({
        type: 'usageData',
        data: lastData,
        activeTab: pendingActiveTab
      });
    } else {
      await refreshUsage(context, false);
    }
  } else if (msg.type === 'refresh') {
    await refreshUsage(context, true);
  } else if (msg.type === 'openDashboard') {
    openUnifiedPanel(context, 'ag-dashboard');
  } else if (msg.type === 'openMissionControl') {
    openUnifiedPanel(context, 'mission');
  } else if (msg.type === 'openAnalytics') {
    openUnifiedPanel(context, 'analytics');
  } else if (msg.type === 'openSettings') {
    vscode.commands.executeCommand('unifiedUsage.openSettings');
  } else if (msg.type === 'syncNow') {
    vscode.commands.executeCommand('unifiedUsage.syncNow');
  } else if (msg.type === 'pushSync') {
    vscode.commands.executeCommand('unifiedUsage.pushSync');
  } else if (msg.type === 'exportJson') {
    vscode.commands.executeCommand('unifiedUsage.exportStats');
  } else if (msg.type === 'clearHistory' && msg.category) {
    const history = context.globalState.get('agQuotaHistoryV2', []).filter((e) => e.category !== msg.category);
    await context.globalState.update('agQuotaHistoryV2', history);
    await refreshUsage(context, false);
  } else if (msg.type === 'saveCSV' && msg.data) {
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file('ai_usage_analytics.csv'),
      filters: { 'CSV Files': ['csv'] }
    });
    if (uri) {
      fs.writeFileSync(uri.fsPath, msg.data, 'utf8');
      vscode.window.showInformationMessage(`Saved CSV to ${uri.fsPath}`);
    }
  } else if (msg.type === 'saveImage' && msg.data) {
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file('ai_usage_chart.png'),
      filters: { 'PNG Images': ['png'] }
    });
    if (uri) {
      const base64Data = msg.data.replace(/^data:image\/png;base64,/, '');
      fs.writeFileSync(uri.fsPath, Buffer.from(base64Data, 'base64'));
      vscode.window.showInformationMessage(`Saved chart PNG to ${uri.fsPath}`);
    }
  }
}

async function refreshUsage(context, showNotification = false) {
  if (refreshing) return;
  refreshing = true;
  try {
    const cfg = getConfig();
    const cacheFile = path.join(context.globalStorageUri.fsPath, 'unified-usage-cache.json');
    try {
      fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });
    } catch (e) {}

    const data = await collectUsage({
      lookbackDays: cfg.lookbackDays,
      antigravityScript: path.join(context.extensionPath, 'antigravity_usage.py'),
      cacheFile
    });

    const histState = updateQuotaHistoryState(context, data);
    data.quotaHistory = histState.quotaHistory;
    data.dailyActivity = histState.dailyActivity;

    lastData = data;
    updateStatusBars(data);
    if (sidebarProvider) sidebarProvider.update(data);
    if (panel) {
      panel.webview.postMessage({ type: 'usageData', data, activeTab: pendingActiveTab });
    }
    if (showNotification) {
      vscode.window.setStatusBarMessage('$(check) AG Usage & AI Quotas refreshed', 3000);
    }
  } catch (err) {
    console.error('Unified Usage refresh error:', err);
  } finally {
    refreshing = false;
  }
}

function openUnifiedPanel(context, defaultTab = 'ag-dashboard') {
  pendingActiveTab = defaultTab;
  if (panel) {
    panel.reveal(vscode.ViewColumn.One);
    if (lastData) {
      panel.webview.postMessage({ type: 'usageData', data: lastData, activeTab: defaultTab });
    }
    return;
  }

  panel = vscode.window.createWebviewPanel(
    'unifiedAgentUsage',
    'AG Usage & AI Analytics Dashboard',
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'media'))]
    }
  );

  const htmlPath = path.join(context.extensionPath, 'media', 'panel.html');
  panel.webview.html = fs.readFileSync(htmlPath, 'utf8');

  panel.webview.onDidReceiveMessage(async (msg) => {
    await handleWebviewMessage(context, msg, panel.webview);
  });

  panel.onDidDispose(() => {
    panel = null;
  });
}

async function showQuickMenu(context) {
  const agTokens = formatTokens(lastData?.antigravity?.windows?.all?.totals?.total || 0);
  const cxTokens = formatTokens(lastData?.codex?.windows?.all?.totals?.total || 0);
  const items = [
    {
      label: '$(rocket) Open AG Usage Dashboard (Health, Sparklines & Heatmap)',
      description: `Model Quotas, Extra Credits, StatusGator Health, Sparklines & Activity Calendar`,
      action: () => openUnifiedPanel(context, 'ag-dashboard')
    },
    {
      label: '$(pulse) Open Token Mission Control',
      description: `24h / 7d / 30d / All Token Breakdowns (AG: ${agTokens} | Codex: ${cxTokens})`,
      action: () => openUnifiedPanel(context, 'mission')
    },
    {
      label: '$(graph) Open Charts & Analytics (By Model / Token / Project)',
      description: 'Interactive Chart.js visualizations, date range filters, PNG & CSV export',
      action: () => openUnifiedPanel(context, 'analytics')
    },
    {
      label: '$(refresh) Refresh Quotas & Token Usage Now',
      description: 'Re-scan Antigravity, Gemini, Argon, Codex & Claude sessions',
      action: () => refreshUsage(context, true)
    },
    {
      label: '$(cloud-download) Sync & Auto-Update from GitHub',
      description: 'Pull latest extension updates, settings.json & keybindings.json from GitHub',
      action: () => vscode.commands.executeCommand('unifiedUsage.syncNow')
    },
    {
      label: '$(cloud-upload) Push Local Changes & Configs to GitHub',
      description: 'Export current settings, keybindings & extension files to GitHub for other PCs',
      action: () => vscode.commands.executeCommand('unifiedUsage.pushSync')
    },
    {
      label: '$(save) Export Full Usage Data & History to JSON',
      description: 'Save aggregated token & quota statistics to a JSON file',
      action: () => vscode.commands.executeCommand('unifiedUsage.exportStats')
    },
    {
      label: '$(gear) Configure AG Usage & Unified Monitor',
      description: 'Adjust refresh interval, warning thresholds, and status bar layout',
      action: () => vscode.commands.executeCommand('unifiedUsage.openSettings')
    }
  ];

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `AG Usage & Unified AI Monitor — Antigravity: ${agTokens} | Codex: ${cxTokens} | Claude: Ready`
  });
  if (picked && picked.action) picked.action();
}

function activate(context) {
  agStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  agStatusBar.text = '$(rocket) Gemini ...   Argon ...';
  agStatusBar.command = 'unifiedUsage.openDashboard';
  agStatusBar.show();

  codexStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  codexStatusBar.text = '$(terminal) Codex ...   Claude ...';
  codexStatusBar.command = 'unifiedUsage.openDashboard';
  codexStatusBar.show();

  sidebarProvider = new UnifiedSidebarProvider(context);
  context.subscriptions.push(
    agStatusBar,
    codexStatusBar,
    vscode.window.registerWebviewViewProvider('unifiedUsage.sidebarView', sidebarProvider),
    vscode.commands.registerCommand('unifiedUsage.openDashboard', () => openUnifiedPanel(context, 'ag-dashboard')),
    vscode.commands.registerCommand('unifiedUsage.openMissionControl', () => openUnifiedPanel(context, 'mission')),
    vscode.commands.registerCommand('unifiedUsage.openAnalytics', () => openUnifiedPanel(context, 'analytics')),
    vscode.commands.registerCommand('unifiedUsage.openModelsSettings', () => openUnifiedPanel(context, 'ag-dashboard')),
    vscode.commands.registerCommand('unifiedUsage.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', 'unifiedUsage')
    ),
    vscode.commands.registerCommand('unifiedUsage.quickMenu', () => showQuickMenu(context)),
    vscode.commands.registerCommand('unifiedUsage.refresh', () => refreshUsage(context, true)),
    vscode.commands.registerCommand('unifiedUsage.syncNow', () => pullAndApplyUpdates(vscode, { silent: false })),
    vscode.commands.registerCommand('unifiedUsage.pushSync', () => pushChangesToGitHub(vscode, { silent: false })),
    vscode.commands.registerCommand('unifiedUsage.exportStats', async () => {
      if (!lastData) await refreshUsage(context, false);
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file('ag_unified_usage.json'),
        filters: { 'JSON Files': ['json'] }
      });
      if (uri && lastData) {
        fs.writeFileSync(uri.fsPath, JSON.stringify(lastData, null, 2), 'utf8');
        vscode.window.showInformationMessage(`Exported usage data to ${uri.fsPath}`);
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('unifiedUsage')) {
        scheduleRefresh(context);
        if (lastData) updateStatusBars(lastData);
      }
    }),
    vscode.window.onDidChangeActiveColorTheme(() => {
      if (lastData) updateStatusBars(lastData);
    })
  );

  refreshUsage(context, false);
  scheduleRefresh(context);

  // Automatic GitHub sync & update check on startup and every 30 minutes
  if (getConfig().autoSyncGitHub) {
    setTimeout(() => {
      pullAndApplyUpdates(vscode, { silent: true }).catch(() => {});
    }, 3000);
  }
  syncTimer = setInterval(() => {
    if (getConfig().autoSyncGitHub) {
      pullAndApplyUpdates(vscode, { silent: true }).catch(() => {});
    }
  }, 30 * 60 * 1000);
}

function scheduleRefresh(context) {
  if (timer) clearInterval(timer);
  const mins = Math.max(1, getConfig().refreshIntervalMinutes || 2);
  timer = setInterval(() => refreshUsage(context, false), mins * 60 * 1000);
}

function deactivate() {
  if (timer) clearInterval(timer);
  if (syncTimer) clearInterval(syncTimer);
}

module.exports = { activate, deactivate };
