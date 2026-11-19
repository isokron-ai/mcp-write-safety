/**
 * compare (`mws-compare/1`): before/after per cell, from two results.json files of the same test on two server builds.
 *
 * A cell is `<requirement>@<tool>` (the record's `cell` where the run stamped one; MUST and SHOULD alike). Its verdict on
 * each side is rolled up from its records by MWS section 8.2 rule 13: violated, then platform, then held, then not observed,
 * then not tested. Within that order a `violated` record whose validity says it does not count (harness-suspect) ranks below
 * held and is shown as `violated?`, and `self-attested` ranks above `not tested`; `not applicable` is last. Where the run wrote
 * its own cells (results.cells) and they disagree with this roll-up on a verdict other than not tested or not applicable, the
 * cell is not compared (`rollup-mismatch`); for not tested against not applicable the run's own cell decides, since only the
 * run knows its applicability rules.
 *
 * Records are joined slot by slot and case by case: a slot is the record's requirement, resource, tool, procedure id and case
 * (records of a procedure that makes several on one write path carry a case id). Two records are the same test where their
 * test hashes are equal, or, under mws-test-hash/2, where their test inputs differ only as owner rule A allows (sameTest): the
 * same tester build and every input other than the tools equal, every argument the before test sent present after with equal
 * constraints, and every other difference an added optional argument or optional nested property, or a required argument
 * relaxed to optional (RELAXED_REQUIRED_IS_SAME_TEST); each tolerated difference is listed (same_test_because). A tightening is
 * `test-changed`; records hashed under different schemes are `scheme-changed`. For a requirement that judges the schema (MWS-IN-2,
 * 3, 5, 6, 7), a changed constraint of a probed argument is a change of the subject (schema-fixed or subject-changed, and a
 * regression when held → violated); a probed argument that is gone is a changed test. Several records in one slot without case
 * ids keep the slot from a fix where their counts differ or an after record is not tested, not observed or violated?. A slot on
 * one side only is joined when its record is `not tested` or `not applicable`, and is `coverage-change` when it carries a tested
 * verdict. A fix is claimed only between records judged by one stated, clean tester build (else `tester-unpinned`). `test_hash` on
 * a side is sha256 over the cell's sorted distinct record hashes, for display.
 *
 * Labels: `fixed` (violated → held, nothing else), `regressed` (held or not observed → violated), `unchanged` (the same
 * verdict), `changed` (another move between two tested verdicts: violated → not observed, anything to or from platform, held
 * → not observed …; never a fix), and `not comparable` (test changed, coverage changed (to or from not tested or not
 * applicable), a cell on one side only, an unstable `violated?`, or a roll-up mismatch). The finer `transition` class follows
 * the before/after design (§1.5). There is no total: cells are listed, never counted.
 */

import { createHash } from 'node:crypto';

import { canonical, isObj, sha256 } from '../core/util.js';
import { TEST_HASH_FORMAT, TEST_HASH_FORMATS_READ } from '../core/identity.js';
import { hashOfInputs, isSchemaProbe, subjectFacets, type Facet, type Shape, type TestInputs, type ToolShape } from './testhash.js';
import { SUITE_NAME, SUITE_VERSION } from '../version.js';
import type { VerifyOutcome } from './sign.js';

export const COMPARE_FORMAT = 'mws-compare/1';

/** A cell's state on one side: the seven verdicts, plus `violated?` for a violated record that does not count. */
export type CellState = 'violated' | 'platform' | 'held' | 'violated?' | 'not observed' | 'self-attested' | 'not tested' | 'not applicable';
const UNTESTED: CellState[] = ['not tested', 'not applicable'];
export const ROLLUP_ORDER: CellState[] = ['violated', 'platform', 'held', 'violated?', 'not observed', 'self-attested', 'not tested', 'not applicable'];

export type Label = 'fixed' | 'schema-fixed' | 'regressed' | 'unchanged' | 'changed' | 'not comparable';
export type Transition =
  | 'fixed'
  | 'regressed'
  | 'still-violated'
  | 'held-both'
  | 'platform-both'
  | 'same'
  | '→platform'
  | 'platform→'
  | 'not-seen-after'
  | 'changed'
  | 'coverage-change'
  | 'test-changed'
  | 'no-test-hash'
  | 'unstable'
  | 'rollup-mismatch'
  | 'new-cell'
  | 'removed-cell'
  | 'partly-held'
  | 'subject-changed'
  | 'schema-fixed'
  | 'scheme-changed'
  | 'hash-mismatch'
  | 'tester-unpinned';

interface Rec {
  requirement: string;
  level?: string;
  write_path: { resource: string; tool: string };
  scenario: { id: string; version: string };
  verdict: string;
  reason?: string;
  cell?: string;
  test_hash?: string;
  test_hash_core?: string;
  test_inputs?: TestInputs;
  case?: string;
  validity?: { counts?: boolean; class?: string };
  attribution?: string | null;
  /** A self-attested record's answer is in numbers.answer. */
  numbers?: Record<string, unknown> | null;
  /** Set by compare (never written): the record's hash scheme and the tester the file states. */
  _scheme?: string;
  _doc_tester?: string | null;
}

export interface Side {
  verdict: CellState;
  /** The cell's records, for the join (not written to compare.json). */
  recs?: Rec[];
  /** sha256 over the cell's sorted distinct record test hashes; null where a record has none. */
  test_hash: string | null;
  level: string | null;
  /** The run's own cell verdict (results.cells), where it wrote one. */
  run_cell: string | null;
  /** The deciding record's reason. */
  reason: string;
  /** JSONPaths of the cell's records in that results.json. */
  records: string[];
  scenarios: string[];
}

export interface CellCompare {
  key: string;
  requirement: string;
  tool: string;
  before: Side | null;
  after: Side | null;
  transition: Transition;
  label: Label;
  /** Why, in a sentence (always for not comparable and changed). */
  why: string;
  /** Slots (resource/procedure) of the cell whose verdict moved, on equal test hashes; absent when none moved. */
  slot_moves?: { slot: string; before: CellState; after: CellState }[];
  /** Slots that went from held or not observed to violated, in a cell whose own label is not `regressed`. */
  slot_regressions?: string[];
  /** Why records whose hashes differ were judged the same test (rule A): each difference that was tolerated, by slot. */
  same_test_because?: string[];
  /** Violated on the after build in a cell the before build did not test (no cell, not tested or not applicable). */
  newly_found?: boolean;
  /** Only on `subject-changed`: the parts of the tool entry the requirement judges that changed (report/testhash.ts, subjectFacets). */
  facets?: Facet[];
}

