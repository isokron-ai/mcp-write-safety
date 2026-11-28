// R-DM-16 to R-DM-23: the defect matrix runs mcp-writecheck itself (writecheck_detected). Runs in ci.yml's spec job
// (node --test scripts/ci/*.test.mjs). The mutation checks at the end change the thing being protected and show the
// test fails (a defect's expected answer dropped, a writecheck regression that stops reporting a defect).
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { cellRecord } from './matrix-cell.mjs';
import { allCells, documentedGaps, judgeCell, judgeWritecheck, plan } from './matrix-plan.mjs';
import { build } from './t0-bundle.mjs';
import { buildMap, MAP_FILE, mcpDefects } from './writecheck-expected.mjs';
import { CONTROL_LAYOUT_DEFECTS, controlManifest, layoutFor, observedOf, runWritecheck } from './writecheck-run.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (f) => JSON.parse(readFileSync(join(root, f), 'utf8'));
const BUILDS = read('examples/tiny-tracker/expected/builds-0.4.0.json');
const COMMITTED = read('examples/tiny-tracker/expected/0.4.0.json');
const MAP = read(MAP_FILE);
const yaml = readFileSync(join(root, '.github', 'workflows', 'defect-matrix.yml'), 'utf8');

const rows = Object.fromEntries(COMMITTED.builds.map((r) => [r.label, r]));
const gotFor = (labels) => Object.fromEntries(labels.map((l) => [l, { build_hash: rows[l].build_hash, fixture: rows[l].fixture }]));
const fixtureVerdict = (defect) => {
  const cell = { kind: 'defect', defect };
  const labels = (plan(BUILDS).defects.get(defect).single.length ? plan(BUILDS).defects.get(defect).single : plan(BUILDS).defects.get(defect).all).map((b) => b.label);
  return { cell, v: judgeCell({ cell, buildsDoc: BUILDS, expectedDoc: COMMITTED, got: gotFor(labels) }) };
};
const byStatus = (status) => [...plan(BUILDS).defects.keys()].filter((d) => fixtureVerdict(d).v.status === status);
// A single-defect MCP defect the fixture answers cannot tell from the correct build (documented in the known-answer file's
// not_detected note) and mcp-writecheck is expected to catch: the case the matrix could not judge before.
const expectingDocumented = () => byStatus('documented').filter((d) => MAP.defects[d].expected.length);
const caught = (defect) => ({ ok: true, observed: [...MAP.defects[defect].expected], version: 't', records: 1 });
const judgeWith = (defect, run) => {
  const { cell } = fixtureVerdict(defect);
  const labels = (plan(BUILDS).defects.get(defect).single.length ? plan(BUILDS).defects.get(defect).single : plan(BUILDS).defects.get(defect).all).map((b) => b.label);
  return judgeCell({ cell, buildsDoc: BUILDS, expectedDoc: COMMITTED, got: gotFor(labels), writecheck: { run, expected: MAP.defects[defect] } });
};
const GOOD = { kind: 'known-good', label: 'L2 correct build' };
const judgeGood = (run) => judgeCell({ cell: GOOD, buildsDoc: BUILDS, expectedDoc: COMMITTED, got: gotFor([GOOD.label]), writecheck: { run, expected: null } });
const control = (b, kind) => b.meta.controls.find((c) => c.kind === kind);

test('R-DM-16: the expected-violations map is derived from the defects\' own sources, covers every defect of the 0.4.0 list, and only the documented ones differ from "its requirement is violated"', () => {
  assert.deepEqual(MAP, buildMap(), 'the committed map is what the sources give (node scripts/ci/writecheck-expected.mjs --write)');
  const listed = new Set(allCells(BUILDS).filter((c) => c.kind === 'defect').map((c) => c.defect));
  assert.deepEqual(new Set(Object.keys(MAP.defects)), listed, 'one entry per defect of the matrix, none more');
  for (const [name, requirement] of Object.entries(mcpDefects())) {
    const e = MAP.defects[name];
    if (e.reason) continue; // an override carries its reason
    assert.deepEqual(e.expected, [`${requirement}:violated`], name);
  }
  for (const [name, e] of Object.entries(MAP.defects)) if (e.reason) assert.ok(e.reason.length > 20, `${name}: an exception states where it comes from`);
  const overridden = Object.entries(MAP.defects).filter(([, e]) => e.layer === 'mcp' && e.reason).map(([n]) => n).sort();
  assert.deepEqual(overridden, ['conflict-as-generic-error', 'lookup-reexecutes', 'stale-unannounced']);
  // The four exceptions, spelled out here and not derived: a wrong OVERRIDES value cannot re-derive itself into the map.
  const literal = { 'lookup-reexecutes': [], 'stale-unannounced': ['MWS-CONC-5:self-attested-no'], 'conflict-as-generic-error': ['MWS-CONC-6:self-attested-no'], 'lost-update': ['MWS-CONC-3:platform'] };
  for (const [name, want] of Object.entries(literal)) assert.deepEqual(MAP.defects[name].expected, want, name);
});

