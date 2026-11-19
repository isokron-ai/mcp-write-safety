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
 * Two cells are joined only on equal test hashes (report/testhash.ts). A record's slot is its requirement, resource, tool and
 * procedure id. Where a slot is on both sides, its test hashes must be equal (otherwise `test-changed`: the procedure version,
 * a tool entry, the resource block, the declaration, a limit or the tester differs). Where a slot is on one side only (the
 * check did not reach it on the other build: a failed set-up, a stop), the cell is still joined when that record is `not
 * tested` or `not applicable`, and is `coverage-change` when it carries a tested verdict, since the other build has no evidence
 * for it. A cell with a record that carries no test_hash is `no-test-hash`. In each case no transition is claimed. `test_hash`
 * on a side is sha256 over the cell's sorted distinct record hashes, for display; the join is per slot.
 *
 * Labels: `fixed` (violated → held, nothing else), `regressed` (held or not observed → violated), `unchanged` (the same
 * verdict), `changed` (another move between two tested verdicts: violated → not observed, anything to or from platform, held
 * → not observed …; never a fix), and `not comparable` (test changed, coverage changed (to or from not tested or not
 * applicable), a cell on one side only, an unstable `violated?`, or a roll-up mismatch). The finer `transition` class follows
 * the before/after design (§1.5). There is no total: cells are listed, never counted.
 */

import { createHash } from 'node:crypto';

import { isObj, sha256 } from '../core/util.js';
import { TEST_HASH_FORMAT } from '../core/identity.js';
import { subjectFacets, type Facet } from './testhash.js';
import { SUITE_NAME, SUITE_VERSION } from '../version.js';
import type { VerifyOutcome } from './sign.js';

export const COMPARE_FORMAT = 'mws-compare/1';

