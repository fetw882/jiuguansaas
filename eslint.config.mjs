import js from '@eslint/js';
import jsdoc from 'eslint-plugin-jsdoc';
import globals from 'globals';

const sharedRules = {
    'jsdoc/no-undefined-types': ['warn', { disableReporting: true, markVariablesAsUsed: true }],
    'no-unused-vars': ['error', { args: 'none' }],
    'no-control-regex': 'off',
    'no-constant-condition': ['error', { checkLoops: false }],
    'require-yield': 'off',
    'quotes': 'off',
    'semi': ['error', 'always'],
    'indent': 'off',
    'comma-dangle': 'off',
    'eol-last': 'off',
    'no-trailing-spaces': 'off',
    'object-curly-spacing': 'off',
    'space-infix-ops': 'off',
    'no-unused-expressions': ['error', { allowShortCircuit: true, allowTernary: true }],
    'no-cond-assign': 'error',
    'no-unneeded-ternary': 'error',
    'no-irregular-whitespace': ['error', { skipStrings: true, skipTemplates: true }],
    'no-async-promise-executor': 'off',
    'no-inner-declarations': 'off',
    'no-empty': ['error', { allowEmptyCatch: true }],
    'no-useless-escape': 'off',
};

const ignoredPaths = [
    '**/node_modules/**',
    '**/dist/**',
    '**/.git/**',
    'public/**',
    'src/**',
    'SillyTavern/**',
    'default/**',
    'public/lib/**',
    'backups/**',
    'data/**',
    'cache/**',
    'src/tokenizers/**',
    'docker/**',
    'plugins/**',
    '**/*.min.js',
    'public/scripts/extensions/quick-reply/lib/**',
    'public/scripts/extensions/tts/lib/**',
    'tests/.eslintrc.js',
];

export default [
    {
        ignores: ignoredPaths,
    },
    js.configs.recommended,
    {
        files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
        plugins: {
            jsdoc,
        },
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
        },
        rules: sharedRules,
    },
    {
        files: ['src/**/*.js', '*.js', 'plugins/**/*.js', 'gateway/**/*.js'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: {
                ...globals.node,
                globalThis: 'readonly',
                Deno: 'readonly',
            },
        },
    },
    {
        files: ['*.cjs'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'commonjs',
            globals: {
                ...globals.node,
            },
        },
    },
    {
        files: ['src/**/*.mjs'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: {
                ...globals.node,
            },
        },
    },
    {
        files: ['public/**/*.js'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: {
                ...globals.browser,
                ...globals.jquery,
                globalThis: 'readonly',
                ePub: 'readonly',
                pdfjsLib: 'readonly',
                toastr: 'readonly',
                SillyTavern: 'readonly',
            },
        },
    },
    {
        files: ['tests/**/*.js'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: {
                ...globals.jest,
                ...globals.node,
                page: 'readonly',
                browser: 'readonly',
                context: 'readonly',
            },
        },
    },
    {
        files: [
            'public/scripts/slash-commands.js',
            'public/scripts/slash-commands/SlashCommand.js',
        ],
        rules: {
            'no-unused-vars': 'off',
        },
    },
];
