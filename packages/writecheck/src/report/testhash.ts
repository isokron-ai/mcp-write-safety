/**
 * The per-record test_hash (`mws-test-hash/1`): a hash of exactly what defines one record's test, so that two runs of the same
 * test on two server builds can be compared record by record even when the builds offer different tool lists. It is
 * `sha256:` + sha256 of the RFC 8785 canonical JSON of:
 *
 *   format        "mws-test-hash/1"
 *   tester        { name, version, commit }  (the build stamp; commit null when the build was not stamped)
 *   spec          the MWS version the requirements come from
 *   requirement, level
 *   scenario      { id, version }  (the procedure and its version)
 *   write_path    { resource, tool, arm }
 *   tools         for the write path's tool and every tool the record's resource block names: the narrowed input schema
 *                 (narrowSchema: `type`, the subschemas of the arguments the test uses, `required` restricted to those, and
 *                 the names of any other required argument), or null where the catalog has no such tool. Descriptions,
 *                 titles, annotations, output schemas, icons and `_meta` are left out, and so are optional arguments the test
 *                 does not use: a fix that only adds optional arguments, or bounds an argument the test does not send, keeps
 *                 the hash.
 *   subject       only for a requirement that judges part of the tool entry itself (SUBJECT_FACETS): that part of the write
 *                 path tool's entry, whole (the input schema for MWS-IN-2/3/5/6/7, the annotations for MWS-ANN-*, the
 *                 description for MWS-CONC-5, MWS-RETRY-2 and MWS-TGT-3). Such a record also carries test_hash_core, the
 *                 hash without `subject`, so compare can tell a changed subject from a changed test.
 *   resource      the record's resource block as loaded, or null for (server), (catalog) and (declaration) records
 *   declaration   every other top-level member except `server`, `target`, `resources`, `limits`, `prefix` and `source`
 *   guard         target.guard, where declared (it decides whether the run goes on between checks)
 *   limits        every limit except `write_budget`, and except `writes_per_second` but for MWS-CONC-* records
 *   extras        settings a tester build reads from its command line that change a verdict, where present (the
 *                 MWS-IN-5 reading, `in5_reading`, for MWS-IN-5 records)
 *
 * Not included, on purpose: the rest of the tool list, the catalog fingerprint, the manifest sha256 and the plan hash, the
 * server block and the rest of the target block (they name the build under test, not the test), target.provenance, and
 * anything the run measured.
 */

import { dirname, relative, resolve, sep } from 'node:path';

import type { Manifest } from '../core/manifest.js';
import { canonical, isObj, sha256 } from '../core/util.js';
import { TEST_HASH_FORMAT } from '../core/identity.js';
import { SPEC_VERSION } from '../requirements.js';
import { SUITE_NAME, SUITE_VERSION } from '../version.js';
import type { Result } from './verdicts.js';

/** Manifest members that never enter a test hash (see the header). */
export const HASH_EXCLUDED_TOP = ['server', 'target', 'resources', 'limits', 'prefix', 'source'] as const;
export const HASH_EXCLUDED_LIMITS = ['write_budget', 'writes_per_second'] as const;

/** The part of the tool entry a requirement judges, which then enters its hash whole. */
export type Facet = 'schema' | 'annotations' | 'description';
export function subjectFacets(requirement: string): Facet[] {
  if (/^MWS-IN-[23567]$/.test(requirement)) return ['schema'];
  if (/^MWS-ANN-\d+$/.test(requirement)) return ['annotations'];
  if (['MWS-CONC-5', 'MWS-RETRY-2', 'MWS-TGT-3'].includes(requirement)) return ['description'];
  return [];
}

/** Command-line settings of a tester build that change a verdict (set by the run before stamping; see the header). */
export interface HashExtras {
  in5_reading?: string;
}

/**
 * The extras of this build, where its modules define them: the MWS-IN-5 reading (checks/in5search.ts, IN5_READING) is read
 * when that module exists, so a build without the MWS-IN-5 search hashes nothing for it.
 */
