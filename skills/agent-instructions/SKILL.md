---
name: agent-instructions
description: Create or reconcile a repository's agent instruction files (AGENTS.md, CLAUDE.md, .claude/CLAUDE.md, GEMINI.md, at the root and in subdirectories) against the code, which wins every disagreement on facts. Keeps exact build, test and lint commands, key folders, project workflows, explicit anti-patterns, gotchas and pointers to context docs; drops style rules a linter enforces, verbose stack descriptions, API docs and anything the code already states. Existing files are maintained in place, in their own structure and language. When none exists, creates AGENTS.md as the single source of truth, plus a CLAUDE.md and a GEMINI.md that only import it. Use when asked to create, init, write, update, refresh, sync, audit or fix AGENTS.md, CLAUDE.md, GEMINI.md or a project's agent instructions, and right after making a change that leaves them stale, such as a command, script, key folder, entry point or documented workflow added, renamed or removed.
license: MIT
compatibility: Node.js 18 or later runs the bundled inventory script, and git lets it honor .gitignore. Without Node, the inventory is taken by hand.
---

# Agent instructions

Agent instruction files tell coding agents how to work in a repository. This skill creates them when there are none and keeps existing ones true to the code. An existing instruction file has no authority over facts: it is a hypothesis to check against the repository, and every disagreement on a fact is settled in favor of the code, never of the document.

## Files

| File | Read by | Created by this skill as |
| --- | --- | --- |
| `AGENTS.md` | Codex, Cursor, GitHub Copilot, OpenCode; Claude Code when no `CLAUDE.md` exists; Gemini CLI when configured to | The single source of truth, with the content |
| `CLAUDE.md` or `.claude/CLAUDE.md` | Claude Code | `@AGENTS.md`, alone on its line |
| `GEMINI.md` | Gemini CLI | `@./AGENTS.md`, alone on its line (the form Gemini CLI documents) |

The same names in a subdirectory (`packages/api/AGENTS.md`) apply to that subtree. Every other file is out of scope and never modified: `.github/copilot-instructions.md`, Cursor and Windsurf rules, `CLAUDE.local.md`, `AGENTS.override.md`, and anything gitignored.

A pointer is a file made only of `@path` import lines; an extended pointer imports another instruction file and adds content of its own. Never write through a symlink: edit its target.

## Modes

- **Full reconciliation**, when the user asks to create, update, sync or audit the instructions: follow every step below.
- **Incremental update**, right after a change of yours that makes a maintained file wrong or incomplete (a command or script added, renamed or removed; a key folder or entry point moved; a documented workflow changed): edit only the lines the change affects, under the same content rules, with no inventory and no other edit. Say in one line of your reply which file you updated and why. This mode never creates a file: when no instruction file exists, leave it to a full reconciliation the user asks for.

Never commit: the user reviews the diff.

## 1. Inventory

Run the bundled script from this skill's directory, with the repository root as argument:

```bash
node scripts/inventory.mjs <repository-root>
```

It prints JSON and never writes. The fields this procedure uses:

- `rootCase`: `create` when no root instruction file carries content, directly or through a pointer; `maintain` otherwise.
- `maintain`: the files whose content to reconcile, pointers and symlinks already resolved to their targets.
- `brokenPointers`: pointers and symlinks whose target does not exist.
- `instructionFiles[]`: per file, `scope` (the directory it covers), `type` (`content`, `pointer`, `extended-pointer`, `symlink`, `unreadable`), `lines`, `overLimit` (over 200 lines), `imports`, `symlinkTarget`, and `deadReferences`: paths, links and `npm`/`composer`/`make`/`just`/`task` scripts the file cites that do not resolve. These are candidates, not verdicts: a sentence may name a file to say it does not exist.
- `declaredScripts[]`: scripts and targets declared in `package.json`, `composer.json`, `deno.json`, Makefiles, justfiles and Taskfiles.
- `sources`: manifests, lockfiles with their package manager, workspace files, CI workflows, git hooks (with `core.hooksPath`), `.env` examples, docs, Docker files, tool version files, lint and format configs. It is a closed list: complete it for any ecosystem it does not know.
- `warnings`: files that could not be read or parsed, git failures. Read them before trusting the rest.

Without Node, take the same inventory by hand: find the instruction files, classify each as above, and list the same sources.

## 2. Decide what to write

- **`rootCase` is `create`**: create `AGENTS.md` at the root (see "Creating AGENTS.md"), then `CLAUDE.md` and `GEMINI.md` as pointers if missing. `CLAUDE.md` counts as present when `.claude/CLAUDE.md` exists. A broken pointer whose import still does not resolve to the new `AGENTS.md` is repointed to it (`@../AGENTS.md` from `.claude/CLAUDE.md`), and the report says so.
- **`rootCase` is `maintain`**: reconcile every file in `maintain`, root and nested. Create nothing, not even a missing pointer.
- **Two or more root files carry their own content** (two `content` files, or an `extended-pointer` whose own content is not specific to its agent): reconcile each separately, then propose the migration in the report (see "Migration").
- Nested files are maintained when they exist and never created.

## 3. Discover

Discovery assumes no language or ecosystem:

1. List the root and the first level of the tree.
2. Read the manifests and configuration files the inventory found, and any it does not know.
3. Extract the real commands: scripts, task runner targets, CI steps, hook contents. CI workflows and hooks show which commands actually run, and in which order.
4. Infer the architecture from the tree, the entry points and the boundaries between modules, services and packages.
5. Check every fact the maintained files state, and every entry of `deadReferences`, against what you found.

