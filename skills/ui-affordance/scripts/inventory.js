// UI affordance inventory, run inside the audited page by the agent's browser tool.
//
// This file is a single function expression, with no import or export. Evaluate it with the viewport
// of the pass, as an expression or wrapped in a function, depending on what the tool accepts:
//   (<file content>)({ viewport: 'desktop' })
//   () => (<file content>)({ viewport: 'mobile' })
// It returns a JSON-serializable inventory and installs window.__uiAffordance, whose methods
// (inventory, hover, list, get) can then be called without sending the file again, until the page
// reloads. Rule identifiers (G3, A1...) refer to references/checklist.md.
function uiAffordanceInventory(options) {
  'use strict';

  if (options === null || typeof options !== 'object' || (options.viewport !== 'desktop' && options.viewport !== 'mobile')) {
    throw new Error("uiAffordanceInventory: options.viewport must be 'desktop' or 'mobile'");
  }

  const VERSION = 1;
  const MIN_TARGET_SIZE = 44;
  const MAX_EXAMPLES = 3;
  const MAX_TEXT_LENGTH = 60;
  const MAX_SCROLL_CONTAINERS = 20;
  const MAX_PEER_ANCESTORS = 4;

  const SKIPPED_TAGS = new Set(['head', 'script', 'style', 'template', 'noscript', 'link', 'meta', 'title', 'base']);
  const FORM_TAGS = new Set(['button', 'input', 'select', 'textarea', 'fieldset', 'optgroup', 'option']);
  const BUTTON_INPUT_TYPES = new Set(['button', 'submit', 'reset', 'image', 'color']);
  const ROLE_KINDS = new Map([
    ['link', 'link'],
    ['button', 'button'],
    ['tab', 'tab'],
    ['menuitem', 'menuitem'],
    ['option', 'menuitem'],
    ['treeitem', 'menuitem'],
    ['checkbox', 'checkable'],
    ['radio', 'checkable'],
    ['switch', 'checkable'],
    ['menuitemcheckbox', 'checkable'],
    ['menuitemradio', 'checkable'],
    ['slider', 'slider'],
    ['combobox', 'select'],
    ['textbox', 'text-field'],
    ['searchbox', 'text-field'],
  ]);

  // Cursors accepted per kind (G3). The keys are also the list of kinds.
  const POINTER = ['pointer'];
  const EXPECTED_CURSORS = new Map([
    ['link', POINTER],
    ['button', POINTER],
    ['tab', POINTER],
    ['menuitem', POINTER],
    ['checkable', POINTER],
    ['select', POINTER],
    ['file', POINTER],
    ['label', POINTER],
    ['disclosure', POINTER],
    ['clickable', POINTER],
    ['text-field', ['text', 'auto']],
    ['slider', ['pointer', 'grab', 'grabbing']],
    ['draggable', ['grab', 'grabbing', 'move']],
  ]);
  // Kinds expected to change visibly on hover (G4), and kinds that may be icon-only buttons (A6).
  const HOVER_KINDS = new Set(['link', 'button', 'tab', 'menuitem', 'checkable', 'select', 'file', 'disclosure', 'clickable', 'slider', 'draggable']);
  const ICON_KINDS = new Set(['link', 'button', 'tab', 'menuitem', 'disclosure', 'clickable']);

  const CHECK_RULES = new Map([
    ['pointer-on-static', 'G2'],
    ['static-hover', 'G2'],
    ['underline-not-link', 'G2'],
    ['cursor-missing', 'G3'],
    ['hover-only', 'G5'],
    ['target-size', 'G7'],
    ['selected-indistinct', 'G8'],
    ['inline-link-no-underline', 'A1'],
    ['button-no-shape', 'A3'],
    ['icon-only', 'A6'],
    ['disabled-cursor', 'A8'],
    ['disabled-hover', 'A8'],
    ['external-link', 'A10'],
    ['field-no-boundary', 'I1'],
    ['placeholder-like-value', 'I2'],
  ]);

  // Declarations of a :hover rule that change nothing visible on their own.
  const NON_VISUAL_PREFIXES = ['transition', 'animation', 'will-change', 'cursor', 'pointer-events', 'z-index', 'user-select'];
  const SCROLLABLE_OVERFLOWS = new Set(['auto', 'scroll', 'overlay']);

  const SIDES = ['top', 'right', 'bottom', 'left'];
  const BORDER_PROPS = SIDES.flatMap((side) => [`border-${side}-style`, `border-${side}-width`, `border-${side}-color`]);
  // Properties compared between elements (G6, G8) and between rest and hover (G4).
  const VISUAL_PROPS = ['color', 'background-color', 'background-image', 'box-shadow', 'text-decoration-line', 'font-weight', 'opacity', 'visibility', 'transform', 'filter', 'cursor', ...BORDER_PROPS];
  const STYLE_PROPS = [...VISUAL_PROPS, 'display', 'pointer-events', 'overflow-x', 'overflow-y', 'scrollbar-width'];
  const PSEUDO_ELEMENTS = ['::before', '::after'];
  const PSEUDO_PROPS = ['content', 'background-color', 'border-bottom-style', 'border-bottom-width', 'border-bottom-color', 'opacity', 'transform'];

  // `:hover` as a pseudo-class, not inside an escaped class name such as `.hover\:bg-blue`.
  const HOVER_PSEUDO_CLASS = /(?<!\\):hover(?![\w-])/g;
  const HAS_HOVER_PSEUDO_CLASS = /(?<!\\):hover(?![\w-])/;
  const PSEUDO_ELEMENT = /(?<!\\)::[\w-]+(?:\([^)]*\))?|(?<!\\):(?:before|after|first-line|first-letter)(?![\w-])/g;

  const desktop = options.viewport === 'desktop';
  const pageUrl = window.location.href;

  // ---------------------------------------------------------------------------------------------
  // Computed style helpers
  // ---------------------------------------------------------------------------------------------

  function styleOf(element, pseudo) {
    return window.getComputedStyle(element, pseudo === undefined ? null : pseudo);
  }

  function snapshot(element) {
    const style = styleOf(element);
    const values = {};
    for (const prop of STYLE_PROPS) {
      values[prop] = style.getPropertyValue(prop);
    }
    for (const pseudo of PSEUDO_ELEMENTS) {
      const pseudoStyle = styleOf(element, pseudo);
      const content = pseudoStyle.getPropertyValue('content');
      if (content === '' || content === 'none' || content === 'normal') {
        continue;
      }
      for (const prop of PSEUDO_PROPS) {
        values[`${pseudo} ${prop}`] = pseudoStyle.getPropertyValue(prop);
      }
    }
    return values;
  }

  function visualEntries(values, ignored) {
    return Object.keys(values)
      .filter((key) => (VISUAL_PROPS.includes(key) || key.startsWith('::')) && !ignored.includes(key))
      .sort();
  }

  function visualKey(values, ignored = []) {
    return visualEntries(values, ignored)
      .map((key) => `${key}:${values[key]}`)
      .join(';');
  }

  function pickVisual(values) {
    const picked = {};
    for (const key of visualEntries(values, [])) {
      picked[key] = values[key];
    }
    return picked;
  }

  function alphaOf(color) {
    if (color === '' || color === 'transparent') {
      return 0;
    }
    const modern = color.match(/\/\s*([\d.]+)(%?)\s*\)$/);
    if (modern) {
      return parseFloat(modern[1]) / (modern[2] ? 100 : 1);
    }
    const legacy = color.match(/^rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)(%?)\s*\)$/);
    if (legacy) {
      return parseFloat(legacy[1]) / (legacy[2] ? 100 : 1);
    }
    return 1;
  }

  function visibleBorderSides(values) {
    return SIDES.filter((side) => {
      const style = values[`border-${side}-style`];
      return style !== 'none' && style !== 'hidden' && parseFloat(values[`border-${side}-width`]) > 0 && alphaOf(values[`border-${side}-color`]) > 0;
    });
  }

  function isHidden(values) {
    return values.display === 'none' || values.visibility === 'hidden' || parseFloat(values.opacity) === 0;
  }

  function isUnderlined(values) {
    if ((values['text-decoration-line'] || '').includes('underline')) {
      return true;
    }
    if (visibleBorderSides(values).includes('bottom')) {
      return true;
    }
    if (values['background-image'] !== 'none') {
      return true;
    }
    return PSEUDO_ELEMENTS.some((pseudo) => {
      const width = values[`${pseudo} border-bottom-width`];
      if (width === undefined) {
        return false;
      }
      const border = parseFloat(width) > 0 && values[`${pseudo} border-bottom-style`] !== 'none';
      return border || alphaOf(values[`${pseudo} background-color`]) > 0;
    });
  }

  // Background behind an element: the first ancestor with an opaque enough background color, null when
  // an ancestor paints an image first (unknown), white when nothing paints (the default canvas).
  function backgroundBehind(record) {
    for (let ancestor = record.parent; ancestor !== null; ancestor = ancestor.parent) {
      if (ancestor.style['background-image'] !== 'none') {
        return null;
      }
      if (alphaOf(ancestor.style['background-color']) > 0) {
        return ancestor.style['background-color'];
      }
    }
    return 'rgb(255, 255, 255)';
  }

  // A visible container at rest: border, shadow, image or a fill distinct from what is behind (A3, I1).
  function hasShape(record) {
    const values = record.style;
    if (visibleBorderSides(values).length > 0) {
      return true;
    }
    if (values['box-shadow'] !== 'none' || values['background-image'] !== 'none') {
      return true;
    }
    if (alphaOf(values['background-color']) === 0) {
      return false;
    }
    const behind = backgroundBehind(record);
    return behind === null || behind !== values['background-color'];
  }

  // ---------------------------------------------------------------------------------------------
  // Text and selectors
  // ---------------------------------------------------------------------------------------------

  function collapse(text) {
    return text.replace(/\s+/g, ' ').trim();
  }

  function truncate(text) {
    return text.length > MAX_TEXT_LENGTH ? `${text.slice(0, MAX_TEXT_LENGTH - 1)}…` : text;
  }

  function cssEscape(value) {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
      return CSS.escape(value);
    }
    return value.replace(/[^\w-]/g, (char) => `\\${char}`).replace(/^(\d)/, '\\3$1 ');
  }

  // ---------------------------------------------------------------------------------------------
  // First pass: ids (for unique selectors and label[for] targets)
  // ---------------------------------------------------------------------------------------------

  const idCounts = new Map();
  const idElements = new Map();
  const labelledIds = new Set();
  (function indexIds(element) {
    const id = element.id;
    if (id) {
      idCounts.set(id, (idCounts.get(id) || 0) + 1);
      if (!idElements.has(id)) {
        idElements.set(id, element);
      }
    }
    if (element.tagName.toLowerCase() === 'label' && element.hasAttribute('for')) {
      labelledIds.add(element.getAttribute('for'));
    }
    for (const child of Array.from(element.children)) {
      indexIds(child);
    }
  })(document.documentElement);

  function selectorFor(element, parentSelector, index) {
    const id = element.id;
    if (id && idCounts.get(id) === 1) {
      return `#${cssEscape(id)}`;
    }
    return `${parentSelector} > ${element.tagName.toLowerCase()}:nth-child(${index + 1})`;
  }

  // ---------------------------------------------------------------------------------------------
  // Classification
  // ---------------------------------------------------------------------------------------------

  function isCheckableInput(element) {
    if (!element || element.tagName.toLowerCase() !== 'input') {
      return false;
    }
    const type = (element.getAttribute('type') || '').toLowerCase();
    return type === 'checkbox' || type === 'radio';
  }

  function containsCheckableInput(element) {
    return Array.from(element.children).some((child) => isCheckableInput(child) || containsCheckableInput(child));
  }

  function classify(element, tag) {
    if (tag === 'input') {
      const type = (element.getAttribute('type') || 'text').toLowerCase();
      if (type === 'hidden') {
        return null;
      }
      if (type === 'checkbox' || type === 'radio') {
        return 'checkable';
      }
      if (type === 'range') {
        return 'slider';
      }
      if (type === 'file') {
        return 'file';
      }
      if (BUTTON_INPUT_TYPES.has(type)) {
        return 'button';
      }
      // text, email, password, search, number, date and time types, and any type a browser adds later.
      return 'text-field';
    }
    if (tag === 'textarea') {
      return 'text-field';
    }
    if (tag === 'select') {
      return 'select';
    }
    const role = (element.getAttribute('role') || '').trim().split(/\s+/)[0].toLowerCase();
    if (ROLE_KINDS.has(role)) {
      return ROLE_KINDS.get(role);
    }
    if ((tag === 'a' || tag === 'area') && element.hasAttribute('href')) {
      return 'link';
    }
    if (tag === 'button') {
      return 'button';
    }
    if (tag === 'summary') {
      return 'disclosure';
    }
    if (tag === 'label') {
      const target = element.hasAttribute('for') ? idElements.get(element.getAttribute('for')) : null;
      if (isCheckableInput(target) || containsCheckableInput(element)) {
        return 'label';
      }
    }
    const editable = element.getAttribute('contenteditable');
    if (editable !== null && editable !== 'false') {
      return 'text-field';
    }
    if (element.hasAttribute('onclick')) {
      return 'clickable';
    }
    return null;
  }

  function isDisabled(element, tag, fieldsetDisabled) {
    if (element.getAttribute('aria-disabled') === 'true') {
      return true;
    }
    return FORM_TAGS.has(tag) && (element.hasAttribute('disabled') || fieldsetDisabled);
  }

  // ---------------------------------------------------------------------------------------------
  // :hover rules from the stylesheets
  // ---------------------------------------------------------------------------------------------

  const stylesheets = { read: 0, unreadable: [], unparsedSelectors: 0 };
  const hoverRules = [];

  function splitSelectorList(text) {
    const parts = [];
    let depth = 0;
    let quote = null;
    let current = '';
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (char === '\\') {
        current += char + (text[index + 1] || '');
        index += 1;
        continue;
      }
      if (quote !== null) {
        if (char === quote) {
          quote = null;
        }
        current += char;
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
      } else if (char === '(' || char === '[') {
        depth += 1;
      } else if (char === ')' || char === ']') {
        depth -= 1;
      } else if (char === ',' && depth === 0) {
        parts.push(current.trim());
        current = '';
        continue;
      }
      current += char;
    }
    if (current.trim() !== '') {
      parts.push(current.trim());
    }
    return parts;
  }

  // The selector matched by an element at rest: `.row:hover .actions` becomes `.row .actions`, and a
  // pseudo-element is dropped, its change being a change of the element.
  function stripHover(selector) {
    let pseudoElement = false;
    const withoutPseudoElements = selector.replace(PSEUDO_ELEMENT, () => {
      pseudoElement = true;
      return '';
    });
    const stripped = withoutPseudoElements.replace(HOVER_PSEUDO_CLASS, (match, offset, whole) => {
      const previous = offset === 0 ? '' : whole[offset - 1];
      return previous === '' || /[\s>+~(,]/.test(previous) ? '*' : '';
    });
    return { selector: stripped.trim(), pseudoElement };
  }

  function nestSelector(selectorText, parent) {
    return splitSelectorList(selectorText)
      .map((part) => (part.includes('&') ? part.replace(/&/g, `:is(${parent})`) : `:is(${parent}) ${part}`))
      .join(', ');
  }

  function addHoverRule(selectorText, style) {
    const properties = [];
    for (let index = 0; index < style.length; index += 1) {
      properties.push(style.item(index));
    }
    if (properties.length === 0) {
      return;
    }
    const visual = properties.some((property) => !NON_VISUAL_PREFIXES.some((prefix) => property.startsWith(prefix)));
    const reveals = properties.some((property) => {
      const value = style.getPropertyValue(property).trim();
      return (property === 'opacity' && value !== '0') || (property === 'visibility' && value === 'visible') || (property === 'display' && value !== 'none');
    });
    for (const part of splitSelectorList(selectorText)) {
      if (!HAS_HOVER_PSEUDO_CLASS.test(part)) {
        continue;
      }
      const stripped = stripHover(part);
      hoverRules.push({ source: part, selector: stripped.selector, pseudoElement: stripped.pseudoElement, visual, reveals });
    }
  }

  function mediaMatches(mediaText) {
    return !mediaText || window.matchMedia(mediaText).matches;
  }

  function supportsCondition(conditionText) {
    if (!conditionText || typeof CSS === 'undefined' || typeof CSS.supports !== 'function') {
      return true;
    }
    return CSS.supports(conditionText);
  }

  function visitRules(rules, context) {
    for (const rule of Array.from(rules)) {
      const type = rule.constructor ? rule.constructor.name : '';
      if (type === 'CSSStyleRule') {
        const selector = context === null ? rule.selectorText : nestSelector(rule.selectorText, context);
        addHoverRule(selector, rule.style);
        if (rule.cssRules && rule.cssRules.length > 0) {
          visitRules(rule.cssRules, selector);
        }
      } else if (type === 'CSSNestedDeclarations') {
        if (context !== null) {
          addHoverRule(context, rule.style);
        }
      } else if (type === 'CSSMediaRule') {
        if (mediaMatches(rule.media.mediaText)) {
          visitRules(rule.cssRules, context);
        }
      } else if (type === 'CSSSupportsRule') {
        if (supportsCondition(rule.conditionText)) {
          visitRules(rule.cssRules, context);
        }
      } else if (type === 'CSSContainerRule' || type === 'CSSLayerBlockRule') {
        visitRules(rule.cssRules, context);
      } else if (type === 'CSSImportRule') {
        if (rule.styleSheet) {
          readSheet(rule.styleSheet);
        }
      }
    }
  }

  function readSheet(sheet) {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      // Cross-origin stylesheets refuse access to their rules. They are reported, and the agent hovers
      // the elements they style for real.
      stylesheets.unreadable.push(sheet.href || '(inline)');
      return;
    }
    if (!rules) {
      stylesheets.unreadable.push(sheet.href || '(inline)');
      return;
    }
    stylesheets.read += 1;
    visitRules(rules, null);
  }

  for (const sheet of [...Array.from(document.styleSheets), ...Array.from(document.adoptedStyleSheets || [])]) {
    readSheet(sheet);
  }

  const hoverRulesOf = new Map();
  for (const rule of hoverRules) {
    let matched;
    try {
      matched = document.querySelectorAll(rule.selector);
    } catch {
      // A selector this browser cannot parse once :hover is removed: counted in stylesheets.unparsedSelectors.
      stylesheets.unparsedSelectors += 1;
      continue;
    }
    for (const element of Array.from(matched)) {
      const list = hoverRulesOf.get(element);
      if (list) {
        list.push(rule);
      } else {
        hoverRulesOf.set(element, [rule]);
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Second pass: one record per element
  // ---------------------------------------------------------------------------------------------

  const records = [];
  const recordOf = new Map();
  const bySelector = new Map();
  let shadowHosts = 0;

  function walk(element, selector, parent, context) {
    const tag = element.tagName.toLowerCase();
    if (SKIPPED_TAGS.has(tag)) {
      return false;
    }
    if (element.shadowRoot) {
      shadowHosts += 1;
    }
    const values = snapshot(element);
    const rect = element.getBoundingClientRect();
    let kind = classify(element, tag);
    const draggable = element.getAttribute('draggable') === 'true';
    if (kind === null && draggable) {
      kind = 'draggable';
    }
    const transparent = context.transparent || parseFloat(values.opacity) === 0;
    const record = {
      element,
      selector,
      tag,
      kind,
      draggable,
      parent,
      style: values,
      disabled: kind !== null && isDisabled(element, tag, context.fieldsetDisabled),
      box: {
        x: Math.round(rect.left + window.scrollX),
        y: Math.round(rect.top + window.scrollY),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      rendered: rect.width > 1 && rect.height > 1 && values.visibility !== 'hidden' && !transparent && rect.right + window.scrollX > 0 && rect.bottom + window.scrollY > 0,
      hiddenAtRest: isHidden(values),
      interactiveAncestor: context.interactiveAncestor,
      inLabel: context.inLabel,
      interactiveDescendant: false,
      hasRenderedChild: false,
    };
    records.push(record);
    recordOf.set(element, record);
    bySelector.set(selector, record);
    if (tag !== 'svg') {
      const childContext = {
        fieldsetDisabled: context.fieldsetDisabled || (tag === 'fieldset' && element.hasAttribute('disabled')),
        transparent,
        interactiveAncestor: context.interactiveAncestor || kind !== null,
        inLabel: context.inLabel || tag === 'label',
      };
      Array.from(element.children).forEach((child, index) => {
        if (walk(child, selectorFor(child, selector, index), record, childContext)) {
          record.interactiveDescendant = true;
        }
        const childRecord = recordOf.get(child);
        if (childRecord && childRecord.rendered) {
          record.hasRenderedChild = true;
        }
      });
    }
    return kind !== null || record.interactiveDescendant;
  }

  walk(document.documentElement, 'html', null, { fieldsetDisabled: false, transparent: false, interactiveAncestor: false, inLabel: false });

  // ---------------------------------------------------------------------------------------------
  // Record helpers
  // ---------------------------------------------------------------------------------------------

  function visibleText(element) {
    const own = recordOf.get(element);
    let text = '';
    for (const node of Array.from(element.childNodes)) {
      if (node.nodeType === 3) {
        if (own && own.rendered) {
          text += node.nodeValue;
        }
      } else if (node.nodeType === 1 && recordOf.has(node)) {
        text += ` ${visibleText(node)} `;
      }
    }
    return text;
  }

  // All the text of an inventoried subtree, shown or not: names elements hidden at rest (G5).
  function rawText(element) {
    let text = '';
    for (const node of Array.from(element.childNodes)) {
      if (node.nodeType === 3) {
        text += node.nodeValue;
      } else if (node.nodeType === 1 && recordOf.has(node)) {
        text += ` ${rawText(node)} `;
      }
    }
    return text;
  }

  function textOf(record) {
    if (record.text === undefined) {
      record.text = collapse(visibleText(record.element));
    }
    return record.text;
  }

  function labelInside(element) {
    for (const attribute of ['aria-label', 'title', 'alt']) {
      const value = element.getAttribute(attribute);
      if (value) {
        return `[${attribute}] ${collapse(value)}`;
      }
    }
    for (const child of Array.from(element.children)) {
      const found = labelInside(child);
      if (found) {
        return found;
      }
    }
    return '';
  }

  function nameOf(record) {
    const text = record.rendered ? textOf(record) : collapse(rawText(record.element));
    if (text) {
      return truncate(text);
    }
    for (const attribute of ['placeholder', 'value']) {
      const value = record.element.getAttribute(attribute);
      if (value) {
        return truncate(`[${attribute}] ${collapse(value)}`);
      }
    }
    return truncate(labelInside(record.element));
  }

  function example(record, detail) {
    const result = { selector: record.selector, kind: record.kind, text: nameOf(record), box: record.box };
    if (detail !== undefined) {
      result.detail = detail;
    }
    return result;
  }

  function statesOf(record) {
    if (record.states === undefined) {
      const element = record.element;
      const current = element.getAttribute('aria-current');
      record.states = {
        selected: element.getAttribute('aria-selected') === 'true',
        current: current !== null && current !== 'false',
        pressed: element.getAttribute('aria-pressed') === 'true',
        checked: element.checked === true || element.getAttribute('aria-checked') === 'true',
        expanded: element.getAttribute('aria-expanded'),
        readonly: element.hasAttribute('readonly') || element.getAttribute('aria-readonly') === 'true',
      };
    }
    return record.states;
  }

  function isActive(record) {
    const states = statesOf(record);
    return states.selected || states.current || states.pressed;
  }

  function isInlineInText(record) {
    if (record.style.display !== 'inline' || record.parent === null) {
      return false;
    }
    return Array.from(record.parent.element.childNodes).some((node) => node.nodeType === 3 && node.nodeValue.trim() !== '');
  }

  function isIconOnly(record) {
    return textOf(record) === '' && record.hasRenderedChild;
  }

  function isInside(record, ancestor) {
    for (let current = record.parent; current !== null; current = current.parent) {
      if (current === ancestor) {
        return true;
      }
    }
    return false;
  }

  // Elements of the same kind, without the active state, in the closest ancestor that holds any (G8).
  function peersOf(record) {
    let ancestor = record.parent;
    for (let level = 0; ancestor !== null && level < MAX_PEER_ANCESTORS; level += 1) {
      const scope = ancestor;
      const peers = records.filter((other) => other !== record && other.kind === record.kind && other.rendered && !isActive(other) && isInside(other, scope));
      if (peers.length > 0) {
        return peers;
      }
      ancestor = ancestor.parent;
    }
    return [];
  }

  // Appearance of an item, including its wrapper when the wrapper holds only it (li > a in a nav).
  function itemKey(record) {
    const own = visualKey(record.style, ['cursor']);
    const parent = record.parent;
    if (parent !== null && parent.element.children.length === 1) {
      return `${own}|${visualKey(parent.style, ['cursor'])}`;
    }
    return own;
  }

  function leavesApp(element) {
    if (element.getAttribute('target') === '_blank') {
      return 'opens a new tab';
    }
    let url;
    try {
      url = new URL(element.getAttribute('href'), window.location.href);
    } catch {
      // An href that is not a URL leads nowhere outside the app: nothing to signal for A10.
      return null;
    }
    if ((url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== window.location.origin) {
      return `goes to ${url.origin}`;
    }
    return null;
  }

  function placeholderLikeValue(record) {
    const placeholder = record.element.getAttribute('placeholder');
    if (!placeholder || !placeholder.trim()) {
      return false;
    }
    const style = styleOf(record.element, '::placeholder');
    return style.getPropertyValue('color') === record.style.color && style.getPropertyValue('opacity') === record.style.opacity;
  }

  function needsTargetCheck(record) {
    if (record.kind === 'checkable' && record.tag === 'input' && (record.inLabel || labelledIds.has(record.element.id))) {
      return false;
    }
    return !(record.kind === 'link' && isInlineInText(record));
  }

  function hasStaticHoverAncestor(record) {
    for (let current = record.parent; current !== null; current = current.parent) {
      if (current.staticHover) {
        return true;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------------------------------------
  // Checks
  // ---------------------------------------------------------------------------------------------

  const groups = new Map();
  const realHoverGroups = new Map();

  function addToGroup(map, key, create, record, detail) {
    let group = map.get(key);
    if (!group) {
      group = create();
      map.set(key, group);
    }
    group.count += 1;
    if (group.examples.length < MAX_EXAMPLES) {
      group.examples.push(example(record, detail));
    }
  }

  function flag(check, record, detail) {
    const key = `${check}|${record.kind}|${record.tag}|${visualKey(record.style)}`;
    addToGroup(groups, key, () => ({ check, rule: CHECK_RULES.get(check), kind: record.kind, count: 0, examples: [] }), record, detail);
  }

  function needsRealHover(record) {
    const key = `${record.kind}|${record.tag}|${visualKey(record.style)}`;
    addToGroup(realHoverGroups, key, () => ({ kind: record.kind, count: 0, examples: [] }), record);
  }

  function checkStatic(record, rules) {
    if (record.interactiveAncestor) {
      return;
    }
    const style = record.style;
    if (desktop && style.cursor === 'pointer' && !(record.parent !== null && record.parent.style.cursor === 'pointer')) {
      flag('pointer-on-static', record, 'cursor: pointer on an element with no interactive semantics');
    }
    const visualRule = rules.find((rule) => rule.visual);
    if (desktop && visualRule && !record.interactiveDescendant && !hasStaticHoverAncestor(record)) {
      record.staticHover = true;
      flag('static-hover', record, `hover style from ${visualRule.source}`);
    }
    if ((style['text-decoration-line'] || '').includes('underline') && record.tag !== 'abbr') {
      flag('underline-not-link', record, `text-decoration-line: ${style['text-decoration-line']}`);
    }
  }

  function checkInteractive(record, rules) {
    const { kind, style } = record;
    const visualRule = rules.find((rule) => rule.visual);
    if (desktop) {
      if (record.disabled) {
        if (style.cursor !== 'not-allowed' || style['pointer-events'] === 'none') {
          const detail = style['pointer-events'] === 'none' ? 'pointer-events: none, the cursor of the element below shows' : `cursor: ${style.cursor}, expected not-allowed`;
          flag('disabled-cursor', record, detail);
        }
        if (visualRule) {
          flag('disabled-hover', record, `hover style from ${visualRule.source}`);
        }
      } else if (style['pointer-events'] !== 'none') {
        const expected = record.draggable ? [...EXPECTED_CURSORS.get('draggable'), ...EXPECTED_CURSORS.get(kind)] : EXPECTED_CURSORS.get(kind);
        if (!expected.includes(style.cursor)) {
          flag('cursor-missing', record, `cursor: ${style.cursor}, expected ${[...new Set(expected)].join(' or ')}`);
        }
        if (HOVER_KINDS.has(kind) && !visualRule) {
          needsRealHover(record);
        }
      }
    }
    if (!record.disabled) {
      if (kind === 'button' && !isIconOnly(record) && !hasShape(record)) {
        flag('button-no-shape', record);
      }
      const boxedField = (kind === 'text-field' && (record.tag === 'input' || record.tag === 'textarea')) || (kind === 'select' && record.tag === 'select');
      if (boxedField && !statesOf(record).readonly && !hasShape(record)) {
        flag('field-no-boundary', record);
      }
      if (kind === 'text-field' && placeholderLikeValue(record)) {
        flag('placeholder-like-value', record, `placeholder color ${style.color}, same as the value`);
      }
      if (!desktop && needsTargetCheck(record) && (record.box.width < MIN_TARGET_SIZE || record.box.height < MIN_TARGET_SIZE)) {
        flag('target-size', record, `${record.box.width} × ${record.box.height} px`);
      }
    }
    if (kind === 'link' && record.tag === 'a' && isInlineInText(record) && !isUnderlined(style)) {
      flag('inline-link-no-underline', record);
    }
    if (ICON_KINDS.has(kind) && isIconOnly(record)) {
      flag('icon-only', record);
    }
    if (kind === 'link') {
      const leaves = leavesApp(record.element);
      if (leaves !== null) {
        flag('external-link', record, leaves);
      }
    }
    if (isActive(record)) {
      const peers = peersOf(record);
      const own = itemKey(record);
      if (peers.length > 0 && peers.every((peer) => itemKey(peer) === own)) {
        flag('selected-indistinct', record, `looks like its ${peers.length} unselected peer(s)`);
      }
    }
  }

  for (const record of records) {
    const rules = hoverRulesOf.get(record.element) || [];
    const parentRendered = record.parent === null || record.parent.rendered;
    if (record.hiddenAtRest && parentRendered && (record.kind !== null || record.interactiveDescendant)) {
      const reveal = rules.find((rule) => rule.reveals);
      if (reveal) {
        flag('hover-only', record, `hidden at rest, revealed by ${reveal.source}`);
      }
    }
    if (!record.rendered) {
      continue;
    }
    if (record.kind === null) {
      checkStatic(record, rules);
    } else {
      checkInteractive(record, rules);
    }
  }

  const scrollContainers = [];
  let scrollContainersTruncated = false;
  for (const record of records) {
    if (!record.rendered || record.tag === 'html' || record.tag === 'body') {
      continue;
    }
    const element = record.element;
    const x = SCROLLABLE_OVERFLOWS.has(record.style['overflow-x']) && element.scrollWidth > element.clientWidth + 1;
    const y = SCROLLABLE_OVERFLOWS.has(record.style['overflow-y']) && element.scrollHeight > element.clientHeight + 1;
    if (!x && !y) {
      continue;
    }
    if (scrollContainers.length === MAX_SCROLL_CONTAINERS) {
      scrollContainersTruncated = true;
      break;
    }
    scrollContainers.push({
      selector: record.selector,
      axis: x && y ? 'both' : x ? 'x' : 'y',
      scrollbarHidden: record.style['scrollbar-width'] === 'none',
      box: record.box,
    });
  }

  const counts = {};
  for (const record of records) {
    if (record.rendered && record.kind !== null) {
      counts[record.kind] = (counts[record.kind] || 0) + 1;
    }
  }

  const byRuleThenCount = (a, b) => a.rule.localeCompare(b.rule) || a.check.localeCompare(b.check) || b.count - a.count;

  // ---------------------------------------------------------------------------------------------
  // API kept in the page for the rest of the page load
  // ---------------------------------------------------------------------------------------------

  function requireRecord(selector) {
    if (window.location.href !== pageUrl) {
      throw new Error('The page changed since the inventory: run window.__uiAffordance.inventory({ viewport }) again.');
    }
    const record = bySelector.get(selector);
    if (!record) {
      throw new Error(`${selector} is not in the inventory: use a selector returned by it.`);
    }
    if (record.element.isConnected === false) {
      throw new Error(`${selector} was removed from the page since the inventory: run window.__uiAffordance.inventory({ viewport }) again.`);
    }
    return record;
  }

  window.__uiAffordance = {
    version: VERSION,
    url: pageUrl,
    viewport: options.viewport,
    inventory: uiAffordanceInventory,

    // Call while the browser tool keeps the pointer over the element: computed style changes since
    // the inventory, taken at rest, and the elements hidden at rest that are now visible (G4, G5).
    hover(selector) {
      const record = requireRecord(selector);
      const now = snapshot(record.element);
      const changes = [];
      for (const key of new Set([...Object.keys(record.style), ...Object.keys(now)])) {
        if (record.style[key] !== now[key]) {
          changes.push({ property: key, rest: record.style[key] === undefined ? null : record.style[key], hover: now[key] === undefined ? null : now[key] });
        }
      }
      const revealed = records
        .filter((other) => other.hiddenAtRest && (other.kind !== null || other.interactiveDescendant))
        .filter((other) => {
          const style = styleOf(other.element);
          return !isHidden({ display: style.getPropertyValue('display'), visibility: style.getPropertyValue('visibility'), opacity: style.getPropertyValue('opacity') });
        })
        .map((other) => example(other));
      return { selector, changes, revealed };
    },

    // Rendered, enabled elements grouped by appearance, for one kind or all (G6).
    list(kind) {
      if (kind !== undefined && !EXPECTED_CURSORS.has(kind)) {
        throw new Error(`Unknown kind ${kind}. Kinds: ${[...EXPECTED_CURSORS.keys()].join(', ')}.`);
      }
      const listGroups = new Map();
      for (const record of records) {
        if (!record.rendered || record.kind === null || record.disabled || (kind !== undefined && record.kind !== kind)) {
          continue;
        }
        const key = `${record.kind}|${visualKey(record.style)}`;
        addToGroup(listGroups, key, () => ({ kind: record.kind, count: 0, style: pickVisual(record.style), examples: [] }), record);
      }
      return [...listGroups.values()].sort((a, b) => a.kind.localeCompare(b.kind) || b.count - a.count);
    },

    // Everything known about one element of the inventory.
    get(selector) {
      const record = requireRecord(selector);
      return {
        ...example(record),
        tag: record.tag,
        rendered: record.rendered,
        disabled: record.disabled,
        states: statesOf(record),
        style: record.style,
        hoverRules: (hoverRulesOf.get(record.element) || []).map((rule) => rule.source),
      };
    },
  };

  return {
    version: VERSION,
    url: pageUrl,
    viewport: options.viewport,
    size: { width: window.innerWidth, height: window.innerHeight },
    page: { scrollHeight: document.documentElement.scrollHeight, viewportHeight: window.innerHeight },
    counts,
    checks: [...groups.values()].sort(byRuleThenCount),
    needsRealHover: [...realHoverGroups.values()].sort((a, b) => a.kind.localeCompare(b.kind) || b.count - a.count),
    scrollContainers,
    scrollContainersTruncated,
    stylesheets,
    shadowHosts,
  };
}
