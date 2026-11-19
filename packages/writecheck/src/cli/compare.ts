/**
 * The `compare` and `verify-results` commands, and the run identity flags of `run` and `rerun`.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { KeyObject } from 'node:crypto';

import type { Tool } from '../checks/types.js';
import { buildStamp, TEST_HASH_FORMAT } from '../core/identity.js';
import { parseManifestText } from '../core/manifest.js';
import { renderMarkdown } from '../report/markdown.js';
import type { ResultsDoc } from '../report/results.js';
import { signResults } from '../report/sign.js';
import { applyInputs, hashExtras, stampTestHashes, type TestInputs } from '../report/testhash.js';
import type { Result } from '../report/verdicts.js';
import { reviewOf } from './run.js';
import { SUITE_NAME, SUITE_VERSION } from '../version.js';
import { readCatalogFile } from './commands.js';

import type { ProvenanceFlags } from '../core/identity.js';
import { WritecheckError } from '../core/util.js';
import { compareDocs, CompareRefused, renderCompareMarkdown, summarize, type CompareDoc } from '../report/compare.js';
import { parseResultsBytes, publicKeyFrom, verifyResults, type VerifyOutcome } from '../report/sign.js';

/** Flags `run` and `rerun` take for the run identity and the results signature (main.ts adds them to both commands). */
export const IDENTITY_FLAGS = ['--provenance', '--server-repo', '--server-commit', '--server-tag', '--server-image', '--backend-image', '--sign-key'];

export const IDENTITY_USAGE = `    Run identity (results.identity; MANIFEST.md, Run identity): --server-repo URL --server-commit SHA
    [--server-tag TAG] [--server-image REF@sha256:…] [--backend-image name=REF@sha256:…]... or --provenance FILE
    (the same keys as target.provenance). --sign-key FILE (or MWSC_SIGN_KEY): sign results.json with an Ed25519 key.`;

export interface IdentityOptions {
  provenance?: ProvenanceFlags;
  signKey?: string;
}

/** The identity options from parsed flags (`last` gives a flag's last value, `all` every value). */
export function identityOptions(last: (n: string) => string | undefined, all: (n: string) => string[]): IdentityOptions {
  const p: ProvenanceFlags = {};
  const set = <K extends keyof ProvenanceFlags>(k: K, v: ProvenanceFlags[K] | undefined) => {
    if (v !== undefined) p[k] = v;
  };
  set('provenanceFile', last('--provenance'));
  set('serverRepo', last('--server-repo'));
  set('serverCommit', last('--server-commit'));
  set('serverTag', last('--server-tag'));
  set('serverImage', last('--server-image'));
  const b = all('--backend-image');
  if (b.length) p.backendImages = b;
  const signKey = last('--sign-key');
  return { ...(Object.keys(p).length ? { provenance: p } : {}), ...(signKey ? { signKey } : {}) };
}

/** A results.json path, or a run folder holding one. */
function resultsFile(p: string): string {
  if (!existsSync(p)) throw new WritecheckError(`${p} does not exist`, 2);
  const f = statSync(p).isDirectory() ? join(p, 'results.json') : p;
  if (!existsSync(f)) throw new WritecheckError(`${p}: no results.json`, 2);
  return f;
}

function readDoc(f: string): { bytes: Buffer; doc: Record<string, unknown> } {
  const bytes = readFileSync(f);
  const doc = parseResultsBytes(bytes, f);
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) throw new WritecheckError(`${f}: not a results document`, 2);
  return { bytes, doc: doc as Record<string, unknown> };
}

/**
 * `verify-results <file> [--pubkey KEY]`. Exit 0: signed by the pinned key and unchanged. 1: unsigned, ssh-only, or valid
 * but not pinned (no --pubkey). 3: the signature does not verify, the content changed, or another key signed.
 */
export function verifyResultsCommand(o: { file: string; pubkey?: string; log: (s: string) => void }): { exit: number; outcome: VerifyOutcome } {
  const f = resultsFile(o.file);
  const { doc } = readDoc(f);
  const pinned = o.pubkey ? publicKeyFrom(o.pubkey) : null;
  const outcome = verifyResults(doc, pinned);
  o.log(`${f}: ${outcome.status}: ${outcome.detail}`);
  const exit = outcome.status === 'valid' ? 0 : outcome.status === 'invalid' ? 3 : 1;
  return { exit, outcome };
}

