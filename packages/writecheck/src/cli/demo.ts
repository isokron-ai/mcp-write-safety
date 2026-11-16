/**
 * `demo`: try the suite on tiny-tracker, the MWS sample server, in about two minutes. It starts
 * tiny-tracker's backend on loopback, runs the shipped manifest (examples/tiny-tracker/
 * writecheck.yaml) against the correct build or a broken one, prints one line per requirement and
 * write path, and stops everything it started. Nothing leaves the machine.
 *
 * Because the demo starts the target itself, on 127.0.0.1, with an in-memory backend it throws away
 * afterwards, it confirms the target and the plan hash itself (and says so). `run` never does.
 *
 * Where tiny-tracker is found, in order: --tiny-tracker <dir>, TINY_TRACKER_DIR, a `tiny-tracker`
 * command on PATH (for example from `npx -p`), and examples/tiny-tracker next to this package in a
 * checkout of the repository. It must be built (dist/src/cli.js).
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { spawnSupervised } from '../core/supervised.js';
import { WritecheckError } from '../core/util.js';
import { REQUIREMENTS, previewSentence } from '../requirements.js';
import { planCommand } from './commands.js';
import { runCommand } from './run.js';

const here = dirname(fileURLToPath(import.meta.url));

function onPath(cmd: string): string | null {
  for (const d of (process.env['PATH'] ?? '').split(delimiter)) {
    const f = join(d, cmd);
    if (existsSync(f)) return f;
  }
  return null;
}

/** The tiny-tracker build to use, or a clear error saying how to get one. */
export function findTinyTracker(given: string | undefined, env: NodeJS.ProcessEnv): string {
  const tries: string[] = [];
  const ok = (d: string) => existsSync(join(d, 'dist', 'src', 'cli.js'));
  for (const d of [given, env['TINY_TRACKER_DIR']]) {
    if (!d) continue;
    tries.push(d);
    if (ok(resolve(d))) return resolve(d);
  }
  const bin = onPath('tiny-tracker');
  if (bin) {
    // why: the bin is <package>/dist/src/cli.js behind a link; the package folder is three levels up.
    const d = resolve(dirname(realpathSync(bin)), '..', '..');
    tries.push(d);
    if (ok(d)) return d;
  }
  // A checkout: packages/writecheck/dist/src/cli → ../../../../examples/tiny-tracker
  const repo = resolve(here, '..', '..', '..', '..', '..', 'examples', 'tiny-tracker');
  tries.push(repo);
  if (ok(repo)) return repo;
  throw new WritecheckError(`tiny-tracker is not built where the demo looked (${tries.join(', ')}). In a checkout: (cd examples/tiny-tracker && npm ci && npm run build). Or pass --tiny-tracker <dir>.`, 2);
}

/** The manifest the demo runs: the shipped one, with its working folder pointed at the tiny-tracker build. */
function demoManifest(ttDir: string, dir: string, shipped: string | null): string {
  // The tiny-tracker package's own copy, this package's copy (made at pack time), or a checkout's.
  const src = shipped ?? [join(ttDir, 'writecheck.yaml'), resolve(here, '..', '..', '..', 'examples', 'tiny-tracker.yaml'), resolve(here, '..', '..', '..', '..', '..', 'examples', 'tiny-tracker', 'writecheck.yaml')].find((f) => existsSync(f));
  if (!src) throw new WritecheckError(`no writecheck.yaml next to ${ttDir} or in this checkout's examples/tiny-tracker`, 2);
  const out = join(dir, 'writecheck.yaml');
  writeFileSync(out, readFileSync(src, 'utf8').replace(/^  cwd: .*$/m, `  cwd: ${JSON.stringify(ttDir)}`));
  return out;
}

export async function demoCommand(o: { tinyTracker?: string; defects: string[]; manifest?: string; out: string; env: NodeJS.ProcessEnv; log: (s: string) => void; verbose?: boolean }): Promise<number> {
  const tt = findTinyTracker(o.tinyTracker, o.env);
  const token = `demo-${randomBytes(16).toString('hex')}`;
  const work = mkdtempSync(join(tmpdir(), 'mwsc-demo-'));
  const backend = spawnSupervised(process.execPath, [join(tt, 'dist', 'src', 'cli.js'), 'backend', '--port', '0'], { env: { PATH: o.env['PATH'] ?? '', HOME: o.env['HOME'] ?? '', TRACKER_BACKEND_TOKEN: token }, cwd: null, stdin: 'ignore' });
  try {
    const first = await new Promise<string>((res, rej) => {
      const t = setTimeout(() => rej(new WritecheckError('tiny-tracker\'s backend did not start within 15 s', 4)), 15_000);
      createInterface({ input: backend.proc.stdout! }).once('line', (l) => (clearTimeout(t), res(l)));
      backend.proc.once('exit', (c) => rej(new WritecheckError(`tiny-tracker's backend exited (${c}) before it was ready`, 4)));
    });
    const url = (JSON.parse(first) as { backend: string }).backend;
    const manifest = demoManifest(tt, work, o.manifest ?? null);
    const env: NodeJS.ProcessEnv = { PATH: o.env['PATH'], HOME: o.env['HOME'], TRACKER_BACKEND_URL: url, TRACKER_BACKEND_TOKEN: token, ...(o.defects.length ? { TRACKER_DEFECTS: o.defects.join(',') } : {}) };
    o.log(`tiny-tracker ${o.defects.length ? `with defects: ${o.defects.join(', ')}` : '(correct build)'} — backend ${url}, MCP server started by the tester behind the loopback gate`);
    const { hash } = await planCommand({ manifest, env, log: () => {} });
    o.log(`plan ${hash}; the demo confirms the target itself because it started it (on 127.0.0.1, in memory). \`run\` always asks.`);
    const t0 = Date.now();
    const r = await runCommand({ manifest, outRoot: o.out, stateDir: join(work, 'state'), confirmTarget: 'tiny-tracker', planHash: hash, interactive: false, env, log: o.verbose ? o.log : () => {}, noSignals: false });
    o.log('');
    for (const req of REQUIREMENTS) {
      const recs = r.doc.results.filter((x) => x.requirement === req.id);
      const where = (v: string) => [...new Set(recs.filter((x) => x.verdict === v).map((x) => `${x.write_path.resource}:${x.write_path.tool}`))];
      const violated = where('violated');
      const no = [...new Set(recs.filter((x) => x.verdict === 'self-attested' && x.numbers['answer'] === false).map((x) => `${x.write_path.resource}:${x.write_path.tool}`))];
      const verdicts = [...new Set(recs.map((x) => x.verdict))];
      const line = violated.length ? `violated in ${violated.join(', ')}` : recs.length ? verdicts.join(', ') : 'no record';
      o.log(`${req.id.padEnd(12)} ${req.level.padEnd(6)} ${line}${no.length ? `; review answer "no" in ${no.join(', ')}` : ''}`);
    }
    o.log('');
    o.log(`${r.doc.results.length} records in ${((Date.now() - t0) / 1000).toFixed(1)} s. One line per requirement; the report has one row per write path. There is no total.`);
    o.log(previewSentence());
    o.log(`report: ${r.outDir}/report.md`);
    if (r.doc.leftovers.length) o.log(`${r.doc.leftovers.length} object(s) were left behind in the demo's backend (it is in memory and stops now).`);
    return r.exit;
  } finally {
    backend.term();
    await new Promise((res) => setTimeout(res, 300));
    backend.kill();
    rmSync(work, { recursive: true, force: true });
  }
}
