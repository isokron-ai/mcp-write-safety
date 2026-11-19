/**
 * The suite's self-test against tiny-tracker, the MWS sample server, with the shipped manifest
 * (examples/tiny-tracker/writecheck.yaml): the four-part rule of the spec's change process in
 * executable form.
 *
 *   - the correct build gives no `violated` (over protocol 2026-07-28 and 2025-11-25)
 *   - each defect, alone, gives `violated` for its own requirement and for nothing else, except the
 *     documented secondary effects below, where the spec's own test method reaches a second
 *     requirement the defect really breaks
 *   - all defects together leave no requirement unviolated, except the two whose defects the spec's
 *     method cannot reach as `violated` (documented below)
 *   - the backend's own lost update is `platform`, not `violated`
 *
 * Runs when tiny-tracker is built (examples/tiny-tracker/dist, or TINY_TRACKER_DIR); skipped
 * otherwise, with the reason. No network beyond loopback; every process is stopped.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { REQUIREMENTS } from '../../src/requirements.js';
import { writePathKey, type Result } from '../../src/report/verdicts.js';
import { runTT, startTinyTracker, tinyTrackerDir } from '../tiny-tracker/harness.js';

const dir = tinyTrackerDir();
const skip = dir ? false : 'tiny-tracker is not built here (examples/tiny-tracker/dist or TINY_TRACKER_DIR)';
const violatedIds = (rs: Result[]) => [...new Set(rs.filter((r) => r.verdict === 'violated').map((r) => r.requirement))].sort();
const violatedKeys = (rs: Result[]) => rs.filter((r) => r.verdict === 'violated').map((r) => `${r.requirement} ${writePathKey(r.write_path)}`);
const saidNo = (rs: Result[]) => rs.filter((r) => r.verdict === 'self-attested' && r.numbers['answer'] === false).map((r) => `${r.requirement} ${writePathKey(r.write_path)}`);

/**
 * Each defect's expected `violated` requirements. The first is the defect's own; any other is a
 * secondary effect the spec's test method finds because the defect really breaks it too:
 *   force-by-default          replace_ticket overwrites without the version check: the stale write
 *                             wins (CONC-2: "the tool accepted a version and did not use it") and a
 *                             concurrent write is lost (CONC-3; GF-01 is cited under both)
 *   delete-refetches-version  the delete defeats the check the platform's API applies (CONC-1)
 *   create-overwrites         create_project is annotated destructiveHint: false and replaces an
 *                             existing project the call did not identify (ANN-2), which is also not
 *                             additive (ANN-5)
 *   add-label-replaces-list   add_label removes labels its arguments did not name (ANN-2), so it is
 *                             not additive either (ANN-5)
 *   drop-unknown-args         an argument dropped silently (IN-2) was also not rejected (IN-7)
 *   shape-missing-failed      bulk_update_tickets writes one by one, so a failed call leaves the
 *                             earlier writes in place (ATOM-2); the shape's lie is ATOM-1. When the
 *                             answer to its last write is lost, that ticket is applied and the
 *                             result neither identifies it nor says its outcome is unknown (RES-2)
 *   shape-text-says-all-saved bulk_update_tickets writes one by one, so a failed call leaves the
 *                             earlier writes in place (ATOM-2); its sentence says all tickets were
 *                             saved beside a correct shape, read by patterns.applied_all (ATOM-1).
 *                             When the answer to its last write is lost, its shape gives that
 *                             applied ticket as not applied (RES-2)
 *   conflict-as-generic-error set_labels words every refusal "Request failed ... Nothing was
 *                             written."; after a lost backend answer (the write applied) that is a
 *                             failure stated for a write in effect (RES-2, kind stated-failure). Its
 *                             own finding (CONC-6) is review-only, below
 *   coerce-types              a conversion that changes the meaning (IN-1) is also a value of
 *                             another type that was accepted (IN-6; spec: "a record here and under
 *                             MWS-IN-1")
 * Two defects are found by review-only clauses, so the record is self-attested with the answer "no"
 * (asserted below), never `violated` (spec 8.2, rule 11):
 *   stale-unannounced         MWS-CONC-5: delete_project's description no longer says that a stale
 *                             delete is not detected
 *   conflict-as-generic-error MWS-CONC-6: the conflict neither carries the current state nor tells
 *                             the caller to read again
 */
