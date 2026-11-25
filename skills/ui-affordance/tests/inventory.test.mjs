// Tests for scripts/inventory.js, run against the fake DOM of fake-dom.mjs.
// Run from the repository root: node --test skills/ui-affordance/tests/*.test.mjs

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CSSLayerBlockRule, CSSMediaRule, CSSNestedDeclarations, CSSStyleRule, FakeStyleSheet, createPage, h, loadInventory, normalize, runInventory } from './fake-dom.mjs';

const POINTER = { cursor: 'pointer' };
const MOBILE = { viewport: 'mobile' };

function groupsOf(result, check) {
  return result.checks.filter((group) => group.check === check);
}

function flaggedTexts(result, check) {
  return groupsOf(result, check)
    .flatMap((group) => group.examples.map((example) => example.text))
    .sort();
}

function hoverNeededTexts(result) {
  return result.needsRealHover.flatMap((group) => group.examples.map((example) => example.text)).sort();
}

describe('options', () => {
  it('requires a desktop or mobile viewport', () => {
    const inventory = loadInventory(createPage());
    assert.throws(() => inventory(), /options\.viewport must be 'desktop' or 'mobile'/);
    assert.throws(() => inventory({ viewport: 'tablet' }), /options\.viewport/);
  });

  it('reports the page and the viewport', () => {
    const result = runInventory(createPage({ width: 390, height: 844, scrollHeight: 3000 }), MOBILE);
    assert.equal(result.viewport, 'mobile');
    assert.deepEqual(result.size, { width: 390, height: 844 });
    assert.deepEqual(result.page, { scrollHeight: 3000, viewportHeight: 844 });
  });
});

describe('classification', () => {
  it('counts rendered interactive elements by kind', () => {
    const page = createPage({
      body: [
        h('a', { attrs: { href: '/docs' } }, 'Docs'),
        h('a', {}, 'Anchor without href'),
        h('button', {}, 'Save'),
        h('input', { attrs: { type: 'email' } }),
        h('input', { attrs: { type: 'hidden' } }),
        h('input', { attrs: { type: 'checkbox' } }),
        h('input', { attrs: { type: 'range' } }),
        h('input', { attrs: { type: 'submit', value: 'Send' } }),
        h('textarea'),
        h('select'),
        h('div', { attrs: { role: 'tab' } }, 'Tab'),
        h('div', { attrs: { draggable: 'true' } }, 'Card'),
        h('summary', {}, 'More'),
        h('button', { rect: { width: 0, height: 0 } }, 'Not rendered'),
      ],
    });
    assert.deepEqual(runInventory(page).counts, {
      link: 1,
      button: 2,
      'text-field': 2,
      checkable: 1,
      slider: 1,
      select: 1,
      tab: 1,
      draggable: 1,
      disclosure: 1,
    });
  });

  it('treats a label as clickable only when it labels a checkbox or a radio', () => {
    const page = createPage({
      body: [
        h('label', { attrs: { for: 'remember' } }, 'Remember me'),
        h('input', { attrs: { id: 'remember', type: 'checkbox' } }),
        h('label', { attrs: { for: 'name' } }, 'Name'),
        h('input', { attrs: { id: 'name' } }),
        h('label', {}, h('input', { attrs: { type: 'radio' } }), 'Monthly'),
      ],
    });
    assert.equal(runInventory(page).counts.label, 2);
  });
});

describe('cursor (G3)', () => {
  it('flags clickable elements without the expected cursor on desktop only', () => {
    const body = () => [
      h('button', {}, 'No pointer'),
      h('button', { style: POINTER }, 'Pointer'),
      h('input', { attrs: { placeholder: 'Name' }, style: { cursor: 'text' } }),
      h('div', { attrs: { draggable: 'true' }, style: POINTER }, 'Drag me'),
    ];
    const desktop = runInventory(createPage({ body: body() }));
    assert.deepEqual(flaggedTexts(desktop, 'cursor-missing'), ['Drag me', 'No pointer']);
    assert.equal(groupsOf(desktop, 'cursor-missing').find((group) => group.kind === 'button').examples[0].detail, 'cursor: auto, expected pointer');
    assert.equal(groupsOf(desktop, 'cursor-missing')[0].rule, 'G3');
    assert.deepEqual(flaggedTexts(runInventory(createPage({ body: body() }), MOBILE), 'cursor-missing'), []);
  });

  it('expects not-allowed on disabled elements, including inside a disabled fieldset', () => {
    const page = createPage({
      body: [
        h('button', { attrs: { disabled: '' } }, 'Disabled'),
        h('button', { attrs: { disabled: '' }, style: { cursor: 'not-allowed' } }, 'Disabled with cursor'),
        h('button', { attrs: { disabled: '' }, style: { cursor: 'not-allowed', 'pointer-events': 'none' } }, 'No pointer events'),
        h('fieldset', { attrs: { disabled: '' } }, h('button', {}, 'In fieldset')),
        h('div', { attrs: { role: 'button', 'aria-disabled': 'true' } }, 'Aria disabled'),
      ],
    });
    const result = runInventory(page);
    assert.deepEqual(flaggedTexts(result, 'disabled-cursor'), ['Aria disabled', 'Disabled', 'In fieldset', 'No pointer events']);
    assert.deepEqual(flaggedTexts(result, 'cursor-missing'), []);
  });
});