test('R-DM-17: a defect mcp-writecheck should catch but does not is a control miss: writecheck_detected false, the cell fails, known_bad is "missed"', () => {
  const d = expectingDocumented()[0];
  const w = judgeWritecheck({ run: { ok: true, observed: [] }, expected: MAP.defects[d] });
  assert.equal(w.state, 'missed');
  assert.deepEqual(w.missing, MAP.defects[d].expected);
  const v = judgeWith(d, { ok: true, observed: [] });
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'writecheck_missed');
  assert.equal(v.writecheck_detected, false);
  assert.equal(v.status, 'documented', 'the fixture status is kept as it was');
  const rec = cellRecord({ KIND: 'defect', DEFECT: d }, v);
  const b = build({ expected: [{ kind: 'defect', defect: d }], found: [rec] });
  assert.equal(control(b, 'known_bad').observed, 'missed', 'tool-qa ingest rejects this as control_failed');
  assert.deepEqual(b.matrix.writecheck_missed, [d]);
  // and when it reports it, the cell holds and the defect is listed as writecheck_detected
  const good = judgeWith(d, caught(d));
  assert.equal(good.ok, true);
  assert.equal(good.writecheck_detected, true);
  assert.equal(good.status, 'documented');
});

test('R-DM-18: a correct build must show no violation: any violated or review-no answer fails known_good ("differs"), a clean one holds', () => {
  const clean = judgeGood({ ok: true, observed: [] });
  assert.equal(clean.ok, true);
  assert.equal(clean.writecheck_clean, true);
  for (const o of ['MWS-UPD-1:violated', 'MWS-CONC-5:self-attested-no']) {
    const bad = judgeGood({ ok: true, observed: [o] });
    assert.equal(bad.ok, false, o);
    assert.equal(bad.reason, 'writecheck_violated');
    assert.equal(bad.writecheck_clean, false);
    const b = build({ expected: [GOOD], found: [cellRecord({ KIND: 'known-good', LABEL: GOOD.label }, bad)] });
    assert.equal(control(b, 'known_good').observed, 'differs');
  }
  assert.equal(judgeGood({ ok: false, error: 'x' }).reason, 'writecheck_error', 'a run that failed is never read as clean');
});

test('R-DM-19: committed_contract, combo_only and documented stay as they are; writecheck_detected is reported beside them, and a combo_only or committed_contract defect it caught is judged', () => {
  const documented = byStatus('documented')[0];
  const combo = byStatus('combo_only')[0];
  assert.ok(documented && combo);
  for (const d of [documented, combo]) {
    const v = judgeWith(d, caught(d));
    assert.equal(v.ok, true, d);
    assert.equal(v.status, fixtureVerdict(d).v.status, `${d}: status unchanged`);
    assert.equal(v.writecheck_detected, true);
  }
  // reported on their own and never satisfying known_bad, unless writecheck ran on them
  const cell = (c, status, wd) => ({ ...c, outcome: 'success', status, ...(wd === undefined ? {} : { writecheck_detected: wd }) });
  const found = [cell({ kind: 'defect', defect: 'c' }, 'combo_only'), cell({ kind: 'defect', defect: 'd' }, 'committed_contract')];
  const none = build({ expected: found.map(({ outcome, status, ...c }) => c), found });
  assert.equal(control(none, 'known_bad').observed, 'none_judged', 'as before: no writecheck answer, not judged');
  const wc = [cell({ kind: 'defect', defect: 'c' }, 'combo_only', true), cell({ kind: 'defect', defect: 'd' }, 'committed_contract', true)];
  const b = build({ expected: wc.map(({ outcome, status, writecheck_detected, ...c }) => c), found: wc });
  assert.equal(control(b, 'known_bad').observed, 'detected_or_documented');
  assert.deepEqual(b.matrix.combo_only, ['c']);
  assert.deepEqual(b.matrix.committed_contract, ['d']);
  assert.deepEqual(b.matrix.writecheck_detected, ['c', 'd']);
  // a miss on a combo_only defect, or an error of the run, shows as missed (it does not hide behind the unjudged status)
  for (const extra of [{ writecheck_detected: false, outcome: 'failure', reason: 'writecheck_missed' }, { outcome: 'failure', reason: 'writecheck_error' }]) {
    const f = [{ ...wc[0], ...extra }];
    assert.equal(control(build({ expected: [{ kind: 'defect', defect: 'c' }], found: f }), 'known_bad').observed, 'missed');
  }
});

