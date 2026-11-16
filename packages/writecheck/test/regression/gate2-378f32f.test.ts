/**
 * From the gate-2 re-run on 378f32f (note 19, cases R1 to R12). Each test runs one of the re-run's cases against the re-run's
 * own fake server (gate2-fake2-server.ts and gate2-backend2.ts, vendored unchanged) with the re-run's manifest, and asserts what the fixed
 * tool must say; the ground truth (objects left) comes from the backend. R3 (a kill recorded as a graceful stop) is pinned by
 * test/integration/infra-supervisor.test.ts; R13 is left as it is.
 *
 *   rule 11 (note 19 item 1)  a default pattern alone never gives held or violated: R4, R8 to R12
 *   step (e) trace (item 2)   a paged list is read to the end (list.next) or the trace is partial and gives no verdict: R5, R6
 *   step (a) (item 4)         R1, R2
 *   clean-up (item 5)         a create answered with an error after it applied is swept by its marker: R7
 *   key_lifetime (item 6)     counts only where the tool's description states it
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { planCommand } from '../../src/cli/commands.js';
import { runCommand, type RunOutcome } from '../../src/cli/run.js';
import type { Result } from '../../src/report/verdicts.js';
import { Backend2 } from './gate2-backend2.js';
import { show } from './harness.js';

const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'gate2-fake2-server.js');
const CONFIRM = 'mwsv-retry';
const SURV = (g: boolean, k: boolean) => `key_record_survives: { graceful: ${g}, kill: ${k} }`;

interface Case {
  opts: string;
  kind?: 'r11';
  settings?: boolean;
  gate?: boolean;
  restart?: 'graceful' | 'kill';
  c?: string;
  u?: string;
  only?: 'create' | 'update';
  patterns?: string;
  /** Added to the list block (list.next for a paged list). */
  listExtra?: string;
}

/** The manifest of safety-378f32f/retry.mjs, unchanged apart from `listExtra`. */
function manifest(c: Case): string {
  const head = `mws: "0.9"
prefix: mwsr
server:
  stdio: [${JSON.stringify(process.execPath)}, ${JSON.stringify(FAKE)}]
  env_public: [FAKE_URL, FAKE_OPTS, FAKE_CALL_LOG, FAKE_STATE_DIR${c.settings ? ', FAKE_READ_ONLY, FAKE_TOOLS, FAKE_DENY_TOOLS' : ''}]
  processes: separate
${c.restart ? `  restart: { stop: ${c.restart} }\n` : ''}target:
  environment: test
  confirm: ${CONFIRM}
  guard: { tool: whoami, args: {}, path: tenant, pattern: "^mwsv-test-" }
${c.gate ? 'backend:\n  gate: { rewrite_env: FAKE_URL }\n' : ''}limits: { write_budget: 20000, writes_per_second: 1000, pairs: 40, stale_reps: 1, gate_reps: 1, timeout_ms: 5000, max_fuzz_cases: ${c.kind === 'r11' ? 200 : 20} }
${c.patterns ? `patterns:\n  ${c.patterns}\n` : ''}`;
  const common = `    read: { tool: ticket_get, args: { id: "{{id}}" }, object: ticket, ignore: [updated_at] }
    list: { tool: ticket_list, args: { title_prefix: "{{prefix}}" }, items: tickets, id: id, name: title${c.listExtra ?? ''} }
    delete: { tool: ticket_delete, args: { id: "{{id}}" } }
    cleanup: delete
`;
  if (c.kind === 'r11')
    return `${head}${c.settings ? `settings:
  read_only: { env: FAKE_READ_ONLY, on: "true", valid: { "true": restrict, "1": restrict, "false": permit, "0": permit } }
  tool_filters:
    - { env: FAKE_TOOLS, kind: allow }
    - { env: FAKE_DENY_TOOLS, kind: deny }
calls:
  ticket_assign_and_close: { resource: ticket, args: { id: "{{id}}", assignee: zed } }
` : ''}resources:
  - name: ticket
    create: { tool: ticket_create, args: { title: "{{marker}}" }, id: id, name_path: title }
${common}    update: { tool: ticket_update, mode: field_patch, args: { id: "{{id}}", "{{field}}": "{{value}}" } }
    fields:
      - { path: assignee, values: [ann, bob] }
      - { path: status, values: [blocked, closed] }
    version: { read: version }
    failures:
      - { name: close_refused, tool: ticket_assign_and_close, args: { id: "{{id}}", assignee: zed, comment: applied } }
`;
  return `${head}resources:
${c.only === 'update' ? '' : `  - name: ticket
    create: { tool: ticket_create, args: { title: "{{marker}}" }, id: id, name_path: title }
${common}    idempotency: { args: { title: "{{marker}}" }, key: { arg: idempotency_key }${c.c ? `, ${c.c}` : ''} }
`}${c.only === 'create' ? '' : `  - name: ticket-upd
    create: { tool: ticket_create, args: { title: "{{marker}}" }, id: id, name_path: title }
${common}    version: { read: version }
    idempotency: { tool: ticket_update, kind: update, args: { id: "{{id}}", assignee: "{{marker}}" }, key: { arg: idempotency_key }, version_steps: true${c.u ? `, ${c.u}` : ''} }
`}`;
}

