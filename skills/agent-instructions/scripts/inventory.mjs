#!/usr/bin/env node
// Inventory for the agent-instructions skill: the agent instruction files of a repository (AGENTS.md,
// CLAUDE.md, .claude/CLAUDE.md and GEMINI.md, at any depth), the references in them that no longer
// resolve, the scripts the repository declares, and the sources an instruction file is checked against.
//
// Usage: node scripts/inventory.mjs [repository-root]
//
// Prints one JSON document on stdout; the root defaults to the current directory. The output is
// described in SKILL.md. The script only reads files and runs read-only git commands (rev-parse,
// ls-files, check-ignore, config --get): it never writes. It exits with 1 and a message on stderr when
// the root is not a directory.

import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const INVENTORY_VERSION = 1;
export const LINE_LIMIT = 200;

const MAX_ENTRIES_PER_CATEGORY = 200;
const MAX_POINTER_HOPS = 5;
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

const INSTRUCTION_FILES = new Map([
  ['AGENTS.md', 'agents'],
  ['CLAUDE.md', 'claude'],
  ['GEMINI.md', 'gemini'],
]);

// Third-party code is skipped even when git tracks it (a committed vendor/ directory); generated
// directories only when the tree is walked without git, since .gitignore usually covers them.
const THIRD_PARTY_DIRECTORIES = new Set(['node_modules', 'vendor', 'bower_components', '.venv', 'venv', 'site-packages']);
const GENERATED_DIRECTORIES = new Set(['.git', 'dist', 'build', 'out', 'target', 'coverage', '__pycache__', '.next', '.nuxt', '.cache', '.turbo', '.gradle', '.idea', '.vscode']);

