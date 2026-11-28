#!/usr/bin/env node
// The simulator's run: every grid cell (model.mjs) and the seeded population, written to <out>/sim.json.
// Usage: node scripts/sim/same-key-inflight/sim.mjs <out-dir>   (POPULATION_RUNS and POPULATION_SEED in the environment)
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BACKOFF_MS, FENCE_LEAD_MS, grid, GRID_DELAYS, population, RETRIES, TIMEOUT_MS } from './model.mjs';

const out = process.argv[2];
if (!out) { process.stderr.write('usage: sim.mjs <out-dir>\n'); process.exit(2); }
const int = (v, def, min, max) => {
  if (v === undefined || v === '') return def;
  if (!/^[0-9]{1,9}$/.test(v) || Number(v) < min || Number(v) > max) { process.stderr.write(`not an integer from ${min} to ${max}: ${JSON.stringify(v)}\n`); process.exit(2); }
  return Number(v);
};
const runs = int(process.env.POPULATION_RUNS, 5000, 100, 100000);
const seed = int(process.env.POPULATION_SEED, 20261127, 0, 2 ** 31);
const doc = {
  kind: 'same-key-inflight/sim',
  constants: { timeout_ms: TIMEOUT_MS, backoff_ms: BACKOFF_MS, retries: RETRIES, fence_lead_ms: FENCE_LEAD_MS, grid_delays_ms: GRID_DELAYS },
  grid: await grid(),
  population: await population({ seed, runs }),
};
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'sim.json'), `${JSON.stringify(doc, null, 1)}\n`);
process.stdout.write(`sim: ${doc.grid.length} grid cells, population ${runs} runs per variant and policy (seed ${seed})\n`);
