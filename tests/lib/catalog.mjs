// Catalog validation for this repository, used by tests/catalog.test.mjs.
//
// validateRepo(root) returns the list of problems found (empty when the repository is valid):
// - .claude-plugin/marketplace.json declares a non-empty "plugins" array; every plugin has a valid,
//   unique name, "source": "./" and a non-empty "skills" array of "./skills/<name>" paths;
// - every skill belongs to exactly one plugin;
// - every listed skill has a skills/<name>/SKILL.md that is under 500 lines, whose frontmatter uses
//   standard Agent Skills fields only, with "name" equal to the directory name, a non-empty
//   "description" of at most 1024 characters and, when present, a "compatibility" string of 1 to
//   500 characters;
// - every entry of skills/ is a directory listed by a plugin;
// - no other SKILL.md exists in the repository: `npx skills` scans the whole repository, so any
//   other SKILL.md would be offered to users as an installable skill.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const NAME_MAX_LENGTH = 64;
const DESCRIPTION_MAX_LENGTH = 1024;
const COMPATIBILITY_MAX_LENGTH = 500;
const SKILL_MAX_LINES = 500;
const STANDARD_FIELDS = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);
const SKILL_PATH = /^\.\/skills\/([^/]+)\/?$/;
const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules']);

export const CATALOG_PATH = '.claude-plugin/marketplace.json';

function isValidName(name) {
  return typeof name === 'string' && name.length <= NAME_MAX_LENGTH && NAME.test(name);
}

function stripBom(text) {
  // Files edited on Windows may start with a BOM, which JSON.parse and the frontmatter delimiter check reject.
  return text.replace(/^﻿/, '');
}

