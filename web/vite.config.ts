import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite на 5173, Go-сервер на 7777. /api и /ws проксируем в Go.
// VITE_BASE_PATH задаётся в CI для деплоя на GitHub Pages (/ZubraMeet/).
export default defineConfig({
  base: process.env.VITE_BASE_PATH ?? '/',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:7777', changeOrigin: true },
      '/ws': { target: 'ws://localhost:7777', ws: true, changeOrigin: true },
    },
  },
});
