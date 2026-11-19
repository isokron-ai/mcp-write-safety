import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { draftManifest, split } from '../../src/cli/init.js';
import { main } from '../../src/cli/main.js';
import { FaultStore } from '../../src/gate/faults.js';
import { GateNotBuilt, lastMutating } from '../../src/gate/gate.js';
import { installOutbound } from '../../src/gate/outbound.js';
import { parseManifestText } from '../../src/core/manifest.js';
import { buildPlan, planHash } from '../../src/core/plan.js';
import { applyBaseline, exitCodeFor } from '../../src/report/baseline.js';
import { signChecksums, verifyChecksums, writeChecksums } from '../../src/report/evidence.js';
import { renderJunit } from '../../src/report/junit.js';
import { renderMarkdown } from '../../src/report/markdown.js';
import { RESULTS_KEYS, RESULTS_KEYS_WRITTEN, type ResultsDoc } from '../../src/report/results.js';
import { result } from '../../src/report/verdicts.js';
import { COVERAGE, previewSentence, REQUIREMENTS } from '../../src/requirements.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..', '..', '..');

const w = { resource: 'ticket', tool: 'ticket_update', arm: 'mcp' as const };
const sc = { id: 'x', version: '1' };
const results = [
  result('MWS-CONC-3', w, sc, 'violated', 'lost'),
  result('MWS-UPD-1', w, sc, 'held', 'only named'),
  result('MWS-CONC-2', w, sc, 'not observed', 'none seen'),
  result('MWS-ANN-4', { resource: '(catalog)', tool: 't', arm: 'mcp' }, sc, 'violated', 'no hint'),
];
const doc = (): ResultsDoc => ({
  format: 'mws-results/1',
  scope: 'Scope: test.',
  suite: { name: 'mcp-writecheck', version: '0' },
  spec: { version: '0.9' },
  run: { id: 'r', prefix: 'mwsc-r-', started: 'a', ended: 'b', status: 'complete', stopped_reason: null, writes: 1, processes_started: 1 },
  target: { confirm: 't', environment: 'test', server: 's', catalog_fingerprint: 'sha256:x', guard: null },
  manifest: { path: 'manifest.yaml', sha256: 'm' },
  plan: { hash: 'h' },
  results,
  cells: [],
  not_built: [],
  measurements: null,
  leftovers: [],
  cleanup: null,
  observations: [],
  evidence: { capture: null, checksums: 'SHA256SUMS', signature: null },
  safety: { canaries: [], fixtures_restored: [], gate: null, protocol: null, rerun_of: null },
});

test('the requirement registry has 37 permanent MWS- ids, unique', () => {
  assert.equal(REQUIREMENTS.length, 37);
  assert.equal(new Set(REQUIREMENTS.map((r) => r.id)).size, 37);
  assert.ok(REQUIREMENTS.every((r) => /^MWS-[A-Z]+-\d+$/.test(r.id)));
  assert.equal(REQUIREMENTS.filter((r) => r.level === 'MUST').length, 26);
});

test('results schema: exactly the document keys, no additional top-level property, no aggregate field', () => {
  const schema = JSON.parse(readFileSync(join(pkg, 'schema', 'mws-results-1.schema.json'), 'utf8')) as { additionalProperties: boolean; properties: Record<string, unknown>; required: string[] };
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.properties), [...RESULTS_KEYS_WRITTEN]);
  assert.deepEqual(Object.keys(doc()), [...RESULTS_KEYS]);
  const text = JSON.stringify(schema);
  for (const banned of ['score', 'passed', 'percent', 'total', 'grade', 'summary']) assert.ok(!new RegExp(`"${banned}"`).test(text), `schema has no ${banned}`);
});

