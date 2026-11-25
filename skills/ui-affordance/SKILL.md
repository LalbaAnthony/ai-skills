---
name: ui-affordance
description: Audit and fix the affordance of web user interfaces, judged on the rendered app. Every interactive element looks interactive and of its type, nothing static looks interactive, cursors and hover effects match, disabled, selected and loading states show, no action is visible only on hover, and mobile touch targets reach 44 px; web conventions first, then internal consistency, with Nielsen heuristics, Material 3, Apple HIG and Fluent 2 as references. Use when asked to audit, review or improve the affordance, intuitiveness or ease of use of a web app or page, to fix the findings of a ui-affordance report, and when creating or editing interactive UI such as links, buttons, form fields, menus, tabs, accordions, cards, tables or drag and drop. Audits need a browser tool, write a report under docs/audits/ and change code only when asked to fix; when writing UI, the rules apply to the code and problems in edited files are fixed. Keyboard focus, screen readers and contrast are out of scope.
license: MIT
compatibility: Audits and fixes need a browser tool that can open pages, resize the viewport, hover and click elements, take screenshots and run JavaScript in the page.
---

# UI affordance

Affordance, here, is what the rendered interface tells users they can do with each element before they try: its signifiers. This skill audits a running web app for them, fixes what the audit finds when asked, and applies the same rules when writing UI. The final render is what gets judged; the code is read to find and fix the causes.

## Scope

In scope:

- Signifiers at rest: every interactive element looks interactive and of its type (link, button, field, switch, tab, draggable item), and nothing static looks interactive.
- Signifiers on hover, on desktop: the cursor and a visible change.
- Interaction states: disabled, selected or current, loading.
- Actions visible only on hover, and the size of touch targets on mobile.
- Labels, where the text is the signifier (a button without a verb, a link reading "Click here").

Out of scope, neither reported nor fixed: keyboard focus, screen readers, ARIA, contrast ratios and other accessibility criteria; feedback after an action (toasts, confirmations, error messages); information architecture, layout and visual style beyond the signifiers.

The rules are in `references/checklist.md`, with an identifier each (G1, A3, I1...).

## Standards and precedence

1. **Web conventions**: what users learned on other sites and apps (a link in text is underlined, a button has a shape, a field has a boundary).
2. **Internal consistency**: same role, same look across the app (G6).
3. **References** used to justify findings: Nielsen's usability heuristics, Material 3, Apple Human Interface Guidelines, Fluent 2. The report cites them by name only, never by URL.

Conventions beat internal consistency: a house style applied everywhere that breaks a convention is a finding, and its fix converges to the convention everywhere.

## Severities

The labels stay in English in every report and reply.

- `[BLOCKER]`: the user does not see that an action exists, or a false signifier leads them into a dead end (a click that does nothing).
- `[WARN]`: the action is identifiable, with hesitation: ambiguous type, inconsistency, departure from a convention, action visible only on hover on desktop, touch target under 44 px.
- `[NITPICK]`: polish: missing pointer cursor, missing or faint hover change, missing new-tab indicator.

## Which mode applies

- **Writing UI**: the agent creates or edits interactive UI and nobody asked for an audit. Follow "Writing UI".
- **Audit**: the user asks to audit, review or evaluate the affordance, intuitiveness or ease of use of an app or pages. Follow "Audit" and stop after the report. An ambiguous request ("look at the affordance of the app") is an audit only.
- **Audit and fix**: the request also asks to fix or improve. Follow "Audit", then "Fix".
- **Fix from a report**: the user points to an existing report, by path or by date. Follow "Fix", starting with "From an existing report".

## Audit

### 1. Check the tools

The audit needs a browser tool that can open a URL, set the viewport size, hover and click elements, take screenshots, and run JavaScript in the page. If one of these is missing, stop: tell the user the audit needs it, and name what is missing. Never fall back to an audit of the code alone or of screenshots the user would provide.

### 2. Find the app

Look for an app already running on an address the project declares: dev server scripts and configuration (`package.json` scripts, `vite.config.*`, `next.config.*`, `nuxt.config.*`, `angular.json`), ports in `docker-compose.yml`, `APP_URL` or `PORT` in `.env`, the README. Open the candidates. If none answers, ask the user for the base URL. Never start, build or restart the app.

### 3. Choose the pages

