import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Files still allowed to write to disk directly. `ChangeSetService` is the intended
 * permanent home for every mutation; `ChatWebviewProvider` is listed only because it
 * still carries the legacy SEARCH/REPLACE edit path, which Phase 4 deletes. Removing
 * that entry is the acceptance test for Phase 4.
 */
const FILE_WRITE_ALLOWLIST = [
  'src/layer3-reasoning/agent/ChangeSetService.ts',
  'src/layer2-context/database/DatabaseManager.ts', // persists the extension's own SQLite store, never workspace files
  'src/vscode/providers/ChatWebviewProvider.ts', // TODO(phase-4): delete the legacy edit path, then drop this line
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
);