test('R-DM-20: a defect the fixture cannot see and nothing documents (neutered) is writecheck_detected when mcp-writecheck caught it; otherwise it stays neutered', () => {
  const { defects, correct } = plan(BUILDS);
  const d = [...defects].find(([n, o]) => o.single.length && !documentedGaps(COMMITTED).has(n) && MAP.defects[n].expected.length)?.[0];
  assert.ok(d, 'R-DM-20 needs a defect with a single-defect build, an expected writecheck answer and no not_detected note; none exists any more (every such defect is now documented), so the neutered case has no candidate: choose one another way');
  const o = defects.get(d);
  const goodOf = (b) => rows[correct.find((x) => x.factors.level === b.factors.level).label];
  const saved = o.single.map((b) => [b.label, rows[b.label].fixture, rows[b.label].contract]);
  const got = Object.fromEntries(o.single.map((b) => [b.label, { build_hash: rows[b.label].build_hash, fixture: goodOf(b).fixture }]));
  try {
    for (const b of o.single) { rows[b.label].fixture = goodOf(b).fixture; rows[b.label].contract = goodOf(b).contract; }
    const cell = { kind: 'defect', defect: d };
    const by = (run) => judgeCell({ cell, buildsDoc: BUILDS, expectedDoc: COMMITTED, got, writecheck: { run, expected: MAP.defects[d] } });
    assert.equal(judgeCell({ cell, buildsDoc: BUILDS, expectedDoc: COMMITTED, got }).reason, 'neutered');
    const yes = by(caught(d));
    assert.equal(yes.ok, true);
    assert.equal(yes.status, 'writecheck_detected');
    const no = by({ ok: true, observed: [] });
    assert.equal(no.ok, false);
    assert.equal(no.reason, 'writecheck_missed');
  } finally {
    for (const [l, f, c] of saved) { rows[l].fixture = f; rows[l].contract = c; }
  }
});

test('R-DM-21: a defect mcp-writecheck is not expected to see (a backend fixture defect, lookup-reexecutes) records what it saw and neither fails nor claims detection; an extra violation is reported, not failed', () => {
  const none = Object.entries(MAP.defects).filter(([, e]) => e.expected.length === 0).map(([n]) => n);
  assert.ok(none.includes('lookup-reexecutes') && none.includes('digest-of-current-state'));
  const v = judgeWith('lookup-reexecutes', { ok: true, observed: [] });
  assert.equal(v.writecheck_detected, null);
  assert.equal(v.writecheck.state, 'not_expected');
  assert.equal(v.ok, true);
  assert.equal(judgeWith('digest-of-current-state', { skipped: 'backend_fixture_defect' }).writecheck.state, 'not_run');
  const d = expectingDocumented()[0];
  const extra = judgeWith(d, { ok: true, observed: [...MAP.defects[d].expected, 'MWS-IN-9:violated'] });
  assert.equal(extra.ok, true);
  assert.equal(extra.writecheck_detected, true);
  assert.equal(judgeWith('lost-update', { ok: true, observed: ['MWS-CONC-3:violated'] }).writecheck_detected, false, 'violated is not the platform verdict');
  assert.equal(judgeWith('lost-update', { ok: true, observed: ['MWS-CONC-3:platform'] }).writecheck_detected, true);
});

