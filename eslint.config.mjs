import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**'] },
  {
    files: ['**/*.{js,mjs,cjs}'],
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    extends: [js.configs.recommended],
    languageOptions: {
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      // Underscore-prefixed names are the repo's intentional "unused" marker
      // (fake harness callbacks, ignored request params in tests).
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs' },
  },
  {
    // Puppeteer evaluates these callbacks in the page, not in Node.
    files: ['scripts/screenshots.mjs', 'scripts/ui-smoke.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: ['src/**/*.{ts,tsx,mts,cts}', '.opencode/**/*.{ts,mts,cts}'],
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    extends: [...tseslint.configs.recommended],
    rules: {
      // Underscore-prefixed names are the repo's intentional "unused" marker
      // (fake harness callbacks, ignored request params in tests).
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
      // `npm run lint` uses --max-warnings=0, so a new explicit `any` fails the
      // gate unless it carries a justified inline suppression.
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    // The compiler-backed preset: the classic hook rules plus the React
    // correctness rules (set-state-in-effect, refs, purity, ...). Effects keep
    // synchronous state writes out of their bodies; see AGENTS.md.
    files: ['src/web/src/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat['recommended-latest']],
  },
);
