---
name: project-report
description: Write a status report or a delivery note on the current work (code, release, deployment, infrastructure, investigation, anything in progress) for one of three audiences, the client (what was delivered or changed, no technical detail), the project manager (plain-language progress, key technical points, risks and decisions, plus references a developer can follow) or an internal developer (a complete handoff to resume the work exactly where it stopped). Gathers facts from the conversation, git through a bundled script, the hosting platform and project files, and never states as done what no source confirms. Use when asked where things stand, for a status update, progress report, recap, handoff, release or delivery note, or for a report to the client, the project manager or a colleague, including French phrasings such as "état de la situation", "point d'étape", "où on en est", "fais le point", "livraison", "mise en ligne", "compte rendu", "récap", "passation". Not for performing a release or deployment itself.
license: MIT
compatibility: Node.js 18 or later and git run the bundled git-state script. Without them, the repository state is read with git commands by hand, or left out when the work is not in a repository.
---

# Project report

This skill writes one report on the current work for one audience (the client, the project manager or an internal developer), either as a status report while the work is in progress or as a delivery note once it has shipped. The work can be code, a release, a deployment, infrastructure, an investigation or anything else. A report states only what a source confirms; everything else is marked or set aside for the user, depending on the audience.

The skill writes and never acts on what it reports: it does not commit, push, deploy, comment on a merge request or a ticket, or send the report to anyone. When the user asks to perform a delivery, that work happens outside this skill; a report is written only when asked for.

## 1. Mode, audience, language

**Mode.** Take it from the wording. "livraison", "mise en prod", "mise en ligne", "release", "delivery", "shipped" ask for a delivery note (what has shipped); "point", "état", "où on en est", "status", "progress", "recap", "handoff" ask for a status report (where the work stands). When the wording settles neither, ask.