test('R-DM-22: the sealed bundle stays compatible: the cell record adds only sanitized writecheck members, a record without them reads as before, and the controls keep their kinds and words', () => {
  const rec = cellRecord({ KIND: 'defect', DEFECT: 'x-y' }, { ok: true, status: 'documented', writecheck_detected: true, writecheck: { state: 'detected', expected: ['MWS-A-1:violated', 'rm -rf /'], observed: ['MWS-A-1:violated'], missing: [] }, secret: 's' });
  assert.deepEqual(rec, { kind: 'defect', outcome: 'success', defect: 'x-y', status: 'documented', writecheck_detected: true, writecheck: { state: 'detected', expected: ['MWS-A-1:violated'], observed: ['MWS-A-1:violated'], missing: [] } });
  assert.deepEqual(cellRecord({ KIND: 'defect', DEFECT: 'x-y' }, { ok: true, status: 'detected', writecheck: { state: 'bogus' } }), { kind: 'defect', outcome: 'success', defect: 'x-y', status: 'detected' });
  const expected = [{ kind: 'known-good', label: 'L2 correct build' }, { kind: 'defect', defect: 'a' }, { kind: 'defect', defect: 'b' }];
  const found = [{ ...expected[0], outcome: 'success', writecheck_clean: true }, { ...expected[1], outcome: 'success', status: 'documented', writecheck_detected: true }, { ...expected[2], outcome: 'success', status: 'detected' }];
  const b = build({ expected, found });
  assert.deepEqual(b.meta.controls, [{ kind: 'known_good', expected: 'match', observed: 'match' }, { kind: 'known_bad', expected: 'detected_or_documented', observed: 'detected_or_documented' }]);
  assert.deepEqual(b.matrix.writecheck_detected, ['a']);
  assert.deepEqual(b.matrix.writecheck_clean, ['L2 correct build']);
  assert.deepEqual(b.matrix.documented_gaps, ['a']);
  assert.deepEqual(b.matrix.detected, ['b']);
  // without a writecheck argument judgeCell is exactly what it was
  const { cell } = fixtureVerdict(expectingDocumented()[0]);
  assert.equal('writecheck' in judgeCell({ cell, buildsDoc: BUILDS, expectedDoc: COMMITTED, got: gotFor(plan(BUILDS).defects.get(cell.defect).single.map((x) => x.label)) }), false);
});

test('R-DM-23: observedOf reads violated, platform and review answers "no" from a results.json, and nothing else', () => {
  const doc = { results: [
    { requirement: 'MWS-UPD-1', verdict: 'violated' }, { requirement: 'MWS-UPD-1', verdict: 'held' }, { requirement: 'MWS-CONC-3', verdict: 'platform' },
    { requirement: 'MWS-CONC-5', verdict: 'self-attested', numbers: { answer: false } }, { requirement: 'MWS-CONC-6', verdict: 'self-attested', numbers: { answer: true } },
    { requirement: 'MWS-IN-5', verdict: 'not tested' }, { requirement: 'MWS-UPD-1', verdict: 'violated' },
  ] };
  assert.deepEqual(observedOf(doc), ['MWS-CONC-3:platform', 'MWS-CONC-5:self-attested-no', 'MWS-UPD-1:violated']);
  assert.deepEqual(observedOf({}), []);
});

