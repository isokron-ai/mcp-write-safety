#!/usr/bin/env node
// Runs one shard of a node:test suite in CI, and checks afterwards that the shards together ran every test
// exactly once.
//
//   node scripts/ci/test-shard.mjs run --shard 2/6 --cwd packages/writecheck --dir dist/test \
//        [--exclude dist/test/unit] [--split dist/test/integration/tiny-tracker.test.js] \
//        [--weights scripts/ci/weights.json] --manifest shard-2.json
//   node scripts/ci/test-shard.mjs verify --cwd packages/writecheck --src test [--exclude test/unit] shard-*.json
//
// run: the test files are every *.test.js under --dir, less --exclude. A file not named by --split runs
// whole in exactly one shard: files are dealt out longest first (by --weights, seconds per file, default 1)
// to the shard with the least work so far, ties to the lowest shard. A --split file runs in every shard, and
// scripts/ci/test-shard-hook.mjs keeps only this shard's top-level tests in it. The manifest records the
// whole file list, this shard's files and every split-file registration.
//
// verify: all manifests name the same files and the same n, one manifest per shard 1..n; every file is run
// whole by exactly one shard or split; every shard saw the same split-file units in the same order, and each
// unit was kept by exactly one shard; and the file list equals the *.test.ts files under --src (less
// --exclude), so a test file the build dropped is caught.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const [cmd, ...rest] = process.argv.slice(2);
const opts = { exclude: [], split: [], files: [] };
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a.startsWith('--')) {
    const key = a.slice(2);
    const val = rest[++i];
    if (val === undefined) die(`${a} needs a value`);
    if (Array.isArray(opts[key])) opts[key].push(val);
    else opts[key] = val;
  } else opts.files.push(a);
}

const cwd = resolve(opts.cwd ?? '.');
const norm = (p) => relative(cwd, resolve(cwd, p)).split('\\').join('/');
const excluded = (rel) => opts.exclude.map(norm).some((x) => rel === x || rel.startsWith(x + '/'));
const walk = (dir, suffix) =>
  readdirSync(resolve(cwd, dir), { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(suffix))
    .map((d) => norm(join(d.parentPath ?? d.path, d.name)))
    .filter((rel) => !excluded(rel))
    .sort();

if (cmd === 'run') run();
else if (cmd === 'verify') verify();
else die('usage: test-shard.mjs run|verify ...');

function run() {
  const m = /^(\d+)\/(\d+)$/.exec(opts.shard ?? '');
  if (!m || +m[1] < 1 || +m[1] > +m[2]) die('--shard i/n, 1 <= i <= n');
  const [shard, total] = [+m[1], +m[2]];
  if (!opts.dir || !opts.manifest) die('--dir and --manifest are required');
  const all = walk(opts.dir, '.test.js');
  if (all.length === 0) die(`no *.test.js under ${opts.dir}`);
  const split = opts.split.map(norm);
  for (const s of split) if (!all.includes(s)) die(`--split ${s} is not one of the test files`);
  const weights = opts.weights ? JSON.parse(readFileSync(resolve(opts.weights), 'utf8')) : {};
  const assigned = deal(all.filter((f) => !split.includes(f)), total, (f) => weights[f] ?? 1);
  const mine = all.filter((f) => assigned.get(f) === shard || split.includes(f));

  const log = resolve(opts.manifest + '.log');
  rmSync(log, { force: true });
  console.log(`shard ${shard}/${total}: ${mine.length} of ${all.length} files${split.length ? ` (split: ${split.join(', ')})` : ''}`);
  for (const f of mine) console.log(`  ${f}`);
  let status = 0;
  if (mine.length > 0) {
    const r = spawnSync(
      process.execPath,
      ['--import', join(here, 'test-shard-hook.mjs'), '--test', '--test-concurrency=1', '--test-reporter=spec', ...mine],
      {
        cwd,
        stdio: 'inherit',
        env: {
          ...process.env,
          TEST_SHARD: `${shard}/${total}`,
          TEST_SHARD_SPLIT: JSON.stringify(split.map((s) => resolve(cwd, s))),
          TEST_SHARD_LOG: log,
          TEST_SHARD_ROOT: cwd,
        },
      },
    );
    status = r.status ?? 1;
  }
  const units = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  writeFileSync(opts.manifest, JSON.stringify({ shard, total, files: all, split, whole: mine.filter((f) => !split.includes(f)), units }, null, 1) + '\n');
  const kept = units.filter((u) => u.shard === shard).length;
  console.log(`shard ${shard}/${total}: split files kept ${kept} of ${units.length} top-level units; exit ${status}`);
  process.exit(status);
}

/** Longest first, each to the shard with the least weight so far (ties: lowest shard). Deterministic. */
function deal(files, total, weight) {
  const load = Array(total).fill(0);
  const out = new Map();
  for (const f of [...files].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : 1))) {
    const s = load.indexOf(Math.min(...load));
    load[s] += weight(f);
    out.set(f, s + 1);
  }
  return out;
}

