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
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  // Config/script JS has no project type info: run only untyped rules there.
  {
    files: ['**/*.js', '**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // Numbers in template literals are safe and heavily used for stats/ids.
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true },
      ],
      // ArkQR intentionally guards Web APIs that exist in lib.dom types but
      // are missing on older browsers (BarcodeDetector, CompressionStream,
      // webkitAudioContext, captureStream, ...). Those runtime checks look
      // "unnecessary" to the type checker but are load-bearing compat code.
      '@typescript-eslint/no-unnecessary-condition': 'off',
      // The typed getElementById helper is idiomatic; the single-use
      // parameter is the whole point.
      '@typescript-eslint/no-unnecessary-type-parameters': 'off',
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