describe('false signifiers (G2)', () => {
  it('flags a pointer cursor on static elements, once per subtree', () => {
    const page = createPage({
      body: [
        h('div', { style: POINTER }, h('span', { style: POINTER }, 'Static with pointer')),
        h('a', { attrs: { href: '/' }, style: POINTER }, h('span', { style: POINTER }, 'Inside a link')),
      ],
    });
    assert.deepEqual(flaggedTexts(runInventory(page), 'pointer-on-static'), ['Static with pointer']);
  });

  it('flags underlined text outside links, except abbreviations', () => {
    const underline = { 'text-decoration-line': 'underline' };
    const page = createPage({
      body: [
        h('p', {}, h('span', { style: underline }, 'Underlined')),
        h('p', {}, h('abbr', { style: underline, attrs: { title: 'HyperText' } }, 'HTML')),
        h('p', {}, h('a', { attrs: { href: '/' } }, h('span', { style: underline }, 'Link text'))),
      ],
    });
    assert.deepEqual(flaggedTexts(runInventory(page), 'underline-not-link'), ['Underlined']);
  });

  it('flags hover effects on static elements without interactive content', () => {
    const card = h('div', {}, 'Static card');
    const wrapper = h('div', {}, h('a', { attrs: { href: '/' } }, 'Link in wrapper'));
    const faded = h('div', {}, 'Transition only');
    const title = h('h3', {}, 'Title in card');
    card.append(title);
    const page = createPage({
      body: [card, wrapper, faded],
      styleSheets: [
        new FakeStyleSheet([
          new CSSStyleRule('.card:hover', { 'box-shadow': '0 4px 8px black' }),
          new CSSStyleRule('.card:hover h3', { color: 'blue' }),
          new CSSStyleRule('.wrapper:hover', { 'background-color': 'gray' }),
          new CSSStyleRule('.faded:hover', { transition: 'opacity 0.2s' }),
        ]),
      ],
      selectors: { '.card': [card], '.card h3': [title], '.wrapper': [wrapper], '.faded': [faded] },
    });
    const result = runInventory(page);
    assert.deepEqual(flaggedTexts(result, 'static-hover'), ['Static card Title in card']);
    assert.equal(groupsOf(result, 'static-hover')[0].examples[0].detail, 'hover style from .card:hover');
  });
});

describe('links (A1, A10)', () => {
  it('flags links inside text that are not underlined', () => {
    const link = (text, style = {}) => h('a', { attrs: { href: '/docs' }, style }, text);
    const page = createPage({
      body: [
        h('p', {}, 'Read the ', link('plain'), ' first.'),
        h('p', {}, 'Read the ', link('underlined', { 'text-decoration-line': 'underline' }), ' first.'),
        h('p', {}, 'Read the ', link('bordered', { 'border-bottom-style': 'solid', 'border-bottom-width': '1px' }), ' first.'),
        h('nav', {}, h('ul', {}, h('li', {}, link('Navigation')))),
      ],
    });
    assert.deepEqual(flaggedTexts(runInventory(page), 'inline-link-no-underline'), ['plain']);
  });

  it('lists links that open a new tab or leave the app', () => {
    const page = createPage({
      body: [
        h('a', { attrs: { href: '/help', target: '_blank' } }, 'New tab'),
        h('a', { attrs: { href: 'https://example.org/page' } }, 'Other site'),
        h('a', { attrs: { href: '/orders' } }, 'Same app'),
        h('a', { attrs: { href: 'http://localhost:3000/settings' } }, 'Same origin'),
        h('a', { attrs: { href: 'mailto:team@example.org' } }, 'Mail'),
      ],
    });
    const details = groupsOf(runInventory(page), 'external-link')
      .flatMap((group) => group.examples.map((example) => `${example.text}: ${example.detail}`))
      .sort();
    assert.deepEqual(details, ['New tab: opens a new tab', 'Other site: goes to https://example.org']);
  });
});