// readdirSync order depends on the file system; sorting keeps error messages in a stable order.
function readSortedDirectory(path) {
  return readdirSync(path, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function splitLines(text) {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') {
    lines.pop();
  }
  return lines;
}

// Minimal parser for the YAML subset used in SKILL.md frontmatter: top-level `key: value` lines,
// quoted single-line values (quotes stripped, escapes left as is), block scalars (`>` or `|`, with an
// optional chomping indicator), plain values continued on indented lines, and nested mappings or
// lists (kept as non-scalar). Anything outside that subset throws instead of being guessed.
// Returns a Map of field name to string value, or to null for a nested mapping or list.
export function parseFrontmatter(text) {
  const lines = splitLines(stripBom(text));
  if (lines[0] !== '---') {
    throw new Error('does not start with a "---" frontmatter line');
  }
  const end = lines.indexOf('---', 1);
  if (end === -1) {
    throw new Error('has no closing "---" frontmatter line');
  }

  const entries = new Map();
  let current = null;
  for (const [index, line] of lines.slice(1, end).entries()) {
    const lineNumber = index + 2;
    if (line.trim() === '') {
      current?.continuation.push('');
      continue;
    }
    if (line.startsWith('#')) {
      continue;
    }
    if (/^\s/.test(line)) {
      if (!current) {
        throw new Error(`line ${lineNumber} is indented but follows no field`);
      }
      current.continuation.push(line.trim());
      continue;
    }
    const field = line.match(/^([A-Za-z0-9_-]+):(?:[ \t]+(.*?))?[ \t]*$/);
    if (!field) {
      throw new Error(`line ${lineNumber} is not a "key: value" line`);
    }
    const [, key, inline = ''] = field;
    if (entries.has(key)) {
      throw new Error(`field "${key}" is declared twice`);
    }
    current = { inline, continuation: [], lineNumber };
    entries.set(key, current);
  }

  const fields = new Map();
  for (const [key, { inline, continuation, lineNumber }] of entries) {
    fields.set(key, resolveValue(key, inline, continuation, lineNumber));
  }
  return fields;
}

function resolveValue(key, inline, continuation, lineNumber) {
  const content = continuation.slice();
  while (content.at(-1) === '') {
    content.pop();
  }
  const block = inline.match(/^([>|])[+-]?$/);
  if (block) {
    return block[1] === '|' ? content.join('\n') : content.filter((part) => part !== '').join(' ');
  }
  const quote = inline[0];
  if (quote === '"' || quote === "'") {
    if (inline.length < 2 || inline.at(-1) !== quote || content.length > 0) {
      throw new Error(`field "${key}" (line ${lineNumber}) is a quoted value that does not end on the same line`);
    }
    return inline.slice(1, -1);
  }
  if (inline === '') {
    return content.length > 0 ? null : '';
  }
  const value = [inline, ...content.filter((part) => part !== '')].join(' ');
  // Strict YAML parsers reject these in a plain value, so some agents would fail to load the skill.
  if (value.includes(': ') || value.includes(' #')) {
    throw new Error(`field "${key}" (line ${lineNumber}) contains ": " or " #" and must be quoted`);
  }
  return value;
}

function readCatalog(root, errors) {
  const path = join(root, CATALOG_PATH);
  if (!existsSync(path)) {
    errors.push(`${CATALOG_PATH} is missing`);
    return null;
  }
  try {
    return JSON.parse(stripBom(readFileSync(path, 'utf8')));
  } catch (error) {
    errors.push(`${CATALOG_PATH} is not valid JSON: ${error.message}`);
    return null;
  }
}

// Returns a Map of listed skill name to the label of the plugin that lists it.
function validateCatalog(catalog, errors) {
  const owners = new Map();
  if (!Array.isArray(catalog?.plugins) || catalog.plugins.length === 0) {
    errors.push(`${CATALOG_PATH} declares no plugins`);
    return owners;
  }

  const pluginNames = new Set();
  catalog.plugins.forEach((plugin, index) => {
    const label = typeof plugin?.name === 'string' ? `plugin "${plugin.name}"` : `plugin #${index}`;
    if (!isValidName(plugin?.name)) {
      errors.push(`${label}: invalid plugin name ${JSON.stringify(plugin?.name)}`);
    } else if (pluginNames.has(plugin.name)) {
      errors.push(`${label}: declared twice`);
    } else {
      pluginNames.add(plugin.name);
    }
    if (plugin?.source !== './') {
      errors.push(`${label}: "source" must be "./", got ${JSON.stringify(plugin?.source)}`);
    }
    if (!Array.isArray(plugin?.skills) || plugin.skills.length === 0) {
      errors.push(`${label}: no "skills" array`);
      return;
    }
    for (const path of plugin.skills) {
      const match = typeof path === 'string' ? SKILL_PATH.exec(path) : null;
      if (!match) {
        errors.push(`${label}: skill path ${JSON.stringify(path)} is not of the form "./skills/<name>"`);
        continue;
      }
      const name = match[1];
      if (!isValidName(name)) {
        errors.push(`${label}: invalid skill name ${JSON.stringify(name)}`);
        continue;
      }
      if (owners.has(name)) {
        errors.push(`skill "${name}" is listed by ${owners.get(name)} and ${label}, it must belong to exactly one plugin`);
        continue;
      }
      owners.set(name, label);
    }
  });
  return owners;
}

function validateSkill(root, name, errors) {
  const path = `skills/${name}/SKILL.md`;
  const file = join(root, 'skills', name, 'SKILL.md');
  if (!existsSync(file)) {
    errors.push(`${path} is missing`);
    return;
  }
  const text = readFileSync(file, 'utf8');

  const lineCount = splitLines(text).length;
  if (lineCount >= SKILL_MAX_LINES) {
    errors.push(`${path}: ${lineCount} lines, must stay under ${SKILL_MAX_LINES}`);
  }

  let fields;
  try {
    fields = parseFrontmatter(text);
  } catch (error) {
    errors.push(`${path}: frontmatter ${error.message}`);
    return;
  }
  for (const key of fields.keys()) {
    if (!STANDARD_FIELDS.has(key)) {
      errors.push(`${path}: non-standard frontmatter field "${key}"`);
    }
  }

  const frontmatterName = fields.get('name');
  if (typeof frontmatterName !== 'string' || frontmatterName === '') {
    errors.push(`${path}: no "name" field`);
  } else if (frontmatterName !== name) {
    errors.push(`${path}: name "${frontmatterName}" does not match its directory "${name}"`);
  }

  const description = fields.get('description');
  if (typeof description !== 'string' || description === '') {
    errors.push(`${path}: no "description" field`);
  } else if (description.length > DESCRIPTION_MAX_LENGTH) {
    errors.push(`${path}: description is ${description.length} characters, max ${DESCRIPTION_MAX_LENGTH}`);
  }

  if (fields.has('compatibility')) {
    const compatibility = fields.get('compatibility');
    if (typeof compatibility !== 'string') {
      errors.push(`${path}: compatibility must be a string, not a nested mapping or list`);
    } else if (compatibility === '') {
      errors.push(`${path}: compatibility is empty, remove it or give it 1 to ${COMPATIBILITY_MAX_LENGTH} characters`);
    } else if (compatibility.length > COMPATIBILITY_MAX_LENGTH) {
      errors.push(`${path}: compatibility is ${compatibility.length} characters, max ${COMPATIBILITY_MAX_LENGTH}`);
    }
  }
}

function validateSkillsDirectory(root, owners, errors) {
  const directory = join(root, 'skills');
  if (!existsSync(directory)) {
    return;
  }
  for (const entry of readSortedDirectory(directory)) {
    if (!entry.isDirectory()) {
      errors.push(`skills/${entry.name} is not a skill directory`);
    } else if (!owners.has(entry.name)) {
      errors.push(`skills/${entry.name} is not listed by any plugin`);
    }
  }
}

function findSkillFiles(root, relativeDirectory = '') {
  const found = [];
  for (const entry of readSortedDirectory(join(root, relativeDirectory))) {
    const relativePath = relativeDirectory === '' ? entry.name : `${relativeDirectory}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) {
        found.push(...findSkillFiles(root, relativePath));
      }
    } else if (entry.name.toLowerCase() === 'skill.md') {
      found.push(relativePath);
    }
  }
  return found;
}

function validateDiscoverableFiles(root, errors) {
  for (const path of findSkillFiles(root)) {
    if (!/^skills\/[^/]+\/SKILL\.md$/.test(path)) {
      errors.push(`${path}: only skills/<name>/SKILL.md may exist, npx skills would offer this file as a skill`);
    }
  }
}

export function validateRepo(root) {
  const errors = [];
  const catalog = readCatalog(root, errors);
  if (catalog !== null) {
    const owners = validateCatalog(catalog, errors);
    for (const name of owners.keys()) {
      validateSkill(root, name, errors);
    }
    validateSkillsDirectory(root, owners, errors);
  }
  validateDiscoverableFiles(root, errors);
  return errors;
}
