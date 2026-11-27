#!/usr/bin/env node
// The cells of the tiny-tracker defect matrix, from the committed 0.4.0 build list and known-answer file, and how one
// defect cell is judged. Pure functions plus a small CLI (`cells`, used by defect-matrix.yml's guard step).
//
// The 0.4.0 list is a pairwise covering set (515 builds). A defect is judged on its single-defect builds (a build whose only
// defect is that one): its fixture answers, run now, must differ from the committed answers of the correct build at the
// same level, or the committed contract answers must differ. A defect with no single-defect build is `combo_only`: it is
// only checked for reproducing its committed rows, and reported as such, never as detected. A defect that is listed in
// the known-answer file's not_detected note is `documented`: an undetected row is expected, not a miss.
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

export const BUILDS = 'examples/tiny-tracker/expected/builds-0.4.0.json';
export const EXPECTED = 'examples/tiny-tracker/expected/0.4.0.json';
const FACTORS = ['mcp', 'backend', 'variant'];

const defectsOf = (b) => FACTORS.filter((k) => b.factors[k] !== '-').map((k) => b.factors[k]);
export const isCorrect = (b) => defectsOf(b).length === 0;

/** The defect names listed by the known-answer file's not_detected note ("Not detected in 0.4.0: a, b, c ..."). */
export function documentedGaps(expectedDoc) {
  const text = String(expectedDoc.not_detected ?? '').replace(/^[^:]*:/, '').split(/[.\n]/)[0];
  return new Set(text.split(',').map((s) => s.trim()).filter((s) => /^[a-z0-9-]+$/.test(s)));
}

/** @returns {{correct: object[], defects: Map<string, {single: object[], all: object[]}>}} */
export function plan(buildsDoc) {
  const correct = buildsDoc.builds.filter(isCorrect);
  const defects = new Map();
  for (const b of buildsDoc.builds) {
    const ds = defectsOf(b);
    for (const d of ds) {
      const o = defects.get(d) ?? { single: [], all: [] };
      o.all.push(b);
      if (ds.length === 1) o.single.push(b);
      defects.set(d, o);
    }
  }
  return { correct, defects };
}

/** The matrix cells for `defects=all`: every correct build against its own row, every distinct defect. */
export function allCells(buildsDoc) {
  const { correct, defects } = plan(buildsDoc);
  return [...correct.map((b) => ({ kind: 'known-good', label: b.label })), ...[...defects.keys()].map((d) => ({ kind: 'defect', defect: d }))];
}

/** The cells for the control set (empty `defects`) or an explicit list. */
export function cellsFor(raw, buildsDoc) {
  if (raw === '') return [{ kind: 'known-good', label: 'L2 correct build' }, { kind: 'defect', defect: 'digest-of-current-state' }];
  if (raw === 'all') return allCells(buildsDoc);
  return [...new Set(raw.split(','))].map((d) => ({ kind: 'defect', defect: d }));
}

/** The labels a cell runs. */
export function labelsFor(cell, buildsDoc) {
  if (cell.kind === 'known-good') return [cell.label];
  const o = plan(buildsDoc).defects.get(cell.defect);
  if (!o) throw new Error(`${cell.defect}: no build in ${BUILDS} carries that defect`);
  return (o.single.length ? o.single : o.all).map((b) => b.label);
}

const level = (b) => b.factors.level;

/**
 * Judge one cell. `got`: label -> {build_hash, fixture} from running the build now; `rows`: label -> committed row
 * (build_hash, fixture, contract).
 * @returns {{ok: boolean, reason?: string, mode?: string, detected?: boolean, documented?: boolean, builds: number}}
 */
export function judgeCell({ cell, buildsDoc, expectedDoc, got }) {
  const rows = Object.fromEntries(expectedDoc.builds.map((r) => [r.label, r]));
  const labels = labelsFor(cell, buildsDoc);
  const byLabel = Object.fromEntries(buildsDoc.builds.map((b) => [b.label, b]));
  for (const l of labels) {
    if (!rows[l]) return { ok: false, reason: 'no_committed_row', builds: labels.length };
    const g = got[l];
    if (!g) return { ok: false, reason: 'not_run', builds: labels.length };
    if (g.build_hash !== rows[l].build_hash || !isDeepStrictEqual(g.fixture, rows[l].fixture)) return { ok: false, reason: 'not_reproduced', builds: labels.length };
  }
  if (cell.kind === 'known-good') return { ok: true, builds: labels.length };
  const o = plan(buildsDoc).defects.get(cell.defect);
  const documented = documentedGaps(expectedDoc).has(cell.defect);
  if (!o.single.length) return { ok: true, mode: 'combo_only', detected: false, documented, builds: labels.length };
  const goodOf = (b) => rows[buildsDoc.builds.find((x) => isCorrect(x) && level(x) === level(b)).label];
  const detected = o.single.some((b) => {
    const g = goodOf(b);
    const r = rows[b.label];
    return !isDeepStrictEqual(got[b.label].fixture, g.fixture) || !isDeepStrictEqual(r.contract ?? null, g.contract ?? null);
  });
  if (!detected && !documented) return { ok: false, reason: 'neutered', mode: 'single', detected, documented, builds: labels.length };
  return { ok: true, mode: 'single', detected, documented, builds: labels.length };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href && process.argv[2] === 'cells') {
  process.stdout.write(JSON.stringify(cellsFor(process.argv[3] ?? '', JSON.parse(readFileSync(BUILDS, 'utf8')))));
}
