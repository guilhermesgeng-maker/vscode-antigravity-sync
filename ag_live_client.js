'use strict';

const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');

const MAX_BUFFER = 1024 * 1024;
const REQ_TIMEOUT = 2500;
const RETRY_DELAY = 150;
const CONN_TTL_MS = 5 * 60 * 1000;

const ENDPOINTS = {
  GET_UNLEASH_DATA: '/exa.language_server_pb.LanguageServerService/GetUnleashData',
  RETRIEVE_USER_QUOTA_SUMMARY: '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary',
  GET_USER_STATUS: '/exa.language_server_pb.LanguageServerService/GetUserStatus'
};

let cachedConn = null;

function isValidPid(pid) {
  return Number.isInteger(pid) && pid > 0 && pid <= 2147483647;
}

function isValidPort(port) {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function runCmd(cmd, args, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let outLen = 0;
    let errLen = 0;
    let settled = false;

    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error(`Command '${cmd}' timed out after ${timeoutMs}ms`)));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      if (settled) return;
      outLen += chunk.length;
      if (outLen > MAX_BUFFER) {
        child.kill();
        finish(() => reject(new Error(`Command '${cmd}' output exceeded ${MAX_BUFFER} bytes`)));
        return;
      }
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      errLen += chunk.length;
      if (errLen <= MAX_BUFFER) stderr += chunk.toString();
    });

    child.on('error', (err) => {
      finish(() => reject(err));
    });

    child.on('close', (code) => {
      finish(() => {
        if (code === 0) resolve(stdout);
        else reject(new Error(stderr.trim() || `Command '${cmd}' exited with code ${code}`));
      });
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function errMsg(err) {
  return err instanceof Error ? err.message : String(err);
}

class WindowsProcessScanner {
  escapeLike(s) {
    return s.replace(/[%_[\]]/g, '[$&]').replace(/'/g, "''");
  }

  async getProcesses() {
    const ls = this.escapeLike('language_server');
    const hp1 = this.escapeLike('--hub-port');
    const hp2 = this.escapeLike('--hub_port');
    const csrf = this.escapeLike('--csrf_token');
    const filter = `CommandLine LIKE '%${ls}%' OR CommandLine LIKE '%${hp1}%' OR CommandLine LIKE '%${hp2}%' OR CommandLine LIKE '%${csrf}%'`;
    let out;
    try {
      out = await runCmd('powershell', [
        '-NoProfile',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "${filter}" | Where-Object { $_.ProcessId -ne $PID } | Select-Object ProcessId, CommandLine | ForEach-Object { "$($_.ProcessId)|$($_.CommandLine)" }`
      ]);
    } catch {
      out = await runCmd('wmic', [
        'process',
        'where',
        `CommandLine like '%${ls}%' or CommandLine like '%${hp1}%' or CommandLine like '%${hp2}%' or CommandLine like '%${csrf}%'`,
        'get',
        'CommandLine,ProcessId',
        '/format:csv'
      ]);
      return this.parseWmic(out);
    }

    const res = [];
    for (const line of out.trim().split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const sep = trimmed.indexOf('|');
      if (sep === -1) continue;
      const pid = parseInt(trimmed.substring(0, sep).trim(), 10);
      const cmd = trimmed.substring(sep + 1).trim();
      if (isValidPid(pid) && pid !== process.pid && cmd) {
        res.push({ pid, cmd });
      }
    }
    return res;
  }

  parseWmic(out) {
    const res = [];
    for (const line of out.trim().split(/\r?\n/)) {
      if (!line || line.startsWith('Node,')) continue;
      const lastComma = line.lastIndexOf(',');
      const firstComma = line.indexOf(',');
      if (lastComma === -1 || firstComma === -1 || firstComma === lastComma) continue;
      const pid = parseInt(line.substring(lastComma + 1).trim(), 10);
      const cmd = line.substring(firstComma + 1, lastComma).trim();
      if (isValidPid(pid) && pid !== process.pid && cmd) {
        res.push({ pid, cmd });
      }
    }
    return res;
  }

  async getPorts(pid) {
    const direct = await this.getDirectPorts(pid);
    if (direct.length > 0) return direct;
    const children = await this.getChildPids(pid);
    const all = [];
    for (const c of children) {
      const p = await this.getDirectPorts(c);
      all.push(...p);
    }
    return all;
  }

  async getDirectPorts(pid) {
    try {
      const out = await runCmd('powershell', [
        '-NoProfile',
        '-Command',
        `Get-NetTCPConnection -OwningProcess ${pid} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort`
      ]);
      const ports = [];
      for (const line of out.trim().split(/\r?\n/)) {
        const p = parseInt(line.trim(), 10);
        if (isValidPort(p)) ports.push(p);
      }
      return ports;
    } catch {
      const out = await runCmd('netstat', ['-ano']);
      return this.parseNetstat(out, pid);
    }
  }

  async getChildPids(pid) {
    try {
      const out = await runCmd('powershell', [
        '-NoProfile',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "ParentProcessId = ${pid}" | Select-Object -ExpandProperty ProcessId`
      ]);
      return out
        .trim()
        .split(/\r?\n/)
        .map((n) => parseInt(n.trim(), 10))
        .filter((n) => isValidPid(n) && n !== pid && n !== process.pid);
    } catch {
      return [];
    }
  }

  parseNetstat(out, pid) {
    const ports = [];
    for (const line of out.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 5 || parts[0].toUpperCase() !== 'TCP' || parseInt(parts[parts.length - 1], 10) !== pid) continue;
      const state = parts[3].toUpperCase();
      if (state !== 'LISTENING') continue;
      const addr = parts[1];
      const colon = addr.lastIndexOf(':');
      if (colon !== -1) {
        const p = parseInt(addr.substring(colon + 1), 10);
        if (isValidPort(p)) ports.push(p);
      }
    }
    return ports;
  }
}

function extractCsrfToken(cmd) {
  const patterns = [
    /--csrf_token[=\s]+"([^"]+)"/i,
    /--csrf_token[=\s]+'([^']+)'/i,
    /--csrf_token[=\s]+([^\s"']+)/i
  ];
  for (const re of patterns) {
    const m = cmd.match(re);
    if (m && m[1]) return m[1].trim();
  }
  return undefined;
}

