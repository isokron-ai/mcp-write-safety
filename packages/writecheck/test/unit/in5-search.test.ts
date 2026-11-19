/**
 * MWS-IN-5 as a scoped, automated search (lane F7): the probe generator, the hints, and the differential reading.
 *
 *   generator   every probe is valid by the schema; lengths are capped at maxLength and at the payload cap; enums, consts,
 *               booleans and objects give none; an argument that names the object for cleanup keeps the run prefix
 *   hints       bounds stated in words add probes at N and N+1, from a description or a document naming tool and argument
 *   reading     a fixed constraint is confirmed only with a neighbour accepted, the refusal repeated in a fresh context and a
 *               monotonic boundary; a refusal that depends on state, identity or a rate limit is excluded; bisection finds the
 *               exact boundary
 *   verdict     violated (reading by the tester) or not observed with the scope in numbers; never held
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hintsIn, in5Probes, orderedValue, regexHints, type Dim } from '../../src/checks/in5gen.js';
import { bisectNext, boundaryOf, excludedWhy, readIn5, type In5Call } from '../../src/checks/in5read.js';
import { in5SearchVerdict, type ToolObs5 } from '../../src/checks/in5search.js';
import { validates } from '../../src/core/jsonschema.js';
import { parseManifestText } from '../../src/core/manifest.js';

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: {
    id: { type: 'string', pattern: '^T-[0-9]+$' },
    title: { type: 'string', minLength: 1, maxLength: 200, description: 'Title, 1 to 200 characters.' },
    note: { type: 'string', description: 'Free text, up to 500 characters.' },
    code: { type: 'string', pattern: '^[a-z]+$' },
    status: { type: 'string', enum: ['open', 'closed'] },
    done: { type: 'boolean' },
    details: { type: 'object' },
    priority: { type: 'integer', minimum: 1, maximum: 5 },
    weight: { type: 'number' },
    labels: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 32 }, maxItems: 20 },
    due: { type: 'string', format: 'date-time' },
  },
};
const BASE = { id: 'T-1' };

test('generator: every probe is valid by the argument schema and the whole input schema', () => {
  for (const arg of Object.keys(SCHEMA.properties)) {
    for (const p of in5Probes(SCHEMA, BASE, arg).probes) {
      assert.equal(validates((SCHEMA.properties as Record<string, unknown>)[arg], p.value, SCHEMA), true, `${arg} ${p.cls}`);
      assert.equal(validates(SCHEMA, { ...BASE, [arg]: p.value }), true, `${arg} ${p.cls} in the whole call`);
    }
  }
});

test('generator: string lengths are capped at maxLength (which is itself probed) and at the payload cap', () => {
  const t = in5Probes(SCHEMA, BASE, 'title').probes.filter((p) => p.dim === 'length');
  assert.ok(t.every((p) => p.n! <= 200 && p.n! >= 1));
  assert.ok(t.some((p) => p.n === 200), 'maxLength itself');
  assert.ok(!t.some((p) => p.n === 0), 'below minLength is not sent');
  const n = in5Probes(SCHEMA, BASE, 'note').probes.filter((p) => p.dim === 'length').map((p) => p.n);
  for (const L of [0, 1, 255, 256, 1024, 4096, 65536]) assert.ok(n.includes(L), `length ${L}`);
  const capped = in5Probes(SCHEMA, BASE, 'note', { payload_bytes: 2000 }).probes;
  assert.ok(capped.every((p) => Buffer.byteLength(p.value as string) <= 2000));
  assert.ok(!capped.some((p) => p.n === 4096));
  // every character class has its plain neighbour of the same length
  const all = in5Probes(SCHEMA, BASE, 'note').probes;
  for (const c of all.filter((p) => p.cls.startsWith('chars.'))) assert.ok(all.some((p) => p.cls === 'plain' && p.n === c.plain_len), c.cls);
  assert.ok(!all.some((p) => typeof p.value === 'string' && p.value.includes('\u0000')), 'NUL is never sent');
});

test('generator: a pattern, an enum, a boolean, an object, numbers, arrays and formats', () => {
  assert.ok(in5Probes(SCHEMA, BASE, 'code').probes.every((p) => /^[a-z]+$/.test(p.value as string)), 'only values the pattern allows');
  for (const a of ['status', 'done', 'details']) assert.equal(in5Probes(SCHEMA, BASE, a).probes.length, 0, a);
  assert.match(in5Probes(SCHEMA, BASE, 'status').skipped!, /enum/);
  assert.deepEqual(in5Probes(SCHEMA, BASE, 'priority').probes.map((p) => p.value), [1]);
  const w = in5Probes(SCHEMA, BASE, 'weight').probes.map((p) => p.value);
  for (const v of [0, 1, -1, 2 ** 31, -(2 ** 31), Number.MAX_SAFE_INTEGER, 0.5]) assert.ok(w.includes(v), String(v));
  const l = in5Probes(SCHEMA, BASE, 'labels').probes.map((p) => (p.value as unknown[]).length);
  assert.deepEqual(l, [0, 1, 20], 'within maxItems; 100 and 1000 become 20');
  const d = in5Probes(SCHEMA, BASE, 'due').probes;
  assert.ok(d.length && d.every((p) => p.cls === 'format.date-time' && /^\d{4}-\d\d-\d\dT/.test(p.value as string)), 'only values valid by the format');
});

test('generator: an argument that names the object for cleanup keeps the run prefix in every value', () => {
  const pre = 'mwsc-abc123-';
  const ps = in5Probes(SCHEMA, BASE, 'title', { keep_prefix: pre }).probes;
  assert.ok(ps.length);
  assert.ok(ps.every((p) => (p.value as string).startsWith(pre)));
  assert.ok(!ps.some((p) => p.n !== undefined && p.n < pre.length));
  assert.equal(orderedValue(SCHEMA.properties.title, 'length', 101, pre), `${pre}${'x'.repeat(101 - pre.length)}`);
  assert.equal(orderedValue(SCHEMA.properties.title, 'length', 3, pre), null);
});

test('hints: a bound in words adds probes at N and N+1; a document counts only where it names the tool and the argument', () => {
  assert.deepEqual(hintsIn('Up to 100 characters.', 'title', { type: 'string' }, 'd').map((h) => [h.kind, h.n, h.unit]), [['max', 100, 'characters']]);
  assert.deepEqual(hintsIn('Between 1 and 50 items', 'tags', { type: 'array' }, 'd').map((h) => [h.kind, h.n, h.unit]), [['min', 1, 'items'], ['max', 50, 'items']]);
  assert.deepEqual(hintsIn('must not exceed 1,000', 'n', { type: 'integer' }, 'd').map((h) => [h.kind, h.n, h.unit]), [['max', 1000, 'value']]);
  const schema = { type: 'object', properties: { title: { type: 'string', maxLength: 200 } } };
  const tool = { name: 'update_ticket', inputSchema: schema };
  const docs = [{ path: 'README.md', text: 'The update_ticket title is limited to 100 characters. Other tools accept a title of up to 150 characters.' }];
  const hs = regexHints.hints(tool, docs);
  assert.deepEqual(hs.map((h) => [h.arg, h.kind, h.n, h.source]), [['title', 'max', 100, 'README.md']]);
  const ps = in5Probes(schema, {}, 'title', { hints: hs }).probes.filter((p) => p.source === 'hint').map((p) => p.n);
  assert.deepEqual(ps, [100, 101]);
});

// ---- the differential reading -------------------------------------------------------------------------------------------

let seq = 0;
const call = (arg: string, n: number, ok: boolean, o: Partial<In5Call> = {}): In5Call => ({ arg, cls: 'length', value: `x(${n})`, dim: 'length', n, phase: 'search', context: 'A', ok, isError: !ok, rpc_error: null, text: ok ? 'Updated.' : `Invalid ${arg}: must be at most 100 characters.`, step: `s${++seq}`, ...o });
/** A tool with a hidden maxLength: a length is refused above `limit`, in any context. */
const oracle = (limit: number) => (n: number, context: 'A' | 'B' = 'A', phase: In5Call['phase'] = 'search') => call('title', n, n <= limit, { context, phase });

