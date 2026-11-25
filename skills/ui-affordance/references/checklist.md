# Affordance checklist

Every rule applies to every audited page at both viewports unless it names one. Each rule gives a typical severity: set the final one with the definitions of "Severities" in `SKILL.md`. "Script" names the checks of `scripts/inventory.js` that find candidates for the rule; a candidate becomes a finding only once confirmed on the screenshot, and most rules have no script check at all. "Standards" lists what the report cites, by name.

## General

### G1. Interactive elements look interactive, and of their type

- At rest, without hovering, each element that reacts to a click, a tap or typing looks like something that does, and like the right thing: a link like a link, a button like a button, a field like a field, a switch like a switch.
- Judge the screenshot, not the markup: a `<button>` reset to plain text fails; a `<div>` styled as a filled button passes this rule.
- Typical severity: BLOCKER when nothing at rest suggests the action exists; WARN when the action shows but its type is ambiguous (a button that looks like a tag, a link that looks like a heading).
- Standards: Web conventions; Nielsen #6 Recognition rather than recall; Nielsen #4 Consistency and standards.

### G2. Nothing static looks interactive

- No false signifier: no underline on text that is not a link; no accent-colored text alone that reads as a link; no button-like shape (filled or outlined pill, raised box) on a label, badge or status; no hover effect, pointer cursor or elevation on an element that does nothing; no chevron, arrow or handle on something that does not expand, navigate or move.
- Typical severity: BLOCKER when the resemblance invites a click that leads nowhere; WARN when it is weak (a decorative underline, a hover effect alone).
- Script: `pointer-on-static`, `static-hover`, `underline-not-link`. A `pointer-on-static` element may be clickable through a JavaScript handler: check the code before calling it a false signifier.
- Standards: Web conventions; Nielsen #4 Consistency and standards.

### G3. The cursor matches the element (desktop)

- `pointer` on every clickable element: links, buttons, clickable cards and rows, tabs, menu items, selects, checkboxes, radios, switches and their labels, summary elements, upload controls.
- `text` (or `auto`, which shows the I-beam) on text fields; `grab` on draggable items, `grabbing` while dragged; a resize cursor on resize handles; `not-allowed` on disabled elements (A8); the default cursor on static elements (G2).
- Typical severity: NITPICK.
- Script: `cursor-missing`, `pointer-on-static`, `disabled-cursor`.
- Standards: Web conventions.

### G4. Clickable elements react to hover, static ones do not (desktop)

- Hovering a clickable element changes something visible on it: background, border, shadow, underline or color. Text fields need no hover change.
- Typical severity: NITPICK, for a missing or barely perceptible change.
- Script: `needsRealHover` lists clickable elements with no `:hover` rule found; hover a representative of each group and call `hover(selector)`: no change in `changes` confirms the finding.
- Standards: Material 3 — Interaction states.

### G5. No action or signifier visible only on hover

- An action that appears only when its container is hovered (row actions, buttons on a card, a copy button on a code block) does not exist for a user who does not hover there, and does not exist at all on a touch screen.
- Exception: a submenu revealed by hovering a visible trigger that already signals it (chevron, caret) is not hover-only on desktop; on mobile it must open on tap.
- Typical severity: WARN on desktop; BLOCKER on mobile when the action has no other access on that viewport.
- Script: `hover-only`. Elements that JavaScript inserts on hover are not in the inventory: compare screenshots at rest and while hovering rows, cards and list items.
- Standards: Nielsen #6 Recognition rather than recall.

### G6. Same action, same look; different look, different behavior

- Across all audited pages and both viewports, elements with the same role share one appearance: primary buttons, secondary buttons, links in text, navigation links, fields. Two elements that look alike behave alike.
- A house style applied everywhere that breaks a web convention is not a consistency question: report it under the rule of the convention (A1, A3, I1...).
- Typical severity: WARN.
- Script: `list(kind)` groups the elements of a page by appearance; compare the groups across pages.
- Standards: Nielsen #4 Consistency and standards.

### G7. Touch targets of at least 44 × 44 px (mobile)

- The hit area of each interactive element, padding included, is at least 44 × 44 CSS px at 390 px wide. Links inside a sentence are exempt. A checkbox or radio inside its label, or pointed to by a `label[for]`, is measured with the label.
- The script measures the element's box: a hit area enlarged by a pseudo-element or by a clickable wrapper is measured in the code before reporting.
- Typical severity: WARN.
- Script: `target-size`.
- Standards: Apple HIG — Buttons (44 × 44 pt hit region).

### G8. Selected and current states show

- The selected tab, the current page in a navigation, an applied filter, a pressed toggle button, a selected row or option look clearly different from their unselected peers: weight, background, indicator bar, check mark.
- Typical severity: WARN; BLOCKER when the user cannot tell which item is active and it changes what the page shows (tabs, filters).
- Script: `selected-indistinct`, based on `aria-selected`, `aria-current` and `aria-pressed`. States marked by a class only are checked on the screenshot.
- Standards: Nielsen #1 Visibility of system status.