export interface RunSummary {
  file: string;
  /** sha256 of the file's bytes, so a page can link to the exact file. */
  sha256: string;
  run_id: string | null;
  status: string | null;
  stopped_reason: string | null;
  suite: { name: string; version: string } | null;
  tester_commit: string | null;
  spec: string | null;
  manifest_sha256: string | null;
  plan_hash: string | null;
  tools_fingerprint: string | null;
  server: Record<string, unknown> | null;
  backend: unknown[] | null;
  identity_gaps: string[] | null;
  signature: { status: string; key_id: string | null; detail: string; accepted?: 'pinned' | 'allow-unsigned' };
  /** When the run started (run.started). */
  started?: string | null;
  tester_dirty?: boolean | null;
  /** The build that rechecked the file, where one did (identity.rechecked_by). */
  rechecked_by?: { version: string | null; commit: string | null } | null;
  /** Every tester build that judged a record of the file (from the records' test_inputs), as `version @ commit`. */
  judged_by?: string[];
}

/** The tester build a file states (identity.tester and rechecked_by), or null where it states none, or a dirty one. */
function docTesterKey(doc: Record<string, unknown>): string | null {
  const id = isObj(doc['identity']) ? doc['identity'] : null;
  const t = id && isObj(id['tester']) ? id['tester'] : null;
  if (!t || typeof t['commit'] !== 'string' || !t['commit'] || t['dirty'] === true) return null;
  const rb = id && isObj(id['rechecked_by']) ? id['rechecked_by'] : null;
  if (rb && (typeof rb['commit'] !== 'string' || rb['dirty'] === true)) return null;
  return `${String(t['version'])}@${t['commit']}${rb ? `+recheck:${String(rb['version'])}@${String(rb['commit'])}` : ''}`;
}

export interface CompareDoc {
  format: typeof COMPARE_FORMAT;
  tool: { name: string; version: string };
  /** IsoKron letters are off until activation (design §1.6); compare never rates. */
  rating: null;
  spec: { version: string };
  test_hash: string;
  before: RunSummary;
  after: RunSummary;
  same: { manifest: boolean; plan: boolean; tools: boolean; tester: boolean };
  warnings: string[];
  cells: CellCompare[];
}

export class CompareRefused extends Error {}

const recsOf = (doc: Record<string, unknown>): Rec[] => (Array.isArray(doc['results']) ? (doc['results'] as Rec[]) : []);
export const cellKeyOf = (r: Rec): string => r.cell ?? `${r.requirement}@${r.write_path.tool}`;

function stateOf(r: Rec): CellState {
  if (r.verdict === 'violated') return r.validity?.counts === false ? 'violated?' : 'violated';
  return (ROLLUP_ORDER.includes(r.verdict as CellState) ? r.verdict : 'not tested') as CellState;
}

/** Rule 13 roll-up of one cell's records (see the header for violated? and self-attested). */
export function rollUp(recs: Rec[]): { verdict: CellState; deciding: Rec } {
  let best = recs[0]!;
  let rank = ROLLUP_ORDER.indexOf(stateOf(best));
  for (const r of recs) {
    const k = ROLLUP_ORDER.indexOf(stateOf(r));
    if (k < rank) {
      rank = k;
      best = r;
    }
  }
  return { verdict: ROLLUP_ORDER[rank]!, deciding: best };
}

export function cellTestHash(recs: Rec[]): string | null {
  if (recs.some((r) => typeof r.test_hash !== 'string')) return null;
  const hs = [...new Set(recs.map((r) => r.test_hash!))].sort();
  return `sha256:${sha256(hs.join('\n'))}`;
}

function sides(doc: Record<string, unknown>): Map<string, { side: Side; recs: Rec[]; requirement: string; tool: string }> {
  const groups = new Map<string, { recs: Rec[]; idx: number[] }>();
  const id = isObj(doc['identity']) ? doc['identity'] : null;
  const scheme = id && typeof id['test_hash'] === 'string' ? id['test_hash'] : 'mws-test-hash/1';
  const docTester = docTesterKey(doc);
  recsOf(doc).forEach((r0, i) => {
    const r: Rec = { ...r0, _scheme: scheme, _doc_tester: docTester };
    const k = cellKeyOf(r);
    const g = groups.get(k) ?? { recs: [], idx: [] };
    g.recs.push(r);
    g.idx.push(i);
    groups.set(k, g);
  });
  const runCells = new Map<string, string>();
  if (Array.isArray(doc['cells'])) for (const c of doc['cells'] as { key?: string; verdict?: string }[]) if (c.key && c.verdict) runCells.set(c.key, c.verdict);
  const out = new Map<string, { side: Side; recs: Rec[]; requirement: string; tool: string }>();
  for (const [k, g] of groups) {
    const rolled = rollUp(g.recs);
    const { deciding } = rolled;
    const rc = runCells.get(k) as CellState | undefined;
    // why: review p07c: for not tested against not applicable the run's own cell decides (only the run knows its applicability rules).
    const verdict = UNTESTED.includes(rolled.verdict) && rc && UNTESTED.includes(rc) ? rc : rolled.verdict;
    out.set(k, {
      requirement: deciding.requirement,
      tool: deciding.write_path.tool,
      recs: g.recs,
      side: {
        verdict,
        recs: g.recs,
        test_hash: cellTestHash(g.recs),
        level: deciding.level ?? null,
        run_cell: runCells.get(k) ?? null,
        reason: deciding.reason ?? '',
        records: g.idx.map((i) => `$.results[${i}]`),
        scenarios: [...new Set(g.recs.map((r) => `${r.scenario.id} v${r.scenario.version}`))].sort(),
      },
    });
  }
  return out;
}


/** The run's own cell and this roll-up disagree on a tested verdict. */
function mismatch(s: Side): string | null {
  if (!s.run_cell) return null;
  const mine = s.verdict === 'violated?' ? 'violated' : s.verdict;
  if (UNTESTED.includes(mine) && UNTESTED.includes(s.run_cell as CellState)) return null;
  return mine === s.run_cell ? null : `the run's own cell says ${s.run_cell}, the rule-13 roll-up of its records says ${s.verdict}`;
}

const slotOf = (r: Rec) => `${r.requirement}|${r.write_path.resource}|${r.write_path.tool}|${r.scenario.id}|${r.case ?? ''}`;
const slotName = (r: Rec) => `${r.write_path.resource}/${r.scenario.id}${r.case !== undefined ? `[${r.case}]` : ''} v${r.scenario.version}`;

/**
 * Owner rule A (18 Nov), decided: a fix after which the same call is accepted by both versions is the same test. Tolerated: an
 * added optional argument (also one the common manifest already sends), an added optional nested property, and a required
 * argument relaxed to optional while the test's call is unchanged (this constant). A tightening (optional to required, a new
 * required argument, a changed type, enum, format or bound of an argument the test sends) is always a changed test.
 */
export const RELAXED_REQUIRED_IS_SAME_TEST = true;

/**
 * An argument the test sends, undeclared before in a schema with additionalProperties false and declared (optional) after: the
 * same call. Owner rule A (18 Nov) names it the same test (an added optional returnDocument the common manifest already sends);
 * the call is unchanged, and whether the before server accepted it shows in the before verdicts. Decided under rule A (owner
 * decision, 18 Nov 2026); compare says it under the cell.
 */
export const UNDECLARED_IN_CLOSED_SCHEMA_IS_SAME_TEST = true;

const keysOf = (o: Record<string, unknown> | undefined): string[] => (o ? Object.keys(o).sort() : []);
const hasKey = (o: Record<string, unknown> | undefined, k: string): boolean => !!o && Object.prototype.hasOwnProperty.call(o, k);

