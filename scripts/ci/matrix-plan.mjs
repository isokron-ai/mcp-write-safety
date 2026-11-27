#!/usr/bin/env node
// The cells of the tiny-tracker defect matrix, from the committed 0.4.0 build list and known-answer file, and how one
// defect cell is judged. Pure functions plus a small CLI (`cells`, used by defect-matrix.yml's guard step).
//
// The 0.4.0 list is a pairwise covering set (515 builds). A defect is judged on its single-defect builds (a build whose only
// defect is that one): its fixture answers, run now, must differ from the committed answers of the correct build at the
// same level. (The committed contract answers are compared only when both rows have one, and a difference only there is
// reported as `committed_contract`: it was not run here, so it is not detection.) A defect with no single-defect build is
// `combo_only`: it is only checked for reproducing its committed rows, and reported as such, never as detected. A defect that is listed in
// the known-answer file's not_detected note is `documented`: an undetected row is expected, not a miss.
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

export const BUILDS = 'examples/tiny-tracker/expected/builds-0.4.0.json';
export const EXPECTED = 'examples/tiny-tracker/expected/0.4.0.json';
// Defects are the mcp and backend factors. A `variant` is a correct alternative (a different key store, say), never a defect, so
// it is not a defect of the matrix; a build with a variant is not a pure single-defect build either.
const FACTORS = ['mcp', 'backend'];

const defectsOf = (b) => FACTORS.filter((k) => b.factors[k] !== '-').map((k) => b.factors[k]);
/** The plain correct build of a level: no defect and no variant. */
export const isCorrect = (b) => defectsOf(b).length === 0 && b.factors.variant === '-';

/** The defect names listed by the known-answer file's not_detected note ("Not detected in 0.4.0: a, b, c ..."). */
export function documentedGaps(expectedDoc) {
  // "Not detected in 0.4.0: a, b, c give exactly the correct build's answers ...": the list runs up to the verb.
  const text = String(expectedDoc.not_detected ?? '').replace(/^[^:]*:/, '').split(/ give exactly| give the same|\n/)[0];
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
      if (ds.length === 1 && b.factors.variant === '-') o.single.push(b);
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
 * @returns {{ok: boolean, reason?: string, status?: string, mode?: string, detected?: boolean, documented?: boolean, builds: number}}
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
  const base = { builds: labels.length, documented };
  // status: what the cell says about the defect. Only detected and documented satisfy the matrix's known_bad control;
  // combo_only and committed_contract are reported on their own and never count as detection (R-DM-08, R-DM-15).
  if (!o.single.length) return { ok: true, status: 'combo_only', mode: 'combo_only', detected: false, ...base };
  const goodOf = (b) => rows[buildsDoc.builds.find((x) => isCorrect(x) && level(x) === level(b)).label];
  const detected = o.single.some((b) => !isDeepStrictEqual(got[b.label].fixture, goodOf(b).fixture));
  // The contract answers are committed, not run here: compared only when BOTH rows have one.
  const committedContract = !detected && o.single.some((b) => {
    const r = rows[b.label].contract;
    const g = goodOf(b).contract;
    return r != null && g != null && !isDeepStrictEqual(r, g);
  });
  if (detected) return { ok: true, status: 'detected', mode: 'single', detected: true, ...base };
  if (documented) return { ok: true, status: 'documented', mode: 'single', detected: false, ...base };
  if (committedContract) return { ok: true, status: 'committed_contract', mode: 'single', detected: false, ...base };
  return { ok: false, reason: 'neutered', status: 'neutered', mode: 'single', detected: false, ...base };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href && process.argv[2] === 'cells') {
  process.stdout.write(JSON.stringify(cellsFor(process.argv[3] ?? '', JSON.parse(readFileSync(BUILDS, 'utf8')))));
}
