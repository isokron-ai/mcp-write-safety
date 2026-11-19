/**
 * What the tester writes, against what it publishes about it (test/publish-lint.ts):
 *
 *   compare.json      a compare of two results files that reaches every transition the code can give (and the slot lists)
 *                     validates against schema/mws-compare-1.schema.json, member for member; the schema's transition and
 *                     label lists are exactly the ones reached, and `facets` is allowed on `subject-changed` only.
 *   emitted text      no string literal of src/ names a product the tester was tried on or cites a review of the tester, so no
 *                     record, report or line of command output can.
 *
 * results.json is checked the same way on every fixture run, by the shared harnesses (test/fake, test/regression,
 * test/tiny-tracker) and test/integration/identity-run.test.ts.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';

import ts from 'typescript';

import { compareCommand } from '../../src/cli/compare.js';
import { TEST_HASH_FORMAT } from '../../src/core/identity.js';
import { validates } from '../../src/core/jsonschema.js';
import type { CompareDoc, Transition } from '../../src/report/compare.js';
import { assertMatchesSchema, assertNoBannedText, bannedIn, PKG, schemaFile, undeclaredMembers } from '../publish-lint.js';

type Rec = { requirement: string; level: string; write_path: { resource: string; tool: string; arm: 'mcp' }; scenario: { id: string; version: string }; verdict: string; reason: string; test_hash?: string; test_hash_core?: string; validity?: { counts: boolean } };

const h = (s: string) => `sha256:${s.padEnd(64, '0')}`;
/** One record of the cell `<requirement>@<tool>`: slot `sc`, test hash `hash` (none when null), `core` for a judged-part requirement. */
const R = (tool: string, verdict: string, hash: string | null, o: { req?: string; sc?: string; core?: string; suspect?: boolean } = {}): Rec => ({
  requirement: o.req ?? 'MWS-CONC-1',
  level: 'MUST',
  write_path: { resource: 'ticket', tool, arm: 'mcp' },
  scenario: { id: o.sc ?? 's1', version: '1' },
  verdict,
  reason: `${verdict} on ${tool}`,
  ...(hash ? { test_hash: h(hash) } : {}),
  ...(o.core ? { test_hash_core: h(o.core) } : {}),
  ...(o.suspect ? { validity: { counts: false } } : {}),
});

/** Per transition: the tool that names the cell, and its records before and after. */
const CASES: Record<Transition, { before: Rec[]; after: Rec[] }> = {
  fixed: { before: [R('fixed', 'violated', 'a1')], after: [R('fixed', 'held', 'a1')] },
  regressed: { before: [R('regressed', 'held', 'a1')], after: [R('regressed', 'violated', 'a1')] },
  // Two slots that swap: the roll-up stays violated, both slots moved, and one of them regressed.
  'still-violated': { before: [R('still', 'held', 'a1'), R('still', 'violated', 'a2', { sc: 's2' })], after: [R('still', 'violated', 'a1'), R('still', 'held', 'a2', { sc: 's2' })] },
  'held-both': { before: [R('held', 'held', 'a1')], after: [R('held', 'held', 'a1')] },
  'platform-both': { before: [R('platform', 'platform', 'a1')], after: [R('platform', 'platform', 'a1')] },
  same: { before: [R('same', 'not observed', 'a1')], after: [R('same', 'not observed', 'a1')] },
  '→platform': { before: [R('to-platform', 'held', 'a1')], after: [R('to-platform', 'platform', 'a1')] },
  'platform→': { before: [R('from-platform', 'platform', 'a1')], after: [R('from-platform', 'held', 'a1')] },
  'not-seen-after': { before: [R('not-seen', 'violated', 'a1')], after: [R('not-seen', 'not observed', 'a1')] },
  changed: { before: [R('changed', 'held', 'a1')], after: [R('changed', 'not observed', 'a1')] },
  'coverage-change': { before: [R('coverage', 'held', 'a1')], after: [R('coverage', 'not tested', 'a1')] },
  'test-changed': { before: [R('test', 'held', 'a1')], after: [R('test', 'held', 'b1')] },
  'no-test-hash': { before: [R('no-hash', 'held', null)], after: [R('no-hash', 'held', 'a1')] },
  unstable: { before: [R('unstable', 'violated', 'a1', { suspect: true })], after: [R('unstable', 'held', 'a1')] },
  // The run's own cell (below) says held; its records roll up to violated.
  'rollup-mismatch': { before: [R('rollup', 'violated', 'a1')], after: [R('rollup', 'held', 'a1')] },
  'new-cell': { before: [], after: [R('new', 'held', 'a1')] },
  'removed-cell': { before: [R('removed', 'held', 'a1')], after: [] },
  // The cell is held after, but a slot violated before (a violation that does not count) is not held after.
  'partly-held': { before: [R('partly', 'violated', 'a1'), R('partly', 'violated', 'a2', { sc: 's2', suspect: true })], after: [R('partly', 'held', 'a1'), R('partly', 'violated', 'a2', { sc: 's2', suspect: true })] },
  // Only the judged part differs (equal test_hash_core): the schema here; the annotations and the description below.
  'subject-changed': { before: [R('subject', 'violated', 'a1', { req: 'MWS-IN-2', core: 'c1' })], after: [R('subject', 'not observed', 'b1', { req: 'MWS-IN-2', core: 'c1' })] },
  'schema-fixed': { before: [R('schema', 'violated', 'a1', { req: 'MWS-IN-3', core: 'c1' })], after: [R('schema', 'held', 'b1', { req: 'MWS-IN-3', core: 'c1' })] },
};
const MORE_SUBJECTS: { before: Rec[]; after: Rec[] }[] = [
  { before: [R('subject-ann', 'held', 'a1', { req: 'MWS-ANN-1', core: 'c1' })], after: [R('subject-ann', 'held', 'b1', { req: 'MWS-ANN-1', core: 'c1' })] },
  { before: [R('subject-desc', 'held', 'a1', { req: 'MWS-CONC-5', core: 'c1' })], after: [R('subject-desc', 'held', 'b1', { req: 'MWS-CONC-5', core: 'c1' })] },
];