## Actions

### A1. Links inside text are underlined

- A link inside a sentence or paragraph is underlined at rest (text decoration, bottom border or drawn underline), in addition to any color. Color alone fails, even when the whole app does it.
- Typical severity: WARN; BLOCKER when the link color is also close to the text color.
- Script: `inline-link-no-underline`.
- Standards: Web conventions (links); Nielsen #4 Consistency and standards.

### A2. Navigation links are recognizable by their context

- Links in navigation bars, menus, sidebars, footers and link lists need no underline: position, grouping and spacing signal them. They still differ from static text in the same area (section titles in a footer, labels in a sidebar).
- Typical severity: WARN.
- Standards: Web conventions (navigation).

### A3. Buttons have a shape

- A button shows a container at rest: a fill distinct from its surroundings, or a border. The primary action of a view is filled.
- Typical severity: WARN; BLOCKER when the primary action of a view looks like plain text.
- Script: `button-no-shape` (icon-only buttons excluded, see A6); judge each candidate with A4.
- Standards: Material 3 — Buttons; Fluent 2 — Button; Apple HIG — Buttons.

### A4. Text and ghost buttons only for secondary or tertiary actions

- A button without a container is accepted only for a secondary or tertiary action, when it stands out from the surrounding text (accent color, weight or icon) and gains a container or an underline on hover. Never for the primary action of a view.
- Typical severity: WARN.
- Standards: Material 3 — Buttons.

### A5. What looks like a link navigates

- An element that looks like a link does not trigger an action (delete, send, save, open a dialog or a menu, toggle something): it looks like a button. A link styled as a button for a call to action ("Create an account") is accepted.
- Tell what an element does from the code, or by clicking it within the agreed interactions.
- Typical severity: WARN.
- Standards: Web conventions (links and buttons); Nielsen #4 Consistency and standards.

### A6. Icon-only buttons use universal icons

- A button or link with no visible text is accepted only with an icon everybody recognizes: close (×), menu (☰), search (magnifier), back (←), add (+), delete (trash), edit (pencil), settings (gear), more options (⋯ or ⋮), expand or collapse (chevron), download, home, play and pause. Any other icon gets a visible text label; a tooltip does not count.
- A logo linking to the home page passes.
- Typical severity: WARN.
- Script: `icon-only` lists them; identify each icon on the screenshot.
- Standards: Nielsen #6 Recognition rather than recall; Material 3 — Icon buttons.

### A7. Clickable cards and rows look clickable as a whole

- A card, list item or table row that opens something when clicked anywhere shows it at rest (a title styled as a link, a chevron or arrow, a visible action) and reacts to hover on its whole surface, with a pointer cursor.
- Clickable and static cards on the same page do not look identical.
- When only part of a card is clickable (its title, a button), the card as a whole has no hover effect and no pointer cursor (G2).
- Typical severity: WARN; BLOCKER when nothing shows at rest and the card is the only way to reach what it opens.
- Standards: Material 3 — Cards; Nielsen #4 Consistency and standards.

### A8. Disabled elements look disabled

- A disabled control is visibly muted compared with its enabled state (reduced opacity, greyed fill or text), shows the `not-allowed` cursor and does not react to hover.
- Typical severity: BLOCKER when it looks enabled (the click does nothing); NITPICK for the cursor alone.
- Script: `disabled-cursor`, `disabled-hover`.
- Standards: Material 3 — Interaction states; Nielsen #1 Visibility of system status.

### A9. Work in progress shows

- After an action that takes time (submit, save, load more), its trigger shows that it is working (spinner, progress label, busy state); a region being loaded shows a loader or a skeleton.
- Actions that write are observed only when the user confirmed the environment is disposable; loading without a write (opening a page, filtering a list) is always observed.
- Typical severity: WARN.
- Standards: Nielsen #1 Visibility of system status.

### A10. Links that leave the app say so

- A link that opens a new tab or goes to another site shows it, with an icon (↗) or in its text.
- Typical severity: NITPICK.
- Script: `external-link` lists them; check for the indicator on the screenshot.
- Standards: Web conventions (external links).

### A11. Labels say what happens

- A button label names its action with a verb ("Save", "Send the invoice"); "OK" is accepted only in a simple dialog. A link names its destination; "Click here", "Learn more" or "Read more" alone fail.
- Typical severity: WARN.
- Standards: Nielsen #2 Match between the system and the real world.

## Input

### I1. Fields look editable

- A text field, text area or select has a visible boundary at rest: a border, a bottom line, or a fill distinct from its background.
- Typical severity: BLOCKER when nothing shows the field; WARN when the boundary is faint.
- Script: `field-no-boundary`.
- Standards: Web conventions (form fields); Material 3 — Text fields.

### I2. Placeholders do not look like values