function extractHubPort(cmd) {
  const m = cmd.match(/--hub[-_]port(?:=|\s+)(?:"(\d{1,5})"|'(\d{1,5})'|(\d{1,5}))/i);
  if (!m) return undefined;
  const p = parseInt(m[1] ?? m[2] ?? m[3], 10);
  return isValidPort(p) ? p : undefined;
}

function isHubCandidate(cmd) {
  const low = cmd.toLowerCase();
  return extractHubPort(cmd) !== undefined && (low.includes('antigravity') || low.includes('.gemini'));
}

function rankProcesses(list) {
  const valid = list.filter((p) => {
    const low = p.cmd.toLowerCase();
    return (extractCsrfToken(p.cmd) !== undefined && low.includes('--csrf_token')) || isHubCandidate(low);
  });
  const score = (p) => {
    const low = p.cmd.toLowerCase();
    let s = 0;
    if (low.includes('--standalone')) s += 8;
    if (low.includes('--override_ide_name antigravity')) s += 6;
    if (low.includes('\\antigravity\\resources\\bin\\language_server')) s += 6;
    if (low.includes('--app_data_dir antigravity')) s += 4;
    if (isHubCandidate(low) && low.includes('--app_data_dir=antigravity')) s += 5;
    if (low.includes('--app_data_dir antigravity-ide')) s -= 2;
    return s;
  };
  return valid.sort((a, b) => {
    const diff = score(b) - score(a);
    return diff !== 0 ? diff : b.pid - a.pid;
  });
}

