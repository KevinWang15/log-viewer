import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  // Relative asset URLs let the same build run at / as a standalone app or
  // below a reverse-proxy prefix such as /log-viewer/ when embedded.
  base: './',
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:5178',
      '/ws': { target: 'ws://localhost:5178', ws: true },
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        embed: resolve(__dirname, 'embed.html'),
        component: resolve(__dirname, 'component.html'),
      },
    },
  },
});
