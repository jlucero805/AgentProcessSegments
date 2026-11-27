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
    // Server tests must wait on an observable condition or fake timers. A
    // wall-clock setTimeout/setInterval is a fixed sleep unless it is a
    // bounded fail-fast guard, and guards must justify themselves with
    // `eslint-disable-next-line no-restricted-syntax -- <reason>`.
    files: ['src/server/test/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='setTimeout']",
          message:
            'Do not use wall-clock setTimeout in server tests; await an observable condition or use fake timers. A bounded fail-fast guard needs an eslint-disable-next-line no-restricted-syntax comment with a reason.',
        },
        {
          selector: "CallExpression[callee.property.name='setTimeout']",
          message:
            'Do not use wall-clock setTimeout in server tests; await an observable condition or use fake timers.',
        },
        {
          selector: "CallExpression[callee.name='setInterval']",
          message:
            'Do not use setInterval in server tests; use fake timers or an observable condition.',
        },
        {
          selector: "CallExpression[callee.property.name='setInterval']",
          message:
            'Do not use setInterval in server tests; use fake timers or an observable condition.',
        },
        {
          selector: "ImportDeclaration[source.value='node:timers/promises']",
          message:
            'Do not import node:timers/promises in server tests; it is a fixed sleep.',
        },
        {
          selector: "ImportDeclaration[source.value='timers/promises']",
          message:
            'Do not import timers/promises in server tests; it is a fixed sleep.',
        },
      ],
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