function fetchHubHtml(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/', method: 'GET', timeout: REQ_TIMEOUT }, (res) => {
      res.setEncoding('utf8');
      let body = '';
      res.on('data', (c) => {
        body += c;
        if (body.length > MAX_BUFFER) {
          req.destroy();
          reject(new Error('Hub response too large'));
        }
      });
      res.on('end', () => resolve(body));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Hub request timed out'));
    });
  });
}

async function fetchCsrfFromHub(port) {
  let lastErr = new Error(`CSRF token not found on hub port ${port}`);
  for (let i = 0; i < 3; i++) {
    if (i > 0) await sleep(RETRY_DELAY * 4);
    try {
      const html = await fetchHubHtml(port);
      const m = html.match(/__APP_CONFIG__\s*=\s*(\{.*?\})\s*;/s);
      if (m && m[1]) {
        const cfg = JSON.parse(m[1]);
        if (typeof cfg.csrfToken === 'string' && cfg.csrfToken.trim()) {
          return cfg.csrfToken.trim();
        }
      }
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

function postConnectRpc(proto, port, csrfToken, rpcPath, payload) {
  return new Promise((resolve, reject) => {
    const dataStr = JSON.stringify(payload || {});
    const opts = {
      hostname: '127.0.0.1',
      port,
      path: rpcPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(dataStr),
        'X-Codeium-Csrf-Token': csrfToken,
        'Connect-Protocol-Version': '1'
      },
      timeout: REQ_TIMEOUT
    };

    const onRes = (res) => {
      res.setEncoding('utf8');
      let body = '';
      res.on('data', (c) => {
        body += c;
        if (body.length > MAX_BUFFER) {
          req.destroy();
          reject(new Error('RPC response too large'));
        }
      });
      res.on('end', () => {
        const code = res.statusCode || 0;
        if (code < 200 || code >= 300) {
          reject(new Error(`HTTP ${code} on ${rpcPath}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error(`Invalid JSON from ${rpcPath}`));
        }
      });
      res.on('error', reject);
    };

    const req = proto === 'https'
      ? https.request({ ...opts, rejectUnauthorized: false }, onRes)
      : http.request(opts, onRes);

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('RPC request timed out'));
    });
    req.write(dataStr);
    req.end();
  });
}

async function rpcCall(port, csrfToken, rpcPath, payload) {
  const errs = [];
  for (const proto of ['https', 'http']) {
    try {
      return await postConnectRpc(proto, port, csrfToken, rpcPath, payload);
    } catch (e) {
      errs.push(`${proto}: ${errMsg(e)}`);
    }
  }
  throw new Error(errs.join('; '));
}

function categorizeModel(name) {
  const low = String(name || '').toLowerCase();
  if (low.includes('argon')) return 'Argon';
  if (low.includes('gemini') || low.includes('flash')) return 'Gemini';
  return 'Claude';
}

function parseFraction(val) {
  const n = parseFloat(String(val ?? ''));
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : null;
}

function parseTimestamp(val) {
  if (val == null) return null;
  const ms = typeof val === 'number' ? val : new Date(val).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function normalizeWindow(w, bucketId, displayName) {
  const arr = [w, bucketId, displayName].filter((x) => typeof x === 'string').map((x) => x.toLowerCase());
  if (arr.some((x) => x.includes('week'))) return 'weekly';
  if (arr.some((x) => x.includes('5h') || /five[\s_-]*hour/.test(x))) return '5h';
  return w ?? bucketId ?? displayName ?? 'unknown';
}

function sortBuckets(buckets) {
  const order = (w) => {
    const low = String(w || '').toLowerCase();
    return low === '5h' ? 0 : low === 'weekly' ? 1 : 2;
  };
  return [...buckets].sort((a, b) => order(a.window) - order(b.window));
}

function parseQuotaSummaryResponse(res) {
  const groups = {};
  for (const g of res?.response?.groups || []) {
    const cat = categorizeModel(g.displayName || '');
    const buckets = [];
    for (const b of g.buckets || []) {
      const q = parseFraction(b.remainingFraction);
      if (q === null) continue;
      const win = normalizeWindow(b.window, b.bucketId, b.displayName);
      buckets.push({
        window: win,
        displayName: win === 'weekly' ? 'Weekly Limit' : win === '5h' ? 'Five Hour Limit' : (b.displayName || 'Limit'),
        quota: q,
        resetTime: parseTimestamp(b.resetTime)
      });
    }
    if (buckets.length === 0) continue;
    const sorted = sortBuckets(buckets);
    const minB = sorted.reduce((c, p) => (p.quota < c.quota ? p : c), sorted[0]);
    const target = (groups[cat] = groups[cat] || { quota: 1, resetTime: null, buckets: [], models: [] });
    target.buckets = sortBuckets([...(target.buckets || []), ...sorted]);
    if (minB.quota < target.quota || target.resetTime === null) {
      target.quota = minB.quota;
      target.resetTime = minB.resetTime;
    }
  }
  return groups;
}

function attachArgonFromClientModels(groups, clientModels) {
  const argonList = clientModels
    .filter((m) => categorizeModel(m.label || '') === 'Argon')
    .map((m) => ({
      quota: parseFraction(m.quotaInfo?.remainingFraction),
      resetTime: parseTimestamp(m.quotaInfo?.resetTime)
    }))
    .filter((m) => m.quota !== null);

  if (argonList.length === 0) return;

  const minArgon = argonList.reduce((a, b) =>
    b.quota < a.quota || (b.quota === a.quota && b.resetTime !== null && (a.resetTime === null || b.resetTime < a.resetTime))
      ? b
      : a,
    argonList[0]
  );

  const target = (groups.Argon = groups.Argon || {
    quota: minArgon.quota,
    resetTime: minArgon.resetTime,
    buckets: [],
    models: []
  });

  if (!target.buckets || !target.buckets.some((b) => b.window.toLowerCase() === 'weekly')) {
    target.buckets = sortBuckets([
      ...(target.buckets || []),
      {
        window: 'weekly',
        displayName: 'Weekly Limit',
        quota: minArgon.quota,
        resetTime: minArgon.resetTime
      }
    ]);
  } else {
    target.buckets = target.buckets.map((b) =>
      b.window.toLowerCase() === 'weekly'
        ? { ...b, quota: Math.min(b.quota, minArgon.quota), resetTime: minArgon.resetTime || b.resetTime }
        : b
    );
  }

  if (minArgon.quota < target.quota || target.resetTime === null) {
    target.quota = minArgon.quota;
    target.resetTime = minArgon.resetTime;
  }
}

async function fetchStatusAndSummary(port, csrfToken) {
  let summaryGroups = null;
  try {
    const sumRes = await rpcCall(port, csrfToken, ENDPOINTS.RETRIEVE_USER_QUOTA_SUMMARY, {});
    const parsed = parseQuotaSummaryResponse(sumRes);
    if (Object.keys(parsed).length > 0) summaryGroups = parsed;
  } catch {
    summaryGroups = null;
  }

  let statusRes = {};
  try {
    statusRes = await rpcCall(port, csrfToken, ENDPOINTS.GET_USER_STATUS, {
      metadata: { ideName: 'antigravity-ide' }
    });
  } catch (e) {
    if (!summaryGroups) throw e;
  }

  const clientModels = statusRes?.userStatus?.cascadeModelConfigData?.clientModelConfigs || [];
  const groups = summaryGroups || {};

  if (!summaryGroups) {
    for (const m of clientModels) {
      const q = parseFraction(m.quotaInfo?.remainingFraction);
      if (q === null) continue;
      const cat = categorizeModel(m.label || '');
      const rTime = parseTimestamp(m.quotaInfo?.resetTime);
      const target = (groups[cat] = groups[cat] || { quota: 1, resetTime: null, buckets: [], models: [] });
      if (q < target.quota || (q === target.quota && rTime !== null && (target.resetTime === null || rTime < target.resetTime))) {
        target.quota = q;
        target.resetTime = rTime;
      }
    }
  }

  attachArgonFromClientModels(groups, clientModels);

  for (const m of clientModels) {
    if (!m.label) continue;
    const cat = categorizeModel(m.label);
    const target = groups[cat];
    if (target) {
      target.models = target.models || [];
      const clean = m.label.replace(/\s*\([^)]*\)\s*$/, '').trim();
      if (clean && !target.models.includes(clean)) target.models.push(clean);
    }
  }

  const plan =
    statusRes?.userStatus?.userTier?.name ||
    statusRes?.userStatus?.planStatus?.planInfo?.planName ||
    statusRes?.userStatus?.planName ||
    statusRes?.userStatus?.plan ||
    statusRes?.planName ||
    statusRes?.plan ||
    'Google AI Pro';

  const credObj = statusRes?.userStatus?.userTier?.availableCredits?.[0];
  const credits = credObj ? parseInt(String(credObj.creditAmount ?? 0), 10) : undefined;

  return { groups, plan, credits };
}

async function validatePort(ports, csrfToken) {
  for (const p of ports) {
    try {
      await rpcCall(p, csrfToken, ENDPOINTS.RETRIEVE_USER_QUOTA_SUMMARY, {});
      return p;
    } catch {
      try {
        await rpcCall(p, csrfToken, ENDPOINTS.GET_UNLEASH_DATA, {
          context: { properties: { ide: 'antigravity-ide', ideVersion: '2.1.1' } }
        });
        return p;
      } catch {}
    }
  }
  throw new Error('No valid listening RPC port responded');
}

async function connectToProcess(proc, scanner) {
  const cmdCsrf = extractCsrfToken(proc.cmd);
  const hubPort = extractHubPort(proc.cmd);
  if (!cmdCsrf && hubPort === undefined) {
    throw new Error('Process has neither CSRF token nor hub port');
  }
  let ports = [];
  try {
    ports = await scanner.getPorts(proc.pid);
  } catch {}
  const allPorts = Array.from(new Set([...(hubPort !== undefined ? [hubPort] : []), ...ports]));
  if (allPorts.length === 0) throw new Error('No listening ports found');

  if (cmdCsrf) {
    try {
      const validPort = await validatePort(allPorts, cmdCsrf);
      return { port: validPort, csrfToken: cmdCsrf };
    } catch (e) {
      if (hubPort === undefined) throw e;
    }
  }
  const hubCsrf = await fetchCsrfFromHub(hubPort);
  const validPort = await validatePort(allPorts, hubCsrf);
  return { port: validPort, csrfToken: hubCsrf };
}

async function fetchLiveAgUsageStats() {
  if (cachedConn && Date.now() - cachedConn.timestamp < CONN_TTL_MS) {
    try {
      return await fetchStatusAndSummary(cachedConn.port, cachedConn.csrfToken);
    } catch {
      cachedConn = null;
    }
  }

  if (os.platform() !== 'win32') {
    throw new Error('Live process scanner currently configured for Windows');
  }

  const scanner = new WindowsProcessScanner();
  const procs = rankProcesses(await scanner.getProcesses());
  if (procs.length === 0) {
    throw new Error('Antigravity process not found');
  }

  let lastErr = null;
  for (const proc of procs) {
    try {
      const conn = await connectToProcess(proc, scanner);
      cachedConn = { ...conn, timestamp: Date.now() };
      return await fetchStatusAndSummary(conn.port, conn.csrfToken);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Could not connect to Antigravity process');
}

module.exports = { fetchLiveAgUsageStats };
