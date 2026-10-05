import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/', 'coverage/', 'public/sw.js'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.worker, ...globals.node },
    },
  },
  {
    files: ['src/**/*.ts', 'tests/**/*.ts', 'scripts/**/*.mjs'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
