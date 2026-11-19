/**
 * The README says what the command line does: every option it names exists, every command it shows is in `--help`,
 * the coverage table lists the requirements this build knows (and its counts are the table's), and the warning that a
 * full run makes real writes comes before the demo. Cheap checks, so a doc that trails the code fails the build.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = (f: string): string => readFileSync(root + f, 'utf8');
const main = root + 'dist/src/cli/main.js';
const run = (...a: string[]): string => {
  const r = spawnSync(process.execPath, [main, ...a], { encoding: 'utf8' });
  return r.stdout + r.stderr;
};

const readme = read('README.md');
const help = run('--help');

test('README: every command-line option it names is in --help', () => {
  const named = new Set([...readme.matchAll(/`(--[a-z0-9][a-z0-9-]*)/g)].map((m) => m[1]!));
  named.delete('--yes'); // "there is no --yes"
  assert.ok(named.size >= 8);
  for (const flag of named) assert.ok(help.includes(flag), `README names ${flag}, which --help does not list`);
});

test('README: every `mcp-writecheck <command>` it shows is a command --help lists', () => {
  const use = readme.slice(readme.indexOf('## Use'), readme.indexOf('## The manifest'));
  const cmds = new Set([...use.matchAll(/^mcp-writecheck ([a-z-]+)/gm)].map((m) => m[1]!));
  for (const c of ['init', 'plan', 'catalog', 'run', 'review', 'recheck', 'rerun', 'cleanup', 'compare', 'verify-results']) assert.ok(cmds.has(c), `README shows ${c}`);
  for (const c of cmds) assert.ok(help.includes(`mcp-writecheck ${c}`), `--help has no command ${c}`);
});

test('README: the exit statuses it gives are the ones --help gives', () => {
  assert.match(help, /Exit status: 0 done; 1 a violated MUST/);
  assert.match(readme, /Exit status 1 only for a violated MUST/);
  assert.match(readme, /Exit status 4 for an incomplete run/);
  assert.match(help, /4 stopped or failed/);
  assert.match(help, /130 interrupted/);
});

test('README: the coverage table has every requirement this build knows, and its counts add up', () => {
  const known = run('requirements').split('\n').map((l) => l.split('\t')[0]!).filter((id) => /^MWS-/.test(id));
  const rows = [...readme.matchAll(/^\| (MWS-[A-Z]+-\d+) \| (MUST|SHOULD) \| (yes|partial) \|/gm)];
  assert.deepEqual(rows.map((m) => m[1]), known);
  const yes = rows.filter((m) => m[3] === 'yes').length;
  const partial = rows.length - yes;
  assert.ok(readme.includes(`executes the test of ${yes} in full and of ${partial} in part`), `README counts: ${yes} full, ${partial} partial`);
  assert.ok(help.length > 0 && known.length === 37);
});

test('README: the real-writes warning comes before the demo and names the safeguards', () => {
  const warn = readme.indexOf('## Before you run');
  const demo = readme.indexOf('## Try it');
  assert.ok(warn > 0 && warn < demo, 'warning section before the demo');
  const section = readme.slice(warn, demo);
  for (const s of ['disposable', '`plan`', '--plan-hash', '--confirm-target', 'send_empty_forms', 'no `--yes`']) assert.ok(section.includes(s), s);
  assert.ok(readme.slice(0, warn).includes('It makes real writes'), 'the first paragraph already says it');
});

test('docs: the public docs use neither "certified" nor "seal" and name no plugin platform', () => {
  for (const f of ['README.md', 'MANIFEST.md', 'CHANGELOG.md', 'docs/CELLS.md']) {
    const t = read(f);
    assert.doesNotMatch(t, /\bcertif(?:ied|ication|y)\b/i, f);
    assert.doesNotMatch(t, /\bseal\b/i, f);
    assert.doesNotMatch(t, /strapi/i, f);
  }
});
