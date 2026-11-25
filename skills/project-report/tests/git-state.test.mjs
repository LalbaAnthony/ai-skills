// Tests for scripts/git-state.mjs, run against repositories built in a temporary directory, with git
// isolated from the user's configuration.
// Run from the repository root: node --test skills/project-report/tests/*.test.mjs

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { describeRemoteUrl, gitState, parseArguments, parseNameStatus, parseNumstat, parseStatus } from '../scripts/git-state.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'git-state.mjs');
const HAS_GIT = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;
const sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), 'project-report-')));

// No global or system configuration (signing, hooks, autocrlf, credential helpers), a fixed identity, and
// no repository lookup above the sandbox.
const emptyConfig = join(sandbox, 'gitconfig');
writeFileSync(emptyConfig, '');
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: emptyConfig,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CEILING_DIRECTORIES: sandbox,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
});

after(() => {
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 5 });
});

const OFFLINE = { fetch: false };

function git(cwd, args, env = {}) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env } });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

let directoryCount = 0;
function directory(name) {
  directoryCount += 1;
  const path = join(sandbox, `${name}-${directoryCount}`);
  mkdirSync(path);
  return path;
}

function write(root, files) {
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, ...path.split('/'));
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
}

function repository() {
  const root = directory('repo');
  git(root, ['init', '-q', '-b', 'main']);
  return root;
}

let clock = Date.UTC(2026, 0, 1);
function commit(root, message, files = {}, date = undefined) {
  write(root, files);
  git(root, ['add', '-A']);
  clock += 3_600_000;
  const when = date ?? new Date(clock).toISOString();
  git(root, ['commit', '-q', '--allow-empty', '-m', message], { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when });
}

function paths(list) {
  return list.items.map((item) => item.path);
}

// main: init, second; feat/login: add login, rework (a.txt modified, old.txt renamed to new.txt).
function featureRepository() {
  const root = repository();
  commit(root, 'init', { 'a.txt': 'one\n', 'old.txt': 'line\n'.repeat(10) });
  commit(root, 'second', { 'b.txt': 'b\n' });
  git(root, ['checkout', '-q', '-b', 'feat/login']);
  commit(root, 'add login', { 'login.txt': 'l1\nl2\n' });
  git(root, ['mv', 'old.txt', 'new.txt']);
  commit(root, 'rework', { 'a.txt': 'one\ntwo\n' });
  return root;
}

describe('parseArguments', () => {
  it('defaults to fetching the current directory', () => {
    assert.deepEqual(parseArguments([]), { path: undefined, base: undefined, since: undefined, fetch: true });
  });

  it('reads the path and the options in both forms', () => {
    assert.deepEqual(parseArguments(['repo', '--base', 'v1.0.0', '--no-fetch']), { path: 'repo', base: 'v1.0.0', since: undefined, fetch: false });
    assert.equal(parseArguments(['--since=2026-01-15']).since, '2026-01-15');
  });

  it('rejects invalid combinations and values', () => {
    assert.throws(() => parseArguments(['--base', 'main', '--since', '2026-01-01']), /cannot be used together/);
    assert.throws(() => parseArguments(['--base']), /needs a value/);
    assert.throws(() => parseArguments(['--base', '--no-fetch']), /must not start with "-"/);
    assert.throws(() => parseArguments(['--base', 'a', '--base', 'b']), /given twice/);
    assert.throws(() => parseArguments(['--verbose']), /unknown option/);
    assert.throws(() => parseArguments(['one', 'two']), /unexpected argument/);
  });
});

