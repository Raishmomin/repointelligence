import react from '@vitejs/plugin-react';
import * as path from 'path';
import { defineConfig } from 'vite';

/**
 * Builds the sidebar UI into the extension's own `out/` directory.
 *
 * Three settings here are load-bearing:
 *
 *  - **`outDir: ../out/webview`**, not `webview-ui/dist`. `.vscodeignore` excludes
 *    `webview-ui/**` to keep tens of MB of React tooling out of the VSIX; emitting into
 *    `out/` (which is not excluded) means the built UI ships and the packaging trap is
 *    unreachable rather than merely avoided.
 *  - **`emptyOutDir: false`**. It is pointed inside `out/`, which also holds
 *    `extension.js` and `sql-wasm.wasm` — clearing it would delete the extension bundle
 *    on every UI build.
 *  - **`define: process.env.NODE_ENV`**. Library mode does not define it, and React reads
 *    it at module scope, so without this the panel dies with `process is not defined`
 *    before the first render.
 */
export default defineConfig({
  plugins: [react()],

  resolve: {
    alias: {
      // Types shared with the extension host. Only `src/shared/types` and the pure
      // provider schema are importable — anything touching `vscode` is not.
      '@shared': path.resolve(__dirname, '../src/shared/types'),
      '@providers': path.resolve(__dirname, '../src/layer3-reasoning/providers'),
    },
  },

  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },

  build: {
    outDir: path.resolve(__dirname, '../out/webview'),
    emptyOutDir: false,
    // No hashed filenames: the extension host builds the URIs itself and should never have
    // to parse a manifest to find them.
    lib: {
      entry: path.resolve(__dirname, 'src/main.tsx'),
      formats: ['iife'],
      name: 'RepoIntelligenceUI',
      fileName: () => 'index.js',
    },
    rollupOptions: {
      output: {
        assetFileNames: 'index.[ext]',
        // A single self-contained bundle: a webview cannot resolve chunk imports without
        // extra plumbing, and there is nothing here worth code-splitting.
        inlineDynamicImports: true,
      },
    },
    // Sourcemaps only outside production, so the shipped VSIX stays small.
    sourcemap: process.env.NODE_ENV !== 'production',
    target: 'es2022',
  },
});
