# ai-skills

[Agent Skills](https://agentskills.io) for coding agents: Claude Code, Codex, Gemini CLI, Cursor, GitHub Copilot, OpenCode. Every skill is written in this repository and follows the open Agent Skills specification: one folder per skill under `skills/<name>/`, holding a `SKILL.md` and optional bundled files.

Skills are grouped by theme into plugins, declared in `.claude-plugin/marketplace.json`. Claude Code installs those plugins from this repository as a plugin marketplace; the other agents install individual skills with the [`skills` CLI](https://github.com/vercel-labs/skills).

## Browse

```bash
npx skills add LalbaAnthony/ai-skills --list
```

Lists every skill with its description, grouped by plugin.

## Install

### Claude Code

```bash
claude plugin install <plugin> --marketplace LalbaAnthony/ai-skills
```

Inside a session: `/plugin install <plugin> --marketplace LalbaAnthony/ai-skills`. This works in one step on Claude Code 2.1.275 or later; on older versions, run `claude plugin marketplace add LalbaAnthony/ai-skills` first, then `claude plugin install <plugin>@ai-skills`.

To declare the marketplace in a settings file instead, add it to `extraKnownMarketplaces` in `~/.claude/settings.json` (current user) or in a project's `.claude/settings.json` (collaborators are prompted to add it when they trust the folder). `autoUpdate` refreshes the marketplace and its installed plugins at each startup:

```json
{
  "extraKnownMarketplaces": {
    "ai-skills": {
      "source": {
        "source": "github",
        "repo": "LalbaAnthony/ai-skills"
      },
      "autoUpdate": true
    }
  }
}
```

Plugins are then installed with `claude plugin install <plugin>@ai-skills`.

Claude loads a skill when its description matches the task; it can also be invoked directly as `/<plugin>:<skill>`.

### Other agents

```bash
npx skills add LalbaAnthony/ai-skills -g --skill <skill> -a <agent> -y
```

`-g` installs for the current user; without it, the skill is installed into the current project. Without `--skill` or `-a`, the CLI asks which skills and agents to use.

If you use Claude Code, install through the marketplace rather than with `-a claude-code`: installing both ways loads every skill twice.

| Agent          | `-a`             | Global path                  |
| -------------- | ---------------- | ---------------------------- |
| Codex          | `codex`          | `~/.agents/skills/`          |
| Cursor         | `cursor`         | `~/.cursor/skills/`          |
| Gemini CLI     | `gemini-cli`     | `~/.gemini/skills/`          |
| GitHub Copilot | `github-copilot` | `~/.copilot/skills/`         |
| OpenCode       | `opencode`       | `~/.config/opencode/skills/` |

These directories are written by the `skills` CLI: do not edit the installed copies by hand.

## Update

- Claude Code: `claude plugin marketplace update ai-skills`, then `claude plugin update <plugin>@ai-skills`. Or, per machine: `/plugin` > Marketplaces > `ai-skills` > Enable auto-update, or `"autoUpdate": true` in settings (see [Claude Code](#claude-code)).
- Other agents: `npx skills update -g -y`.

Plugins carry no version: an update installs the latest commit of `main`.

## Contributing

### Layout

```
ai-skills/
├── .claude-plugin/
│   └── marketplace.json        # catalog: thematic plugins, each listing its skills
├── .githooks/
│   ├── pre-commit              # runs the tests check
│   └── pre-push                # runs every check
├── .github/
│   ├── scripts/
│   │   └── checks.mjs          # the checks, shared by CI and the git hooks
│   └── workflows/
│       └── ci.yml              # runs the checks on push and pull request
├── skills/
│   └── <skill>/
│       ├── SKILL.md
│       └── references/         # optional bundled files, like scripts/ and assets/
├── template/
│   └── SKILL.md.example        # starting point for a new skill
├── tests/
│   ├── lib/
│   │   └── catalog.mjs         # catalog validation rules
│   └── catalog.test.mjs
├── .gitattributes
├── CLAUDE.md                   # guidance for Claude Code when working on this repository
├── LICENSE
└── README.md
```

### Add a skill

1. Copy `template/SKILL.md.example` to `skills/<name>/SKILL.md` and write the instructions. The template keeps its `.example` suffix on purpose: `npx skills` scans the whole repository and would offer any other `SKILL.md` to users as a skill.
2. Add `"./skills/<name>"` to the `skills` array of one plugin in `.claude-plugin/marketplace.json`, or declare a new plugin:

   ```json
   {
     "name": "<plugin>",
     "description": "<what the group covers>",
     "source": "./",
     "skills": ["./skills/<name>"]
   }
   ```

   A skill belongs to exactly one plugin; a skill that no plugin lists fails the tests.

3. Try it locally, run the checks, open a pull request.

### Portability rules

- Frontmatter: standard fields only (`name`, `description`, optional `license`, `compatibility`, `metadata`, `allowed-tools`). Agent-specific fields such as `disable-model-invocation` are ignored by other agents.
- `name` = directory name: lowercase letters, digits and single hyphens, at most 64 characters. `description`: at most 1024 characters, saying what the skill does and when to use it, with the words that should trigger it.
- Quote frontmatter values that contain `: ` or ` #`: strict YAML parsers reject them otherwise.
- `license: MIT`, the license of this repository.
- No agent-specific tool names in the body.
- Bundled files go in `scripts/`, `references/` or `assets/`, referenced with paths relative to the skill root. Prefer Python or Node over shell scripts for Windows compatibility.
- Keep `SKILL.md` under 500 lines; move details to `references/`.

### Try it locally

```bash
claude --plugin-dir .
```

Loads the whole repository as a single session plugin named `ai-skills`: skills are invoked as `/ai-skills:<skill>` in that session. Run `/reload-plugins` after an edit.

### Checks

```bash
node .github/scripts/checks.mjs              # all checks
node .github/scripts/checks.mjs tests        # one check: tests, marketplace or discovery
```

`tests` runs `tests/catalog.test.mjs`, which checks the repository against the rules above: every plugin lists its skills under `./skills/`, every skill belongs to exactly one plugin and has a valid `SKILL.md`, every folder of `skills/` is listed, and no other `SKILL.md` exists. Its fixture tests use placeholder names, so adding or removing a skill never requires updating a test. `marketplace` runs `claude plugin validate .` and `discovery` runs `npx skills add . --list`, both through `npx` at the versions pinned in `.github/scripts/checks.mjs`. CI runs the three checks on every push and pull request to `main`.

To run them locally through git hooks (`tests` before each commit, all three before each push), enable the hooks once per clone:

```bash
git config core.hooksPath .githooks
```

`--no-verify` skips them for one commit or push. The hooks check the working tree, not the staged or pushed content.

### Remove a skill

Delete `skills/<name>/`, remove `"./skills/<name>"` from its plugin in `.claude-plugin/marketplace.json`, and delete the plugin entry if its `skills` array becomes empty.

## License

[MIT](LICENSE)

## References

- [Agent Skills specification](https://agentskills.io/specification)
- [Claude Code: marketplace reference](https://code.claude.com/docs/en/plugins/marketplace-reference.md)
- [Claude Code: host and maintain a marketplace](https://code.claude.com/docs/en/plugins/host-marketplace.md)
- [skills CLI](https://github.com/vercel-labs/skills)