// Extensions and extensionless file names that make a code span read as a path rather than as an
// identifier (`process.env`, `config.get`) or a word.
const KNOWN_EXTENSIONS = new Set([
  'md', 'mdx', 'mdc', 'txt', 'json', 'jsonc', 'json5', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'xml', 'csv',
  'lock', 'lockb', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'vue', 'svelte', 'astro', 'php', 'py',
  'pyi', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'scala', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'fs', 'sh',
  'bash', 'zsh', 'ps1', 'psm1', 'bat', 'cmd', 'sql', 'prisma', 'graphql', 'gql', 'proto', 'html', 'htm', 'css',
  'scss', 'sass', 'less', 'twig', 'neon', 'dist', 'example', 'sample', 'template', 'tpl', 'gradle', 'csproj',
  'sln', 'fsproj', 'tf', 'tfvars', 'hcl', 'nix', 'dockerfile', 'ex', 'exs', 'erl', 'dart', 'lua', 'pl', 'pm',
  'ipynb', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'pdf', 'zip', 'gz', 'tgz', 'wasm', 'mk', 'just', 'http',
]);
const KNOWN_FILE_NAMES = new Set([
  'Makefile', 'GNUmakefile', 'Dockerfile', 'Containerfile', 'Jenkinsfile', 'Gemfile', 'Procfile', 'Pipfile',
  'Taskfile', 'justfile', 'Justfile', 'Vagrantfile', 'Brewfile', 'LICENSE', 'README', 'CODEOWNERS',
]);
// A code span holding any of these characters is a command, a glob, a placeholder or prose, not a path.
const NON_PATH_CHARACTERS = /[\s*?{}[\]<>|$%=,;'"`\\()!&^~:@#+]/;

const MANIFEST_NAMES = new Set([
  'package.json', 'composer.json', 'pyproject.toml', 'setup.py', 'setup.cfg', 'Pipfile', 'go.mod', 'Cargo.toml',
  'Gemfile', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'mix.exs',
  'deno.json', 'deno.jsonc', 'pubspec.yaml', 'CMakeLists.txt', 'Package.swift', 'environment.yml', 'stack.yaml',
  'dune-project', 'build.sbt', 'project.clj', 'deps.edn', 'rebar.config', 'flake.nix',
]);
const MANIFEST_PATTERN = /(^requirements.*\.txt$)|(\.(csproj|fsproj|vbproj|sln|gemspec|cabal|nimble)$)/;
const LOCKFILES = new Map([
  ['package-lock.json', 'npm'], ['npm-shrinkwrap.json', 'npm'], ['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'], ['bun.lockb', 'bun'], ['deno.lock', 'deno'], ['composer.lock', 'composer'],
  ['poetry.lock', 'poetry'], ['uv.lock', 'uv'], ['Pipfile.lock', 'pipenv'], ['pdm.lock', 'pdm'], ['Cargo.lock', 'cargo'],
  ['go.sum', 'go'], ['Gemfile.lock', 'bundler'], ['mix.lock', 'mix'], ['pubspec.lock', 'pub'],
  ['packages.lock.json', 'nuget'], ['gradle.lockfile', 'gradle'],
]);
const WORKSPACE_NAMES = new Set(['pnpm-workspace.yaml', 'lerna.json', 'nx.json', 'turbo.json', 'rush.json', 'go.work']);
const MAKEFILE_NAMES = ['Makefile', 'makefile', 'GNUmakefile'];
const JUSTFILE_NAMES = ['justfile', 'Justfile', '.justfile'];
const TASKFILE_NAMES = ['Taskfile.yml', 'Taskfile.yaml', 'taskfile.yml', 'taskfile.yaml', 'Taskfile.dist.yml', 'Taskfile.dist.yaml'];
const CI_NAMES = new Set([
  '.gitlab-ci.yml', 'Jenkinsfile', 'azure-pipelines.yml', 'bitbucket-pipelines.yml', '.drone.yml', '.travis.yml',
  '.woodpecker.yml', 'appveyor.yml', 'cloudbuild.yaml', 'codemagic.yaml',
]);
const CI_DIRECTORIES = ['.circleci/', '.woodpecker/', '.buildkite/', '.gitlab/ci/'];
const HOOK_DIRECTORIES = ['.githooks/', '.git-hooks/', '.husky/'];
const HOOK_NAMES = new Set(['lefthook.yml', '.lefthook.yml', 'lefthook.yaml', '.lefthook.yaml', '.pre-commit-config.yaml']);
const TOOL_VERSION_NAMES = new Set([
  '.nvmrc', '.node-version', '.tool-versions', '.python-version', '.ruby-version', 'mise.toml', '.mise.toml',
  'rust-toolchain', 'rust-toolchain.toml', '.sdkmanrc', 'global.json', '.go-version', '.java-version', '.terraform-version',
]);
const LINT_FORMAT_PATTERNS = [
  /^\.editorconfig$/, /^eslint\.config\.[cm]?[jt]s$/, /^\.eslintrc(\..+)?$/, /^\.prettierrc(\..+)?$/,
  /^prettier\.config\.[cm]?[jt]s$/, /^biome\.jsonc?$/, /^\.stylelintrc(\..+)?$/, /^stylelint\.config\.[cm]?[jt]s$/,
  /^tsconfig(\..+)?\.json$/, /^jsconfig\.json$/, /^\.?phpcs\.xml(\.dist)?$/, /^phpstan\.neon(\.dist)?$/,
  /^psalm\.xml(\.dist)?$/, /^pint\.json$/, /^\.php-cs-fixer(\.dist)?\.php$/, /^rector\.php$/, /^\.?ruff\.toml$/,
  /^\.flake8$/, /^\.pylintrc$/, /^\.?mypy\.ini$/, /^\.rubocop\.yml$/, /^\.?rustfmt\.toml$/, /^clippy\.toml$/,
  /^\.golangci\.ya?ml$/, /^\.markdownlint(-cli2)?(\..+)?$/, /^\.commitlintrc(\..+)?$/, /^commitlint\.config\.[cm]?[jt]s$/,
  /^\.lintstagedrc(\..+)?$/, /^lint-staged\.config\.[cm]?[jt]s$/,
];
const ROOT_DOC_PATTERN = /^(README|CONTRIBUTING|ARCHITECTURE|DEVELOPMENT|DEVELOPING|HACKING|SECURITY|STYLEGUIDE)(\.[A-Za-z]+)?$/i;
const DOC_DIRECTORIES = new Set(['docs', 'doc', 'documentation', 'wiki']);
const DECISION_DIRECTORIES = new Set(['adr', 'adrs', 'decisions']);

// Commands whose target can be checked against what the repository declares. `run` is required for
// package managers whose shorthand (`yarn build`) collides with built-in commands.
const COMMAND_PATTERNS = [
  { runner: 'npm', manifest: 'package.json', regex: /(?:^|[\s;&|(])(?:npm|pnpm|yarn|bun)\s+run(?:-script)?\s+([A-Za-z0-9_][\w:.\-]*)/g },
  { runner: 'npm', manifest: 'package.json', regex: /(?:^|[\s;&|(])npm\s+(test|start|stop|restart)(?=$|[\s;&|)])/g },
  { runner: 'composer', manifest: 'composer.json', regex: /(?:^|[\s;&|(])composer\s+run(?:-script)?\s+([A-Za-z0-9_][\w:.\-]*)/g },
  { runner: 'make', manifest: MAKEFILE_NAMES, regex: /(?:^|[\s;&|(])make\s+([A-Za-z0-9_][\w./\-]*)(?=$|[\s;&|)])/g },
  { runner: 'just', manifest: JUSTFILE_NAMES, regex: /(?:^|[\s;&|(])just\s+([A-Za-z_][\w\-]*)(?=$|[\s;&|)])/g },
  { runner: 'task', manifest: TASKFILE_NAMES, regex: /(?:^|[\s;&|(])task\s+([A-Za-z0-9_][\w:.\-]*)(?=$|[\s;&|)])/g },
];

function toPosix(path) {
  return path.split(sep).join('/');
}

function toAbsolute(root, path) {
  return path === '.' ? root : join(root, ...path.split('/'));
}

function byPath(left, right) {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function splitLines(text) {
  return text.replace(/^﻿/, '').split(/\r?\n/);
}

function countLines(text) {
  const lines = splitLines(text);
  return lines.at(-1) === '' ? lines.length - 1 : lines.length;
}

function hasThirdPartySegment(path) {
  return path.split('/').some((segment) => THIRD_PARTY_DIRECTORIES.has(segment));
}

function git(root, args, input) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER, input, windowsHide: true });
  if (result.error || result.status !== 0) {
    return null;
  }
  return result.stdout;
}

// Files git tracks or would track (untracked but not ignored), with their index mode, or null when the
// root is not in a git work tree or git cannot run.
function listGitFiles(root) {
  const inside = git(root, ['rev-parse', '--is-inside-work-tree']);
  if (inside === null || inside.trim() !== 'true') {
    return null;
  }
  const staged = git(root, ['ls-files', '-z', '--stage']);
  const others = git(root, ['ls-files', '-z', '--others', '--exclude-standard']);
  if (staged === null || others === null) {
    return null;
  }
  const modes = new Map();
  for (const record of staged.split('\0')) {
    const tab = record.indexOf('\t');
    if (tab === -1) {
      continue;
    }
    const mode = record.slice(0, tab).split(' ')[0];
    // 160000 is a submodule: a directory of another repository, not a file of this one.
    if (mode !== '160000') {
      modes.set(record.slice(tab + 1), mode);
    }
  }
  for (const path of others.split('\0')) {
    if (path !== '' && !modes.has(path)) {
      modes.set(path, null);
    }
  }
  const entries = [];
  for (const [path, mode] of modes) {
    // Tracked files deleted from the working tree are still in the index.
    if (lstatExists(toAbsolute(root, path))) {
      entries.push({ path, mode });
    }
  }
  return entries;
}

function lstatExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      return false;
    }
    throw error;
  }
}