describe('shapes (A3, I1)', () => {
  it('flags buttons with no visible container', () => {
    const page = createPage({
      body: [
        h(
          'section',
          { style: { 'background-color': 'rgb(240, 240, 240)' } },
          h('button', {}, 'Transparent'),
          h('button', { style: { 'background-color': 'rgb(240, 240, 240)' } }, 'Same as section'),
          h('button', { style: { 'background-color': 'rgb(0, 90, 200)' } }, 'Filled'),
          h('button', { style: { 'border-top-style': 'solid', 'border-top-width': '1px' } }, 'Bordered'),
          h('button', { attrs: { 'aria-label': 'Close' } }, h('svg')),
        ),
      ],
    });
    const result = runInventory(page);
    assert.deepEqual(flaggedTexts(result, 'button-no-shape'), ['Same as section', 'Transparent']);
    assert.equal(groupsOf(result, 'button-no-shape')[0].rule, 'A3');
  });

  it('flags editable fields with no visible boundary', () => {
    const page = createPage({
      body: [
        h('input', { attrs: { placeholder: 'No boundary' } }),
        h('input', { attrs: { placeholder: 'Underlined field' }, style: { 'border-bottom-style': 'solid', 'border-bottom-width': '1px' } }),
        h('input', { attrs: { placeholder: 'Read only', readonly: '' } }),
        h('select', { attrs: { 'aria-label': 'Bare select' } }),
      ],
    });
    assert.deepEqual(flaggedTexts(runInventory(page), 'field-no-boundary'), ['[aria-label] Bare select', '[placeholder] No boundary']);
  });
});

describe('placeholders (I2)', () => {
  it('flags placeholders styled like values', () => {
    const page = createPage({
      body: [
        h('input', { attrs: { placeholder: 'Looks filled' }, pseudo: { '::placeholder': { color: 'rgb(0, 0, 0)', opacity: '1' } } }),
        h('input', { attrs: { placeholder: 'Default placeholder' } }),
      ],
    });
    assert.deepEqual(flaggedTexts(runInventory(page), 'placeholder-like-value'), ['[placeholder] Looks filled']);
  });
});

describe('icon-only buttons (A6)', () => {
  it('lists buttons and links whose content is only an icon', () => {
    const page = createPage({
      body: [
        h('button', { attrs: { 'aria-label': 'Close' } }, h('svg')),
        h('a', { attrs: { href: '/' } }, h('img', { attrs: { alt: 'Home' } })),
        h('button', {}, h('svg'), 'Save'),
        h('button', {}, h('span', { rect: { width: 1, height: 1 } }, 'Hidden label'), h('svg', { attrs: { title: 'Gear' } })),
      ],
    });
    assert.deepEqual(flaggedTexts(runInventory(page), 'icon-only'), ['[alt] Home', '[aria-label] Close', '[title] Gear']);
  });
});

describe('touch targets (G7)', () => {
  it('flags targets under 44 px on mobile, except inline links and labelled checkboxes', () => {
    const body = () => [
      h('button', { rect: { width: 30, height: 30 } }, 'Small'),
      h('button', { rect: { width: 44, height: 44 } }, 'Large enough'),
      h('p', { rect: { width: 300, height: 60 } }, 'See ', h('a', { attrs: { href: '/terms' }, rect: { width: 40, height: 18 } }, 'terms'), '.'),
      h('label', { rect: { width: 300, height: 48 } }, h('input', { attrs: { type: 'checkbox' }, rect: { width: 16, height: 16 } }), 'Remember me'),
      h('input', { attrs: { type: 'checkbox', 'aria-label': 'Lone checkbox' }, rect: { width: 16, height: 16 } }),
    ];
    const mobile = runInventory(createPage({ body: body(), width: 390, height: 844 }), MOBILE);
    assert.deepEqual(flaggedTexts(mobile, 'target-size'), ['Small', '[aria-label] Lone checkbox']);
    const small = groupsOf(mobile, 'target-size').flatMap((group) => group.examples).find((example) => example.text === 'Small');
    assert.equal(small.detail, '30 × 30 px');
    assert.deepEqual(flaggedTexts(runInventory(createPage({ body: body() })), 'target-size'), []);
  });
});

