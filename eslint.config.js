import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'coverage', 'client', '**/*.js'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/no-confusing-void-expression': 'off',
      'no-console': ['error', { allow: ['error'] }],
    },
  },
  {
    // El dominio es puro: no puede importar red, base de datos ni framework.
    files: ['src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [
        { group: ['fastify*', '@fastify/*', 'pg', 'ioredis', 'ws', 'node:*', '@azure/*', '../app/*', '../infra/*', '../transport/*'], message: 'El dominio debe ser puro.' },
      ] }],
    },
  },
  { files: ['tools/**', 'load/**', 'test/**'], rules: { 'no-console': 'off', '@typescript-eslint/no-non-null-assertion': 'off' } },
);