function walkFiles(root, warnings) {
  const entries = [];
  const pending = ['.'];
  while (pending.length > 0) {
    const directory = pending.pop();
    let dirents;
    try {
      dirents = readdirSync(toAbsolute(root, directory), { withFileTypes: true });
    } catch (error) {
      warnings.push(`cannot read directory ${directory}: ${error.message}`);
      continue;
    }
    for (const dirent of dirents) {
      const path = directory === '.' ? dirent.name : `${directory}/${dirent.name}`;
      if (dirent.isDirectory()) {
        if (!GENERATED_DIRECTORIES.has(dirent.name) && !THIRD_PARTY_DIRECTORIES.has(dirent.name)) {
          pending.push(path);
        }
      } else if (dirent.isFile() || dirent.isSymbolicLink()) {
        entries.push({ path, mode: null });
      }
    }
  }
  return entries;
}

function buildIndex(entries) {
  const files = new Map();
  const directories = new Set();
  const fileNames = new Set();
  const directoryNames = new Set();
  for (const { path, mode } of entries) {
    files.set(path, mode);
    fileNames.add(posix.basename(path));
    let directory = posix.dirname(path);
    while (directory !== '.' && !directories.has(directory)) {
      directories.add(directory);
      directoryNames.add(posix.basename(directory));
      directory = posix.dirname(directory);
    }
  }
  return { files, directories, fileNames, directoryNames };
}

// Splits Markdown into prose (code spans blanked out, so imports and links are read only there) and
// code (inline code spans and the lines of fenced blocks). Line numbers are 1-based.
export function scanMarkdown(text) {
  const prose = [];
  const code = [];
  let fence = null;
  splitLines(text).forEach((raw, index) => {
    const line = index + 1;
    if (fence !== null) {
      const closing = raw.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (closing && closing[1][0] === fence.character && closing[1].length >= fence.length) {
        fence = null;
      } else {
        code.push({ line, text: raw, fenced: true });
      }
      return;
    }
    const opening = raw.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (opening && !(opening[1][0] === '`' && opening[2].includes('`'))) {
      fence = { character: opening[1][0], length: opening[1].length };
      return;
    }
    let text = '';
    let position = 0;
    while (position < raw.length) {
      if (raw[position] !== '`') {
        text += raw[position];
        position += 1;
        continue;
      }
      const run = backtickRunLength(raw, position);
      const closing = findClosingRun(raw, position + run, run);
      if (closing === -1) {
        text += raw.slice(position, position + run);
        position += run;
        continue;
      }
      code.push({ line, text: raw.slice(position + run, closing).trim(), fenced: false });
      text += ' ';
      position = closing + run;
    }
    prose.push({ line, text });
  });
  return { prose, code };
}

