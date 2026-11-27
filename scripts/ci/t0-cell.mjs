#!/usr/bin/env node
// Write one defect-matrix cell's result: <dir>/cell.json = { kind, label?, defect?, outcome }.
// Used by .github/workflows/defect-matrix.yml after each cell's known-answer check; scripts/ci/t0-bundle.mjs
// collects them. Takes KIND, LABEL, DEFECT and OUTCOME (the check step's outcome) from the environment.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function cellRecord(env) {
  const kind = String(env.KIND ?? '');
  if (!['known-good', 'known-bad', 'defect'].includes(kind)) throw new Error(`cell kind ${JSON.stringify(kind)} is not known-good, known-bad or defect`);
  const outcome = ['success', 'failure', 'cancelled', 'skipped'].includes(env.OUTCOME) ? env.OUTCOME : 'unknown';
  const rec = { kind, outcome };
  if (kind === 'defect') rec.defect = String(env.DEFECT ?? '');
  else rec.label = String(env.LABEL ?? '');
  return rec;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const dir = process.argv[2];
  if (!dir) { process.stderr.write('usage: t0-cell.mjs <dir>\n'); process.exit(2); }
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'cell.json'), `${JSON.stringify(cellRecord(process.env))}\n`);
}
