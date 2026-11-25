// Tests for scripts/inventory.mjs, run against fixture repositories built in a temporary directory.
// Run from the repository root: node --test skills/agent-instructions/tests/*.test.mjs

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { LINE_LIMIT, findImports, inventory, isPathLike, parseJustRecipes, parseMakeTargets, parseTaskfileTasks, scanMarkdown } from '../scripts/inventory.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'inventory.mjs');
const HAS_GIT = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;
const temporaryRoots = [];

after(() => {
  for (const root of temporaryRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function repository(files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'agent-instructions-'));
  temporaryRoots.push(root);
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, ...path.split('/'));
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  return root;
}

function git(root, args, input) {
  const result = spawnSync('git', ['-C', root, '-c', 'core.autocrlf=false', ...args], { encoding: 'utf8', input, windowsHide: true });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

function gitRepository(files) {
  const root = repository(files);
  git(root, ['init', '-q']);
  return root;
}

function file(result, path) {
  const found = result.instructionFiles.find((entry) => entry.path === path);
  assert.ok(found, `${path} not in the inventory`);
  return found;
}

function deadTexts(result, path) {
  return file(result, path).deadReferences.map((reference) => reference.text).sort();
}

describe('root case', () => {
  it('is create when no instruction file exists', () => {
    const result = inventory(repository({ 'README.md': '# Project\n' }));
    assert.equal(result.rootCase, 'create');
    assert.deepEqual(result.instructionFiles, []);
    assert.deepEqual(result.maintain, []);
  });

  it('is maintain when AGENTS.md has content', () => {
    const result = inventory(repository({ 'AGENTS.md': '# AGENTS.md\n\nSome content.\n' }));
    assert.equal(result.rootCase, 'maintain');
    assert.deepEqual(result.maintain, ['AGENTS.md']);
    assert.equal(file(result, 'AGENTS.md').type, 'content');
    assert.equal(file(result, 'AGENTS.md').agent, 'agents');
  });

  it('follows CLAUDE.md and GEMINI.md pointers to AGENTS.md', () => {
    const result = inventory(repository({ 'AGENTS.md': '# AGENTS.md\n', 'CLAUDE.md': '@AGENTS.md\n', 'GEMINI.md': '@./AGENTS.md\n' }));
    assert.equal(result.rootCase, 'maintain');
    assert.deepEqual(result.maintain, ['AGENTS.md']);
    for (const path of ['CLAUDE.md', 'GEMINI.md']) {
      const pointer = file(result, path);
      assert.equal(pointer.type, 'pointer');
      assert.equal(pointer.imports.length, 1);
      assert.equal(pointer.imports[0].path, 'AGENTS.md');
      assert.equal(pointer.imports[0].exists, true);
    }
  });

  it('is create when the only file is a pointer to a missing file', () => {
    const result = inventory(repository({ 'CLAUDE.md': '@AGENTS.md\n' }));
    assert.equal(result.rootCase, 'create');
    assert.deepEqual(result.brokenPointers, ['CLAUDE.md']);
    assert.equal(file(result, 'CLAUDE.md').imports[0].exists, false);
  });

  it('maintains a non-instruction file a pointer imports', () => {
    const result = inventory(repository({ 'CLAUDE.md': '@docs/ai.md\n', 'docs/ai.md': '# AI\n' }));
    assert.equal(result.rootCase, 'maintain');
    assert.deepEqual(result.maintain, ['docs/ai.md']);
  });

  it('lists every file that carries its own content', () => {
    const result = inventory(repository({ 'AGENTS.md': '# A\n', 'CLAUDE.md': '# C\n' }));
    assert.deepEqual(result.maintain.sort(), ['AGENTS.md', 'CLAUDE.md']);
  });
});

describe('file types', () => {
  it('reports a pointer with content of its own as an extended pointer', () => {
    const result = inventory(repository({ 'AGENTS.md': '# A\n', 'CLAUDE.md': '@AGENTS.md\n\n## Claude Code\n\n- Use the project hooks.\n' }));
    assert.equal(file(result, 'CLAUDE.md').type, 'extended-pointer');
    assert.deepEqual(result.maintain.sort(), ['AGENTS.md', 'CLAUDE.md']);
  });

  it('ignores imports inside code spans and fenced blocks', () => {
    const result = inventory(repository({ 'CLAUDE.md': 'Write `@AGENTS.md` in it.\n\n```\n@AGENTS.md\n```\n' }));
    const claude = file(result, 'CLAUDE.md');
    assert.equal(claude.type, 'content');
    assert.deepEqual(claude.imports, []);
  });

  it('gives .claude/CLAUDE.md the scope of its parent and resolves its imports from .claude/', () => {
    const result = inventory(repository({ 'AGENTS.md': '# A\n', '.claude/CLAUDE.md': '@../AGENTS.md\n' }));
    const claude = file(result, '.claude/CLAUDE.md');
    assert.equal(claude.scope, '.');
    assert.equal(claude.type, 'pointer');
    assert.equal(claude.imports[0].path, 'AGENTS.md');
    assert.equal(claude.imports[0].exists, true);
  });

  it('scopes nested files to their directory and does not count them for the root case', () => {
    const result = inventory(repository({ 'packages/api/AGENTS.md': '# API\n' }));
    assert.equal(file(result, 'packages/api/AGENTS.md').scope, 'packages/api');
    assert.equal(result.rootCase, 'create');
    assert.deepEqual(result.maintain, ['packages/api/AGENTS.md']);
  });

  it('flags files over the line limit', () => {
    const long = `${Array.from({ length: LINE_LIMIT + 1 }, (_, index) => `- line ${index}`).join('\n')}\n`;
    const result = inventory(repository({ 'AGENTS.md': long, 'CLAUDE.md': '# Short\n' }));
    assert.equal(file(result, 'AGENTS.md').lines, LINE_LIMIT + 1);
    assert.equal(file(result, 'AGENTS.md').overLimit, true);
    assert.equal(file(result, 'CLAUDE.md').overLimit, false);
  });

  it('detects a symlink on disk', (context) => {
    const root = repository({ 'AGENTS.md': '# A\n' });
    try {
      symlinkSync('AGENTS.md', join(root, 'CLAUDE.md'));
    } catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES') {
        context.skip('creating symlinks needs privileges on this system');
        return;
      }
      throw error;
    }
    const result = inventory(root);
    const claude = file(result, 'CLAUDE.md');
    assert.equal(claude.type, 'symlink');
    assert.equal(claude.symlinkTarget.path, 'AGENTS.md');
    assert.deepEqual(result.maintain, ['AGENTS.md']);
  });

  it('detects a git symlink checked out as a text file', { skip: !HAS_GIT }, () => {
    const root = gitRepository({ 'AGENTS.md': '# A\n', 'CLAUDE.md': 'AGENTS.md' });
    const blob = git(root, ['hash-object', '-w', '--stdin'], 'AGENTS.md').trim();
    git(root, ['update-index', '--add', '--cacheinfo', `120000,${blob},CLAUDE.md`]);
    const result = inventory(root);
    const claude = file(result, 'CLAUDE.md');
    assert.equal(claude.type, 'symlink');
    assert.equal(claude.symlinkTarget.path, 'AGENTS.md');
    assert.equal(claude.symlinkTarget.exists, true);
  });
});