describe(':hover rules (G4)', () => {
  it('asks for a real hover only on clickable elements with no :hover rule', () => {
    const styled = h('button', { style: POINTER }, 'Styled');
    const plain = h('button', { style: POINTER }, 'Plain');
    const page = createPage({
      body: [styled, plain, h('input', { style: { cursor: 'text' } })],
      styleSheets: [new FakeStyleSheet([new CSSStyleRule('.btn:hover', { 'background-color': 'blue' })])],
      selectors: { '.btn': [styled] },
    });
    const result = runInventory(page);
    assert.deepEqual(hoverNeededTexts(result), ['Plain']);
    assert.deepEqual(result.stylesheets, { read: 1, unreadable: [], unparsedSelectors: 0 });
    assert.deepEqual(runInventory(page, MOBILE).needsRealHover, []);
  });

  it('resolves nested rules, media queries, layers and escaped class names', () => {
    const nested = h('a', { attrs: { href: '/a' }, style: POINTER }, 'Nested');
    const tailwind = h('a', { attrs: { href: '/b' }, style: POINTER }, 'Tailwind');
    const layered = h('a', { attrs: { href: '/c' }, style: POINTER }, 'Layered');
    const listed = h('a', { attrs: { href: '/d' }, style: POINTER }, 'Listed');
    const page = createPage({
      body: [nested, tailwind, layered, listed],
      styleSheets: [
        new FakeStyleSheet([
          new CSSStyleRule('.nav-link', { color: 'black' }, [new CSSStyleRule('&:hover', {}, [new CSSMediaRule('(hover: hover)', [new CSSNestedDeclarations({ color: 'blue' })])])]),
          new CSSStyleRule('.dark\\:hover\\:text-blue:hover', { color: 'blue' }),
          new CSSLayerBlockRule([new CSSStyleRule('.layered:hover::after', { opacity: '1' })]),
          new CSSStyleRule('.listed:focus-visible, .listed:hover', { 'text-decoration-line': 'underline' }),
        ]),
      ],
      selectors: {
        ':is(.nav-link)': [nested],
        '.dark\\:hover\\:text-blue': [tailwind],
        '.layered': [layered],
        '.listed': [listed],
      },
    });
    assert.deepEqual(hoverNeededTexts(runInventory(page)), []);
  });

  it('ignores rules in media queries that do not match', () => {
    const link = h('a', { attrs: { href: '/' }, style: POINTER }, 'Link');
    const page = createPage({
      body: [link],
      styleSheets: [new FakeStyleSheet([new CSSMediaRule('(hover: hover)', [new CSSStyleRule('.link:hover', { color: 'blue' })])])],
      selectors: { '.link': [link] },
      media: { '(hover: hover)': false },
    });
    assert.deepEqual(hoverNeededTexts(runInventory(page)), ['Link']);
  });

  it('reports cross-origin stylesheets and selectors the browser cannot parse', () => {
    const page = createPage({
      body: [h('button', { style: POINTER }, 'Button')],
      styleSheets: [
        new FakeStyleSheet([], { href: 'https://cdn.example.org/theme.css', crossOrigin: true }),
        new FakeStyleSheet([new CSSStyleRule('.odd:hover:unknown-pseudo', { color: 'red' })]),
      ],
      selectors: { '.odd:unknown-pseudo': 'invalid' },
    });
    assert.deepEqual(runInventory(page).stylesheets, { read: 1, unreadable: ['https://cdn.example.org/theme.css'], unparsedSelectors: 1 });
  });

  it('flags hover effects on disabled elements (A8)', () => {
    const disabled = h('button', { attrs: { disabled: '' }, style: { cursor: 'not-allowed' } }, 'Disabled');
    const page = createPage({
      body: [disabled],
      styleSheets: [new FakeStyleSheet([new CSSStyleRule('.btn:hover', { 'background-color': 'blue' })])],
      selectors: { '.btn': [disabled] },
    });
    assert.deepEqual(flaggedTexts(runInventory(page), 'disabled-hover'), ['Disabled']);
  });
});

