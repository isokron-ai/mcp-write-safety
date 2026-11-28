#!/usr/bin/env node
// Run one defect-matrix cell and write <dir>/cell.json (kind, defect or label, outcome, reason, mode, detected, documented).
// Run from the repository root after tiny-tracker is built: KIND, LABEL or DEFECT in the environment, the directory as the
// argument. Exits 1 when the cell did not hold (the cell.json is written first).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BUILDS, EXPECTED, judgeCell, labelsFor } from './matrix-plan.mjs';
import { MAP_FILE } from './writecheck-expected.mjs';
import { layoutFor, runWritecheck } from './writecheck-run.mjs';

const WC_ITEM = /^MWS-[A-Z0-9]+-[0-9]+:(violated|self-attested-no|platform)$/;
const WC_STATES = new Set(['detected', 'missed', 'not_expected', 'violated', 'clean', 'error', 'not_run']);
const strings = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string' && WC_ITEM.test(x)) : []);

export function cellRecord(env, verdict) {
  const kind = String(env.KIND ?? '');
  if (!['known-good', 'defect'].includes(kind)) throw new Error(`cell kind ${JSON.stringify(kind)} is not known-good or defect`);
  const rec = { kind, outcome: verdict.ok ? 'success' : 'failure' };
  if (kind === 'defect') rec.defect = String(env.DEFECT ?? ''); else rec.label = String(env.LABEL ?? '');
  for (const k of ['reason', 'status', 'mode', 'detected', 'documented']) if (verdict[k] !== undefined) rec[k] = verdict[k];
  // mcp-writecheck's own answer (added 27 Nov): true/false/null for a defect, a boolean for a correct build; the lists are requirement answers only.
  if (typeof verdict.writecheck_detected === 'boolean' || verdict.writecheck_detected === null) rec.writecheck_detected = verdict.writecheck_detected;
  if (typeof verdict.writecheck_clean === 'boolean') rec.writecheck_clean = verdict.writecheck_clean;
  if (verdict.writecheck && WC_STATES.has(verdict.writecheck.state)) {
    const w = verdict.writecheck;
    rec.writecheck = { state: w.state, expected: strings(w.expected), observed: strings(w.observed), missing: strings(w.missing) };
  }
  return rec;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const dir = process.argv[2];
  if (!dir) { process.stderr.write('usage: matrix-cell.mjs <dir>\n'); process.exit(2); }
  const buildsDoc = JSON.parse(readFileSync(BUILDS, 'utf8'));
  const expectedDoc = JSON.parse(readFileSync(EXPECTED, 'utf8'));
  const cell = process.env.KIND === 'defect' ? { kind: 'defect', defect: process.env.DEFECT } : { kind: 'known-good', label: process.env.LABEL };
  let verdict;
  try {
    const labels = labelsFor(cell, buildsDoc);
    const { generate } = await import(new URL(`file://${resolve('examples/tiny-tracker/expected/generate.mjs')}`));
    const doc = await generate({ builds: resolve(BUILDS), only: labels, repeat: 2, jobs: 2 });
    const got = Object.fromEntries(doc.builds.map((b) => [b.label, { build_hash: b.build_hash, fixture: b.fixture }]));
    let writecheck;
    if (process.env.WRITECHECK_CLI) {
      const map = JSON.parse(readFileSync(MAP_FILE, 'utf8'));
      const entry = cell.kind === 'defect' ? map.defects[cell.defect] : null;
      if (cell.kind === 'defect' && !entry) throw new Error(`${cell.defect}: no entry in ${MAP_FILE}`);
      // A backend defect other than lost-update is a fixture-layer defect the demo's build cannot start: it is not run.
      const skip = entry?.layer === 'backend' && entry.expected.length === 0;
      const run = skip ? { skipped: 'backend_fixture_defect' } : await runWritecheck({
        cli: process.env.WRITECHECK_CLI, tinyTracker: 'examples/tiny-tracker',
        defects: entry?.layer === 'mcp' ? [cell.defect] : [], backendDefects: entry?.layer === 'backend' ? [cell.defect] : [],
        layout: layoutFor(cell),
      });
      writecheck = { run, expected: entry };
      process.stdout.write(`writecheck ${JSON.stringify({ layout: layoutFor(cell), ...run })}\n`);
    }
    verdict = judgeCell({ cell, buildsDoc, expectedDoc, got, writecheck });
  } catch (err) {
    verdict = { ok: false, reason: 'error' };
    process.stderr.write(`${String(err?.message ?? err).slice(0, 300)}\n`);
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'cell.json'), `${JSON.stringify(cellRecord(process.env, verdict))}\n`);
  process.stdout.write(`${JSON.stringify(verdict)}\n`);
  process.exit(verdict.ok ? 0 : 1);
}