/** Rule A on one argument's shape: `bad` gets every change that makes another test, `tol` every change that is tolerated. */
function cmpShape(b: Shape, a: Shape, at: string, tol: string[], bad: string[], relax = RELAXED_REQUIRED_IS_SAME_TEST): void {
  if (b.h !== a.h) {
    bad.push(`${at}: its type or constraints changed`);
    return;
  }
  const bp = b.p;
  const ap = a.p;
  const br = b.r ?? [];
  const ar = a.r ?? [];
  for (const n of keysOf(bp)) {
    if (!hasKey(ap, n)) bad.push(`${at}.${n}: a nested property was removed`);
    else cmpShape(bp![n]!, ap![n]!, `${at}.${n}`, tol, bad, relax);
  }
  for (const n of keysOf(ap)) if (!hasKey(bp, n)) (ar.includes(n) ? bad.push(`${at}.${n}: a new required nested property`) : tol.push(`${at}.${n}: an optional nested property added`));
  for (const n of ar) if (!br.includes(n) && hasKey(bp, n)) bad.push(`${at}.${n}: a nested property became required`);
  for (const n of ar) if (!br.includes(n) && !hasKey(ap, n)) bad.push(`${at}: a new required name ${n}`);
  for (const n of br) if (!ar.includes(n)) (relax ? tol.push(`${at}.${n}: relaxed from required to optional`) : bad.push(`${at}.${n}: relaxed from required to optional (this check acts on required)`));
  if (b.i && a.i) cmpShape(b.i, a.i, `${at}[]`, tol, bad, relax);
  else if (b.i || a.i) bad.push(`${at}: its array items changed`);
}

/** Rule A on a tool: every argument the before test sent is there with equal constraints; the rest is tolerated or not (above). */
function cmpTool(b: ToolShape, a: ToolShape, tool: string, tol: string[], bad: string[], probed: boolean, removed: string[] = bad, relax = RELAXED_REQUIRED_IS_SAME_TEST): void {
  if (b.h !== a.h) bad.push(`${tool}: a keyword that constrains the arguments together changed`);
  for (const n of keysOf(b.p)) {
    if (!hasKey(a.p, n)) removed.push(`${tool}.${n}: ${probed ? 'a probed argument' : 'an argument the test sends'} was removed`);
    else cmpShape(b.p[n]!, a.p[n]!, `${tool}.${n}`, tol, bad, relax);
  }
  for (const n of keysOf(a.p)) {
    if (hasKey(b.p, n)) continue;
    if (a.r.includes(n)) bad.push(`${tool}.${n}: ${probed ? 'a new required argument' : 'an argument the test sends is now declared and required'}`);
    // why: rule A (owner decision, 18 Nov 2026) names this case (an optional returnDocument the common manifest already sends,
    // added by the fix) the same test: the call is the same; whether the before build refused it shows in its verdicts.
    else if (!probed && (a.x || b.x)) (UNDECLARED_IN_CLOSED_SCHEMA_IS_SAME_TEST ? tol.push(`${tool}.${n}: an optional argument added (the test sends it); the before schema allowed no undeclared argument: check that the before build accepted the call`) : bad.push(`${tool}.${n}: an argument the test sends is now declared, in a schema that allows no undeclared argument`));
    else tol.push(`${tool}.${n}: an optional argument added${probed ? '' : ' (the test sends it)'}`);
  }
  for (const n of a.r) if (!b.r.includes(n) && hasKey(b.p, n)) bad.push(`${tool}.${n}: became required`);
  for (const n of b.r) if (!a.r.includes(n) && hasKey(a.p, n)) (relax ? tol.push(`${tool}.${n}: relaxed from required to optional (the test sends it both times)`) : bad.push(`${tool}.${n}: relaxed from required to optional (this check acts on required, so its calls change)`));
  for (const n of a.ro) if (!b.ro.includes(n)) bad.push(`${tool}.${n}: a new required argument the test does not send`);
  // why: review F4: a required argument the test does not send made the before call incomplete; after, the same call is accepted.
  // (only for a tool the test calls with arguments: a record that reads the catalog or scans answers sends none)
  for (const n of b.ro) if (!a.ro.includes(n) && !hasKey(a.p, n)) (keysOf(b.p).length ? bad.push(`${tool}.${n}: a required argument the test does not send is no longer required (the before build refused the call)`) : tol.push(`${tool}.${n}: a required argument is no longer required (the test sends this tool no arguments)`));
}

/**
 * Requirements whose procedure acts on the `required` of the arguments it probes, so that relaxing a probed argument to optional
 * changes the calls the test sends (review F4): MWS-IN-1 compares a probe with the call without the argument only for an
 * optional one (checks/schema.ts). MWS-CONC-2's run that leaves an optional version argument out is in `chosen`
 * (version_left_out), since only the version argument's `required` decides it.
 */
export const REQUIRED_DRIVES_CALLS = ['MWS-IN-1'] as const;

interface SameTest {
  kind: 'equal' | 'rule-a' | 'subject' | 'changed' | 'scheme';
  why: string;
  tolerated: string[];
  facets?: Facet[];
}

const schemeOf = (r: Rec): string => r.test_inputs?.scheme ?? r._scheme ?? 'mws-test-hash/1';

