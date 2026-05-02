import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

const alias = {
  '@app': resolve(__dirname, 'app'),
  '@shared': resolve(__dirname, 'shared'),
  '@agent-types': resolve(__dirname, 'agent/types'),
};

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'app/main/index.ts') },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'app/preload/index.ts') },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'app/renderer'),
    resolve: { alias },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'app/renderer/index.html') },
      },
    },
  },
});