interface Ran {
  r: RunOutcome;
  /** Tickets of the run still on the backend. */
  left: { id: string; title: string }[];
}

async function run(c: Case): Promise<Ran> {
  const backend = new Backend2({ tenant: 'mwsv-test-tenant' });
  const url = await backend.start();
  backend.seed('tickets', { id: 'B1', title: 'customer ticket B1', status: 'open', assignee: 'carol' });
  backend.seed('tickets', { id: 'B2', title: 'mwsr-leftover-of-an-older-run', status: 'open', assignee: 'dave' });
  const dir = mkdtempSync(join(tmpdir(), 'mwsc-g378-'));
  mkdirSync(join(dir, 'state'), { recursive: true });
  const mf = join(dir, 'manifest.yaml');
  writeFileSync(mf, manifest(c));
  const env: NodeJS.ProcessEnv = { PATH: process.env['PATH'], HOME: process.env['HOME'], FAKE_URL: url, FAKE_OPTS: c.opts, FAKE_CALL_LOG: join(dir, 'calls.jsonl'), FAKE_STATE_DIR: join(dir, 'state') };
  try {
    const { hash } = await planCommand({ manifest: mf, env, log: () => {} });
    const r = await runCommand({ manifest: mf, outRoot: join(dir, 'out'), stateDir: join(dir, 'state-cli'), confirmTarget: CONFIRM, planHash: hash, interactive: false, env, log: () => {}, noSignals: true });
    const left = (backend.all('tickets') as { id: string; title: string }[]).filter((t) => t.id !== 'B1' && t.id !== 'B2').map((t) => ({ id: String(t.id), title: String(t.title) }));
    return { r, left };
  } finally {
    // why: a server the run started is stopped by the run; anything the fake left behind in its state folder goes with it.
    const pids = join(dir, 'state', 'pids');
    if (existsSync(pids)) for (const p of readFileSync(pids, 'utf8').split('\n').filter(Boolean).map(Number)) try { process.kill(p, 'SIGKILL'); } catch { /* gone */ }
    await backend.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

const rows = (x: Ran, req: string, o: { scenario?: RegExp; tool?: string } = {}): Result[] => x.r.doc.results.filter((r) => r.requirement === req && (!o.scenario || o.scenario.test(r.scenario.id)) && (!o.tool || r.write_path.tool === o.tool));
const verdicts = (rs: Result[]) => rs.map((r) => r.verdict);

// ───────────────────────────── control ─────────────────────────────

test('control r0-correct: a correct server gives no MWS-RETRY-2 or MWS-RES-2 violated', async () => {
  const x = await run({ opts: '', gate: true, restart: 'graceful', c: 'backend_key: true', u: 'backend_key: true' });
  const bad = [...rows(x, 'MWS-RETRY-2'), ...rows(x, 'MWS-RES-2')].filter((r) => r.verdict === 'violated');
  assert.deepEqual(bad.map((r) => `${r.scenario.id}: ${r.reason}`), []);
  assert.deepEqual(x.left, []);
});

// ───────────────────────────── step (a) ─────────────────────────────

test('R1 r2-first-error-old: an error-form repeat read only by the default is not violated', async () => {
  const x = await run({ opts: 'keys=file,after=fail,repeat2=old' });
  const abc = rows(x, 'MWS-RETRY-2', { scenario: /^[^.]+$/ });
  assert.ok(abc.length >= 1);
  assert.ok(!verdicts(abc).includes('violated'), show(abc));
});

test('R2 r3-err-success: after a first success, an error-form repeat is never held; a declared pattern that reads it makes it violated (F4)', async () => {
  // Review of note 19 (7): whether an error is an infrastructure refusal (not tested) is read by a declared pattern only.
  const x = await run({ opts: 'keys=file,repeat=err-success' });
  const abc = rows(x, 'MWS-RETRY-2', { scenario: /^[^.]+$/ });
  assert.ok(abc.length >= 1 && !verdicts(abc).includes('held'), show(abc));
  // F4 / S1: with patterns.unavailable declared but not matching, the error-form repeat still needs reading; a declared applied
  // pattern that reads it ("was created") decides: the repeat is an error, not the success the first answer was (R2), so violated.
  const y = await run({ opts: 'keys=file,repeat=err-success', patterns: 'unavailable: "rate limit|try again later"' });
  const abc2 = rows(y, 'MWS-RETRY-2', { scenario: /^[^.]+$/ });
  assert.ok(!verdicts(abc2).includes('held'), show(abc2));
  const z = await run({ opts: 'keys=file,repeat=err-success', patterns: 'unavailable: "rate limit|try again later"\n  applied: "was created"' });
  const abc3 = rows(z, 'MWS-RETRY-2', { scenario: /^[^.]+$/ });
  assert.ok(verdicts(abc3).includes('violated') && !verdicts(abc3).includes('held'), show(abc3));
});

// ───────────────────────────── crash form (R4) ─────────────────────────────

test('R4 r5-pending-bare: a bare refusal in the crash form is not held without a declared patterns.unavailable', async () => {
  const x = await run({ opts: 'keys=file-pending,pending=bare', gate: true, restart: 'kill' });
  const crash = rows(x, 'MWS-RETRY-2', { scenario: /\.restart-crash$/ });
  assert.ok(crash.length >= 1);
  assert.ok(!verdicts(crash).includes('held'), show(crash));
});

// ───────────────────────────── step (e) trace on a paged list (R5, R6) ─────────────────────────────

test('R5 r8-dup-hidden-page8: a duplicate on page 2 is never held; with list.next it is violated', async () => {
  const c: Case = { opts: 'keys=file,repeat=apply-stored,listpage=8', restart: 'graceful', c: SURV(true, true), only: 'create' };
  const x = await run(c);
  const e = rows(x, 'MWS-RETRY-2', { scenario: /\.restart$/ });
  assert.ok(e.length === 1 && e[0]!.verdict !== 'held', show(e));
  const y = await run({ ...c, listExtra: ', next: { path: next_page, arg: page }' });
  const e2 = rows(y, 'MWS-RETRY-2', { scenario: /\.restart$/ });
  assert.equal(e2[0]?.verdict, 'violated', show(e2));
});

test('R6 r8-dup-hidden-page2: a partial trace says so (never "did not apply the write"); with list.next the duplicate is found and nothing is left', async () => {
  const c: Case = { opts: 'keys=file,repeat=apply-stored,listpage=2', restart: 'graceful', c: SURV(true, true), only: 'create' };
  const x = await run(c);
  const all = rows(x, 'MWS-RETRY-2');
  assert.deepEqual(all.filter((r) => /did not apply the write/.test(r.reason)).map((r) => r.reason), []);
  assert.ok(all.some((r) => /partial/.test(r.reason)), show(all));
  const y = await run({ ...c, listExtra: ', next: { path: next_page, arg: page }' });
  assert.ok(verdicts(rows(y, 'MWS-RETRY-2')).includes('violated'), show(rows(y, 'MWS-RETRY-2')));
  assert.deepEqual(y.left, [], 'every object of the run, the duplicates on later pages too, is cleaned up');
});

// ───────────────────────────── clean-up (R7) ─────────────────────────────

test('R7 r2-first-error-same: objects of creates answered with an error after they applied are swept and removed', async () => {
  const x = await run({ opts: 'keys=file,after=fail' });
  const reported = new Set(x.r.doc.leftovers.map((l) => String(l.id)));
  assert.deepEqual(x.left.filter((t) => !reported.has(t.id)), [], 'nothing of the run is left unreported');
  assert.deepEqual(x.left, [], 'nothing of the run is left');
});

// ───────────────────────────── key_lifetime ─────────────────────────────

test('key_lifetime: a quote that is not in the tool\'s description is ignored, so step (e) is judged', async () => {
  const x = await run({ opts: 'keys=memory', restart: 'graceful', c: 'key_lifetime: { ms: 1, quote: "a key is remembered for 1 ms" }', only: 'create' });
  const e = rows(x, 'MWS-RETRY-2', { scenario: /\.restart$/ });
  assert.equal(e[0]?.verdict, 'violated', show(e));
  assert.ok(e[0]!.notes.some((n) => /key_lifetime was ignored/.test(n)), e[0]!.notes.join('\n'));
});

// ───────────────────────────── rule 11 (R8 to R12) ─────────────────────────────

const res2 = (x: Ran) => rows(x, 'MWS-RES-2').filter((r) => r.write_path.tool === 'ticket_assign_and_close' || /unknown outcome/i.test(r.reason) || /\.unknown/.test(r.scenario.id));

for (const t of ['neg-identifies', 'de', 'de-unknown', 'unknown-other']) {
  test(`R8 p-${t}: a partial-failure error read only by the default is not MWS-RES-2 violated`, async () => {
    const x = await run({ kind: 'r11', opts: `partial=${t}` });
    const r = rows(x, 'MWS-RES-2', { tool: 'ticket_assign_and_close' });
    assert.ok(r.length >= 1, show(rows(x, 'MWS-RES-2')));
    assert.ok(!verdicts(r).includes('violated'), show(r));
  });
}

for (const [t, o] of [['p-neg-false', { kind: 'r11', opts: 'partial=neg-false' }], ['p-echo', { kind: 'r11', opts: 'partial=echo' }], ['u-echo', { kind: 'r11', opts: 'keys=none,unk=echo', gate: true }]] as const) {
  test(`R9 ${t}: a word elsewhere in the answer does not make MWS-RES-2 held`, async () => {
    const x = await run(o as Case);
    const r = res2(x);
    assert.ok(r.length >= 1, show(rows(x, 'MWS-RES-2')));
    assert.ok(!verdicts(r).includes('held'), show(r));
  });
}

for (const t of ['neg-unknown', 'de']) {
  test(`R10 u-${t}: an unknown-outcome error read only by the default is not MWS-RES-2 violated`, async () => {
    const x = await run({ kind: 'r11', opts: `keys=none,unk=${t}`, gate: true });
    const r = rows(x, 'MWS-RES-2');
    assert.ok(r.length >= 1);
    assert.ok(!verdicts(r).includes('violated'), show(r));
  });
}

test('R10 control p-de-declared: a declared outcome_unknown pattern decides (held)', async () => {
  const x = await run({ kind: 'r11', opts: 'partial=de-unknown', patterns: 'outcome_unknown: "nicht bekannt, ob"' });
  assert.deepEqual(verdicts(rows(x, 'MWS-RES-2', { tool: 'ticket_assign_and_close' })), ['held']);
});

for (const t of ['negation', 'echo']) {
  test(`R11 x-${t}: a notice read as "not used" only by the default is not MWS-IN-2 held`, async () => {
    const x = await run({ kind: 'r11', opts: `extra=${t}` });
    const r = rows(x, 'MWS-IN-2', { tool: 'ticket_update' });
    assert.ok(r.length >= 1, show(rows(x, 'MWS-IN-2')));
    assert.ok(!verdicts(r).includes('held'), show(r));
  });
}

test('R11 control x-de-declared: a declared not_used pattern decides (held)', async () => {
  const x = await run({ kind: 'r11', opts: 'extra=de', patterns: 'not_used: "nicht verwendet"' });
  assert.deepEqual(verdicts(rows(x, 'MWS-IN-2', { tool: 'ticket_update' })), ['held']);
});

test('R12 c-allow-notools-de: a tools/list error read only by the default is not MWS-CFG-4 held; a declared no_tools pattern reads it', async () => {
  const x = await run({ kind: 'r11', settings: true, opts: 'allow=listerror:notools-de' });
  const r = rows(x, 'MWS-CFG-4');
  assert.ok(r.length >= 1 && !verdicts(r).includes('held'), show(r));
  const y = await run({ kind: 'r11', settings: true, opts: 'allow=listerror:notools-de', patterns: 'no_tools: "keine werkzeuge"' });
  const r2 = rows(y, 'MWS-CFG-4');
  assert.deepEqual(verdicts(r2), ['not tested'], show(r2));
  assert.match(r2[0]!.reason, /because no tool is enabled/);
});

test('MWS-CFG-4 echo rule (S1): c-allow-unknown and c-allow-neg-notools name the invented tool and are held; c-allow-unreadable is not tested', async () => {
  const x = await run({ kind: 'r11', settings: true, opts: 'allow=listerror:unknown' });
  const r = rows(x, 'MWS-CFG-4');
  assert.deepEqual(verdicts(r), ['held'], show(r));
  assert.ok(r[0]!.notes.some((n) => /echo rule/.test(n)), show(r));
  const y = await run({ kind: 'r11', settings: true, opts: 'allow=listerror:neg-notools' });
  assert.deepEqual(verdicts(rows(y, 'MWS-CFG-4')), ['held'], show(rows(y, 'MWS-CFG-4')));
  const z = await run({ kind: 'r11', settings: true, opts: 'allow=listerror:unreadable' });
  assert.deepEqual(verdicts(rows(z, 'MWS-CFG-4')), ['not tested'], show(rows(z, 'MWS-CFG-4')));
});

// ───────────────────────────── validator re-run on f573a24: no false loss from the run's own prefixed objects ─────────────────────────────
for (const [name, opts, patterns] of [
  ['r2-first-error-old', 'keys=file,after=fail,repeat2=old', undefined],
  ['r2-first-error-same', 'keys=file,after=fail', undefined],
  ['r2-first-error-old+pEN', 'keys=file,after=fail,repeat2=old', 'applied: "was created"\n  outcome_unknown: "not known whether"'],
  ['r2-first-error-same+pEN', 'keys=file,after=fail', 'applied: "was created"\n  outcome_unknown: "not known whether"'],
  ['r9-restart-reid', 'keys=file,restart=reid', undefined],
] as const) {
  test(`f573a24 ${name}: objects carrying the run prefix are the tester's own; no bystander loss is reported`, async () => {
    const x = await run({ opts, ...(patterns ? { patterns } : {}), ...(name.startsWith('r9') ? { restart: 'graceful' as const } : {}) });
    const lost = x.r.doc.results.filter((r) => Array.isArray(r.numbers['bystanders_lost']) && (r.numbers['bystanders_lost'] as unknown[]).length);
    assert.deepEqual(lost.map((r) => r.requirement), [], show(lost));
    assert.ok(!/objects the tester did not create were lost/.test(x.r.doc.run.stopped_reason ?? ''), x.r.doc.run.stopped_reason ?? '');
    assert.deepEqual((x.r.doc.safety as { run_losses?: unknown[] }).run_losses ?? [], []);
  });
}