describe('dead references', () => {
  const files = {
    'src/index.ts': '',
    '.claude-plugin/marketplace.json': '{}',
    'docs/setup.md': '',
    'package.json': JSON.stringify({ scripts: { build: 'tsc', test: 'vitest' } }),
    'packages/web/package.json': JSON.stringify({ scripts: { storybook: 'storybook dev' } }),
  };

  it('reports missing paths and links, not existing, ambiguous or non-path spans', () => {
    const agents = [
      'Entry point: `src/index.ts`. Removed: `src/old.ts`, `legacy/`.',
      'Catalog: `marketplace.json`. Placeholder: `skills/<name>/SKILL.md`. MIME: `application/json`.',
      'Identifiers: `process.env`, `config.get`. Extension: `.md`. Command: `npm run build`.',
      'See [setup](docs/setup.md), [gone](docs/gone.md#top), [site](https://example.com) and [anchor](#commands).',
      '',
      '[ref]: docs/missing.md',
    ].join('\n');
    const result = inventory(repository({ ...files, 'AGENTS.md': agents }));
    assert.deepEqual(deadTexts(result, 'AGENTS.md'), ['docs/gone.md', 'docs/missing.md', 'legacy/', 'src/old.ts']);
    const kinds = Object.fromEntries(file(result, 'AGENTS.md').deadReferences.map((reference) => [reference.text, reference.kind]));
    assert.equal(kinds['src/old.ts'], 'path');
    assert.equal(kinds['docs/gone.md'], 'link');
  });

  it('reports scripts missing from the nearest manifest and says where else they are declared', () => {
    const agents = ['```bash', 'npm run build', 'pnpm run lint', 'npm test', 'npm start', 'yarn run storybook', '# npm run commented', '```'].join('\n');
    const result = inventory(repository({ ...files, 'AGENTS.md': agents }));
    const dead = file(result, 'AGENTS.md').deadReferences;
    assert.deepEqual(dead.map((reference) => reference.text).sort(), ['npm start', 'pnpm run lint', 'yarn run storybook']);
    const storybook = dead.find((reference) => reference.text === 'yarn run storybook');
    assert.equal(storybook.kind, 'script');
    assert.match(storybook.reason, /no "storybook" in package\.json; declared in packages\/web\/package\.json/);
  });

  it('checks scripts of a nested file against its own manifest', () => {
    const result = inventory(repository({ ...files, 'packages/web/AGENTS.md': 'Run `npm run storybook`, not `npm run build`.\n' }));
    assert.deepEqual(deadTexts(result, 'packages/web/AGENTS.md'), ['npm run build']);
  });

  it('checks make targets only when a Makefile exists', () => {
    const makefile = '.PHONY: build\nbuild:\n\tgo build\n';
    const withMake = inventory(repository({ Makefile: makefile, 'AGENTS.md': '`make build` then `make deploy`.\n' }));
    assert.deepEqual(deadTexts(withMake, 'AGENTS.md'), ['make deploy']);
    const withoutMake = inventory(repository({ 'AGENTS.md': '```\nmake sure it works\n```\n' }));
    assert.deepEqual(deadTexts(withoutMake, 'AGENTS.md'), []);
  });

  it('reports npm scripts when no package.json exists', () => {
    const result = inventory(repository({ 'AGENTS.md': '`npm run build`\n' }));
    const [reference] = file(result, 'AGENTS.md').deadReferences;
    assert.equal(reference.text, 'npm run build');
    assert.match(reference.reason, /no package\.json in \. or above/);
  });

  it('does not report gitignored paths', { skip: !HAS_GIT }, () => {
    const root = gitRepository({ '.gitignore': 'dist/\n.env\n', 'AGENTS.md': 'Build output: `dist/`. Secrets: `.env.local`, `.env`. Gone: `lib/gone.ts`.\n' });
    const result = inventory(root);
    assert.equal(result.git, true);
    assert.deepEqual(deadTexts(result, 'AGENTS.md'), ['.env.local', 'lib/gone.ts']);
  });
});

