import * as path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
  resolve: {
    alias: {
      // The extension host supplies `vscode` at runtime; unit tests get a hand-rolled stub
      // so that anything importing the API stays testable outside VS Code.
      vscode: path.resolve(__dirname, 'test/mocks/vscode.ts'),
    },
  },
});