List the routes that render pages, from the code: router configuration (vue-router, React Router, Angular routes), file-based routing (Next.js `app/` or `pages/`, Nuxt `pages/`, SvelteKit `src/routes/`), server routes (Laravel `routes/web.php`, Symfony route attributes, Express routers). Leave out API, asset and redirect-only routes. Show the user the list, static and dynamic routes, with the authentication guard of each route when the code shows one, and ask which to audit. Audit only the routes the user keeps.

### 4. Sign in

When a kept route needs authentication, ask the user for the credentials of one test account in the conversation, and sign in through the app's login form. Never write the credentials anywhere: not in the report, a file, a commit or a shell command. Routes this account cannot open are listed as not audited.

### 5. Agree on interactions

Before the first page, ask once whether the environment is disposable.

- Without a yes: hover, scroll, open menus, tabs, accordions and dialogs, type in fields without submitting. Never submit a form or trigger an action that writes (save, send, delete, pay, invite).
- With a yes: also submit forms and trigger actions, to observe loading states and the states they lead to. Even then, leave out actions whose effects leave the environment (payments, messages to real recipients) unless the user names them.

What the agreed interactions do not allow to observe is listed in the report as not observed.

### 6. Resolve dynamic routes

For each kept dynamic route (`/users/:id`), open the page that lists those items and follow a real link to one. When no page leads there, ask the user for a value; without one, list the route as not audited.

### 7. Audit each page

Two passes per page, in this order: desktop at 1440 × 900, then mobile at 390 × 844, with touch emulation when the tool has it. Default theme only. For each pass:

1. Load the page and wait until it is settled (no spinner, content rendered). Move the pointer to an empty area, away from the content, so that nothing is hovered.
2. Take a screenshot, full page when the tool can, and look at it with the checklist in mind: the screenshot is the primary evidence. Screenshots are never saved in the project.
3. Run the inventory script (see "Inventory script"). For the mobile pass on the same page load, resize, then call `window.__uiAffordance.inventory({ viewport: 'mobile' })`.
4. Desktop only: hover one representative of each `needsRealHover` group and, with the pointer still on it, call `window.__uiAffordance.hover(selector)`. Hover rows, cards and list items too, to catch actions that appear on hover (G5), comparing screenshots at rest and hovered.
5. Within the agreed interactions, open menus, tabs, accordions, dialogs and dropdowns, and trigger the states of G8, A8 and A9.
6. Go through the checklist for the elements the page holds. Script checks are candidates: confirm or dismiss each one against the screenshot and the code.
7. Find the source of each finding: the component, template or stylesheet that renders it.

### 8. Consolidate

- One finding per problem, with every occurrence (route, viewport, element). Problems with one cause (one shared component, one stylesheet rule) are one finding.
- Judge consistency (G6) across all audited pages, from the `list()` groups of each page.
- Set each severity with the definitions above; conventions beat the house style.

### 9. Write the report

Write `docs/audits/ui-affordance-YYYY-MM-DD.md` in the audited project, with today's date, creating the folders; when the file exists, add `-2`, `-3`... before `.md`. Follow `references/report-template.md`, in the language the user asked in. Every finding starts with the status `open`.

Then reply with the report path, the number of findings per severity, and the routes not audited. In the Audit mode, stop there and change no code.

## Fix

### From an existing report

1. Open the report the user points to. Given a date, open `docs/audits/ui-affordance-<date>.md`; when several files match, ask which one.
2. Steps 1, 2, 4 and 5 of "Audit" apply again: browser tool, URL, credentials, interactions.
3. Before changing any code, re-verify on the render every finding whose status is not `fixed` or `no longer reproduced`, on the occurrences it lists. A finding that no longer reproduces anywhere gets `no longer reproduced`, with a note.
4. Fix the remaining findings as below, and update this same report: never start a new one.

### Scope

Every finding, whatever its severity, unless the user restricts the fix ("only the blockers").

### Where

At the source. A finding caused by a shared component (button, link, card, layout) or a global stylesheet is fixed there, so that every usage changes, audited or not.

### What may change

- **Styles**: CSS, utility classes, CSS variables: underline, border, fill, cursor, styles for hover, disabled, selected.
- **Markup**: element type and structure, such as a clickable `div` that becomes a `button` or a link. Keep the behavior: `type="button"` on a button that does not submit, handlers moved to the new element, and the default styles of the new element reset so that only the intended change shows.
- **Icons**: only from an icon library installed as a dependency of the project, or an icon the project already has (icon component, sprite, assets folder). Never write a new SVG, inline or as a file. Without a suitable icon, fix another way (style, label) or leave the finding `not fixed`.
- **Labels**: in an app with translation files, change the key in every locale, translating the new label into each language.

