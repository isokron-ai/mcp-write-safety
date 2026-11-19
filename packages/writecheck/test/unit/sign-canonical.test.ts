/**
 * p08: the canonical form a results signature covers is injective, stable across parse and serialise, and refuses hostile
 * input (number text beyond double precision, lone surrogates, deep nesting, bytes that are not UTF-8) cleanly.
 */

import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync, sign as edSign, type KeyObject } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { verifyResultsCommand } from '../../src/cli/compare.js';
import { canonical, canonicalStrict, jsonTextProblem, MAX_JSON_DEPTH, WritecheckError } from '../../src/core/util.js';
import { BOUND_MEMBERS, duplicateKey, keyId, parseResultsBytes, RESULTS_SIGNATURE_DOMAIN, RESULTS_SIGNATURE_FORMAT, signResults, verifyResults } from '../../src/report/sign.js';

type Doc = Record<string, unknown> & { evidence: Record<string, unknown> };

const doc = (extra: Record<string, unknown> = {}): Doc => ({
  format: 'mws-results/1',
  run: { id: 'r1', status: 'complete' },
  results: [{ requirement: 'MWS-X-1', verdict: 'held', reason: 'ok', numbers: { big: 9007199254740992, one: 1, small: 1.5e-7, huge: 1e21, neg: -5 } }],
  evidence: { capture: null, checksums: 'SHA256SUMS', signature: null },
  ...extra,
});

const refused = (code: number, re?: RegExp) => (e: unknown) => e instanceof WritecheckError && e.code === code && (!re || re.test(e.message));

/** A signature made the way the code before p08 made it (recursive `canonical`, no input checks). */
function legacySign(d: Doc, key: KeyObject): Record<string, unknown> {
  const pub = createPublicKey(key);
  const meta = { format: RESULTS_SIGNATURE_FORMAT, alg: 'ed25519', key_id: keyId(pub), sums: null };
  const bound = Object.fromEntries(BOUND_MEMBERS.map((k) => [k, (meta as Record<string, unknown>)[k] ?? null]));
  const body = canonical({ ...d, evidence: { ...d.evidence, signature: bound } });
  const digest = `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`;
  const value = edSign(null, Buffer.from(RESULTS_SIGNATURE_DOMAIN + body, 'utf8'), key).toString('base64');
  return { ...meta, public_key_pem: pub.export({ format: 'pem', type: 'spki' }).toString(), digest, value };
}

/** A value nested `n` levels deep (`{"a":{"a":…1}}`), built without recursion. */
function nested(n: number): unknown {
  let v: unknown = 1;
  for (let i = 0; i < n; i++) v = { a: v };
  return v;
}

test('p08 canonical form: byte-identical to the earlier form for ordinary documents, so earlier signatures still verify', () => {
  const values: unknown[] = [doc(), { b: [1, 'x', null, true, { '\u00e9': 'e\u0301', 'e\u0301': '\u00e9', '\u{1F600}': '\ud83d\ude00' }], a: -0, c: [] }, [0.1, 1e-7, 123456789012, 2 ** 53, -(2 ** 60)], 'plain', 0, nested(MAX_JSON_DEPTH - 1)];
  for (const v of values) assert.equal(canonicalStrict(v), canonical(v));
  const { privateKey } = generateKeyPairSync('ed25519');
  const d = doc();
  d.evidence['signature'] = legacySign(d, privateKey);
  const round = parseResultsBytes(Buffer.from(JSON.stringify(d, null, 2)), 'f') as Doc;
  assert.equal(verifyResults(round, createPublicKey(privateKey)).status, 'valid', 'a signature made by the earlier code verifies unchanged');
});