const EXPECT: Record<string, string[]> = {
  'update-adds-defaults': ['MWS-UPD-1'],
  'label-by-position': ['MWS-UPD-2'],
  'force-by-default': ['MWS-CONC-1', 'MWS-CONC-2', 'MWS-CONC-3'],
  'delete-refetches-version': ['MWS-CONC-1', 'MWS-CONC-2'],
  'read-merge-put': ['MWS-CONC-3'],
  'conflict-without-iserror': ['MWS-CONC-4'],
  'stale-unannounced': [],
  'conflict-as-generic-error': ['MWS-RES-2'],
  'ignore-project-scope': ['MWS-TGT-1'],
  'empty-filter-deletes-all': ['MWS-TGT-2'],
  'create-overwrites': ['MWS-ANN-2', 'MWS-ANN-5', 'MWS-TGT-3'],
  'skip-null-assignee': ['MWS-RES-1'],
  'shape-claims-applied': ['MWS-RES-1'],
  'shape-unknown-as-failed': ['MWS-RES-2'],
  'shape-text-says-failed': ['MWS-RES-2'],
  'shape-text-invites-retry': ['MWS-RES-2'],
  'shape-wrong-version': ['MWS-RES-4'],
  'shape-missing-failed': ['MWS-ATOM-1', 'MWS-ATOM-2', 'MWS-RES-2'],
  'shape-text-says-all-saved': ['MWS-ATOM-1', 'MWS-ATOM-2', 'MWS-RES-2'],
  'error-as-text': ['MWS-RES-2'],
  'comment-id-dropped': ['MWS-RES-3'],
  'receipt-missing-version': ['MWS-RES-4'],
  'bulk-misreports-partial': ['MWS-ATOM-1'],
  'bulk-without-transaction': ['MWS-ATOM-2'],
  'no-idempotency-key': ['MWS-RETRY-1'],
  'idempotency-key-dropped': ['MWS-RETRY-2'],
  'idempotency-key-ignores-args': ['MWS-RETRY-2'],
  'retry-without-key': ['MWS-RETRY-2'],
  'key-store-in-memory': ['MWS-RETRY-2'],
  'close-before-confirm': ['MWS-RETRY-3'],
  'coerce-types': ['MWS-IN-1', 'MWS-IN-6'],
  'drop-unknown-args': ['MWS-IN-2', 'MWS-IN-7'],
  'skip-limits': ['MWS-IN-3'],
  'vague-validation-error': ['MWS-IN-4'],
  'undeclared-title-limit': ['MWS-IN-5'],
  'convert-numeric-strings': ['MWS-IN-6'],
  'ignore-unknown-args-with-notice': ['MWS-IN-7'],
  'read-only-strict-true': ['MWS-CFG-1'],
  'unknown-denied-tools-ignored': ['MWS-CFG-2'],
  'read-only-by-annotation': ['MWS-CFG-3'],
  'unknown-tools-ignored': ['MWS-CFG-4'],
  'comment-marked-read-only': ['MWS-ANN-1'],
  // tiny-tracker 0.2.0 (default profile, feature lookup): get_operation is annotated readOnlyHint: true and, on a key
  // with no record, creates a ticket (its requirement is MWS-ANN-1, which tiny-tracker's own self-test shows). The
  // manifest calls get_operation on a scratch ticket with a key no write used (calls.get_operation), twice: the ticket
  // it creates is a new object in the default project, not the object the check watches, and MWS-ANN-1's method
  // watches only that object (spec 8.2, rule 8). So the record is `not observed`, never `violated`, under this method.
  'lookup-reexecutes': [],
  'add-label-replaces-list': ['MWS-ANN-2', 'MWS-ANN-5'],
  'create-marked-idempotent': ['MWS-ANN-3'],
  'missing-annotations': ['MWS-ANN-4'],
  'set-labels-non-destructive': ['MWS-ANN-5'],
  'token-in-error': ['MWS-SEC-1'],
};

/** Review-only findings each defect must give as self-attested "no". */
const SAID_NO: Record<string, string[]> = {
  'stale-unannounced': ['MWS-CONC-5 project:delete_project'],
  'conflict-as-generic-error': ['MWS-CONC-6 ticket:set_labels'],
};

