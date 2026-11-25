#!/usr/bin/env node
// Repository state for the project-report skill: the current branch, the base it started from, the
// commits and file changes since that base, the working tree, the upstream, the tags and the remote, so
// that a report states what was done without guessing.
//
// Usage: node scripts/git-state.mjs [path] [--base <ref> | --since <date>] [--no-fetch]
//
// Prints one JSON document on stdout, described in SKILL.md; the path defaults to the current directory.
// Before reading, it fetches the remote of the upstream branch (or origin) with credential prompts
// disabled and a timeout; a failed fetch is reported in `fetch` and `warnings`, and the state is then
// read from the local refs. Apart from that fetch, which updates remote-tracking refs and FETCH_HEAD, it
// only runs read-only git commands. It exits with 1 and a message on stderr on a usage error, when the
// path is not a directory or when --base names an unknown revision. A directory outside any git
// repository is not an error: `repository` is then null.

import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const GIT_STATE_VERSION = 1;
export const DEFAULT_LIMITS = Object.freeze({ commits: 200, changes: 300, workingTree: 200 });
export const FETCH_TIMEOUT_MS = 30_000;

// Branches a feature branch usually starts from, besides the default branch of the remote.
const BASE_BRANCH_NAMES = ['main', 'master', 'develop'];
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const FIELD_SEPARATOR = '\x1f';
const CONFLICT_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
// Markers git leaves in its directory while a multi-step operation is in progress, in order of precedence.
const OPERATION_MARKERS = [
  ['rebase-merge', 'rebase'],
  ['rebase-apply', 'rebase'],
  ['MERGE_HEAD', 'merge'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'],
  ['REVERT_HEAD', 'revert'],
  ['BISECT_LOG', 'bisect'],
];

function toPosix(path) {
  return path.split(sep).join('/');
}

function runGit(cwd, args, { env = process.env, timeout } = {}) {
  const result = spawnSync('git', ['-C', cwd, '-c', 'core.quotePath=false', ...args], {
    encoding: 'utf8',
    maxBuffer: GIT_MAX_BUFFER,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
    timeout,
  });
  return {
    ok: !result.error && result.status === 0,
    stdout: result.stdout ?? '',
    stderr: (result.stderr ?? '').trim(),
    error: result.error ?? null,
  };
}

// stdout of a git command that is allowed to fail (a probe), or null when it failed.
function probe(cwd, args) {
  const result = runGit(cwd, args);
  return result.ok ? result.stdout : null;
}

function probeLine(cwd, args) {
  const output = probe(cwd, args);
  if (output === null) {
    return null;
  }
  const line = output.trim();
  return line === '' ? null : line;
}

// stdout of a git command expected to succeed; a failure is recorded as a warning and yields null.
function read(cwd, args, warnings, what) {
  const result = runGit(cwd, args);
  if (!result.ok) {
    const reason = result.error ? result.error.message : result.stderr || 'unknown error';
    warnings.push(`could not read ${what}: ${reason}`);
    return null;
  }
  return result.stdout;
}

// git expands %x1f itself, so no control character has to travel on the command line.
function logFormat(placeholders) {
  return placeholders.join('%x1f');
}

function lines(text) {
  return text.split(/\r?\n/).filter((line) => line !== '');
}

function capped(list, limit) {
  return { total: list.length, truncated: list.length > limit, items: list.slice(0, limit) };
}

function isGitAvailable() {
  const result = spawnSync('git', ['--version'], { windowsHide: true, stdio: 'ignore' });
  return !result.error && result.status === 0;
}

export function parseArguments(argv) {
  const options = { path: undefined, base: undefined, since: undefined, fetch: true };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--no-fetch') {
      options.fetch = false;
      continue;
    }
    const valued = argument.match(/^--(base|since)(?:=(.*))?$/);
    if (valued) {
      const [, name, inline] = valued;
      const value = inline ?? argv[(index += 1)];
      if (value === undefined || value === '') {
        throw new Error(`--${name} needs a value`);
      }
      // The value reaches git as an argument: a leading dash would be read as an option.
      if (value.startsWith('-')) {
        throw new Error(`--${name} value must not start with "-": ${value}`);
      }
      if (options[name] !== undefined) {
        throw new Error(`--${name} is given twice`);
      }
      options[name] = value;
      continue;
    }
    if (argument.startsWith('-')) {
      throw new Error(`unknown option: ${argument}`);
    }
    if (options.path !== undefined) {
      throw new Error(`unexpected argument: ${argument}`);
    }
    options.path = argument;
  }
  if (options.base !== undefined && options.since !== undefined) {
    throw new Error('--base and --since cannot be used together');
  }
  return options;
}