/** Whether two records (one slot, one case) are the same test (MANIFEST.md, compare: rule A). */
export function sameTest(rb: Rec, ra: Rec): SameTest {
  const sb = schemeOf(rb);
  const sa = schemeOf(ra);
  if (sb !== sa) return { kind: 'scheme', why: `hashed under different schemes (${sb} before, ${sa} after): run both builds with one tester release, or recheck both files with it`, tolerated: [] };
  const ib = rb.test_inputs;
  const ia = ra.test_inputs;
  if (rb.test_hash === ra.test_hash && (!ib || !ia || ib.scheme === sb)) return { kind: 'equal', why: '', tolerated: [] };
  const procedure = rb.scenario.version !== ra.scenario.version ? ` (procedure v${rb.scenario.version} → v${ra.scenario.version})` : '';
  if (!ib || !ia || sb === 'mws-test-hash/1') {
    const facets = subjectFacets(rb.requirement);
    if (facets.length && typeof rb.test_hash_core === 'string' && rb.test_hash_core === ra.test_hash_core) return { kind: 'subject', why: '', tolerated: [], facets };
    return { kind: 'changed', why: procedure || ' (a used argument, the resource block, the declaration, a limit or the tester differs)', tolerated: [] };
  }
  // why: the dirty flag is not part of the build's name; a dirty build is refused a fix by testerProblem, an unknown flag is not.
  if (canonical(testerKey(ib.tester)) !== canonical(testerKey(ia.tester))) return { kind: 'changed', why: ` (another tester build judged it: ${testerName(ib.tester)} before, ${testerName(ia.tester)} after)`, tolerated: [] };
  if (ib.rest !== ia.rest) return { kind: 'changed', why: procedure || ' (the procedure, its case, the resource block, the declaration, a limit or a setting differs)', tolerated: [] };
  if (canonical(ib.extras ?? null) !== canonical(ia.extras ?? null)) return { kind: 'changed', why: ` (a setting of the tester or a document it read differs: ${canonical(ib.extras ?? null)} before, ${canonical(ia.extras ?? null)} after)`, tolerated: [] };
  const tol: string[] = [];
  const bad: string[] = [];
  const relax = RELAXED_REQUIRED_IS_SAME_TEST;
  const relaxProbed = RELAXED_REQUIRED_IS_SAME_TEST && !(REQUIRED_DRIVES_CALLS as readonly string[]).includes(rb.requirement);
  for (const t of [...new Set([...Object.keys(ib.tools), ...Object.keys(ia.tools)])].sort()) {
    const x = ib.tools[t];
    const y = ia.tools[t];
    if (x === undefined || y === undefined) bad.push(`${t}: named by the test on one build only`);
    else if (x === null || y === null) {
      if (x !== y) bad.push(`${t}: in the tool list of one build only`);
    } else cmpTool(x, y, t, tol, bad, false, bad, relax);
  }
  if (canonical(ib.chosen ?? null) !== canonical(ia.chosen ?? null)) bad.push(`the procedure chose other calls from the schema (${canonical(ib.chosen ?? null)} before, ${canonical(ia.chosen ?? null)} after)`);
  const facets = new Set<Facet>();
  if (isSchemaProbe(rb.requirement)) {
    const x = ib.probed ?? null;
    const y = ia.probed ?? null;
    const judged = subjectFacets(rb.requirement).includes('schema');
    if (x === null || y === null) {
      if (x !== y) bad.push(`${rb.write_path.tool}: in the tool list of one build only`);
    } else {
      // why: review M4: a probed argument that is gone means the probe that failed was not sent again: never a fix.
      const changedArgs: string[] = [];
      cmpTool(x, y, rb.write_path.tool, tol, judged ? changedArgs : bad, true, bad, relaxProbed);
      if (changedArgs.length) {
        facets.add('schema');
        tol.push(...changedArgs.map((c) => `judged schema changed: ${c}`));
      }
    }
  }
  for (const f of new Set([...Object.keys(ib.subject ?? {}), ...Object.keys(ia.subject ?? {})])) if ((ib.subject ?? {})[f] !== (ia.subject ?? {})[f]) facets.add(f as Facet);
  if (bad.length) return { kind: 'changed', why: ` (${bad.join('; ')})`, tolerated: tol };
  if (facets.size) return { kind: 'subject', why: '', tolerated: tol, facets: [...facets] };
  return { kind: 'rule-a', why: '', tolerated: tol };
}

const testerKey = (t: { name?: string; version?: string; commit?: string | null }) => ({ name: t.name ?? null, version: t.version ?? null, commit: t.commit ?? null });

const testerName = (t: { name?: string; version?: string; commit?: string | null; dirty?: boolean | null } | null | undefined): string => (t ? `${t.version ?? '?'} @ ${t.commit ? t.commit.slice(0, 12) : 'unstamped'}${t.dirty ? ' (dirty)' : ''}` : 'not stated');

/**
 * Why the tester build of two joined records cannot be called the same build: a record (or, for mws-test-hash/1, the file)
 * that states no commit, or a build from a tree with uncommitted changes. null === null is not the same build.
 */
function testerProblem(rb: Rec, ra: Rec): string | null {
  for (const [n, r] of [['before', rb], ['after', ra]] as const) {
    const t = r.test_inputs?.tester;
    if (t) {
      if (!t.commit) return `${n}: the tester build that judged it states no commit`;
      if (t.dirty === true) return `${n}: the tester build that judged it was built from a dirty tree`;
    } else if (!r._doc_tester) return `${n}: the file states no clean, stamped tester build (identity.tester)`;
  }
  if (!rb.test_inputs && !ra.test_inputs && rb._doc_tester !== ra._doc_tester) return 'the two files state different tester builds';
  return null;
}

/** Why a record's stored hashes do not follow from its test inputs (mws-test-hash/2), or null. */
export function inputsMismatch(r: Rec): string | null {
  const i = r.test_inputs;
  if (!i || i.scheme !== TEST_HASH_FORMAT) return null;
  if (hashOfInputs(r.requirement, i) !== r.test_hash) return 'its test_hash does not follow from its test_inputs (the file was edited, or written by another scheme)';
  if (typeof r.test_hash_core === 'string' && hashOfInputs(r.requirement, i, true) !== r.test_hash_core) return 'its test_hash_core does not follow from its test_inputs';
  return null;
}

export interface SlotMove {
  slot: string;
  before: CellState;
  after: CellState;
  /** Several records in one slot without case ids: why no fix can be claimed on it (review M2). */
  ambiguous?: string;
}

export interface Join {
  /** Why the cell is not compared, or null when every slot is the same test. */
  problem: { transition: Transition; why: string; facets?: Facet[] } | null;
  /** Every slot on both sides with equal hashes, with its rolled-up verdict on each side. */
  slots: SlotMove[];
  /** Slots on both sides whose hashes differ only in the judged part of the tool entry. */
  subjectSlots: SlotMove[];
  /** Differences tolerated by rule A, by slot. */
  tolerated: string[];
  /** A tester build that is not stated or not clean, on a joined slot. */
  tester: string | null;
}

const isRegression = (m: SlotMove) => (m.before === 'held' || m.before === 'not observed') && m.after === 'violated';

