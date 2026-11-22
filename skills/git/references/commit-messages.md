# Conventional Commits

Use this format only when the repository shows no commit convention of its own. Specification: [conventionalcommits.org](https://www.conventionalcommits.org/en/v1.0.0/).

```text
<type>(<scope>): <summary>

<body>

<footer>
```

- `type`: `feat` (new feature), `fix` (bug fix), `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.
- `scope`: optional, the part of the codebase that changed (module, package, top-level folder).
- `summary`: imperative mood ("add", not "added"), no trailing period, about 72 characters at most.
- `body`: optional, explains why the change was made rather than how; separated from the summary by a blank line.
- `footer`: optional, `Token: value` trailers such as `Refs: #123`.
- Breaking change: add `!` before the colon (`feat(api)!: drop v1 endpoints`) and/or a `BREAKING CHANGE: <what breaks and how to migrate>` footer.

## Examples

```text
fix(parser): reject empty input instead of returning null
```

```text
feat(api)!: require an API key on every request

Anonymous access let any client exhaust the rate limit.

BREAKING CHANGE: clients must send the X-Api-Key header.
```
