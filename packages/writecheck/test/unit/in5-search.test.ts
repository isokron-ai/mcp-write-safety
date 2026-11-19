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
import { in5SearchVerdict, interleave, searchPhases, type ToolObs5 } from '../../src/checks/in5search.js';
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
  assert.deepEqual(in5Probes(SCHEMA, BASE, 'priority').probes.map((p) => p.value), [1, 5]);
  const w = in5Probes(SCHEMA, BASE, 'weight').probes.map((p) => p.value);
  for (const v of [0, 1, -1, 2 ** 31, -(2 ** 31), Number.MAX_SAFE_INTEGER, 0.5]) assert.ok(w.includes(v), String(v));
  const l = in5Probes(SCHEMA, BASE, 'labels', { role: 'read' }).probes.map((p) => (p.value as unknown[]).length);
  assert.deepEqual(l, [0, 1, 20], 'within maxItems; 100 and 1000 become 20');
  const d = in5Probes(SCHEMA, BASE, 'due').probes;
  assert.ok(d.length && d.every((p) => p.cls === 'format.date-time' && /^\d{4}-\d\d-\d\dT/.test(p.value as string)), 'only values valid by the format');
});

test('generator: safety defaults (review M8): arrays of 0, 1, 2 and maxItems on a write tool; no number above 1 on a read tool unless a maximum is declared', () => {
  const sch = { type: 'object', properties: { ids: { type: 'array', items: { type: 'integer' } }, tags: { type: 'array', items: { type: 'string' }, maxItems: 20 }, limit: { type: 'integer' }, page: { type: 'integer', maximum: 100 } } };
  assert.deepEqual(in5Probes(sch, {}, 'ids').probes.map((p) => (p.value as unknown[]).length), [0, 1, 2]);
  assert.deepEqual(in5Probes(sch, {}, 'tags').probes.map((p) => (p.value as unknown[]).length), [0, 1, 2, 20]);
  assert.deepEqual(in5Probes(sch, {}, 'ids', { role: 'read' }).probes.map((p) => (p.value as unknown[]).length), [0, 1, 100, 1000]);
  assert.deepEqual(in5Probes(sch, {}, 'limit', { role: 'read' }).probes.map((p) => p.value), [-1, 0, 1]);
  assert.deepEqual(in5Probes(sch, {}, 'page', { role: 'read' }).probes.map((p) => p.value), [-1, 0, 1, 100]);
  assert.ok(in5Probes(sch, {}, 'limit').probes.some((p) => p.value === 2 ** 31), 'a write tool still gets the extremes');
});

test('generator: an integer format bounds the extremes (review S2)', () => {
  const sch = { type: 'object', properties: { a: { type: 'integer', format: 'int32' }, b: { type: 'integer', format: 'int64' } } };
  const a = in5Probes(sch, {}, 'a').probes.map((p) => p.value as number);
  assert.ok(a.includes(2 ** 31 - 1) && !a.includes(2 ** 31) && !a.includes(Number.MAX_SAFE_INTEGER));
  assert.ok(in5Probes(sch, {}, 'b').probes.some((p) => p.value === Number.MAX_SAFE_INTEGER));
});

test('generator: array items with a format or an encoding give no array probe (review M2)', () => {
  const sch = { type: 'object', properties: { to: { type: 'array', items: { type: 'string', format: 'email' } }, blobs: { type: 'array', items: { type: 'string', contentEncoding: 'base64' } } } };
  for (const a of ['to', 'blobs']) {
    const g = in5Probes(sch, {}, a);
    assert.equal(g.probes.length, 0, a);
    assert.equal(g.rule, 'format');
  }
  assert.equal(orderedValue(sch.properties.to, 'items', 3), null);
});

test('generator: a huge bound a server states is never built (review M6; reviewer p2)', () => {
  const schema = { type: 'object', properties: { body: { type: 'string', description: 'Body, up to 1,000,000,000 characters.' }, ids2: { type: 'array', items: { type: 'integer' }, description: 'at most 300,000,000 items' }, big: { type: 'string', maxLength: 1_000_000_000 } } };
  const hs = regexHints.hints({ name: 't', inputSchema: schema }, []);
  for (const a of ['body', 'ids2', 'big']) {
    const t0 = Date.now();
    const r = in5Probes(schema, null, a, { hints: hs, role: 'read' });
    assert.ok(Date.now() - t0 < 2000, a);
    assert.ok(r.probes.every((p) => Buffer.byteLength(typeof p.value === 'string' ? p.value : JSON.stringify(p.value)) <= 65536), a);
  }
  assert.equal(orderedValue({ type: 'string' }, 'length', 1_000_000_000), null);
  assert.equal(orderedValue({ type: 'array', items: { type: 'integer' } }, 'items', 300_000_000), null);
});

