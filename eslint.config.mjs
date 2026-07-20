import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * The only files permitted to write to disk directly.
 *
 * `ChangeSetService` is the single path through which workspace files may be mutated, so
 * that approval, hash-staleness checks, and revert history cannot be bypassed.
 * `DatabaseManager` is exempt because it persists the extension's own SQLite store, never
 * anything in the user's workspace.
 */
const FILE_WRITE_ALLOWLIST = [
  'src/layer3-reasoning/agent/ChangeSetService.ts',
  'src/layer2-context/database/DatabaseManager.ts',
];

export default tseslint.config(
  { ignores: ['out/**', 'node_modules/**', 'webview-ui/dist/**', 'scratch/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    // Build scripts are CommonJS by design.
    files: ['**/*.js', '**/*.cjs'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    files: ['src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      // Pre-existing lazy requires in ContextAssembler/PromptBuilder, some of which
      // break genuine import cycles. Surfaced as debt rather than errors; the files
      // that carry them are rewritten in later phases anyway.
      '@typescript-eslint/no-require-imports': 'warn',
    },
  },
  {
    // ChangeSetService is the single code path allowed to mutate files on disk.
    // Every other module must route through it so approval, hash-staleness checks
    // and revert history cannot be bypassed.
    files: ['src/**/*.ts'],
    ignores: FILE_WRITE_ALLOWLIST,
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[property.name=/^(writeFileSync|writeFile|rmSync|unlinkSync|renameSync)$/]",
          message: 'File mutations must go through ChangeSetService so they are approved, hash-checked and revertible.',
        },
      ],
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // The webview runs in a browser, not the extension host: node globals are absent and
    // DOM globals are present. Without this block the root config lints these files with
    // `globals.node`, so `document` and `window` read as undefined.
    files: ['webview-ui/src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      // The webview talks to the host over postMessage, which is untyped at the boundary.
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
);
