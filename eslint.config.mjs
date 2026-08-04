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
  prettier
);
