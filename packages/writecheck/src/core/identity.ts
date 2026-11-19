/**
 * Run identity (results.identity): what a before/after page needs to say exactly which tester, which spec, which test and
 * which server build a results.json came from. Every member is stated or null; a null member is listed in `gaps`, so a reader
 * (or a publish job) can refuse a run that is not pinned instead of assuming a default. The tester never guesses a build:
 * the server's repository, commit, tag and image come only from the operator (CLI flags, a provenance file, or the manifest's
 * optional `target.provenance`), and the tester's own commit only from the stamp written at build time (scripts/build-stamp.mjs).
 *
 * For a before/after pair the manifest should be byte-identical on both sides, so give the build through flags or
 * `--provenance`, not through `target.provenance` (which is part of the manifest bytes and so of manifest.sha256 and the plan
 * hash). The per-record test_hash (report/testhash.ts) never includes provenance.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { arch, platform, release } from 'node:os';
import { fileURLToPath } from 'node:url';

import { SPEC_VERSION } from '../requirements.js';
import { SUITE_NAME, SUITE_VERSION } from '../version.js';
import { isObj, parseConfigText, WritecheckError } from './util.js';

export const IDENTITY_FORMAT = 'mws-identity/1';
export const TEST_HASH_FORMAT = 'mws-test-hash/2';
/** Every test-hash scheme compare reads: records hashed under different schemes are never joined (compare says so). */
export const TEST_HASH_FORMATS_READ = ['mws-test-hash/1', 'mws-test-hash/2'] as const;

/** A git commit: 40 (SHA-1) or 64 (SHA-256) lowercase hex characters. Abbreviated commits are refused: they do not pin. */
export const COMMIT_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
/** An OCI image reference pinned by digest: `name@sha256:<64 hex>` (a tag before the digest is allowed and ignored by pulls). */
export const IMAGE_DIGEST_RE = /^[^\s@]+@sha256:[0-9a-f]{64}$/;

export interface BackendImage {
  /** What it is (`kind-node`, `postgres`, `grafana`). */
  name: string;
  /** The image reference; pinned only when it carries `@sha256:<digest>`. */
  image: string | null;
  version: string | null;
}

/** What the operator states about the server build under test (all optional; what is missing is listed in identity.gaps). */
export interface Provenance {
  repo: string | null;
  commit: string | null;
  tag: string | null;
  image: string | null;
  /** How the build was made (a Dockerfile path at the commit, a `go build` line); free text. */
  recipe: string | null;
  backend: BackendImage[];
}

export const emptyProvenance = (): Provenance => ({ repo: null, commit: null, tag: null, image: null, recipe: null, backend: [] });

const PROV_KEYS = ['repo', 'commit', 'tag', 'image', 'recipe', 'backend'];

function fail(where: string, why: string): WritecheckError {
  return new WritecheckError(`${where}: ${why}`, 2);
}

function optString(v: unknown, where: string): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || !v.trim()) throw fail(where, 'must be a non-empty string');
  return v.trim();
}

export function checkCommit(v: string | null, where: string): string | null {
  if (v === null) return null;
  if (!COMMIT_RE.test(v)) throw fail(where, `${JSON.stringify(v)} is not a full git commit (40 or 64 lowercase hex characters); an abbreviated commit does not pin a build`);
  return v;
}

export function checkImage(v: string | null, where: string): string | null {
  if (v === null) return null;
  if (/\s/.test(v)) throw fail(where, 'an image reference has no spaces');
  return v;
}

/**
 * Validate a provenance block (`target.provenance` in a manifest, or a `--provenance` file). Unknown keys are refused, so a
 * misspelt `comit` never leaves a run looking pinned when it is not.
 */