const resultsDoc = (results: Rec[], cells: { key: string; verdict: string }[]) => ({
  format: 'mws-results/1',
  suite: { name: 'mcp-writecheck', version: '0.1.0' },
  spec: { version: '0.9' },
  run: { id: 'r1', status: 'complete', stopped_reason: null, started: 's', ended: 'e' },
  manifest: { path: 'manifest.yaml', sha256: 'm1' },
  plan: { hash: 'p1' },
  results,
  cells,
  evidence: { capture: null, checksums: 'SHA256SUMS', signature: null },
  identity: { test_hash: TEST_HASH_FORMAT, tester: { commit: 'a'.repeat(40) }, tools_fingerprint: 't1', server: { repo: 'https://example.invalid/server', commit: 'b'.repeat(40) }, backend: [{ name: 'db', image: null, version: null }], gaps: ['server.image: not stated'] },
});

/** compare.json and compare.md as `mcp-writecheck compare` writes them for the cases above. */
function compared(): { doc: CompareDoc; md: string } {
  const dir = mkdtempSync(join(tmpdir(), 'mwsc-publish-'));
  try {
    const all = [...Object.values(CASES), ...MORE_SUBJECTS];
    const write = (name: 'before' | 'after') => {
      mkdirSync(join(dir, name));
      const cells = name === 'before' ? [{ key: 'MWS-CONC-1@rollup', verdict: 'held' }] : [];
      writeFileSync(join(dir, name, 'results.json'), JSON.stringify(resultsDoc(all.flatMap((c) => c[name]), cells), null, 2) + '\n');
      return join(dir, name);
    };
    compareCommand({ before: write('before'), after: write('after'), out: join(dir, 'out'), log: () => {} });
    return { doc: JSON.parse(readFileSync(join(dir, 'out', 'compare.json'), 'utf8')) as CompareDoc, md: readFileSync(join(dir, 'out', 'compare.md'), 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('compare.json: every transition the code gives, with facets and the slot lists, matches mws-compare-1 member for member', () => {
  const { doc, md } = compared();
  const schema = schemaFile('mws-compare-1');
  assertMatchesSchema('mws-compare-1', doc, 'compare.json');
  assertNoBannedText(doc, { 'compare.md': md });

  // Each case gave the transition it is named for, so the document above holds every one of them.
  const by = new Map(doc.cells.map((c) => [c.tool, c]));
  for (const [transition, c] of Object.entries(CASES)) {
    const tool = (c.before[0] ?? c.after[0])!.write_path.tool;
    assert.equal(by.get(tool)?.transition, transition, `the cell of ${tool}`);
  }

  // The schema lists exactly the transitions and labels the code gives: one added on either side alone fails here.
  const cell = ((schema['properties'] as Record<string, { items: { properties: Record<string, { enum: string[] }> } }>)['cells']!).items.properties;
  assert.deepEqual([...cell['transition']!.enum].sort(), Object.keys(CASES).sort(), 'the transitions of the schema are the transitions of the code');
  assert.deepEqual([...cell['label']!.enum].sort(), [...new Set(doc.cells.map((c) => c.label))].sort(), 'the labels of the schema are the labels of the code');

  // facets: on subject-changed and nowhere else, one of the three judged parts.
  const withFacets = doc.cells.filter((c) => c.facets !== undefined);
  assert.deepEqual(withFacets.map((c) => c.transition), ['subject-changed', 'subject-changed', 'subject-changed']);
  assert.deepEqual(withFacets.map((c) => [c.tool, c.facets]).sort(), [['subject', ['schema']], ['subject-ann', ['annotations']], ['subject-desc', ['description']]]);
  assert.equal(by.get('schema')!.facets, undefined, 'schema-fixed carries none');

  // The slot lists are present: a cell whose slots swapped, and warned about.
  assert.deepEqual(by.get('still')!.slot_moves, [{ slot: 'ticket/s1', before: 'held', after: 'violated' }, { slot: 'ticket/s2', before: 'violated', after: 'held' }]);
  assert.deepEqual(by.get('still')!.slot_regressions, ['ticket/s1 held → violated']);
  assert.ok(by.get('partly')!.slot_moves?.length, 'slot_moves on a partly-held cell');
  assert.ok(doc.warnings.some((w) => /slot regressed/.test(w)));

  // The schema refuses facets anywhere else, a subject-changed cell without them, and a part it does not know.
  const edit = (tool: string, f: (c: Record<string, unknown>) => void) => {
    const d = JSON.parse(JSON.stringify(doc)) as { cells: Record<string, unknown>[] };
    f(d.cells.find((c) => c['tool'] === tool)!);
    return validates(schema, d);
  };
  assert.equal(edit('fixed', (c) => (c['facets'] = ['schema'])), false, 'facets on a fixed cell');
  assert.equal(edit('schema', (c) => (c['facets'] = ['schema'])), false, 'facets on a schema-fixed cell');
  assert.equal(edit('subject', (c) => delete c['facets']), false, 'subject-changed without facets');
  assert.equal(edit('subject', (c) => (c['facets'] = ['title'])), false, 'an unknown part');
  assert.equal(edit('subject', (c) => (c['facets'] = ['schema', 'description'])), true, 'two parts');
  assert.equal(edit('fixed', (c) => (c['score'] = 1)), false, 'no other member');
});

test('undeclaredMembers: a member the schema does not name is found in an open object too', () => {
  const schema = { type: 'object', properties: { a: { type: 'object', properties: { x: {} } }, list: { type: 'array', items: { oneOf: [{ type: 'null' }, { type: 'object', properties: { y: {} } }] } }, open: { type: 'object' }, map: { type: 'object', properties: {}, additionalProperties: { type: 'string' } } } };
  assert.deepEqual(undeclaredMembers(schema, { a: { x: 1 }, list: [null, { y: 1 }], open: { anything: 1 }, map: { k: 'v' } }), []);
  assert.deepEqual(undeclaredMembers(schema, { a: { x: 1, extra: 1 }, list: [{ y: 1, z: 1 }], b: 1 }), ['$.a.extra', '$.b', '$.list[].z']);
});

/** Every string literal and template part of a source file, with its line. */
function literals(file: string): { line: number; text: string }[] {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
  const out: { line: number; text: string }[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) out.push({ line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, text: n.text });
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const sources = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? sources(join(dir, n)) : n.endsWith('.ts') ? [join(dir, n)] : []));

test('emitted text: no string of src/ names a product the tester was tried on, or cites a review of the tester', () => {
  // why: a record's reason, a note, a report line and a line of command output are all built from string literals of src/;
  // comments are not literals, so a `// why:` may still say where a rule came from.
  const files = sources(join(PKG, 'src'));
  assert.ok(files.length > 50, 'src/ was read');
  const all = files.flatMap((f) => literals(f).map((l) => ({ ...l, file: relative(PKG, f) })));
  assert.ok(all.length > 5000, 'its string literals were read');
  const bad = all.flatMap((l) => bannedIn(l.text).map((b) => `${l.file}:${l.line}: ${b}`));
  assert.deepEqual(bad, []);

  // The scan sees what it is for, and leaves alone what only looks like it.
  for (const s of ['the attribution stays unresolved (gate-2 Grafana item 3).', 'through the declared control.patch (research builds N3).', 'a Kubernetes Status with reason Conflict', 'kept once (t11)', 'see note 19', 'review R2', 'the Payload build', 'by the interim rule of the before/after design']) assert.ok(bannedIn(s).length, s);
  for (const s of ['needs backend.gate', 'limits.in5_payload_bytes', 'github-actions', 'GITHUB_RUN_ID', 'payload too large', '2026-11-18T10:00:00Z', 'spec 8.2, rule 6', 'a status object with reason Conflict', 'not tested']) assert.deepEqual(bannedIn(s), [], s);
});
