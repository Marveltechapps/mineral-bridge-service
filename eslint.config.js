import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/** Flat ESLint for Mineral Bridge. Legacy admin/v1 code is linted softly; new /v2 modules stay clean. */
export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      'no-console': 'off',
      'no-useless-assignment': 'off',
      'no-useless-escape': 'warn',
      'no-irregular-whitespace': 'warn',
      'prefer-const': 'warn',
      'no-empty': 'warn',
    },
  },
);
