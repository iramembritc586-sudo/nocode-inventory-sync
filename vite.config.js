import { fileURLToPath, URL } from 'url';
import { defineConfig } from 'vite';
import { resolve } from 'path';
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

const createLocalSyncDevPlugin = () => {
  const batchStore = new Map();

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
          writeJson(res, 200, { ok: true });
          return;
        }

        next();
      });
    },
  };
};

const isProdEnv = process.env.NODE_ENV === 'production';
const PUBLIC_PATH = isProdEnv ? process.env.PUBLIC_PATH + '/' + process.env.CHAT_VARIABLE : process.env.PUBLIC_PATH;
const OUT_DIR = isProdEnv ? 'build/' + process.env.CHAT_VARIABLE : 'build';
const PLUGINS = isProdEnv ? [
  react(),
  prodHtmlTransformer(process.env.CHAT_VARIABLE)
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
    outDir: OUT_DIR
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
