/**
 * An adopted result shape (spec 7.3, rule 11, and the draft Annex B-9 "write-result"): "a structured field that the
 * declaration names for the purpose decides like a declared pattern, and so does an adopted library by name and version".
 * The declaration adopts the shape by name and version (`results: { shape: write-result/0.1 }`, at the top level or per
 * tool), so a tester does not declare fields one by one. Where a tool adopts it and a result carries it, its well-formed
 * members decide what that result *says* (the outcome, the repeat it allows, the read it names, what it reports changed,
 * per item, the conflict state, the receipt, a replay), and the record quotes the member and its value. What actually
 * happened is still decided by the read-back.
 *
 * Reading rules (B-9 v2, "how a tester uses it"):
 *   - the shape is `structuredContent.mws`, an object whose `shape` is exactly `write-result/0.1`: before 1.0 a reader
 *     reads only the version it knows, and another 0.x or another MAJOR is read as no shape;
 *   - each member is read on its own: a member whose value does not have the form B-9 gives decides nothing, and the
 *     record quotes it as an observation; the other members are still read, also where `outcome` is missing or malformed
 *     (so dropping `outcome` cannot hide `repeat: "yes"`); so does a `read_with.tool` the server does not list, or one the
 *     tester cannot check because it has no tool list;
 *   - identifiers and versions are a string or an integer (within ±(2^53−1)), compared as strings;
 *   - where structuredContent carries no shape (an SDK that drops it on an error), a text block that is the serialized
 *     JSON of structuredContent is read instead, and the record says so;
 *   - the shape never decides what the read-back decides, and a text that contradicts a member can still give `violated`
 *     where a declared pattern reads it so (both are content, spec section 4).
 */

import type { Manifest } from '../core/manifest.js';

/** The shapes a declaration can adopt, by name and version (MAJOR.MINOR). */
export const RESULT_SHAPES = ['write-result/0.1'] as const;
export type ShapeName = (typeof RESULT_SHAPES)[number];
const SHAPE_RE = /^write-result\/(\d+)\.(\d+)$/;
/** The 14 codes B-9 reserves (v2, and not_permitted), with the outcome each goes with. A code it does not reserve is free content. */
export const RESERVED_CODES: Record<string, string> = {
  conflict: 'not_applied', locked: 'not_applied', version_required: 'not_applied', invalid_argument: 'not_applied', not_found: 'not_applied',
  idempotency_key_reused: 'not_applied', in_progress: 'unknown', key_not_known: 'unknown', unavailable: 'not_applied', not_permitted: 'not_applied', not_sent: 'not_applied',
  no_answer: 'unknown', backend_error: 'unknown', internal_error: 'unknown',
};

export const OUTCOMES = ['applied', 'not_applied', 'partial', 'unknown', 'accepted'] as const;
export type Outcome = (typeof OUTCOMES)[number];
export const REPEATS = ['no', 'yes', 'same_key', 'same_version', 'read_first'] as const;
export type Repeat = (typeof REPEATS)[number];
export const ITEM_OUTCOMES = ['applied', 'not_applied', 'not_attempted', 'unknown'] as const;
export type ItemOutcome = (typeof ITEM_OUTCOMES)[number];

/** An identifier or a version: a string, or an integer within ±(2^53−1) (B-9 v2). */
export type IdV = string | number;
export interface ConflictMember { current_version?: IdV; checked_by?: 'backend' | 'server'; current_state?: Record<string, unknown>; omitted?: string[]; held_by?: string }
export interface ShapeItem {
  index?: number;
  step?: string;
  id?: IdV;
  version?: IdV;
  outcome?: ItemOutcome;
  code?: string;
  message?: string;
  conflict?: ConflictMember;
}
/** The well-formed members of one result's shape (malformed members are left out and listed in `bad`). */
export interface WriteResult {
  shape: string;
  /** Required by B-9, but read on its own: absent here where it is missing or malformed (the other members still decide). */
  outcome?: Outcome;
  repeat?: Repeat;
  operation?: string;
  object?: { type?: string; id?: IdV; version?: IdV; scope?: string; parent?: { type?: string; id?: IdV; version?: IdV } };
  changed?: string[];
  replayed?: true;
  items?: ShapeItem[];
  applied_count?: number;
  code?: string;
  message?: string;
  argument?: string;
  argument_errors?: { argument: string; code?: string; message?: string }[];
  conflict?: ConflictMember;
  read_with?: { tool: string; arguments: Record<string, unknown> };
  version_argument?: string;
}