/** Whether two cells' records are the same tests, slot by slot and case by case (see the header). */
export function joinCell(b: Rec[], a: Rec[]): Join {
  const empty = { slots: [], subjectSlots: [], tolerated: [], tester: null };
  const noHash = [...b.map((r) => ['before', r] as const), ...a.map((r) => ['after', r] as const)].find(([, r]) => typeof r.test_hash !== 'string');
  if (noHash) return { problem: { transition: 'no-test-hash', why: `${noHash[0]}: the record ${slotName(noHash[1])} carries no test_hash` }, ...empty };
  // why: review F7: a stored test_hash must follow from the record's own test inputs before an equal hash is trusted.
  const forged = [...b.map((r) => ['before', r] as const), ...a.map((r) => ['after', r] as const)].find(([, r]) => inputsMismatch(r));
  if (forged) return { problem: { transition: 'hash-mismatch', why: `${forged[0]}: the record ${slotName(forged[1])}: ${inputsMismatch(forged[1])}` }, ...empty };
  const group = (rs: Rec[]) => {
    const m = new Map<string, Rec[]>();
    for (const r of rs) m.set(slotOf(r), [...(m.get(slotOf(r)) ?? []), r]);
    return m;
  };
  const sb = group(b);
  const sa = group(a);
  const changed: string[] = [];
  const schemes: string[] = [];
  const subject: string[] = [];
  const subjectSlots: SlotMove[] = [];
  const facets = new Set<Facet>();
  const slots: SlotMove[] = [];
  const coverage: string[] = [];
  const tolerated: string[] = [];
  let tester: string | null = null;
  for (const [k, x] of sb) {
    const y = sa.get(k);
    if (!y) continue;
    const name = slotName(x[0]!).replace(/ v.*$/, '');
    // why: review M2: records of one slot without case ids cannot be paired; they must at least be one test on each side.
    const mixed = [x, y].find((rs) => new Set(rs.map((r) => r.test_hash)).size > 1);
    if (mixed) {
      changed.push(`${name} (records of one slot without case ids carry different test hashes)`);
      continue;
    }
    const st = sameTest(x[0]!, y[0]!);
    if (st.kind === 'scheme') {
      schemes.push(`${name}: ${st.why}`);
      continue;
    }
    if (st.kind === 'changed') {
      changed.push(`${name}${st.why}`);
      continue;
    }
    tester ??= testerProblem(x[0]!, y[0]!);
    for (const t of st.tolerated) tolerated.push(`${name}: ${t}`);
    const m: SlotMove = { slot: name, before: rollUp(x).verdict, after: rollUp(y).verdict };
    if (x.length > 1 || y.length > 1) {
      const loose = y.filter((r) => ['not tested', 'not observed', 'violated?'].includes(stateOf(r)));
      if (x.length !== y.length) m.ambiguous = `${x.length} record(s) before and ${y.length} after in one slot, without case ids`;
      else if (loose.length) m.ambiguous = `${loose.length} of the slot's ${y.length} records after are ${[...new Set(loose.map(stateOf))].join(' or ')}, and the records carry no case ids to pair them`;
    }
    if (st.kind === 'subject') {
      for (const f of st.facets ?? []) facets.add(f);
      subject.push(name);
      subjectSlots.push(m);
      continue;
    }
    // why: review: a slot tested on one build and not on the other has no evidence to compare on the other.
    if (UNTESTED.includes(m.before) !== UNTESTED.includes(m.after)) coverage.push(`${name} ${m.before} → ${m.after}`);
    slots.push(m);
  }
  // why: rule A on the real pairs (set-up rule): a run whose set-up of a resource fails writes one `setup` record for the
  // requirement in place of the records of the procedures it could not run (cli/run.ts). Where the other build set the same
  // resource up (it has tested records for the same requirement, resource and tool, made under the same context, tools and
  // tester), its set-up made the same writes and passed: the set-up slot is joined as held on that side, and the procedure
  // slots the set-up record stood for are not a coverage change.
  const handled = new Set<string>();
  const setupJoin = (one: Map<string, Rec[]>, other: Map<string, Rec[]>, otherRecs: Rec[], side: 'before' | 'after') => {
    for (const [k, x] of one) {
      if (other.has(k) || x[0]!.scenario.id !== 'setup') continue;
      const r0 = x[0]!;
      const partners = otherRecs.filter((r) => r.requirement === r0.requirement && r.write_path.resource === r0.write_path.resource && r.write_path.tool === r0.write_path.tool && r.scenario.id !== 'setup' && !UNTESTED.includes(stateOf(r)));
      const p0 = partners[0];
      const [ib, ia] = side === 'before' ? [r0.test_inputs, p0?.test_inputs] : [p0?.test_inputs, r0.test_inputs];
      if (!p0 || !ib || !ia || ib.scheme !== ia.scheme || !ib.context || ib.context !== ia.context || canonical(testerKey(ib.tester)) !== canonical(testerKey(ia.tester))) continue;
      const tol: string[] = [];
      const bad: string[] = [];
      for (const t of [...new Set([...Object.keys(ib.tools), ...Object.keys(ia.tools)])].sort()) {
        const tb = ib.tools[t];
        const ta = ia.tools[t];
        if (!tb || !ta) {
          if (tb !== ta) bad.push(t);
        } else cmpTool(tb, ta, t, tol, bad, false);
      }
      if (bad.length) continue;
      const name = slotName(r0).replace(/ v.*$/, '');
      handled.add(k);
      for (const p of partners) handled.add(slotOf(p));
      tester ??= testerProblem(side === 'before' ? r0 : p0, side === 'before' ? p0 : r0);
      const m: SlotMove = side === 'before' ? { slot: name, before: rollUp(x).verdict, after: 'held' } : { slot: name, before: 'held', after: rollUp(x).verdict };
      tolerated.push(`${name}: the ${side === 'before' ? 'after' : 'before'} build set ${r0.write_path.resource} up with the same writes and passed (no set-up record; its records ${[...new Set(partners.map((p) => p.scenario.id))].join(', ')} stand where the set-up record stood)`, ...tol.map((t) => `${name}: ${t}`));
      slots.push(m);
    }
  };
  setupJoin(sb, sa, a, 'before');
  setupJoin(sa, sb, b, 'after');
  for (const k of handled) {
    if (!sb.has(k) || !sa.has(k)) {
      sb.delete(k);
      sa.delete(k);
    }
  }
  const base = { slots, subjectSlots, tolerated, tester };
  if (changed.length) return { problem: { transition: 'test-changed', why: `the test changed: ${changed.join('; ')}` }, ...base };
  if (schemes.length) return { problem: { transition: 'scheme-changed', why: schemes.join('; ') }, ...base };
  const oneSided = (m: Map<string, Rec[]>, other: Map<string, Rec[]>) => [...m].filter(([k]) => !other.has(k)).flatMap(([, rs]) => rs).filter((r) => !UNTESTED.includes(stateOf(r)));
  const onlyB = oneSided(sb, sa);
  const onlyA = oneSided(sa, sb);
  const say = (rs: Rec[]) => rs.map((r) => `${slotName(r)} ${r.verdict}`).join(', ');
  if (onlyB.length || onlyA.length || coverage.length) {
    const parts = [onlyB.length ? `before only: ${say(onlyB)}` : '', onlyA.length ? `after only: ${say(onlyA)}` : '', coverage.length ? `tested on one build only: ${coverage.join(', ')}` : ''].filter(Boolean);
    return { problem: { transition: 'coverage-change', why: `evidence on one build only (${parts.join('; ')})` }, ...base };
  }
  if (subject.length) return { problem: { transition: 'subject-changed', why: `the tool's ${[...facets].join(' and ')} changed, which is what this requirement judges (${subject.join(', ')})`, facets: [...facets] }, ...base };
  return { problem: null, ...base };
}

type Classified = { transition: Transition; label: Label; why: string; slot_moves?: SlotMove[]; slot_regressions?: string[]; same_test_because?: string[]; facets?: Facet[] };

