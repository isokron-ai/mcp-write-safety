/**
 * results.json (`mws-results/1`): one record per requirement per write path per scenario, the
 * requirements not built in this release, the Annex A measurements, the leftovers, and the raw
 * observations `recheck` re-evaluates. There is no aggregate field: no total, no percentage, no
 * `passed`. The published schema (schema/mws-results-1.schema.json) forbids additional top-level
 * properties, so a wrapper cannot add one and still validate.
 */

import type { Measurements } from '../checks/catalog.js';
import type { Cell } from '../checks/cells.js';
import type { Observation } from '../checks/types.js';
import type { CleanupReport, Leftover } from '../core/cleanup.js';
import type { RunIdentity } from '../core/identity.js';
import type { ResultsSignature } from './sign.js';
import type { McpRecord } from './protocol.js';
import type { NotRun, Result } from './verdicts.js';

export const RESULTS_FORMAT = 'mws-results/1';

export interface ResultsDoc {
  format: typeof RESULTS_FORMAT;
  /** The first line of every report: what was tested and what was not. */
  scope: string;
  suite: { name: string; version: string };
  spec: { version: string };
  /**
   * cut_at (optional): where a run cut short (write budget, rate limit, interrupt) was cut: `record`, the index in `results` of
   * the first record made after the cut; `observation`, the index in `observations` of the first observation made after it.
   * Recheck uses it to keep V-RUN on exactly those records (docs/CELLS.md, Validity).
   */
  run: { id: string; prefix: string; started: string; ended: string; status: 'complete' | 'stopped'; stopped_reason: string | null; writes: number; processes_started: number; cut_at?: { record: number; observation: number } };
  /** mcp: spec 5.3, the protocol revision and transport, and the client capabilities and extensions the tester declared (with rule 10's input requests and rule 11's patterns). */
  target: { confirm: string; environment: string; server: string; catalog_fingerprint: string; guard: { tool: string; matched: string; basis?: 'annotation' | 'operator'; note?: string; calls?: number; call_steps?: string[]; counted_as_writes?: number } | null; mcp?: McpRecord };
  manifest: { path: string; sha256: string };
  plan: { hash: string };
  results: Result[];
  /** One entry per cell (MUST requirement × declared write tool, plus the server-level requirements): docs/CELLS.md. Not an aggregate: no total, no percentage. Optional in mws-results/1 (absent in files written before the cell pass). */
  cells?: Cell[];
  not_built: NotRun[];
  measurements: Measurements | null;
  leftovers: Leftover[];
  cleanup: Omit<CleanupReport, 'left'> | null;
  observations: Observation[];
  /**
   * signature: null (unsigned); a string, the ssh signature file of SHA256SUMS (`--sign`); or a results signature
   * (`--sign-key`, report/sign.ts) over this document with this member null, whose `sums` names the ssh signature if any.
   */
  evidence: { capture: { lines: number; lines_sha256: string } | null; checksums: 'SHA256SUMS'; signature: string | ResultsSignature | null };
  safety: {
    canaries: { name: string; tool: string; unchanged: boolean | null; note?: string }[];
    fixtures_restored: { resource: string; restored: boolean; note?: string }[];
    gate: { route: string; description: string } | null;
    protocol: string | null;
    rerun_of: string | null;
    /** Warnings about the declaration (an ignored field the tool under test can set). */
    warnings?: string[]; /** review S3: bystander losses outside any check's records. */ run_losses?: unknown[];
  };
  /** The run's identity (core/identity.ts): tester build, spec, manifest, plan, tools, server build, backend, runner. Optional in mws-results/1 (absent in files written before it). */
  identity?: RunIdentity;
}

/** The top-level keys the schema allows, in order (a test checks the schema file against this). */
export const RESULTS_KEYS = ['format', 'scope', 'suite', 'spec', 'run', 'target', 'manifest', 'plan', 'results', 'cells', 'not_built', 'measurements', 'leftovers', 'cleanup', 'observations', 'evidence', 'safety'] as const;

/** Top-level keys after RESULTS_KEYS, optional in mws-results/1, written by every run of this release. */
export const RESULTS_OPTIONAL_TAIL = ['identity'] as const;
/** Every top-level key a run of this release writes, in order (the schema's properties, in order). */
export const RESULTS_KEYS_WRITTEN: readonly string[] = [...RESULTS_KEYS, ...RESULTS_OPTIONAL_TAIL];

export function scopeSentence(o: { server: string; catalog: string; resources: { name: string; tool: string; fields: string[] }[]; notBuiltCount: number }): string {
  const res = o.resources.map((r) => (r.fields.length ? `${r.name} through ${r.tool} (fields ${r.fields.join(', ')})` : `${r.name} through ${r.tool}`)).join('; ');
  return `Scope: server ${o.server} (catalog ${o.catalog.slice(0, 23)}…), resources ${res}. Results are per write path; requirements marked not tested or not applicable say why${o.notBuiltCount ? `, and ${o.notBuiltCount} requirement(s) have no check in this release` : ''}.`;
}
