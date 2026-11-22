---
name: git
description: Safe, non-interactive Git usage for coding agents. Use when inspecting repository state, staging changes, writing a commit message, committing, branching or pushing, and before running any Git command that rewrites history or discards work.
license: MIT
---

# Git

## Inspect before acting

- Run `git status`, `git diff` and `git diff --staged` before staging or committing: never assume the working tree is clean or that only your changes are in it.
- Check the branch with `git branch --show-current` before committing or pushing.
- Read `git log --oneline -10` to learn the repository's commit message convention.

## Stay non-interactive

Commands that open an editor, a pager or a prompt hang or fail without a human at the keyboard.

- Pass commit messages with `-m`; use one `-m` per paragraph.
- Never use `-i` or `-p` (`git rebase -i`, `git add -p`).
- Prefix read commands with `git --no-pager` when output may be long.
- Continue a merge or rebase with `git -c core.editor=true rebase --continue` (or `merge --continue`).

## Stage and commit

- Stage explicit paths (`git add path/to/file`), not `git add -A` or `git add .`, which pick up unrelated files, build output or secrets.
- Never commit secrets (`.env`, keys, credentials). Unstage one with `git restore --staged <file>`.
- One logical change per commit.
- Write the message in the repository's convention; if `git log` shows none, use Conventional Commits as described in [references/commit-messages.md](references/commit-messages.md).
- If a hook fails, fix the cause and commit again; never bypass it with `--no-verify`.

## Destructive operations

Run these only when the user explicitly asks, after stating what will be lost: `git push --force` (prefer `--force-with-lease`), `git reset --hard`, `git clean -fd`, `git restore <path>` or `git checkout -- <path>` on unstaged changes, `git branch -D`, `git stash drop`, and any rebase or amend of commits that are already pushed.

## Push

Push only when asked: a push publishes the commits. Push a new branch with `git push -u origin <branch>`.