export function parseProvenance(raw: unknown, where: string): Provenance {
  if (!isObj(raw)) throw fail(where, 'must be a mapping');
  for (const k of Object.keys(raw)) if (!PROV_KEYS.includes(k)) throw fail(where, `unknown key ${JSON.stringify(k)} (allowed: ${PROV_KEYS.join(', ')})`);
  const backend: BackendImage[] = [];
  if (raw['backend'] !== undefined) {
    if (!Array.isArray(raw['backend'])) throw fail(`${where}.backend`, 'must be a list of { name, image, version }');
    raw['backend'].forEach((b, i) => {
      const w = `${where}.backend[${i}]`;
      if (!isObj(b)) throw fail(w, 'must be a mapping');
      for (const k of Object.keys(b)) if (!['name', 'image', 'version'].includes(k)) throw fail(w, `unknown key ${JSON.stringify(k)} (allowed: name, image, version)`);
      const name = optString(b['name'], `${w}.name`);
      if (!name) throw fail(`${w}.name`, 'is required');
      backend.push({ name, image: checkImage(optString(b['image'], `${w}.image`), `${w}.image`), version: optString(b['version'], `${w}.version`) });
    });
  }
  return {
    repo: optString(raw['repo'], `${where}.repo`),
    commit: checkCommit(optString(raw['commit'], `${where}.commit`), `${where}.commit`),
    tag: optString(raw['tag'], `${where}.tag`),
    image: checkImage(optString(raw['image'], `${where}.image`), `${where}.image`),
    recipe: optString(raw['recipe'], `${where}.recipe`),
    backend,
  };
}

/** The manifest's optional `target.provenance` (validated again here; the loader validates it too), or null. */
export function manifestProvenance(file: string): Provenance | null {
  const raw = parseConfigText(readFileSync(file, 'utf8'), file);
  const t = isObj(raw) && isObj(raw['target']) ? raw['target'] : null;
  return t && t['provenance'] !== undefined ? parseProvenance(t['provenance'], 'manifest target.provenance') : null;
}

/** The operator's statements from the command line (`run`, `rerun`). */
export interface ProvenanceFlags {
  provenanceFile?: string;
  serverRepo?: string;
  serverCommit?: string;
  serverTag?: string;
  serverImage?: string;
  /** `--backend-image name=ref` (repeatable). */
  backendImages?: string[];
}

/** Parse `--backend-image name=ref`. */
export function backendFlag(s: string): BackendImage {
  const i = s.indexOf('=');
  if (i <= 0 || i === s.length - 1) throw fail('--backend-image', `${JSON.stringify(s)}: give name=image (for example kind-node=kindest/node@sha256:…)`);
  const name = s.slice(0, i).trim();
  return { name, image: checkImage(s.slice(i + 1).trim(), `--backend-image ${name}`), version: null };
}

/**
 * The provenance in force: the manifest's `target.provenance`, then the `--provenance` file, then the flags; a later source
 * replaces a member an earlier one set (a backend entry is replaced by name). Where two sources state different values the
 * later wins and the earlier is reported in `overridden`, so a manifest that says one commit and a flag that says another
 * cannot pass unnoticed.
 */
export function resolveProvenance(fromManifest: Provenance | null, flags: ProvenanceFlags = {}): { provenance: Provenance; sources: string[]; overridden: string[] } {
  const out = emptyProvenance();
  const sources: string[] = [];
  const overridden: string[] = [];
  const apply = (p: Partial<Provenance>, src: string) => {
    let used = false;
    for (const k of ['repo', 'commit', 'tag', 'image', 'recipe'] as const) {
      const v = p[k];
      if (v === undefined || v === null) continue;
      if (out[k] !== null && out[k] !== v) overridden.push(`${k}: ${src} replaced ${JSON.stringify(out[k])} with ${JSON.stringify(v)}`);
      out[k] = v;
      used = true;
    }
    for (const b of p.backend ?? []) {
      const at = out.backend.findIndex((x) => x.name === b.name);
      if (at >= 0) {
        if (out.backend[at]!.image !== b.image) overridden.push(`backend ${b.name}: ${src} replaced ${JSON.stringify(out.backend[at]!.image)} with ${JSON.stringify(b.image)}`);
        out.backend[at] = { ...out.backend[at]!, ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== null)) } as BackendImage;
      } else out.backend.push(b);
      used = true;
    }
    if (used) sources.push(src);
  };
  if (fromManifest) apply(fromManifest, 'manifest target.provenance');
  if (flags.provenanceFile) {
    if (!existsSync(flags.provenanceFile)) throw fail('--provenance', `${flags.provenanceFile} does not exist`);
    apply(parseProvenance(parseConfigText(readFileSync(flags.provenanceFile, 'utf8'), flags.provenanceFile), `--provenance ${flags.provenanceFile}`), '--provenance file');
  }
  apply(
    {
      repo: flags.serverRepo ?? null,
      commit: checkCommit(flags.serverCommit ?? null, '--server-commit'),
      tag: flags.serverTag ?? null,
      image: checkImage(flags.serverImage ?? null, '--server-image'),
      backend: (flags.backendImages ?? []).map(backendFlag),
    },
    'flags',
  );
  return { provenance: out, sources, overridden };
}