export function classify(b: Side, a: Side): Classified {
  const mb = mismatch(b);
  const ma = mismatch(a);
  if (mb || ma) return { transition: 'rollup-mismatch', label: 'not comparable', why: [mb && `before: ${mb}`, ma && `after: ${ma}`].filter(Boolean).join('; ') };
  let slots: SlotMove[] = [];
  let tolerated: string[] = [];
  let tester: string | null = null;
  // why: re-review 1: the slot moves (and regressions) on equal hashes are reported whatever else makes the cell not comparable;
  // review M4: so are the moves of slots whose judged schema changed.
  const withSlots = (c: Classified): Classified => {
    const moved = slots.filter((m) => m.before !== m.after);
    const regs = moved.filter(isRegression).map((m) => `${m.slot} ${m.before} → violated`);
    // why: review S3, F6: a fix or a regression is claimed only between two records judged by one stated, clean tester build.
    const gated = tester && (c.label === 'fixed' || c.label === 'schema-fixed' || c.label === 'regressed') ? { transition: 'tester-unpinned' as Transition, label: 'not comparable' as Label, why: `${c.why}; not claimed: ${tester}` } : c;
    const regsWhy = tester && regs.length ? { why: `${gated.why}; slot regressions not claimed (${regs.join(', ')}): ${tester}` } : {};
    return { ...gated, ...regsWhy, ...(moved.length ? { slot_moves: moved } : {}), ...(regs.length && !tester && gated.label !== 'regressed' ? { slot_regressions: regs } : {}), ...(tolerated.length ? { same_test_because: tolerated } : {}) };
  };
  if (b.recs && a.recs) {
    const j = joinCell(b.recs, a.recs);
    slots = [...j.slots, ...j.subjectSlots];
    tolerated = j.tolerated;
    tester = j.tester;
    if (j.problem?.transition === 'subject-changed') {
      // why: re-review 2: schema-fixed needs every slot violated before (judged-part slots and the others) held after.
      const open = openSlots(slots);
      if (j.problem.facets?.includes('schema') && b.verdict === 'violated' && a.verdict === 'held' && !open.length)
        return withSlots({ transition: 'schema-fixed', label: 'schema-fixed', why: `${j.problem.why}: every slot violated before is held after. compare cannot read the schemas: check that the after build's schema now declares the constraint the before run found` });
      // why: review M4: held → violated across a change of the judged schema, every other input the same, is a regression.
      if ((b.verdict === 'held' || b.verdict === 'not observed') && a.verdict === 'violated') return withSlots({ transition: 'regressed', label: 'regressed', why: `${b.verdict} on the before build; violated on the after build, where ${j.problem.why.replace(/^the tool's/, 'only the tool\'s')}` });
      // why: the cell says which judged part changed (facets), so a reader need not parse `why`; the schema allows it on this transition only.
      return withSlots({ transition: 'subject-changed', why: j.problem.why, facets: j.problem.facets ?? [], label: 'not comparable', ...(open.length && b.verdict === 'violated' ? { why: `${j.problem.why}; not schema-fixed: ${open.map((m) => `${m.slot} ${m.before} → ${m.after}${m.ambiguous ? ` (${m.ambiguous})` : ''}`).join(', ')}` } : {}) });
    }
    if (j.problem) return withSlots({ transition: j.problem.transition, why: j.problem.why, label: 'not comparable' });
  } else {
    if (!b.test_hash || !a.test_hash) return { transition: 'no-test-hash', label: 'not comparable', why: `${!b.test_hash ? 'before' : 'after'}: a record of this cell carries no test_hash` };
    if (b.test_hash !== a.test_hash) return { transition: 'test-changed', label: 'not comparable', why: 'the test changed: the test hashes differ' };
  }
  return withSlots(verdictMove(b, a, slots));
}

/** Slots that keep a fix from being claimed: violated (or violated?) before and not held after, violated? after, or several records without case ids that cannot be paired (review M2). */
function openSlots(slots: SlotMove[]): SlotMove[] {
  return slots.filter((m) => ((m.before === 'violated' || m.before === 'violated?') && m.after !== 'held') || m.after === 'violated?' || !!m.ambiguous);
}

function verdictMove(b: Side, a: Side, slots: SlotMove[]): Classified {
  const v0 = b.verdict;
  const v1 = a.verdict;
  if (v0 === 'violated?' || v1 === 'violated?') return { transition: 'unstable', label: 'not comparable', why: 'a violated record on one side does not count (harness-suspect validity): re-run before claiming a change' };
  if (v0 === v1) {
    // why: review p07a: a cell whose self-attested answer flipped (deciding or beside a tested record) is not unchanged.
    const answers = (s: Side) => [...new Set((s.recs ?? []).filter((r) => r.verdict === 'self-attested').map((r) => canonical(r.numbers?.['answer'] ?? null)))].sort().join(', ');
    const x = answers(b);
    const y = answers(a);
    if (x && y && x !== y) return { transition: 'changed', label: 'changed', why: `${v0} on both builds, but a self-attested answer changed (${x} → ${y}); an answer, not a test` };
  }
  if (v0 === v1) {
    const t: Transition = v0 === 'violated' ? 'still-violated' : v0 === 'held' ? 'held-both' : v0 === 'platform' ? 'platform-both' : 'same';
    return { transition: t, label: 'unchanged', why: `${v0} on both builds` };
  }
  if (UNTESTED.includes(v0) || UNTESTED.includes(v1)) return { transition: 'coverage-change', label: 'not comparable', why: UNTESTED.includes(v1) ? `no longer tested: ${a.reason}` : `newly tested (before: ${b.reason})` };
  if (v0 === 'violated' && v1 === 'held') {
    // why: review: fixed only where every slot violated before is held after, on an equal hash.
    const open = openSlots(slots);
    if (open.length) return { transition: 'partly-held', label: 'changed', why: `the cell is held after, but ${open.map((m) => (m.ambiguous ? `${m.slot}: ${m.ambiguous}` : `${m.slot} went violated → ${m.after}`)).join(', ')}; not a fix` };
    return { transition: 'fixed', label: 'fixed', why: 'violated on the before build; every slot that was violated held on the after build, same tests' };
  }
  if ((v0 === 'held' || v0 === 'not observed') && v1 === 'violated') return { transition: 'regressed', label: 'regressed', why: `${v0} on the before build; the same test is violated on the after build` };
  if (v1 === 'platform') return { transition: '→platform', label: 'changed', why: `${v0} → platform: the backend shows the same behaviour on the after build; not a fix` };
  if (v0 === 'platform') return { transition: 'platform→', label: 'changed', why: `platform → ${v1}: the backend showed the behaviour on the before build; not a fix` };
  if (v0 === 'violated' && v1 === 'not observed') return { transition: 'not-seen-after', label: 'changed', why: 'violated → not observed: not seen after (a search, not proof); not a fix' };
  return { transition: 'changed', label: 'changed', why: `${v0} → ${v1}` };
}

const LABEL_ORDER: Label[] = ['regressed', 'fixed', 'schema-fixed', 'changed', 'not comparable', 'unchanged'];

