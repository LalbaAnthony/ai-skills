// Reference ESLint configuration of the typescript-strict skill, shared by Node and Vite projects.
// Dev dependencies: eslint, typescript-eslint, typescript (within typescript-eslint's peer range).
// It lints src/ and tests/ only; root tool configs and scripts are reviewed by hand.

import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

const CODE = ['src/**/*.{ts,tsx}', 'tests/**/*.{ts,tsx}'];
const TYPES = ['src/types/**/*.ts', 'tests/types/**/*.ts'];
const AMBIENT = ['src/types/**/*.d.ts'];
const VALIDATION = ['src/validation/**/*.{ts,tsx}'];

// Restricted in every file under CODE.
const ALWAYS = [
  {
    selector: 'TSEnumDeclaration',
    message: 'enum is banned: declare a union type in src/types/, plus an `as const` array in a logic module if the values are needed at runtime.',
  },
  {
    selector: ':matches(PropertyDefinition, AccessorProperty, VariableDeclarator)[definite=true]',
    message: 'Definite assignment (`x!: T`) is banned: initialize the value, or type it as optional and check it.',
  },
  {
    selector: 'TSModuleDeclaration[kind="module"]:not([body])',
    message: 'Shorthand `declare module` types the whole module as any: declare its exports in src/types/*.d.ts.',
  },
  {
    selector: 'CallExpression[callee.property.name=/^(querySelector|querySelectorAll|closest)$/][typeArguments]',
    message: 'A type argument on a DOM query is an unchecked cast: narrow the result with instanceof.',
  },
  {
    selector: 'ImportSpecifier[importKind="type"], ExportSpecifier[exportKind="type"]',
    message: 'Use a top-level `import type` / `export type` statement, not an inline `type` modifier.',
  },
  {
    selector: 'CallExpression[callee.type="Identifier"][callee.name="require"]',
    message: 'ESM only: use import.',
  },
  {
    selector: 'MemberExpression[object.name="module"][property.name="exports"]',
    message: 'ESM only: use export.',
  },
  {
    selector: 'Identifier[name=/^__(dirname|filename)$/]',
    message: 'ESM only: use import.meta.dirname / import.meta.filename.',
  },
];

// Restricted outside src/types/ and tests/types/.
const OUTSIDE_TYPES = [
  {
    selector: 'TSTypeAliasDeclaration, TSInterfaceDeclaration',
    message: 'Declare types and interfaces under src/types/ (tests/types/ for test-only types) and import them with `import type`.',
  },
  {
    selector: 'TSModuleDeclaration',
    message: 'Declare global and module augmentations under src/types/.',
  },
];

// Restricted outside src/validation/.
const OUTSIDE_VALIDATION = [
  {
    selector:
      'TSUnknownKeyword:not(TSTypeParameter TSUnknownKeyword, CatchClause > Identifier > TSTypeAnnotation > TSUnknownKeyword)',
    message: '`unknown` is only allowed in src/validation/, catch clauses and generic constraints: narrow raw input in src/validation/.',
  },
  {
    selector: 'MemberExpression[object.type="MetaProperty"][property.name="env"]',
    message: 'Read import.meta.env in src/validation/ and expose a typed config.',
  },
];

// Files under src/types/*.ts and tests/types/*.ts hold type declarations only.
const TYPES_ONLY = {
  selector:
    'Program > :not(ImportDeclaration[importKind="type"], ExportNamedDeclaration[exportKind="type"], ExportAllDeclaration[exportKind="type"], ExportNamedDeclaration[specifiers.length=0]:not([declaration], [source]), TSTypeAliasDeclaration, TSInterfaceDeclaration, TSModuleDeclaration[kind="global"], TSModuleDeclaration[kind="module"][body])',
  message: 'Files under types/ hold type declarations only: no runtime code, no value import or export.',
};

// src/types/*.d.ts holds ambient declarations of untyped modules and asset imports only.
const AMBIENT_ONLY = {
  selector: 'Program > :not(TSModuleDeclaration[kind="module"][body])',
  message: 'src/types/*.d.ts holds only `declare module \'...\' { ... }` for untyped packages and asset imports; everything else goes in src/types/*.ts.',
};

const RAW_INPUT_MESSAGE = 'Read raw input in src/validation/ and expose a typed value.';

export default defineConfig([
  { ignores: ['dist/**'] },
  {
    files: CODE,
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      '@typescript-eslint/ban-ts-comment': [
        'error',
        { 'ts-check': false, 'ts-expect-error': true, 'ts-ignore': true, 'ts-nocheck': true },
      ],
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/no-explicit-any': ['error', { fixToUnknown: false, ignoreRestArgs: false }],
      // node:test's test() and describe() return promises that the runner tracks itself.
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          allowForKnownSafeCalls: [
            { from: 'package', package: 'node:test', name: ['test', 'it', 'describe', 'suite'] },
          ],
        },
      ],
      '@typescript-eslint/no-non-null-assertion': 'error',
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'node:module', importNames: ['createRequire'], message: 'ESM only: use import.' },
            { name: 'module', importNames: ['createRequire'], message: 'ESM only: use import.' },
            { name: 'node:process', importNames: ['env', 'argv'], message: RAW_INPUT_MESSAGE },
            { name: 'process', importNames: ['env', 'argv'], message: RAW_INPUT_MESSAGE },
          ],
        },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'JSON', property: 'parse', message: RAW_INPUT_MESSAGE },
        { object: 'process', property: 'env', message: RAW_INPUT_MESSAGE },
        { object: 'process', property: 'argv', message: RAW_INPUT_MESSAGE },
        { object: 'window', property: 'localStorage', message: RAW_INPUT_MESSAGE },
        { object: 'window', property: 'sessionStorage', message: RAW_INPUT_MESSAGE },
        { object: 'location', property: 'search', message: RAW_INPUT_MESSAGE },
        { object: 'location', property: 'hash', message: RAW_INPUT_MESSAGE },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'localStorage', message: RAW_INPUT_MESSAGE },
        { name: 'sessionStorage', message: RAW_INPUT_MESSAGE },
      ],
      'no-restricted-syntax': ['error', ...ALWAYS, ...OUTSIDE_TYPES, ...OUTSIDE_VALIDATION],
    },
  },
  {
    files: VALIDATION,
    rules: {
      // The raw-input boundary: `as` (not the angle-bracket form), `unknown` and raw reads are allowed here.
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        { assertionStyle: 'as', objectLiteralTypeAssertions: 'allow' },
      ],
      'no-restricted-imports': 'off',
      'no-restricted-properties': 'off',
      'no-restricted-globals': 'off',
      'no-restricted-syntax': ['error', ...ALWAYS, ...OUTSIDE_TYPES],
    },
  },
  {
    files: TYPES,
    rules: {
      'no-restricted-syntax': ['error', ...ALWAYS, ...OUTSIDE_VALIDATION, TYPES_ONLY],
    },
  },
  {
    files: AMBIENT,
    rules: {
      'no-restricted-syntax': ['error', ...ALWAYS, AMBIENT_ONLY],
    },
  },
  {
    files: ['src/**/*.d.ts', 'tests/**/*.d.ts'],
    ignores: AMBIENT,
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: 'Program', message: 'Declaration files are only allowed under src/types/, for ambient module declarations.' },
      ],
    },
  },
]);