/** A cell's state on one side: the seven verdicts, plus `violated?` for a violated record that does not count. */
export type CellState = 'violated' | 'platform' | 'held' | 'violated?' | 'not observed' | 'self-attested' | 'not tested' | 'not applicable';
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
  | 'schema-fixed';

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
  validity?: { counts?: boolean; class?: string };
  attribution?: string | null;
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
  signature: { status: string; key_id: string | null; detail: string };
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
  recsOf(doc).forEach((r, i) => {
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
    const { verdict, deciding } = rollUp(g.recs);
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

const UNTESTED: CellState[] = ['not tested', 'not applicable'];

/** The run's own cell and this roll-up disagree on a tested verdict. */
function mismatch(s: Side): string | null {
  if (!s.run_cell) return null;
  const mine = s.verdict === 'violated?' ? 'violated' : s.verdict;
  if (UNTESTED.includes(mine) && UNTESTED.includes(s.run_cell as CellState)) return null;
  return mine === s.run_cell ? null : `the run's own cell says ${s.run_cell}, the rule-13 roll-up of its records says ${s.verdict}`;
}

const slotOf = (r: Rec) => `${r.requirement}|${r.write_path.resource}|${r.write_path.tool}|${r.scenario.id}`;
const slotName = (r: Rec) => `${r.write_path.resource}/${r.scenario.id} v${r.scenario.version}`;

export interface SlotMove {
  slot: string;
  before: CellState;
  after: CellState;
}

export interface Join {
  /** Why the cell is not compared, or null when every slot is the same test. */
  problem: { transition: Transition; why: string; facets?: Facet[] } | null;
  /** Every slot on both sides with equal hashes, with its rolled-up verdict on each side. */
  slots: SlotMove[];
  /** Slots on both sides whose hashes differ only in the judged part of the tool entry (equal test_hash_core). */
  subjectSlots: SlotMove[];
}

const isRegression = (m: SlotMove) => (m.before === 'held' || m.before === 'not observed') && m.after === 'violated';

/** Whether two cells' records are the same tests, slot by slot (see the header). */
export function joinCell(b: Rec[], a: Rec[]): Join {
  const noHash = [...b.map((r) => ['before', r] as const), ...a.map((r) => ['after', r] as const)].find(([, r]) => typeof r.test_hash !== 'string');
  if (noHash) return { problem: { transition: 'no-test-hash', why: `${noHash[0]}: the record ${slotName(noHash[1])} carries no test_hash` }, slots: [], subjectSlots: [] };
  const group = (rs: Rec[]) => {
    const m = new Map<string, Rec[]>();
    for (const r of rs) m.set(slotOf(r), [...(m.get(slotOf(r)) ?? []), r]);
    return m;
  };
  const sb = group(b);
  const sa = group(a);
  const set = (rs: Rec[], k: 'test_hash' | 'test_hash_core') => [...new Set(rs.map((r) => r[k] ?? ''))].sort().join('\n');
  const changed: string[] = [];
  const subject: string[] = [];
  const subjectSlots: SlotMove[] = [];
  const facets = new Set<Facet>();
  const slots: SlotMove[] = [];
  const coverage: string[] = [];
  for (const [k, x] of sb) {
    const y = sa.get(k);
    if (!y) continue;
    const name = slotName(x[0]!).replace(/ v.*$/, '');
    if (set(x, 'test_hash') !== set(y, 'test_hash')) {
      const cores = [...x, ...y].every((r) => typeof r.test_hash_core === 'string');
      if (cores && set(x, 'test_hash_core') === set(y, 'test_hash_core')) {
        for (const f of subjectFacets(x[0]!.requirement)) facets.add(f);
        subject.push(name);
        subjectSlots.push({ slot: name, before: rollUp(x).verdict, after: rollUp(y).verdict });
        continue;
      }
      const vb = [...new Set(x.map((r) => r.scenario.version))].join('/');
      const va = [...new Set(y.map((r) => r.scenario.version))].join('/');
      changed.push(`${name}${vb !== va ? ` (procedure v${vb} → v${va})` : ' (a used argument, the resource block, the declaration, a limit or the tester differs)'}`);
      continue;
    }
    const m = { slot: name, before: rollUp(x).verdict, after: rollUp(y).verdict };
    // why: review: a slot tested on one build and not on the other has no evidence to compare on the other.
    if (UNTESTED.includes(m.before) !== UNTESTED.includes(m.after)) coverage.push(`${name} ${m.before} → ${m.after}`);
    slots.push(m);
  }
  if (changed.length) return { problem: { transition: 'test-changed', why: `the test changed: ${changed.join('; ')}` }, slots, subjectSlots };
  const oneSided = (m: Map<string, Rec[]>, other: Map<string, Rec[]>) => [...m].filter(([k]) => !other.has(k)).flatMap(([, rs]) => rs).filter((r) => !UNTESTED.includes(stateOf(r)));
  const onlyB = oneSided(sb, sa);
  const onlyA = oneSided(sa, sb);
  const say = (rs: Rec[]) => rs.map((r) => `${slotName(r)} ${r.verdict}`).join(', ');
  if (onlyB.length || onlyA.length || coverage.length) {
    const parts = [onlyB.length ? `before only: ${say(onlyB)}` : '', onlyA.length ? `after only: ${say(onlyA)}` : '', coverage.length ? `tested on one build only: ${coverage.join(', ')}` : ''].filter(Boolean);
    return { problem: { transition: 'coverage-change', why: `evidence on one build only (${parts.join('; ')})` }, slots, subjectSlots };
  }
  if (subject.length) return { problem: { transition: 'subject-changed', why: `the tool's ${[...facets].join(' and ')} changed, which is what this requirement judges (${subject.join(', ')})`, facets: [...facets] }, slots, subjectSlots };
  return { problem: null, slots, subjectSlots };
}

type Classified = { transition: Transition; label: Label; why: string; slot_moves?: SlotMove[]; slot_regressions?: string[]; facets?: Facet[] };

export function classify(b: Side, a: Side): Classified {
  const mb = mismatch(b);
  const ma = mismatch(a);
  if (mb || ma) return { transition: 'rollup-mismatch', label: 'not comparable', why: [mb && `before: ${mb}`, ma && `after: ${ma}`].filter(Boolean).join('; ') };
  let slots: SlotMove[] = [];
  // why: re-review 1: the slot moves (and regressions) on equal hashes are reported whatever else makes the cell not comparable.
  const withSlots = (c: Classified): Classified => {
    const moved = slots.filter((m) => m.before !== m.after);
    const regs = moved.filter(isRegression).map((m) => `${m.slot} ${m.before} → violated`);
    return { ...c, ...(moved.length ? { slot_moves: moved } : {}), ...(regs.length && c.label !== 'regressed' ? { slot_regressions: regs } : {}) };
  };
  if (b.recs && a.recs) {
    const j = joinCell(b.recs, a.recs);
    slots = j.slots;
    if (j.problem?.transition === 'subject-changed') {
      // why: re-review 2: schema-fixed needs every slot violated before (judged-part slots and the others) held after.
      const open = openSlots([...slots, ...j.subjectSlots]);
      if (j.problem.facets?.includes('schema') && b.verdict === 'violated' && a.verdict === 'held' && !open.length)
        return withSlots({ transition: 'schema-fixed', label: 'schema-fixed', why: `${j.problem.why}: every slot violated before is held after. compare cannot read the schemas: check that the after build's schema now declares the constraint the before run found` });
      // why: the cell says which judged part changed (facets), so a reader need not parse `why`; the schema allows it on this transition only.
      return withSlots({ transition: 'subject-changed', why: j.problem.why, facets: j.problem.facets ?? [], label: 'not comparable', ...(open.length && b.verdict === 'violated' ? { why: `${j.problem.why}; not schema-fixed: ${open.map((m) => `${m.slot} ${m.before} → ${m.after}`).join(', ')}` } : {}) });
    }
    if (j.problem) return withSlots({ transition: j.problem.transition, why: j.problem.why, label: 'not comparable' });
  } else {
    if (!b.test_hash || !a.test_hash) return { transition: 'no-test-hash', label: 'not comparable', why: `${!b.test_hash ? 'before' : 'after'}: a record of this cell carries no test_hash` };
    if (b.test_hash !== a.test_hash) return { transition: 'test-changed', label: 'not comparable', why: 'the test changed: the test hashes differ' };
  }
  return withSlots(verdictMove(b, a, slots));
}

/** Slots that keep a fix from being claimed: violated (or violated?) before and not held after, or violated? after. */
function openSlots(slots: SlotMove[]): SlotMove[] {
  return slots.filter((m) => ((m.before === 'violated' || m.before === 'violated?') && m.after !== 'held') || m.after === 'violated?');
}

function verdictMove(b: Side, a: Side, slots: SlotMove[]): Classified {
  const v0 = b.verdict;
  const v1 = a.verdict;
  if (v0 === 'violated?' || v1 === 'violated?') return { transition: 'unstable', label: 'not comparable', why: 'a violated record on one side does not count (harness-suspect validity): re-run before claiming a change' };
  if (v0 === v1) {
    const t: Transition = v0 === 'violated' ? 'still-violated' : v0 === 'held' ? 'held-both' : v0 === 'platform' ? 'platform-both' : 'same';
    return { transition: t, label: 'unchanged', why: `${v0} on both builds` };
  }
  if (UNTESTED.includes(v0) || UNTESTED.includes(v1)) return { transition: 'coverage-change', label: 'not comparable', why: UNTESTED.includes(v1) ? `no longer tested: ${a.reason}` : `newly tested (before: ${b.reason})` };
  if (v0 === 'violated' && v1 === 'held') {
    // why: review: fixed only where every slot violated before is held after, on an equal hash.
    const open = openSlots(slots);
    if (open.length) return { transition: 'partly-held', label: 'changed', why: `the cell is held after, but ${open.map((m) => `${m.slot} went violated → ${m.after}`).join(', ')}; not a fix` };
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
    if (id && id['test_hash'] !== TEST_HASH_FORMAT) throw new CompareRefused(`${n}: test hashes made by ${String(id['test_hash'])}; this release compares ${TEST_HASH_FORMAT} only`);
  }
  if (before.spec !== after.spec) throw new CompareRefused(`the two runs test different MWS versions (before ${before.spec}, after ${after.spec}): a change of requirements is not a change of the server`);
  const warnings: string[] = [];
  const same = {
    manifest: before.manifest_sha256 !== null && before.manifest_sha256 === after.manifest_sha256,
    plan: before.plan_hash !== null && before.plan_hash === after.plan_hash,
    tools: before.tools_fingerprint !== null && before.tools_fingerprint === after.tools_fingerprint,
    tester: !!before.suite && !!after.suite && before.suite.version === after.suite.version && before.tester_commit === after.tester_commit,
  };
  if (!same.tester) warnings.push(`the two runs were made by different tester builds (before ${before.suite?.version ?? '?'} @ ${before.tester_commit ?? 'unstamped'}, after ${after.suite?.version ?? '?'} @ ${after.tester_commit ?? 'unstamped'}): every cell's test hash differs, so no transition is claimed`);
  if (!same.manifest) warnings.push('the manifests differ (manifest sha256): cells are joined only where their test hashes are equal');
  for (const [s, n] of [[before, 'before'], [after, 'after']] as const) {
    if (s.status !== 'complete') warnings.push(`${n}: the run is ${s.status ?? 'of unknown status'}${s.stopped_reason ? ` (${s.stopped_reason})` : ''}`);
    if (s.signature.status !== 'valid') warnings.push(`${n}: signature ${s.signature.status}: ${s.signature.detail}`);
    if (s.identity_gaps === null) warnings.push(`${n}: no run identity (results.identity): the server build is not stated`);
    else for (const g of s.identity_gaps) warnings.push(`${n}: identity gap: ${g}`);
    if (!s.tester_commit) warnings.push(`${n}: the tester build is not stamped with a commit, so two different builds of version ${s.suite?.version ?? '?'} would hash alike`);
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
    if (c.before) delete c.before.recs;
    if (c.after) delete c.after.recs;
    // why: review: a slot that regressed inside a cell whose roll-up did not move is said, never hidden by the roll-up.
    for (const r of c.slot_regressions ?? []) warnings.push(`${c.key}: slot regressed inside a cell labelled ${c.label}: ${r}`);
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
    return `${parts || 'build not stated'} (run ${s.run_id ?? '?'}, ${s.status ?? '?'}; results.json sha256 ${s.sha256.slice(0, 16)}…; signature ${s.signature.status}${s.signature.key_id ? ` ${s.signature.key_id}` : ''})`;
  };
  L.push(`# Before/after: ${c.before.suite?.name ?? 'mcp-writecheck'} ${c.before.suite?.version ?? '?'}, MWS ${c.spec.version}`);
  L.push('');
  L.push(`- Before: ${build(c.before)}`);
  L.push(`- After: ${build(c.after)}`);
  L.push(`- Same manifest: ${c.same.manifest ? 'yes' : 'no'}; same plan: ${c.same.plan ? 'yes' : 'no'}; same tool list: ${c.same.tools ? 'yes' : 'no'}; same tester build: ${c.same.tester ? 'yes' : 'no'}.`);
  L.push(`- Cells are joined only where their test hashes (${c.test_hash}) are equal. Verdicts per cell are rolled up by MWS section 8.2 rule 13. Cells are listed, not counted. No rating.`);
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
    for (const r of rows) L.push(`| \`${r.key}\` | ${fmt(r.before)} | ${fmt(r.after)} | ${r.transition} | ${(r.why + (r.slot_regressions?.length ? `. Slot regressed: ${r.slot_regressions.join(', ')}` : '')).replace(/\|/g, '\\|').replace(/\n/g, ' ')} | ${short(r.before?.test_hash)}${r.before?.test_hash !== r.after?.test_hash ? ` / ${short(r.after?.test_hash)}` : ''} |`);
  }
  return L.join('\n') + '\n';
}
