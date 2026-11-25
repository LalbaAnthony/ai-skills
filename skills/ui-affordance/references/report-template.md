# Report template

The report is written in the language the user asked for the audit in: title, headings, field names and prose. These stay in English whatever the language, so that a later session can read the report back: the severity labels (`[BLOCKER]`, `[WARN]`, `[NITPICK]`), the statuses, finding numbers (`F1`), routes, selectors, file paths and code.

## Statuses

- `open`: found by the audit, not fixed yet.
- `fixed`: fixed by the agent and verified on every occurrence.
- `partial`: fixed on some occurrences, or part of the problem remains; the note says which.
- `not fixed`: the agent tried and could not fix it; the note says why (no fitting token or value, no icon available).
- `no longer reproduced`: gone when re-verified before fixing, through a change made outside this report's fixes.

## Rules

- One finding per problem, with all its occurrences; problems with one cause (one shared component, one stylesheet rule) are one finding.
- Findings sorted by severity, then by number of occurrences, and numbered `F1`, `F2`... in that order. Numbers never change afterwards, even when statuses do.
- No screenshot, no proposed fix, no credentials. The account is described by its role.
- `Note` appears only for the statuses `partial`, `not fixed` and `no longer reproduced`.
- A fix run updates the statuses and notes in place, adds its date to `Fixes`, and recounts the summary. It never removes a finding.

## Template

```markdown
# UI affordance audit — 2026-11-25

- App: http://localhost:5173
- Commit: 4f2c9e1, with uncommitted changes
- Viewports: desktop 1440 × 900, mobile 390 × 844
- Theme: default
- Account: test account, role "manager"
- Interactions: without server-side effects
- Fixes: none

## Summary

| Severity | Findings | open | fixed | partial | not fixed | no longer reproduced |
| --- | --- | --- | --- | --- | --- | --- |
| [BLOCKER] | 1 | 1 | 0 | 0 | 0 | 0 |
| [WARN] | 1 | 1 | 0 | 0 | 0 | 0 |
| [NITPICK] | 0 | 0 | 0 | 0 | 0 | 0 |

## Pages

| Route | Audited URL | Viewports |
| --- | --- | --- |
| `/` | `/` | desktop, mobile |
| `/products` | `/products` | desktop, mobile |
| `/orders/:id` | `/orders/1042` | desktop, mobile |

### Not audited

- `/admin/users`: not accessible to the test account.
- `/invoices/:id`: no link to an invoice from a list page, and no value given.

### Not observed

- Loading states after a form submission: no consent for server-side effects.

## Findings

### F1 [BLOCKER] Search fields have no visible boundary

- Status: open
- Standard: Web conventions (form fields); Material 3 — Text fields
- Observed: the search field is white on the white header, with only a grey placeholder; nothing shows it accepts typing.
- Expected: a border or a fill distinct from the header, like the other fields of the app.
- Occurrences:
  - `/products`, desktop and mobile: header, search field
  - `/orders/:id`, desktop: header, search field
- Source: `src/components/SearchInput.vue`, `src/styles/forms.css`

### F2 [WARN] Row actions appear only on hover

- Status: open
- Standard: Nielsen #6 Recognition rather than recall
- Observed: the edit and delete icons of each product row are invisible until the row is hovered. On mobile, the table shows them at rest.
- Expected: the actions visible at rest, or a visible "more options" button (⋯) on each row.
- Occurrences:
  - `/products`, desktop: product table, every row
- Source: `src/components/DataTable.vue`
```