function platformOf(host) {
  if (!host) {
    return null;
  }
  const name = host.toLowerCase();
  if (name.includes('github')) {
    return 'github';
  }
  if (name.includes('gitlab')) {
    return 'gitlab';
  }
  if (name.includes('bitbucket')) {
    return 'bitbucket';
  }
  if (name === 'dev.azure.com' || name.endsWith('.visualstudio.com') || name.startsWith('ssh.dev.azure.com')) {
    return 'azure-devops';
  }
  return null;
}

function projectOf(path) {
  const project = path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '');
  return project === '' ? null : project;
}

// Describes a remote URL without the credentials it may embed (https://user:token@host/...).
export function describeRemoteUrl(raw) {
  const url = raw.trim();
  const local = { url, host: null, platform: null, project: null };
  if (/^[A-Za-z]:[\\/]/.test(url) || url.startsWith('/') || url.startsWith('.') || url.startsWith('\\\\')) {
    return local;
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(url)) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      // Unparsable as a URL: strip anything that looks like user information, keep the rest as is.
      return { ...local, url: url.replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^@/]*@/, '$1') };
    }
    if (parsed.protocol === 'file:') {
      return local;
    }
    parsed.username = '';
    parsed.password = '';
    const host = parsed.hostname === '' ? null : parsed.hostname;
    return { url: parsed.toString(), host, platform: platformOf(host), project: projectOf(decodeURIComponent(parsed.pathname)) };
  }
  // scp-like syntax: [user@]host:path. The user part carries no password in this syntax.
  const scp = url.match(/^(?:[^@/]+@)?([^:/]+):(.*)$/);
  if (scp) {
    return { url, host: scp[1], platform: platformOf(scp[1]), project: projectOf(scp[2]) };
  }
  return local;
}

function readHead(root, warnings) {
  const branch = probeLine(root, ['symbolic-ref', '-q', '--short', 'HEAD']);
  const commit = probeLine(root, ['rev-parse', '--verify', '-q', 'HEAD']);
  if (commit === null) {
    warnings.push('HEAD has no commit yet');
    return { branch, detached: false, commit: null, subject: null, date: null };
  }
  const details = read(root, ['log', '-1', `--format=${logFormat(['%h', '%cI', '%s'])}`, 'HEAD'], warnings, 'the HEAD commit');
  const [hash = null, date = null, subject = null] = details === null ? [] : details.replace(/\r?\n$/, '').split(FIELD_SEPARATOR);
  return { branch, detached: branch === null, commit: hash, subject, date };
}

function selectRemote(root, branch) {
  const remotes = lines(probe(root, ['remote']) ?? '');
  if (remotes.length === 0) {
    return null;
  }
  const configured = branch === null ? null : probeLine(root, ['config', '--get', `branch.${branch}.remote`]);
  if (configured !== null && remotes.includes(configured)) {
    return configured;
  }
  return remotes.includes('origin') ? 'origin' : remotes[0];
}

function describeRemote(root, name, warnings) {
  if (name === null) {
    return null;
  }
  const url = read(root, ['remote', 'get-url', name], warnings, `the URL of remote ${name}`);
  if (url === null) {
    return { name, url: null, host: null, platform: null, project: null };
  }
  return { name, ...describeRemoteUrl(url) };
}

function lastFetchTime(root) {
  const relativePath = probeLine(root, ['rev-parse', '--git-path', 'FETCH_HEAD']);
  if (relativePath === null) {
    return null;
  }
  const path = isAbsolute(relativePath) ? relativePath : join(root, relativePath);
  return existsSync(path) ? statSync(path).mtime.toISOString() : null;
}

function fetchRemote(root, remote, options, warnings) {
  const state = { attempted: false, remote, ok: null, error: null, lastFetch: null };
  if (remote !== null && options.fetch) {
    state.attempted = true;
    // No interactive prompt: a fetch that needs credentials fails instead of waiting for input.
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
    const customSsh = process.env.GIT_SSH_COMMAND || process.env.GIT_SSH || probeLine(root, ['config', '--get', 'core.sshCommand']);
    if (!customSsh) {
      env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes';
    }
    const result = runGit(root, ['fetch', '--quiet', '--no-recurse-submodules', remote], { env, timeout: options.fetchTimeout });
    state.ok = result.ok;
    if (!result.ok) {
      if (result.error?.code === 'ETIMEDOUT') {
        state.error = `timed out after ${Math.round(options.fetchTimeout / 1000)} s`;
      } else {
        state.error = result.error ? result.error.message : lines(result.stderr).at(-1) ?? 'unknown error';
      }
      warnings.push(`fetch from ${remote} failed (${state.error}): remote-tracking refs may be stale`);
    }
  }
  state.lastFetch = lastFetchTime(root);
  return state;
}