### Values

- In a project with a token system (CSS variables, Tailwind theme, design system), use its tokens. When none fits, add a token to that system (`--color-link-hover`) and use it. Never write a raw value in a component.
- In a project without tokens, reuse a literal value the project already uses (the same accent color, the same radius). When none fits, leave the finding `not fixed`.

### Verify

1. Run the project's existing tests, with the command its `package.json`, `composer.json` or `Makefile` declares. Fix the tests the changes broke (snapshots, selectors). Write no new test.
2. Reload every route with a fixed occurrence, at both viewports, and re-check each fixed finding the way the audit found it: screenshot, inventory, hover.
3. Update the report: each finding's status (`fixed`, `partial`, `not fixed`) and note, the date in `Fixes`, the summary counts.
4. Commit nothing. Reply with the files changed, the number of findings per status, and the findings not fixed with their reason.

## Writing UI

When creating or editing interactive UI outside of an audit:

1. Apply the rules of `references/checklist.md` that concern the elements being written: a pointer cursor and a hover style on what is clickable, a shape on buttons, a boundary on fields, an underline on links in text, a muted style and `not-allowed` on disabled states, a visible selected state, a chevron on menus and expandable sections, a handle on draggable items, actions visible at rest, mobile targets of 44 px at least.
2. "What may change" and "Values" of "Fix" apply: tokens, icons, labels and translations.
3. Work on the code only: no browser, no inventory script, no report file.
4. Fix the affordance problems already present in the files modified for the task. In files only read, flag them without fixing.
5. End the reply with a section listing what was fixed and what was flagged, one `path:line` per item, with the rule:

```markdown
## ui-affordance

### Fixed
- `src/components/ProductCard.vue:14`: clickable card without hover style or pointer cursor (A7). Added both, with the existing `--shadow-raised` token.

### Flagged
- `src/components/DataTable.vue:48`: row actions visible only on hover (G5). Show them at rest, or behind a visible "more options" button.
```

## Inventory script

`scripts/inventory.js` runs inside the audited page through the browser tool. It is a single function expression: read the file and evaluate it called with the viewport of the pass, as an expression `(<file content>)({ viewport: 'desktop' })`, or wrapped for tools that take a function: `() => (<file content>)({ viewport: 'desktop' })`.

It returns JSON and installs `window.__uiAffordance` for the rest of the page load, so later calls are short. The file is large: send it only when `window.__uiAffordance` is missing, after a full page load. After a client-side navigation, in a single-page app, it is still there: call `window.__uiAffordance.inventory({ viewport })` instead.

| Call | Returns |
| --- | --- |
| `inventory({ viewport })` | the same result, computed again (after a resize, or after opening something) |
| `hover(selector)` | style changes between the inventory, taken at rest, and now, while the tool keeps the pointer on the element; plus the elements hidden at rest that are now visible |
| `list(kind)` | rendered, enabled elements of one kind, or of all kinds without argument, grouped by appearance (G6) |
| `get(selector)` | one element: kind, states, text, box, computed style, `:hover` rules |

Fields of the result:

- `checks`: candidates grouped by check, kind and appearance, each with `check`, `rule` (checklist identifier), `count` and up to three `examples` (`selector`, `text`, `box`, `detail`).
- `needsRealHover` (desktop): clickable elements for which no `:hover` rule was found.
- `scrollContainers`, `page`: for D3.
- `counts`: rendered interactive elements per kind (`link`, `button`, `text-field`, `select`, `checkable`, `slider`, `file`, `tab`, `menuitem`, `label`, `disclosure`, `clickable`, `draggable`).
- `stylesheets`: `unreadable` lists cross-origin stylesheets, whose `:hover` rules are unknown; hover their elements for real. `unparsedSelectors` counts `:hover` rules the browser could not match.
- `shadowHosts`: elements with a shadow root, whose content is not inventoried; check them on the screenshot.

Blind spots, covered by the screenshot and real hovering: styles set by JavaScript on hover, elements inserted on hover, hit areas enlarged by a pseudo-element or a wrapper, and any visual judgment (is this icon universal, does this card look clickable).
