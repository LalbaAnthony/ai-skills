---
name: typescript-strict
description: Strict TypeScript conventions for Node and Vite-bundled projects. No any, no `as` casts outside src/validation/ (only `as const` and `satisfies` elsewhere), no non-null `!`, no definite assignment, no @ts-expect-error, @ts-ignore or @ts-nocheck, no enum; raw input (JSON, env vars, CLI args, browser storage, untyped libraries) read and validated in src/validation/; every type and interface declared under src/types/ and imported with a top-level `import type`; ESM only with package type module and Node >= 22; explicit strict tsconfig flags enforced by typescript-eslint. Use when creating a TypeScript project, writing, editing or reviewing TypeScript code, adding a type or interface, parsing JSON or reading environment variables, or editing tsconfig.json, package.json or eslint.config.js. New projects follow every rule; on existing projects, new code follows the rules and existing violations are flagged, never fixed unasked.
license: MIT
---

# Strict TypeScript

A rule set for TypeScript projects run by Node (backends, CLIs, libraries) and for frontend projects bundled by Vite. The reference configurations in `assets/` enforce most rules mechanically; the agent applies the rest by reading the code.

## Which mode applies

- **New project**: no `package.json` exists yet, and the agent creates it. Every rule applies, and the project is scaffolded as described in "New projects".
- **Existing project**: a `package.json` exists, even with no TypeScript in it yet. Follow "Existing projects".
- **Monorepo** (npm or pnpm workspaces): each workspace package is a project of its own, with its own `src/types/`, `src/validation/` and `tests/types/`. A type shared across packages lives in the `src/types/` of the package that owns it and is exported from that package.

`src/` is the source root in every path below. In an existing project whose code lives elsewhere (`lib/`, `app/`, `server/`), use the same layout under that root (`lib/types/`, `lib/validation/`) and flag once that the root is not `src/`. Never move folders unasked.

## Rules

### Type safety

1. **No `any`**, explicit or leaking from an API that returns it. A value typed `any` by a library is raw input: see "Raw input and src/validation/".
2. **No type assertions** (`x as T`, `<T>x`, `x as unknown as T`) outside `src/validation/`. Allowed everywhere: `as const`, and `satisfies`, which checks a value without changing its type.
3. **No non-null assertion** `x!` and **no definite assignment** `let x!: T` or class field `x!: T`, in `src/validation/` too. Check the value (`if (x === undefined) throw ...`), initialize it, or make it optional.
4. **No `@ts-expect-error`, `@ts-ignore` or `@ts-nocheck`.** Fix the type error instead.
5. **No `Function`, `Object` or `{}` types.** Write the exact signature (`(id: string) => void`), `object`, or a precise type.
6. **`unknown` only** in `src/validation/`, in catch clauses (`catch (error)` is `unknown` under `strict`; narrow it in the catch block with `instanceof Error`), and in generic constraints (`T extends Record<string, unknown>`). Elsewhere, an opaque value (logger metadata, cache entries, event payloads) gets a precise type or a type parameter.
7. **No `enum`.** Declare a union type in `src/types/`. When the values are needed at runtime, add a constant in a logic module: `export const ROLES = ['admin', 'member'] as const satisfies readonly Role[];`.
8. **DOM lookups are narrowed with `instanceof`**, never cast and never given a type argument (`querySelector<HTMLInputElement>()` is an unchecked cast in another syntax):

   ```ts
   const input = document.querySelector('#name');
   if (!(input instanceof HTMLInputElement)) {
     throw new Error('#name input not found');
   }
   ```

9. **Tests follow the same rules.** Use typed fakes that implement the whole interface from `src/types/`, `satisfies` for fixtures, and explicit checks (`assert.ok(found)`, `if (!found) throw ...`) instead of `!`.

### Raw input and src/validation/

Raw input is any value whose shape the type system cannot vouch for: `JSON.parse`, `Response.json()`, `process.env`, `process.argv`, `import.meta.env`, `localStorage` and `sessionStorage`, `location.search` and `location.hash`, `event.data` from `postMessage` or a WebSocket, rows from a database driver without generated types, and the result of any library that returns `any`.

- Raw input is read **inside `src/validation/`**, by functions that take the raw source and return a typed value. `unknown` and `as` casts are allowed there, and only there; the angle-bracket form `<T>x` is not.
- Validation uses hand-written type guards or a schema library (zod, valibot): the project's choice. Neither may leak `unknown` out of `src/validation/`.
- With a schema library, the schema is the single source of truth: its inferred type is still declared in `src/types/`, from the schema imported with `import type`. This is the only case where a file of `src/types/` may import from a logic module.
- Env vars and CLI args are parsed once at startup into a typed config.