function backtickRunLength(text, start) {
  let length = 0;
  while (text[start + length] === '`') {
    length += 1;
  }
  return length;
}

function findClosingRun(text, start, length) {
  let position = start;
  while (position < text.length) {
    if (text[position] !== '`') {
      position += 1;
      continue;
    }
    const run = backtickRunLength(text, position);
    if (run === length) {
      return position;
    }
    position += run;
  }
  return -1;
}

// `@path` imports, as Claude Code and Gemini CLI read them: in prose only, at the start of a line or
// after whitespace. Trailing punctuation belongs to the sentence, not to the path.
export function findImports(text) {
  const imports = [];
  for (const match of text.matchAll(/(?:^|\s)@(\S+)/g)) {
    const path = match[1].replace(/[.,;:!?)\]}>"']+$/, '');
    if (path !== '') {
      imports.push(path);
    }
  }
  return imports;
}

function resolveReference(root, baseDirectory, raw) {
  let absolute;
  if (raw.startsWith('~/')) {
    absolute = join(homedir(), raw.slice(2));
  } else if (isAbsolute(raw)) {
    absolute = raw;
  } else {
    absolute = resolve(toAbsolute(root, baseDirectory), ...raw.split(/[\\/]/));
  }
  const fromRoot = relative(root, absolute);
  const inside = !fromRoot.startsWith('..') && !isAbsolute(fromRoot);
  return {
    path: inside ? (fromRoot === '' ? '.' : toPosix(fromRoot)) : toPosix(absolute),
    external: !inside,
    exists: existsSync(absolute),
  };
}

function hasKnownExtension(name) {
  const match = name.match(/\.([A-Za-z0-9]+)$/);
  return match !== null && name.length > match[0].length && KNOWN_EXTENSIONS.has(match[1].toLowerCase());
}