test('p08 stability: canonicalise, parse, canonicalise again gives the same bytes; the canonical text is accepted as is', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const leaf = (): unknown => {
    const r = rnd();
    if (r < 0.2) return Math.round(rnd() * 1e6) - 5e5;
    if (r < 0.35) return (rnd() - 0.5) * 10 ** Math.floor(rnd() * 40 - 20);
    if (r < 0.5) return String.fromCharCode(...Array.from({ length: 6 }, () => [0x41, 0xe9, 0x22, 0x5c, 0x0a, 0x2028, 0x4e2d][Math.floor(rnd() * 7)]!));
    if (r < 0.6) return '😀';
    return [true, false, null][Math.floor(rnd() * 3)];
  };
  const gen = (d: number): unknown => {
    if (d > 4 || rnd() < 0.3) return leaf();
    if (rnd() < 0.5) return Array.from({ length: Math.floor(rnd() * 4) }, () => gen(d + 1));
    return Object.fromEntries(Array.from({ length: Math.floor(rnd() * 4) }, (_, i) => [`k${Math.floor(rnd() * 9)}${i}`, gen(d + 1)]));
  };
  for (let n = 0; n < 300; n++) {
    const v = gen(0);
    const c = canonicalStrict(v);
    assert.equal(jsonTextProblem(c), null, c);
    assert.equal(canonicalStrict(JSON.parse(c)), c);
    // Pretty-printed and with members reversed: the same canonical bytes.
    const shuffled = JSON.stringify(v, (_k, x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).reverse()) : x), 3);
    assert.equal(jsonTextProblem(shuffled), null);
    assert.equal(canonicalStrict(JSON.parse(shuffled)), c);
  }
});

