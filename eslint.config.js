/**
 * Configuration ESLint minimale (flat config), sans dependance supplementaire.
 * Le typage reel est assure par `npm run typecheck` (TypeScript) : ESLint ne
 * sert ici qu'a reperer quelques erreurs evidentes.
 */
export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'data/**', 'logs/**'],
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      eqeqeq: ['warn', 'smart'],
      'no-var': 'error',
      'prefer-const': 'warn',
      'no-debugger': 'error',
    },
  },
];
