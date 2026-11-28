#!/usr/bin/env node
// Run mcp-writecheck (the CLI built from packages/writecheck in the same job) against the built tiny-tracker, and say which
// requirements it reports. Used by matrix-cell.mjs; no secrets: the backend token is made here and lives for the run.
//
// It does what `mcp-writecheck demo` does (start tiny-tracker's backend on 127.0.0.1, point the shipped manifest at the build,
// plan, confirm the target and the plan hash, run) with the one thing the demo cannot do: pass a backend defect. The build
// is the release default profile, backend and server as separate processes, as in expected/generate.mjs --writecheck.
//
// The control layout (R-DM-26..28), only for the defects in CONTROL_LAYOUT_DEFECTS: `tiny-tracker all --fixture-control` with
// the faults feature, its backend and control listener on loopback ports picked here, no gate. writecheck's same-key scenario
// (MWS-RES-2) arms backend/before-commit/delay there to hold the first keyed create inside the backend; the separate layout has
// no control listener, so that scenario is not tested in it. The control and evidence tokens are made here, masked in the
// Actions log, and live for the run.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';

/**
 * What a results.json says, as "<requirement>:<answer>" strings (sorted, each once): violated, self-attested-no (a review-only
 * clause answered no) and platform. Everything else (held, not tested, ...) is not listed.
 */
export function observedOf(doc) {
  const seen = new Set();
  for (const r of doc.results ?? []) {
    if (r.verdict === 'violated') seen.add(`${r.requirement}:violated`);
    else if (r.verdict === 'platform') seen.add(`${r.requirement}:platform`);
    else if (r.verdict === 'self-attested' && r.numbers?.answer === false) seen.add(`${r.requirement}:self-attested-no`);
  }
  return [...seen].sort();
}

function findResults(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { const f = findResults(p); if (f) return f; } else if (e.name === 'results.json') return p;
  }
  return null;
}

/** The defects whose cell runs in the control layout: they need a write held inside the backend (writecheck inflight.same-key). */
export const CONTROL_LAYOUT_DEFECTS = new Set(['in-progress-reported-not-applied']);

/** The layout a cell's writecheck run uses: 'control' for the defects above, 'separate' for every other cell. */
export const layoutFor = (cell) => (cell?.kind === 'defect' && CONTROL_LAYOUT_DEFECTS.has(cell.defect) ? 'control' : 'separate');

/**
 * The shipped manifest edited for the control layout: one `tiny-tracker all --fixture-control` process with the faults feature
 * on the given loopback ports, the control and evidence tokens passed through, the backend URL kept from the server (in `all`
 * it runs its own backend; the tester alone reads it), and no gate, restart step or launch settings (a second process would
 * want the same ports). Throws when the shipped manifest no longer has a line this edits, so a drift is an error, never a
 * quiet run in the wrong layout.
 */
export function controlManifest(text, { cwd, backendPort, controlPort }) {
  const edits = [
    [/^ {2}cwd: .*$/m, `  cwd: ${JSON.stringify(cwd)}`],
    [/command: \[node, dist\/src\/cli\.js, server, --port, "0"\]/, `command: [node, dist/src/cli.js, all, --port, "0", --backend-port, "${backendPort}", --fixture-control, --control-port, "${controlPort}", --features, "evidence,strict-input,ledger,faults"]`],
    ['env_passthrough: [TRACKER_BACKEND_TOKEN]', 'env_passthrough: [TRACKER_BACKEND_TOKEN, TRACKER_CONTROL_TOKEN, TRACKER_EVIDENCE_TOKEN]'],
    ['env_public: [TRACKER_BACKEND_URL, TRACKER_DEFECTS, TRACKER_VARIANTS, TRACKER_KEY_JOURNAL]', 'env_public: [TRACKER_DEFECTS]'],
    [/^ {2}restart: .*$/m, ''],
    [/^ {2}gate: \{ rewrite_env: TRACKER_BACKEND_URL \}$/m, ''],
    [/\nsettings:\n( {2}.*\n)+?( {2}tool_filters:\n( {4}- .*\n)+)/, '\n'],
  ];
  let out = text;
  for (const [from, to] of edits) {
    const next = out.replace(from, to);
    if (next === out) throw new Error(`the control layout cannot edit the shipped manifest: ${String(from).slice(0, 80)} not found`);
    out = next;
  }
  if (!/inflight_hold: \{ fixture: fixture-api\/1, control_env: TRACKER_CONTROL_URL, token_env: TRACKER_CONTROL_TOKEN/.test(out)) throw new Error('the shipped manifest declares no backend.inflight_hold on TRACKER_CONTROL_URL / TRACKER_CONTROL_TOKEN');
  return out;
}

async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  await new Promise((r) => s.close(() => r()));
  return p;
}