/**
 * What a call's answer carried of a shape, captured for every call (cheap; whether it counts is decided at evaluation, from
 * the declaration): `structuredContent.mws`, and the `mws` member of each text block that is a JSON object. Kept in
 * observations, so `recheck` reads it again under a later rule.
 */
export interface ShapeCapture {
  /** structuredContent.mws, or null where structuredContent carries no `mws` member. */
  sc: unknown;
  /** The `mws` member of each text block that is a JSON object carrying one, in order. */
  texts: unknown[];
  /** The result carried structuredContent (B-9 v2 reads a JSON text block as the shape only where it carries none); absent in older evidence. */
  has_sc?: boolean;
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isStr = (x: unknown): x is string => typeof x === 'string';

/** The capture for one result, or null where neither structuredContent nor a text block carries an `mws` member. */
export function captureShape(structured: unknown, texts: string[]): ShapeCapture | null {
  const sc = isObj(structured) && Object.hasOwn(structured, 'mws') ? structured['mws'] : null;
  const ts: unknown[] = [];
  for (const t of texts) {
    const s = t.trim();
    if (!s.startsWith('{')) continue;
    try {
      const o: unknown = JSON.parse(s);
      if (isObj(o) && Object.hasOwn(o, 'mws')) ts.push(o['mws']);
    } catch {
      /* prose */
    }
  }
  return sc !== null || ts.length ? { sc, texts: ts, has_sc: structured !== undefined && structured !== null } : null;
}

// ------------------------------------------------------------------------------------------------ the declaration in use

let declared: Manifest['results'] = { shape: null, tools: {} };
let listed: Set<string> | null = null;

/** Set the declaration's adopted shapes for the evaluation that follows (run and recheck call this with usePatterns). */
export function useShapes(m: Pick<Manifest, 'results'> | null | undefined, tools?: { name: string }[] | null): void {
  declared = m?.results ? { shape: m.results.shape, tools: { ...m.results.tools } } : { shape: null, tools: {} };
  listed = tools ? new Set(tools.map((t) => t.name)) : null;
}

/** The tools the server lists (for `read_with.tool`); set once the catalog is known. */
export function useShapeCatalog(tools: { name: string }[] | null): void {
  listed = tools ? new Set(tools.map((t) => t.name)) : null;
}

/** The shape a tool adopts (its own entry, else the top-level one), or null. */
export function adoptedBy(tool: string | null | undefined): ShapeName | null {
  if (tool && Object.hasOwn(declared.tools, tool)) return declared.tools[tool] ?? null;
  return declared.shape;
}

/** The adopted shapes, for the results header (the declaration as used). */
export function shapesInEffect(): { shape: ShapeName | null; tools: Record<string, ShapeName | null> } {
  return { shape: declared.shape, tools: { ...declared.tools } };
}

// ------------------------------------------------------------------------------------------------ reading

/**
 * The text a check keeps for reading what a result says (B-9 v2, "Free words and the serialized block"): for a tool that adopts
 * the shape and a result that carries one, the text blocks without the serialized structuredContent and without a JSON block
 * carrying the shape; otherwise the whole text, as before.
 */
export function readText(r: { tool?: string | null; text: string | null; prose_text?: string | null }): string | null {
  return r.prose_text !== undefined && adoptedBy(r.tool ?? null) ? r.prose_text : r.text;
}


export type ShapeRead =
  | { status: 'none' }
  | { status: 'unread'; shape: ShapeName; why: string }
  | { status: 'ok'; shape: ShapeName; v: WriteResult; where: string; bad: string[] };

/** What a call brief needs for the shape to be read. */
export interface ShapeCarrier {
  tool?: string | null;
  shape?: ShapeCapture | null;
  data?: unknown;
  text?: string | null;
}

const pointer = (x: unknown): x is string => isStr(x) && (x === '' || x.startsWith('/'));

/**
 * The well-formed members of a shape object, and an observation for each malformed one (B-9: a member whose value does not
 * have the form given decides nothing). Null, with the reason, where the shape decides nothing at all.
 */
export function parseShape(o: unknown, adopted: ShapeName): { v: WriteResult; bad: string[] } | { why: string } {
  if (!isObj(o)) return { why: `structuredContent.mws is ${JSON.stringify(o)}, not an object` };
  const m = isStr(o['shape']) ? SHAPE_RE.exec(o['shape']) : null;
  if (!m) return { why: `mws.shape is ${JSON.stringify(o['shape'] ?? null)}, not write-result/MAJOR.MINOR` };
  // why: B-9 v2: before 1.0 a reader reads only the version it knows; another 0.x, like another MAJOR, is read as no shape.
  if (o['shape'] !== adopted) return { why: `mws.shape is ${JSON.stringify(o['shape'])}, not the adopted ${adopted}; before version 1.0 another version is read as no shape` };
  const v: WriteResult = { shape: o['shape'] as string };
  const bad: string[] = [];
  // why: B-9 v2 and rule 11 (SF-3): outcome is required, but a missing or malformed one decides nothing on its own; the other members are still read.
  if ((OUTCOMES as readonly unknown[]).includes(o['outcome'])) v.outcome = o['outcome'] as Outcome;
  else bad.push(`mws.outcome = ${JSON.stringify(o['outcome'] ?? null)} is ${Object.hasOwn(o, 'outcome') ? 'not one of ' + OUTCOMES.join(', ') : 'missing (it is required)'} and decides nothing; the other members are still read`);
  const take = <K extends keyof WriteResult>(k: K, ok: boolean, val: WriteResult[K]) => {
    if (!Object.hasOwn(o, k)) return;
    if (ok) v[k] = val;
    else bad.push(`mws.${k} = ${JSON.stringify(o[k])} does not have the form B-9 gives it and decides nothing`);
  };
  take('repeat', (REPEATS as readonly unknown[]).includes(o['repeat']), o['repeat'] as Repeat);
  take('operation', isStr(o['operation']) && o['operation'] !== '', o['operation'] as string);
  const ob = o['object'];
  const par = isObj(ob) ? ob['parent'] : undefined;
  take('object', isObj(ob) && ['type', 'scope'].every((k) => !Object.hasOwn(ob, k) || isStr(ob[k])) && ['id', 'version'].every((k) => !Object.hasOwn(ob, k) || idv(ob[k])) && (par === undefined || (isObj(par) && (!Object.hasOwn(par, 'type') || isStr(par['type'])) && ['id', 'version'].every((k) => !Object.hasOwn(par, k) || idv(par[k])))), ob as WriteResult['object']);
  take('changed', Array.isArray(o['changed']) && (o['changed'] as unknown[]).every(pointer), o['changed'] as string[]);
  take('replayed', o['replayed'] === true, true);
  const items = o['items'];
  take(
    'items',
    Array.isArray(items) &&
      items.every((it) => isObj(it) && (!Object.hasOwn(it, 'index') || (Number.isInteger(it['index']) && (it['index'] as number) >= 0)) && ['step', 'code', 'message'].every((k) => !Object.hasOwn(it, k) || isStr(it[k])) && ['id', 'version'].every((k) => !Object.hasOwn(it, k) || idv(it[k])) && (Object.hasOwn(it, 'index') || Object.hasOwn(it, 'step') || Object.hasOwn(it, 'id')) && (ITEM_OUTCOMES as readonly unknown[]).includes(it['outcome']) && (!Object.hasOwn(it, 'conflict') || conflictOk(it['conflict']))),
    items as ShapeItem[],
  );
  take('applied_count', Number.isInteger(o['applied_count']) && (o['applied_count'] as number) >= 0, o['applied_count'] as number);
  take('code', isStr(o['code']) && /^[a-z0-9_]+$/.test(o['code']), o['code'] as string);
  take('message', isStr(o['message']), o['message'] as string);
  take('argument', pointer(o['argument']), o['argument'] as string);
  const ae = o['argument_errors'];
  take('argument_errors', Array.isArray(ae) && ae.every((e) => isObj(e) && pointer(e['argument']) && (!Object.hasOwn(e, 'code') || (isStr(e['code']) && /^[a-z0-9_]+$/.test(e['code']))) && (!Object.hasOwn(e, 'message') || isStr(e['message']))), ae as WriteResult['argument_errors']);
  take('conflict', conflictOk(o['conflict']), o['conflict'] as WriteResult['conflict']);
  const rw = o['read_with'];
  const rwOk = isObj(rw) && isStr(rw['tool']) && isObj(rw['arguments']);
  // why: B-9 v2: a read_with.tool the server does not list, or one the tester cannot check (no tool list), decides nothing.
  if (rwOk && !listed) bad.push(`mws.read_with.tool = ${JSON.stringify(rw['tool'])} could not be checked against the server's tool list (none was available), so read_with decides nothing`);
  else if (rwOk && listed && !listed.has(rw['tool'] as string)) bad.push(`mws.read_with.tool = ${JSON.stringify(rw['tool'])} is not a tool the server lists, so read_with decides nothing`);
  else take('read_with', rwOk, rw as WriteResult['read_with']);
  take('version_argument', isStr(o['version_argument']) && o['version_argument'] !== '', o['version_argument'] as string);
  // why: B-9 "conflict": present only where code is conflict or locked; a conflict member otherwise is still read (it is well formed) but noted.
  if (v.conflict && v.code !== 'conflict' && v.code !== 'locked') bad.push(`mws.conflict is present while mws.code is ${JSON.stringify(v.code ?? null)} (B-9 gives it only with conflict or locked); it is read as given`);
  return { v, bad };
}

/** An identifier or a version: a string, or an integer within ±(2^53−1). */
const idv = (x: unknown): boolean => isStr(x) || (Number.isSafeInteger(x) as boolean);

function conflictOk(c: unknown): boolean {
  return isObj(c) && (!Object.hasOwn(c, 'current_version') || idv(c['current_version'])) && (!Object.hasOwn(c, 'checked_by') || c['checked_by'] === 'backend' || c['checked_by'] === 'server') && (!Object.hasOwn(c, 'current_state') || isObj(c['current_state'])) && (!Object.hasOwn(c, 'omitted') || (Array.isArray(c['omitted']) && (c['omitted'] as unknown[]).every(pointer))) && (!Object.hasOwn(c, 'held_by') || isStr(c['held_by']));
}

/** The capture of a brief: recorded with the call, or (older evidence) structuredContent kept as data. */
function captureOf(b: ShapeCarrier): ShapeCapture | null {
  // why: a capture recorded with the call (null: the answer carried none) is final; only older evidence is captured from its data.
  if (b.shape !== undefined) return b.shape;
  return captureShape(b.data, b.text ? b.text.split('\n') : []);
}

/**
 * The adopted shape as one result carries it: `none` where the tool adopts no shape; `unread` (with the reason) where it
 * decides nothing; `ok` with its well-formed members otherwise.
 */
export function readShape(b: ShapeCarrier | null | undefined): ShapeRead {
  if (!b) return { status: 'none' };
  const name = adoptedBy(b.tool ?? null);
  if (!name) return { status: 'none' };
  const cap = captureOf(b);
  if (!cap) return { status: 'unread', shape: name, why: 'the result carries no shape (no mws member in structuredContent or in a JSON text block)' };
  const fromSc = cap.sc !== null && cap.sc !== undefined;
  // why: B-9 v2: a JSON text block is read as the shape only where the result carries no structuredContent.
  if (!fromSc && cap.has_sc) return { status: 'unread', shape: name, why: 'structuredContent carries no mws member; a JSON text block that carries one is read as the shape only where the result has no structuredContent (B-9 v2)' };
  const src = fromSc ? cap.sc : cap.texts[0];
  const p = parseShape(src, name);
  if ('why' in p) return { status: 'unread', shape: name, why: p.why };
  const notes = [...p.bad];
  if (fromSc && !cap.texts.length) notes.push('no text block carries the serialized structuredContent (B-9, "Text"); a client that forwards only content does not show the shape to the model');
  if (fromSc && cap.texts.length && JSON.stringify(sortKeys(cap.texts[0])) !== JSON.stringify(sortKeys(cap.sc))) notes.push('the JSON text block and structuredContent carry different shapes; structuredContent was read, and each text block is read by the patterns through its free words only');
  return { status: 'ok', shape: name, v: p.v, where: fromSc ? 'structuredContent.mws' : 'the JSON text block (structuredContent carries none)', bad: notes };
}

/** The shape where it is adopted and decides, else null. */
export function shapeOf(b: ShapeCarrier | null | undefined): WriteResult | null {
  const r = readShape(b);
  return r.status === 'ok' ? r.v : null;
}

/** The members B-9 v2 defines (a member it does not define is free content). */
const DEFINED = ['shape', 'outcome', 'repeat', 'operation', 'object', 'changed', 'replayed', 'items', 'applied_count', 'code', 'message', 'argument', 'argument_errors', 'conflict', 'read_with', 'version_argument'];

/**
 * The data a text pattern reads (B-9 v2, "Free words and the serialized block"): for a tool that adopts the shape,
 * `structuredContent.mws` is replaced by its free words only (`message`, an item's `message`, an `argument_errors` entry's
 * `message`, `conflict.held_by`, a code the version does not reserve, and members it does not define). Member names and
 * fixed values are not sentences: a pattern for "applied" does not match `"outcome":"applied"`. The tool's own output is
 * kept as it is.
 */
export function patternData(b: ShapeCarrier): unknown {
  const d = b.data;
  if (!isObj(d) || !Object.hasOwn(d, 'mws') || !adoptedBy(b.tool ?? null)) return d ?? null;
  const m = d['mws'];
  if (!isObj(m)) return d;
  return { ...d, mws: freeOf(m) };
}

/** The free words of a shape object (B-9 v2): `message`, items' and argument errors' `message`, `conflict.held_by`, a code the version does not reserve, and members it does not define. */
function freeOf(m: Record<string, unknown>): unknown[] {
  const free: unknown[] = [];
  if (isStr(m['message'])) free.push(m['message']);
  if (isStr(m['code']) && !Object.hasOwn(RESERVED_CODES, m['code'])) free.push(m['code']);
  for (const it of Array.isArray(m['items']) ? m['items'] : []) if (isObj(it) && isStr(it['message'])) free.push(it['message']);
  for (const e of Array.isArray(m['argument_errors']) ? m['argument_errors'] : []) if (isObj(e) && isStr(e['message'])) free.push(e['message']);
  if (isObj(m['conflict']) && isStr(m['conflict']['held_by'])) free.push(m['conflict']['held_by']);
  for (const k of Object.keys(m)) if (!DEFINED.includes(k)) free.push(m[k]);
  return free;
}

/**
 * The free words of the shape a text block carries, as lines of text (B-9 v2: "the free words and members just named are read
 * in that block as in structuredContent"): what the text patterns read of a block that is left out of the prose. Strings only,
 * found anywhere in a free member; never a member name or a fixed value. Empty where the block carries no shape object.
 */
export function freeWordsOfBlock(mws: unknown): string[] {
  if (!isObj(mws)) return [];
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (isStr(v)) out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (isObj(v)) Object.values(v).forEach(walk);
  };
  freeOf(mws).forEach(walk);
  return out.filter((x) => x.trim() !== '');
}

