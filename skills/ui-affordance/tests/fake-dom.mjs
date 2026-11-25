// Minimal DOM and CSSOM stand-ins for running scripts/inventory.js under Node. They implement only
// what the script reads. Selector matching is not implemented: each test registers the elements that
// document.querySelectorAll returns for a selector, and the selectors the script generates (#id and
// tag:nth-child chains) are resolved structurally by document.querySelector.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const SCRIPT_PATH = fileURLToPath(new URL('../scripts/inventory.js', import.meta.url));

const INLINE_TAGS = new Set(['a', 'abbr', 'b', 'code', 'em', 'i', 'ins', 'label', 'span', 'strong', 'u']);
const INLINE_BLOCK_TAGS = new Set(['button', 'input', 'select', 'textarea']);

const DEFAULT_STYLE = {
  'background-color': 'rgba(0, 0, 0, 0)',
  'background-image': 'none',
  'box-shadow': 'none',
  color: 'rgb(0, 0, 0)',
  content: 'none',
  cursor: 'auto',
  filter: 'none',
  'font-weight': '400',
  opacity: '1',
  'overflow-x': 'visible',
  'overflow-y': 'visible',
  'pointer-events': 'auto',
  'scrollbar-width': 'auto',
  'text-decoration-line': 'none',
  transform: 'none',
  visibility: 'visible',
};
for (const side of ['top', 'right', 'bottom', 'left']) {
  DEFAULT_STYLE[`border-${side}-style`] = 'none';
  DEFAULT_STYLE[`border-${side}-width`] = '0px';
  DEFAULT_STYLE[`border-${side}-color`] = 'rgb(0, 0, 0)';
}
const DEFAULT_PLACEHOLDER_STYLE = { ...DEFAULT_STYLE, color: 'rgb(117, 117, 117)' };

export class FakeText {
  constructor(value) {
    this.nodeType = 3;
    this.nodeValue = value;
    this.parentElement = null;
  }
}

export class FakeElement {
  // style: computed values at rest; pseudo: computed values per pseudo-element ('::before',
  // '::placeholder'...); rect: box in viewport coordinates; props: DOM properties (checked);
  // scroll: scrollWidth, clientWidth, scrollHeight, clientHeight.
  constructor(tag, { attrs = {}, style = {}, pseudo = {}, rect = {}, props = {}, scroll = {} } = {}, children = []) {
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.attributes = new Map(Object.entries(attrs));
    this.computed = style;
    this.pseudo = pseudo;
    this.rect = { x: 0, y: 0, width: 100, height: 20, ...rect };
    this.scrollWidth = scroll.scrollWidth ?? 0;
    this.clientWidth = scroll.clientWidth ?? 0;
    this.scrollHeight = scroll.scrollHeight ?? 0;
    this.clientHeight = scroll.clientHeight ?? 0;
    this.parentElement = null;
    this.childNodes = [];
    this.isConnected = true;
    this.shadowRoot = null;
    Object.assign(this, props);
    for (const child of children) {
      this.append(child);
    }
  }

  get id() {
    return this.attributes.has('id') ? String(this.attributes.get('id')) : '';
  }

  get children() {
    return this.childNodes.filter((node) => node.nodeType === 1);
  }

  append(child) {
    const node = typeof child === 'string' ? new FakeText(child) : child;
    node.parentElement = this;
    this.childNodes.push(node);
    return node;
  }

  getAttribute(name) {
    return this.attributes.has(name) ? String(this.attributes.get(name)) : null;
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  getBoundingClientRect() {
    const { x, y, width, height } = this.rect;
    return { x, y, left: x, top: y, width, height, right: x + width, bottom: y + height };
  }
}

export function h(tag, options = {}, ...children) {
  return new FakeElement(tag, options, children);
}

class FakeComputedStyle {
  constructor(values, defaults) {
    this.values = values;
    this.defaults = defaults;
  }

