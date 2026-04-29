#!/usr/bin/env node

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { URL } = require('url');
const { execSync, spawn } = require('child_process');

const APP_NAME = 'NoCode Inventory Sync';
const DEFAULT_PORT = 8080;
const MAX_PORT_RETRY = 20;

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function getRuntimeLogPath() {
  const candidates = [
    process.env.APPDATA ? path.join(process.env.APPDATA, 'nocode-inventory-sync') : '',
    path.dirname(process.execPath || process.cwd()),
    process.cwd(),
    os.tmpdir(),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      fs.mkdirSync(candidate, { recursive: true });
      return path.join(candidate, 'nocode-runtime.log');
    } catch (_) {
      // Try next path candidate.
    }
  }

  return path.join(os.tmpdir(), 'nocode-runtime.log');
}

const RUNTIME_LOG_PATH = getRuntimeLogPath();

function appendRuntimeLog(level, message) {
  const line = `${new Date().toISOString()} [${level}] ${message}\n`;
  try {
    fs.appendFileSync(RUNTIME_LOG_PATH, line, 'utf8');
  } catch (_) {
    // Keep runtime resilient even if logging fails.
  }
}

function isPortAvailable(port, host = '0.0.0.0') {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', () => resolve(false));
    tester.once('listening', () => {
      tester.close(() => resolve(true));
    });
    tester.listen(port, host);
  });
}

async function findAvailablePort(startPort, maxOffset = MAX_PORT_RETRY) {
  for (let offset = 0; offset <= maxOffset; offset += 1) {
    const candidate = startPort + offset;
    if (candidate > 65535) break;
    // eslint-disable-next-line no-await-in-loop
    if (await isPortAvailable(candidate)) {
      return candidate;
    }
  }
  throw new Error(`No available port found in range ${startPort}-${Math.min(startPort + maxOffset, 65535)}`);
}

function parseArgs(argv) {
  let port = Number(process.env.PORT || DEFAULT_PORT);
  let noOpen = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if ((arg === '--port' || arg === '-p') && argv[i + 1]) {
      port = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--no-open') {
      noOpen = true;
    }
  }

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    port = DEFAULT_PORT;
  }

  return { port, noOpen };
}

function getDataFilePath() {
  const candidates = [
    process.env.APPDATA ? path.join(process.env.APPDATA, 'nocode-inventory-sync') : '',
    path.join(path.dirname(process.execPath || process.cwd()), 'nocode-data'),
    path.join(process.cwd(), 'nocode-data'),
    path.join(os.tmpdir(), 'nocode-inventory-sync'),
  ].filter(Boolean);

  for (const dataDir of candidates) {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      return path.join(dataDir, 'local-sync-store.json');
    } catch (_) {
      // Try next writable path.
    }
  }

  // Last-resort fallback.
  const fallbackDir = path.join(os.tmpdir(), 'nocode-inventory-sync');
  fs.mkdirSync(fallbackDir, { recursive: true });
  return path.join(fallbackDir, 'local-sync-store.json');
}

function loadStoreFromDisk(filePath) {
  try {
    if (!fs.existsSync(filePath)) return new Map();
    const content = fs.readFileSync(filePath, 'utf8');
    if (!content.trim()) return new Map();
    const parsed = JSON.parse(content);
    const result = new Map();
    Object.entries(parsed).forEach(([batch, rows]) => {
      const rowMap = new Map();
      Object.entries(rows || {}).forEach(([recordKey, item]) => {
        rowMap.set(recordKey, item);
      });
      result.set(batch, rowMap);
    });
    return result;
  } catch (error) {
    console.warn('[WARN] Failed to load local sync store, starting with empty store.');
    return new Map();
  }
}

function saveStoreToDisk(filePath, batchStore) {
  const plainObject = {};
  for (const [batch, rowMap] of batchStore.entries()) {
    plainObject[batch] = {};
    for (const [recordKey, item] of rowMap.entries()) {
      plainObject[batch][recordKey] = item;
    }
  }
  fs.writeFileSync(filePath, `${JSON.stringify(plainObject, null, 2)}\n`, 'utf8');
}

function getBatchMap(batchStore, batch) {
  if (!batchStore.has(batch)) {
    batchStore.set(batch, new Map());
  }
  return batchStore.get(batch);
}

function writeJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let rawBody = '';
    req.on('data', (chunk) => {
      rawBody += chunk;
      if (rawBody.length > 5 * 1024 * 1024) {
        reject(new Error('Body too large'));
      }
    });
    req.on('end', () => resolve(rawBody));
    req.on('error', reject);
  });
}

function resolveStaticDir() {
  const candidates = [
    path.resolve(__dirname, '..', 'build-exe'),
    path.resolve(process.cwd(), 'build-exe'),
    path.resolve(path.dirname(process.execPath), 'build-exe'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'index.html'))) {
      return candidate;
    }
  }
  return null;
}

