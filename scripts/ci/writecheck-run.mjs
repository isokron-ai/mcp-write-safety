#!/usr/bin/env node
// Run mcp-writecheck (the CLI built from packages/writecheck in the same job) against the built tiny-tracker, and say which
// requirements it reports. Used by matrix-cell.mjs; no secrets: the backend token is made here and lives for the run.
//
// It does what `mcp-writecheck demo` does (start tiny-tracker's backend on 127.0.0.1, point the shipped manifest at the build,
// plan, confirm the target and the plan hash, run) with the one thing the demo cannot do: pass a backend defect. The build
// is the release default profile, backend and server as separate processes, as in expected/generate.mjs --writecheck.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

/**
 * @param {{cli: string, tinyTracker: string, defects?: string[], backendDefects?: string[], timeoutMs?: number}} o
 * @returns {Promise<{ok: true, observed: string[], version: string, records: number} | {ok: false, error: string}>}
 */
export async function runWritecheck(o) {
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
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 300) };
  } finally {
    backend.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    backend.kill('SIGKILL');
    rmSync(work, { recursive: true, force: true });
  }
}
