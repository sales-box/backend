// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      "prettier/prettier": ["error", { endOfLine: "auto" }],
    },
  },
  {
    files: ['src/database/pagination/pagination.extension.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off'
    }
  },
  {
    // Developer scripts (evals, backfills, one-off probes). The repo's own
    // `pnpm lint` has always scoped to {src,apps,libs,test} — scripts/ is
    // deliberately outside it. lint-staged does not know that: it lints
    // whatever is staged, by path, so the first commit that touches a script
    // fails on rules the project never intended to apply to it.
    //
    // Type-aware linting also degrades here: these files sit outside the
    // program eslint builds for src/, so imported types resolve to `any` and
    // every field access trips a no-unsafe-* rule. Turning those off is
    // honest — the type checking that matters is `tsc -p tsconfig.json`,
    // which DOES cover scripts/ and which these files now pass.
    files: ['scripts/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
  {
    // US-043 external content resolver: structurally forbid raw HTTP on client
    // URLs (only the Google Drive SDK may fetch) and any AI/LLM import (sprint
    // rule: zero AI). Tests are exempt — the behavioral no-fetch spec spies on
    // the network primitives on purpose.
    files: ['src/modules/external-content/**/*.ts'],
    ignores: ['src/modules/external-content/**/*.spec.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'fetch',
          message:
            'US-043: no raw fetch on client URLs — only the Google Drive SDK.',
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'http',
                'https',
                'node:http',
                'node:https',
                'axios',
                'undici',
                'got',
                'node-fetch',
                'gaxios',
                'superagent',
                'request',
              ],
              message:
                'US-043: no raw HTTP on client URLs — only the Google Drive SDK.',
            },
            {
              group: [
                'openai',
                '@anthropic-ai/*',
                'langchain',
                '@langchain/*',
                'cohere-ai',
                '@google/generative-ai',
                '@google/genai',
                'genai',
                '@huggingface/*',
                '@xenova/*',
                '@tensorflow/*',
                '@tensorflow-models/*',
                '*embeddings*',
              ],
              message: 'US-043 sprint rule: zero AI/LLM/embedding calls.',
            },
          ],
        },
      ],
    },
  }
);