function aheadBehind(root, ref, warnings) {
  const counts = read(root, ['rev-list', '--left-right', '--count', `HEAD...${ref}`], warnings, `the distance to ${ref}`);
  if (counts === null) {
    return { ahead: null, behind: null };
  }
  const [ahead, behind] = counts.trim().split(/\s+/).map(Number);
  return { ahead, behind };
}

function readUpstream(root, head, remote, warnings) {
  if (head.branch === null || head.commit === null) {
    return null;
  }
  const tracked = probeLine(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${head.branch}@{upstream}`]);
  if (tracked !== null && probeLine(root, ['rev-parse', '--verify', '-q', tracked]) !== null) {
    return { ref: tracked, tracking: true, ...aheadBehind(root, tracked, warnings) };
  }
  if (probeLine(root, ['config', '--get', `branch.${head.branch}.merge`]) !== null) {
    warnings.push(`the upstream configured for ${head.branch} no longer exists on the remote`);
  }
  if (remote !== null && probeLine(root, ['rev-parse', '--verify', '-q', `refs/remotes/${remote}/${head.branch}`]) !== null) {
    const ref = `${remote}/${head.branch}`;
    return { ref, tracking: false, ...aheadBehind(root, ref, warnings) };
  }
  return null;
}

function baseCandidates(root, remote) {
  const names = [];
  if (remote !== null) {
    const target = probeLine(root, ['symbolic-ref', '-q', `refs/remotes/${remote}/HEAD`]);
    const prefix = `refs/remotes/${remote}/`;
    if (target !== null && target.startsWith(prefix)) {
      names.push(target.slice(prefix.length));
    }
  }
  for (const name of BASE_BRANCH_NAMES) {
    if (!names.includes(name)) {
      names.push(name);
    }
  }
  const refs = [];
  for (const name of names) {
    // Remote-tracking refs first: after the fetch they are the freshest, and they win ties.
    const fullRefs = remote === null ? [`refs/heads/${name}`] : [`refs/remotes/${remote}/${name}`, `refs/heads/${name}`];
    for (const fullRef of fullRefs) {
      if (probeLine(root, ['rev-parse', '--verify', '-q', `${fullRef}^{commit}`]) !== null) {
        refs.push({ fullRef, ref: fullRef.replace(/^refs\/(heads|remotes)\//, '') });
      }
    }
  }
  return { names, refs };
}

function emptyBase(status) {
  return { status, ref: null, commit: null, source: null, since: null, containedIn: [] };
}

function resolveBase(root, head, remote, options, warnings) {
  if (head.commit === null) {
    return emptyBase('no-commit');
  }
  if (options.base !== undefined) {
    if (probeLine(root, ['rev-parse', '--verify', '-q', `${options.base}^{commit}`]) === null) {
      throw new Error(`--base: unknown revision ${options.base}`);
    }
    const mergeBase = probeLine(root, ['merge-base', 'HEAD', options.base]);
    if (mergeBase === null) {
      throw new Error(`--base: ${options.base} shares no history with HEAD`);
    }
    return { ...emptyBase('resolved'), ref: options.base, commit: mergeBase, source: 'option' };
  }
  if (options.since !== undefined) {
    // The last commit of the first-parent line made before the date; null when every commit is after it.
    const commit = probeLine(root, ['rev-list', '-1', '--first-parent', `--before=${options.since}`, 'HEAD']);
    return { ...emptyBase('resolved'), commit, source: 'since', since: options.since };
  }

  const { names, refs } = baseCandidates(root, remote);
  if (head.branch !== null && names.includes(head.branch)) {
    return emptyBase('on-base-branch');
  }
  const containedIn = [];
  let best = null;
  for (const candidate of refs) {
    if (runGit(root, ['merge-base', '--is-ancestor', 'HEAD', candidate.fullRef]).ok) {
      containedIn.push(candidate.ref);
    }
    const mergeBase = probeLine(root, ['merge-base', 'HEAD', candidate.fullRef]);
    if (mergeBase === null) {
      continue;
    }
    const distance = Number(probeLine(root, ['rev-list', '--count', `${mergeBase}..HEAD`]));
    if (Number.isNaN(distance)) {
      warnings.push(`could not count the commits since ${candidate.ref}`);
      continue;
    }
    if (best === null || distance < best.distance) {
      best = { ...candidate, mergeBase, distance };
    }
  }
  if (best === null) {
    return { ...emptyBase('no-candidate'), containedIn };
  }
  return { ...emptyBase('resolved'), ref: best.ref, commit: best.mergeBase, source: 'detected', containedIn };
}

function emptyTree(root, warnings) {
  const result = spawnSync('git', ['-C', root, 'hash-object', '-t', 'tree', '--stdin'], { encoding: 'utf8', input: '', windowsHide: true });
  if (result.error || result.status !== 0) {
    warnings.push('could not compute the empty tree to diff against');
    return null;
  }
  return result.stdout.trim();
}

function readCommits(root, base, limits, warnings) {
  if (base.status !== 'resolved') {
    return null;
  }
  const range = base.commit === null ? ['HEAD'] : [`${base.commit}..HEAD`];
  const total = read(root, ['rev-list', '--count', ...range], warnings, 'the commit count');
  const format = logFormat(['%h', '%aI', '%an', '%P', '%s']);
  const log = read(root, ['log', `--max-count=${limits.commits}`, `--format=${format}`, ...range], warnings, 'the commits');
  if (total === null || log === null) {
    return null;
  }
  const items = lines(log).map((line) => {
    const [hash, date, author, parents, subject] = line.split(FIELD_SEPARATOR);
    return { hash, date, author, merge: parents.trim().split(/\s+/).length > 1, subject };
  });
  const count = Number(total.trim());
  return { total: count, truncated: count > items.length, items };
}

export function parseNameStatus(output) {
  const tokens = output.split('\0');
  const entries = [];
  for (let index = 0; index < tokens.length && tokens[index] !== ''; ) {
    const code = tokens[index];
    const status = code[0];
    if (status === 'R' || status === 'C') {
      entries.push({ status, previousPath: tokens[index + 1], path: tokens[index + 2] });
      index += 3;
    } else {
      entries.push({ status, previousPath: null, path: tokens[index + 1] });
      index += 2;
    }
  }
  return entries;
}

export function parseNumstat(output) {
  const tokens = output.split('\0');
  const stats = new Map();
  for (let index = 0; index < tokens.length && tokens[index] !== ''; ) {
    const [added, deleted, ...rest] = tokens[index].split('\t');
    const inlinePath = rest.join('\t');
    let path;
    if (inlinePath === '') {
      // Rename or copy: the old and new paths follow as separate tokens.
      path = tokens[index + 2];
      index += 3;
    } else {
      path = inlinePath;
      index += 1;
    }
    stats.set(path, { additions: added === '-' ? null : Number(added), deletions: deleted === '-' ? null : Number(deleted) });
  }
  return stats;
}

function readChanges(root, base, limits, warnings) {
  if (base.status !== 'resolved') {
    return null;
  }
  const from = base.commit ?? emptyTree(root, warnings);
  if (from === null) {
    return null;
  }
  const nameStatus = read(root, ['diff', '--name-status', '-z', '-M', from, 'HEAD'], warnings, 'the changed files');
  const numstat = read(root, ['diff', '--numstat', '-z', '-M', from, 'HEAD'], warnings, 'the line counts');
  if (nameStatus === null || numstat === null) {
    return null;
  }
  const stats = parseNumstat(numstat);
  const entries = parseNameStatus(nameStatus)
    .map((entry) => ({ ...entry, ...(stats.get(entry.path) ?? { additions: null, deletions: null }) }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const sum = (key) => entries.reduce((total, entry) => total + (entry[key] ?? 0), 0);
  return { ...capped(entries, limits.changes), additions: sum('additions'), deletions: sum('deletions') };
}

export function parseStatus(output) {
  const tokens = output.split('\0');
  const result = { staged: [], unstaged: [], untracked: [], conflicted: [] };
  for (let index = 0; index < tokens.length && tokens[index] !== ''; index += 1) {
    const token = tokens[index];
    const code = token.slice(0, 2);
    const path = token.slice(3);
    const [indexStatus, treeStatus] = code;
    let previousPath = null;
    if (indexStatus === 'R' || indexStatus === 'C') {
      // With -z, the original path of a rename or copy follows as its own token.
      index += 1;
      previousPath = tokens[index];
    }
    if (code === '??') {
      result.untracked.push(path);
    } else if (code === '!!') {
      continue;
    } else if (CONFLICT_CODES.has(code)) {
      result.conflicted.push(path);
    } else {
      if (indexStatus !== ' ') {
        result.staged.push({ path, status: indexStatus, previousPath });
      }
      if (treeStatus !== ' ') {
        result.unstaged.push({ path, status: treeStatus });
      }
    }
  }
  return result;
}

function operationInProgress(root) {
  for (const [marker, operation] of OPERATION_MARKERS) {
    const relativePath = probeLine(root, ['rev-parse', '--git-path', marker]);
    if (relativePath !== null && existsSync(isAbsolute(relativePath) ? relativePath : join(root, relativePath))) {
      return operation;
    }
  }
  return null;
}

function readWorkingTree(root, limits, warnings) {
  const status = read(root, ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], warnings, 'the working tree status');
  if (status === null) {
    return null;
  }
  const parsed = parseStatus(status);
  const stashList = probe(root, ['stash', 'list']);
  return {
    clean: Object.values(parsed).every((list) => list.length === 0),
    staged: capped(parsed.staged, limits.workingTree),
    unstaged: capped(parsed.unstaged, limits.workingTree),
    untracked: capped(parsed.untracked, limits.workingTree),
    conflicted: capped(parsed.conflicted, limits.workingTree),
    stashes: stashList === null ? 0 : lines(stashList).length,
    operation: operationInProgress(root),
  };
}

function readTags(root, head) {
  if (head.commit === null) {
    return null;
  }
  const atHead = lines(probe(root, ['tag', '--points-at', 'HEAD']) ?? '');
  const name = probeLine(root, ['describe', '--tags', '--abbrev=0', 'HEAD']);
  if (name === null) {
    return { atHead, latest: null };
  }
  const commit = probeLine(root, ['rev-parse', '--short', `${name}^{commit}`]);
  const commitsSince = Number(probeLine(root, ['rev-list', '--count', `${name}..HEAD`]));
  return { atHead, latest: { name, commit, commitsSince: Number.isNaN(commitsSince) ? null : commitsSince } };
}

export function gitState(path, options = {}) {
  const target = resolve(path);
  if (!existsSync(target) || !statSync(target).isDirectory()) {
    throw new Error(`not a directory: ${target}`);
  }
  if (options.base !== undefined && options.since !== undefined) {
    throw new Error('--base and --since cannot be used together');
  }
  const settings = {
    base: options.base,
    since: options.since,
    fetch: options.fetch ?? true,
    fetchTimeout: options.fetchTimeout ?? FETCH_TIMEOUT_MS,
    limits: { ...DEFAULT_LIMITS, ...options.limits },
  };
  const warnings = [];
  const state = {
    version: GIT_STATE_VERSION,
    path: toPosix(target),
    gitAvailable: isGitAvailable(),
    repository: null,
    head: null,
    remote: null,
    fetch: { attempted: false, remote: null, ok: null, error: null, lastFetch: null },
    upstream: null,
    base: emptyBase('no-repository'),
    commits: null,
    changes: null,
    workingTree: null,
    tags: null,
    warnings,
  };
  if (!state.gitAvailable) {
    warnings.push('git is not installed or not on PATH');
    return state;
  }
  const root = probeLine(target, ['rev-parse', '--show-toplevel']);
  if (root === null) {
    return state;
  }
  state.repository = root;
  state.head = readHead(root, warnings);
  const remoteName = selectRemote(root, state.head.branch);
  state.remote = describeRemote(root, remoteName, warnings);
  state.fetch = fetchRemote(root, remoteName, settings, warnings);
  state.upstream = readUpstream(root, state.head, remoteName, warnings);
  state.base = resolveBase(root, state.head, remoteName, settings, warnings);
  state.commits = readCommits(root, state.base, settings.limits, warnings);
  state.changes = readChanges(root, state.base, settings.limits, warnings);
  state.workingTree = readWorkingTree(root, settings.limits, warnings);
  state.tags = readTags(root, state.head);
  return state;
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
    const { path, ...options } = parseArguments(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(gitState(path ?? process.cwd(), options), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`git-state: ${error.message}\n`);
    process.exitCode = 1;
  }
}