```ts
// src/validation/user.ts
import type { Role, User } from '../types/user.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isRole(value: unknown): value is Role {
  return value === 'admin' || value === 'member';
}

export function isUser(value: unknown): value is User {
  return (
    isRecord(value) &&
    typeof value['id'] === 'string' &&
    typeof value['name'] === 'string' &&
    isRole(value['role'])
  );
}

export async function readUser(res: Response): Promise<User> {
  const raw: unknown = await res.json();
  if (!isUser(raw)) {
    throw new Error('Invalid user payload');
  }
  return raw;
}
```

```ts
// src/http/users.ts: no unknown, no cast, no raw read
import type { User } from '../types/user.js';
import { readUser } from '../validation/user.js';

export async function fetchUser(baseUrl: string, id: string): Promise<User> {
  return readUser(await fetch(`${baseUrl}/users/${id}`));
}
```

```ts
// src/types/order.ts: a type inferred from a schema
import type { z } from 'zod';
import type { orderSchema } from '../validation/order.js';

export type Order = z.infer<typeof orderSchema>;
```

### Types live in src/types/

- **Every `type` alias and `interface`** is declared under `src/types/`, exported or not, including generic helpers (`type Nullable<T> = T | null`) and component props (a React `Props` type, the type passed to Vue's `defineProps<Props>()`). It does not matter whether the type crosses a module boundary. An inline object type in a signature (`opts: { force: boolean }`) is not a declaration and may stay in place.
- **One file per domain**: `src/types/user.ts`, `src/types/order.ts`, `src/types/http.ts`. Types are grouped by what they describe, not by the module that uses them. No barrel `index.ts`: import from the domain file.
- **Type files are `.ts` and hold type declarations only**: no runtime code, no value import or export. They import other types with `import type`; an empty `export {};` is allowed. They do not derive types from values in logic modules, except from schemas in `src/validation/`.
- **Augmentations** of typed code (`declare global { interface Window { ... } }`, `declare module 'express' { interface Request { ... } }`) go in `src/types/*.ts`.
- **`.d.ts` files** exist only in `src/types/`, and only for `declare module '...' { ... }` blocks typing an untyped package or an asset import (`*.glsl`). In a package of type module every `.ts` file is a module, where `declare module` is an augmentation that fails for a module without types (TS2664, TS2665); only a `.d.ts` file works. Type the untyped package's results as `unknown` and call it from `src/validation/`. Shorthand `declare module 'x';` is banned: it types the whole module as `any`. `skipLibCheck` skips errors in `.d.ts` files, so keep them minimal.
- **Test-only types** live in `tests/types/`. Tests import production types from `src/types/`.
- **Logic modules import types with a top-level `import type`** statement: `import type { User } from '../types/user.js';`. Never an inline `import { type User }`: under `verbatimModuleSyntax` it is emitted as `import {} from '../types/user.js'`, a runtime load of an empty module. A mixed import of values and types is split into two statements. Re-exports use `export type { ... }`.
- `.vue` and `.svelte` files follow the same rules. Linting them needs the framework's ESLint parser plugin (`eslint-plugin-vue`, `eslint-plugin-svelte`), added with the same rules when the project uses them.

### ESM and Node

- `package.json` has `"type": "module"` and `"engines": { "node": ">=22" }`.
- No `require`, `module.exports` or `createRequire`. No `__dirname` or `__filename`: use `import.meta.dirname` and `import.meta.filename`.
- In Node projects (`moduleResolution: nodenext`), relative imports end in `.js`, even though the source file is `.ts`.

### Tool configs and scripts

TypeScript files outside `src/` and `tests/` (`vite.config.ts`, `scripts/*.ts`) follow the type-safety rules (no `any`, no cast, no `@ts-` comment, no `enum`) and the ESM rules. They are exempt from the folder rules: `process.env` in `vite.config.ts` is fine. The reference ESLint configuration does not lint them; review them by reading.

### tsconfig

TypeScript 6 turned `strict` on by default and removed the ES5 target. Set every flag below explicitly anyway, so the build does not depend on compiler defaults. A tsconfig missing one of them, or setting one differently, is a violation.

| Flag | Node | Vite app |
| --- | --- | --- |
| `strict` | `true` | `true` |
| `target` | `"es2024"` | `"es2024"` |
| `lib` | `["es2024"]` | `["es2024", "dom", "dom.iterable"]` |
| `module` | `"nodenext"` | `"esnext"` |
| `moduleResolution` | `"nodenext"` | `"bundler"` |
| `types` | `["node"]` | `["vite/client"]` |
| `verbatimModuleSyntax`, `isolatedModules` | `true` | `true` |
| `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` | `true` | `true` |
| `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch` | `true` | `true` |
| `noPropertyAccessFromIndexSignature` | `true` | `true` |
| `forceConsistentCasingInFileNames`, `skipLibCheck` | `true` | `true` |

`noPropertyAccessFromIndexSignature` makes index-signature reads explicit: `env['PORT']`, not `env.PORT`.

## New projects

1. Ask the user whether to use a package manager other than npm. Use npm if they have no preference. The commands below use npm.
2. Pick the layout: **Node** (backend, CLI, library) or **Vite** (bundled frontend).
3. Create `package.json` with `"type": "module"`, `"engines": { "node": ">=22" }` and the scripts below.
4. Install the dev dependencies with caret ranges (npm's default):
   - `typescript`: the newest version that satisfies typescript-eslint's peer range, not blindly `latest`. Read the range with `npm view typescript-eslint peerDependencies`, then install `npm install -D "typescript@<range>"`. typescript-eslint's typed rules (`no-unsafe-*`) only run on a TypeScript version inside that range.
   - `@types/node@^22`: its major matches the Node floor, so the type checker rejects APIs missing from Node 22. Raise it together with `engines`.
   - `eslint` and `typescript-eslint`; `vite` for the Vite layout.
5. Copy the reference configurations from this skill's `assets/`:
   - Node: `assets/node/tsconfig.json` (type-checks `src/` and `tests/`, no emit) and `assets/node/tsconfig.build.json` (emits `src/` to `dist/` with source maps). For a published library, add `"declaration": true` and `"declarationMap": true` to the build config.
   - Vite: `assets/frontend/tsconfig.json` (solution file), `tsconfig.app.json` (`src/`, browser types only), `tsconfig.node.json` (`vite.config.ts`, Node types) and `tsconfig.test.json` (`tests/`, browser and Node types). App code never sees Node globals such as `process`.
   - Both: `assets/eslint.config.js`.
6. Create `src/types/`, `src/validation/` and `tests/types/` when their first file is needed.
7. Before finishing, run the type check and the linter: both must report no error.

| Script | Node | Vite |
| --- | --- | --- |
| `typecheck` | `tsc` | `tsc -b` |
| `build` | `tsc -p tsconfig.build.json` | `tsc -b && vite build` |
| `lint` | `eslint .` | `eslint .` |
| `start` | `node --enable-source-maps dist/index.js` | |

The test runner is the project's choice. Node's built-in type stripping cannot run tests from source in the Node layout, because the relative imports end in `.js` and point at `.ts` files: use a runner that resolves them (Vitest, tsx), or run the tests against the build output.

### What the reference ESLint configuration enforces

`assets/eslint.config.js` lints `src/` and `tests/` with typescript-eslint's `recommendedTypeChecked` preset, plus:

- `no-explicit-any`, the `no-unsafe-*` rules from the preset, `no-non-null-assertion`, `ban-ts-comment` (every `@ts-` directive except `@ts-check`);
- `consistent-type-assertions` set to `never`, relaxed to `as` in `src/validation/`;
- `consistent-type-imports`, and a ban on inline `type` specifiers;
- `no-restricted-syntax` for `enum`, definite assignment, shorthand `declare module`, `require`, `module.exports`, `__dirname`, `__filename`, type arguments on DOM queries, type and interface declarations outside the types folders, `unknown` outside `src/validation/` (catch clauses and generic constraints excepted), and runtime code inside the types folders;
- `no-restricted-properties`, `no-restricted-globals` and `no-restricted-imports` for raw-input reads (`JSON.parse`, `process.env`, `process.argv`, `import.meta.env`, storage, `location.search` and `location.hash`) and `createRequire` outside `src/validation/`.

A `no-restricted-syntax` setting in a later block replaces the earlier one for the files it matches. Keep the selector arrays (`ALWAYS`, `OUTSIDE_TYPES`, `OUTSIDE_VALIDATION`) combined per block when editing the configuration.

## Existing projects

1. **At the start of the first TypeScript task**, check `package.json` (`type`, `engines`) and every `tsconfig*.json` against "ESM and Node" and "tsconfig". Report the deviations once.
2. **New or changed code follows the rules** wherever it can sit alongside the existing code: new types go in `src/types/`, new raw-input reads in `src/validation/` (create the folders if missing), and new code uses `import type`, with no `any`, cast, `!`, `@ts-` comment or `enum`.
3. **Project-level changes are flagged, never made unasked**: CommonJS to ESM, tsconfig flags, `engines`, lint setup, the source root. In a CommonJS package, new code keeps the module system already in place.
4. **Existing violations stay as they are.** When a requested change touches one, make the change in place (a new field goes into the misplaced interface; a function with a cast keeps its cast) and flag the violation. Do not move types, remove casts or convert enums unless the user asks.
5. **Flag violations in the files read or edited during the task.** Run the project's linter if it has this configuration. A full audit of the project happens only on request.
6. **Report** in a section at the end of the reply, grouped by rule, one `path:line` per violation with its concrete fix:

```markdown
## typescript-strict violations

### Type assertion outside src/validation/
- `src/services/order-service.ts:42`: `payload as Order`. Read the payload with a validator in src/validation/order.ts.

### Type declared outside src/types/
- `src/services/user-service.ts:8`: `interface UserRow`. Move it to src/types/user.ts and import it with `import type`.

### tsconfig
- `tsconfig.json`: `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` are not set.
```
