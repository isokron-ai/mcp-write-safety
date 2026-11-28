/**
 * Min mode: the parts of a declaration (a writecheck manifest, hand-written or the thin template `mcp-writecheck init`
 * drafts from tools/list) that min mode reads. Nothing else of the manifest is used. A member marked `# guessed` is
 * dropped: min mode never holds or violates on a guessed field (owner decision, 27 Nov). A requirement whose
 * judgement needs a member that is absent is `not tested`, reason code `declaration_missing`.
 */

import { readFileSync } from 'node:fs';

import { isMap, isPair, isScalar, isSeq, parseDocument, type Node } from 'yaml';

import { GUESSED } from '../core/manifest.js';
import { isObj, type Obj } from '../core/util.js';

export interface MinDeclaration {
  /** Spec 7.3, rule 11: the text patterns the declaration gives (patterns.* and review.*). */
  patterns: Record<string, RegExp>;
  /** An adopted result shape (`results.shape`, e.g. write-result/0.1), or null. */
  shape: string | null;
  readOnly: { env: string; on: string; valid: Record<string, 'restrict' | 'permit'> } | null;
  toolFilters: { env: string; kind: 'allow' | 'deny' }[];
  issuingTools: string[];
  selectors: { tool: string; args: Obj; forms: { name: string; args: Obj }[]; sendEmptyForms: boolean }[];
  multiReports: Record<string, { applied: string; id: string }>;
  fixedConstraints: Record<string, { arg: string; pattern: RegExp }[]>;
  tryValues: Record<string, { arg: string; length: number }[]>;
  /** Tools whose backend operation has no version check, as the declaration states (MWS-CONC-5). */
  noVersionCheck: string[];
  /** Members dropped because they were marked guessed, by path. */
  dropped: string[];
  source: string | null;
}

export const EMPTY_DECLARATION: MinDeclaration = { patterns: {}, shape: null, readOnly: null, toolFilters: [], issuingTools: [], selectors: [], multiReports: {}, fixedConstraints: {}, tryValues: {}, noVersionCheck: [], dropped: [], source: null };

const guessed = (n: unknown): boolean => {
  const x = n as { comment?: string | null; commentBefore?: string | null } | null;
  return !!x && [x.comment, x.commentBefore].some((c) => typeof c === 'string' && c.includes(GUESSED.replace(/^#\s*/, '')));
};

/** Removes every pair or item whose key or value carries the guessed marker. */
function prune(n: Node | null | undefined, path: string, dropped: string[]): void {
  if (isMap(n)) {
    n.items = n.items.filter((p) => {
      const k = isScalar(p.key) ? String(p.key.value) : '?';
      if (guessed(p.key) || guessed(p.value)) {
        dropped.push(`${path}${path ? '.' : ''}${k}`);
        return false;
      }
      prune(p.value as Node, `${path}${path ? '.' : ''}${k}`, dropped);
      return true;
    });
  } else if (isSeq(n)) {
    n.items = n.items.filter((it, i) => {
      if (guessed(it)) {
        dropped.push(`${path}[${i}]`);
        return false;
      }
      prune(it as Node, `${path}[${i}]`, dropped);
      return true;
    });
  } else if (isPair(n)) prune(n.value as Node, path, dropped);
}

const re = (v: unknown): RegExp | null => {
  if (typeof v !== 'string' || !v) return null;
  try {
    return new RegExp(v, 'i');
  } catch {
    return null;
  }
};

export function parseDeclaration(text: string, source: string | null = null): MinDeclaration {
  const doc = parseDocument(text);
  const dropped: string[] = [];
  prune(doc.contents as Node, '', dropped);
  const m = doc.toJS() as unknown;
  if (!isObj(m)) return { ...EMPTY_DECLARATION, dropped, source };
  const patterns: Record<string, RegExp> = {};
  for (const block of ['patterns', 'review']) {
    const b = m[block];
    if (isObj(b)) for (const [k, v] of Object.entries(b)) {
      const r = re(v);
      if (r) patterns[k] = r;
    }
  }
  const results = isObj(m['results']) ? m['results'] : {};
  const settings = isObj(m['settings']) ? m['settings'] : {};
  const ro = isObj(settings['read_only']) ? settings['read_only'] : null;
  const readOnly = ro && typeof ro['env'] === 'string' && ro['on'] !== undefined ? { env: ro['env'], on: String(ro['on']), valid: Object.fromEntries(Object.entries(isObj(ro['valid']) ? ro['valid'] : {}).filter(([, v]) => v === 'restrict' || v === 'permit')) as Record<string, 'restrict' | 'permit'> } : null;
  const toolFilters = (Array.isArray(settings['tool_filters']) ? settings['tool_filters'] : []).filter((f): f is Obj => isObj(f) && typeof f['env'] === 'string' && (f['kind'] === 'allow' || f['kind'] === 'deny')).map((f) => ({ env: f['env'] as string, kind: f['kind'] as 'allow' | 'deny' }));
  const secrets = isObj(m['secrets']) ? m['secrets'] : {};
  const out: MinDeclaration = { ...EMPTY_DECLARATION, patterns, shape: typeof results['shape'] === 'string' ? results['shape'] : null, readOnly, toolFilters, issuingTools: Array.isArray(secrets['issuing_tools']) ? (secrets['issuing_tools'] as unknown[]).map(String) : [], selectors: [], multiReports: {}, fixedConstraints: {}, tryValues: {}, noVersionCheck: [], dropped, source };
  for (const r of Array.isArray(m['resources']) ? m['resources'] : []) {
    if (!isObj(r)) continue;
    const sel = isObj(r['selector']) ? r['selector'] : null;
    if (sel && typeof sel['tool'] === 'string') {
      out.selectors.push({ tool: sel['tool'], args: isObj(sel['args']) ? sel['args'] : {}, forms: (Array.isArray(sel['forms']) ? sel['forms'] : []).filter(isObj).map((f) => ({ name: String(f['name'] ?? 'form'), args: isObj(f['args']) ? f['args'] : {} })), sendEmptyForms: sel['send_empty_forms'] === true });
    }
    for (const x of Array.isArray(r['multi']) ? r['multi'] : []) {
      if (isObj(x) && typeof x['tool'] === 'string' && isObj(x['report']) && typeof x['report']['applied'] === 'string') out.multiReports[x['tool']] = { applied: x['report']['applied'] as string, id: typeof x['report']['id'] === 'string' ? x['report']['id'] : 'id' };
    }
    for (const t of Array.isArray(r['no_version_check']) ? r['no_version_check'] : []) if (typeof t === 'string') out.noVersionCheck.push(t);
    const upd = isObj(r['update']) && typeof r['update']['tool'] === 'string' ? (r['update']['tool'] as string) : null;
    if (upd) {
      const fc = (Array.isArray(r['fixed_constraints']) ? r['fixed_constraints'] : []).filter(isObj).map((f) => ({ arg: String(f['arg']), pattern: re(f['pattern']) })).filter((f): f is { arg: string; pattern: RegExp } => f.pattern !== null);
      if (fc.length) out.fixedConstraints[upd] = [...(out.fixedConstraints[upd] ?? []), ...fc];
      const tv = (Array.isArray(r['try_values']) ? r['try_values'] : []).filter(isObj).filter((t) => typeof t['length'] === 'number').map((t) => ({ arg: String(t['arg']), length: t['length'] as number }));
      if (tv.length) out.tryValues[upd] = [...(out.tryValues[upd] ?? []), ...tv];
    }
  }
  return out;
}

export function readDeclaration(file: string): MinDeclaration {
  return parseDeclaration(readFileSync(file, 'utf8'), file);
}