describe('declared scripts', () => {
  it('reads package.json, composer.json and deno.json scripts', () => {
    const result = inventory(
      repository({
        'package.json': JSON.stringify({ scripts: { dev: 'vite' } }),
        'composer.json': JSON.stringify({ scripts: { test: ['phpunit'] } }),
        'deno.json': JSON.stringify({ tasks: { start: 'deno run main.ts' } }),
      }),
    );
    const byRunner = Object.fromEntries(result.declaredScripts.map((entry) => [entry.runner, entry]));
    assert.deepEqual(byRunner.npm.names, ['dev']);
    assert.deepEqual(byRunner.npm.commands, { dev: 'vite' });
    assert.deepEqual(byRunner.composer.commands, { test: ['phpunit'] });
    assert.deepEqual(byRunner.deno.names, ['start']);
  });

  it('warns on a manifest that does not parse', () => {
    const result = inventory(repository({ 'package.json': '{ not json' }));
    assert.equal(result.declaredScripts.length, 0);
    assert.match(result.warnings.join('\n'), /cannot parse package\.json/);
  });

  it('parses Makefile targets', () => {
    const makefile = [
      'VERSION := 1.0',
      'CC ::= gcc',
      'FLAGS ?= -O2',
      '.PHONY: build test',
      'build test: deps',
      '\techo "not: a target"',
      'deps::',
      'clean:',
      '%.o: %.c',
      '$(OUT): build',
    ].join('\n');
    assert.deepEqual(parseMakeTargets(makefile).sort(), ['build', 'clean', 'deps', 'test']);
  });

  it('parses justfile recipes', () => {
    const justfile = ['set shell := ["bash", "-c"]', 'alias b := build', 'export PORT := "3000"', '[private]', 'build:', '    cargo build', 'test filter="":', '@lint:', '# comment:'].join('\n');
    assert.deepEqual(parseJustRecipes(justfile).sort(), ['build', 'lint', 'test']);
  });

  it('parses Taskfile tasks at the first level under tasks', () => {
    const taskfile = ["version: '3'", 'tasks:', '  build:', '    cmds:', '      - go build', '  "test:unit":', '    cmds: [go test]', '  lint: golangci-lint run', 'vars:', '  other: x'].join('\n');
    assert.deepEqual(parseTaskfileTasks(taskfile), ['build', 'test:unit', 'lint']);
  });
});