test('generator: a character class whose UTF-16 length passes maxLength is not sent, and its plain neighbour has the UTF-16 length (review S3)', () => {
  const sch = { type: 'object', properties: { name: { type: 'string', maxLength: 9 } } };
  const ps = in5Probes(sch, {}, 'name').probes;
  assert.ok(!ps.some((p) => p.cls === 'chars.emoji'), 'the emoji class is 7 code points but 10 UTF-16 units');
  const all = in5Probes(SCHEMA, BASE, 'note').probes;
  const e = all.find((p) => p.cls === 'chars.emoji')!;
  assert.equal(e.plain_len, (e.value as string).length);
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

type Answer = { ok: boolean; text: string | null; ind?: boolean };
/**
 * The search's own three phases (searchPhases), driven by a simulated server: `oracle(value, t, where)` answers the t-th call
 * sent, in context A or B. `fresh: false` is a read tool with no other argument to vary in context B.
 */
async function simulate(schema: { properties: Record<string, unknown> }, arg: string, oracle: (v: unknown, t: number, where: 'A' | 'B') => Answer, o: { role?: 'read' | 'write'; fresh?: boolean } = {}): Promise<In5Call[]> {
  const calls: In5Call[] = [];
  const values = new Map<In5Call, unknown>();
  let t = 0;
  const integer = (schema.properties[arg] as { type?: string }).type === 'integer';
  const perArg = new Map([[arg, in5Probes(schema, {}, arg, { role: o.role ?? 'write' }).probes.map((p) => ({ ...p, phase: 'search' as const }))]]);
  await searchPhases({
    perArg,
    props: schema.properties,
    schema,
    keepPrefix: () => null,
    payload: 65536,
    calls,
    values,
    stopped: () => false,
    openB: async () => true,
    send: async (where, p, phase, extra = {}) => {
      const r = oracle(p.value, t++, where);
      const c: In5Call = { arg, cls: p.cls, value: String(p.value).slice(0, 20), ...(p.dim ? { dim: p.dim } : {}), ...(p.n !== undefined ? { n: p.n } : {}), ...(p.plain_len !== undefined ? { plain_len: p.plain_len } : {}), ...(integer ? { integer: true } : {}), phase, context: where, ...(where === 'B' ? { fresh: o.fresh ?? true } : {}), ok: r.ok, isError: !r.ok, rpc_error: null, text: r.text, step: `s${t}`, ...(r.ind ? { indeterminate: true } : {}), ...extra };
      calls.push(c);
      values.set(c, p.value);
      return c;
    },
  });
  return calls;
}
const S = (props: Record<string, unknown>) => ({ type: 'object', properties: props });
const lenOracle = (limit: number) => (v: unknown): Answer => ((v as string).length <= limit ? { ok: true, text: 'ok' } : { ok: false, text: `Invalid title: must be at most ${limit} characters.` });

test('reading: a fixed constraint is confirmed, with the exact boundary found by bisection', async () => {
  const calls = await simulate(S({ title: { type: 'string' } }), 'title', lenOracle(100));
  const r = readIn5(calls);
  assert.equal(r.confirmed.length, 1);
  const k = r.confirmed[0]!;
  assert.deepEqual([k.keyword, k.bound, k.exact, k.accepted_at, k.refused_at, k.reading_by], ['maxLength', 100, true, 100, 101, 'tester (differential probe)']);
  assert.equal(k.steps.length, 4, 'the refusal at the boundary, its accepted neighbour, the repeat and the neighbour again in context B');
  assert.deepEqual([k.refusal.names_arg, k.refusal.kind, k.refusal.states_bound], [true, 'length', true]);
  const b = calls.filter((c) => c.context === 'B');
  assert.deepEqual(b.map((c) => [c.repeat_of, c.n, c.ok]), [['refused', 101, false], ['neighbour', 100, true]], 'context B: the refused value, then its neighbour');
});

test('reading: bisection converges for any hidden bound', async () => {
  for (const limit of [3, 37, 64, 99, 128, 254, 255, 1000, 4095]) {
    const r = readIn5(await simulate(S({ t: { type: 'string' } }), 't', lenOracle(limit)));
    assert.equal(r.confirmed[0]?.bound, limit, `limit ${limit}`);
    assert.equal(r.confirmed[0]?.exact, true);
  }
});

test('reading: an empty value accepted as "not given" is not a bound (review M1: cursor, Go since; reviewer S1, S1b)', async () => {
  const cursor = await simulate(S({ after: { type: 'string' } }), 'after', (v) => (v === '' ? { ok: true, text: '[]' } : { ok: false, text: 'invalid cursor' }), { role: 'read' });
  assert.equal(readIn5(cursor).confirmed.length, 0);
  const since = await simulate(S({ since: { type: 'string', description: 'ISO 8601 timestamp' } }), 'since', (v) => (v === '' ? { ok: true, text: '[]' } : { ok: false, text: 'failed to parse since: parsing time "x"' }), { role: 'read' });
  assert.equal(readIn5(since).confirmed.length, 0);
  const tags = await simulate(S({ tags: { type: 'array', items: { type: 'string' } } }), 'tags', (v) => ((v as unknown[]).length === 0 ? { ok: true, text: 'ok' } : { ok: false, text: 'bad tags' }), { role: 'read' });
  assert.equal(readIn5(tags).confirmed.length, 0, 'no maxItems 0');
});

test('reading: a failure that begins during the run is not a bound (review M3; reviewer S2, S2b, S2c)', async () => {
  const onset = (k: number, text: string) => (_v: unknown, t: number): Answer => (t < k ? { ok: true, text: 'ok' } : { ok: false, text });
  for (const [schema, arg, k, text] of [
    [S({ title: { type: 'string' } }), 'title', 6, 'Error: upstream request failed'],
    [S({ limit: { type: 'integer' } }), 'limit', 4, 'Error: upstream request failed'],
    [S({ tags: { type: 'array', items: { type: 'string' } } }), 'tags', 3, 'Error: quota reached for this account'],
    [S({ title: { type: 'string' } }), 'title', 12, 'HTTP 500 Internal Server Error'],
  ] as const) {
    for (const role of ['read', 'write'] as const) {
      const r = readIn5(await simulate(schema, arg, onset(k, text), { role }));
      assert.equal(r.confirmed.length, 0, `${arg} onset at ${k} (${role}): ${JSON.stringify(r.confirmed.map((x) => [x.keyword, x.bound]))}`);
    }
  }
});

test('reading: a read tool with nothing to vary in the fresh context confirms nothing (review M4)', async () => {
  const r = readIn5(await simulate(S({ title: { type: 'string' } }), 'title', lenOracle(100), { role: 'read', fresh: false }));
  assert.equal(r.confirmed.length, 0);
  assert.ok(r.seen.some((x) => /could not vary another argument/.test(x.why)));
});

test('reading: a refusal that does not repeat in a fresh context is state-dependent and not judged', async () => {
  const r = readIn5(await simulate(S({ title: { type: 'string' } }), 'title', (v, _t, where) => (where === 'B' || (v as string).length <= 100 ? { ok: true, text: 'ok' } : { ok: false, text: 'too long here' })));
  assert.equal(r.confirmed.length, 0);
  assert.ok(r.seen.some((x) => /did not repeat in a fresh context/.test(x.why)));
});

test('reading: refusals that name state, identity, a rate limit or the size of the whole request are excluded (review S1; reviewer S5)', async () => {
  for (const [text, why] of [
    ['project ab already exists', /state/],
    ['Version conflict: changed since the version you read', /state/],
    ['403 Forbidden: missing permission', /identity/],
    ['429 Too Many Requests', /rate limit/],
    ['HTTP 413 Payload Too Large', /size of the whole request/],
  ] as const) {
    const calls = [call('title', 1, true), call('title', 2, true), call('title', 200, false, { text }), call('title', 199, true), call('title', 200, false, { text, context: 'B', repeat_of: 'refused' }), call('title', 199, true, { context: 'B', repeat_of: 'neighbour' })];
    assert.match(excludedWhy(calls[2]!)!, why);
    assert.equal(readIn5(calls).confirmed.length, 0, text);
  }
  const body = await simulate(S({ body: { type: 'string' } }), 'body', (v) => (Buffer.byteLength(JSON.stringify({ body: v })) > 50000 ? { ok: false, text: 'HTTP 413 Payload Too Large' } : { ok: true, text: 'ok' }));
  assert.equal(readIn5(body).confirmed.length, 0);
  assert.match(excludedWhy(call('title', 5, false, { indeterminate: true }))!, /unknown/);
});

test('reading: the bisection stops on an answer left out of the reading (review M7; reviewer p3)', async () => {
  let n = 0;
  const calls = await simulate(S({ t: { type: 'string' } }), 't', (v, _t) => {
    if ((v as string).length > 100) return { ok: false, text: 'too long' };
    n++;
    return n > 12 ? { ok: false, text: 'Error 429: Too Many Requests' } : { ok: true, text: 'ok' };
  });
  const bis = calls.filter((c) => c.phase === 'bisect');
  assert.ok(bis.length <= 4, `bisection calls: ${bis.map((c) => c.n).join(', ')}`);
  assert.equal(new Set(bis.map((c) => c.n)).size, bis.length, 'no value sent twice');
});

test('reading: every call timed out: nothing judged, not tested (review M5; reviewer S3)', async () => {
  const calls = await simulate(S({ title: { type: 'string' } }), 'title', () => ({ ok: false, text: null, ind: true }));
  const v = in5SearchVerdict(obs(calls), RES);
  assert.equal(v.verdict, 'not tested');
  assert.equal(v.numbers['args_judged'], 0);
});

test('reading: a UTF-16 maxLength gives no false character constraint (review S3; reviewer S6, S6b)', async () => {
  for (const max of [10, 9, 8]) {
    const r = readIn5(await simulate(S({ name: { type: 'string', maxLength: max } }), 'name', (v) => ((v as string).length > max ? { ok: false, text: `String must contain at most ${max} character(s)` } : { ok: true, text: 'ok' })));
    assert.ok(!r.confirmed.some((k) => k.keyword === 'pattern'), `maxLength ${max}`);
  }
});

test('reading: a boundary on a number is exact only for an integer (review S4; reviewer S7, S7b)', async () => {
  for (const lim of [1.2, 2.5]) {
    const r = readIn5(await simulate(S({ w: { type: 'number' } }), 'w', (v) => ((v as number) > lim ? { ok: false, text: 'w too large' } : { ok: true, text: 'ok' })));
    assert.ok(r.confirmed.every((k) => !k.exact), `limit ${lim}: ${JSON.stringify(r.confirmed.map((k) => [k.keyword, k.bound, k.exact]))}`);
  }
  const i = readIn5(await simulate(S({ n: { type: 'integer' } }), 'n', (v) => ((v as number) > 1000 ? { ok: false, text: 'n too large' } : { ok: true, text: 'ok' })));
  assert.deepEqual(i.confirmed.map((k) => [k.keyword, k.bound, k.exact]), [['maximum', 1000, true]]);
});

test('reading: a refusal with no accepted neighbour, or not monotonic, is not a bound', () => {
  assert.equal(readIn5([call('title', 200, false), call('title', 200, false, { context: 'B', repeat_of: 'refused' })]).confirmed.length, 0, 'no neighbour');
  const nm = [call('title', 1, true), call('title', 5, true), call('title', 100, false), call('title', 200, true), call('title', 100, false, { context: 'B', repeat_of: 'refused' }), call('title', 5, true, { context: 'B', repeat_of: 'neighbour' })];
  const r = readIn5(nm);
  assert.equal(r.confirmed.length, 0);
  assert.ok(r.seen.some((x) => /not monotonic/.test(x.why)));
});

test('reading: a lower bound and an upper bound of an integer', async () => {
  const r = readIn5(await simulate(S({ count: { type: 'integer' } }), 'count', (v) => ((v as number) < 0 || (v as number) > 2 ** 31 - 1 ? { ok: false, text: 'count is out of range' } : { ok: true, text: 'ok' })));
  assert.deepEqual(r.confirmed.map((k) => [k.keyword, k.bound, k.exact]).sort(), [['maximum', 2 ** 31 - 1, true], ['minimum', 0, true]]);
});

test('reading: a character class is a constraint only beside a plain value of the same length, accepted again after the repeat', async () => {
  const onlyAscii = (v: unknown): Answer => (/^[\x20-\x7e]*$/.test(v as string) ? { ok: true, text: 'ok' } : { ok: false, text: 'title: only ASCII characters are allowed' });
  const r = readIn5(await simulate(S({ title: { type: 'string', maxLength: 50 } }), 'title', onlyAscii));
  assert.ok(r.confirmed.length >= 1 && r.confirmed.every((k) => k.keyword === 'pattern'));
  assert.ok(r.confirmed.every((k) => k.steps.length === 4));
  const ch = (ok: boolean, o: Partial<In5Call> = {}) => call('title', 0, ok, { cls: 'chars.emoji', dim: undefined, n: undefined, plain_len: 9, text: ok ? 'ok' : 'title: only letters and digits are allowed', ...o });
  assert.equal(readIn5([ch(false), ch(false, { context: 'B', repeat_of: 'refused' })]).confirmed.length, 0, 'no plain neighbour');
});

test('reading: the declaration (fixed_constraints) confirms a refusal without the differential reading', () => {
  const r = readIn5([call('title', 150, false, { phase: 'declared', cls: 'declared' })], [{ arg: 'title', pattern: 'at most \\d+ characters', reason: 'a fixed limit' }]);
  assert.deepEqual(r.confirmed.map((k) => [k.keyword, k.reading_by]), [['declared', 'declaration']]);
  // a success after which a declared value is not stored counts as refused (spec R10-8)
  const quiet = readIn5([call('title', 150, true, { phase: 'declared', cls: 'declared', stored: false, text: 'Updated.' })]);
  assert.equal(quiet.seen.length, 1);
});

test('interleave: round-robin over the arguments, each scrambled, deterministic', () => {
  const a = [0, 1, 2, 3].map((n) => ({ arg: 'a', cls: 'length', n }));
  const b = [0, 1].map((n) => ({ arg: 'b', cls: 'length', n }));
  const x = interleave([a, b]);
  assert.deepEqual(x.slice(0, 4).map((p) => p.arg), ['a', 'b', 'a', 'b']);
  assert.deepEqual(x, interleave([a, b]));
  assert.notDeepEqual(x.filter((p) => p.arg === 'a').map((p) => p.n), [0, 1, 2, 3], 'not ascending');
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

function obs(calls: In5Call[], o: Partial<ToolObs5> = {}): ToolObs5 {
  return { tool: 'ticket_update', role: 'update', from: 'ticket.update', args_total: 4, args: [{ arg: 'title', probes: 9 }, { arg: 'id', probes: 0, skipped: 'not probed: the identifier', rule: 'names the object, scope, version or key' }, { arg: 'status', probes: 0, skipped: 'no probe: enum', rule: 'enum or const' }, { arg: 'code', probes: 0, skipped: 'no probe: no valid value' }], calls, hints: [], cap: 80, used: calls.length, cut: null, notes: [], ...o };
}

test('verdict: by default a constraint only the differential reading confirms is a candidate in a not observed record', async () => {
  const r = in5SearchVerdict(obs(await simulate(S({ title: { type: 'string' } }), 'title', lenOracle(100))), RES);
  assert.equal(r.verdict, 'not observed');
  assert.match(r.reason, /candidate constraint/);
  assert.ok(r.notes.some((n) => /^Candidate constraint, seen, not judged: title: maxLength 100/.test(n)));
  assert.equal(r.numbers['confirmed'], 0);
  assert.equal(r.numbers['candidates'], 1);
  assert.deepEqual((r.numbers['constraints'] as { bound: number; candidate?: boolean }[]).map((k) => [k.bound, k.candidate]), [[100, true]]);
});

test('verdict: with --in5-reading=tester it is violated, with the reading and the evidence it rests on', async () => {
  const r = in5SearchVerdict(obs(await simulate(S({ title: { type: 'string' } }), 'title', lenOracle(100))), RES, 'tester');
  assert.equal(r.verdict, 'violated');
  assert.equal(r.write_path.tool, 'ticket_update');
  assert.match(r.reason, /title: maxLength 100 \(100 characters accepted, 101 characters refused\)/);
  assert.ok(r.notes.some((n) => /Reading by: tester \(differential probe\)/.test(n)));
  assert.equal(r.steps.length, 4);
});

test('verdict: not observed carries the scope searched in its numbers (review M5); never held', () => {
  const ok = in5SearchVerdict(obs([call('title', 1, true), call('title', 200, true)]), RES);
  assert.equal(ok.verdict, 'not observed');
  assert.deepEqual(
    [ok.numbers['args_total'], ok.numbers['args_searchable'], ok.numbers['args_judged'], ok.numbers['args_probed'], ok.numbers['probes'], ok.numbers['refusals'], ok.numbers['confirmed']],
    [4, 2, 1, 1, 2, 0, 0],
  );
  assert.deepEqual(ok.numbers['args_skipped'], { 'names the object, scope, version or key': 1, 'enum or const': 1 });
  assert.ok(ok.notes[0]!.startsWith('Scope of the search: 1 of 2 searchable argument(s)'));
  const seen = in5SearchVerdict(obs([call('title', 1, true), call('title', 200, false)]), RES);
  assert.equal(seen.verdict, 'not observed');
  assert.ok(seen.notes.some((n) => /^Seen, not judged: title=/.test(n) && /must be at most 100 characters/.test(n)));
  assert.equal(in5SearchVerdict(obs([]), RES).verdict, 'not tested');
  assert.equal(in5SearchVerdict(obs([], { args_total: 0, args: [] }), RES).verdict, 'not applicable');
  assert.match(in5SearchVerdict(obs([], { not_probed: 'the base call did not succeed' }), RES).reason, /not searched/);
});