function isSafeRelativePath(urlPathname) {
  const normalized = path.posix.normalize(urlPathname.replace(/\\/g, '/'));
  if (normalized.includes('\0')) return false;
  if (normalized.startsWith('../') || normalized.includes('/../')) return false;
  return true;
}

function resolveFilePath(staticDir, urlPathname) {
  const pathname = urlPathname === '/' ? '/index.html' : urlPathname;
  if (!isSafeRelativePath(pathname)) return null;
  const relativePath = pathname.replace(/^\/+/, '');
  return path.join(staticDir, relativePath);
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

function isVirtualInterfaceName(interfaceName) {
  return /(loopback|vmware|virtualbox|vbox|hyper-v|vethernet|docker|tailscale|zerotier|wsl|tap|tun|bridge)/i.test(interfaceName);
}

function getPrivateRangeWeight(ip) {
  if (/^192\.168\./.test(ip)) return 30;
  if (/^10\./.test(ip)) return 24;
  const octets = ip.split('.').map((value) => Number(value));
  if (octets.length === 4 && octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return 18;
  return 6;
}

function getInterfaceNameWeight(interfaceName) {
  if (/(wi-?fi|wlan|wireless)/i.test(interfaceName)) return 40;
  if (/(ethernet|lan)/i.test(interfaceName)) return 25;
  if (isVirtualInterfaceName(interfaceName)) return -100;
  return 10;
}

function getLanCandidates() {
  const candidates = [];
  const interfaces = os.networkInterfaces();

  Object.entries(interfaces).forEach(([interfaceName, interfaceList]) => {
    (interfaceList || []).forEach((addressInfo) => {
      const isIPv4 = addressInfo.family === 'IPv4' || addressInfo.family === 4;
      if (!isIPv4 || addressInfo.internal) return;
      if (String(addressInfo.address || '').startsWith('169.254.')) return;

      const ip = String(addressInfo.address || '').trim();
      if (!ip) return;

      const score = getPrivateRangeWeight(ip) + getInterfaceNameWeight(interfaceName);
      candidates.push({
        interfaceName,
        ip,
        score,
      });
    });
  });

  return candidates
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.ip.localeCompare(b.ip);
    })
    .filter((item, index, arr) => arr.findIndex((x) => x.ip === item.ip) === index);
}

