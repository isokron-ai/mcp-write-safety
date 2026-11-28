#!/usr/bin/env node
// The live harness: the policies of model.mjs, as small scripted MCP clients, against a real tiny-tracker whose
// create_ticket answers the same-key-in-flight retry as one of the variants (TRACKER_SAME_KEY_ANSWER, A to E).
//
// One process, `tiny-tracker all --fixture-control` with the faults feature (the matrix runner's control layout,
// scripts/ci/writecheck-run.mjs), on loopback ports it picks itself. Per cell: arm backend/before-commit/delay once for
// d ms on the control listener (the fault point of #45), run the policy through the MCP layer (Streamable HTTP, JSON-RPC),
// and once the first write has settled, count the tickets that carry the cell's marker. In the failure case the first call
// carries a fixture run tag, and the run is reset FENCE_LEAD_MS before the hold ends: the pending key record is fenced, the
// held write applies nothing, and a later same-key call is answered key_fenced (model.mjs says the same).
//
// Each live cell is compared with its simulated cell: the final report, the objects, the calls, and the answer classes in
// order. No secrets: the tokens are made here, masked in the Actions log, and live for the run.
//
// Usage: node scripts/sim/same-key-inflight/live.mjs <tiny-tracker-dir> <out-dir>
//   VARIANT (A-E), OUTCOME (lands|fails), REPEATS (1-5) in the environment.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { classify, FENCE_LEAD_MS, GRID_DELAYS, OUTCOMES, POLICIES, POLICY_NAMES, simulateCell, TIMEOUT_MS, VARIANTS } from './model.mjs';

const RUN_META = 'dev.writesafety.tiny-tracker/run';
const PROJECT = 'inbox';
const SETTLE_MS = 400;

const mask = (v) => { if (process.env.GITHUB_ACTIONS === 'true') process.stdout.write(`::add-mask::${v}\n`); };

/** Read one server-sent-events response until the JSON-RPC message with this id. */
async function readSse(res, id) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buf += dec.decode(value, { stream: true });
      for (let m = /\r?\n\r?\n/.exec(buf); m; m = /\r?\n\r?\n/.exec(buf)) {
        const ev = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        const data = ev.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
        if (!data) continue;
        const msg = JSON.parse(data);
        if (msg.id === id) return msg;
      }
      if (done) throw new Error('the event stream ended without the response');
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

/** A minimal Streamable HTTP client. A call that times out is left to finish in the background; its answer is ignored. */
class Mcp {
  constructor(url) {
    this.url = url;
    this.next = 1;
    this.protocol = null;
    this.session = null;
    this.background = new Set();
  }
  headers() {
    const h = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    if (this.protocol) h['mcp-protocol-version'] = this.protocol;
    if (this.session) h['mcp-session-id'] = this.session;
    return h;
  }
  async exchange(msg) {
    const res = await fetch(this.url, { method: 'POST', headers: this.headers(), body: JSON.stringify(msg) });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.session = sid;
    if (msg.id === undefined) { await res.arrayBuffer().catch(() => undefined); return null; }
    if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) return readSse(res, msg.id);
    const text = await res.text();
    if (!text) throw new Error(`HTTP ${res.status} with no body`);
    return JSON.parse(text);
  }
  /** { msg } | { timeout: true } | { error } */
  async request(method, params, timeoutMs) {
    const p = this.exchange({ jsonrpc: '2.0', id: this.next++, method, params });
    this.background.add(p);
    p.catch(() => undefined).finally(() => this.background.delete(p));
    let timer;
    const to = new Promise((r) => { timer = setTimeout(() => r({ timeout: true }), timeoutMs); });
    try {
      return await Promise.race([p.then((msg) => ({ msg }), (e) => ({ error: String(e?.message ?? e) })), to]);
    } finally {
      clearTimeout(timer);
    }
  }
  async init() {
    const r = await this.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'same-key-sim', version: '1' } }, 15000);
    if (!r.msg?.result) throw new Error(`initialize failed: ${JSON.stringify(r).slice(0, 300)}`);
    this.protocol = r.msg.result.protocolVersion ?? null;
    await this.exchange({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }
  callTool(name, args, meta, timeoutMs) {
    return this.request('tools/call', { name, arguments: args, ...(meta ? { _meta: meta } : {}) }, timeoutMs);
  }
  async settle(capMs) {
    await Promise.race([Promise.allSettled([...this.background]), sleep(capMs)]);
  }
}

const textOf = (result) => (Array.isArray(result?.content) ? result.content.find((c) => c?.type === 'text')?.text ?? '' : '');