/** The tester's own build, from dist/src/build-info.json (written by scripts/build-stamp.mjs at build time). */
export interface BuildStamp {
  commit: string | null;
  /** The working tree had changes that are not in `commit` when it was built. */
  dirty: boolean | null;
  /** Why commit is null (no git, not a checkout), when it is. */
  note?: string;
  /** Compiled code is newer than the stamp (tsc was run without the stamp step): the stamp may name another commit. */
  stale?: boolean;
}

/** The newest modification time of a .js file under a folder (0 when none). */
function newestJs(dir: string): number {
  let t = 0;
  try {
    for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
      if (e.isFile() && e.name.endsWith('.js')) t = Math.max(t, statSync(join(e.parentPath ?? (e as unknown as { path: string }).path, e.name)).mtimeMs);
    }
  } catch {
    return 0;
  }
  return t;
}

let stampCache: BuildStamp | null = null;

export function buildStamp(at?: string): BuildStamp {
  if (stampCache && at === undefined) return stampCache;
  const file = at ?? fileURLToPath(new URL('../build-info.json', import.meta.url));
  let s: BuildStamp;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const commit = typeof raw['commit'] === 'string' && COMMIT_RE.test(raw['commit']) ? raw['commit'] : null;
    s = { commit, dirty: typeof raw['dirty'] === 'boolean' ? raw['dirty'] : null, ...(commit ? {} : { note: typeof raw['note'] === 'string' ? raw['note'] : 'the build stamp names no commit' }) };
    // why: review: a tsc run after the stamp leaves a stamp that may name another commit than the code that runs.
    if (newestJs(dirname(file)) > statSync(file).mtimeMs + 1000) s.stale = true;
  } catch {
    s = { commit: null, dirty: null, note: 'no build stamp (dist/src/build-info.json): this build was not made with npm run build' };
  }
  if (at === undefined) stampCache = s;
  return s;
}

export interface Runner {
  os: string;
  arch: string;
  node: string;
  /** A CI job, where the environment names one (GitHub Actions); null on a workstation. */
  ci: { provider: 'github-actions'; run_id: string; run_attempt: string | null; url: string | null; workflow_ref: string | null } | null;
}

export function runnerInfo(env: NodeJS.ProcessEnv = process.env): Runner {
  const gh = env['GITHUB_ACTIONS'] === 'true' && env['GITHUB_RUN_ID'];
  const url = gh && env['GITHUB_SERVER_URL'] && env['GITHUB_REPOSITORY'] ? `${env['GITHUB_SERVER_URL']}/${env['GITHUB_REPOSITORY']}/actions/runs/${env['GITHUB_RUN_ID']}` : null;
  return {
    os: `${platform()} ${release()}`,
    arch: arch(),
    node: process.version,
    ci: gh ? { provider: 'github-actions', run_id: String(env['GITHUB_RUN_ID']), run_attempt: env['GITHUB_RUN_ATTEMPT'] ?? null, url, workflow_ref: env['GITHUB_WORKFLOW_REF'] ?? null } : null,
  };
}

