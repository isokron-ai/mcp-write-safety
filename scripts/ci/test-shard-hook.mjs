// Loaded with `node --import` into each test file's process by scripts/ci/test-shard.mjs. In a file the
// runner splits (TEST_SHARD_SPLIT), it keeps the top-level tests and suites of this shard and registers
// the others as skipped, so one long file can run across several CI jobs.
//
// A unit is a top-level call of test, it, describe or suite (calls inside a suite or inside a running test
// are left alone). Unit k of a file belongs to shard (k + offset) mod n, offset = a hash of the file's
// path: each unit belongs to exactly one shard. Every registration, kept or not, is appended to
// TEST_SHARD_LOG, so the coverage check can confirm that all shards saw the same units in the same order.
//
// Environment (set by test-shard.mjs): TEST_SHARD=i/n (1-based), TEST_SHARD_SPLIT=JSON array of absolute
// file paths, TEST_SHARD_LOG=path of the JSON-lines log, TEST_SHARD_ROOT=directory the logged paths are
// relative to.

import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { relative, resolve } from 'node:path';

const file = process.argv[1] ? resolve(process.argv[1]) : '';
const split = JSON.parse(process.env.TEST_SHARD_SPLIT || '[]');
const m = /^(\d+)\/(\d+)$/.exec(process.env.TEST_SHARD || '');

if (m && split.includes(file)) {
  const shard = Number(m[1]) - 1;
  const total = Number(m[2]);
  const rel = relative(process.env.TEST_SHARD_ROOT || process.cwd(), file);
  const offset = hash(rel) % total;
  const log = process.env.TEST_SHARD_LOG;
  const inside = new AsyncLocalStorage();
  const require = createRequire(import.meta.url);
  const nt = require('node:test');
  let index = 0;

  const wrap = (orig, kind) =>
    function (...args) {
      if (inside.getStore()) return orig.apply(this, args);
      const fnAt = args.findIndex((a) => typeof a === 'function');
      const fn = fnAt >= 0 ? args[fnAt] : undefined;
      const name = typeof args[0] === 'string' ? args[0] : fn?.name || '<anonymous>';
      const k = index++;
      const owner = (k + offset) % total;
      const keep = owner === shard;
      if (log) appendFileSync(log, JSON.stringify({ file: rel, index: k, kind, name, shard: owner + 1, total }) + '\n');
      if (fn) args[fnAt] = function (...a) { return inside.run(true, () => fn.apply(this, a)); };
      if (keep) return orig.apply(this, args);
      const options = args.find((a, i) => i < (fnAt >= 0 ? fnAt : args.length) && a && typeof a === 'object') || {};
      const named = typeof args[0] === 'string' ? [args[0]] : [];
      return orig.call(this, ...named, { ...options, skip: `shard ${owner + 1}/${total}` }, fn ?? (() => {}));
    };

  // What would bypass the wrapper and run in every shard is refused at top level (test-shard.mjs also refuses
  // it statically, with a default import of node:test, which no hook can intercept).
  const refuse = (orig, what) =>
    function (...args) {
      if (inside.getStore()) return orig.apply(this, args);
      throw new Error(`test-shard: ${rel} is split across shards; a top-level ${what} would run in every shard`);
    };
  for (const [key, kind] of [['test', 'test'], ['it', 'test'], ['describe', 'suite'], ['suite', 'suite']]) {
    const orig = nt[key];
    const wrapped = Object.assign(wrap(orig, kind), orig);
    for (const m of ['only', 'skip', 'todo']) if (typeof orig[m] === 'function') wrapped[m] = refuse(orig[m], `${key}.${m}()`);
    nt[key] = wrapped;
  }
  for (const key of ['before', 'after', 'beforeEach', 'afterEach']) nt[key] = refuse(nt[key], `${key}()`);
  syncBuiltinESMExports();
}

function hash(s) {
  let h = 2166136261; // FNV-1a, 32 bit
  for (const c of Buffer.from(s, 'utf8')) h = Math.imul(h ^ c, 16777619) >>> 0;
  return h;
}