async function countMarker(mcp, marker) {
  const r = await mcp.callTool('list_tickets', { project: PROJECT, title_prefix: marker }, null, 10000);
  const list = r.msg?.result?.structuredContent?.tickets;
  if (!Array.isArray(list)) throw new Error(`list_tickets gave no ticket list: ${JSON.stringify(r).slice(0, 300)}`);
  return list.filter((t) => t?.title === marker).length;
}

/** The policies' client, in real time, through the MCP layer. */
class LiveClient {
  constructor(mcp, marker, runTag) {
    this.mcp = mcp;
    this.marker = marker;
    this.runTag = runTag;
    this.key1 = `k1-${marker}`;
    this.keys = 1;
    this.calls = 0;
    this.trace = [];
    this.t0 = performance.now();
  }
  at() { return Math.round(performance.now() - this.t0); }
  newKey() { return `k${++this.keys}-${this.marker}`; }
  async create(key) {
    this.calls++;
    const t = this.at();
    const meta = this.calls === 1 && this.runTag ? { [RUN_META]: this.runTag } : null;
    const r = await this.mcp.callTool('create_ticket', { project: PROJECT, title: this.marker, idempotency_key: key }, meta, TIMEOUT_MS);
    const seen = r.timeout ? { cls: 'timeout', code: null }
      : r.msg?.error ? { cls: 'no_claim', code: `rpc ${r.msg.error.code}` }
      : r.msg ? classify(r.msg.result) : { cls: 'no_claim', code: `transport: ${r.error}` };
    const op = key === this.key1 ? 'create K1' : `create K${key.slice(1, key.indexOf('-'))}`;
    this.trace.push({ t, op, ...seen, ...(r.msg?.result ? { text: textOf(r.msg.result).slice(0, 120) } : {}) });
    return seen;
  }
  async sleep(ms) { await sleep(ms); }
  async readBack() {
    this.calls++;
    const t = this.at();
    const n = await countMarker(this.mcp, this.marker);
    this.trace.push({ t, op: 'read back', cls: 'count', code: n });
    return n;
  }
}

async function control(tt, method, path, body) {
  const res = await fetch(`${tt.control}${path}`, { method, headers: { authorization: `Bearer ${tt.tokens.TRACKER_CONTROL_TOKEN}`, 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json ?? text };
}

async function startTinyTracker(ttDir, variant) {
  const tok = (p) => `sk-${p}-${randomBytes(16).toString('hex')}`;
  const tokens = { TRACKER_BACKEND_TOKEN: tok('b'), TRACKER_CONTROL_TOKEN: tok('c'), TRACKER_EVIDENCE_TOKEN: tok('e') };
  for (const v of Object.values(tokens)) mask(v);
  const args = [join(ttDir, 'dist', 'src', 'cli.js'), 'all', '--port', '0', '--backend-port', '0', '--fixture-control', '--control-port', '0', '--features', 'evidence,strict-input,ledger,faults'];
  const child = spawn(process.execPath, args, { env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...tokens, TRACKER_SAME_KEY_ANSWER: variant }, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  const line = await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`tiny-tracker did not start within 20 s: ${err.slice(-300)}`)), 20000);
    createInterface({ input: child.stdout }).once('line', (l) => { clearTimeout(t); res(l); });
    child.once('exit', (c) => rej(new Error(`tiny-tracker exited (${c}) before it was ready: ${err.slice(-300)}`)));
  });
  const state = JSON.parse(line);
  if (state.same_key_answer !== variant && !(variant === 'B' && state.same_key_answer === 'B')) throw new Error(`the state line names same_key_answer ${JSON.stringify(state.same_key_answer)}, not ${variant}`);
  if (!state.mcp || !state.control) throw new Error(`the state line has no mcp or control URL: ${line.slice(0, 300)}`);
  return { child, tokens, mcp: state.mcp, control: state.control, state: { same_key_answer: state.same_key_answer, features: state.features, defects: state.defects, profile: state.profile }, stderr: () => err };
}