export interface RunIdentity {
  format: typeof IDENTITY_FORMAT;
  tester: { name: string; version: string; commit: string | null; dirty: boolean | null; stale?: boolean };
  spec: { version: string };
  manifest_sha256: string;
  plan_hash: string;
  /** sha256 over the canonical, name-sorted tools/list entries (tools only; target.catalog_fingerprint also covers prompts and templates). */
  tools_fingerprint: string;
  /** The per-record test_hash algorithm (report/testhash.ts; MANIFEST.md, Run identity). */
  test_hash: string;
  server: { repo: string | null; commit: string | null; tag: string | null; image: string | null; recipe: string | null; launch: string; transport: string | null };
  backend: BackendImage[];
  runner: Runner;
  started: string;
  finished: string;
  /** Where the provenance came from (manifest target.provenance, --provenance file, flags), and any value a later source replaced. */
  provenance: { sources: string[]; overridden: string[] };
  /** Each identity member that is not stated or not pinned, with why. Empty only for a fully pinned run. */
  gaps: string[];
  /** Inputs of the test hashes that are not in the manifest copy the run keeps (so a recheck can hash with them): the `--pair-budget` given, and the sha256 of each document MWS-IN-5 read. */
  hash_inputs?: { pair_budget?: { repeats: number; pairs: number } | null; in5_docs?: Record<string, string | null> };
  /** Set by `recheck` on its copy: the tester build that re-applied the rules, when, and how many records it hashed anew. */
  rechecked_by?: { name: string; version: string; commit: string | null; dirty?: boolean | null; at: string; records_rehashed: number };
}

export function identityGaps(i: Omit<RunIdentity, 'gaps'>): string[] {
  const g: string[] = [];
  if (!i.tester.commit) g.push('tester.commit: not stamped (build with npm run build in a git checkout)');
  else if (i.tester.dirty) g.push('tester.dirty: the tester was built from a working tree with uncommitted changes');
  else if (i.tester.dirty === null) g.push('tester.dirty: the build stamp does not say whether the working tree was clean');
  if (i.tester.stale) g.push('tester.stale: the compiled code is newer than the build stamp (run npm run build, not tsc alone)');
  if (!i.server.repo) g.push('server.repo: not stated (--server-repo or target.provenance.repo)');
  if (!i.server.commit) g.push('server.commit: not stated (--server-commit or target.provenance.commit)');
  if (!i.server.image) g.push('server.image: not stated (--server-image or target.provenance.image)');
  else if (!IMAGE_DIGEST_RE.test(i.server.image)) g.push(`server.image: ${i.server.image} is not pinned by digest (@sha256:…)`);
  if (!i.backend.length) g.push('backend: no backend image stated (--backend-image name=ref or target.provenance.backend)');
  for (const b of i.backend) if (!b.image || !IMAGE_DIGEST_RE.test(b.image)) g.push(`backend ${b.name}: image ${b.image ?? '(none)'} is not pinned by digest (@sha256:…)`);
  if (i.provenance.overridden.length) g.push(`provenance: a later source replaced a stated value (${i.provenance.overridden.join('; ')})`);
  return g;
}

export function buildIdentity(o: {
  manifestSha256: string;
  planHash: string;
  toolsFingerprint: string;
  launch: string;
  transport: string | null;
  provenance: Provenance;
  sources: string[];
  overridden: string[];
  started: string;
  finished: string;
  env?: NodeJS.ProcessEnv;
  stamp?: BuildStamp;
}): RunIdentity {
  const st = o.stamp ?? buildStamp();
  const base: Omit<RunIdentity, 'gaps'> = {
    format: IDENTITY_FORMAT,
    tester: { name: SUITE_NAME, version: SUITE_VERSION, commit: st.commit, dirty: st.dirty, ...(st.stale ? { stale: true } : {}) },
    spec: { version: SPEC_VERSION },
    manifest_sha256: o.manifestSha256,
    plan_hash: o.planHash,
    tools_fingerprint: o.toolsFingerprint,
    test_hash: TEST_HASH_FORMAT,
    server: { repo: o.provenance.repo, commit: o.provenance.commit, tag: o.provenance.tag, image: o.provenance.image, recipe: o.provenance.recipe, launch: o.launch, transport: o.transport },
    backend: o.provenance.backend,
    runner: runnerInfo(o.env),
    started: o.started,
    finished: o.finished,
    provenance: { sources: o.sources, overridden: o.overridden },
  };
  return { ...base, gaps: identityGaps(base) };
}