// Whether a code span reads as a path to check. Conservative: a missed dead path costs less than a
// false one, since the agent verifies every reported reference anyway.
export function isPathLike(token, index) {
  if (token === '' || token.startsWith('-') || token.startsWith('/') || NON_PATH_CHARACTERS.test(token)) {
    return false;
  }
  const clean = token.replace(/^\.\//, '');
  const trailingSlash = clean.endsWith('/');
  const segments = clean.replace(/\/+$/, '').split('/');
  if (segments.some((segment) => segment === '')) {
    return false;
  }
  const last = segments.at(-1);
  if (segments.length > 1 || trailingSlash) {
    return trailingSlash || hasKnownExtension(last) || KNOWN_FILE_NAMES.has(last) || index.directoryNames.has(segments[0]);
  }
  if (/^\.[A-Za-z0-9]+$/.test(last)) {
    // `.md` names an extension, `.nvmrc` a file.
    return !KNOWN_EXTENSIONS.has(last.slice(1).toLowerCase());
  }
  return hasKnownExtension(last) || KNOWN_FILE_NAMES.has(last) || (last.startsWith('.') && last.length > 1);
}

function joinedCandidates(token, bases) {
  const clean = token.replace(/^\.\//, '').replace(/\/+$/, '');
  return [...new Set(bases.map((base) => posix.normalize(base === '.' ? clean : `${base}/${clean}`)))];
}

function referenceResolves(root, token, bases, index) {
  const clean = token.replace(/^\.\//, '').replace(/\/+$/, '');
  for (const candidate of joinedCandidates(token, bases)) {
    if (index.files.has(candidate) || index.directories.has(candidate) || existsSync(resolve(root, ...candidate.split('/')))) {
      return true;
    }
  }
  // A path cited from another base (`scripts/checks.mjs` for `.github/scripts/checks.mjs`) or a bare
  // file name is ambiguous, not dead.
  if (clean.includes('/')) {
    const suffix = `/${clean}`;
    for (const path of index.files.keys()) {
      if (path.endsWith(suffix)) {
        return true;
      }
    }
    for (const directory of index.directories) {
      if (directory.endsWith(suffix)) {
        return true;
      }
    }
    return false;
  }
  return index.fileNames.has(clean) || index.directoryNames.has(clean);
}

function cleanLinkTarget(target) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) {
    return null;
  }
  const withoutFragment = target.replace(/[#?].*$/, '');
  if (withoutFragment === '') {
    return null;
  }
  try {
    return decodeURIComponent(withoutFragment);
  } catch {
    // A malformed escape is kept as written: the raw target is still the path to check.
    return withoutFragment;
  }
}

function pathCandidates(scan, index) {
  const candidates = [];
  for (const span of scan.code) {
    if (!span.fenced && isPathLike(span.text, index)) {
      candidates.push({ line: span.line, text: span.text, kind: 'path' });
    }
  }
  for (const { line, text } of scan.prose) {
    for (const match of text.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+["'(][^)]*)?\)/g)) {
      const target = cleanLinkTarget(match[1]);
      if (target !== null) {
        candidates.push({ line, text: target, kind: 'link' });
      }
    }
    const definition = text.match(/^\s{0,3}\[[^\]]+\]:\s*<?([^\s>]+)>?/);
    if (definition) {
      const target = cleanLinkTarget(definition[1]);
      if (target !== null) {
        candidates.push({ line, text: target, kind: 'link' });
      }
    }
  }
  return candidates;
}

function nearestFile(index, scope, names) {
  let directory = scope;
  for (;;) {
    for (const name of names) {
      const candidate = directory === '.' ? name : `${directory}/${name}`;
      if (index.files.has(candidate)) {
        return candidate;
      }
    }
    if (directory === '.') {
      return null;
    }
    directory = posix.dirname(directory);
  }
}

function commandReferences(root, scan, scope, index, declared) {
  const dead = [];
  // make, just and task are also English words: they are checked only where the runner is in use.
  const patterns = COMMAND_PATTERNS.filter(
    (pattern) => !Array.isArray(pattern.manifest) || pattern.manifest.some((name) => index.fileNames.has(name)),
  );
  for (const { line, text } of scan.code) {
    const trimmed = text.trim();
    if (trimmed.startsWith('#') || trimmed.startsWith('//') || trimmed.startsWith('<!--')) {
      continue;
    }
    for (const pattern of patterns) {
      const manifestNames = Array.isArray(pattern.manifest) ? pattern.manifest : [pattern.manifest];
      for (const match of trimmed.matchAll(pattern.regex)) {
        const name = match[1];
        const command = match[0].replace(/^[\s;&|(]+/, '');
        const manifest = nearestFile(index, scope, manifestNames);
        if (manifest === null) {
          dead.push({ line, text: command, kind: 'script', reason: `no ${manifestNames[0]} in ${scope} or above` });
          continue;
        }
        const names = declared.get(manifest)?.names ?? [];
        if (names.includes(name) || (pattern.runner === 'npm' && referenceResolves(root, name, [scope, '.'], index))) {
          continue;
        }
        const alsoIn = [...declared.entries()]
          .filter(([path, entry]) => path !== manifest && manifestNames.includes(posix.basename(path)) && entry.names.includes(name))
          .map(([path]) => path);
        const reason = `no "${name}" in ${manifest}${alsoIn.length > 0 ? `; declared in ${alsoIn.join(', ')}` : ''}`;
        dead.push({ line, text: command, kind: 'script', reason });
      }
    }
  }
  return dead;
}

function ignoredByGit(root, paths) {
  if (paths.length === 0) {
    return new Set();
  }
  const result = spawnSync('git', ['-C', root, 'check-ignore', '--stdin', '-z'], {
    encoding: 'utf8',
    input: `${paths.join('\0')}\0`,
    maxBuffer: GIT_MAX_BUFFER,
    windowsHide: true,
  });
  // check-ignore exits with 1 when no path is ignored.
  if (result.error || (result.status !== 0 && result.status !== 1)) {
    return null;
  }
  return new Set(result.stdout.split('\0').filter((path) => path !== ''));
}

function deadReferences(root, file, scan, index, declared, usesGit, warnings) {
  const bases = [...new Set([file.scope, posix.dirname(file.path), '.'])];
  const unresolved = pathCandidates(scan, index).filter((candidate) => !referenceResolves(root, candidate.text, bases, index));
  let dead = unresolved;
  if (usesGit && unresolved.length > 0) {
    // A gitignored path (`.env`, `dist/`) is generated or local: absent from a fresh clone, not dead.
    const variants = unresolved.flatMap((candidate) => joinedCandidates(candidate.text, bases).flatMap((path) => [path, `${path}/`]));
    const ignored = ignoredByGit(root, variants.filter((path) => !path.startsWith('..')));
    if (ignored === null) {
      warnings.push(`git check-ignore failed: gitignored paths in ${file.path} may be reported as dead`);
    } else {
      dead = unresolved.filter((candidate) => !joinedCandidates(candidate.text, bases).some((path) => ignored.has(path) || ignored.has(`${path}/`)));
    }
  }
  const all = [...dead, ...commandReferences(root, scan, file.scope, index, declared)];
  const seen = new Set();
  return all
    .filter((reference) => {
      const key = `${reference.line}\0${reference.kind}\0${reference.text}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .sort((left, right) => left.line - right.line);
}

function isInstructionPath(path) {
  return INSTRUCTION_FILES.has(posix.basename(path));
}

function describeInstructionFile(root, entry, index, declared, usesGit, warnings) {
  const { path, mode } = entry;
  const name = posix.basename(path);
  const directory = posix.dirname(path);
  const scope = name === 'CLAUDE.md' && posix.basename(directory) === '.claude' ? posix.dirname(directory) : directory;
  const file = {
    path,
    agent: INSTRUCTION_FILES.get(name),
    scope,
    type: 'content',
    lines: 0,
    overLimit: false,
    imports: [],
    symlinkTarget: null,
    deadReferences: [],
  };
  const absolute = toAbsolute(root, path);
  const isLink = lstatSync(absolute).isSymbolicLink();
  // Mode 120000 without a link on disk: git checked the symlink out as a text file holding its target
  // (Windows without symlink support).
  if (isLink || mode === '120000') {
    let target;
    try {
      target = isLink ? readlinkSync(absolute) : readFileSync(absolute, 'utf8').trim();
    } catch (error) {
      warnings.push(`cannot read link ${path}: ${error.message}`);
      file.type = 'unreadable';
      return file;
    }
    file.type = 'symlink';
    file.symlinkTarget = resolveReference(root, directory, toPosix(target));
    return file;
  }
  let text;
  try {
    text = readFileSync(absolute, 'utf8');
  } catch (error) {
    warnings.push(`cannot read ${path}: ${error.message}`);
    file.type = 'unreadable';
    return file;
  }
  const scan = scanMarkdown(text);
  file.lines = countLines(text);
  file.overLimit = file.lines > LINE_LIMIT;
  file.imports = scan.prose.flatMap(({ line, text: prose }) =>
    findImports(prose).map((raw) => ({ line, raw: `@${raw}`, ...resolveReference(root, directory, raw) })),
  );
  const nonBlank = splitLines(text).filter((line) => line.trim() !== '');
  const importsOnly = nonBlank.length > 0 && nonBlank.every((line) => /^\s*@\S+\s*$/.test(line)) && file.imports.length === nonBlank.length;
  if (importsOnly) {
    file.type = 'pointer';
    return file;
  }
  if (file.imports.some((reference) => !reference.external && isInstructionPath(reference.path))) {
    file.type = 'extended-pointer';
  }
  file.deadReferences = deadReferences(root, file, scan, index, declared, usesGit, warnings);
  return file;
}

// The files whose content a file stands for: itself when it has content of its own, the targets of its
// imports or of its link otherwise, followed through other pointers.
function contentSources(file, byPath, hops = 0) {
  if (file.type === 'content' || file.type === 'extended-pointer') {
    return [file.path];
  }
  if (hops >= MAX_POINTER_HOPS) {
    return [];
  }
  const targets = file.type === 'symlink' ? [file.symlinkTarget] : file.type === 'pointer' ? file.imports : [];
  return targets
    .filter((target) => target !== null && target.exists && !target.external)
    .flatMap((target) => {
      const described = byPath.get(target.path);
      return described === undefined ? [target.path] : contentSources(described, byPath, hops + 1);
    });
}

export function parseMakeTargets(text) {
  const targets = new Set();
  for (const line of splitLines(text)) {
    if (line.startsWith('\t')) {
      continue;
    }
    // `::?(?![:=])` keeps `a:` and `a::` rules and rejects `:=` and `::=` assignments.
    const match = line.match(/^([A-Za-z0-9_][\w./\-]*(?:[ \t]+[A-Za-z0-9_][\w./\-]*)*)[ \t]*::?(?![:=])/);
    if (match) {
      for (const target of match[1].split(/[ \t]+/)) {
        targets.add(target);
      }
    }
  }
  return [...targets];
}

export function parseJustRecipes(text) {
  const recipes = new Set();
  for (const line of splitLines(text)) {
    // Parameters may hold `=` defaults; `:=` marks a `set`, `alias` or variable line, not a recipe.
    const match = line.match(/^@?([A-Za-z_][\w\-]*)(?:[ \t]+[^:\n]*)?:(?!=)/);
    if (match) {
      recipes.add(match[1]);
    }
  }
  return [...recipes];
}

export function parseTaskfileTasks(text) {
  const lines = splitLines(text);
  const start = lines.findIndex((line) => /^tasks:\s*(#.*)?$/.test(line));
  if (start === -1) {
    return [];
  }
  const tasks = [];
  let indent = null;
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '' || line.trim().startsWith('#')) {
      continue;
    }
    if (/^\S/.test(line)) {
      break;
    }
    const lineIndent = line.match(/^ */)[0].length;
    indent ??= lineIndent;
    if (lineIndent !== indent) {
      continue;
    }
    // A quoted key may hold a colon (`"test:unit":`), a bare one may not.
    const match = line.match(/^ +(?:"([^"]+)"|'([^']+)'|([^\s#:"']+)):(?:\s|$)/);
    if (match) {
      tasks.push(match[1] ?? match[2] ?? match[3]);
    }
  }
  return tasks;
}

function readJson(root, path, warnings) {
  try {
    return JSON.parse(readFileSync(toAbsolute(root, path), 'utf8').replace(/^﻿/, ''));
  } catch (error) {
    warnings.push(`cannot parse ${path}: ${error.message}`);
    return null;
  }
}

function readText(root, path, warnings) {
  try {
    return readFileSync(toAbsolute(root, path), 'utf8');
  } catch (error) {
    warnings.push(`cannot read ${path}: ${error.message}`);
    return null;
  }
}

function scriptObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function collectDeclaredScripts(root, index, warnings) {
  const declared = new Map();
  for (const path of [...index.files.keys()].sort()) {
    const name = posix.basename(path);
    if (name === 'package.json' || name === 'composer.json') {
      const manifest = readJson(root, path, warnings);
      if (manifest !== null) {
        const commands = scriptObject(manifest.scripts);
        declared.set(path, { source: path, runner: name === 'package.json' ? 'npm' : 'composer', names: Object.keys(commands), commands });
      }
    } else if (name === 'deno.json') {
      const manifest = readJson(root, path, warnings);
      if (manifest !== null) {
        const commands = scriptObject(manifest.tasks);
        declared.set(path, { source: path, runner: 'deno', names: Object.keys(commands), commands });
      }
    } else if (MAKEFILE_NAMES.includes(name) || JUSTFILE_NAMES.includes(name) || TASKFILE_NAMES.includes(name)) {
      const text = readText(root, path, warnings);
      if (text !== null) {
        const [runner, names] = MAKEFILE_NAMES.includes(name)
          ? ['make', parseMakeTargets(text)]
          : JUSTFILE_NAMES.includes(name)
            ? ['just', parseJustRecipes(text)]
            : ['task', parseTaskfileTasks(text)];
        declared.set(path, { source: path, runner, names });
      }
    }
  }
  return declared;
}

function isEnvExample(name) {
  return (
    ['example.env', 'env.example', 'sample.env'].includes(name) ||
    (name.startsWith('.env.') && /(^|\.)(example|sample|dist|template|defaults)(\.|$)/.test(name.slice(5)))
  );
}

function collectSources(root, index, usesGit, warnings) {
  const sources = {
    manifests: [],
    lockfiles: [],
    packageJson: null,
    workspaces: [],
    taskRunners: [],
    ci: [],
    hooks: [],
    hooksPath: null,
    env: [],
    docs: [],
    docker: [],
    toolVersions: [],
    lintFormat: [],
  };
  if (usesGit) {
    const hooksPath = git(root, ['config', '--get', 'core.hooksPath']);
    sources.hooksPath = hooksPath === null ? null : hooksPath.trim();
  }
  const hookDirectories = sources.hooksPath ? [...HOOK_DIRECTORIES, `${sources.hooksPath.replace(/\/+$/, '')}/`] : HOOK_DIRECTORIES;
  for (const path of [...index.files.keys()].sort()) {
    const name = posix.basename(path);
    const atRoot = !path.includes('/');
    if (MANIFEST_NAMES.has(name) || MANIFEST_PATTERN.test(name)) {
      sources.manifests.push(path);
    }
    if (LOCKFILES.has(name)) {
      sources.lockfiles.push({ path, packageManager: LOCKFILES.get(name) });
    }
    if (WORKSPACE_NAMES.has(name)) {
      sources.workspaces.push(path);
    }
    if (MAKEFILE_NAMES.includes(name) || JUSTFILE_NAMES.includes(name) || TASKFILE_NAMES.includes(name)) {
      sources.taskRunners.push(path);
    }
    if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(path) || CI_NAMES.has(name) || CI_DIRECTORIES.some((prefix) => path.startsWith(prefix))) {
      sources.ci.push(path);
    }
    if ((hookDirectories.some((prefix) => path.startsWith(prefix)) && !path.startsWith('.husky/_/')) || HOOK_NAMES.has(name)) {
      sources.hooks.push(path);
    }
    if (isEnvExample(name)) {
      sources.env.push(path);
    }
    if (atRoot && ROOT_DOC_PATTERN.test(name)) {
      sources.docs.push(path);
    }
    if (/^Dockerfile(\..+)?$/.test(name) || /\.Dockerfile$/.test(name) || /^(docker-)?compose(\..+)?\.ya?ml$/.test(name) || name === '.dockerignore') {
      sources.docker.push(path);
    }
    if (TOOL_VERSION_NAMES.has(name)) {
      sources.toolVersions.push(path);
    }
    if (LINT_FORMAT_PATTERNS.some((pattern) => pattern.test(name))) {
      sources.lintFormat.push(path);
    }
  }
  for (const directory of [...index.directories].sort()) {
    const name = posix.basename(directory);
    if ((!directory.includes('/') && DOC_DIRECTORIES.has(name)) || DECISION_DIRECTORIES.has(name)) {
      sources.docs.push(`${directory}/`);
    }
    if (directory === '.devcontainer') {
      sources.docker.push(`${directory}/`);
    }
  }
  if (index.files.has('package.json')) {
    const manifest = readJson(root, 'package.json', warnings);
    if (manifest !== null) {
      const fields = Object.fromEntries(['packageManager', 'engines', 'workspaces'].filter((key) => key in manifest).map((key) => [key, manifest[key]]));
      sources.packageJson = Object.keys(fields).length > 0 ? fields : null;
    }
  }
  const truncated = {};
  for (const [category, value] of Object.entries(sources)) {
    if (Array.isArray(value) && value.length > MAX_ENTRIES_PER_CATEGORY) {
      truncated[category] = value.length;
      sources[category] = value.slice(0, MAX_ENTRIES_PER_CATEGORY);
    }
  }
  if (Object.keys(truncated).length > 0) {
    sources.truncated = truncated;
  }
  return sources;
}

export function inventory(rootArgument = process.cwd()) {
  const root = resolve(rootArgument);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`not a directory: ${root}`);
  }
  const warnings = [];
  const gitEntries = listGitFiles(root);
  const usesGit = gitEntries !== null;
  if (!usesGit && existsSync(join(root, '.git'))) {
    warnings.push('git could not list this repository: files were listed by walking the tree, without .gitignore');
  }
  const entries = (usesGit ? gitEntries : walkFiles(root, warnings)).filter((entry) => !hasThirdPartySegment(entry.path)).sort(byPath);
  const index = buildIndex(entries);
  const declared = collectDeclaredScripts(root, index, warnings);

  const instructionFiles = entries
    .filter((entry) => isInstructionPath(entry.path))
    .map((entry) => describeInstructionFile(root, entry, index, declared, usesGit, warnings))
    .sort((left, right) => left.scope.split('/').length - right.scope.split('/').length || (left.path < right.path ? -1 : 1));
  const byPathMap = new Map(instructionFiles.map((file) => [file.path, file]));

  const maintain = [];
  const brokenPointers = [];
  for (const file of instructionFiles) {
    const sources = contentSources(file, byPathMap);
    if (sources.length === 0 && (file.type === 'pointer' || file.type === 'symlink')) {
      brokenPointers.push(file.path);
    }
    for (const source of sources) {
      if (!maintain.includes(source)) {
        maintain.push(source);
      }
    }
  }
  const rootHasContent = instructionFiles.some((file) => file.scope === '.' && contentSources(file, byPathMap).length > 0);

  return {
    version: INVENTORY_VERSION,
    root: toPosix(root),
    git: usesGit,
    rootCase: rootHasContent ? 'maintain' : 'create',
    maintain,
    brokenPointers,
    instructionFiles,
    declaredScripts: [...declared.values()],
    sources: collectSources(root, index, usesGit, warnings),
    warnings,
  };
}

function isMainModule() {
  if (!process.argv[1]) {
    return false;
  }
  const self = fileURLToPath(import.meta.url);
  const invoked = resolve(process.argv[1]);
  return process.platform === 'win32' ? self.toLowerCase() === invoked.toLowerCase() : self === invoked;
}

if (isMainModule()) {
  try {
    process.stdout.write(`${JSON.stringify(inventory(process.argv[2] ?? process.cwd()), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`inventory: ${error.message}\n`);
    process.exitCode = 1;
  }
}