describe('hover-only actions (G5)', () => {
  it('flags interactive content hidden at rest and revealed by a :hover rule', () => {
    const actions = h('div', { style: { opacity: '0' } }, h('button', {}, 'Edit'), h('button', {}, 'Delete'));
    const decoration = h('div', { style: { opacity: '0' } }, 'Decoration');
    const closedDialog = h('div', { style: { display: 'none' }, rect: { width: 0, height: 0 } }, h('div', { style: { display: 'none' }, rect: { width: 0, height: 0 } }, h('button', {}, 'Inside')));
    const nestedMenu = closedDialog.children[0];
    const page = createPage({
      body: [h('div', {}, 'Row', actions, decoration), closedDialog],
      styleSheets: [
        new FakeStyleSheet([
          new CSSStyleRule('.row:hover .actions', { opacity: '1' }),
          new CSSStyleRule('.row:hover .decoration', { opacity: '1' }),
          new CSSStyleRule('.menu:hover > .submenu', { display: 'block' }),
        ]),
      ],
      selectors: { '.row .actions': [actions], '.row .decoration': [decoration], '.menu > .submenu': [nestedMenu] },
    });
    const groups = groupsOf(runInventory(page), 'hover-only');
    assert.equal(groups.length, 1);
    assert.equal(groups[0].rule, 'G5');
    assert.equal(groups[0].examples[0].detail, 'hidden at rest, revealed by .row:hover .actions');
    assert.equal(groups[0].examples[0].text, 'Edit Delete');
  });
});

describe('selected state (G8)', () => {
  it('flags a selected item that looks like its unselected peers', () => {
    const tabs = (selectedStyle) =>
      h(
        'div',
        { attrs: { role: 'tablist' } },
        h('button', { attrs: { role: 'tab', 'aria-selected': 'true' }, style: { cursor: 'pointer', ...selectedStyle } }, 'Overview'),
        h('button', { attrs: { role: 'tab', 'aria-selected': 'false' }, style: POINTER }, 'Activity'),
        h('button', { attrs: { role: 'tab', 'aria-selected': 'false' }, style: POINTER }, 'Settings'),
      );
    assert.deepEqual(flaggedTexts(runInventory(createPage({ body: [tabs({})] })), 'selected-indistinct'), ['Overview']);
    assert.deepEqual(flaggedTexts(runInventory(createPage({ body: [tabs({ 'font-weight': '700' })] })), 'selected-indistinct'), []);
    const indicator = { '::after': { content: '""', 'background-color': 'rgb(0, 90, 200)' } };
    const withIndicator = tabs({});
    withIndicator.children[0].pseudo = indicator;
    assert.deepEqual(flaggedTexts(runInventory(createPage({ body: [withIndicator] })), 'selected-indistinct'), []);
  });

  it('takes the style of a single-item wrapper into account', () => {
    const item = (text, current, style = {}) => h('li', { style }, h('a', { attrs: current ? { href: `/${text}`, 'aria-current': 'page' } : { href: `/${text}` } }, text));
    const nav = (currentStyle) => h('nav', {}, h('ul', {}, item('home', true, currentStyle), item('orders', false), item('invoices', false)));
    assert.deepEqual(flaggedTexts(runInventory(createPage({ body: [nav({})] })), 'selected-indistinct'), ['home']);
    assert.deepEqual(flaggedTexts(runInventory(createPage({ body: [nav({ 'background-color': 'rgb(230, 230, 230)' })] })), 'selected-indistinct'), []);
  });
});

describe('scroll containers (D3)', () => {
  it('lists overflowing containers and whether their scrollbar is hidden', () => {
    const page = createPage({
      body: [
        h('div', { style: { 'overflow-x': 'auto', 'scrollbar-width': 'none' }, scroll: { scrollWidth: 800, clientWidth: 300 }, rect: { width: 300, height: 120 } }),
        h('div', { style: { 'overflow-y': 'scroll' }, scroll: { scrollHeight: 400, clientHeight: 400 } }),
      ],
    });
    const result = runInventory(page);
    assert.equal(result.scrollContainers.length, 1);
    const { selector, ...container } = result.scrollContainers[0];
    assert.equal(selector, 'html > body:nth-child(2) > div:nth-child(1)');
    assert.deepEqual(container, { axis: 'x', scrollbarHidden: true, box: { x: 0, y: 0, width: 300, height: 120 } });
    assert.equal(result.scrollContainersTruncated, false);
  });
});

