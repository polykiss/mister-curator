import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@app': resolve(__dirname, 'app'),
      '@shared': resolve(__dirname, 'shared'),
      '@agent-types': resolve(__dirname, 'agent/types'),
    },
  },
  test: {
    environment: 'node',
    passWithNoTests: true,
  },
});
