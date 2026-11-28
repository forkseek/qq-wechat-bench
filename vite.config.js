import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.join(root, 'frontend'),
  base: '/app/',
  plugins: [vue()],
  build: {
    outDir: path.join(root, 'public', 'app'),
    emptyOutDir: true,
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        main: path.join(root, 'frontend', 'index.html'),
        widget: path.join(root, 'frontend', 'widget.html'),
        pet: path.join(root, 'frontend', 'pet.html')
      }
    }
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:4318',
      '/qq-login': 'http://127.0.0.1:4318'
    }
  }
});