describe('describeRemoteUrl', () => {
  it('removes credentials from an https URL', () => {
    const remote = describeRemoteUrl('https://user:s3cret@gitlab.example.com/group/sub/project.git');
    assert.deepEqual(remote, { url: 'https://gitlab.example.com/group/sub/project.git', host: 'gitlab.example.com', platform: 'gitlab', project: 'group/sub/project' });
  });

  it('reads scp-like and ssh URLs', () => {
    assert.deepEqual(describeRemoteUrl('git@github.com:owner/repo.git'), { url: 'git@github.com:owner/repo.git', host: 'github.com', platform: 'github', project: 'owner/repo' });
    const ssh = describeRemoteUrl('ssh://git@bitbucket.org:2222/team/repo.git');
    assert.equal(ssh.host, 'bitbucket.org');
    assert.equal(ssh.platform, 'bitbucket');
    assert.equal(ssh.project, 'team/repo');
    assert.ok(!ssh.url.includes('git@'));
  });

  it('recognizes Azure DevOps and leaves unknown hosts without platform', () => {
    const azure = describeRemoteUrl('https://org@dev.azure.com/org/project/_git/repo');
    assert.equal(azure.platform, 'azure-devops');
    assert.equal(azure.url, 'https://dev.azure.com/org/project/_git/repo');
    assert.deepEqual(describeRemoteUrl('https://git.example.com/team/repo'), { url: 'https://git.example.com/team/repo', host: 'git.example.com', platform: null, project: 'team/repo' });
  });

  it('treats local paths as having no host', () => {
    for (const url of ['C:\\repos\\remote.git', '/srv/git/remote.git', '../remote.git', 'file:///srv/git/remote.git']) {
      assert.deepEqual(describeRemoteUrl(url), { url, host: null, platform: null, project: null }, url);
    }
  });
});

describe('output parsers', () => {
  it('parses name-status output with renames', () => {
    assert.deepEqual(parseNameStatus('M\0a.txt\0R087\0old.txt\0new.txt\0A\0b.txt\0'), [
      { status: 'M', previousPath: null, path: 'a.txt' },
      { status: 'R', previousPath: 'old.txt', path: 'new.txt' },
      { status: 'A', previousPath: null, path: 'b.txt' },
    ]);
  });

  it('parses numstat output with renames and binary files', () => {
    const stats = parseNumstat('1\t2\ta.txt\0' + '3\t0\t\0old.txt\0new.txt\0' + '-\t-\tbin.png\0');
    assert.deepEqual(Object.fromEntries(stats), {
      'a.txt': { additions: 1, deletions: 2 },
      'new.txt': { additions: 3, deletions: 0 },
      'bin.png': { additions: null, deletions: null },
    });
  });

  it('classifies status entries', () => {
    const status = parseStatus('M  staged.txt\0 M edited.txt\0R  new.txt\0old.txt\0?? notes/\0UU conflict.txt\0MM both.txt\0');
    assert.deepEqual(status, {
      staged: [
        { path: 'staged.txt', status: 'M', previousPath: null },
        { path: 'new.txt', status: 'R', previousPath: 'old.txt' },
        { path: 'both.txt', status: 'M', previousPath: null },
      ],
      unstaged: [
        { path: 'edited.txt', status: 'M' },
        { path: 'both.txt', status: 'M' },
      ],
      untracked: ['notes/'],
      conflicted: ['conflict.txt'],
    });
  });
});