test('R-DM-24: the driver starts the backend with the backend defect, gives the server the defect, confirms the plan hash and reads results.json (stub CLI)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dm-wc-test-'));
  try {
    const tt = join(dir, 'tt');
    mkdirSync(join(tt, 'dist', 'src'), { recursive: true });
    writeFileSync(join(tt, 'writecheck.yaml'), 'server:\n  cwd: .\n');
    // the stub backend prints its state line and records its arguments next to it; it stays up until killed
    writeFileSync(join(tt, 'dist', 'src', 'cli.js'), `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(join(dir, 'backend-args.json'))}, JSON.stringify(process.argv.slice(2)));\nconsole.log(JSON.stringify({ backend: 'http://127.0.0.1:9' }));\nsetInterval(() => {}, 1000);\n`);
    const cli = join(dir, 'main.mjs');
    writeFileSync(cli, `import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const a = process.argv.slice(2);
const at = (f) => a[a.indexOf(f) + 1];
if (a[0] === 'plan') { console.log('plan hash: h123'); process.exit(0); }
if (a[2] !== undefined && at('--plan-hash') !== 'h123') process.exit(3);
if (at('--confirm-target') !== 'tiny-tracker') process.exit(3);
if (!/cwd: "/.test(readFileSync(at('-m'), 'utf8'))) process.exit(3);
const out = at('--out') + '/run-1'; mkdirSync(out, { recursive: true });
const seen = process.env.TRACKER_DEFECTS ?? '';
writeFileSync(out + '/results.json', JSON.stringify({ suite: { version: 'stub' }, results: seen ? [{ requirement: 'MWS-SEC-1', verdict: 'violated' }] : [{ requirement: 'MWS-SEC-1', verdict: 'held' }] }));
process.exit(seen ? 1 : 0);
`);
    const hit = await runWritecheck({ cli, tinyTracker: tt, defects: ['token-in-error'], backendDefects: ['lost-update'], timeoutMs: 20000 });
    assert.deepEqual(hit, { ok: true, observed: ['MWS-SEC-1:violated'], version: 'stub', records: 1 });
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'backend-args.json'), 'utf8')), ['backend', '--port', '0', '--backend-defect', 'lost-update']);
    const clean = await runWritecheck({ cli, tinyTracker: tt, timeoutMs: 20000 });
    assert.deepEqual(clean.observed, []);
    const broken = await runWritecheck({ cli: join(dir, 'missing.mjs'), tinyTracker: tt, timeoutMs: 20000 });
    assert.equal(broken.ok, false, 'a CLI that cannot run is an error, never "clean"');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R-DM-25: mutation checks: dropping an expected answer, or a writecheck that stops reporting a defect, is caught by these tests\' own checks', () => {
  // (a) the map: with one defect's expected requirement dropped, it no longer equals what the sources give
  const mutated = structuredClone(MAP);
  const d = expectingDocumented()[0];
  mutated.defects[d].expected = [];
  assert.notDeepEqual(mutated, buildMap(), 'a map edited by hand is not the derived one');
  // (b) a regression in mcp-writecheck: for EVERY defect it is expected to catch, an empty answer is a miss; none is let through
  const expecting = Object.entries(MAP.defects).filter(([, e]) => e.expected.length).map(([n]) => n);
  assert.ok(expecting.length >= 45, `${expecting.length} defects mcp-writecheck is expected to catch`);
  for (const n of expecting) assert.equal(judgeWith(n, { ok: true, observed: [] }).ok, false, `${n}: a writecheck that stops catching it must fail the cell`);
  // (c) a correct build with one violation injected fails, for every level's correct build
  for (const c of plan(BUILDS).correct) {
    const cell = { kind: 'known-good', label: c.label };
    const v = judgeCell({ cell, buildsDoc: BUILDS, expectedDoc: COMMITTED, got: gotFor([c.label]), writecheck: { run: { ok: true, observed: ['MWS-UPD-1:violated'] }, expected: null } });
    assert.equal(v.ok, false, c.label);
  }
  // (d) the workflow builds the CLI it then runs, and gives the cell its path
  assert.match(yaml, /working-directory: packages\/writecheck[\s\S]{0,200}npm run build/);
  assert.match(yaml, /WRITECHECK_CLI: \$\{\{ github\.workspace \}\}\/packages\/writecheck\/dist\/src\/cli\/main\.js/);
  assert.equal(JSON.parse(readFileSync(join(root, 'packages/writecheck/package.json'), 'utf8')).bin['mcp-writecheck'], 'dist/src/cli/main.js');
});

// ---- the control layout (R-DM-26..28): the cells whose defect needs a write held inside the backend ----

const SHIPPED = readFileSync(join(root, 'examples', 'tiny-tracker', 'writecheck.yaml'), 'utf8');

test('R-DM-26: only in-progress-reported-not-applied runs in the control layout; every other cell, correct builds included, is unchanged (separate)', () => {
  assert.deepEqual([...CONTROL_LAYOUT_DEFECTS], ['in-progress-reported-not-applied']);
  const cells = allCells(BUILDS);
  const control = cells.filter((c) => layoutFor(c) === 'control').map((c) => c.defect);
  assert.deepEqual(control, ['in-progress-reported-not-applied']);
  assert.ok(cells.filter((c) => c.kind === 'known-good').every((c) => layoutFor(c) === 'separate'), 'L2, L3, L3d and Lv stay separate');
  assert.equal(layoutFor({ kind: 'defect', defect: 'settle-miss-reported-not-applied' }), 'separate', 'settle-miss needs the gate, which only the separate layout has');
  assert.deepEqual(MAP.defects['in-progress-reported-not-applied'].expected, ['MWS-RES-2:violated'], 'what the control layout must show');
});