/** The shape where it is adopted and decides and its `outcome` is well formed (for the readings that start from the outcome). */
export function outcomeShape(b: ShapeCarrier | null | undefined): (WriteResult & { outcome: Outcome }) | null {
  const s = shapeOf(b);
  return s && s.outcome ? (s as WriteResult & { outcome: Outcome }) : null;
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (isObj(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}

// ------------------------------------------------------------------------------------------------ the record

/** `mws.outcome = "applied"`: a member and its value as the record quotes it. */
export const quoteField = (field: string, value: unknown): string => `mws.${field} = ${JSON.stringify(value)}`;

/** The rule-11 line for a record decided by the shape: the members relied on, quoted, and the source. */
export function decidedByShape(fields: Record<string, unknown> | [string, unknown][], b?: ShapeCarrier | null): string {
  const list = (Array.isArray(fields) ? fields : Object.entries(fields)).filter(([, v]) => v !== undefined);
  const r = b ? readShape(b) : null;
  const name = r && r.status === 'ok' ? r.v.shape : (b && adoptedBy(b.tool ?? null)) ?? 'write-result/0.1';
  const extra = r && r.status === 'ok' && r.bad.length ? ` Observations: ${r.bad.join('; ')}.` : '';
  return `What the result says was decided by the adopted result shape ${name}${r && r.status === 'ok' && r.v.shape !== adoptedBy(b?.tool ?? null) ? ` (adopted as ${adoptedBy(b?.tool ?? null)})` : ''}, on ${list.map(([k, v]) => quoteField(k, v)).join(', ')} (spec 7.3, rule 11).${extra}`;
}

/** The note for a result whose adopted shape decided nothing. */
export function shapeFallbackNote(b: ShapeCarrier | null | undefined): string | null {
  const r = readShape(b);
  if (r.status !== 'unread') return null;
  return `The adopted result shape ${r.shape} decided nothing in this result: ${r.why}. What the result says was left to rule 11's other sources (the declared patterns, or a person's reading); a shape that is not read never gives held (spec 7.3, rule 11).`;
}

// ------------------------------------------------------------------------------------------------ what the shape says

const same = (a: unknown, b: unknown): boolean => a !== undefined && a !== null && b !== undefined && b !== null && (typeof a === 'object' || typeof b === 'object' ? JSON.stringify(a) === JSON.stringify(b) : String(a) === String(b));

/** A field path of the declaration (`details.component`, `labels[1]`) as a JSON Pointer (`/details/component`, `/labels/1`). */
export function toPointer(path: string): string {
  const segs = path.replace(/\[(\d+)\]/g, '.$1').replace(/\[[^\]]*\]/g, '').split('.').filter(Boolean);
  return segs.map((s) => '/' + s.replace(/~/g, '~0').replace(/\//g, '~1')).join('');
}

/**
 * Does the shape list a field as changed (B-9 v2, *Changed fields*): the field's pointer, a pointer below it, or one above it.
 * `""` names every field only for a create or a delete (`whole`); for an update the fields are named one by one.
 */
export function shapeNamesField(s: WriteResult, path: string, whole = false): boolean {
  const p = toPointer(path);
  return (s.changed ?? []).some((c) => (c === '' ? whole : c === p || c.startsWith(`${p}/`) || p.startsWith(`${c}/`)));
}

/** The state the outcome reports for the write as a whole: the change in effect (`applied`), not, or not stated. */
export const reportsSuccess = (s: WriteResult, async: boolean): boolean => s.outcome === 'applied' || (s.outcome === 'accepted' && !async);

/** Reserved codes (B-9 v2) say what they define; a code the version does not reserve is free content and decides nothing. */
export const reservedCode = (s: WriteResult | null | undefined): string | null => (s?.code && Object.hasOwn(RESERVED_CODES, s.code) ? s.code : null);

/**
 * `repeat` as B-9 v2's "How a tester uses it" reads it: `same_key` / `same_version` name the key or version only where the
 * call carried one (the trial records it, `CallBrief.carried`; only older evidence, which does not, takes them as given); `read_first` names a read where `read_with` (listed) or
 * `object.id` gives one, or the text names one (`textNamesRead`); otherwise each is read as `yes`.
 */
export function effectiveRepeat(s: WriteResult, o: { carriedKey?: boolean; carriedVersion?: boolean; textNamesRead?: boolean } = {}): Repeat | undefined {
  const r = s.repeat;
  if (r === 'same_key' && o.carriedKey === false) return 'yes';
  if (r === 'same_version' && o.carriedVersion === false) return 'yes';
  if (r === 'read_first' && !s.read_with && (s.object?.id === undefined) && !o.textNamesRead) return 'yes';
  return r;
}

/**
 * The outcome the shape gives an item (B-9 v2, *Items*): its entry in `items`, found by `index` where the tester knows the
 * item's position in the call, else by `id`; an unlisted item is applied where `applied_count` covers it, else takes the
 * top-level outcome only where that is `applied` or `not_applied`; otherwise its outcome is not stated (`unknown`).
 */
export function itemStatus(s: WriteResult, id: unknown, index?: number): ItemOutcome {
  // why: the position in the list the call sent wins over an id match at another position.
  const it = (index !== undefined ? (s.items ?? []).find((x) => x.index === index) : undefined) ?? (s.items ?? []).find((x) => x.id !== undefined && same(x.id, id));
  if (it && it.outcome) return it.outcome;
  if (s.applied_count !== undefined && s.applied_count > 0) return 'applied';
  if (s.outcome === 'applied') return 'applied';
  if (s.outcome === 'not_applied') return 'not_applied';
  return 'unknown';
}

/**
 * Does the shape identify a change that stayed applied (MWS-RES-2 second clause, ATOM-1, RETRY-2)? Under `applied`, the
 * field among `changed`, or the object or version named; under `partial`, the field among `changed`; under `partial` or
 * `unknown`, an item listed as applied whose id is the value (for a create). `not_applied` identifies nothing (it says nothing
 * remains).
 */
export function shapeIdentifies(s: WriteResult, path: string, value?: unknown): boolean {
  if (s.outcome === 'not_applied' || s.outcome === 'accepted') return false;
  const v = value !== undefined && value !== null && value !== '' ? value : undefined;
  if (v !== undefined && (s.items ?? []).some((it) => it.outcome === 'applied' && same(it.id, v))) return true;
  // why: B-9 v2: changed names the fields whose stored value the write changed, also where only part of the write was applied.
  if (s.outcome === 'partial') return shapeNamesField(s, path);
  if (s.outcome !== 'applied') return false;
  if (v !== undefined && same(s.object?.id, v) && String(v) === path) return true;
  if (v !== undefined && same(s.object?.version, v)) return true;
  return shapeNamesField(s, path);
}

export { same as sameValue };