- Placeholder text is visibly lighter than typed values; a placeholder that looks like a value makes the field look already filled.
- Typical severity: WARN.
- Script: `placeholder-like-value`.
- Standards: Material 3 — Text fields.

### I3. Read-only and disabled fields do not look editable

- A read-only value shows as text, or in a field style visibly different from editable fields; a disabled field is muted (A8).
- Typical severity: WARN.
- Standards: Web conventions (form fields); Nielsen #4 Consistency and standards.

### I4. Selects and pickers show that they open

- A select, dropdown or combobox shows a chevron or caret at rest; a field that opens a picker (date, color, file) shows its icon or button.
- Typical severity: WARN.
- Standards: Web conventions (form fields); Material 3 — Menus.

### I5. Choices look like their behavior

- Checkboxes are square, for independent options; radios are round, for one choice in a group; a switch is for an on/off setting applied at once, and its states differ by the knob position as well as by color.
- Typical severity: WARN.
- Standards: Web conventions (form fields); Material 3 — Checkbox, Radio button, Switch; Apple HIG — Toggles.

### I6. Upload areas look like targets

- A drop zone looks like one (dashed border, upload icon or "drop files here" text) and holds a visible control to browse for files.
- Typical severity: WARN.
- Standards: Web conventions (file upload).

### I7. Sliders look draggable

- A slider shows its track and a thumb that looks grabbable, and the selected value or range is readable.
- Typical severity: WARN.
- Standards: Material 3 — Sliders.

## Navigation and disclosure

### N1. Tabs look like tabs

- Tabs sit in one row, look clickable, and the selected one is marked (G8).
- Typical severity: WARN.
- Standards: Material 3 — Tabs.

### N2. The current location is marked

- The current page is marked in the navigation bar, sidebar or bottom bar (G8).
- Typical severity: WARN.
- Standards: Nielsen #1 Visibility of system status.

### N3. Menu triggers show that they open a menu

- A button that opens a dropdown menu shows a chevron or caret, or is a universal menu icon (☰, ⋯, ⋮, or the avatar for the account menu).
- Typical severity: WARN.
- Standards: Web conventions (menus); Material 3 — Menus.

### N4. Expandable sections show that they expand

- Accordions, collapsible panels, tree nodes and "show more" toggles show a chevron, a plus or a similar mark at rest, which changes when open; the whole header is clickable.
- Typical severity: WARN; BLOCKER when the collapsed content holds required information or actions and nothing signals it.
- Standards: Web conventions (disclosure); Nielsen #6 Recognition rather than recall.

### N5. Pagination shows where the user is

- The current page is marked and does not look clickable; previous and next at the ends look disabled (A8).
- Typical severity: WARN.
- Standards: Nielsen #1 Visibility of system status.

### N6. Breadcrumbs link their ancestors only

- The ancestors in a breadcrumb look like links; the current page, last, does not.
- Typical severity: NITPICK.
- Standards: Web conventions (breadcrumbs).

### N7. Overlays show how to close them

- A dialog, drawer, panel or popover that does not close by itself after a choice shows a close control (× in the top right corner by convention) or a Cancel or Close button.
- Typical severity: BLOCKER when there is no visible way out; WARN when the only one is a button at the bottom of a long overlay.
- Standards: Nielsen #3 User control and freedom.

## Direct manipulation

### D1. Draggable items show that they move

- Items that can be reordered or moved show a handle (⋮⋮ grip) or an obviously movable look, with a `grab` cursor (G3); drop targets highlight while dragging.
- Typical severity: BLOCKER when dragging is the only way to do something and nothing shows it; WARN otherwise.
- Standards: Apple HIG — Drag and drop.

### D2. Resizable areas show their handle

- Resizable panels, columns and text areas show a handle or divider that looks grabbable, with a resize cursor.
- Typical severity: WARN.
- Standards: Web conventions (resizing).

### D3. Scrollable content shows that there is more

- Content that continues beyond a scroll container or below the fold looks cut: an item partly visible at the edge, a fade, or a visible scrollbar. A hidden scrollbar (`scrollbarHidden`, or overlay scrollbars on mobile) needs one of the other cues.
- No false floor: a section that ends exactly at the bottom of the viewport, with nothing hinting at the content below.
- Typical severity: WARN.
- Script: `scrollContainers`, and `page.scrollHeight` against `page.viewportHeight`.
- Standards: Web conventions (scrolling).

### D4. Carousels show that there are more slides

- Arrows, pagination dots, or the next slide peeking at the edge; on mobile, where arrows are often hidden, a peeking slide or dots.
- Typical severity: WARN.
- Standards: Material 3 — Carousel.

### D5. Sortable columns show that they sort

- Sortable column headers show a sort icon at rest (not only on hover, G5), the current sort column and direction are marked, and headers that do not sort have no pointer and no hover effect.
- Typical severity: WARN.
- Standards: Web conventions (data tables).