test('R-DM-27: the control manifest is one all --fixture-control process with faults on loopback ports, the control and evidence tokens passed through, no gate, restart or launch settings; a drifted manifest is refused', () => {
  const m = controlManifest(SHIPPED, { cwd: '/tt', backendPort: 41001, controlPort: 41002 });
  assert.match(m, /command: \[node, dist\/src\/cli\.js, all, --port, "0", --backend-port, "41001", --fixture-control, --control-port, "41002", --features, "evidence,strict-input,ledger,faults"\]/);
  assert.match(m, /env_passthrough: \[TRACKER_BACKEND_TOKEN, TRACKER_CONTROL_TOKEN, TRACKER_EVIDENCE_TOKEN\]/);
  assert.match(m, /env_public: \[TRACKER_DEFECTS\]/, 'the server is not given TRACKER_BACKEND_URL (in all it runs its own backend)');
  assert.doesNotMatch(m, /rewrite_env|^ {2}restart:|^settings:/m);
  assert.match(m, /^ {2}cwd: "\/tt"$/m);
  assert.match(m, /inflight_hold: \{ fixture: fixture-api\/1, control_env: TRACKER_CONTROL_URL, token_env: TRACKER_CONTROL_TOKEN/);
  // mutation: a shipped manifest whose server line changed is refused, not run in a half-edited layout
  assert.throws(() => controlManifest(SHIPPED.replace('server, --port, "0"', 'server, --port, "4100"'), { cwd: '/tt', backendPort: 1, controlPort: 2 }), /cannot edit the shipped manifest/);
  assert.throws(() => controlManifest(SHIPPED.replace(/^ {2}inflight_hold: .*$/m, ''), { cwd: '/tt', backendPort: 1, controlPort: 2 }), /no backend\.inflight_hold/);
});

test('R-DM-28: the control layout starts no separate backend, gives the tester loopback backend and control URLs and fresh tokens, and masks every token in the Actions log (stub CLI)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dm-wc-ctl-'));
  const printed = [];
  const write = process.stdout.write.bind(process.stdout);
  const was = process.env.GITHUB_ACTIONS;
  try {
    const tt = join(dir, 'tt');
    mkdirSync(join(tt, 'dist', 'src'), { recursive: true });
    writeFileSync(join(tt, 'writecheck.yaml'), SHIPPED);
    writeFileSync(join(tt, 'dist', 'src', 'cli.js'), `require('node:fs').writeFileSync(${JSON.stringify(join(dir, 'backend-started'))}, 'yes');\n`);
    const cli = join(dir, 'main.mjs');
    writeFileSync(cli, `import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const a = process.argv.slice(2);
const at = (f) => a[a.indexOf(f) + 1];
if (a[0] === 'plan') { console.log('plan hash: h1'); process.exit(0); }
const e = process.env;
writeFileSync(${JSON.stringify(join(dir, 'seen.json'))}, JSON.stringify({ manifest: readFileSync(at('-m'), 'utf8'), backend: e.TRACKER_BACKEND_URL, control: e.TRACKER_CONTROL_URL, tokens: [e.TRACKER_BACKEND_TOKEN, e.TRACKER_CONTROL_TOKEN, e.TRACKER_EVIDENCE_TOKEN], defects: e.TRACKER_DEFECTS }));
const out = at('--out') + '/run-1'; mkdirSync(out, { recursive: true });
writeFileSync(out + '/results.json', JSON.stringify({ suite: { version: 'stub' }, results: [{ requirement: 'MWS-RES-2', verdict: 'violated' }] }));
process.exit(1);
`);
    process.env.GITHUB_ACTIONS = 'true';
    process.stdout.write = (c, ...r) => { printed.push(String(c)); return true; };
    let got;
    try {
      got = await runWritecheck({ cli, tinyTracker: tt, defects: ['in-progress-reported-not-applied'], layout: 'control', timeoutMs: 20000 });
    } finally {
      process.stdout.write = write;
    }
    assert.deepEqual(got, { ok: true, observed: ['MWS-RES-2:violated'], version: 'stub', records: 1 });
    const seen = JSON.parse(readFileSync(join(dir, 'seen.json'), 'utf8'));
    assert.match(seen.backend, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.match(seen.control, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.notEqual(seen.backend, seen.control);
    assert.equal(new Set(seen.tokens).size, 3, 'three distinct tokens');
    for (const t of seen.tokens) assert.ok(printed.includes(`::add-mask::${t}\n`), 'each token is masked');
    assert.ok(!printed.some((l) => !l.startsWith('::add-mask::') && seen.tokens.some((t) => l.includes(t))), 'no token printed otherwise');
    assert.match(seen.manifest, /--fixture-control/);
    assert.equal(seen.defects, 'in-progress-reported-not-applied');
    assert.throws(() => readFileSync(join(dir, 'backend-started')), 'no separate backend was started');
  } finally {
    if (was === undefined) delete process.env.GITHUB_ACTIONS; else process.env.GITHUB_ACTIONS = was;
    rmSync(dir, { recursive: true, force: true });
  }
});
