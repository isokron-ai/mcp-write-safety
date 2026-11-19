// Self-test of scripts/ci/test-shard.mjs and test-shard-hook.mjs: node --test scripts/ci/*.test.mjs
//
// Each case builds a tiny suite in a temp dir (dist/test/*.test.js, and test/*.test.ts sources for verify)
// and runs the real script on it.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), 'test-shard.mjs');
const temps = [];
after(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));

const CLEAN = `import { test, describe, it } from 'node:test';
test('a', () => {});
test('b', () => {});
describe('c', () => { it('c1', () => {}); });
`;

/** A temp project: files maps relative path -> content; each dist/test/X.test.js also gets test/X.test.ts. */
function project(files) {
  const root = mkdtempSync(join(tmpdir(), 'test-shard-'));
  temps.push(root);
  for (const [rel, text] of Object.entries(files)) {
    const paths = [rel];
    if (rel.startsWith('dist/test/') && rel.endsWith('.test.js')) paths.push(rel.slice(5).replace(/\.js$/, '.ts'));
    for (const p of paths) {
      mkdirSync(dirname(join(root, p)), { recursive: true });
      writeFileSync(join(root, p), text);
    }
  }
  return root;
}

function shard(root, args) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // the child runner must report on its own, not to this runner
  const r = spawnSync(process.execPath, [script, ...args], { cwd: root, env, encoding: 'utf8' });
  return { status: r.status, out: r.stdout + r.stderr };
}

/** Runs all n shards (manifests m1..mn.json in root); returns the results. */
function runAll(root, n, extra = []) {
  return Array.from({ length: n }, (_, i) =>
    shard(root, ['run', '--shard', `${i + 1}/${n}`, '--dir', 'dist/test', ...extra, '--manifest', `m${i + 1}.json`]),
  );
}
const manifests = (n) => Array.from({ length: n }, (_, i) => `m${i + 1}.json`);

test('a clean split file runs over the shards and verifies', () => {
  const root = project({ 'dist/test/split.test.js': CLEAN, 'dist/test/plain.test.js': CLEAN });
  const rs = runAll(root, 2, ['--split', 'dist/test/split.test.js']);
  rs.forEach((r) => assert.equal(r.status, 0, r.out));
  const v = shard(root, ['verify', '--dir', 'dist/test', '--src', 'test', ...manifests(2)]);
  assert.equal(v.status, 0, v.out);
  assert.match(v.out, /coverage ok: 2 shards, 1 whole files each run once, 1 split file\(s\) with 3 top-level units/);
});

for (const [what, text, re] of [
  ['a default import', `import test from 'node:test';\ntest('a', () => {});\n`, /default import of node:test/],
  ['a default import beside named ones', `import nt, {\n  it,\n} from 'node:test';\nit('a', () => {});\n`, /default import of node:test/],
  ['require of node:test', `const t = require('node:test');\n`, /require\('node:test'\)/],
  ['test.only', `import { test } from 'node:test';\ntest.only('a', () => {});\n`, /\.only\/\.skip\/\.todo/],
  ['describe.skip', `import { describe } from 'node:test';\ndescribe.skip('a', () => {});\n`, /\.only\/\.skip\/\.todo/],
  ['it.todo', `import { it } from 'node:test';\nit.todo('a');\n`, /\.only\/\.skip\/\.todo/],
  ['a top-level before', `import { before, test } from 'node:test';\nbefore(() => {});\ntest('a', () => {});\n`, /top-level hook/],
  ['a top-level afterEach', `import * as nt from 'node:test';\nnt.afterEach(() => {});\n`, /top-level hook/],
]) {
  test(`run and verify refuse a split file with ${what}`, () => {
    const root = project({ 'dist/test/split.test.js': CLEAN, 'dist/test/plain.test.js': CLEAN });
    const ok = runAll(root, 2, ['--split', 'dist/test/split.test.js']);
    ok.forEach((r) => assert.equal(r.status, 0, r.out));
    // the same construct in the built file (run) and in its source (verify)
    writeFileSync(join(root, 'dist/test/split.test.js'), text);
    writeFileSync(join(root, 'test/split.test.ts'), text);
    const r = shard(root, ['run', '--shard', '1/2', '--dir', 'dist/test', '--split', 'dist/test/split.test.js', '--manifest', 'x.json']);
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, re);
    const v = shard(root, ['verify', '--dir', 'dist/test', '--src', 'test', ...manifests(2)]);
    assert.equal(v.status, 1, v.out);
    assert.match(v.out, re);
  });
}

test('the hook throws on a top-level hook the static check does not see', () => {
  const text = `import { before, test } from 'node:test';\nif (true) {\n  before(() => {});\n}\ntest('a', () => {});\n`;
  const root = project({ 'dist/test/split.test.js': text });
  const r = shard(root, ['run', '--shard', '1/2', '--dir', 'dist/test', '--split', 'dist/test/split.test.js', '--manifest', 'm1.json']);
  assert.notEqual(r.status, 0, r.out);
  assert.match(r.out, /a top-level before\(\) would run in every shard/);
});

test('hooks inside a test or suite of a split file are allowed (.only/.skip/.todo are refused anywhere in it)', () => {
  const text = `import { before, describe, it, test } from 'node:test';
describe('s', () => { before(() => {}); it('x', { skip: true }, () => {}); it('y', () => {}); });
test('t', async (t) => { t.after(() => {}); });
`;
  const root = project({ 'dist/test/split.test.js': text });
  const rs = runAll(root, 2, ['--split', 'dist/test/split.test.js']);
  rs.forEach((r) => assert.equal(r.status, 0, r.out));
});

test('--top-only: a nested test file fails run and verify', () => {
  const root = project({ 'dist/test/a.test.js': CLEAN, 'dist/test/b.test.js': CLEAN });
  const ok = runAll(root, 2, ['--top-only']);
  ok.forEach((r) => assert.equal(r.status, 0, r.out));
  assert.equal(shard(root, ['verify', '--top-only', '--dir', 'dist/test', '--src', 'test', ...manifests(2)]).status, 0);

  mkdirSync(join(root, 'dist/test/sub'));
  writeFileSync(join(root, 'dist/test/sub/c.test.js'), CLEAN);
  mkdirSync(join(root, 'test/sub'));
  writeFileSync(join(root, 'test/sub/c.test.ts'), CLEAN);
  const r = shard(root, ['run', '--top-only', '--shard', '1/2', '--dir', 'dist/test', '--manifest', 'x.json']);
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /nested test files that npm test would not run: dist\/test\/sub\/c\.test\.js/);
  const v = shard(root, ['verify', '--top-only', '--dir', 'dist/test', '--src', 'test', ...manifests(2)]);
  assert.equal(v.status, 1, v.out);
  assert.match(v.out, /nested test files that npm test would not run: test\/sub\/c\.test\.ts/);
});