async function runCell(tt, mcp, { variant, outcome, policy, d, rep }) {
  const marker = `sk-${variant}${outcome[0]}-${policy}-${d}-${rep}-${randomBytes(3).toString('hex')}`;
  let runTag = null;
  if (outcome === 'fails') {
    const r = await control(tt, 'POST', '/_fixture/runs', { label: marker });
    if (r.status !== 201 || typeof r.body?.run_id !== 'string') throw new Error(`run allocation answered ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    runTag = r.body.run_id;
  }
  const arm = await control(tt, 'POST', '/_fixture/faults', { point: 'backend/before-commit/delay', selector: { once: true, hold_ms: d } });
  const faultId = arm.body?.fault?.id;
  if (arm.status !== 201 || typeof faultId !== 'string') throw new Error(`arming answered ${arm.status} ${JSON.stringify(arm.body).slice(0, 200)}`);
  const c = new LiveClient(mcp, marker, runTag);
  let reset = null;
  const resetDone = runTag ? (async () => {
    await sleep(Math.max(0, d - FENCE_LEAD_MS - c.at()));
    const at = c.at();
    const r = await control(tt, 'POST', `/_fixture/runs/${encodeURIComponent(runTag)}/reset`, {});
    reset = { at, status: r.status, dropped: r.body?.dropped ?? null };
  })() : Promise.resolve();
  const report = await POLICIES[policy](c);
  await resetDone;
  await sleep(Math.max(0, d + SETTLE_MS - c.at()));
  await mcp.settle(15000);
  const faults = await control(tt, 'GET', '/_fixture/faults');
  const all = [...(faults.body?.armed ?? []), ...(faults.body?.spent ?? [])];
  const fired = all.some((a) => a?.id === faultId && typeof a.fired === 'number' && a.fired >= 1);
  const objects = await countMarker(mcp, marker);
  const live = { report, objects, calls: c.calls };
  const sim = await simulateCell(variant, policy, outcome, d);
  const classes = (tr) => tr.map((x) => `${x.op}:${x.cls}`).join(' ');
  const valid = fired && (outcome === 'lands' || reset?.status === 200);
  return {
    variant, outcome, policy, d, rep, marker, fired, reset, valid,
    ...live,
    extra: Math.max(0, c.calls - 1),
    duplicate: objects >= 2,
    lost: (report === 'not_saved' && objects >= 1) || (report === 'saved' && objects === 0),
    wrong: (report === 'saved' && objects !== 1) || (report === 'not_saved' && objects !== 0),
    unresolved: report === 'unknown',
    sim: { report: sim.report, objects: sim.objects, calls: sim.calls, classes: classes(sim.trace) },
    classes: classes(c.trace),
    match: sim.report === report && sim.objects === objects && sim.calls === c.calls && classes(sim.trace) === classes(c.trace),
    trace: c.trace,
  };
}

async function main() {
  const [ttArg, outDir] = process.argv.slice(2);
  if (!ttArg || !outDir) { process.stderr.write('usage: live.mjs <tiny-tracker-dir> <out-dir>\n'); process.exit(2); }
  const variant = process.env.VARIANT ?? '';
  const outcome = process.env.OUTCOME ?? '';
  const repeats = process.env.REPEATS === undefined || process.env.REPEATS === '' ? 1 : Number(process.env.REPEATS);
  if (!VARIANTS.includes(variant) || !OUTCOMES.includes(outcome) || !/^[1-5]$/.test(String(repeats))) {
    process.stderr.write(`VARIANT must be one of ${VARIANTS.join(', ')}, OUTCOME one of ${OUTCOMES.join(', ')}, REPEATS 1 to 5\n`);
    process.exit(2);
  }
  const tt = await startTinyTracker(resolve(ttArg), variant);
  const cells = [];
  let error = null;
  try {
    const mcp = new Mcp(tt.mcp);
    await mcp.init();
    await countMarker(mcp, 'warm-up');
    for (let rep = 1; rep <= repeats; rep++) {
      for (const d of GRID_DELAYS) {
        for (const policy of POLICY_NAMES) {
          const cell = await runCell(tt, mcp, { variant, outcome, policy, d, rep });
          cells.push(cell);
          process.stdout.write(`${variant} ${outcome} ${policy} d=${d} rep=${rep}: ${cell.report}, ${cell.objects} object(s), ${cell.calls} call(s)${cell.valid ? '' : ' INVALID'}${cell.match ? '' : ` MISMATCH (sim: ${cell.sim.report}, ${cell.sim.objects}, ${cell.sim.calls}; ${cell.sim.classes} | live: ${cell.classes})`}\n`);
        }
      }
    }
  } catch (e) {
    error = String(e?.stack ?? e).slice(0, 2000);
    process.stderr.write(`live harness error: ${error}\n${tt.stderr().slice(-2000)}\n`);
  } finally {
    tt.child.kill('SIGTERM');
  }
  mkdirSync(outDir, { recursive: true });
  const doc = { kind: 'same-key-inflight/live', variant, outcome, repeats, tiny_tracker: tt.state, error, cells, matched: cells.filter((c) => c.match).length, valid: cells.filter((c) => c.valid).length, total: cells.length };
  writeFileSync(join(outDir, `live-${variant}-${outcome}.json`), `${JSON.stringify(doc, null, 1)}\n`);
  process.stdout.write(`live ${variant} ${outcome}: ${doc.matched}/${doc.total} cells match the simulator; ${doc.valid}/${doc.total} valid\n`);
  process.exit(error ? 1 : 0);
}

await main();