/**
 * `compare <before> <after> [--out DIR] [--pubkey KEY] [--allow-unsigned] [--fail-on-slot-regression true|false]
 * [--fail-on-new-violation true|false]`: writes compare.json and compare.md. A file whose signature does not verify is refused
 * (exit 3), with or without --pubkey. With --pubkey both files must be signed by that key (exit 3 otherwise); without it, a file
 * that is unsigned, or signed by a key nobody pinned, is compared only with --allow-unsigned (exit 2 otherwise), and the output
 * says so. Exit 1 when a cell regressed, or (unless --fail-on-slot-regression false) a slot regressed inside a cell whose
 * roll-up did not, or (with --fail-on-new-violation true) a cell the before build did not test is violated after; else 0;
 * 2 when the two cannot be compared.
 */
export function compareCommand(o: { before: string; after: string; out: string; pubkey?: string; allowUnsigned?: boolean; failOnSlotRegression?: boolean; failOnNewViolation?: boolean; log: (s: string) => void }): { exit: number; doc: CompareDoc } {
  const pinned = o.pubkey ? publicKeyFrom(o.pubkey) : null;
  const read = (p: string, n: string) => {
    const f = resultsFile(p);
    const { bytes, doc } = readDoc(f);
    return { f, n, bytes, doc, sig: verifyResults(doc, pinned) };
  };
  const files = [read(o.before, 'before'), read(o.after, 'after')];
  // why: review M5: a changed file is refused as verify-results refuses it, whether or not a key was pinned (checked on both
  // files before anything else, so the refusal names the changed file).
  for (const x of files) if (x.sig.status === 'invalid') throw new WritecheckError(`${x.n} ${x.f}: the results signature does not verify (${x.sig.detail}); compare refuses a changed file`, 3);
  for (const x of files) {
    if (pinned && x.sig.status !== 'valid') throw new WritecheckError(`${x.n} ${x.f}: ${x.sig.status}: ${x.sig.detail}`, 3);
    if (!pinned && !o.allowUnsigned) throw new WritecheckError(`${x.n} ${x.f}: ${x.sig.status === 'valid-unpinned' ? 'signed by a key that is not pinned' : `not signed (${x.sig.status})`}; give --pubkey KEY to check who signed, or --allow-unsigned to compare it anyway (the output then says the input is not pinned)`, 2);
  }
  const [b, a] = files.map((x) => {
    const sum = summarize(x.doc, x.f, x.bytes, x.sig);
    sum.signature.accepted = pinned ? 'pinned' : 'allow-unsigned';
    return { doc: x.doc, sum };
  }) as [{ doc: Record<string, unknown>; sum: ReturnType<typeof summarize> }, { doc: Record<string, unknown>; sum: ReturnType<typeof summarize> }];
  let doc: CompareDoc;
  try {
    doc = compareDocs(b.doc, a.doc, b.sum, a.sum);
  } catch (e) {
    if (e instanceof CompareRefused) throw new WritecheckError(`compare refused: ${e.message}`, 2);
    throw e;
  }
  mkdirSync(o.out, { recursive: true });
  writeFileSync(join(o.out, 'compare.json'), JSON.stringify(doc, null, 2) + '\n');
  writeFileSync(join(o.out, 'compare.md'), renderCompareMarkdown(doc));
  if (!pinned) o.log('warning: the input files are not pinned to a key (--allow-unsigned); compare.md says so');
  for (const w of doc.warnings) o.log(`warning: ${w}`);
  for (const label of ['regressed', 'fixed'] as const) for (const c of doc.cells.filter((x) => x.label === label)) o.log(`${label}: ${c.key} (${c.before?.verdict} → ${c.after?.verdict})${c.same_test_because?.length ? `; same test by rule A: ${c.same_test_because.join('; ')}` : ''}`);
  o.log(`compare: ${join(o.out, 'compare.md')} (also compare.json); cells are listed there, not counted`);
  const slotRegressed = doc.cells.some((c) => c.slot_regressions?.length);
  const newly = doc.cells.some((c) => c.newly_found);
  return { exit: doc.cells.some((c) => c.label === 'regressed') || (slotRegressed && o.failOnSlotRegression !== false) || (newly && o.failOnNewViolation === true) ? 1 : 0, doc };
}

/**
 * After `recheck` wrote <run>/recheck/: the copy holds new verdicts, so the original results signature no longer covers it.
 * Its signature is set to null (or made again with --sign-key / MWSC_SIGN_KEY), every record recheck re-evaluated gets a
 * test_hash naming this tester build, and identity.rechecked_by names the build and the time. Records kept as recorded keep the
 * hash they were made with.
 *
 * Review S1: where the recorded record of the same slot and case carries test inputs of this scheme (and the same procedure
 * version), those inputs are reused, with this build as the tester and this build's MWS-IN-5 reading, so the hash does not
 * depend on the redacted copies of the manifest and the catalog in the run folder. Otherwise (a file written before
 * mws-test-hash/2, or a `--review` file given) they are computed from those copies.
 */
/**
 * Whether recheck may sign its copy (review F5): only where the original's results signature verifies under a pinned key, or with
 * --allow-unsigned (recorded). Otherwise a signature would make an unsigned or unpinned file look vouched for. Throws (exit 2).
 */