describe('sources', () => {
  it('classifies manifests, lockfiles, CI, hooks, env, docs, docker, tool versions and lint configs', () => {
    const result = inventory(
      repository({
        'package.json': JSON.stringify({ packageManager: 'pnpm@9.0.0', engines: { node: '>=22' } }),
        'pnpm-lock.yaml': '',
        'pnpm-workspace.yaml': '',
        'requirements-dev.txt': '',
        '.github/workflows/ci.yml': '',
        '.husky/pre-commit': '',
        '.husky/_/husky.sh': '',
        '.env.example': '',
        '.env.local.example': '',
        'README.md': '',
        'packages/api/README.md': '',
        'docs/guide.md': '',
        'architecture/adr/0001.md': '',
        'Dockerfile.prod': '',
        'docker-compose.yml': '',
        '.nvmrc': '',
        'eslint.config.js': '',
        'tsconfig.json': '',
        Makefile: 'build:\n',
      }),
    );
    const { sources } = result;
    assert.deepEqual(sources.manifests, ['package.json', 'requirements-dev.txt']);
    assert.deepEqual(sources.lockfiles, [{ path: 'pnpm-lock.yaml', packageManager: 'pnpm' }]);
    assert.deepEqual(sources.packageJson, { packageManager: 'pnpm@9.0.0', engines: { node: '>=22' } });
    assert.deepEqual(sources.workspaces, ['pnpm-workspace.yaml']);
    assert.deepEqual(sources.taskRunners, ['Makefile']);
    assert.deepEqual(sources.ci, ['.github/workflows/ci.yml']);
    assert.deepEqual(sources.hooks, ['.husky/pre-commit']);
    assert.deepEqual(sources.env, ['.env.example', '.env.local.example']);
    assert.deepEqual(sources.docs, ['README.md', 'architecture/adr/', 'docs/']);
    assert.deepEqual(sources.docker, ['Dockerfile.prod', 'docker-compose.yml']);
    assert.deepEqual(sources.toolVersions, ['.nvmrc']);
    assert.deepEqual(sources.lintFormat, ['eslint.config.js', 'tsconfig.json']);
  });

  it('reads core.hooksPath and lists the files under it', { skip: !HAS_GIT }, () => {
    const root = gitRepository({ 'tools/hooks/pre-push': '' });
    git(root, ['config', 'core.hooksPath', 'tools/hooks']);
    const result = inventory(root);
    assert.equal(result.sources.hooksPath, 'tools/hooks');
    assert.deepEqual(result.sources.hooks, ['tools/hooks/pre-push']);
  });
});

describe('file listing', () => {
  it('skips third-party and generated directories when walking without git', () => {
    const result = inventory(repository({ 'AGENTS.md': '# A\n', 'node_modules/pkg/AGENTS.md': '# P\n', 'dist/CLAUDE.md': '# D\n', 'vendor/lib/composer.json': '{}' }));
    assert.equal(result.git, false);
    assert.deepEqual(result.instructionFiles.map((entry) => entry.path), ['AGENTS.md']);
    assert.deepEqual(result.sources.manifests, []);
  });

  it('honors .gitignore and lists untracked files in a git repository', { skip: !HAS_GIT }, () => {
    const root = gitRepository({ '.gitignore': 'generated/\n', 'AGENTS.md': '# A\n', 'generated/CLAUDE.md': '# G\n', 'tracked/vendor/x/AGENTS.md': '# V\n' });
    const result = inventory(root);
    assert.equal(result.git, true);
    assert.deepEqual(result.instructionFiles.map((entry) => entry.path), ['AGENTS.md']);
  });
});

describe('helpers', () => {
  it('splits prose from code spans and fenced blocks', () => {
    const scan = scanMarkdown('Run `npm test` now.\n~~~sh\nnpm run build\n~~~\nAfter ``a ` b``.\n');
    assert.deepEqual(
      scan.code.map(({ line, text, fenced }) => [line, text, fenced]),
      [
        [1, 'npm test', false],
        [3, 'npm run build', true],
        [5, 'a ` b', false],
      ],
    );
    assert.deepEqual(scan.prose.map(({ line }) => line), [1, 5, 6]);
  });

  it('finds imports at line start or after whitespace, without trailing punctuation', () => {
    assert.deepEqual(findImports('@AGENTS.md and see @docs/a.md, or mail a@b.com.'), ['AGENTS.md', 'docs/a.md']);
  });

  it('tells paths from other code spans', () => {
    const index = { directoryNames: new Set(['src']) };
    const paths = ['src/a', 'docs/', 'a/b.ts', 'package.json', '.nvmrc', '.env.example', 'Makefile', './scripts/x.sh'];
    const others = ['npm test', 'application/json', 'process.env', '.md', 'node:test', '--flag', '/plugin', '<name>.md', '*.ts', '@scope/pkg', 'v1.2.3'];
    for (const token of paths) {
      assert.equal(isPathLike(token, index), true, token);
    }
    for (const token of others) {
      assert.equal(isPathLike(token, index), false, token);
    }
  });
});

describe('command line', () => {
  it('prints the inventory as JSON', () => {
    const root = repository({ 'AGENTS.md': '# A\n' });
    const result = spawnSync(process.execPath, [SCRIPT, root], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.version, 1);
    assert.equal(output.rootCase, 'maintain');
  });

  it('exits with 1 when the root is not a directory', () => {
    const root = repository({ 'file.txt': '' });
    const result = spawnSync(process.execPath, [SCRIPT, join(root, 'file.txt')], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not a directory/);
  });
});
