/**
 * The `compare` and `verify-results` commands, and the run identity flags of `run` and `rerun`.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Tool } from '../checks/types.js';
import { buildStamp } from '../core/identity.js';
import { parseManifestText } from '../core/manifest.js';
import { renderMarkdown } from '../report/markdown.js';
import type { ResultsDoc } from '../report/results.js';
import { loadSigningKey, signResults } from '../report/sign.js';
import { hashExtras, stampTestHashes } from '../report/testhash.js';
import { SUITE_NAME, SUITE_VERSION } from '../version.js';
import { readCatalogFile } from './commands.js';

import type { ProvenanceFlags } from '../core/identity.js';
import { WritecheckError } from '../core/util.js';
import { compareDocs, CompareRefused, renderCompareMarkdown, summarize, type CompareDoc } from '../report/compare.js';
import { duplicateKey, publicKeyFrom, verifyResults, type VerifyOutcome } from '../report/sign.js';

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
  let doc: unknown;
  try {
    doc = JSON.parse(bytes.toString('utf8'));
  } catch (e) {
    throw new WritecheckError(`${f}: not JSON (${(e as Error).message})`, 2);
  }
  // why: review: JSON.parse keeps the last of two equal member names; another reader may keep the first. Such a file is refused.
  const dup = duplicateKey(bytes.toString('utf8'));
  if (dup) throw new WritecheckError(`${f}: the member ${dup} appears twice; a signed or compared file has each member once`, 3);
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
 * `compare <before> <after> [--out DIR] [--pubkey KEY] [--fail-on-slot-regression true|false]`: writes compare.json and
 * compare.md. With --pubkey both files must be signed by that key (exit 3 otherwise). Exit 1 when a cell regressed, or (unless
 * --fail-on-slot-regression false) a slot regressed inside a cell whose roll-up did not; else 0; 2 when the two cannot be
 * compared.
 */
export function compareCommand(o: { before: string; after: string; out: string; pubkey?: string; failOnSlotRegression?: boolean; log: (s: string) => void }): { exit: number; doc: CompareDoc } {
  const pinned = o.pubkey ? publicKeyFrom(o.pubkey) : null;
  const load = (p: string, n: string) => {
    const f = resultsFile(p);
    const { bytes, doc } = readDoc(f);
    const sig = verifyResults(doc, pinned);
    if (pinned && sig.status !== 'valid') throw new WritecheckError(`${n} ${f}: ${sig.status}: ${sig.detail}`, 3);
    return { doc, sum: summarize(doc, f, bytes, sig) };
  };
  const b = load(o.before, 'before');
  const a = load(o.after, 'after');
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
  for (const w of doc.warnings) o.log(`warning: ${w}`);
  for (const label of ['regressed', 'fixed'] as const) for (const c of doc.cells.filter((x) => x.label === label)) o.log(`${label}: ${c.key} (${c.before?.verdict} → ${c.after?.verdict})`);
  o.log(`compare: ${join(o.out, 'compare.md')} (also compare.json); cells are listed there, not counted`);
  const slotRegressed = doc.cells.some((c) => c.slot_regressions?.length);
  return { exit: doc.cells.some((c) => c.label === 'regressed') || (slotRegressed && o.failOnSlotRegression !== false) ? 1 : 0, doc };
}

/**
 * After `recheck` wrote <run>/recheck/: the copy holds new verdicts, so the original results signature no longer covers it.
 * Its signature is set to null (or made again with --sign-key / MWSC_SIGN_KEY), every record recheck re-evaluated gets a
 * test_hash from this tester build, and identity.rechecked_by names the build and the time. Records kept as recorded keep the
 * hash they were made with.
 */
export async function finishRecheck(runDir: string, o: { signKey?: string; env: NodeJS.ProcessEnv; log: (s: string) => void }): Promise<ResultsDoc> {
  const dir = join(runDir, 'recheck');
  const file = join(dir, 'results.json');
  const doc = JSON.parse(readFileSync(file, 'utf8')) as ResultsDoc;
  const key = loadSigningKey(o.signKey, o.signKey ? {} : o.env);
  const manifestFile = join(runDir, doc.manifest.path);
  const manifest = parseManifestText(readFileSync(manifestFile, 'utf8'), manifestFile);
  const tools = readCatalogFile(join(runDir, 'catalog.json')).tools as Tool[];
  const stamp = buildStamp();
  const fresh = doc.results.filter((r) => typeof r.test_hash !== 'string');
  stampTestHashes(fresh, { manifest, tools, tester: { name: SUITE_NAME, version: SUITE_VERSION, commit: stamp.commit }, extras: await hashExtras() });
  if (doc.identity) doc.identity.rechecked_by = { name: SUITE_NAME, version: SUITE_VERSION, commit: stamp.commit, at: new Date().toISOString(), records_rehashed: fresh.length };
  doc.evidence.signature = null;
  if (key) doc.evidence.signature = signResults(doc, key, null);
  writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
  writeFileSync(join(dir, 'report.md'), renderMarkdown(doc));
  o.log(key ? 'recheck: results.json is signed again with the given key' : 'recheck: the original results signature does not cover the rechecked copy; its signature is null (give --sign-key to sign it)');
  return doc;
}