test('the expectations cover every tiny-tracker defect the default profile runs', { skip }, async () => {
  const { DEFECTS } = (await import(join(dir!, 'dist', 'src', 'start.js'))) as { DEFECTS: { name: string; requires?: readonly string[] }[] };
  // Coverage gap, stated (G2 fold-in 12): the two inflight-gated MCP-layer defects below have NO expectation row, so
  // writecheck's per-defect runs say nothing about them; tiny-tracker's own tests show them (test/keyed.test.ts). From
  // tiny-tracker 0.3.0 the default profile turns inflight on, so they run here, and `--defect all` below includes them.
  // Listed for 0.4.0: expectation rows for both, measured with a same-key call while the first is in flight.
  const NO_ROW_UNTIL_040 = ['in-progress-reported-not-applied', 'settle-miss-reported-not-applied'];
  const profile = (await import(join(dir!, 'dist', 'src', 'profile.js'))) as { PROFILE_FEATURES: Record<string, readonly string[]> };
  const runs = DEFECTS.filter((d) => (d.requires ?? []).every((f) => profile.PROFILE_FEATURES['default']!.includes(f)));
  assert.deepEqual(runs.filter((d) => !NO_ROW_UNTIL_040.includes(d.name)).map((d) => d.name).sort(), Object.keys(EXPECT).sort());
  // Every defect runs under the default profile, and the gap is exactly the named list: a new defect fails here until
  // it has a row or is named.
  assert.deepEqual(DEFECTS.filter((d) => !runs.includes(d)).map((d) => d.name), [], 'every MCP-layer defect runs under the default profile');
  assert.deepEqual(runs.filter((d) => !Object.keys(EXPECT).includes(d.name)).map((d) => d.name).sort(), NO_ROW_UNTIL_040.sort());
});

