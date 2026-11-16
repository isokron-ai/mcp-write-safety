/**
 * The catalog: MWS-ANN-4 (every tool sets readOnlyHint explicitly; every state-changing tool sets
 * destructiveHint explicitly), decided from tools/list alone, and the Annex A measurements, which
 * are printed with no verdict and never judged: catalog size split by part, the largest result seen,
 * whether tools/list keeps its order, and descriptions that name tools not in the catalog. There is
 * no threshold anywhere; a number here is a measurement, not a target.
 */

import { canonicalJson, isObj, sha256 } from '../core/util.js';
import { result, type Result } from '../report/verdicts.js';
import { annotations, wp, type Tool } from './types.js';

const ID = 'catalog';
const VERSION = '1';

export function annVerdicts(tools: Tool[]): Result[] {
  const sc = { id: ID, version: VERSION };
  return tools.map((t) => {
    const a = annotations(t);
    const missing: string[] = [];
    if (typeof a['readOnlyHint'] !== 'boolean') missing.push('readOnlyHint');
    if (a['readOnlyHint'] !== true && typeof a['destructiveHint'] !== 'boolean') missing.push('destructiveHint');
    return missing.length
      ? result('MWS-ANN-4', wp('(catalog)', t.name), sc, 'violated', `${t.name} does not set ${missing.join(' or ')} explicitly${missing.includes('destructiveHint') ? ' (it is not declared read-only, so it may change state)' : ''}.`)
      : result('MWS-ANN-4', wp('(catalog)', t.name), sc, 'held', `${t.name} sets readOnlyHint${a['readOnlyHint'] === true ? '' : ' and destructiveHint'} explicitly.`);
  });
}

const byKey = (k: string) => (a: unknown, b: unknown) => {
  const x = String(isObj(a) ? a[k] : '');
  const y = String(isObj(b) ? b[k] : '');
  return x < y ? -1 : x > y ? 1 : 0;
};

/**
 * The catalog fingerprint, in mcp-catalog-snap's canonical form so the two tools agree on the same
 * server: sha256 over the compact JCS serialization of `{ tools, prompts, resourceTemplates }`, tools
 * and prompts sorted by name and templates by uriTemplate, lists the server declares no capability
 * for being empty. The hex part equals a catalog-snap snapshot's `sha256`. A bare tools array is
 * taken as tools with no prompts and no templates.
 */
export function catalogFingerprint(c: unknown[] | { tools: unknown[]; prompts?: unknown[]; resourceTemplates?: unknown[] }): string {
  const cat = Array.isArray(c) ? { tools: c } : c;
  const body = { tools: [...cat.tools].sort(byKey('name')), prompts: [...(cat.prompts ?? [])].sort(byKey('name')), resourceTemplates: [...(cat.resourceTemplates ?? [])].sort(byKey('uriTemplate')) };
  return `sha256:${sha256(canonicalJson(body))}`;
}

const bytes = (v: unknown) => (v === undefined ? 0 : Buffer.byteLength(JSON.stringify(v), 'utf8'));
const TOOLISH = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;

export interface Measurements {
  'A-1': { measured: boolean; note: string; jobs: { resource: string; name: string; calls: number; ok: boolean; failed_at: number | null }[] };
  'A-2': { tools: number; bytes_total: number; bytes_descriptions: number; bytes_input_schemas: number; bytes_output_schemas: number; bytes_annotations: number; bytes_icons: number; bytes_other: number; characters_total: number };
  'A-3': { largest_result_bytes: number | null; at_step: string | null };
  'A-4': { order_stable_across_two_lists: boolean | null; unknown_tool_references: { tool: string; names: string[] }[] };
}

export function measure(tools: Tool[], o: { second?: Tool[] | null; largest?: { mcp_bytes: number; step: string | null } | null; jobs?: { resource: string; name: string; calls: number; ok: boolean; failed_at: number | null }[] }): Measurements {
  let desc = 0;
  let input = 0;
  let output = 0;
  let ann = 0;
  let icons = 0;
  for (const t of tools) {
    desc += t.description ? Buffer.byteLength(JSON.stringify(t.description)) : 0;
    input += bytes(t.inputSchema);
    output += bytes(t['outputSchema']);
    ann += bytes(t.annotations);
    icons += bytes(t['icons']);
  }
  const total = bytes(tools);
  const names = new Set(tools.map((t) => t.name));
  const prefixes = new Set([...names].map((n) => n.split('_')[0]!));
  const unknown: { tool: string; names: string[] }[] = [];
  for (const t of tools) {
    const d = typeof t.description === 'string' ? t.description : '';
    const u = [...new Set([...d.matchAll(TOOLISH)].map((m) => m[0]))].filter((w) => !names.has(w) && prefixes.has(w.split('_')[0]!));
    if (u.length) unknown.push({ tool: t.name, names: u });
  }
  return {
    'A-1': o.jobs && o.jobs.length ? { measured: true, note: 'tool calls each declared job took (a job that failed stops at the failing call)', jobs: o.jobs } : { measured: false, note: 'no job declared (resources[].jobs)', jobs: [] },
    'A-2': { tools: tools.length, bytes_total: total, bytes_descriptions: desc, bytes_input_schemas: input, bytes_output_schemas: output, bytes_annotations: ann, bytes_icons: icons, bytes_other: Math.max(0, total - desc - input - output - ann - icons), characters_total: JSON.stringify(tools).length },
    'A-3': { largest_result_bytes: o.largest ? o.largest.mcp_bytes : null, at_step: o.largest?.step ?? null },
    'A-4': { order_stable_across_two_lists: o.second ? JSON.stringify(o.second.map((t) => t.name)) === JSON.stringify(tools.map((t) => t.name)) : null, unknown_tool_references: unknown },
  };
}

export const isTool = (v: unknown): v is Tool => isObj(v) && typeof v['name'] === 'string';
