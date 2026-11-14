import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      'build/**', 'dist/**', 'kun/dist/**', 'node_modules/**', 'out/**', 'coverage/**',
      'src/asset/skills/**', 'src/asset/pptx-editors/third-party/**',
      // User-authored media projects are workspace content, not application code.
      'railwise-video-skills/**', 'railwise-video-v4/**', 'deliverables/**'
    ]
  },
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node
      }
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'no-async-promise-executor': 'off',
      'no-unused-vars': 'off',
      'no-useless-assignment': 'off',
      'preserve-caught-error': 'off'
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      '@typescript-eslint': tseslint.plugin
    },
    languageOptions: {
      parser: tseslint.parser
    },
    rules: {
      'no-redeclare': 'off',
      'no-undef': 'off'
    }
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks
    },
    rules: {
      'react-hooks/exhaustive-deps': 'warn',
      'react-hooks/rules-of-hooks': 'error'
    }
  }
)
