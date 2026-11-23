// Repository checks: the single definition shared by CI (.github/workflows/ci.yml) and the git hooks
// in .githooks/.
//
// Usage: node .github/scripts/checks.mjs [check...]
// With no argument, runs every check in declaration order. Stops at the first failure and exits with
// its status; exits with 2 on an unknown check name.
//
// Tool versions are pinned here and nowhere else, as exact versions bumped by hand.

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLAUDE_CODE_PACKAGE = '@anthropic-ai/claude-code@2.1.330';
const SKILLS_PACKAGE = 'skills@1.9.0';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// npx is a .cmd shim on Windows, which Node refuses to spawn without a shell.
function npx(args) {
  return { command: 'npx', args: ['--yes', ...args], shell: process.platform === 'win32' };
}

const CHECKS = new Map([
  [
    'tests',
    {
      description: 'catalog validation and fixture tests',
      // Node expands the glob itself, so no shell is needed on any platform.
      command: process.execPath,
      args: ['--test', 'tests/*.test.mjs'],
      shell: false,
    },
  ],
  [
    'marketplace',
    {
      description: 'plugin marketplace manifest',
      ...npx([`--package=${CLAUDE_CODE_PACKAGE}`, '--', 'claude', 'plugin', 'validate', '.']),
    },
  ],
  [
    'discovery',
    {
      description: 'skill discovery by the skills CLI',
      ...npx([SKILLS_PACKAGE, 'add', '.', '--list']),
    },
  ],
]);

function run({ command, args, shell }) {
  const options = {
    cwd: root,
    // stdin is ignored: git feeds the pushed refs to the pre-push hook on stdin, and no check is interactive.
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, DISABLE_TELEMETRY: '1' },
  };
  if (!shell) {
    return spawnSync(command, args, options);
  }
  // A single command line rather than an args array, which Node deprecates with `shell: true`. The arguments
  // are the static values above and contain no character the shell interprets.
  return spawnSync([command, ...args].join(' '), { ...options, shell: true });
}

const requested = process.argv.slice(2);
const unknown = requested.filter((name) => !CHECKS.has(name));
if (unknown.length > 0) {
  console.error(`Unknown check: ${unknown.join(', ')}. Available: ${[...CHECKS.keys()].join(', ')}.`);
  process.exit(2);
}

for (const name of requested.length > 0 ? requested : CHECKS.keys()) {
  const check = CHECKS.get(name);
  console.log(`==> ${name}: ${check.description}`);
  const result = run(check);
  if (result.error) {
    console.error(`Check "${name}" could not start: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    const reason = result.signal ? `signal ${result.signal}` : `exit code ${result.status}`;
    console.error(`Check "${name}" failed (${reason}).`);
    process.exit(result.status ?? 1);
  }
}
