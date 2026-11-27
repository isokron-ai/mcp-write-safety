#!/usr/bin/env node
// Build the tool-qa result bundle of one defect-matrix run (t0-defects lane).
//
//   node scripts/ci/t0-bundle.mjs --cells <dir with the cells' cell.json> --out <dir>
//   env: CELLS (the matrix as t0-start built it, JSON), GITHUB_SHA, GITHUB_REPOSITORY
//
// Writes <out>/bundle/results/matrix.json (every cell and its outcome) and <out>/meta.json (worker-kit meta file).
// Controls: known_good (every correct build matched its committed row) and known_bad (every defect build
// matched its row, so its answers still tell it from the correct build). A control that did not hold is
// rejected by tool-qa's ingest as control_failed, which is a lead against OUR tool, never a subject fault.
// A cell that left no result counts as `incomplete`, never as caught.
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SUBJECT_ID = 'isokron-ai/mcp-write-safety.defect-matrix';

const keyOf = (c) => `${c.kind}|${c.defect ?? c.label}`;

/** Read every cell.json under dir (one per downloaded cell artifact). */
export function readCells(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const f = e.isDirectory() ? join(dir, e.name, 'cell.json') : e.name === 'cell.json' ? join(dir, e.name) : null;
    if (!f) continue;
    try { out.push(JSON.parse(readFileSync(f, 'utf8'))); } catch { /* an unreadable cell is incomplete */ }
  }
  return out;
}

/** What each expected cell did: success, failure, or incomplete (no result, or a result that is not success/failure). */
export function judge(expected, found) {
  const byKey = new Map(found.map((c) => [keyOf(c), c]));
  return expected.map((c) => {
    const f = byKey.get(keyOf(c));
    const outcome = f?.outcome === 'success' || f?.outcome === 'failure' ? f.outcome : 'incomplete';
    return { ...c, outcome };
  });
}

const controlOf = (cells, kind, expected, good, bad) => {
  const mine = cells.filter(kind);
  if (mine.length === 0) return null;
  const observed = mine.every((c) => c.outcome === 'success') ? expected : mine.some((c) => c.outcome === 'incomplete') ? 'incomplete' : bad;
  return { kind: good, expected, observed };
};

export function build({ expected, found, env = process.env, now = new Date() }) {
  const cells = judge(expected, found);
  const controls = [
    controlOf(cells, (c) => c.kind === 'known-good', 'match', 'known_good', 'differs'),
    controlOf(cells, (c) => c.kind === 'defect' || c.kind === 'known-bad', 'all_caught', 'known_bad', 'missed'),
  ].filter(Boolean);
  const sha = /^[0-9a-f]{40}$/.test(env.GITHUB_SHA ?? '') ? env.GITHUB_SHA : null;
  const repo = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPOSITORY ?? '') ? env.GITHUB_REPOSITORY : 'isokron-ai/mcp-write-safety';
  const at = now.toISOString().replace(/\.\d+Z$/, 'Z');
  return {
    matrix: { lane: 't0-defects', cells, missed: cells.filter((c) => c.kind !== 'known-good' && c.outcome !== 'success').map((c) => c.defect ?? c.label) },
    meta: {
      subject: { id: SUBJECT_ID, repo, sha },
      tools: [{ name: repo.split('/')[1], version: sha ?? 'unknown' }],
      oracles: [],
      settings_manifest_digest: createHash('sha256').update(JSON.stringify(expected)).digest('hex'),
      started_at: at,
      finished_at: at,
      skips: [],
      controls,
    },
  };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
  const cellsDir = arg('--cells');
  const out = arg('--out');
  if (!cellsDir || !out) { process.stderr.write('usage: t0-bundle.mjs --cells <dir> --out <dir>\n'); process.exit(2); }
  const { matrix, meta } = build({ expected: JSON.parse(process.env.CELLS ?? '[]'), found: readCells(cellsDir) });
  mkdirSync(join(out, 'bundle', 'results'), { recursive: true });
  writeFileSync(join(out, 'bundle', 'results', 'matrix.json'), `${JSON.stringify(matrix, null, 2)}\n`);
  writeFileSync(join(out, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  process.stdout.write(`${matrix.cells.length} cells, ${matrix.missed.length} missed or incomplete: ${meta.controls.map((c) => `${c.kind} ${c.observed}`).join(', ')}\n`);
}