/** The run's search on one order, as in5search does it: the probes, the bisection, then the repeat in context B. */
function search(o: (n: number, c?: 'A' | 'B', p?: In5Call['phase']) => In5Call, probes: number[], dim: Dim = 'length'): In5Call[] {
  const calls = probes.map((n) => o(n));
  let steps = 0;
  for (;;) {
    const b = boundaryOf(calls, dim).upper;
    const next = b ? bisectNext(b.acc, b.ref) : null;
    if (next === null) break;
    calls.push(o(next, 'A', 'bisect'));
    steps++;
    assert.ok(steps < 25);
  }
  const b = boundaryOf(calls, dim).upper;
  if (b) calls.push(o(b.ref, 'B', 'repeat'));
  return calls;
}

test('reading: a fixed constraint is confirmed, with the exact boundary found by bisection', () => {
  const calls = search(oracle(100), [1, 200]);
  const r = readIn5(calls);
  assert.equal(r.confirmed.length, 1);
  const k = r.confirmed[0]!;
  assert.deepEqual([k.keyword, k.bound, k.exact, k.accepted_at, k.refused_at, k.reading_by], ['maxLength', 100, true, 100, 101, 'tester (differential probe)']);
  assert.equal(k.steps.length, 3, 'the refusal at the boundary, its accepted neighbour and the repeat');
  assert.deepEqual([k.refusal.names_arg, k.refusal.kind, k.refusal.states_bound], [true, 'length', true]);
  assert.ok(calls.filter((c) => c.phase === 'bisect').length <= 8, 'log2(199) steps at most');
});