export async function hashExtras(): Promise<HashExtras> {
  const spec = '../checks/in5search.js';
  try {
    const m = (await import(spec)) as { IN5_READING?: { value?: unknown } };
    return typeof m.IN5_READING?.value === 'string' ? { in5_reading: m.IN5_READING.value } : {};
  } catch (e) {
    if ((e as { code?: string }).code === 'ERR_MODULE_NOT_FOUND') return {};
    throw e;
  }
}

export interface TestHashContext {
  manifest: Manifest;
  tools: { name: string; [k: string]: unknown }[];
  tester?: { name: string; version: string; commit: string | null };
  extras?: HashExtras;
}

/** JSON-only copy (drops undefined and functions the way JSON does), so canonical() never meets a non-JSON value. */
const plain = (v: unknown): unknown => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

/**
 * The loader makes some paths absolute against the manifest's folder (documents a check reads). The same manifest checked
 * out in two folders is the same test, so such a path enters the hash relative to that folder (`./docs/api.md`).
 */
export function relativized(v: unknown, base: string): unknown {
  const pre = base.endsWith(sep) ? base : base + sep;
  const walk = (x: unknown): unknown => {
    if (typeof x === 'string') return x.startsWith(pre) ? `./${relative(base, x).split(sep).join('/')}` : x;
    if (Array.isArray(x)) return x.map(walk);
    if (isObj(x)) return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y)]));
    return x;
  };
  return walk(v);
}

const baseOf = (m: Manifest): string => dirname(resolve(m.source.path));

/** Every string under a `tool` key anywhere in a block (update.tool, read.tool, multi[].tool, control … ). */
export function toolsNamedIn(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) for (const x of v) toolsNamedIn(x, out);
  else if (isObj(v)) {
    for (const [k, x] of Object.entries(v)) {
      if (k === 'tool' && typeof x === 'string') out.add(x);
      else toolsNamedIn(x, out);
    }
  }
  return out;
}

/** Argument names the test sends to tool `t`: keys of `args` templates in blocks for `t`, and every declared `arg` of the block. */
export function usedArgs(t: string, res: unknown, underTest: boolean): Set<string> {
  const out = new Set<string>();
  const argsKeys = (v: unknown, own: boolean): void => {
    if (Array.isArray(v)) v.forEach((x) => argsKeys(x, own));
    else if (isObj(v)) {
      const mine = typeof v['tool'] === 'string' ? v['tool'] === t : own;
      for (const [k, x] of Object.entries(v)) {
        if (mine && k === 'args' && isObj(x)) for (const a of Object.keys(x)) if (!a.includes('{{')) out.add(a);
        argsKeys(x, mine);
      }
    }
  };
  const declared = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(declared);
    else if (isObj(v)) for (const [k, x] of Object.entries(v)) (k === 'arg' && typeof x === 'string' ? out.add(x) : declared(x));
  };
  argsKeys(res, false);
  // why: fields, version, key, scope, restorable and idempotency name arguments of the tools under test by `arg`.
  if (underTest && isObj(res)) {
    declared(res);
    for (const r of Array.isArray(res['restorable']) ? res['restorable'] : []) if (typeof r === 'string') out.add(r);
  }
  return out;
}

/** The part of an input schema a test depends on: see the header. */
export function narrowSchema(schema: unknown, used: Set<string>): unknown {
  if (!isObj(schema)) return plain(schema);
  const props = isObj(schema['properties']) ? schema['properties'] : {};
  const req = Array.isArray(schema['required']) ? schema['required'].filter((x): x is string => typeof x === 'string') : [];
  const keep: Record<string, unknown> = {};
  for (const u of [...used].sort()) if (u in props) keep[u] = plain(props[u]);
  return { type: plain(schema['type']), properties: keep, required: req.filter((r) => used.has(r)).sort(), required_other: req.filter((r) => !used.has(r)).sort() };
}

function toolPart(tools: TestHashContext['tools'], name: string, used: Set<string>): unknown {
  const t = tools.find((x) => x.name === name);
  return t ? narrowSchema(t['inputSchema'], used) : null;
}

