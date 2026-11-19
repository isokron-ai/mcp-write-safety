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
 *   tools         for the write path's tool and for every tool the record's resource block names (any `tool` member in it):
 *                 the tools/list entry without `title`, `icons` and `_meta`, or null where the catalog has no such tool
 *   resource      the record's resource block as loaded (args templates, fields, version, control, cleanup …), or null for a
 *                 record that belongs to no resource ((server), (catalog), (declaration))
 *   declaration   the rest of the manifest that a check reads: every top-level member except `server`, `target`,
 *                 `resources`, `limits`, `prefix` and the loader's `source`
 *   limits        every limit except `write_budget` and `writes_per_second` (they bound and pace a run; they do not change
 *                 what one test sends or how it is judged)
 *
 * Not included, on purpose: the rest of the tool list (a patched build that adds tools keeps its hashes), the catalog
 * fingerprint, the manifest sha256 and the plan hash (they cover the whole catalog and every resource), the server block and
 * the target block (the launch command and hosts name the build under test, not the test), target.provenance, and anything
 * the run measured. A change to any included member changes the hash: a tool whose schema or description changed, a
 * different tester build, or a different limit is a different test, and compare reports it as `test changed`.
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
const TOOL_ENTRY_EXCLUDED = ['title', 'icons', '_meta'];

export interface TestHashContext {
  manifest: Manifest;
  tools: { name: string; [k: string]: unknown }[];
  tester?: { name: string; version: string; commit: string | null };
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

function toolEntry(tools: TestHashContext['tools'], name: string): unknown {
  const t = tools.find((x) => x.name === name);
  if (!t) return null;
  return plain(Object.fromEntries(Object.entries(t).filter(([k]) => !TOOL_ENTRY_EXCLUDED.includes(k))));
}

/** The members of the manifest every record's hash includes (computed once per run). */
export function sharedInputs(m: Manifest): { declaration: unknown; limits: unknown } {
  const declaration = Object.fromEntries(Object.entries(m).filter(([k]) => !(HASH_EXCLUDED_TOP as readonly string[]).includes(k)));
  const limits = Object.fromEntries(Object.entries(m.limits).filter(([k]) => !(HASH_EXCLUDED_LIMITS as readonly string[]).includes(k)));
  return { declaration: relativized(plain(declaration), baseOf(m)), limits: plain(limits) };
}

/** What the hash is computed over, for one record (exported so a reader can see exactly what entered it). */
export function testHashInput(r: Pick<Result, 'requirement' | 'level' | 'scenario' | 'write_path'>, ctx: TestHashContext, shared = sharedInputs(ctx.manifest)): Record<string, unknown> {
  const res = ctx.manifest.resources.find((x) => x.name === r.write_path.resource) ?? null;
  const names = new Set<string>([r.write_path.tool, ...(res ? toolsNamedIn(res) : [])]);
  const tools: Record<string, unknown> = {};
  for (const n of [...names].sort()) tools[n] = toolEntry(ctx.tools, n);
  return {
    format: TEST_HASH_FORMAT,
    tester: ctx.tester ?? { name: SUITE_NAME, version: SUITE_VERSION, commit: null },
    spec: SPEC_VERSION,
    requirement: r.requirement,
    level: r.level,
    scenario: { id: r.scenario.id, version: r.scenario.version },
    write_path: { resource: r.write_path.resource, tool: r.write_path.tool, arm: r.write_path.arm },
    tools,
    resource: res ? relativized(plain(res), baseOf(ctx.manifest)) : null,
    declaration: shared.declaration,
    limits: shared.limits,
  };
}

export function testHash(r: Pick<Result, 'requirement' | 'level' | 'scenario' | 'write_path'>, ctx: TestHashContext, shared?: ReturnType<typeof sharedInputs>): string {
  return `sha256:${sha256(canonical(testHashInput(r, ctx, shared)))}`;
}

/** Stamp `test_hash` on every record (in place; the member is added last, so the other members keep their order). */
export function stampTestHashes(results: Result[], ctx: TestHashContext): void {
  const shared = sharedInputs(ctx.manifest);
  for (const r of results) (r as Result & { test_hash?: string }).test_hash = testHash(r, ctx, shared);
}
