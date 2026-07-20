// @ts-check
const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * Plugin to copy sql.js WASM binary to the output directory.
 * sql.js needs the .wasm file at runtime and can't be bundled by esbuild.
 * @type {import('esbuild').Plugin}
 */
const sqlJsWasmPlugin = {
  name: 'sql-js-wasm-copy',
  setup(build) {
    build.onEnd(() => {
      const wasmSource = path.join(__dirname, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
      const wasmDest = path.join(__dirname, 'out', 'sql-wasm.wasm');

      if (fs.existsSync(wasmSource)) {
        fs.copyFileSync(wasmSource, wasmDest);
        console.log('[sql.js] Copied sql-wasm.wasm to out/');
      } else {
        console.warn('[sql.js] WARNING: sql-wasm.wasm not found at', wasmSource);
      }
    });
  },
};

/**
 * Plugin to report build errors in a VS Code problem-matcher friendly format.
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
  name: 'esbuild-problem-matcher',
  setup(build) {
    build.onStart(() => {
      console.log('[watch] build started');
    });
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`);
        if (location) {
          console.error(`    ${location.file}:${location.line}:${location.column}:`);
        }
      });
      console.log('[watch] build finished');
    });
  },
};

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    outfile: 'out/extension.js',
    external: [
      'vscode', // VS Code API is provided at runtime
    ],
    logLevel: 'info',
    plugins: [
      sqlJsWasmPlugin,
      esbuildProblemMatcherPlugin,
    ],
    define: {
      'process.env.NODE_ENV': production ? '"production"' : '"development"',
    },
  });

  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