test('JUnit: held passes, violated fails, everything else is skipped; a baselined violation is skipped', () => {
  const x = renderJunit(doc(), applyBaseline(results, ['MWS-ANN-4 (catalog):t']));
  const cases = x.split('<testcase').slice(1);
  const of = (name: string) => cases.find((c) => c.includes(name))!;
  assert.match(of('MWS-CONC-3 ticket:ticket_update'), /<failure/);
  assert.doesNotMatch(of('MWS-UPD-1'), /<failure|<skipped/);
  assert.match(of('MWS-CONC-2'), /<skipped message="not observed/);
  assert.match(of('MWS-ANN-4'), /<skipped message="violated \(known/);
  assert.doesNotMatch(x, /tests="|failures="|skipped="/, 'no counts on the suites');
});

test('baseline: known violations pass, new MUST violations and stale entries fail', () => {
  assert.equal(exitCodeFor(applyBaseline(results, ['MWS-CONC-3 ticket:ticket_update'])), 0, 'the SHOULD violation (ANN-4) does not set the exit status');
  assert.equal(exitCodeFor(applyBaseline(results, [])), 1);
  const stale = applyBaseline(results, ['MWS-CONC-3 ticket:ticket_update', 'MWS-UPD-1 ticket:ticket_update', 'MWS-IN-1 ticket:ticket_update']);
  assert.deepEqual(stale.stale, ['MWS-UPD-1 ticket:ticket_update'], 'held now: the entry is stale');
  assert.deepEqual(stale.not_rechecked, ['MWS-IN-1 ticket:ticket_update'], 'no verdict this run: neither stale nor known');
  assert.equal(exitCodeFor(stale), 1);
  assert.equal(exitCodeFor(applyBaseline(results, ['MWS-CONC-3 ticket:ticket_update', 'MWS-IN-1 ticket:ticket_update'])), 0, 'a baseline entry whose check did not run does not fail the run');
});

test('report.md starts with the scope sentence and carries no summary count', () => {
  const md = renderMarkdown(doc());
  assert.equal(md.split('\n')[0], 'Scope: test.');
  assert.doesNotMatch(md.replace('There is no total and no score.', ''), /\b\d+ of \d+ (requirements|checks)|passed|score|\d+\s*%/i);
});

test('evidence: SHA256SUMS detects a changed file; an SSH signature verifies with ssh-keygen alone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mwsc-ev-'));
  try {
    mkdirSync(join(dir, 'capture'));
    writeFileSync(join(dir, 'results.json'), '{}');
    writeFileSync(join(dir, 'capture', 'capture.jsonl'), 'x\n');
    writeChecksums(dir);
    assert.ok(verifyChecksums(dir).ok);
    if (spawnSync('ssh-keygen', ['-?'], { stdio: 'ignore' }).error === undefined) {
      const keyDir = mkdtempSync(join(tmpdir(), 'mwsc-key-'));
      try {
        spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'throwaway-test-key', '-f', join(keyDir, 'k')]);
        signChecksums(dir, join(keyDir, 'k'));
        assert.ok(existsSync(join(dir, 'SHA256SUMS.sig')));
        writeFileSync(join(keyDir, 'allowed'), `test@mwsc ${readFileSync(join(keyDir, 'k.pub'), 'utf8')}`);
        const v = spawnSync('ssh-keygen', ['-Y', 'verify', '-f', join(keyDir, 'allowed'), '-I', 'test@mwsc', '-n', 'mcp-writecheck', '-s', join(dir, 'SHA256SUMS.sig')], { input: readFileSync(join(dir, 'SHA256SUMS')) });
        assert.equal(v.status, 0, String(v.stderr));
      } finally {
        rmSync(keyDir, { recursive: true, force: true });
      }
    }
    writeFileSync(join(dir, 'results.json'), '{"edited":true}');
    assert.deepEqual(verifyChecksums(dir).bad, ['results.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const TOOLS = [
  { name: 'whoami', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'get_ticket', inputSchema: { type: 'object', properties: { ticket_id: { type: 'string' } } }, annotations: { readOnlyHint: true } },
  { name: 'update_ticket', inputSchema: { type: 'object', properties: { ticket_id: { type: 'string' }, title: { type: 'string' }, assignee: { type: 'string' }, expected_version: { type: 'integer' } } } },
  { name: 'create_ticket', inputSchema: { type: 'object', properties: { title: { type: 'string' } } } },
  { name: 'delete_ticket', inputSchema: { type: 'object', properties: { ticket_id: { type: 'string' } } } },
  { name: 'dashboard_get', inputSchema: { type: 'object', properties: { uid: { type: 'string' } } } },
  { name: 'dashboard_update', inputSchema: { type: 'object', properties: { uid: { type: 'string' }, operations: { type: 'array' } } } },
];

test('init drafts a manifest with every guess marked, which refuses to load until the markers go', () => {
  assert.deepEqual(split('get_ticket'), { verb: 'get', noun: 'ticket' });
  assert.deepEqual(split('ticketUpdate'), { verb: 'update', noun: 'ticket' });
  const text = draftManifest(TOOLS, { stdio: ['node', 's.js'] });
  assert.match(text, /# guessed/);
  assert.match(text, /mode: field_patch/);
  assert.match(text, /mode: command/);
  assert.match(text, /arg: expected_version/);
  assert.match(text, /tool: whoami/);
  assert.throws(() => parseManifestText(text, 'm.yaml'), /guessed/);
  const confirmed = text.replace(/ # guessed/g, '');
  const m = parseManifestText(confirmed, 'm.yaml');
  assert.equal(m.resources.length, 2);
  assert.equal(m.resources[0]!.cleanup, 'delete');
});

test('the plan hash is stable for the same inputs and changes with the catalog or the manifest', () => {
  const text = draftManifest(TOOLS, { stdio: ['node', 's.js'] }).replace(/ # guessed/g, '');
  const m = parseManifestText(text, 'm.yaml');
  const h1 = planHash(buildPlan(m, TOOLS));
  assert.equal(planHash(buildPlan(parseManifestText(text, 'm.yaml'), TOOLS)), h1);
  assert.notEqual(planHash(buildPlan(m, [...TOOLS, { name: 'extra', inputSchema: {} }])), h1);
  assert.notEqual(planHash(buildPlan(parseManifestText(text.replace('mws: "0.9"', 'mws: "0.9"\nlimits: { pairs: 31 }'), 'm.yaml'), TOOLS)), h1);
});

test('the CLI has no --yes, and `plan --catalog` makes no connection at all', async () => {
  await assert.rejects(main(['run', '-m', 'x.yaml', '--yes']), /there is no --yes/);
  const dir = mkdtempSync(join(tmpdir(), 'mwsc-plan-'));
  try {
    writeFileSync(join(dir, 'm.yaml'), draftManifest(TOOLS, { stdio: ['/nonexistent/server'] }).replace(/ # guessed/g, ''));
    writeFileSync(join(dir, 'tools.json'), JSON.stringify({ tools: TOOLS }));
    const out: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string) => (out.push(s), true)) as typeof process.stdout.write;
    try {
      assert.equal(await main(['plan', '-m', join(dir, 'm.yaml'), '--catalog', join(dir, 'tools.json')]), 0);
    } finally {
      process.stdout.write = orig;
    }
    assert.match(out.join(''), /No tool call was made/);
    assert.match(out.join(''), /plan hash: [0-9a-f]{16}/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gate: the in-process hook holds a backend request until it is released, and faults the k-th match', async () => {
  let hits = 0;
  const srv = createServer((_q, r) => (hits++, r.end('ok')));
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/x`;
  const dir = mkdtempSync(join(tmpdir(), 'mwsc-gate-'));
  const faults = new FaultStore();
  faults.set([
    { id: 'h', fault: 'hold', http_method: 'PUT', release_file: join(dir, 'go'), delay_ms: 5000 },
    { id: 's', fault: 'status', http_method: 'POST', nth: 2, status: 503 },
  ]);
  const restore = installOutbound({ faults });
  try {
    let done = false;
    const p = fetch(url, { method: 'PUT', body: 'a' }).then((r) => ((done = true), r.text()));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(done, false, 'held');
    assert.equal(hits, 0);
    writeFileSync(join(dir, 'go'), '');
    assert.equal(await p, 'ok');
    assert.equal((await fetch(url, { method: 'POST' })).status, 200);
    assert.equal((await fetch(url, { method: 'POST' })).status, 503);
  } finally {
    restore();
    srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
  await assert.rejects(new GateNotBuilt().start(), /not built/);
  assert.equal(lastMutating([{ seq: 1, method: 'GET', path: '/a', t_ms: 0, mutating: false }, { seq: 2, method: 'PUT', path: '/a', t_ms: 1, mutating: true }, { seq: 3, method: 'GET', path: '/a', t_ms: 2, mutating: false }])!.seq, 2);
});

test('the README coverage table matches the registry (spec section 1: the tool lists what it covers)', () => {
  const readme = readFileSync(join(pkg, 'README.md'), 'utf8');
  for (const r of REQUIREMENTS) {
    const c = COVERAGE[r.id];
    assert.ok(c, `${r.id} has a coverage entry`);
    assert.ok(readme.includes(`| ${r.id} | ${r.level} | ${c!.check} | ${c!.not_built} |`), `${r.id} row in the README`);
  }
  assert.match(previewSentence(), /^mcp-writecheck is a preview: of the 37 requirements/);
});

test('package names: the npm scope is @mcp-write-safety; the command stays mcp-writecheck', () => {
  const pj = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')) as { name: string; version: string; bin: Record<string, string>; private?: boolean; publishConfig?: { access?: string } };
  assert.equal(pj.name, '@mcp-write-safety/writecheck');
  assert.deepEqual(Object.keys(pj.bin), ['mcp-writecheck']);
  assert.equal(pj.private, undefined);
  assert.equal(pj.publishConfig?.access, 'public');
  const readme = readFileSync(join(pkg, 'README.md'), 'utf8');
  assert.ok(!readme.includes('<scope>'));
  assert.ok(readme.includes(`@mcp-write-safety/writecheck@${pj.version} -p @mcp-write-safety/tiny-tracker@`) && !/not published/i.test(readme));
});