When the repository has no manifest and no command at all, keep the file to observable facts and say in the report which sources are missing.

## 4. Content rules

| Write | Leave out |
| --- | --- |
| Exact build, test and lint commands | Verbose explanations of the stack |
| Explicit anti-patterns | Style rules (the linter and formatter carry them) |
| Key folders and their role | Exhaustive API documentation |
| Project-specific workflows | What the existing code already shows |
| References to context files | Copies of external documentation |

The reader is an agent: favor what unblocks action (commands, structure, constraints) over descriptive prose. Precision over exhaustiveness, and no assumption the repository does not support.

### Commands

- Never run a project command to check it: no install, build, test, lint, start or migration. The only program this skill runs is the inventory script.
- Write a command as is when a manifest, task runner, CI workflow or git hook declares it. Prefer the project's entry point (`npm run lint`) over the tool call behind it (`npx eslint .`).
- A command derived from a declared tool, such as running a single test, is allowed when the tool is declared in the repository and the syntax is the one its official documentation gives: `npx vitest run <file>` when `npm test` runs vitest, `php artisan test --filter <name>` in a Laravel project.
- A command found only in prose (README, CONTRIBUTING, a wiki page) is written with an explicit marker: `(unverified: from README.md)`.
- A command with no source is omitted. Never invent one.
- Commands go in fenced code blocks, copyable, one per line. Paths are relative to the repository root.

### References

Point to context files (`docs/`, ADRs, `CONTRIBUTING.md`) with plain relative paths, each with when to read it: "Before touching the event bus, read `docs/events.md`." Never as `@` imports: Claude Code and Gemini CLI would load them into every session, and the other agents read them as plain text.

## 5. Reconcile an existing file

- **Facts**: a fact the repository contradicts is corrected; a fact about something that no longer exists is removed; a fact the file is missing is added.
- **Statements that are not facts**: rules, intentions, team workflows and the reasons behind choices stay as written when nothing in the repository contradicts them, even though they cannot be verified.
- **Left-out content**: content of the "Leave out" column is removed only when another source already carries it: a linter or formatter config enforces the style rule, a manifest declares the version, the code shows the structure, an external doc covers the API. A style rule no tool enforces stays.
- **Structure**: keep the author's sections, order, headings and language, and edit in place. A missing section is appended at the end, in the canonical order of "Creating AGENTS.md", with a heading in the file's language.
- **Formatting**: leave untouched paragraphs as they are. A paragraph or list item you modify fits on one line: join it if it was hard-wrapped.
- **Nested files** keep only what applies to their subtree; repository-wide facts belong to the root file, not repeated in each.
- **Size**: target 200 lines per file. When a file exceeds it after reconciliation, the report says by how much and proposes what to move into which referenced file. Move nothing yourself.

## 6. Creating AGENTS.md

Write it in English, under the title `# AGENTS.md`, with these sections in this order. Omit a section that has nothing verifiable to hold.

| Section | Content |
| --- | --- |
| Overview | The purpose of the project, in 1 to 3 sentences. |
| Tech stack | Only what matters to act and that no manifest or version file states plainly, such as a runtime constraint or a non-obvious service. One line per item, no explanation. Often omitted. |
| Structure | Key directories and their role, entry points. Skip what the names make obvious. |
| Commands | Setup, install, build, run or dev, test, lint, format, typecheck, as exact copyable commands. |
| Workflows | Project-specific multi-step procedures: release, database migration, code generation, adding a module, what the git hooks and CI gate. |
| Architecture | Major components, flows, workspace or package boundaries, when the tree does not show them. |
| Conventions | Code constraints and imposed patterns found in the configuration or the code: module system, path aliases, strictness, layering rules. Formatting stays with the formatter. |
| Anti-patterns | Explicit "do not" rules, each with its reason or consequence. |
| Testing | Framework, location of the tests, command for a single test. |
| Environment | Required variables, by reference to `.env.example` and never with values; external services the project needs running. |
| Gotchas | Non-obvious constraints, traps, manual steps. |
| References | Context files worth reading, as plain paths, each with when to read it. |

`CLAUDE.md` then holds `@AGENTS.md` and `GEMINI.md` holds `@./AGENTS.md`, each alone, with nothing else.

## 7. Migration

When two or more root files carry their own content, the report proposes to migrate them, and nothing is migrated until the user explicitly accepts. Once accepted:

1. Merge the generic content of every file into `AGENTS.md`, creating it if needed, under the reconciliation rules. A contradiction between files that the repository cannot settle is a question for the user, not a choice to make.
2. Reduce each existing `CLAUDE.md` to `@AGENTS.md` and each existing `GEMINI.md` to `@./AGENTS.md`, followed only by the content specific to that agent (Claude Code hooks, slash commands or MCP servers; Gemini CLI settings).
3. Create no pointer that did not already exist.

## 8. Report

After writing, report per file, listing only what changed:

```
AGENTS.md (reconciled)
- Corrected: `npm run test:unit` -> `npm test` (script renamed in package.json)
- Removed: "Uses 2-space indentation" (enforced by .editorconfig)
- Removed: `src/legacy/` (directory deleted)
- Added: Workflows > Release (from .github/workflows/release.yml)
- Unverified: `make seed` (from README.md)

Proposals
- Migration: CLAUDE.md and AGENTS.md both carry content; merge into AGENTS.md, CLAUDE.md becomes `@AGENTS.md`.
- Size: AGENTS.md is 236 lines; move Architecture to docs/architecture.md and reference it.

Missing sources
- No manifest and no CI: Commands holds only what the README states.
```

Content kept as is is not listed. Created files are listed with their sections.
