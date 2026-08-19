import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['node_modules/**', 'dist/**', 'coverage/**', 'apps/admin-web/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Keep modules focused so no file grows into a monolith again (app.ts was 1616 lines before the
      // routes/ split). At ~400 code-lines, split by concern into modules with a thin composition root —
      // do NOT disable this rule to get past it. Counts code only (blank + comment lines don't count).
      // See .claude/context/04-conventions.md for the module pattern.
      'max-lines': ['error', { max: 400, skipBlankLines: true, skipComments: true }],
      // Package boundary: cross-package code goes through the @ratio/* name, never a
      // relative path that reaches into packages/. Intra-package relative imports are fine.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/packages/**'],
              message:
                'Import across packages via their @ratio/* workspace name, not a relative path into packages/.',
            },
          ],
        },
      ],
    },
  },
  {
    // Test files legitimately grow with fixtures/cases — they're not the production-monolith risk the
    // max-lines guardrail targets. (A giant test file is still worth splitting, just not blocked here.)
    files: ['**/*.test.ts', '**/__tests__/**/*.ts'],
    rules: { 'max-lines': 'off' },
  },
  {
    // Generated files — size is inherent (inlined spec / theme bytes), not a design smell.
    files: [
      'packages/control-plane-client/src/schema.ts',
      'packages/builder-core/src/theme/default-theme.generated.ts',
    ],
    rules: { 'max-lines': 'off' },
  },
  prettier
);
