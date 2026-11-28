#!/usr/bin/env node
// The defect matrix in min mode (defect-matrix.yml input mode=min): mcp-writecheck's `min` command run against the built
// tiny-tracker, with its backend replaced by the mock made from examples/tiny-tracker/openapi.yaml, and the answer judged
// against what min mode may say (packages/writecheck/src/min/requirements-min.json):
//
//   a defect whose requirement min mode judges (run, partial)   detected when that requirement is violated (or, for a
//                                                               review-only clause, self-attested: no)
//   a defect whose requirement needs real backend semantics     detected when that requirement comes out not_testable_mock
//   (not_testable_mock; and the in-flight RES-1/RES-2 forms)     (never held, never violated)
//   a correct build                                             clean: no violated record, no review answer "no"
//
// The CLI itself refuses a document that holds or violates a not_testable_mock requirement (exit 4), so such a run is an
// error here, never a pass. No secrets: the server gets canaries made by the CLI.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const MIN_FILE = 'packages/writecheck/src/min/requirements-min.json';
/** The in-flight forms (feature inflight): concurrency defects whatever their requirement's area. */
export const INFLIGHT = new Set(['in-progress-reported-not-applied', 'settle-miss-reported-not-applied']);

export function minStatuses(dir = root) {
  const doc = JSON.parse(readFileSync(join(dir, MIN_FILE), 'utf8'));
  return Object.fromEntries(Object.entries(doc.requirements).map(([k, v]) => [k, v.min]));
}

/** What min mode must report for one defect's entry of writecheck-expected-0.4.0.json ([] where nothing is expected). */
export function minExpected(defect, entry, statuses = minStatuses()) {
  if (!entry || !entry.expected.length) return [];
  return entry.expected.map((x) => {
    const [req, answer] = x.split(':');
    if (INFLIGHT.has(defect) || statuses[req] === 'not_testable_mock' || answer === 'platform') return `${req}:not_testable_mock`;
    return `${req}:${answer}`;
  });
}

/** What a min-mode results.json says: violated and review "no" answers, and the requirements capped as not_testable_mock. */
export function readMin(doc) {
  if (doc?.format !== 'mws-min-results/1' || doc?.mode !== 'min') throw new Error('not a min-mode results.json');
  const observed = new Set();
  const capped = new Set();
  for (const r of doc.results ?? []) {
    if (r.verdict === 'violated') observed.add(`${r.requirement}:violated`);
    if (r.verdict === 'self-attested' && r.answer === false) observed.add(`${r.requirement}:self-attested-no`);
    if (r.status === 'not_testable_mock' && r.verdict === 'not tested') capped.add(r.requirement);
  }
  return { observed: [...observed].sort(), capped: [...capped].sort() };
}

/**
 * Judge one min-mode run, in the shape judgeWritecheck gives (matrix-plan.mjs), so the cell and the bundle read it the same way.
 * `defect` null for a correct build.
 */
export function judgeMin({ run, expected, defect = null }) {
  const want = expected ? minExpected(defect, expected) : [];
  if (!run || run.skipped) return { state: 'not_run', expected: want, observed: [], missing: [], extra: [] };
  if (!run.ok) return { state: 'error', expected: want, observed: [], missing: [], extra: [] };
  const verdicts = run.observed;
  const seen = [...verdicts, ...run.capped.map((r) => `${r}:not_testable_mock`)];
  if (!expected) return { state: verdicts.length ? 'violated' : 'clean', expected: [], observed: verdicts, missing: [], extra: verdicts };
  if (!want.length) return { state: 'not_expected', expected: want, observed: verdicts, missing: [], extra: verdicts };
  const has = (w) => seen.includes(w) || (w.endsWith(':violated') && seen.includes(w.replace(/:violated$/, ':self-attested-no'))) || (w.endsWith(':self-attested-no') && seen.includes(w.replace(/:self-attested-no$/, ':violated')));
  const missing = want.filter((w) => !has(w));
  return { state: missing.length ? 'missed' : 'detected', expected: want, observed: seen.filter((s) => want.includes(s) || !s.endsWith(':not_testable_mock')), missing, extra: verdicts.filter((v) => !want.includes(v)) };
}

/**
 * Run `mcp-writecheck min` against the built tiny-tracker.
 * @returns {Promise<{ok: true, observed: string[], capped: string[], records: number, spec_sha256: string, faults: number} | {ok: false, error: string}>}
 */
export async function runMinCell(o) {
  const cli = resolve(o.cli);
  const tt = resolve(o.tinyTracker);
  const work = mkdtempSync(join(tmpdir(), 'dm-min-'));
  try {
    const args = [cli, 'min', '--spec', join(tt, 'openapi.yaml'), '--spec-url', 'https://github.com/isokron-ai/mcp-write-safety/blob/main/examples/tiny-tracker/openapi.yaml',
      '--base-url-env', 'TRACKER_BACKEND_URL', '--env', 'TRACKER_BACKEND_TOKEN', '--declaration', join(tt, 'writecheck.yaml'), '--out', join(work, 'out'), '--cwd', tt,
      ...(o.defects?.length ? ['--set', `TRACKER_DEFECTS=${o.defects.join(',')}`] : []), '--', process.execPath, join(tt, 'dist', 'src', 'cli.js'), 'stdio'];
    const r = spawnSync(process.execPath, args, { env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' }, encoding: 'utf8', timeout: o.timeoutMs ?? 900_000, maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0 && r.status !== 1) return { ok: false, error: `min exited ${r.status}: ${String(r.stderr).slice(-300)}` };
    const doc = JSON.parse(readFileSync(join(work, 'out', 'results.json'), 'utf8'));
    return { ok: true, ...readMin(doc), records: doc.results.length, spec_sha256: doc.spec.sha256, faults: doc.faults_injected.length };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 300) };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