function verify() {
  if (opts.files.length === 0) die('verify: no manifests given');
  const ms = opts.files.map((p) => JSON.parse(readFileSync(p, 'utf8')));
  const problems = [];
  const total = ms[0].total;
  const files = JSON.stringify(ms[0].files);
  const shards = ms.map((x) => x.shard).sort((a, b) => a - b);
  if (JSON.stringify(shards) !== JSON.stringify(Array.from({ length: total }, (_, i) => i + 1)))
    problems.push(`manifests for shards ${shards.join(',')}, expected 1..${total}`);
  for (const x of ms) {
    if (x.total !== total) problems.push(`shard ${x.shard} has n=${x.total}, shard ${ms[0].shard} has n=${total}`);
    if (JSON.stringify(x.files) !== files) problems.push(`shard ${x.shard} lists other test files than shard ${ms[0].shard}`);
    if (JSON.stringify(x.split) !== JSON.stringify(ms[0].split)) problems.push(`shard ${x.shard} splits other files`);
  }
  const all = ms[0].files;
  const split = ms[0].split;
  const count = new Map(all.map((f) => [f, split.includes(f) ? 'split' : 0]));
  for (const x of ms) for (const f of x.whole) count.set(f, count.has(f) ? (count.get(f) === 'split' ? 'bad' : count.get(f) + 1) : 'unknown');
  for (const [f, c] of count) if (c !== 1 && c !== 'split') problems.push(`${f}: run whole by ${c} shards`);

  let units = 0;
  for (const f of split) {
    const seen = ms.map((x) => x.units.filter((u) => u.file === f));
    const shape = (us) => JSON.stringify(us.map((u) => [u.index, u.kind, u.name, u.shard]));
    for (let i = 0; i < ms.length; i++) {
      if (seen[i].length === 0) problems.push(`${f}: shard ${ms[i].shard} logged no units (was the hook loaded?)`);
      else if (shape(seen[i]) !== shape(seen[0])) problems.push(`${f}: shard ${ms[i].shard} registered other units than shard ${ms[0].shard}`);
    }
    const ref = seen[0];
    ref.forEach((u, k) => {
      if (u.index !== k) problems.push(`${f}: unit ${k} logged as index ${u.index}`);
      if (!(u.shard >= 1 && u.shard <= total)) problems.push(`${f}: unit ${k} (${u.name}) has no shard`);
    });
    for (let s = 1; s <= total; s++)
      if (!ref.some((u) => u.shard === s)) console.log(`note: ${f} gives shard ${s} no units`);
    units += ref.length;
  }

  if (opts.src) {
    const want = walk(opts.src, '.test.ts').map((f) => f.replace(/\.ts$/, '.js'));
    const got = all.map((f) => relative(norm(opts.dir ?? 'dist'), f).split('\\').join('/'));
    const relSrc = want.map((f) => relative(norm(opts.src), f).split('\\').join('/'));
    const missing = relSrc.filter((f) => !got.includes(f));
    const extra = got.filter((f) => !relSrc.includes(f));
    if (missing.length) problems.push(`source test files with no built file in any shard: ${missing.join(', ')}`);
    if (extra.length) problems.push(`built test files with no source: ${extra.join(', ')}`);
  }

  if (problems.length) {
    for (const p of problems) console.error(`::error::${p}`);
    process.exit(1);
  }
  console.log(`coverage ok: ${total} shards, ${all.length - split.length} whole files each run once, ${split.length} split file(s) with ${units} top-level units each kept once`);
}

function die(msg) {
  console.error(`test-shard: ${msg}`);
  process.exit(2);
}
