import { fileURLToPath, URL } from 'url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: 8080,
    hmr: {
      overlay: false,
    },
  },
  plugins: [react()],
  base: '/',
  build: {
    outDir: 'build-exe',
    emptyOutDir: true,
  },
  resolve: {
    alias: [
      {
        find: '@',
        replacement: fileURLToPath(new URL('./src', import.meta.url)),
      },
    ],
  },
});

