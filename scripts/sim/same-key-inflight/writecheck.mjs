#!/usr/bin/env node
// writecheck's in-flight check (inflight.same-key, MWS-RES-2) against tiny-tracker with one same-key answer variant, as
// writecheck judges it today (the strict reading of Annex B-9), beside the verdict a lenient reading would give.
//
// The run is the matrix runner's control layout (scripts/ci/writecheck-run.mjs: `tiny-tracker all --fixture-control` with
// the faults feature, no gate), with TRACKER_SAME_KEY_ANSWER passed through to the server. The whole manifest runs; this
// script reads the same-key records and the requirements reported violated.
//
// The two readings of the same-key trial's second answer (packages/writecheck/MANIFEST.md, backend.inflight_hold):
//   strict   B-9 "A repeat with a key": its outcome and code describe the write the key identifies. "not_applied" while
//            that write is in effect afterwards is violated. This is what writecheck does; this script does not change it.
//   lenient  its outcome and code describe the call that carried them. "not_applied" is then true when the second call
//            made no object of its own: with exactly one object carrying the marker afterwards, a strict `violated` is
//            `held`; with two or more, both readings give `violated`. Every other record is the same under both.
// The lenient verdict is computed here from writecheck's own record (its verdict and the object count its reason states);
// no judge code is changed.
//
// Usage: node scripts/sim/same-key-inflight/writecheck.mjs <writecheck-cli> <tiny-tracker-dir> <out-dir>   (VARIANT in env)
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { controlManifest, freePorts, observedOf } from '../../ci/writecheck-run.mjs';
import { VARIANTS } from './model.mjs';

const SCENARIO = 'inflight.same-key';
const mask = (v) => { if (process.env.GITHUB_ACTIONS === 'true') process.stdout.write(`::add-mask::${v}\n`); };

function findResults(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { const f = findResults(p); if (f) return f; } else if (e.name === 'results.json') return p;
  }
  return null;
}

/** The lenient reading of one same-key record (see the header). */
export function lenientOf(rec) {
  if (rec.verdict !== 'violated') return { verdict: rec.verdict, why: 'the same under both readings' };
  const n = Number(/(\d+) object\(s\) carry the call's marker/.exec(rec.reason ?? '')?.[1] ?? NaN);
  if (n === 1) return { verdict: 'held', why: 'one object carries the marker afterwards: the second call made none of its own, so "not applied" is true of that call' };
  if (n >= 2) return { verdict: 'violated', why: `${n} objects carry the marker: the second call made one of its own` };
  return { verdict: 'violated', why: 'the record states no object count; the strict verdict is kept' };
}

const [cliArg, ttArg, outDir] = process.argv.slice(2);
const variant = process.env.VARIANT ?? '';
if (!cliArg || !ttArg || !outDir || !VARIANTS.includes(variant)) {
  process.stderr.write(`usage: VARIANT=<${VARIANTS.join('|')}> writecheck.mjs <writecheck-cli> <tiny-tracker-dir> <out-dir>\n`);
  process.exit(2);
}
const cli = resolve(cliArg);
const tt = resolve(ttArg);
const work = mkdtempSync(join(tmpdir(), 'sk-wc-'));
const tok = (p) => `sk-${p}-${randomBytes(16).toString('hex')}`;
const tokens = { TRACKER_BACKEND_TOKEN: tok('b'), TRACKER_CONTROL_TOKEN: tok('c'), TRACKER_EVIDENCE_TOKEN: tok('e') };
for (const v of Object.values(tokens)) mask(v);
let doc;
try {
  const [backendPort, controlPort] = await freePorts(2);
  const base = controlManifest(readFileSync(join(tt, 'writecheck.yaml'), 'utf8'), { cwd: tt, backendPort, controlPort });
  const text = base.replace('env_public: [TRACKER_DEFECTS]', 'env_public: [TRACKER_DEFECTS, TRACKER_SAME_KEY_ANSWER]');
  if (text === base) throw new Error('the control manifest has no env_public line to add TRACKER_SAME_KEY_ANSWER to');
  const manifest = join(work, 'writecheck.yaml');
  writeFileSync(manifest, text);
  const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...tokens, TRACKER_BACKEND_URL: `http://127.0.0.1:${backendPort}`, TRACKER_CONTROL_URL: `http://127.0.0.1:${controlPort}`, TRACKER_SAME_KEY_ANSWER: variant };
  const run = (args) => spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', timeout: 1_500_000, maxBuffer: 64 * 1024 * 1024 });
  const plan = run(['plan', '-m', manifest]);
  const hash = /plan hash: (\S+)/.exec(plan.stdout ?? '')?.[1];
  if (!hash) throw new Error(`plan gave no plan hash (exit ${plan.status}): ${String(plan.stderr).slice(-500)}`);
  const out = join(work, 'out');
  const r = run(['run', '-m', manifest, '--confirm-target', 'tiny-tracker', '--plan-hash', hash, '--out', out, '--state', join(work, 'state')]);
  const file = existsSync(out) ? findResults(out) : null;
  if (!file) throw new Error(`run wrote no results.json (exit ${r.status}): ${String(r.stderr).slice(-500)}`);
  const results = JSON.parse(readFileSync(file, 'utf8'));
  const records = (results.results ?? []).filter((x) => x.scenario?.id === SCENARIO).map((x) => ({
    tool: x.write_path?.tool ?? null, requirement: x.requirement, strict: x.verdict, reason: x.reason, notes: x.notes ?? [], lenient: lenientOf(x),
  }));
  doc = { kind: 'same-key-inflight/writecheck', variant, ok: true, version: results.suite?.version ?? null, exit: r.status, observed: observedOf(results), records };
} catch (e) {
  doc = { kind: 'same-key-inflight/writecheck', variant, ok: false, error: String(e?.message ?? e).slice(0, 1000), records: [] };
} finally {
  rmSync(work, { recursive: true, force: true });
}
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, `wc-${variant}.json`), `${JSON.stringify(doc, null, 1)}\n`);
for (const x of doc.records) process.stdout.write(`writecheck ${variant} ${x.tool}: strict ${x.strict}, lenient ${x.lenient.verdict}\n`);
if (!doc.ok) { process.stderr.write(`writecheck ${variant}: ${doc.error}\n`); process.exit(1); }
