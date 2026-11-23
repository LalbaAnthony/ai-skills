---
name: github-actions
description: Name every GitHub Actions workflow that has triggers `*.flow.yml` and every reusable workflow (triggered only by `workflow_call`) `*.inc.yml`, flows including the reusable workflows they need, such as `tests.inc.yml` included by `tests.flow.yml`. Use when creating, editing, splitting, reviewing or refactoring files in `.github/workflows/`, when adding a CI or CD job (lint, tests, build, release, deploy), and when the same jobs are needed by more than one workflow or with different parameters.
license: MIT
---

# GitHub Actions workflows

## Naming

GitHub only loads workflows, reusable ones included, from `.github/workflows/` itself: subdirectories are not supported. A file's role is therefore carried by its suffix.

| File              | Role                                                                         | Triggers                                                                                     |
| ----------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `<name>.inc.yml`  | Reusable workflow: holds jobs and never runs on its own                      | `workflow_call` only                                                                         |
| `<name>.flow.yml` | Any workflow with triggers: runs its own jobs, includes `*.inc.yml`, or both | Events (`push`, `pull_request`, `schedule`, `workflow_dispatch`, ...), never `workflow_call` |

```
.github/
└── workflows/
    ├── publish.inc.yml
    ├── release.flow.yml     # tests.inc.yml, then publish.inc.yml, on a version tag
    ├── tests.flow.yml       # tests.inc.yml on push and pull request
    └── tests.inc.yml
```

- Name an `.inc.yml` after what its jobs do (`lint`, `tests`, `build`, `deploy`), not after the workflow that includes it.
- A flow that runs one include on that include's own triggers takes the same base name: `tests.flow.yml` includes `tests.inc.yml`.
- Give an `.inc.yml` no trigger other than `workflow_call`: any other event would also run it on its own, outside its flows, and twice per event when a flow includes it on the same event.
- An include may itself include other `*.inc.yml`; it stays an `.inc.yml`, since its only trigger is `workflow_call`.
- Every workflow that has triggers is a `.flow.yml`, including one that holds only jobs of its own and includes nothing. The folder then holds only `.inc.yml` and `.flow.yml` files, and a workflow that later gains an include keeps its file name. Never give a workflow a plain `<name>.yml`.
- Use the `.yml` extension, not `.yaml`.

## When to include

Move jobs into an `.inc.yml` when:

- more than one workflow runs them, such as tests on pull request and again before a release or a deploy;
- they run with different parameters, such as the same deploy to staging and to production;
- they form a standard stage (lint, tests, build, deploy) that other workflows will plausibly need, behind a clear interface of inputs, secrets and outputs.

Keep jobs inline when a single workflow will ever need them. A reusable workflow shares whole jobs, each on its own runner; sharing a few steps inside a job is the job of a composite action, which this convention does not cover.

## Example

`.github/workflows/tests.inc.yml`:

```yaml
name: Tests

on:
  workflow_call:
    inputs:
      node-version:
        type: string
        default: lts/*

permissions:
  contents: read

jobs:
  unit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: ${{ inputs.node-version }}
      - run: npm ci
      - run: npm test
```

`.github/workflows/tests.flow.yml`:

```yaml
name: Tests

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  tests:
    uses: ./.github/workflows/tests.inc.yml
```

`.github/workflows/release.flow.yml` reuses the same include before publishing:

```yaml
name: Release

on:
  push:
    tags: ["v*"]

permissions:
  contents: read

jobs:
  tests:
    uses: ./.github/workflows/tests.inc.yml

  publish:
    needs: tests
    uses: ./.github/workflows/publish.inc.yml
    secrets:
      NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
```

The interface `publish.inc.yml` declares for it:

```yaml
on:
  workflow_call:
    secrets:
      NPM_TOKEN:
        required: true
    outputs:
      version:
        value: ${{ jobs.publish.outputs.version }}
```

## Writing includes

- Call an include at job level, with its path from the repository root: `uses: ./.github/workflows/<name>.inc.yml`. A local path runs the include from the same commit as the flow.
- A calling job accepts only `name`, `uses`, `with`, `secrets`, `strategy`, `needs`, `if`, `concurrency` and `permissions`. Everything else (`runs-on`, `steps`, `env`, `environment`, `timeout-minutes`, ...) goes on the jobs inside the include.
- Declare every input under `on.workflow_call.inputs` with a `type` (`string`, `number` or `boolean`, nothing else) and either `required: true` or a `default`.
- The flow's `env` does not reach the include, and the `env` context cannot be used in `with`. Pass values through `with`, where the `github`, `needs`, `strategy`, `matrix`, `inputs` and `vars` contexts are available.
- Secrets other than `GITHUB_TOKEN` are not passed automatically. Declare each one under `on.workflow_call.secrets` and pass it explicitly from the flow. Avoid `secrets: inherit`, which hands the include every secret the flow can read.
- `environment` cannot be set on the calling job: pass its name as an input and set `environment: ${{ inputs.environment }}` on the include's job, which then reads that environment's secrets itself.
- The flow, or its calling job, sets the ceiling of the `GITHUB_TOKEN` permissions, and an include can only lower them. Declare in the include the permissions its jobs need: a flow that grants less then fails at startup with an explicit error instead of midway through a job.
- Expose results through `on.workflow_call.outputs.<id>.value`, mapped from job outputs; the flow reads them as `needs.<calling job>.outputs.<id>`.
- Inside an include, the `github` context is the flow's: `github.workflow`, `github.event_name` and `github.ref` describe the flow and its triggering event. Define `concurrency` in the flow only; a group built from `github.workflow` inside an include collides with its flow's group, and the run deadlocks or cancels itself.
- To run an include several times with different parameters, put a `strategy.matrix` on the calling job.

## Changing existing workflows

Apply the convention to new workflows and to workflows the user asks to restructure. Do not rename or split existing workflow files unasked, a plain `<name>.yml` included: it has effects outside the repository files. Point out the files that break the convention and rename them to `<name>.flow.yml` or `<name>.inc.yml` when the user asks. When restructuring, report each of these to the user:

- Check names: the jobs of an include report as `<calling job> / <included job>`. Required status checks in branch protection rules or rulesets that name the old checks stop matching, and pull requests stay blocked until the rules are updated.
- File names: status badges (`actions/workflows/<file>/badge.svg`), `gh workflow run <file>` and API dispatch calls name the workflow file.
- Workflow names: `workflow_run` triggers in other workflows match the `name:` field. Keep the `name:` of the workflow a flow replaces.

## Check

If `actionlint` is installed, run it on `.github/workflows/`: it checks the inputs, secrets and outputs of each local include call against the include's `workflow_call` declaration.