export function summarize(doc: Record<string, unknown>, file: string, bytes: Buffer | string, sig: VerifyOutcome): RunSummary {
  const run = isObj(doc['run']) ? doc['run'] : {};
  const id = isObj(doc['identity']) ? doc['identity'] : null;
  const suite = isObj(doc['suite']) ? { name: String(doc['suite']['name']), version: String(doc['suite']['version']) } : null;
  const spec = isObj(doc['spec']) ? String(doc['spec']['version']) : null;
  const tester = id && isObj(id['tester']) ? id['tester'] : null;
  return {
    file,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    run_id: typeof run['id'] === 'string' ? run['id'] : null,
    status: typeof run['status'] === 'string' ? run['status'] : null,
    stopped_reason: typeof run['stopped_reason'] === 'string' ? run['stopped_reason'] : null,
    suite,
    tester_commit: tester && typeof tester['commit'] === 'string' ? tester['commit'] : null,
    spec,
    manifest_sha256: isObj(doc['manifest']) ? String(doc['manifest']['sha256']) : null,
    plan_hash: isObj(doc['plan']) ? String(doc['plan']['hash']) : null,
    tools_fingerprint: id && typeof id['tools_fingerprint'] === 'string' ? id['tools_fingerprint'] : null,
    server: id && isObj(id['server']) ? id['server'] : null,
    backend: id && Array.isArray(id['backend']) ? id['backend'] : null,
    identity_gaps: id && Array.isArray(id['gaps']) ? (id['gaps'] as string[]) : null,
    signature: { status: sig.status, key_id: sig.key_id, detail: sig.detail },
    started: typeof run['started'] === 'string' ? run['started'] : null,
    tester_dirty: tester && typeof tester['dirty'] === 'boolean' ? tester['dirty'] : null,
    rechecked_by: id && isObj(id['rechecked_by']) ? { version: typeof id['rechecked_by']['version'] === 'string' ? id['rechecked_by']['version'] : null, commit: typeof id['rechecked_by']['commit'] === 'string' ? id['rechecked_by']['commit'] : null } : null,
    judged_by: [...new Set(recsOf(doc).map((r) => (r.test_inputs ? testerName(r.test_inputs.tester) : null)).filter((x): x is string => !!x))].sort(),
  };
}

/**
 * Compare two parsed results documents. Refused (CompareRefused) where the two cannot be compared at all: not mws-results/1,
 * different MWS versions, different test-hash algorithms, or a file whose records carry no test_hash.
 */
export function compareDocs(b: Record<string, unknown>, a: Record<string, unknown>, before: RunSummary, after: RunSummary): CompareDoc {
  for (const [d, n] of [[b, 'before'], [a, 'after']] as const) {
    if (d['format'] !== 'mws-results/1') throw new CompareRefused(`${n}: not an mws-results/1 document (format ${JSON.stringify(d['format'])})`);
    if (!recsOf(d).some((r) => typeof r.test_hash === 'string')) throw new CompareRefused(`${n}: its records carry no test_hash (written before ${TEST_HASH_FORMAT}); run it again with this release`);
    const id = isObj(d['identity']) ? d['identity'] : null;
    if (id && !(TEST_HASH_FORMATS_READ as readonly unknown[]).includes(id['test_hash'])) throw new CompareRefused(`${n}: test hashes made by ${String(id['test_hash'])}; this release reads ${TEST_HASH_FORMATS_READ.join(' and ')}`);
  }
  if (before.spec !== after.spec) throw new CompareRefused(`the two runs test different MWS versions (before ${before.spec}, after ${after.spec}): a change of requirements is not a change of the server`);
  const warnings: string[] = [];
  const tb = docTesterKey(b);
  const ta = docTesterKey(a);
  const same = {
    manifest: before.manifest_sha256 !== null && before.manifest_sha256 === after.manifest_sha256,
    plan: before.plan_hash !== null && before.plan_hash === after.plan_hash,
    tools: before.tools_fingerprint !== null && before.tools_fingerprint === after.tools_fingerprint,
    // why: review S3: two files that state no tester build, or a dirty one, are not "the same tester build" (null === null is not).
    tester: tb !== null && tb === ta,
  };
  // why: review F5: a rechecked copy vouches for no more than the original did.
  for (const [n, d] of [['before', b], ['after', a]] as const) {
    const id = isObj(d['identity']) ? d['identity'] : null;
    const rb = id && isObj(id['rechecked_by']) ? id['rechecked_by'] : null;
    if (!rb) continue;
    const os = isObj(rb['original_signature']) ? rb['original_signature'] : null;
    if (!os) warnings.push(`${n}: a rechecked copy that does not say how the original was signed: its signature (if any) vouches only for the recheck`);
    else if (os['status'] !== 'valid' || os['pinned'] !== true) warnings.push(`${n}: a rechecked copy of an original that was not signed by a pinned key (${String(os['status'])}${os['allow_unsigned'] ? ', signed with --allow-unsigned' : ''}): its signature vouches only for the recheck`);
  }
  if (!same.tester) warnings.push(`the two files do not state one clean, stamped tester build (before ${testerName(isObj(b['identity']) ? (b['identity']['tester'] as never) : null)}${before.rechecked_by ? `, rechecked by ${before.rechecked_by.version ?? '?'} @ ${before.rechecked_by.commit ?? 'unstamped'}` : ''}; after ${testerName(isObj(a['identity']) ? (a['identity']['tester'] as never) : null)}${after.rechecked_by ? `, rechecked by ${after.rechecked_by.version ?? '?'} @ ${after.rechecked_by.commit ?? 'unstamped'}` : ''}): records are joined only where the tester build that judged them is stated on the record and the same`);
  if ((before.judged_by?.length ?? 0) > 1 || (after.judged_by?.length ?? 0) > 1) warnings.push(`records of one file were judged by more than one tester build (before: ${before.judged_by?.join(', ') || 'none stated'}; after: ${after.judged_by?.join(', ') || 'none stated'}); only records judged by one build on both sides are compared`);
  if (!same.manifest) warnings.push('the manifests differ (manifest sha256): cells are joined only where their test hashes are equal or rule A says the test is the same');
  // why: review S5: what a reader would get wrong without a word: swapped files, one file twice, one server build twice.
  if (before.sha256 === after.sha256) warnings.push('the same file is given as before and after: no build changed');
  else if (before.run_id && before.run_id === after.run_id) warnings.push(`both files come from the same run (${before.run_id}): no build changed`);
  if (before.started && after.started && after.started < before.started) warnings.push(`the after run started (${after.started}) before the before run (${before.started}): check that the files are not swapped (a swap reads every regression as a fix)`);
  const sc = (x: RunSummary) => (typeof x.server?.['commit'] === 'string' ? (x.server['commit'] as string) : null);
  if (sc(before) && sc(before) === sc(after)) warnings.push(`both runs state the same build of the server (commit ${sc(before)}): a move between them is not a change of the build (a flaky check, or a changed test environment)`);
  for (const [s, n] of [[before, 'before'], [after, 'after']] as const) {
    if (s.status !== 'complete') warnings.push(`${n}: the run is ${s.status ?? 'of unknown status'}${s.stopped_reason ? ` (${s.stopped_reason})` : ''}`);
    if (s.signature.status !== 'valid') warnings.push(`${n}: signature ${s.signature.status}: ${s.signature.detail}${s.signature.accepted === 'allow-unsigned' ? ' (accepted with --allow-unsigned)' : ''}`);
    if (s.identity_gaps === null) warnings.push(`${n}: no run identity (results.identity): the server build is not stated`);
    else for (const g of s.identity_gaps) warnings.push(`${n}: identity gap: ${g}`);
  }
  const sb = sides(b);
  const sa = sides(a);
  const keys = [...new Set([...sb.keys(), ...sa.keys()])].sort();
  const cells: CellCompare[] = keys.map((key) => {
    const x = sb.get(key);
    const y = sa.get(key);
    const requirement = (x ?? y)!.requirement;
    const tool = (x ?? y)!.tool;
    if (!x) return { key, requirement, tool, before: null, after: y!.side, transition: 'new-cell', label: 'not comparable', why: 'records for this cell only on the after build (a tool or requirement added, or the before run did not reach it)' };
    if (!y) return { key, requirement, tool, before: x.side, after: null, transition: 'removed-cell', label: 'not comparable', why: 'records for this cell only on the before build (a tool or requirement removed, or the after run did not reach it)' };
    return { key, requirement, tool, before: x.side, after: y.side, ...classify(x.side, y.side) };
  });
  for (const c of cells) {
    // why: review S5: a violation the after build shows in a cell the before build did not test is said, not left in the list.
    if (c.after?.verdict === 'violated' && (!c.before || UNTESTED.includes(c.before.verdict))) {
      c.newly_found = true;
      warnings.push(`${c.key}: violated on the after build in a cell the before build did not test (${c.before ? c.before.verdict : 'no cell'}); newly found, not a regression`);
    }
    if (c.before) delete c.before.recs;
    if (c.after) delete c.after.recs;
    // why: review: a slot that regressed inside a cell whose roll-up did not move is said, never hidden by the roll-up.
    for (const r of c.slot_regressions ?? []) warnings.push(`${c.key}: slot regressed inside a cell labelled ${c.label}: ${r}`);
    if (c.transition === 'tester-unpinned' && c.before?.verdict === 'violated' && c.after?.verdict === 'held') warnings.push(`${c.key}: violated → held, not claimed as fixed: ${c.why.replace(/^.*not claimed: /, '')}`);
    if (c.transition === 'tester-unpinned' && c.after?.verdict === 'violated' && c.before && c.before.verdict !== 'violated') warnings.push(`${c.key}: ${c.before.verdict} → violated, not claimed as regressed: ${c.why.replace(/^.*not claimed: /, '')}`);
    if (/slot regressions not claimed/.test(c.why)) warnings.push(`${c.key}: ${c.why.replace(/^.*slot regressions not claimed /, 'slot regressions not claimed ')}`);
    if (c.transition === 'hash-mismatch') warnings.push(`${c.key}: ${c.why}`);
  }
  cells.sort((p, q) => LABEL_ORDER.indexOf(p.label) - LABEL_ORDER.indexOf(q.label) || (p.key < q.key ? -1 : p.key > q.key ? 1 : 0));
  return { format: COMPARE_FORMAT, tool: { name: SUITE_NAME, version: SUITE_VERSION }, rating: null, spec: { version: before.spec ?? '' }, test_hash: TEST_HASH_FORMAT, before, after, same, warnings, cells };
}

