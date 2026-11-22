# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A public catalog of Agent Skills (`skills/<name>/SKILL.md`, open agentskills.io format), all written here and consumed from outside: Claude Code installs plugins from `.claude-plugin/marketplace.json`, other agents install skills with `npx skills add LalbaAnthony/ai-skills`. There is no build step and no install or sync tooling, and no third-party skill is vendored: the deliverables are the skill folders and `marketplace.json`.

## Commands

```bash
node --test tests/*.test.mjs                                            # catalog validation + fixture tests
node --test --test-name-pattern "discovery" tests/catalog.test.mjs     # single test
claude plugin validate .                                                # marketplace manifest
npx -y skills add . --list                                              # what npx skills discovers
```

`node --test tests/` fails on Node 24 (a directory is not accepted); use the glob. CI (`.github/workflows/ci.yml`) runs the same three checks on push and pull request to `main`, with `@anthropic-ai/claude-code` and `skills` pinned to exact versions that are bumped by hand.

## Architecture

**Catalog.** Each entry of `marketplace.json` is a thematic plugin: `"source": "./"`, an explicit `skills` array of `./skills/<name>` paths, no `plugin.json`, no `version`, so installs follow commits on `main`. Claude Code invokes `/<plugin>:<skill>`; `npx skills` discovers skills by scanning the repository for `SKILL.md` and groups them by plugin using the same file.

**Validation** lives in `tests/lib/catalog.mjs`: `validateRepo(root)` returns error strings, `parseFrontmatter` is a deliberately minimal YAML subset parser (single-line and quoted values, `>`/`|` block scalars, nested mappings kept as non-scalar) that throws on anything else. `tests/catalog.test.mjs` runs it against the real repository and against fixture repositories built in a temp directory.

**Template.** `template/SKILL.md.example` is the starting point for a new skill. The `.example` suffix is what keeps it out of `npx skills` discovery; renaming it to `SKILL.md` would offer it to users as an installable skill, and the tests reject any `SKILL.md` outside `skills/<name>/`.

## Rules for changes

- A new skill must be added to exactly one plugin's `skills` array; the tests fail on unlisted folders under `skills/` and on a skill listed twice.
- Skill frontmatter uses standard fields only (`name`, `description`, optional `license`, `compatibility`, `metadata`, `allowed-tools`), `license: MIT`. No agent-specific tool names in skill bodies. Bundled helpers go in `scripts/`, `references/`, `assets/` inside the skill, preferably Python or Node for Windows compatibility. Keep `SKILL.md` under 500 lines.
- Run `node --test tests/*.test.mjs` after editing `marketplace.json` or a skill. Fixture tests use placeholder names (`plugin-a`, `skill-a`, ...) and never reference real plugins or skills, so the catalog can change without touching a test.
- The README is intentionally generic: do not list specific skills or plugins in it.
- Line endings: LF everywhere (`.gitattributes`).
- Commits follow Conventional Commits `type(scope): summary`, scope being the top-level folder (`skills`, `tests`, `template`) or `repo` for root files, `.claude-plugin/` and `.github/`.

## Unverified behavior

- Whether a `"source": "./"` entry loads only the skills in its `skills` array, rather than all of `skills/`, has not been confirmed (`claude plugin details` only works on enabled plugins). If it loads all of `skills/`, every plugin exposes every skill.