test('reading: bisection converges for any hidden bound, with log2 steps', () => {
  for (const limit of [1, 37, 64, 99, 128, 254, 255, 1000, 4095]) {
    const calls = search(oracle(limit), [0, 1, 255, 256, 1024, 4096, 65536]);
    const r = readIn5(calls);
    assert.equal(r.confirmed[0]?.bound, limit, `limit ${limit}`);
    assert.equal(r.confirmed[0]?.exact, true);
  }
});

test('reading: a refusal that does not repeat in a fresh context is state-dependent and not judged', () => {
  const calls = [call('title', 1, true), call('title', 200, false), call('title', 199, true, { phase: 'bisect' }), call('title', 200, true, { context: 'B', phase: 'repeat' })];
  const r = readIn5(calls);
  assert.equal(r.confirmed.length, 0);
  assert.ok(r.seen.some((x) => /did not repeat in a fresh context/.test(x.why)));
});

test('reading: refusals that name state, identity or a rate limit are excluded, whatever the outcomes', () => {
  for (const [text, why] of [
    ['project ab already exists', /state/],
    ['Version conflict: changed since the version you read', /state/],
    ['403 Forbidden: missing permission', /identity/],
    ['429 Too Many Requests', /rate limit/],
  ] as const) {
    const calls = [call('title', 1, true), call('title', 200, false, { text }), call('title', 199, true), call('title', 200, false, { text, context: 'B' })];
    assert.match(excludedWhy(calls[1]!)!, why);
    assert.equal(readIn5(calls).confirmed.length, 0, text);
  }
  assert.match(excludedWhy(call('title', 5, false, { indeterminate: true }))!, /unknown/);
});

test('reading: a refusal with no accepted neighbour, or not monotonic, is not a bound', () => {
  assert.equal(readIn5([call('title', 200, false), call('title', 200, false, { context: 'B' })]).confirmed.length, 0, 'no neighbour');
  const nm = [call('title', 1, true), call('title', 100, false), call('title', 200, true), call('title', 100, false, { context: 'B' })];
  const r = readIn5(nm);
  assert.equal(r.confirmed.length, 0);
  assert.ok(r.seen.some((x) => /not monotonic/.test(x.why)));
});

test('reading: a lower bound and a range of numbers', () => {
  const v = (n: number, ok: boolean, o: Partial<In5Call> = {}) => call('count', n, ok, { dim: 'value', cls: 'number', text: ok ? 'ok' : 'count is out of range', ...o });
  const r = readIn5([v(-1, false), v(0, true), v(1, true), v(2 ** 31, false), v(2 ** 31 - 1, true), v(-1, false, { context: 'B' }), v(2 ** 31, false, { context: 'B' })]);
  assert.deepEqual(r.confirmed.map((k) => [k.keyword, k.bound, k.exact]).sort(), [['maximum', 2 ** 31 - 1, true], ['minimum', 0, true]]);
});