function facetPart(tools: TestHashContext['tools'], name: string, f: Facet): unknown {
  const t = tools.find((x) => x.name === name);
  if (!t) return null;
  return plain(f === 'schema' ? t['inputSchema'] : f === 'annotations' ? t['annotations'] : t['description']);
}

/** The members of the manifest every record's hash includes (computed once per run). */
export function sharedInputs(m: Manifest): { declaration: unknown; limits: unknown; guard: unknown; rate: number } {
  const declaration = Object.fromEntries(Object.entries(m).filter(([k]) => !(HASH_EXCLUDED_TOP as readonly string[]).includes(k)));
  const limits = Object.fromEntries(Object.entries(m.limits).filter(([k]) => !(HASH_EXCLUDED_LIMITS as readonly string[]).includes(k)));
  return { declaration: relativized(plain(declaration), baseOf(m)), limits: plain(limits), guard: m.target.guard ? plain(m.target.guard) : null, rate: m.limits.writes_per_second };
}

/** What the hash is computed over, for one record (exported so a reader can see exactly what entered it). `core`: without the subject. */
export function testHashInput(r: Pick<Result, 'requirement' | 'level' | 'scenario' | 'write_path'>, ctx: TestHashContext, shared = sharedInputs(ctx.manifest), core = false): Record<string, unknown> {
  const res = ctx.manifest.resources.find((x) => x.name === r.write_path.resource) ?? null;
  const names = new Set<string>([r.write_path.tool, ...(res ? toolsNamedIn(res) : [])]);
  const tools: Record<string, unknown> = {};
  const underTest = new Set([r.write_path.tool, res?.update?.tool, res?.create?.tool].filter((x): x is string => !!x));
  for (const n of [...names].sort()) tools[n] = toolPart(ctx.tools, n, usedArgs(n, res ? plain(res) : null, underTest.has(n)));
  const facets = subjectFacets(r.requirement);
  const limits = /^MWS-CONC-/.test(r.requirement) ? { ...(shared.limits as Record<string, unknown>), writes_per_second: shared.rate } : shared.limits;
  const extras: Record<string, unknown> = {};
  if (r.requirement === 'MWS-IN-5' && ctx.extras?.in5_reading !== undefined) extras['in5_reading'] = ctx.extras.in5_reading;
  return {
    format: TEST_HASH_FORMAT,
    tester: ctx.tester ?? { name: SUITE_NAME, version: SUITE_VERSION, commit: null },
    spec: SPEC_VERSION,
    requirement: r.requirement,
    level: r.level,
    scenario: { id: r.scenario.id, version: r.scenario.version },
    write_path: { resource: r.write_path.resource, tool: r.write_path.tool, arm: r.write_path.arm },
    tools,
    ...(facets.length && !core ? { subject: Object.fromEntries(facets.map((f) => [f, facetPart(ctx.tools, r.write_path.tool, f)])) } : {}),
    resource: res ? relativized(plain(res), baseOf(ctx.manifest)) : null,
    declaration: shared.declaration,
    ...(shared.guard !== null ? { guard: shared.guard } : {}),
    limits,
    ...(Object.keys(extras).length ? { extras } : {}),
  };
}

export function testHash(r: Pick<Result, 'requirement' | 'level' | 'scenario' | 'write_path'>, ctx: TestHashContext, shared?: ReturnType<typeof sharedInputs>, core = false): string {
  return `sha256:${sha256(canonical(testHashInput(r, ctx, shared, core)))}`;
}

/** Stamp `test_hash` on every record (in place; the member is added last, so the other members keep their order). */
export function stampTestHashes(results: Result[], ctx: TestHashContext): void {
  const shared = sharedInputs(ctx.manifest);
  for (const r of results) {
    const x = r as Result & { test_hash?: string; test_hash_core?: string };
    x.test_hash = testHash(r, ctx, shared);
    if (subjectFacets(r.requirement).length) x.test_hash_core = testHash(r, ctx, shared, true);
    else delete x.test_hash_core;
  }
}
