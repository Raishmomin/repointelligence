import * as path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, '../src/shared/types'),
      '@providers': path.resolve(__dirname, '../src/layer3-reasoning/providers'),
    },
  },
});