  getPropertyValue(name) {
    if (Object.hasOwn(this.values, name)) {
      return this.values[name];
    }
    return this.defaults[name] ?? '';
  }
}

function getComputedStyle(element, pseudo) {
  if (pseudo === null || pseudo === undefined) {
    const tag = element.tagName.toLowerCase();
    const display = INLINE_TAGS.has(tag) ? 'inline' : INLINE_BLOCK_TAGS.has(tag) ? 'inline-block' : 'block';
    return new FakeComputedStyle(element.computed, { ...DEFAULT_STYLE, display });
  }
  const defaults = pseudo === '::placeholder' ? DEFAULT_PLACEHOLDER_STYLE : DEFAULT_STYLE;
  return new FakeComputedStyle(element.pseudo[pseudo] ?? {}, defaults);
}

function declarations(entries) {
  const names = Object.keys(entries);
  return {
    length: names.length,
    item: (index) => names[index] ?? '',
    getPropertyValue: (name) => entries[name] ?? '',
  };
}

// The script recognizes rules by their constructor name, as in the browser.
export class CSSStyleRule {
  constructor(selectorText, entries = {}, cssRules = []) {
    this.selectorText = selectorText;
    this.style = declarations(entries);
    this.cssRules = cssRules;
  }
}

export class CSSNestedDeclarations {
  constructor(entries) {
    this.style = declarations(entries);
  }
}

export class CSSMediaRule {
  constructor(mediaText, cssRules) {
    this.media = { mediaText };
    this.cssRules = cssRules;
  }
}

export class CSSLayerBlockRule {
  constructor(cssRules) {
    this.cssRules = cssRules;
  }
}

export class FakeStyleSheet {
  constructor(cssRules, { href = null, crossOrigin = false } = {}) {
    this.href = href;
    this.rules = cssRules;
    this.crossOrigin = crossOrigin;
  }

  get cssRules() {
    if (this.crossOrigin) {
      throw new Error('SecurityError: Cannot access rules');
    }
    return this.rules;
  }
}

function findById(element, id) {
  if (element.id === id) {
    return element;
  }
  for (const child of element.children) {
    const found = findById(child, id);
    if (found) {
      return found;
    }
  }
  return null;
}

function resolveGenerated(root, selector) {
  const [first, ...steps] = selector.split(' > ');
  let current = first === 'html' ? root : first.startsWith('#') ? findById(root, first.slice(1)) : null;
  for (const step of steps) {
    const match = step.match(/^([a-z0-9-]+):nth-child\((\d+)\)$/);
    if (current === null || !match) {
      return null;
    }
    const child = current.children[Number(match[2]) - 1];
    current = child && child.tagName.toLowerCase() === match[1] ? child : null;
  }
  return current;
}

// selectors: { [selector]: FakeElement[] | 'invalid' }; media: { [mediaText]: boolean }, true when absent.
export function createPage({ body = [], width = 1440, height = 900, scrollHeight = 2000, styleSheets = [], selectors = {}, media = {}, url = 'http://localhost:3000/' } = {}) {
  const bodyElement = h('body', { rect: { width, height: scrollHeight } }, ...body);
  const root = h('html', { rect: { width, height: scrollHeight } }, h('head'), bodyElement);
  root.scrollHeight = scrollHeight;
  const registry = new Map(Object.entries(selectors));
  const document = {
    documentElement: root,
    body: bodyElement,
    styleSheets,
    querySelectorAll(selector) {
      const matched = registry.get(selector) ?? [];
      if (matched === 'invalid') {
        throw new SyntaxError(`'${selector}' is not a valid selector`);
      }
      return matched;
    },
    querySelector(selector) {
      return registry.has(selector) ? (this.querySelectorAll(selector)[0] ?? null) : resolveGenerated(root, selector);
    },
  };
  const location = new URL(url);
  const window = {
    document,
    innerWidth: width,
    innerHeight: height,
    scrollX: 0,
    scrollY: 0,
    location: { href: location.href, origin: location.origin },
    getComputedStyle,
    matchMedia: (query) => ({ matches: media[query] ?? true }),
  };
  return { window, document, root, body: bodyElement };
}

const FAKE_CSS = {
  escape: (value) => value.replace(/[^\w-]/g, (char) => `\\${char}`),
  supports: () => true,
};

// Objects created by the script belong to the vm context; a JSON round trip turns them into plain
// objects of this realm, as a browser tool would return them.
export function normalize(value) {
  return JSON.parse(JSON.stringify(value));
}

export function loadInventory(page) {
  const context = vm.createContext({ window: page.window, document: page.document, CSS: FAKE_CSS, URL });
  return vm.runInContext(`(${readFileSync(SCRIPT_PATH, 'utf8')}\n)`, context, { filename: 'inventory.js' });
}

export function runInventory(page, options = { viewport: 'desktop' }) {
  return normalize(loadInventory(page)(options));
}
