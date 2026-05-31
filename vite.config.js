import { fileURLToPath, URL } from 'url';
import { defineConfig } from 'vite';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { networkInterfaces, tmpdir } from 'os';
import { devLogger } from '@meituan-nocode/vite-plugin-dev-logger';
import { devHtmlTransformer, prodHtmlTransformer } from '@meituan-nocode/vite-plugin-nocode-html-transformer';
import react from '@vitejs/plugin-react';

const buildDevNetworkInfo = (port = 8080) => {
  const localUrl = `http://127.0.0.1:${port}`;
  const interfaces = networkInterfaces();
  const lanIps = [];

  Object.entries(interfaces).forEach(([name, list]) => {
    (list || []).forEach((addressInfo) => {
      const isIPv4 = addressInfo.family === 'IPv4' || addressInfo.family === 4;
      if (!isIPv4 || addressInfo.internal) return;
      const ip = String(addressInfo.address || '').trim();
      if (!ip || ip.startsWith('169.254.')) return;
      lanIps.push({
        ip,
        name,
      });
    });
  });

  const preferred = lanIps[0]?.ip ? `http://${lanIps[0].ip}:${port}` : '';
  return {
    localUrl,
    preferredLanUrl: preferred,
    lanUrls: lanIps.map((item) => `http://${item.ip}:${port}`),
  };
};

const LOCAL_SYNC_STORE_FILE = resolve(tmpdir(), '.nocode-dev-logs', 'inventory-sync-store.json');

const loadLocalSyncStore = () => {
  const store = new Map();
  try {
    if (!existsSync(LOCAL_SYNC_STORE_FILE)) return store;
    const parsed = JSON.parse(readFileSync(LOCAL_SYNC_STORE_FILE, 'utf-8'));
    Object.entries(parsed?.batches || {}).forEach(([batch, items]) => {
      store.set(batch, new Map(Object.entries(items || {})));
    });
  } catch (error) {
    console.warn('读取本地同步缓存失败，将使用空缓存:', error);
  }
  return store;
};

const persistLocalSyncStore = (store) => {
  try {
    const batches = {};
    store.forEach((batchMap, batch) => {
      batches[batch] = Object.fromEntries(batchMap.entries());
    });
    mkdirSync(dirname(LOCAL_SYNC_STORE_FILE), { recursive: true });
    writeFileSync(LOCAL_SYNC_STORE_FILE, JSON.stringify({ batches }, null, 2));
  } catch (error) {
    console.warn('写入本地同步缓存失败:', error);
  }
};

const createLocalSyncDevPlugin = () => {
  const batchStore = loadLocalSyncStore();

  const writeJson = (res, statusCode, payload) => {
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
  };

  const getBatchMap = (batch) => {
    if (!batchStore.has(batch)) {
      batchStore.set(batch, new Map());
    }
    return batchStore.get(batch);
  };

  return {
    name: 'local-sync-dev-api',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__local_sync__/network', (req, res, next) => {
        const method = (req.method || 'GET').toUpperCase();
        if (method !== 'GET') {
          next();
          return;
        }
        const port = Number(server.config.server?.port || 8080);
        const networkInfo = buildDevNetworkInfo(port);
        writeJson(res, 200, networkInfo);
      });

      server.middlewares.use('/__local_sync__/inventory', (req, res, next) => {
        const method = (req.method || 'GET').toUpperCase();

        if (method === 'GET') {
          const requestUrl = new URL(req.url || '/', 'http://localhost');
          const batch = (requestUrl.searchParams.get('batch') || 'default').trim() || 'default';
          const items = Array.from(getBatchMap(batch).values());
          writeJson(res, 200, { batch, items, batches: Array.from(batchStore.keys()) });
          return;
        }

        if (method === 'POST') {
          let rawBody = '';
          req.on('data', (chunk) => {
            rawBody += chunk;
          });
          req.on('end', () => {
            try {
              const parsedBody = rawBody ? JSON.parse(rawBody) : {};
              const item = parsedBody?.item;
              if (!item || typeof item !== 'object') {
                writeJson(res, 400, { message: 'Invalid item payload' });
                return;
              }

              const batch = String(parsedBody?.batch || item.syncBatch || 'default').trim() || 'default';
              const nowIso = new Date().toISOString();
              const normalizedItem = {
                ...item,
                syncBatch: batch,
                createdAt: item.createdAt || nowIso,
                updatedAt: item.updatedAt || nowIso,
              };
              const recordKey = normalizedItem.recordKey || `${batch}|${Date.now()}|${Math.random().toString(36).slice(2, 10)}`;
              normalizedItem.recordKey = recordKey;

              const batchMap = getBatchMap(batch);
              batchMap.set(recordKey, normalizedItem);
              persistLocalSyncStore(batchStore);
              writeJson(res, 200, { ok: true, item: normalizedItem, count: batchMap.size, batch, batches: Array.from(batchStore.keys()) });
            } catch (error) {
              writeJson(res, 400, { message: 'Invalid JSON body' });
            }
          });
          return;
        }

        if (method === 'DELETE') {
          const requestUrl = new URL(req.url || '/', 'http://localhost');
          const batch = (requestUrl.searchParams.get('batch') || '').trim();
          if (batch) {
            batchStore.delete(batch);
          } else {
            batchStore.clear();
          }
          persistLocalSyncStore(batchStore);
          writeJson(res, 200, { ok: true });
          return;
        }

        next();
      });
    },
  };
};

const isProdEnv = process.env.NODE_ENV === 'production';
const chatVariable = process.env.CHAT_VARIABLE || '';
const publicPath = process.env.PUBLIC_PATH || '/';
const PUBLIC_PATH = isProdEnv && chatVariable ? `${publicPath.replace(/\/$/, '')}/${chatVariable}` : publicPath;
const OUT_DIR = isProdEnv && chatVariable ? `build/${chatVariable}` : 'build';
const PLUGINS = isProdEnv ? [
  react(),
  ...(chatVariable ? [prodHtmlTransformer(chatVariable)] : [])
] : [
  devLogger({
    dirname: resolve(tmpdir(), '.nocode-dev-logs'),
    maxFiles: '3d',
  }),
  react(),
  devHtmlTransformer(process.env.CHAT_VARIABLE),
];
if (!isProdEnv) {
  PLUGINS.push(createLocalSyncDevPlugin());
}
if (process.env.NOCODE_COMPILER_PATH) {
    const { componentCompiler } = await import(process.env.NOCODE_COMPILER_PATH);
    PLUGINS.push(componentCompiler());
}

// https://vitejs.dev/config/
export default defineConfig({
  server: {
    host: '::',
    port: '8080',
    hmr: {
      overlay: false
    }
  },
  plugins: [
    PLUGINS
  ],
  base: PUBLIC_PATH,
  build: {
    outDir: OUT_DIR,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('/xlsx/')) return 'xlsx';
          if (id.includes('/@radix-ui/') || id.includes('/lucide-react/')) return 'ui-vendor';
          return 'vendor';
        },
      },
    },
  },
  resolve: {
    alias: [
      {
        find: '@',
        replacement: fileURLToPath(new URL('./src', import.meta.url)),
      },
      {
        find: 'lib',
        replacement: resolve(__dirname, 'lib'),
      },
    ],
  },
});