const HEAD: Record<Label, string> = {
  regressed: 'Regressed (held or not observed before, violated after, same test)',
  fixed: 'Fixed (violated before, held after, same test)',
  'schema-fixed': 'Schema fixed (the requirement judges the schema; the schema changed and the violation is gone; check the new schema)',
  changed: 'Changed, no claim (another move between tested verdicts; never a fix)',
  'not comparable': 'Not comparable (no transition is claimed)',
  unchanged: 'Unchanged (the same verdict on both builds)',
};

const short = (h: string | null | undefined) => (h ? h.replace(/^sha256:/, '').slice(0, 12) : 'none');

export function renderCompareMarkdown(c: CompareDoc): string {
  const L: string[] = [];
  const build = (s: RunSummary) => {
    const sv = s.server ?? {};
    const parts = [sv['repo'], sv['tag'], sv['commit'] ? `@ ${String(sv['commit'])}` : null, sv['image']].filter(Boolean).join(' ');
    const sig = `signature ${s.signature.status}${s.signature.key_id ? ` ${s.signature.key_id}` : ''}${s.signature.accepted === 'allow-unsigned' ? ', NOT PINNED: accepted with --allow-unsigned' : ''}`;
    const judged = `; tester ${s.suite?.version ?? '?'} @ ${s.tester_commit ?? 'unstamped'}${s.tester_dirty ? ' (dirty)' : ''}${s.rechecked_by ? `, rechecked by ${s.rechecked_by.version ?? '?'} @ ${s.rechecked_by.commit ?? 'unstamped'}` : ''}${s.judged_by?.length ? `; records judged by ${s.judged_by.join(', ')}` : ''}`;
    return `${parts || 'build not stated'} (run ${s.run_id ?? '?'}, ${s.status ?? '?'}; results.json sha256 ${s.sha256.slice(0, 16)}…; ${sig}${judged})`;
  };
  L.push(`# Before/after: ${c.before.suite?.name ?? 'mcp-writecheck'} ${c.before.suite?.version ?? '?'}, MWS ${c.spec.version}`);
  L.push('');
  L.push(`- Before: ${build(c.before)}`);
  L.push(`- After: ${build(c.after)}`);
  L.push(`- Same manifest: ${c.same.manifest ? 'yes' : 'no'}; same plan: ${c.same.plan ? 'yes' : 'no'}; same tool list: ${c.same.tools ? 'yes' : 'no'}; same tester build: ${c.same.tester ? 'yes' : 'no'}.`);
  L.push(`- Records are joined slot by slot and case by case where their test hashes (${c.test_hash}) are equal, or where rule A finds the same call accepted by both builds (an added optional argument or nested property, a required argument relaxed to optional); each such difference is listed under the cell. Verdicts per cell are rolled up by MWS section 8.2 rule 13. Cells are listed, not counted. No rating.`);
  if (c.warnings.length) {
    L.push('');
    L.push('## Warnings');
    L.push('');
    for (const w of c.warnings) L.push(`- ${w}`);
  }
  const fmt = (s: Side | null) => (s ? `${s.verdict}${s.level ? ` (${s.level})` : ''}` : '(no cell)');
  for (const label of LABEL_ORDER) {
    const rows = c.cells.filter((x) => x.label === label);
    L.push('');
    L.push(`## ${HEAD[label]}`);
    L.push('');
    if (!rows.length) {
      L.push('None.');
      continue;
    }
    L.push('| Cell | Before | After | Transition | Why | Test hash |');
    L.push('|---|---|---|---|---|---|');
    for (const r of rows) L.push(`| \`${r.key}\` | ${fmt(r.before)} | ${fmt(r.after)} | ${r.transition} | ${(r.why + (r.slot_regressions?.length ? `. Slot regressed: ${r.slot_regressions.join(', ')}` : '') + (r.newly_found ? '. Newly found: violated after, not tested before' : '') + (r.same_test_because?.length ? `. Same test by rule A, tolerated: ${r.same_test_because.join('; ')}` : '')).replace(/\|/g, '\\|').replace(/\n/g, ' ')} | ${short(r.before?.test_hash)}${r.before?.test_hash !== r.after?.test_hash ? ` / ${short(r.after?.test_hash)}` : ''} |`);
  }
  return L.join('\n') + '\n';
}