describe('gitState', { skip: !HAS_GIT && 'git is not installed' }, () => {
  it('throws when the path is not a directory', () => {
    assert.throws(() => gitState(join(sandbox, 'missing')), /not a directory/);
  });

  it('reports no repository outside git', () => {
    const state = gitState(directory('plain'), OFFLINE);
    assert.equal(state.gitAvailable, true);
    assert.equal(state.repository, null);
    assert.equal(state.head, null);
    assert.equal(state.base.status, 'no-repository');
    assert.equal(state.workingTree, null);
  });

  it('handles a repository without commits', () => {
    const root = repository();
    write(root, { 'a.txt': 'a\n' });
    const state = gitState(root, OFFLINE);
    assert.equal(state.head.commit, null);
    assert.equal(state.head.branch, 'main');
    assert.equal(state.base.status, 'no-commit');
    assert.equal(state.commits, null);
    assert.equal(state.tags, null);
    assert.deepEqual(state.workingTree.untracked.items, ['a.txt']);
    assert.ok(state.warnings.includes('HEAD has no commit yet'));
  });

  it('reports the commits and changes of a feature branch since main', () => {
    const state = gitState(featureRepository(), OFFLINE);
    assert.equal(state.head.branch, 'feat/login');
    assert.equal(state.head.detached, false);
    assert.equal(state.head.subject, 'rework');
    assert.deepEqual({ status: state.base.status, ref: state.base.ref, source: state.base.source, containedIn: state.base.containedIn }, { status: 'resolved', ref: 'main', source: 'detected', containedIn: [] });
    assert.equal(state.commits.total, 2);
    assert.equal(state.commits.truncated, false);
    assert.deepEqual(state.commits.items.map((item) => item.subject), ['rework', 'add login']);
    assert.equal(state.commits.items[0].author, 'Test');
    assert.equal(state.commits.items[0].merge, false);
    assert.deepEqual(state.changes.items, [
      { status: 'M', previousPath: null, path: 'a.txt', additions: 1, deletions: 0 },
      { status: 'A', previousPath: null, path: 'login.txt', additions: 2, deletions: 0 },
      { status: 'R', previousPath: 'old.txt', path: 'new.txt', additions: 0, deletions: 0 },
    ].sort((left, right) => (left.path < right.path ? -1 : 1)));
    assert.equal(state.changes.additions, 3);
    assert.equal(state.workingTree.clean, true);
    assert.equal(state.upstream, null);
    assert.equal(state.remote, null);
    assert.equal(state.fetch.attempted, false);
  });

  it('picks the closest base branch', () => {
    const root = repository();
    commit(root, 'init', { 'a.txt': 'a\n' });
    git(root, ['checkout', '-q', '-b', 'develop']);
    commit(root, 'develop work', { 'b.txt': 'b\n' });
    git(root, ['checkout', '-q', '-b', 'feat/x']);
    commit(root, 'feature work', { 'c.txt': 'c\n' });
    const state = gitState(root, OFFLINE);
    assert.equal(state.base.ref, 'develop');
    assert.equal(state.commits.total, 1);
    assert.deepEqual(paths(state.changes), ['c.txt']);
  });

  it('cannot infer the period on a base branch, and takes it from --base', () => {
    const root = repository();
    commit(root, 'one', { 'a.txt': '1\n' });
    git(root, ['tag', 'v1.0.0']);
    commit(root, 'two', { 'a.txt': '2\n' });
    commit(root, 'three', { 'a.txt': '3\n' });
    const inferred = gitState(root, OFFLINE);
    assert.equal(inferred.base.status, 'on-base-branch');
    assert.equal(inferred.commits, null);
    assert.equal(inferred.changes, null);
    assert.deepEqual(inferred.tags.atHead, []);
    assert.equal(inferred.tags.latest.name, 'v1.0.0');
    assert.equal(inferred.tags.latest.commitsSince, 2);

    const explicit = gitState(root, { ...OFFLINE, base: 'v1.0.0' });
    assert.equal(explicit.base.status, 'resolved');
    assert.equal(explicit.base.source, 'option');
    assert.equal(explicit.base.ref, 'v1.0.0');
    assert.equal(explicit.commits.total, 2);
    assert.deepEqual(paths(explicit.changes), ['a.txt']);

    git(root, ['tag', 'v1.1.0']);
    assert.deepEqual(gitState(root, OFFLINE).tags.atHead, ['v1.1.0']);
  });

  it('rejects an unknown --base revision', () => {
    const root = repository();
    commit(root, 'one');
    assert.throws(() => gitState(root, { ...OFFLINE, base: 'does-not-exist' }), /unknown revision/);
  });

  it('takes the period from --since', () => {
    const root = repository();
    commit(root, 'january', { 'a.txt': '1\n' }, '2026-01-01T10:00:00Z');
    commit(root, 'february', { 'b.txt': '2\n' }, '2026-02-01T10:00:00Z');
    commit(root, 'march', { 'c.txt': '3\n' }, '2026-03-01T10:00:00Z');
    const since = gitState(root, { ...OFFLINE, since: '2026-01-15' });
    assert.equal(since.base.status, 'resolved');
    assert.equal(since.base.source, 'since');
    assert.equal(since.base.since, '2026-01-15');
    assert.deepEqual(since.commits.items.map((item) => item.subject), ['march', 'february']);
    assert.deepEqual(paths(since.changes), ['b.txt', 'c.txt']);

    const everything = gitState(root, { ...OFFLINE, since: '2025-12-01' });
    assert.equal(everything.base.commit, null);
    assert.equal(everything.commits.total, 3);
    assert.deepEqual(everything.changes.items.map((item) => item.status), ['A', 'A', 'A']);
  });

  it('lists the base branches that already contain HEAD', () => {
    const root = repository();
    commit(root, 'init', { 'a.txt': 'a\n' });
    git(root, ['checkout', '-q', '-b', 'feat/merged']);
    commit(root, 'feature', { 'b.txt': 'b\n' });
    git(root, ['checkout', '-q', 'main']);
    git(root, ['merge', '-q', '--ff-only', 'feat/merged']);
    commit(root, 'after merge', { 'c.txt': 'c\n' });
    git(root, ['checkout', '-q', 'feat/merged']);
    const state = gitState(root, OFFLINE);
    assert.equal(state.base.status, 'resolved');
    assert.equal(state.base.ref, 'main');
    assert.deepEqual(state.base.containedIn, ['main']);
    assert.equal(state.commits.total, 0);
  });

  it('describes the working tree', () => {
    const root = repository();
    commit(root, 'init', { 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n', 'd.txt': 'd\n' });
    write(root, { 'd.txt': 'stashed\n' });
    git(root, ['stash', '-q']);
    write(root, { 'a.txt': 'staged\n' });
    git(root, ['add', 'a.txt']);
    git(root, ['mv', 'c.txt', 'e.txt']);
    write(root, { 'b.txt': 'unstaged\n', 'f.txt': 'new\n' });
    const tree = gitState(root, OFFLINE).workingTree;
    assert.equal(tree.clean, false);
    assert.deepEqual(tree.staged.items, [
      { path: 'a.txt', status: 'M', previousPath: null },
      { path: 'e.txt', status: 'R', previousPath: 'c.txt' },
    ]);
    assert.deepEqual(tree.unstaged.items, [{ path: 'b.txt', status: 'M' }]);
    assert.deepEqual(tree.untracked.items, ['f.txt']);
    assert.equal(tree.conflicted.total, 0);
    assert.equal(tree.stashes, 1);
    assert.equal(tree.operation, null);
  });

  it('reports conflicts and the merge in progress', () => {
    const root = repository();
    commit(root, 'init', { 'a.txt': 'base\n' });
    git(root, ['checkout', '-q', '-b', 'other']);
    commit(root, 'other side', { 'a.txt': 'other\n' });
    git(root, ['checkout', '-q', 'main']);
    commit(root, 'main side', { 'a.txt': 'main\n' });
    const merge = spawnSync('git', ['-C', root, 'merge', '-q', 'other'], { encoding: 'utf8', windowsHide: true });
    assert.notEqual(merge.status, 0, 'the merge was expected to conflict');
    const tree = gitState(root, OFFLINE).workingTree;
    assert.deepEqual(tree.conflicted.items, ['a.txt']);
    assert.equal(tree.operation, 'merge');
  });

  it('reports a detached HEAD', () => {
    const root = featureRepository();
    git(root, ['checkout', '-q', '--detach']);
    const state = gitState(root, OFFLINE);
    assert.equal(state.head.branch, null);
    assert.equal(state.head.detached, true);
    assert.equal(state.base.ref, 'main');
  });

  it('caps the lists it returns', () => {
    const state = gitState(featureRepository(), { ...OFFLINE, limits: { commits: 1, changes: 1 } });
    assert.deepEqual({ total: state.commits.total, truncated: state.commits.truncated, length: state.commits.items.length }, { total: 2, truncated: true, length: 1 });
    assert.deepEqual({ total: state.changes.total, truncated: state.changes.truncated, length: state.changes.items.length }, { total: 3, truncated: true, length: 1 });
  });
});

describe('gitState with a remote', { skip: !HAS_GIT && 'git is not installed' }, () => {
  // A bare remote with main, a working clone on feat pushed with an upstream, and a second clone that
  // pushes one more commit to feat, which the working clone only sees after a fetch.
  function remoteSetup() {
    const source = repository();
    commit(source, 'init', { 'a.txt': 'a\n' });
    const remote = join(directory('remote'), 'remote.git');
    git(sandbox, ['clone', '-q', '--bare', source, remote]);
    const work = join(directory('work'), 'work');
    git(sandbox, ['clone', '-q', remote, work]);
    git(work, ['checkout', '-q', '-b', 'feat']);
    commit(work, 'feature', { 'b.txt': 'b\n' });
    git(work, ['push', '-q', '-u', 'origin', 'feat']);
    const other = join(directory('other'), 'other');
    git(sandbox, ['clone', '-q', remote, other]);
    git(other, ['checkout', '-q', 'feat']);
    commit(other, 'from a colleague', { 'c.txt': 'c\n' });
    git(other, ['push', '-q', 'origin', 'feat']);
    return { work };
  }

  it('reads the upstream and the remote base without fetching', () => {
    const { work } = remoteSetup();
    const state = gitState(work, OFFLINE);
    assert.deepEqual(state.fetch, { attempted: false, remote: 'origin', ok: null, error: null, lastFetch: state.fetch.lastFetch });
    assert.deepEqual(state.upstream, { ref: 'origin/feat', tracking: true, ahead: 0, behind: 0 });
    assert.equal(state.base.ref, 'origin/main');
    assert.equal(state.remote.name, 'origin');
    assert.equal(state.remote.host, null);
    assert.equal(state.commits.total, 1);
  });

  it('fetches before comparing with the upstream', () => {
    const { work } = remoteSetup();
    const state = gitState(work);
    assert.equal(state.fetch.attempted, true);
    assert.equal(state.fetch.ok, true);
    assert.equal(state.fetch.error, null);
    assert.equal(typeof state.fetch.lastFetch, 'string');
    assert.deepEqual(state.upstream, { ref: 'origin/feat', tracking: true, ahead: 0, behind: 1 });
  });

  it('finds a pushed branch that has no upstream, and none for a local branch', () => {
    const { work } = remoteSetup();
    git(work, ['checkout', '-q', '-b', 'feat2']);
    commit(work, 'second feature', { 'd.txt': 'd\n' });
    git(work, ['push', '-q', 'origin', 'feat2']);
    assert.deepEqual(gitState(work, OFFLINE).upstream, { ref: 'origin/feat2', tracking: false, ahead: 0, behind: 0 });
    git(work, ['checkout', '-q', '-b', 'local-only']);
    assert.equal(gitState(work, OFFLINE).upstream, null);
  });

  it('reports a failed fetch and still reads the local state', () => {
    const { work } = remoteSetup();
    git(work, ['remote', 'set-url', 'origin', join(sandbox, 'missing.git')]);
    const state = gitState(work);
    assert.equal(state.fetch.attempted, true);
    assert.equal(state.fetch.ok, false);
    assert.ok(state.fetch.error.length > 0);
    assert.ok(state.warnings.some((warning) => warning.startsWith('fetch from origin failed')));
    assert.equal(state.base.status, 'resolved');
    assert.equal(state.upstream.behind, 0);
  });

  it('never outputs the credentials of the remote URL', () => {
    const { work } = remoteSetup();
    git(work, ['remote', 'set-url', 'origin', 'https://user:s3cret@example.com/group/project.git']);
    const state = gitState(work, OFFLINE);
    assert.ok(!JSON.stringify(state).includes('s3cret'));
    assert.equal(state.remote.url, 'https://example.com/group/project.git');
    assert.equal(state.remote.project, 'group/project');
  });
});

describe('command line', { skip: !HAS_GIT && 'git is not installed' }, () => {
  function run(args) {
    return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', windowsHide: true });
  }

  it('prints the state as JSON', () => {
    const result = run([featureRepository(), '--no-fetch']);
    assert.equal(result.status, 0, result.stderr);
    const state = JSON.parse(result.stdout);
    assert.equal(state.version, 1);
    assert.equal(state.commits.total, 2);
  });

  it('exits with 1 on a usage error, an unknown base or a missing directory', () => {
    const root = featureRepository();
    for (const args of [['--verbose'], [root, '--no-fetch', '--base', 'nope'], [join(sandbox, 'missing')]]) {
      const result = run(args);
      assert.equal(result.status, 1, args.join(' '));
      assert.match(result.stderr, /^git-state: /);
    }
  });
});
