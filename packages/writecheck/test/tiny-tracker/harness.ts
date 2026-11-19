/**
 * Runs the suite against the real sample server, tiny-tracker (examples/tiny-tracker), when it is
 * built: in this repository once its branch is merged, or wherever TINY_TRACKER_DIR points. The
 * manifest is the shipped one (examples/tiny-tracker/writecheck.yaml); the harness starts the
 * backend (`tiny-tracker backend`), and the tester itself starts the MCP server from the manifest,
 * behind the loopback gate.
 */

import { assertViolationsHaveSteps } from '../steps-lint.js';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { planCommand } from '../../src/cli/commands.js';
import { runCommand, type RunOutcome } from '../../src/cli/run.js';
import { spawnSupervised, type Supervised } from '../../src/core/supervised.js';

const here = dirname(fileURLToPath(import.meta.url));
/** The shipped manifest, in this repository. */
export const TT_MANIFEST = resolve(here, '..', '..', '..', '..', '..', 'examples', 'tiny-tracker', 'writecheck.yaml');

export function tinyTrackerDir(): string | null {
  const candidates = [process.env['TINY_TRACKER_DIR'], dirname(TT_MANIFEST)].filter((x): x is string => !!x);
  for (const c of candidates) if (existsSync(join(c, 'dist', 'src', 'cli.js'))) return resolve(c);
  return null;
}

/** The shipped manifest with `cwd` pointed at a tiny-tracker build elsewhere (the branch is not merged here yet), and optional limit overrides. */
export function manifestFor(ttDir: string, o: { pairs?: number; gateReps?: number; staleReps?: number; extra?: (text: string) => string } = {}): string {
  let text = readFileSync(TT_MANIFEST, 'utf8').replace(/^  cwd: \..*$/m, `  cwd: ${JSON.stringify(ttDir)}`);
  if (o.pairs !== undefined) text = text.replace(/pairs: \d+/, `pairs: ${o.pairs}`);
  if (o.gateReps !== undefined) text = text.replace(/gate_reps: \d+/, `gate_reps: ${o.gateReps}`);
  if (o.staleReps !== undefined) text = text.replace(/stale_reps: \d+/, `stale_reps: ${o.staleReps}`);
  return o.extra ? o.extra(text) : text;
}

export interface TT {
  backend: Supervised;
  url: string;
  dir: string;
  manifest: string;
  env: NodeJS.ProcessEnv;
  close(): Promise<void>;
}

/** Start tiny-tracker's backend (correct, or with a backend defect) and write the manifest for a run. */
export async function startTinyTracker(ttDir: string, o: { defects?: string[]; backendDefect?: string; pairs?: number; gateReps?: number; staleReps?: number; protocol?: string; gate?: 'node_import'; variants?: string[]; edit?: (text: string) => string } = {}): Promise<TT> {
  const token = `tt-test-${randomBytes(12).toString('hex')}`;
  const args = [join(ttDir, 'dist', 'src', 'cli.js'), 'backend', '--port', '0', ...(o.backendDefect ? ['--backend-defect', o.backendDefect] : [])];
  const backend = spawnSupervised(process.execPath, args, { env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '', TRACKER_BACKEND_TOKEN: token }, cwd: null, stdin: 'ignore' });
  const first = await new Promise<string>((res, rej) => {
    const t = setTimeout(() => rej(new Error('tiny-tracker backend did not start')), 15_000);
    createInterface({ input: backend.proc.stdout! }).once('line', (l) => (clearTimeout(t), res(l)));
    backend.proc.once('exit', (c) => rej(new Error(`tiny-tracker backend exited ${c}`)));
  });
  const url = (JSON.parse(first) as { backend: string }).backend;
  const dir = mkdtempSync(join(tmpdir(), 'mwsc-tt-'));
  const manifest = join(dir, 'writecheck.yaml');
  const extra = (t: string) => {
    let x = o.protocol ? t.replace('  processes: separate', `  processes: separate\n  protocol: "${o.protocol}"`) : t;
    if (o.gate === 'node_import') x = x.replace('  gate: { rewrite_env: TRACKER_BACKEND_URL }', '  gate: { node_import: true }');
    return o.edit ? o.edit(x) : x;
  };
  writeFileSync(manifest, manifestFor(ttDir, { ...o, extra }));
  return {
    backend,
    url,
    dir,
    manifest,
    env: { PATH: process.env['PATH'], HOME: process.env['HOME'], TRACKER_BACKEND_URL: url, TRACKER_BACKEND_TOKEN: token, ...(o.defects?.length ? { TRACKER_DEFECTS: o.defects.join(',') } : {}), ...(o.variants?.length ? { TRACKER_VARIANTS: o.variants.join(','), TRACKER_KEY_JOURNAL: join(dir, 'keys.journal') } : {}) },
    async close() {
      backend.term();
      await new Promise((r) => setTimeout(r, 200));
      backend.kill();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function runTT(t: TT, log: (s: string) => void = () => {}): Promise<RunOutcome> {
  const { hash } = await planCommand({ manifest: t.manifest, env: t.env, log: () => {} });
  const r = await runCommand({ manifest: t.manifest, outRoot: join(t.dir, 'out'), stateDir: join(t.dir, 'state'), confirmTarget: 'tiny-tracker', planHash: hash, interactive: false, env: t.env, log, noSignals: true });
  // why: review R2 (lane F1): no violated record without its trace steps, unless its evidence is not a call trace.
  assertViolationsHaveSteps(r.doc);
  return r;
}