function getPreferredIpFromRoutingTable() {
  if (process.platform !== 'win32') return '';

  try {
    const output = execSync('route print -4', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    const entries = [];
    const routeLineRegex = /^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+\S+\s+(\d{1,3}(?:\.\d{1,3}){3})\s+(\d+)/;
    output.split(/\r?\n/).forEach((line) => {
      const match = line.match(routeLineRegex);
      if (!match) return;

      const ip = match[1];
      const metric = Number(match[2]);
      if (!ip || ip === '0.0.0.0' || ip.startsWith('127.') || ip.startsWith('169.254.')) return;
      if (!Number.isFinite(metric)) return;

      entries.push({ ip, metric });
    });

    if (entries.length === 0) return '';
    entries.sort((a, b) => a.metric - b.metric);
    return entries[0].ip;
  } catch (_) {
    return '';
  }
}

function buildNetworkInfo(port) {
  const localUrl = `http://127.0.0.1:${port}`;
  const candidates = getLanCandidates();
  const routePreferredIp = getPreferredIpFromRoutingTable();
  if (routePreferredIp) {
    const routeIndex = candidates.findIndex((item) => item.ip === routePreferredIp);
    if (routeIndex > 0) {
      const [preferredItem] = candidates.splice(routeIndex, 1);
      candidates.unshift(preferredItem);
    } else if (routeIndex < 0) {
      candidates.unshift({
        interfaceName: 'DefaultRoute',
        ip: routePreferredIp,
        score: 999,
      });
    }
  }

  const lanUrls = candidates.map((item) => `http://${item.ip}:${port}`);
  const preferredLanUrl = lanUrls[0] || '';
  const openUrl = preferredLanUrl || localUrl;

  return {
    port,
    localUrl,
    lanUrls,
    preferredLanUrl,
    openUrl,
    candidates,
  };
}

function openDefaultBrowser(url) {
  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  if (process.platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}

function ensureFirewallPortOpen(port) {
  if (process.platform !== 'win32') {
    return { status: 'skipped' };
  }

  const ruleName = `NoCodeInventorySync-${port}`;
  const showCmd = `netsh advfirewall firewall show rule name="${ruleName}"`;
  const addCmd = `netsh advfirewall firewall add rule name="${ruleName}" dir=in action=allow protocol=TCP localport=${port} profile=any`;

  try {
    execSync(showCmd, { stdio: 'ignore' });
    return { status: 'exists', ruleName };
  } catch (_) {
    // Continue and try creating the rule.
  }

  try {
    execSync(addCmd, { stdio: 'ignore' });
    return { status: 'added', ruleName };
  } catch (error) {
    try {
      const argList = `advfirewall firewall add rule name="${ruleName}" dir=in action=allow protocol=TCP localport=${port} profile=any`;
      const psScript = `Start-Process -FilePath 'netsh.exe' -ArgumentList '${argList.replace(/'/g, "''")}' -Verb RunAs -Wait`;
      execSync(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${psScript}"`, { stdio: 'ignore' });
      execSync(showCmd, { stdio: 'ignore' });
      return { status: 'added_by_uac', ruleName };
    } catch (_) {
      return { status: 'failed', ruleName, command: addCmd };
    }
  }
}

async function handleLocalSyncApi(req, res, requestUrl, batchStore, dataFilePath) {
  const method = (req.method || 'GET').toUpperCase();

  if (method === 'GET') {
    const batch = (requestUrl.searchParams.get('batch') || 'default').trim() || 'default';
    const items = Array.from(getBatchMap(batchStore, batch).values());
    writeJson(res, 200, { batch, items, batches: Array.from(batchStore.keys()) });
    return true;
  }

  if (method === 'POST') {
    try {
      const rawBody = await readBody(req);
      const parsedBody = rawBody ? JSON.parse(rawBody) : {};
      const item = parsedBody && parsedBody.item;
      if (!item || typeof item !== 'object') {
        writeJson(res, 400, { message: 'Invalid item payload' });
        return true;
      }

      const batch = String((parsedBody && parsedBody.batch) || item.syncBatch || 'default').trim() || 'default';
      const nowIso = new Date().toISOString();
      const normalizedItem = {
        ...item,
        syncBatch: batch,
        createdAt: item.createdAt || nowIso,
        updatedAt: item.updatedAt || nowIso,
      };
      const recordKey = normalizedItem.recordKey || `${batch}|${Date.now()}|${Math.random().toString(36).slice(2, 10)}`;
      normalizedItem.recordKey = recordKey;

      const rowMap = getBatchMap(batchStore, batch);
      rowMap.set(recordKey, normalizedItem);
      saveStoreToDisk(dataFilePath, batchStore);

      writeJson(res, 200, {
        ok: true,
        batch,
        item: normalizedItem,
        count: rowMap.size,
        batches: Array.from(batchStore.keys()),
      });
      return true;
    } catch (error) {
      writeJson(res, 400, { message: 'Invalid JSON body' });
      return true;
    }
  }

  if (method === 'DELETE') {
    const batch = (requestUrl.searchParams.get('batch') || '').trim();
    if (batch) {
      batchStore.delete(batch);
    } else {
      batchStore.clear();
    }
    saveStoreToDisk(dataFilePath, batchStore);
    writeJson(res, 200, { ok: true, batch: batch || null });
    return true;
  }

  writeJson(res, 405, { message: 'Method Not Allowed' });
  return true;
}

function handleNetworkApi(req, res, port) {
  const method = (req.method || 'GET').toUpperCase();
  if (method !== 'GET') {
    writeJson(res, 405, { message: 'Method Not Allowed' });
    return true;
  }

  const networkInfo = buildNetworkInfo(port);
  writeJson(res, 200, {
    localUrl: networkInfo.localUrl,
    preferredLanUrl: networkInfo.preferredLanUrl,
    lanUrls: networkInfo.lanUrls,
  });
  return true;
}

async function serveStatic(req, res, requestUrl, staticDir) {
  if (!['GET', 'HEAD'].includes((req.method || 'GET').toUpperCase())) {
    res.statusCode = 405;
    res.end('Method Not Allowed');
    return;
  }

  let decodedPathname;
  try {
    decodedPathname = decodeURIComponent(requestUrl.pathname);
  } catch (_) {
    res.statusCode = 400;
    res.end('Bad Request');
    return;
  }

  let filePath = resolveFilePath(staticDir, decodedPathname);
  if (!filePath) {
    res.statusCode = 403;
    res.end('Forbidden');
    return;
  }

  let stat = null;
  try {
    stat = fs.statSync(filePath);
  } catch (_) {
    // Fallback to index.html for SPA routes.
  }

  if (!stat || !stat.isFile()) {
    filePath = path.join(staticDir, 'index.html');
    stat = fs.statSync(filePath);
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', getMimeType(filePath));
  res.setHeader('Content-Length', stat.size);
  res.setHeader('Cache-Control', filePath.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable');

  if ((req.method || 'GET').toUpperCase() === 'HEAD') {
    res.end();
    return;
  }

  const stream = fs.createReadStream(filePath);
  stream.on('error', () => {
    if (!res.headersSent) {
      res.statusCode = 500;
    }
    res.end('Internal Server Error');
  });
  stream.pipe(res);
}

function printStartupBanner(staticDir, dataFilePath, firewallResult, networkInfo, requestedPort) {
  console.log('');
  console.log(`=== ${APP_NAME} ===`);
  if (requestedPort !== networkInfo.port) {
    console.log(`Port Adjusted: requested ${requestedPort}, using ${networkInfo.port}`);
  }
  console.log(`Static Dir: ${staticDir}`);
  console.log(`Local Sync Store: ${dataFilePath}`);
  console.log(`Runtime Log: ${RUNTIME_LOG_PATH}`);
  console.log(`Local URL: ${networkInfo.localUrl}`);
  if (networkInfo.lanUrls.length > 0) {
    console.log('LAN URL(s):');
    networkInfo.candidates.forEach((item) => {
      console.log(`  - http://${item.ip}:${networkInfo.port} (${item.interfaceName})`);
    });
  } else {
    console.log('LAN URL(s): none detected');
  }
  if (firewallResult.status === 'added') {
    console.log(`Firewall: inbound rule added (${firewallResult.ruleName})`);
  } else if (firewallResult.status === 'added_by_uac') {
    console.log(`Firewall: inbound rule added after UAC confirmation (${firewallResult.ruleName})`);
  } else if (firewallResult.status === 'exists') {
    console.log(`Firewall: inbound rule already exists (${firewallResult.ruleName})`);
  } else if (firewallResult.status === 'failed') {
    console.log('Firewall: failed to add rule automatically.');
    console.log('Run PowerShell as Administrator and execute:');
    console.log(`  ${firewallResult.command}`);
  } else {
    console.log('Firewall: skipped (non-Windows)');
  }
  console.log('');
}

async function main() {
  const { port: requestedPort, noOpen } = parseArgs(process.argv.slice(2));
  appendRuntimeLog('INFO', `Process started. requestedPort=${requestedPort}`);
  const staticDir = resolveStaticDir();

  if (!staticDir) {
    appendRuntimeLog('ERROR', 'build-exe/index.html not found.');
    console.error('[ERROR] Could not find build-exe/index.html.');
    console.error('Please run "npm run build:exe" first.');
    process.exit(1);
  }

  let port = requestedPort;
  try {
    port = await findAvailablePort(requestedPort, MAX_PORT_RETRY);
  } catch (error) {
    appendRuntimeLog('ERROR', `No available port: ${error.message}`);
    console.error(`[ERROR] ${error.message}`);
    console.error(`Runtime log: ${RUNTIME_LOG_PATH}`);
    process.exit(1);
  }

  if (port !== requestedPort) {
    appendRuntimeLog('WARN', `Requested port ${requestedPort} unavailable, switched to ${port}`);
  }

  const networkInfo = buildNetworkInfo(port);
  const dataFilePath = getDataFilePath();
  const batchStore = loadStoreFromDisk(dataFilePath);
  const firewallResult = ensureFirewallPortOpen(port);

  const server = http.createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
      if (requestUrl.pathname === '/__local_sync__/inventory') {
        await handleLocalSyncApi(req, res, requestUrl, batchStore, dataFilePath);
        return;
      }
      if (requestUrl.pathname === '/__local_sync__/network') {
        handleNetworkApi(req, res, port);
        return;
      }
      await serveStatic(req, res, requestUrl, staticDir);
    } catch (error) {
      res.statusCode = 500;
      res.end('Internal Server Error');
      appendRuntimeLog('ERROR', `Request failed: ${error.stack || error.message}`);
      console.error('[ERROR] Request failed:', error.message);
    }
  });

  server.on('error', (error) => {
    appendRuntimeLog('ERROR', `Server startup error: ${error.stack || error.message}`);
    console.error('[ERROR] Server failed to start:', error.message);
    console.error(`Runtime log: ${RUNTIME_LOG_PATH}`);
    process.exit(1);
  });

  server.listen(port, '0.0.0.0', () => {
    appendRuntimeLog('INFO', `Server listening on port ${port}`);
    printStartupBanner(staticDir, dataFilePath, firewallResult, networkInfo, requestedPort);
    if (!noOpen) {
      openDefaultBrowser(networkInfo.openUrl);
    }
  });
}

process.on('uncaughtException', (error) => {
  appendRuntimeLog('FATAL', `uncaughtException: ${error.stack || error.message}`);
});

process.on('unhandledRejection', (reason) => {
  const text = reason && reason.stack ? reason.stack : String(reason);
  appendRuntimeLog('FATAL', `unhandledRejection: ${text}`);
});

main().catch((error) => {
  appendRuntimeLog('FATAL', `main() failed: ${error.stack || error.message}`);
  console.error('[ERROR] Fatal startup error:', error.message);
  console.error(`Runtime log: ${RUNTIME_LOG_PATH}`);
  process.exit(1);
});