/** Mask a value in the Actions log (a workflow command; outside Actions it is not printed). */
const mask = (v) => { if (process.env.GITHUB_ACTIONS === 'true') process.stdout.write(`::add-mask::${v}\n`); };

/**
 * @param {{cli: string, tinyTracker: string, defects?: string[], backendDefects?: string[], layout?: 'separate' | 'control', timeoutMs?: number}} o
 * @returns {Promise<{ok: true, observed: string[], version: string, records: number} | {ok: false, error: string}>}
 */
export async function runWritecheck(o) {
  return (o.layout ?? 'separate') === 'control' ? runControl(o) : runSeparate(o);
}

/** Plan, confirm and run writecheck on a prepared manifest and environment; read results.json. */
function runOn(o, cli, work, manifest, env) {
  const run = (args) => spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', timeout: o.timeoutMs ?? 1_500_000, maxBuffer: 64 * 1024 * 1024 });
  const plan = run(['plan', '-m', manifest]);
  const hash = /plan hash: (\S+)/.exec(plan.stdout ?? '')?.[1];
  if (!hash) return { ok: false, error: `plan gave no plan hash (exit ${plan.status}): ${String(plan.stderr).slice(-300)}` };
  const out = join(work, 'out');
  const r = run(['run', '-m', manifest, '--confirm-target', 'tiny-tracker', '--plan-hash', hash, '--out', out, '--state', join(work, 'state')]);
  const file = findResults(out.replace(/\/$/, '')) ?? null;
  if (!file) return { ok: false, error: `run wrote no results.json (exit ${r.status}): ${String(r.stderr).slice(-300)}` };
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  return { ok: true, observed: observedOf(doc), version: doc.suite?.version ?? 'unknown', records: (doc.results ?? []).length };
}

async function runControl(o) {
  const cli = resolve(o.cli);
  const tt = resolve(o.tinyTracker);
  const work = mkdtempSync(join(tmpdir(), 'dm-wc-'));
  const tok = (p) => `dm-${p}-${randomBytes(16).toString('hex')}`;
  const tokens = { TRACKER_BACKEND_TOKEN: tok('b'), TRACKER_CONTROL_TOKEN: tok('c'), TRACKER_EVIDENCE_TOKEN: tok('e') };
  for (const v of Object.values(tokens)) mask(v);
  try {
    const [backendPort, controlPort] = [await freePort(), await freePort()];
    const manifest = join(work, 'writecheck.yaml');
    writeFileSync(manifest, controlManifest(readFileSync(join(tt, 'writecheck.yaml'), 'utf8'), { cwd: tt, backendPort, controlPort }));
    // why: the listeners stay on loopback: tiny-tracker binds its control listener to 127.0.0.1, and the tester is told only that.
    const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...tokens, TRACKER_BACKEND_URL: `http://127.0.0.1:${backendPort}`, TRACKER_CONTROL_URL: `http://127.0.0.1:${controlPort}`, ...(o.defects?.length ? { TRACKER_DEFECTS: o.defects.join(',') } : {}) };
    return runOn(o, cli, work, manifest, env);
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 300) };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function runSeparate(o) {
  const cli = resolve(o.cli);
  const tt = resolve(o.tinyTracker);
  const work = mkdtempSync(join(tmpdir(), 'dm-wc-'));
  const token = `dm-${randomBytes(16).toString('hex')}`;
  const base = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' };
  const backend = spawn(process.execPath, [join(tt, 'dist', 'src', 'cli.js'), 'backend', '--port', '0', ...(o.backendDefects ?? []).flatMap((d) => ['--backend-defect', d])], { env: { ...base, TRACKER_BACKEND_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  backend.stderr.on('data', (d) => { err += d; });
  try {
    const first = await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('the backend did not start within 15 s')), 15000);
      createInterface({ input: backend.stdout }).once('line', (l) => { clearTimeout(t); res(l); });
      backend.once('exit', (c) => rej(new Error(`the backend exited (${c}) before it was ready: ${err.trim().slice(-200)}`)));
    });
    const url = JSON.parse(first).backend;
    const manifest = join(work, 'writecheck.yaml');
    writeFileSync(manifest, readFileSync(join(tt, 'writecheck.yaml'), 'utf8').replace(/^ {2}cwd: .*$/m, `  cwd: ${JSON.stringify(tt)}`));
    const env = { ...base, TRACKER_BACKEND_URL: url, TRACKER_BACKEND_TOKEN: token, ...(o.defects?.length ? { TRACKER_DEFECTS: o.defects.join(',') } : {}) };
    return runOn(o, cli, work, manifest, env);
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 300) };
  } finally {
    backend.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    backend.kill('SIGKILL');
    rmSync(work, { recursive: true, force: true });
  }
}
