// Tests for tests/lib/catalog.mjs, run against the real repository and against fixture repositories.
// Usage: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATALOG_PATH, parseFrontmatter, validateRepo } from './lib/catalog.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function skillFile(name, extraFrontmatter = '', body = 'Instructions.\n') {
  return `---\nname: ${name}\ndescription: Does ${name} things.\n${extraFrontmatter}---\n\n${body}`;
}

function validCatalog() {
  return {
    name: 'marketplace-a',
    owner: { name: 'test' },
    plugins: [
      { name: 'plugin-a', source: './', skills: ['./skills/skill-a', './skills/skill-b/'] },
      { name: 'plugin-b', source: './', skills: ['./skills/skill-c'] },
    ],
  };
}

function validFiles() {
  return {
    'skills/skill-a/SKILL.md': skillFile('skill-a'),
    'skills/skill-a/references/details.md': '# Details\n',
    'skills/skill-b/SKILL.md': skillFile('skill-b'),
    'skills/skill-c/SKILL.md': skillFile('skill-c'),
    'template/SKILL.md.example': skillFile('skill-name'),
  };
}

// Builds a repository in a temporary directory. `catalog` is serialized unless it is a string;
// null leaves marketplace.json out. A file mapped to null is left out.
function withRepo({ catalog = validCatalog(), files = {} } = {}, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ai-skills-catalog-'));
  try {
    const all = { ...validFiles(), ...files };
    if (catalog !== null) {
      all[CATALOG_PATH] = typeof catalog === 'string' ? catalog : JSON.stringify(catalog);
    }
    for (const [path, content] of Object.entries(all)) {
      if (content === null) {
        continue;
      }
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Asserts that the repository yields exactly one error per pattern, in order.
function assertErrors(spec, patterns) {
  withRepo(spec, (dir) => {
    const errors = validateRepo(dir);
    assert.equal(errors.length, patterns.length, `unexpected errors:\n${errors.join('\n')}`);
    patterns.forEach((pattern, index) => assert.match(errors[index], pattern));
  });
}

function catalogWith(change) {
  const catalog = validCatalog();
  change(catalog);
  return catalog;
}

test('repository: the real catalog is valid', () => {
  assert.deepEqual(validateRepo(root), []);
});

test('fixture: a valid repository has no errors', () => {
  assertErrors({}, []);
});

test('fixture: a catalog starting with a BOM is accepted', () => {
  assertErrors({ catalog: `﻿${JSON.stringify(validCatalog())}` }, []);
});

const catalogCases = [
  ['missing catalog', { catalog: null }, [/marketplace\.json is missing/]],
  ['invalid JSON', { catalog: '{ "plugins": ' }, [/marketplace\.json is not valid JSON/]],
  [
    'no plugins',
    { catalog: catalogWith((c) => (c.plugins = [])) },
    [/declares no plugins/, /skills\/skill-a is not listed/, /skills\/skill-b is not listed/, /skills\/skill-c is not listed/],
  ],
  [
    'plugins not an array',
    { catalog: catalogWith((c) => (c.plugins = {})) },
    [/declares no plugins/, /skills\/skill-a is not listed/, /skills\/skill-b is not listed/, /skills\/skill-c is not listed/],
  ],
  ['invalid plugin name', { catalog: catalogWith((c) => (c.plugins[1].name = 'Plugin B')) }, [/invalid plugin name "Plugin B"/]],
  ['duplicate plugin name', { catalog: catalogWith((c) => (c.plugins[1].name = 'plugin-a')) }, [/plugin "plugin-a": declared twice/]],
  ['source other than ./', { catalog: catalogWith((c) => (c.plugins[1].source = './skills')) }, [/plugin "plugin-b": "source" must be "\.\/"/]],
  [
    'plugin without skills',
    { catalog: catalogWith((c) => delete c.plugins[1].skills) },
    [/plugin "plugin-b": no "skills" array/, /skills\/skill-c is not listed/],
  ],
  [
    'empty skills array',
    { catalog: catalogWith((c) => (c.plugins[1].skills = [])) },
    [/plugin "plugin-b": no "skills" array/, /skills\/skill-c is not listed/],
  ],
  [
    'skill path outside ./skills',
    { catalog: catalogWith((c) => (c.plugins[1].skills = ['skills/skill-c'])) },
    [/skill path "skills\/skill-c" is not of the form/, /skills\/skill-c is not listed/],
  ],
  ['non-string skill path', { catalog: catalogWith((c) => c.plugins[1].skills.push(42)) }, [/skill path 42 is not of the form/]],
  ['invalid skill name', { catalog: catalogWith((c) => c.plugins[1].skills.push('./skills/Skill_D')) }, [/invalid skill name "Skill_D"/]],
  [
    'skill listed by two plugins',
    { catalog: catalogWith((c) => c.plugins[1].skills.push('./skills/skill-a')) },
    [/skill "skill-a" is listed by plugin "plugin-a" and plugin "plugin-b", it must belong to exactly one plugin/],
  ],
  [
    'skill listed twice by the same plugin',
    { catalog: catalogWith((c) => c.plugins[0].skills.push('./skills/skill-a')) },
    [/skill "skill-a" is listed by plugin "plugin-a" and plugin "plugin-a"/],
  ],
  ['listed skill without SKILL.md', { catalog: catalogWith((c) => c.plugins[1].skills.push('./skills/skill-d')) }, [/skills\/skill-d\/SKILL\.md is missing/]],
];

for (const [label, spec, patterns] of catalogCases) {
  test(`catalog: ${label}`, () => assertErrors(spec, patterns));
}

test('skills directory: unlisted skill directory', () => {
  assertErrors({ files: { 'skills/skill-z/SKILL.md': skillFile('skill-z') } }, [/skills\/skill-z is not listed by any plugin/]);
});

test('skills directory: file at the root of skills/', () => {
  assertErrors({ files: { 'skills/README.md': '# Skills\n' } }, [/skills\/README\.md is not a skill directory/]);
});

test('discovery: SKILL.md outside skills/<name>/ is rejected, SKILL.md.example is not', () => {
  assertErrors(
    {
      files: {
        'template/SKILL.md': skillFile('template'),
        'skills/skill-a/references/SKILL.md': skillFile('nested'),
        'docs/skill.md': skillFile('lowercase'),
      },
    },
    [/^docs\/skill\.md: only skills\/<name>\/SKILL\.md may exist/, /^skills\/skill-a\/references\/SKILL\.md: only/, /^template\/SKILL\.md: only/],
  );
});

const skillCases = [
  ['name does not match the directory', skillFile('skill-x'), [/skills\/skill-a\/SKILL\.md: name "skill-x" does not match its directory "skill-a"/]],
  ['no name', '---\ndescription: Does things.\n---\n', [/skills\/skill-a\/SKILL\.md: no "name" field/]],
  ['no description', '---\nname: skill-a\n---\n', [/skills\/skill-a\/SKILL\.md: no "description" field/]],
  ['empty description', '---\nname: skill-a\ndescription:\n---\n', [/no "description" field/]],
  ['description too long', `---\nname: skill-a\ndescription: ${'x'.repeat(1025)}\n---\n`, [/description is 1025 characters, max 1024/]],
  ['description at the limit', `---\nname: skill-a\ndescription: ${'x'.repeat(1024)}\n---\n`, []],
  ['non-standard field', skillFile('skill-a', 'disable-model-invocation: true\n'), [/non-standard frontmatter field "disable-model-invocation"/]],
  [
    'every standard field',
    skillFile('skill-a', 'license: MIT\ncompatibility: Requires git\nmetadata:\n  author: someone\n  version: "1.0"\nallowed-tools: Read\n'),
    [],
  ],
  // skillFile() writes 5 lines before the body.
  ['500 lines', skillFile('skill-a', '', 'line\n'.repeat(495)), [/skills\/skill-a\/SKILL\.md: 500 lines, must stay under 500/]],
  ['499 lines', skillFile('skill-a', '', 'line\n'.repeat(494)), []],
  ['no frontmatter', '# Skill\n', [/frontmatter does not start with a "---" frontmatter line/]],
  ['unclosed frontmatter', '---\nname: skill-a\n', [/frontmatter has no closing "---" frontmatter line/]],
  ['duplicate field', '---\nname: skill-a\nname: skill-a\ndescription: Does things.\n---\n', [/field "name" is declared twice/]],
  ['line that is not key: value', '---\nname: skill-a\n- item\ndescription: Does things.\n---\n', [/line 3 is not a "key: value" line/]],
  ['unquoted ": " in a value', '---\nname: skill-a\ndescription: Use when: anything\n---\n', [/field "description" \(line 3\) contains ": " or " #" and must be quoted/]],
  ['quoted ": " in a value', '---\nname: skill-a\ndescription: "Use when: anything"\n---\n', []],
  ['quoted value spanning lines', '---\nname: skill-a\ndescription: "Use\n  when"\n---\n', [/is a quoted value that does not end on the same line/]],
  ['folded block description', '---\nname: skill-a\ndescription: >-\n  Does things\n  and more: things.\n---\n', []],
  ['CRLF line endings', skillFile('skill-a').replace(/\n/g, '\r\n'), []],
  ['BOM', `﻿${skillFile('skill-a')}`, []],
];

for (const [label, content, patterns] of skillCases) {
  test(`skill: ${label}`, () => assertErrors({ files: { 'skills/skill-a/SKILL.md': content } }, patterns));
}

test('parseFrontmatter: scalar, quoted, block and nested values', () => {
  const fields = parseFrontmatter(
    [
      '---',
      '# comment',
      'name: skill-a',
      "license: 'MIT'",
      'description: >',
      '  First line',
      '',
      '  second line.',
      'compatibility: |',
      '  Line one',
      '  Line two',
      'metadata:',
      '  author: someone',
      'allowed-tools: Read',
      '  Grep',
      '---',
      'Body: not frontmatter',
    ].join('\n'),
  );
  assert.deepEqual(
    fields,
    new Map([
      ['name', 'skill-a'],
      ['license', 'MIT'],
      ['description', 'First line second line.'],
      ['compatibility', 'Line one\nLine two'],
      ['metadata', null],
      ['allowed-tools', 'Read Grep'],
    ]),
  );
});