test('reading: a character class is a constraint only beside an accepted plain value of the same length', () => {
  const ch = (ok: boolean, o: Partial<In5Call> = {}) => call('title', 0, ok, { cls: 'chars.emoji', dim: undefined, n: undefined, plain_len: 9, text: ok ? 'ok' : 'title: only letters and digits are allowed', ...o });
  const plain = call('title', 9, true, { cls: 'plain' });
  const r = readIn5([plain, ch(false), ch(false, { context: 'B', phase: 'repeat' })]);
  assert.deepEqual(r.confirmed.map((k) => [k.keyword, k.cls, k.refusal.kind]), [['pattern', 'chars.emoji', 'characters']]);
  assert.equal(readIn5([ch(false), ch(false, { context: 'B' })]).confirmed.length, 0, 'no plain neighbour');
});

test('reading: the declaration (fixed_constraints) confirms a refusal without the differential reading', () => {
  const r = readIn5([call('title', 150, false, { phase: 'declared', cls: 'declared' })], [{ arg: 'title', pattern: 'at most \\d+ characters', reason: 'a fixed limit' }]);
  assert.deepEqual(r.confirmed.map((k) => [k.keyword, k.reading_by]), [['declared', 'declaration']]);
  // a success after which a declared value is not stored counts as refused (spec R10-8)
  const quiet = readIn5([call('title', 150, true, { phase: 'declared', cls: 'declared', stored: false, text: 'Updated.' })]);
  assert.equal(quiet.seen.length, 1);
});

// ---- the record ---------------------------------------------------------------------------------------------------------

const RES = parseManifestText(
  `mws: "0.9"
server: { stdio: [node, s.js] }
target: { environment: test, confirm: t }
resources:
  - name: ticket
    create: { tool: ticket_create, args: { title: "{{marker}}" }, id: id, name_path: title }
    read: { tool: ticket_get, args: { id: "{{id}}" }, object: ticket }
    update: { tool: ticket_update, mode: field_patch, args: { id: "{{id}}", "{{field}}": "{{value}}" } }
    fields: [ { path: assignee, values: [ann, bob] }, { path: status, values: [blocked, closed] } ]
    cleanup: delete
    delete: { tool: ticket_delete, args: { id: "{{id}}" } }
`,
  'm.yaml',
).resources[0]!;

const obs = (calls: In5Call[], o: Partial<ToolObs5> = {}): ToolObs5 => ({ tool: 'ticket_update', role: 'update', from: 'ticket.update', args_total: 4, args: [{ arg: 'title', probes: 9 }, { arg: 'id', probes: 0, skipped: 'not probed: the identifier' }], calls, hints: [], cap: 80, used: calls.length, cut: null, notes: [], ...o });

test('verdict: violated on a confirmed constraint, with the reading and the evidence it rests on', () => {
  const r = in5SearchVerdict(obs(search(oracle(100), [1, 200])), RES);
  assert.equal(r.verdict, 'violated');
  assert.equal(r.write_path.tool, 'ticket_update');
  assert.match(r.reason, /title: maxLength 100 \(100 characters accepted, 101 characters refused\)/);
  assert.ok(r.notes.some((n) => /Reading by: tester \(differential probe\)/.test(n)));
  assert.equal((r.numbers['constraints'] as { bound: number }[])[0]!.bound, 100);
  assert.equal(r.steps.length, 3);
  assert.equal(r.numbers['args_probed'], 1);
});

test('verdict: not observed carries the scope searched in its numbers, and lists each refusal seen, not judged; never held', () => {
  const ok = in5SearchVerdict(obs([call('title', 1, true), call('title', 200, true)]), RES);
  assert.equal(ok.verdict, 'not observed');
  assert.deepEqual([ok.numbers['args_total'], ok.numbers['args_probed'], ok.numbers['probes'], ok.numbers['refusals'], ok.numbers['confirmed']], [4, 1, 2, 0, 0]);
  assert.ok(ok.notes[0]!.startsWith('Scope of the search: 1 of 4 argument(s)'));
  const seen = in5SearchVerdict(obs([call('title', 200, false)]), RES);
  assert.equal(seen.verdict, 'not observed');
  assert.ok(seen.notes.some((n) => /^Seen, not judged: title=/.test(n) && /must be at most 100 characters/.test(n)));
  assert.equal(in5SearchVerdict(obs([], { args: [{ arg: 'id', probes: 0, skipped: 'not probed: the identifier' }] }), RES).verdict, 'not tested');
  assert.equal(in5SearchVerdict(obs([], { args_total: 0, args: [] }), RES).verdict, 'not applicable');
  assert.match(in5SearchVerdict(obs([], { not_probed: 'the base call did not succeed' }), RES).reason, /not searched/);
});