export function originalSignature(runDir: string, o: { key: KeyObject | null; pubkey?: KeyObject | null; allowUnsigned?: boolean }): NonNullable<NonNullable<ResultsDoc['identity']>['rechecked_by']>['original_signature'] {
  // why: p08: the original is read as verify-results reads it, so `recheck --pubkey` verifies through the strict parser.
  const f = join(runDir, 'results.json');
  const original = parseResultsBytes(readFileSync(f), f) as ResultsDoc;
  const v = verifyResults(original, o.pubkey ?? null);
  const pinned = !!o.pubkey && v.status === 'valid';
  if (o.key && !pinned && !o.allowUnsigned)
    throw new WritecheckError(`${runDir}: recheck --sign-key signs only a copy of a file signed by a pinned key; the original is ${v.status === 'valid-unpinned' ? 'signed by a key that is not pinned (give --pubkey KEY)' : v.status}. Give --pubkey KEY, or --allow-unsigned to sign it anyway (recorded in identity.rechecked_by)`, 2);
  return { status: v.status, key_id: v.key_id, pinned, ...(o.key && !pinned && o.allowUnsigned ? { allow_unsigned: true } : {}) };
}

export async function finishRecheck(runDir: string, o: { key: KeyObject | null; pubkey?: KeyObject | null; allowUnsigned?: boolean; review?: string; log: (s: string) => void }): Promise<ResultsDoc> {
  const dir = join(runDir, 'recheck');
  const file = join(dir, 'results.json');
  const doc = JSON.parse(readFileSync(file, 'utf8')) as ResultsDoc;
  const original = parseResultsBytes(readFileSync(join(runDir, 'results.json')), join(runDir, 'results.json')) as ResultsDoc;
  const key = o.key;
  const origSig = originalSignature(runDir, o);
  const manifestFile = join(runDir, doc.manifest.path);
  // why: review S7: a run made with --pair-budget is hashed with the budget it ran under.
  const pb = original.identity?.hash_inputs?.pair_budget ?? null;
  const manifest = parseManifestText(readFileSync(manifestFile, 'utf8'), manifestFile, pb ? { pairBudget: pb } : {});
  const tools = readCatalogFile(join(runDir, 'catalog.json')).tools as Tool[];
  const stamp = buildStamp();
  const tester = { name: SUITE_NAME, version: SUITE_VERSION, commit: stamp.commit, dirty: stamp.dirty };
  const extras = await hashExtras();
  const slot = (r: Result) => `${r.requirement}|${r.write_path.resource}|${r.write_path.tool}|${r.scenario.id}|${r.scenario.version}|${r.case ?? ''}`;
  const recorded = new Map<string, TestInputs>();
  for (const r of original.results) if (r.test_inputs?.scheme === TEST_HASH_FORMAT && !recorded.has(slot(r))) recorded.set(slot(r), r.test_inputs);
  const fresh = doc.results.filter((r) => typeof r.test_hash !== 'string');
  const computed: Result[] = [];
  let reused = 0;
  for (const r of fresh) {
    const was = o.review ? undefined : recorded.get(slot(r));
    if (!was) {
      computed.push(r);
      continue;
    }
    const x: Record<string, unknown> = { ...(was.extras ?? {}) };
    if (r.requirement === 'MWS-IN-5' && extras.in5_reading !== undefined) x['in5_reading'] = extras.in5_reading;
    const { extras: _e, ...rest } = was;
    applyInputs(r, { ...rest, tester, ...(Object.keys(x).length ? { extras: x } : {}) });
    reused++;
  }
  stampTestHashes(computed, { manifest, tools, tester, extras: { ...extras, ...(original.identity?.hash_inputs?.in5_docs ? { in5_docs: original.identity.hash_inputs.in5_docs } : {}) }, review: reviewOf(manifest, o.review) ?? null });
  if (computed.length && fresh.length) o.log(`recheck: ${reused} re-evaluated record(s) hashed from their recorded test inputs, ${computed.length} from the run folder's manifest and catalog copies`);
  if (doc.identity) doc.identity.rechecked_by = { name: SUITE_NAME, version: SUITE_VERSION, commit: stamp.commit, dirty: stamp.dirty, at: new Date().toISOString(), records_rehashed: fresh.length, original_signature: origSig };
  doc.evidence.signature = null;
  if (key) doc.evidence.signature = signResults(doc, key, null);
  writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
  writeFileSync(join(dir, 'report.md'), renderMarkdown(doc));
  o.log(key ? 'recheck: results.json is signed again with the given key' : 'recheck: the original results signature does not cover the rechecked copy; its signature is null (give --sign-key to sign it)');
  return doc;
}