**Audience.** Take it from the request ("pour le client", "for the PM", "for Julie who takes over") or from what the conversation already established (a name known to be the client's). When nothing settles it, ask. When several audiences are requested, write one report per audience, one after the other.

**Language.** The language of the request; a language the user names for the report wins. Section names below are given in English: write them in the report's language.

## 2. Gather the facts

Collect from every available source before writing.

1. **Conversation**: what was done, decided, tested (with the results), abandoned, and what is left.
2. **Git**, when the work lives in a repository: run the bundled script (section 3).
3. **Hosting platform**: when a tool can query the platform the remote points to (a CLI such as `glab` or `gh`, or an integration for GitLab or GitHub), look up the merge request or pull request of the branch, its pipeline, its linked issues, and the deployments or environments. Without such a tool, skip this source: what only it could confirm stays unverified.
4. **Project files**: CHANGELOG, release notes, documentation changed by the work, tracking files.
5. **Active checks**, read-only, run without asking: the test command the project declares, and HTTP GET requests on a URL known from the project or the conversation (a version or health endpoint, the page of a delivered feature). Never build, run a migration, deploy, send a request that writes, or run anything else with side effects.

Then sort every fact as **verified** (a source above confirms it now) or **unverified** (remembered, assumed, or stated without a way to check). Observed state wins over memory: when git or the platform contradicts what was said earlier in the conversation, report the observed state and point out the gap to the user.

## 3. Repository state

Run the bundled script from this skill's directory:

```bash
node scripts/git-state.mjs <repository-path> [--base <ref> | --since <YYYY-MM-DD>] [--no-fetch]
```

It prints one JSON document. It first fetches the remote of the upstream branch (or `origin`) with credential prompts disabled and a 30-second timeout; apart from that fetch it only reads. `--no-fetch` skips the fetch when working offline. It exits with 1 and a message on a usage error, a missing directory or an unknown `--base` revision.

- `warnings`: read them before trusting the rest.
- `repository`: the work tree root, or `null` outside a repository (no git facts; rely on the other sources). `gitAvailable` is false when git is not installed.
- `head`: `branch` (`null` when `detached`), `commit`, `subject`, `date`. `commit` is `null` in a repository without commits.
- `remote`: `name`, `url` (credentials removed), `host`, `platform` (`github`, `gitlab`, `bitbucket`, `azure-devops` or `null`), `project` (the path on the host, such as `group/project`). Use them to query the platform.
- `fetch`: `attempted`, `remote`, `ok`, `error`, `lastFetch`. When the fetch failed or did not run, `upstream` reflects the remote as of `lastFetch`; the developer report says so.
- `upstream`: `ref`, `tracking` (false when a remote branch of the same name exists but is not the configured upstream), `ahead`, `behind`. `null` when the branch was never pushed.
- `base`: where the reported work starts.
  - `status` `resolved`: commits and changes are counted from `commit`, the merge base of HEAD and `ref`. `source` is `detected` (the closest of the remote's default branch, `main`, `master` and `develop`), `option` (`--base`) or `since` (`--since`, with `commit` `null` when every commit is after the date).
  - `status` `on-base-branch` (HEAD is on `main`, `master`, `develop` or the default branch) or `no-candidate` (no such branch exists): the period cannot be inferred. Ask the user for it (a date, a tag or a commit; offer `tags.latest` when there is one), then run the script again with `--base <tag-or-commit>` or `--since <YYYY-MM-DD>`.
  - `status` `no-commit` or `no-repository`: no commit to report.
  - `containedIn`: base branches that already contain HEAD; the branch was merged into them, or has no commit of its own yet. With no commit since the base and a dirty working tree, the work is uncommitted.
- `commits`: `total`, `truncated`, `items` (`hash`, `date`, `author`, `merge`, `subject`), newest first.
- `changes`: files changed between the base and HEAD, committed work only. `total`, `truncated`, `additions`, `deletions`, `items` (`path`, `status` among A, M, D, R, C and T, `previousPath` for a rename or copy, `additions` and `deletions`, `null` for a binary file).
- `workingTree`: `clean`; `staged`, `unstaged`, `untracked` and `conflicted`, each with `total`, `truncated` and `items`; `stashes`; `operation` (`merge`, `rebase`, `cherry-pick`, `revert`, `bisect` or `null`).
- `tags`: `atHead`, and `latest` (`name`, `commit`, `commitsSince`), the most recent tag reachable from HEAD.

Without Node, read the same facts with git commands by hand.

## 4. Rules for every report

- A report is a body only: Markdown, no subject line, no greeting, no sign-off.
- Never state as done, deployed, merged or tested what no source verified. In the developer report, mark it "(unverified)". In the client and project manager reports, leave it out and list it in the note (section 8).
- No secret or configuration value in any report: tokens, passwords, keys, connection strings, values of environment variables. The developer report may name variables, never their values.
- No invented date, estimate or figure. An estimate appears only when the user gave it.
- Omit a section that has nothing to hold; never pad one.
- Lengths are targets, exceeded when the content requires it: client around 15 lines; project manager around 30 lines, not counting "For the technical team"; developer as long as completeness requires.

`references/example.md` shows the same delivery written for the three audiences, with the note.

## 5. Client

The client wants to know what they get. Describe effects, not implementation: what users can now do, what looks or behaves differently, what is faster or more reliable. No technical vocabulary (framework, file, API, database, branch, pipeline): "pages load twice as fast", not "added a Redis cache".

- **Voice**: formal, the team speaking as "we". In French, "vous" and "nous": « Nous avons mis en ligne… Vous pouvez désormais… ». In other languages, the equivalent formal register.
- **Leave out**: internal tools and their identifiers (GitLab, Jira, CI, branch names, merge request and ticket numbers), names of internal people and subcontractors ("the team"), time spent, costs and internal estimates. A URL the client needs, such as a staging site to test on, is allowed.
- **Bad news stays out of the report**: known bugs, regressions, delays, items removed from scope. They go to the note, for the user to decide. "Good to know" holds only intended behavior worth knowing, such as a limit by design or a documented workaround.

Status report:

| Section | Content |
| --- | --- |
| (no heading) | One or two sentences: where the project stands. |
| Completed | What is finished, as effects for the client. |
| Next steps | What the team does next. |
| What we need from you | A validation, a test, an access, content or a decision expected from the client. |
| Good to know | Intended behavior worth knowing. |

Delivery note:

| Section | Content |
| --- | --- |
| (no heading) | One sentence: what went live, with the date when it is verified. |
| Delivered | New features and fixes, as effects for the client. |
| What changes for you | Existing behavior that changed: new steps, moved screens, new rules. |
| What you need to do | Actions expected from the client, if any. |
| Good to know | Intended behavior worth knowing. |
| Next steps | What comes next, when known. |

## 6. Project manager

The project manager must understand everything without technical knowledge, and must be able to forward the report to a developer who will find the details in it. Write in plain language. Each technical point says what it is and why it matters, in one or two sentences, without implementation detail. Identifiers appear only in the last section.

- **Voice**: impersonal and factual, addressing no one: "The payment page is live. To decide: …".
- **Bad news is included**, under "Risks and blockers". Unverified facts go to the note (section 8).

| Section | Content |
| --- | --- |
| Overall status | First line, bold label: on track, late or blocked, with the reason in a few words. |
| Done (status report) or Delivered (delivery note) | What was achieved, in plain language. |
| Key technical points | Changes that matter beyond their code (a migration, a new dependency or service, a security fix, a performance change, a breaking change), each in plain words with its consequence. |
| Remaining work | What is left, in plain language. |
| Risks and blockers | What could derail the next steps, external dependencies, pending items. |
| Decisions needed | Choices that belong to the project manager or the client: scope, priority, functional choice. |
| For the technical team | References only, grouped by item of the report: merge or pull request, branch, commits, tickets, pipeline, environment. No explanation. |

## 7. Developer

A complete handoff: a colleague resumes the work exactly where it stopped without having to ask anything. Be technical, precise and exhaustive; cite paths, commits, commands and identifiers.

| Section | Content |
| --- | --- |
| Context | Goal, ticket or request, scope, and what is out of scope. |
| Repository state | Branch and base; pushed or not (ahead and behind, with the time of the last fetch when the fetch failed or did not run); commits since the base; uncommitted and stashed changes; operation in progress; merge request and pipeline status. |
| Done | By topic: files changed, what changed, decisions taken and why. |
| Remaining work | Ordered list; the first item is the exact point to resume from. |
| Resume the work | Commands to check out, install, run and test, only as the project declares them (manifest scripts, task runner, CI, git hooks; a command found only in the README is marked "(unverified: README)"). Never an invented command. |
| Tests | Run, with the result and when; not run; not covered. |
| Pitfalls and assumptions | Approaches tried and abandoned with the reason, unverified assumptions, technical debt introduced, traps. |
| Deployment | Migrations, new or changed environment variables (names only), configuration, order of operations, rollback. Always present in a delivery note; in a status report, present as soon as the work adds a migration, an environment variable or a configuration change. |

## 8. Note to the user

After a client or project manager report, add a note for the user, outside the report, under the heading "To settle before sending" in the report's language (« À arbitrer avant envoi » in French). It lists the bad news left out of a client report, the unverified facts left out of either report, and any assumption the report relies on. Omit the note when it is empty. It is never part of the report and never written to a report file.

## 9. Writing to a file

Only when the user asks for it. Without a path from the user, write `docs/reports/<YYYY-MM-DD>-<status|delivery>-<client|pm|dev>.md` under the repository root (the current directory outside a repository), creating the folder. Never overwrite a file: when the name is taken, add `-2`, `-3` and so on before the extension. One file per report. The reply then gives the path of each file and the note, without repeating the report. Never commit the file.