for (const protocol of [undefined, '2025-11-25']) {
  test(`correct build${protocol ? ` over ${protocol}` : ''}: no violation, every requirement has a record, nothing left behind`, { skip }, async () => {
    const t = await startTinyTracker(dir!, { pairs: protocol ? 10 : 40, ...(protocol ? { protocol } : {}) });
    try {
      const r = await runTT(t);
      const rs = r.doc.results;
      assert.deepEqual(violatedKeys(rs), []);
      assert.equal(r.exit, 0);
      assert.equal(r.doc.run.status, 'complete');
      assert.deepEqual(r.doc.leftovers, []);
      assert.equal(r.doc.safety.protocol, protocol ?? '2026-07-28');
      assert.deepEqual(r.doc.safety.canaries.map((c) => c.unchanged), [true]);
      assert.ok(r.doc.safety.gate?.description.includes('TRACKER_BACKEND_URL'));
      for (const req of REQUIREMENTS) {
        // why: over 2025-11-25 there is no input_required result, and 10 pairs are too few for "not observed".
        if (protocol && (req.id === 'MWS-RETRY-3')) continue;
        assert.ok(rs.some((x) => x.requirement === req.id && x.verdict !== 'not tested'), `${req.id} has a record that is not "not tested"`);
      }
      const v = (req: string, path: string, scenario?: string) => rs.find((x) => x.requirement === req && writePathKey(x.write_path) === path && (!scenario || x.scenario.id === scenario))?.verdict;
      assert.equal(v('MWS-CONC-3', 'ticket:update_ticket', 'held-request'), 'held');
      assert.equal(v('MWS-CONC-3', 'ticket:update_ticket', 'barrier-pairs'), protocol ? 'not tested' : 'not observed', 'spec 8.2 rule 6: 30 overlapped pairs');
      assert.equal(v('MWS-CONC-2', 'ticket:delete_ticket'), 'held');
      assert.equal(v('MWS-CONC-2', 'ticket:set_labels'), 'held');
      assert.equal(v('MWS-TGT-1', 'ticket:create_ticket'), 'held');
      assert.equal(v('MWS-TGT-2', 'ticket:delete_tickets'), 'held');
      assert.equal(v('MWS-TGT-3', 'project:create_project'), 'held');
      assert.equal(v('MWS-ATOM-2', 'ticket:delete_tickets'), 'held');
      assert.equal(v('MWS-CFG-3', '(server):TRACKER_READ_ONLY'), 'held');
      assert.equal(v('MWS-SEC-1', '(server):get_ticket'), 'not observed');
      assert.ok(!rs.some((x) => ['MWS-ANN-1', 'MWS-ANN-2', 'MWS-ANN-3', 'MWS-ANN-5', 'MWS-SEC-1', 'MWS-IN-5'].includes(x.requirement) && x.verdict === 'held'), 'spec 8.2 rule 8: never held');
      assert.ok(rs.filter((x) => x.verdict === 'violated' || x.verdict === 'platform').every((x) => x.attribution !== undefined), 'spec 8.2 rule 3: every record carries the attribution field');
      assert.ok(!rs.some((x) => x.scenario.id === 'barrier-pairs' && x.verdict === 'held'), 'spec 8.2 rule 5: pairs are never held');
      assert.ok(rs.filter((x) => x.verdict === 'self-attested').every((x) => x.numbers['answer'] === true));
      // MWS-RETRY-2: the keys go to the backend, which keeps them across a restart of the MCP server; no step carries a note.
      for (const path of ['ticket:create_ticket', 'project:create_project']) {
        for (const sc of ['idempotency-replay', 'idempotency-replay.proxy', 'idempotency-replay.restart', 'idempotency-replay.restart-crash']) assert.equal(v('MWS-RETRY-2', path, sc), 'held', `${path} ${sc}`);
        assert.equal(v('MWS-RETRY-2', path, 'idempotency-replay.concurrent'), protocol ? 'not tested' : 'not observed', `${path}: spec 8.2 rule 6`);
      }
      assert.ok(!rs.some((x) => x.requirement === 'MWS-RETRY-2' && /outcome not established|key record not kept/.test(x.reason)), 'held without a note');
      assert.ok(rs.find((x) => x.scenario.id === 'idempotency-replay' && x.write_path.tool === 'create_project')!.notes.some((n) => /^Step \(b\): held\..*name check/.test(n)), 'a new key for a project key that exists is refused by the declared name check, on its own merits');
      const held = rs.find((x) => x.scenario.id === 'held-request' && x.requirement === 'MWS-CONC-3' && x.write_path.tool === 'update_ticket')!;
      assert.ok(held.notes.some((n) => /^hold A, run B: held #\d+ PATCH \/tickets\/T-\d+, released after the other writer finished/.test(n)), 'the record says which request was held and when it was released');
      const md = readFileSync(join(r.outDir, 'report.md'), 'utf8');
      assert.ok(md.startsWith('Scope: '));
      assert.ok(!/\b\d+ (of|\/) \d+ (requirements|passed)\b|\bcompliant\b|\bcertified\b|\d+ ?% (of|passed)/i.test(md), 'no aggregate, no claim word');
    } finally {
      await t.close();
    }
  });
}

for (const [defect, expect] of Object.entries(EXPECT)) {
  test(`--defect ${defect}: violated ${expect.join(', ') || 'nothing (see the notes)'}`, { skip }, async () => {
    const t = await startTinyTracker(dir!, { defects: [defect], pairs: 10, gateReps: 1 });
    try {
      const r = await runTT(t);
      assert.deepEqual(violatedIds(r.doc.results), [...expect].sort(), violatedKeys(r.doc.results).join('; '));
      assert.deepEqual(r.doc.leftovers, []);
      assert.deepEqual(saidNo(r.doc.results).sort(), SAID_NO[defect] ?? []);
    } finally {
      await t.close();
    }
  });
}

// With every defect on, ignore-project-scope makes MWS-TGT-1 violated, so the selector probes of MWS-TGT-2 are not sent (spec 7.3:
// only after MWS-TGT-1 is held on the scope-named container); TGT-2 is then not tested, by the tester's own safety rule. For the
// same reason the multi-item delete delete_tickets, told its project by the scope argument, is not called (re-review of note 8,
// item 1), so MWS-ATOM-2, whose only violation in this build is that delete's, is not tested.
test('--defect all: every requirement violated except MWS-CONC-5 and MWS-CONC-6 (self-attested "no"), MWS-TGT-2 and MWS-ATOM-2 (not run, spec 7.3)', { skip }, async () => {
  const t = await startTinyTracker(dir!, { defects: ['all'], pairs: 10, gateReps: 1 });
  try {
    const r = await runTT(t);
    assert.deepEqual(violatedIds(r.doc.results), REQUIREMENTS.map((x) => x.id).filter((id) => id !== 'MWS-CONC-5' && id !== 'MWS-CONC-6' && id !== 'MWS-TGT-2' && id !== 'MWS-ATOM-2').sort());
    assert.match(r.doc.results.find((x) => x.requirement === 'MWS-TGT-2')!.reason, /MWS-TGT-1 is not held/);
    assert.match(r.doc.results.find((x) => x.requirement === 'MWS-ATOM-2' && x.write_path.tool === 'delete_tickets')!.reason, /MWS-TGT-1 has not been run for delete_tickets with the verdict held/);
    const no = saidNo(r.doc.results);
    assert.ok(no.some((k) => k.startsWith('MWS-CONC-5')) && no.some((k) => k.startsWith('MWS-CONC-6')), no.join('; '));
    assert.equal(r.exit, 1);
    assert.deepEqual(r.doc.leftovers, []);
  } finally {
    await t.close();
  }
});

// A correct server that keeps keys itself, over a backend without one (Annex B-5): never two tickets for one key, and after a
// restart the repeat is refused, not applied. With a declaration that does not claim a backend key, step (e) is held with the
// note "key record not kept" and says the declaration is silent; nothing is violated.
test('the honest key store (TRACKER_VARIANTS=key-store-honest): held with the notes, nothing violated', { skip }, async () => {
  const noBackendKey = (text: string) => text.replace(/(title: "\{\{marker\}\}" \}, key: \{ arg: idempotency_key \}, replay_marker: replayed), backend_key: true/, '$1');
  const t = await startTinyTracker(dir!, { variants: ['key-store-honest'], pairs: 10, gateReps: 1, edit: noBackendKey });
  try {
    const r = await runTT(t);
    const rs = r.doc.results;
    assert.deepEqual(violatedKeys(rs), []);
    assert.deepEqual(r.doc.leftovers, []);
    const rec = (sc: string) => rs.find((x) => x.requirement === 'MWS-RETRY-2' && x.write_path.tool === 'create_ticket' && x.scenario.id === sc)!;
    assert.equal(rec('idempotency-replay').verdict, 'held');
    const e = rec('idempotency-replay.restart');
    assert.equal(e.verdict, 'held');
    assert.match(e.reason, /"key record not kept"/);
    assert.match(e.reason, /declaration is silent on whether the tool's key record survives a restart/);
    for (const sc of ['idempotency-replay.proxy', 'idempotency-replay.restart-crash']) {
      assert.equal(rec(sc).verdict, 'held', sc);
      assert.match(rec(sc).reason, /"outcome not established"/, sc);
      assert.match(rec(sc).reason, /declaration is silent/, sc);
    }
    assert.ok(!rs.some((x) => x.requirement === 'MWS-RES-2' && x.scenario.id.startsWith('idempotency-replay')), 'the refusal after a restart does not say the earlier call failed');
  } finally {
    await t.close();
  }
});

test('--backend-defect lost-update: platform, not violated', { skip }, async () => {
  const t = await startTinyTracker(dir!, { backendDefect: 'lost-update', pairs: 10, gateReps: 1 });
  try {
    const r = await runTT(t);
    assert.deepEqual(violatedKeys(r.doc.results), []);
    assert.equal(r.doc.results.find((x) => x.requirement === 'MWS-CONC-3' && x.scenario.id === 'barrier-pairs' && x.write_path.tool === 'update_ticket')?.verdict, 'platform');
  } finally {
    await t.close();
  }
});

test('the node --import route: read-merge-put is found through the cooperative hook, and the record says so', { skip }, async () => {
  const t = await startTinyTracker(dir!, { defects: ['read-merge-put'], pairs: 4, gateReps: 1, gate: 'node_import' });
  try {
    const r = await runTT(t);
    const rec = r.doc.results.find((x) => x.requirement === 'MWS-CONC-3' && x.scenario.id === 'held-request' && x.write_path.tool === 'update_ticket')!;
    assert.equal(rec.verdict, 'violated');
    assert.ok(rec.notes.some((n) => /hook inside the server/i.test(n)), rec.notes.join(' | '));
    assert.equal(r.doc.safety.gate?.route, 'node_import');
  } finally {
    await t.close();
  }
});