test('p08 numbers: text not written as RFC 8785 writes it is refused, so number text cannot change under a signature', () => {
  for (const bad of ['1.0', '1e0', '1.0e0', '-0', '1E2', '0.10', '9007199254740993', '18446744073709551616', '123456789012345678901234567890', '1e400', '-1e400', '1e21', '100000000000000000000000'])
    assert.equal(jsonTextProblem(`{"n":${bad}}`)?.kind, 'number', bad);
  for (const ok of ['0', '1', '-5', '0.1', '1.5e-7', '1e+21', '9007199254740992', '9007199254740991', '-9007199254740991', '5e-324', '1.7976931348623157e+308'])
    assert.equal(jsonTextProblem(`{"n":${ok}}`), null, ok);
  // Two texts a JavaScript reader parses alike: only one can be accepted, so they never share a signature.
  const a = '{"n":9007199254740992}';
  const b = '{"n":9007199254740993}';
  assert.equal(canonical(JSON.parse(a)), canonical(JSON.parse(b)), 'the parsed values collide');
  assert.equal(jsonTextProblem(a), null);
  assert.throws(() => parseResultsBytes(Buffer.from(b), 'f'), refused(3, /9007199254740993 is not written as RFC 8785 writes its value \(9007199254740992\)/));
  // Through verify-results: a signed file whose number text was edited is refused (exit 3), never "valid".
  const { privateKey } = generateKeyPairSync('ed25519');
  const dir = mkdtempSync(join(tmpdir(), 'mwsc-p08-'));
  try {
    writeFileSync(join(dir, 'pub.pem'), createPublicKey(privateKey).export({ format: 'pem', type: 'spki' }));
    const d = doc();
    d.evidence['signature'] = signResults(d, privateKey);
    const text = JSON.stringify(d);
    mkdirSync(join(dir, 'run'));
    writeFileSync(join(dir, 'run', 'results.json'), text);
    assert.equal(verifyResultsCommand({ file: join(dir, 'run'), pubkey: join(dir, 'pub.pem'), log: () => {} }).exit, 0);
    for (const [from, to] of [
      ['"big":9007199254740992', '"big":9007199254740993'],
      ['"one":1', '"one":1.0e0'],
      ['"huge":1e+21', '"huge":1000000000000000000000'],
    ] as const) {
      assert.ok(text.includes(from), from);
      writeFileSync(join(dir, 'run', 'results.json'), text.replace(from, to));
      assert.throws(() => verifyResultsCommand({ file: join(dir, 'run'), pubkey: join(dir, 'pub.pem'), log: () => {} }), refused(3, /RFC 8785/), to);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('p08 lone surrogates: refused when signing, refused when reading, and an earlier signature over one is invalid', () => {
  assert.throws(() => canonicalStrict({ s: 'x\ud800' }), refused(3, /\$\.s: a string with a lone surrogate/));
  assert.throws(() => canonicalStrict({ s: '\udc00x' }), refused(3));
  assert.throws(() => canonicalStrict({ ['k\ud800']: 1 }), refused(3, /member name with a lone surrogate/));
  assert.equal(canonicalStrict({ s: '😀' }), '{"s":"\u{1F600}"}', 'a pair is text');
  for (const t of ['{"s":"\\ud800"}', '{"s":"a\\udfffb"}', '{"\\ud800":1}', '["\\ud83d"]', `{"s":"${'\ud800'}"}`]) assert.equal(jsonTextProblem(t)?.kind, 'string', t);
  assert.equal(jsonTextProblem('{"s":"\\ud83d\\ude00"}'), null);
  const { privateKey } = generateKeyPairSync('ed25519');
  const d = doc();
  (d['results'] as { reason: string }[])[0]!.reason = 'ok\ud800';
  assert.throws(() => signResults(d, privateKey), refused(3, /lone surrogate/), 'never signed');
  // A file signed by the earlier code with a lone surrogate: the reader refuses it, and verifyResults on the value says invalid.
  d.evidence['signature'] = legacySign(d, privateKey);
  const out = verifyResults(d, createPublicKey(privateKey));
  assert.equal(out.status, 'invalid');
  assert.match(out.detail, /no RFC 8785 canonical form.*lone surrogate/);
  assert.throws(() => parseResultsBytes(Buffer.from(JSON.stringify(d)), 'f'), refused(3, /lone surrogate/));
});

test('p08 deep nesting: refused cleanly at the limit, by the reader, the duplicate scan, signing and verifying; never a stack overflow', () => {
  const deepText = (n: number) => `{"nest":${'{"a":'.repeat(n)}1${'}'.repeat(n)}}`;
  assert.equal(jsonTextProblem(deepText(MAX_JSON_DEPTH - 1)), null, 'MAX_JSON_DEPTH objects, the outer one counted');
  assert.equal(jsonTextProblem(deepText(MAX_JSON_DEPTH))?.kind, 'depth');
  assert.equal(jsonTextProblem(`${'['.repeat(200000)}${']'.repeat(200000)}`)?.kind, 'depth');
  const t = deepText(20000);
  assert.equal(duplicateKey(t), null);
  assert.throws(() => parseResultsBytes(Buffer.from(t), 'f'), refused(3, new RegExp(`nesting deeper than ${MAX_JSON_DEPTH} levels`)));
  assert.ok(String(jsonTextProblem(t)?.message).length < 220, 'the error line is short');
  // The value-level limit matches the text-level one.
  assert.doesNotThrow(() => canonicalStrict(nested(MAX_JSON_DEPTH)), 'MAX_JSON_DEPTH objects, as in the text');
  assert.throws(() => canonicalStrict(nested(MAX_JSON_DEPTH + 1)), refused(3, /nesting deeper/));
  assert.throws(() => canonicalStrict(nested(100000)), refused(3, /nesting deeper/));
  const { privateKey } = generateKeyPairSync('ed25519');
  const d = doc({ nest: nested(20000) });
  assert.throws(() => signResults(d, privateKey), refused(3, /nesting deeper/));
  d.evidence['signature'] = { format: RESULTS_SIGNATURE_FORMAT, alg: 'ed25519', key_id: keyId(privateKey), value: 'AA==', digest: 'x', sums: null };
  assert.equal(verifyResults(d, null).status, 'invalid');
});

test('p08 bytes: not UTF-8 or a byte order mark is refused (exit 3); text that is not JSON is exit 2; duplicates still exit 3', () => {
  const good = Buffer.from('{"s":"ok"}');
  assert.deepEqual(parseResultsBytes(good, 'f'), { s: 'ok' });
  // Two different invalid byte sequences would both decode to U+FFFD under a lenient decoder.
  for (const b of [Buffer.from([0x7b, 0x22, 0x73, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]), Buffer.from([0x7b, 0x22, 0x73, 0x22, 0x3a, 0x22, 0xc3, 0x22, 0x7d]), Buffer.from([0x7b, 0x22, 0x73, 0x22, 0x3a, 0x22, 0xed, 0xa0, 0x80, 0x22, 0x7d])])
    assert.throws(() => parseResultsBytes(b, 'f'), refused(3, /not valid UTF-8/));
  assert.throws(() => parseResultsBytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), good]), 'f'), refused(3, /byte order mark/));
  for (const t of ['{"a":1', '{"a":1}x', '{"a":01}', '{"a":.5}', "{'a':1}", '{"a":tru}', '{"a"1}', '[1,]', '', '{"a":"\u0001"}']) assert.throws(() => parseResultsBytes(Buffer.from(t), 'f'), refused(2, /not JSON/), t);
  assert.throws(() => parseResultsBytes(Buffer.from('{"a":1,"b":{"c":[{"d":1,"d":2}]}}'), 'f'), refused(3, /the member \$\.b\.c\[0\]\.d appears twice/));
});
