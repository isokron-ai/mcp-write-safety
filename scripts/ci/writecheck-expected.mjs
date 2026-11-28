#!/usr/bin/env node
// The expected mcp-writecheck answer of every tiny-tracker defect, for the defect matrix (defect-matrix.yml).
//
// builds-0.4.0.json carries no per-defect expectation (only the factors of each build), so this map is added. It is
// derived, never typed in: each MCP-layer defect's `requirement` is read from its own source file
// (examples/tiny-tracker/src/defects/<name>.ts, the field the README's defect table and the self-test check), and each
// backend defect's `context` from examples/tiny-tracker/src/backend/defects/<name>.ts. The few places where
// mcp-writecheck's answer is not "that requirement is violated" are the OVERRIDES below, each with its reason.
//
//   node scripts/ci/writecheck-expected.mjs --write   regenerate examples/tiny-tracker/expected/writecheck-expected-0.4.0.json
//   node scripts/ci/writecheck-expected.mjs --check   exit 1 when the committed file differs from the sources
//
// An expected entry is "<requirement>:<answer>", where the answer is what mcp-writecheck gives for that requirement:
//   violated            the verdict `violated` in some record
//   self-attested-no    a review-only clause answered "no" (verdict self-attested, answer false)
//   platform            the verdict `platform` (the platform loses it too)
// An empty list means mcp-writecheck is not expected to say anything about the defect; the cell then only records what it saw.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const MAP_FILE = 'examples/tiny-tracker/expected/writecheck-expected-0.4.0.json';
const TT = 'examples/tiny-tracker/src';

/** Where the answer is not "violated", or is not expected at all. Each carries the reason (and where it is stated). */
export const OVERRIDES = {
  'lookup-reexecutes': { expected: [], reason: 'examples/tiny-tracker/README.md (defect table, Requires table): detected by fx-check (FX-LOOK-2); writecheck does not observe it yet, because the re-executed write creates a new object outside the one MWS-ANN-1 watches' },
  'stale-unannounced': { expected: ['MWS-CONC-5:self-attested-no'], reason: 'examples/tiny-tracker/README.md (self-test section): MWS-CONC-5 is a review-only clause, recorded as self-attested: no' },
  'conflict-as-generic-error': { expected: ['MWS-CONC-6:self-attested-no'], reason: 'examples/tiny-tracker/README.md (self-test section): MWS-CONC-6 is a review-only clause, recorded as self-attested: no' },
  'lost-update': { expected: ['MWS-CONC-3:platform'], reason: 'examples/tiny-tracker/README.md (The platform verdict): the backend loses the update too, so the answer is platform, not violated' },
};
const BACKEND_FIXTURE_REASON = 'a backend defect of the fixture layer (digest, key record, lookup, journal, expiry): its context is a fixture property (FX-), not an MWS requirement of the MCP layer, and mcp-writecheck\'s demo cannot start it. It is judged by the fixture and contract rows only';


/** The MCP-layer defects of the sources: name -> requirement. */
export function mcpDefects(dir = root) {
  const out = {};
  for (const f of readdirSync(join(dir, TT, 'defects')).sort()) {
    if (!f.endsWith('.ts') || f === 'index.ts' || f === 'types.ts') continue;
    const src = readFileSync(join(dir, TT, 'defects', f), 'utf8');
    const m = /name:\s*"([a-z0-9-]+)",\s*\n\s*requirement:\s*"(MWS-[A-Z0-9-]+)"/.exec(src);
    if (!m || `${m[1]}.ts` !== f) throw new Error(`${f}: no name and requirement found, or the name is not the file's`);
    out[m[1]] = m[2];
  }
  return out;
}

/** The backend defects of the sources: name -> context (an MWS requirement for lost-update, else a fixture property). */
export function backendDefects(dir = root) {
  const out = {};
  for (const f of readdirSync(join(dir, TT, 'backend', 'defects')).sort()) {
    if (!f.endsWith('.ts') || f === 'index.ts') continue;
    const src = readFileSync(join(dir, TT, 'backend', 'defects', f), 'utf8');
    const m = /name:\s*"([a-z0-9-]+)"[\s\S]*?context:\s*"([A-Z0-9-]+)"/.exec(src);
    if (!m || `${m[1]}.ts` !== f) throw new Error(`${f}: no name and context found, or the name is not the file's`);
    out[m[1]] = m[2];
  }
  return out;
}

export function buildMap(dir = root) {
  const defects = {};
  for (const [name, requirement] of Object.entries(mcpDefects(dir))) {
    defects[name] = { layer: 'mcp', source: `${TT}/defects/${name}.ts`, expected: [`${requirement}:violated`] };
  }
  for (const [name, context] of Object.entries(backendDefects(dir))) {
    defects[name] = { layer: 'backend', source: `${TT}/backend/defects/${name}.ts`, expected: [], reason: BACKEND_FIXTURE_REASON, context };
  }
  for (const [name, o] of Object.entries(OVERRIDES)) {
    if (!defects[name]) throw new Error(`override for ${name}, which no source file defines`);
    const { reason, expected } = o;
    defects[name] = { ...defects[name], expected, reason };
    if (defects[name].layer === 'backend') delete defects[name].context;
  }
  const sorted = Object.fromEntries(Object.keys(defects).sort().map((k) => [k, defects[k]]));
  return {
    release: '0.4.0',
    note: 'Expected mcp-writecheck answer per defect, for the defect matrix. Generated by scripts/ci/writecheck-expected.mjs from the defects\' own source files (examples/tiny-tracker/src/defects/*.ts: requirement; src/backend/defects/*.ts: context) plus its OVERRIDES. builds-0.4.0.json carries no such metadata. Do not edit by hand.',
    answers: { violated: 'verdict violated', 'self-attested-no': 'review-only clause answered no', platform: 'verdict platform' },
    defects: sorted,
  };
}

const text = (m) => `${JSON.stringify(m, null, 2)}\n`;

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const want = text(buildMap());
  if (process.argv.includes('--write')) writeFileSync(join(root, MAP_FILE), want);
  else if (process.argv.includes('--check')) {
    if (readFileSync(join(root, MAP_FILE), 'utf8') !== want) { process.stderr.write(`${MAP_FILE} differs from the defect sources; run --write\n`); process.exit(1); }
  } else { process.stderr.write('usage: writecheck-expected.mjs --write|--check\n'); process.exit(2); }
}