describe('grouping', () => {
  it('groups identical elements with the same problem and keeps three examples', () => {
    const buttons = ['One', 'Two', 'Three', 'Four', 'Five'].map((text) => h('button', {}, text));
    const groups = groupsOf(runInventory(createPage({ body: buttons })), 'cursor-missing');
    assert.equal(groups.length, 1);
    assert.equal(groups[0].count, 5);
    assert.deepEqual(
      groups[0].examples.map((example) => example.text),
      ['One', 'Two', 'Three'],
    );
  });
});

describe('selectors and page API', () => {
  it('uses unique ids and falls back to nth-child paths', () => {
    const page = createPage({
      body: [h('button', { attrs: { id: 'save' } }, 'Save'), h('button', { attrs: { id: 'dup' } }, 'A'), h('button', { attrs: { id: 'dup' } }, 'B')],
    });
    const selectors = groupsOf(runInventory(page), 'cursor-missing')[0].examples.map((example) => example.selector);
    assert.deepEqual(selectors, ['#save', 'html > body:nth-child(2) > button:nth-child(2)', 'html > body:nth-child(2) > button:nth-child(3)']);
    for (const selector of selectors) {
      assert.ok(page.document.querySelector(selector), selector);
    }
  });

  it('diffs the style between rest and hover, and lists revealed elements', () => {
    const button = h('button', { attrs: { id: 'go' }, style: POINTER }, 'Go');
    const actions = h('div', { attrs: { id: 'actions' }, style: { opacity: '0' } }, h('button', {}, 'Edit'));
    const page = createPage({ body: [button, h('div', {}, actions)] });
    runInventory(page);
    const api = page.window.__uiAffordance;
    assert.deepEqual(normalize(api.hover('#go')), { selector: '#go', changes: [], revealed: [] });
    button.computed = { ...button.computed, 'background-color': 'rgb(0, 0, 255)' };
    actions.computed = { opacity: '1' };
    const hovered = normalize(api.hover('#go'));
    assert.deepEqual(hovered.changes, [{ property: 'background-color', rest: 'rgba(0, 0, 0, 0)', hover: 'rgb(0, 0, 255)' }]);
    assert.deepEqual(
      hovered.revealed.map((example) => example.selector),
      ['#actions'],
    );
  });

  it('refuses unknown selectors, removed elements and a changed page', () => {
    const button = h('button', { attrs: { id: 'go' } }, 'Go');
    const page = createPage({ body: [button] });
    runInventory(page);
    const api = page.window.__uiAffordance;
    assert.throws(() => api.hover('#missing'), /is not in the inventory/);
    button.isConnected = false;
    assert.throws(() => api.get('#go'), /was removed from the page/);
    page.window.location.href = 'http://localhost:3000/other';
    assert.throws(() => api.hover('#go'), /The page changed/);
  });

  it('lists elements by appearance and describes one element', () => {
    const page = createPage({
      body: [
        h('button', { attrs: { id: 'a' }, style: POINTER }, 'A'),
        h('button', { attrs: { id: 'b' }, style: POINTER }, 'B'),
        h('button', { attrs: { id: 'c', 'aria-pressed': 'true' }, style: { cursor: 'pointer', 'background-color': 'rgb(0, 0, 0)' } }, 'C'),
        h('a', { attrs: { href: '/' } }, 'Link'),
      ],
    });
    runInventory(page);
    const api = page.window.__uiAffordance;
    const groups = normalize(api.list('button'));
    assert.deepEqual(
      groups.map((group) => group.count),
      [2, 1],
    );
    assert.equal(groups[0].style.cursor, 'pointer');
    assert.equal(normalize(api.list()).length, 3);
    assert.throws(() => api.list('widget'), /Unknown kind widget/);
    const described = normalize(api.get('#c'));
    assert.equal(described.kind, 'button');
    assert.equal(described.states.pressed, true);
    assert.deepEqual(described.hoverRules, []);
  });

  it('re-runs the inventory from the page for another viewport', () => {
    const page = createPage({ body: [h('button', { rect: { width: 20, height: 20 } }, 'Tiny')] });
    runInventory(page);
    const mobile = normalize(page.window.__uiAffordance.inventory(MOBILE));
    assert.equal(mobile.viewport, 'mobile');
    assert.deepEqual(flaggedTexts(mobile, 'target-size'), ['Tiny']);
  });
});
