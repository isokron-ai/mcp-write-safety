/**
 * Bystander inventory (gate-2 re-run on 169b0cb, safety items S1 to S3; re-run on 6b028ec, note 14): before and after every
 * call of the targeting checks, the tester lists what it can list outside its own objects (every scope the scope resource
 * lists, the default scope, and the scopes themselves), and every object that is gone, changed or missing afterwards goes into
 * the record. An object is the tester's own only when this run's ledger holds its id; a name that carries the run prefix is
 * not enough (note 14 item 6, c4 and c5: a server can make objects whose names carry it). Everything else is a bystander.
 *
 * A declared fixture under another key (corpus target t14, run 44406854696): two resources over one table, the fixture
 * resource keyed by a text id and the create resource by the row number. The second resource's list shows the first one's
 * fixture under the row number, which no ledger entry and no fixture id names, so every write the tester made to its own
 * fixture read as "an object the tester did not create was changed". Such an entry is recognised (`fixtureForms`): the list
 * and the fixture's read go through the same tool with the same fixed arguments, the fixture read by its own id carries the
 * entry's key, and the two forms are equal. It stays in the inventory; only the fields the declaration lets the tester
 * write on the fixture (`fields`, `restorable`) are left out of the comparison. Gone, missing, made again, or changed in
 * any other field, it is reported like every other bystander.
 *
 * The inventory cannot be complete from the server's own lists, so it is made honest instead (note 14, "what I take from
 * it"): every inventory says what it listed (which scopes, how many objects, through which lists, and whether an answer
 * showed a further page), and what it could not list (`partial`). A record whose call can remove objects (a selector call)
 * is never `held` on a partial inventory; "not seen to be lost" is the most any record says.
 *
 * Gone: only a read by id that says the object does not exist (an error that says not found, a sentence that says so, or
 * the server's own answer for an id that never existed). Around a selector call every bystander is read back by id where the
 * resource has a read by id, before and after, whether or not the list still shows it (a list can lag behind deletes, note 14
 * item 5, i4); a change of the read form counts as changed (a soft delete the list hides, i5). An object missing from a list
 * that cannot be read by id is listed again; still missing, it is reported as missing, not confirmed gone: it blocks `held`
 * and never makes `violated` (note 14 item 4, i11).
 *
 * Changed: the listed form (and around a selector call the read form) differs, outside the fields that change by themselves:
 * `read.ignore`, the list's own `ignore`, a field that differs again between two listings with no call in between, and a
 * value that is a time or an age on both sides (note 14 item 2, i12 and Kubernetes' `Age`); around a selector call only an
 * age that grew is set aside at once, and an ISO time only where a listing with no call in between shows it moving. A change is reported but not
 * attributed to the call (other activity can change an object), so it blocks `held` and does not make `violated`.
 */

import { baseVars, callKind, objectFrom, sameFixedArgs } from '../core/driver.js';
import type { ListSpec, ResourceSpec } from '../core/manifest.js';
import { definitelyGone, goneByAnswer, notFoundAnswer, notFoundWithoutError, readsById } from '../core/objects.js';
import { listAll } from '../core/lists.js';
import { render } from '../core/template.js';
import { diff, getPath, short, withoutIgnored } from '../core/util.js';
import type { RunContext } from './types.js';

interface Entry {
  /** The listed form. */
  item: unknown;
  /** The read form (a read by id before the call), where one was taken: null when the read did not show the object. */
  read?: unknown;
  scope: unknown;
  id: unknown;
  /** The resource the entry belongs to (the scope resource for a scope). */
  res: string;
  /** Paths of the listed form that change by themselves. */
  ignore: string[];
  /**
   * Set where the entry is another resource's declared fixture, listed here under this resource's key: the fields the
   * declaration lets the tester write on it. They are left out of the listed and the read form alike.
   */
  own_fields?: string[];
}

export interface Inventory {
  /** key -> entry; key is `scope:<key>` for a scope, `<scope>/<id>` for an object. */
  items: Map<string, Entry>;
  /** Why no inventory could be taken (a list failed or none is declared); null when it was taken. */
  unavailable: string | null;
  /** What the inventory is known not to cover (a scope list that cannot be listed, a further page, a list that needs an id). */
  partial: string[];
  /** What was listed. */
  covered: Coverage;
}

export interface Coverage {
  /** Scopes listed, outside the tester's own. */
  scopes: unknown[];
  /** Objects outside the tester's own that the lists showed. */
  objects: number;
  /** The list calls the inventory used. */
  lists: string[];
  /** Whether every bystander was read back by id around the call. */
  read_back_by_id: boolean;
  /** Entries that are a declared fixture of another resource, listed under this resource's key, with the fields left out. */
  fixtures?: string[];
}

export interface Loss {
  /** Objects outside the tester's own that are gone after the call (a read by id says so). */
  gone: string[];
  /** Objects outside the tester's own whose listed or read form changed. */
  changed: string[];
  /** Objects missing from every listing afterwards that cannot be read by id: not confirmed gone, a loss not ruled out. */
  missing?: string[];
  /** The inventory could not be taken before or after: a loss cannot be ruled out. */
  unavailable: string | null;
  /** What the inventory did not cover. */
  partial?: string[];
  /** What it listed (before the call). */
  covered?: Coverage;
  /** Fields set aside as changing by themselves. */
  volatile?: string[];
}

export const noLoss = (l: Loss | null | undefined): boolean => !!l && !l.unavailable && !l.gone.length && !l.changed.length && !(l.missing ?? []).length;
/** Gone, changed or missing (a loss that blocks `held`). */
export const anyLoss = (l: Loss | null | undefined): boolean => !!l && (l.gone.length > 0 || l.changed.length > 0 || (l.missing ?? []).length > 0);
export const lossText = (l: Loss): string =>
  [l.gone.length ? `gone: ${l.gone.join(', ')}` : '', l.changed.length ? `changed: ${l.changed.join(', ')}` : '', (l.missing ?? []).length ? `missing from every listing and not readable by id: ${l.missing!.join(', ')}` : ''].filter(Boolean).join('; ');
export const BYSTANDER_NOTE = 'Objects the tester did not create were changed or deleted';

/** A sentence saying what an inventory listed. */
export function coverageText(c: Coverage | undefined, partial: string[] = []): string {
  if (!c) return 'the inventory listed nothing';
  const scopes = c.scopes.length ? `${c.scopes.length} scope(s) outside the tester's own (${c.scopes.map((s) => short(s, 30)).join(', ')})` : 'no scope outside the tester\'s own';
  return `the inventory listed ${scopes} and ${c.objects} object(s) outside the tester's own, through ${c.lists.length ? [...new Set(c.lists)].join(', ') : 'no list'}${c.read_back_by_id ? ', and read each object back by id' : ''}${c.fixtures?.length ? `; of these, ${c.fixtures.join('; ')}` : ''}; ${partial.length ? `it did not cover: ${partial.join('; ')}` : 'no answer showed a further page'}. Objects these lists do not show are not covered`;
}

/** A value that is a time or an age (an ISO time, `5s`, `2m30s`, `3d`): one that changes by itself. */
const TIMEISH = /^(\d{4}-\d{2}-\d{2}[T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?|\d+(\.\d+)?(ms|s|m|h|d)(\d+(ms|s|m|h|d))*)$/;
const timeish = (v: unknown): boolean => typeof v === 'string' && TIMEISH.test(v.trim());
/** An ISO time (not an age): a field that moves only when the object is written or made again (i8). */
const isoTime = (v: unknown): boolean => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}[T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?$/.test(v.trim());
/** An age in milliseconds (`5s`, `2m30s`, `3d`), or null for anything else. */
function ageMs(v: unknown): number | null {
  if (typeof v !== 'string' || !/^(\d+(\.\d+)?(ms|s|m|h|d))+$/.test(v.trim())) return null;
  const unit: Record<string, number> = { ms: 1, s: 1e3, m: 6e4, h: 3.6e6, d: 8.64e7 };
  let t = 0;
  for (const m of v.trim().matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/g)) t += Number(m[1]) * unit[m[2]!]!;
  return t;
}

const needsId = (args: unknown): boolean => /\{\{\s*(json:)?id\b/.test(JSON.stringify(args ?? null));
// why: review: an optional `{{?marker}}` filter is dropped when the marker is unset, so such a list still lists everything.
const needsMarker = (args: unknown): boolean => /\{\{\s*(json:)?\s*(marker|key)\b/.test(JSON.stringify(args ?? null));

/** The list block an inventory uses for a resource without scopes: its own list block, else a read through a list. */
const listOf = (r: ResourceSpec): ListSpec | null => r.list ?? (r.read.items ? { tool: r.read.tool, args: r.read.args, items: r.read.items, id: r.read.match ?? 'id', name: 'name', ignore: [], next: null } : null);

/**
 * Gate-2 re-run on 0295ed6 (nx1-x-lie): a list read page by page (list.next) cannot show by itself that its pages are complete: a
 * cursor that ends early, with no sign, looks like the last page. Where such a list leaves out an object that an earlier listing
 * showed and that still reads back by id, its paging is shown not to be complete; from then on, in this run, every inventory that
 * reads that list (for that scope) is partial (spec R10 Q8: a partial inventory never gives `held` to a selector record).
 * Kept per session (one per run).
 */
const pagingIncomplete = new WeakMap<object, Map<string, string>>();
const pagingKey = (tool: string, scope: unknown) => `${tool}|${JSON.stringify(scope ?? null)}`;
const pagingOf = (ctx: RunContext): Map<string, string> => {
  let m = pagingIncomplete.get(ctx.session);
  if (!m) pagingIncomplete.set(ctx.session, (m = new Map()));
  return m;
};
/** The list block an entry was listed through (the scope resource's list for a scope entry). */
function listOfEntry(ctx: RunContext, k: string, e: Entry): ListSpec | null {
  const r = ctx.manifest.resources.find((x) => x.name === e.res);
  if (!r) return null;
  if (k.startsWith('scope:')) return listOf(r);
  return r.scope ? r.scope.list : listOf(r);
}
/**
 * An entry an earlier listing showed is not in a later one and still reads back by id. For a list read through list.next this
 * shows the paging is not complete: it is recorded for the run and returned as a partial reason; null for an unpaged list (a list
 * that leaves an entry out now and then is covered by the reads by id, i13).
 */
function notListedButPresent(ctx: RunContext, k: string, e: Entry): string | null {
  const l = listOfEntry(ctx, k, e);
  if (!l || !l.next) return null;
  const scope = k.startsWith('scope:') ? null : e.scope;
  const why = `${l.tool}${scope !== null && scope !== undefined ? ` (scope ${JSON.stringify(scope)})` : ''} read to its last page did not show ${k}, which an earlier listing showed and which still reads back by id, so its paging is not shown to be complete (a cursor that ends early or skips); objects it does not show are not covered`;
  const m = pagingOf(ctx);
  const key = pagingKey(l.tool, scope);
  if (!m.has(key)) m.set(key, why);
  return m.get(key)!;
}

export async function inventory(ctx: RunContext, res: ResourceSpec, label: string, o: { readById?: boolean } = {}): Promise<Inventory> {
  const inv: Inventory = { items: new Map(), unavailable: null, partial: [], covered: { scopes: [], objects: 0, lists: [], read_back_by_id: false } };
  try {
    return await take(ctx, res, label, o, inv);
  } catch (e) {
    // why: note 14 item 3 (Payload P5): the inventory never makes the check fail; what it cannot do, it says.
    return { ...inv, unavailable: `the inventory could not be taken: ${short((e as Error).message, 160)}` };
  }
}

async function take(ctx: RunContext, res: ResourceSpec, label: string, o: { readById?: boolean }, inv: Inventory): Promise<Inventory> {
  // why: review: an id can come back as 7 from one answer and "7" from another; the ledger's ids match either form.
  const idKey = (id: unknown) => (id !== null && typeof id === 'object' ? JSON.stringify(id) : String(id));
  const own = new Set(ctx.ledger.entries().filter((e) => e.kind === 'created').map((e) => `${(e as { resource: string }).resource}|${idKey((e as { id: unknown }).id)}`));
  // The scopes this run created (never an operator's fixture scope, which may hold other people's objects).
  const created = new Set(own);
  // why: review (12): an operator's fixture is written by the tester on purpose; it is not a bystander.
  for (const r of ctx.manifest.resources) if (r.fixture) own.add(`${r.name}|${idKey(r.fixture.id)}`);
  // why: tiny-tracker self-test (k1 brackets): two resources over the same objects (ticket and ticket-replace both read through
  // get_ticket) see each other's objects; an object the run created under either is the tester's own.
  // why: review: the read tool and its arguments other than the id ("get_entry {collection: articles}" is not "{collection: categories}").
  // Review B1: rendered with the resource's vars, only the id (and other per-call variables) left as a placeholder (callKind).
  // A read that cannot be rendered is a kind of its own, and the inventory says it is partial: an object this run created under
  // another resource read by the same tool may then be listed as someone else's, and a loss of one is not ruled out.
  const kinds = new Map(ctx.manifest.resources.map((r) => [r, callKind(r, r.read)] as const));
  const kindOf = (r: ResourceSpec) => kinds.get(r) ?? `\u0000unkeyed:${r.name}`;
  const sameKind = (r: ResourceSpec) => ctx.manifest.resources.filter((x) => kindOf(x) === kindOf(r));
  for (const r of [res, ...(res.scope ? ctx.manifest.resources.filter((x) => x.name === res.scope!.resource) : [])]) {
    const unsure = ctx.manifest.resources.filter((x) => x !== r && x.read.tool === r.read.tool && (kinds.get(x) === null || kinds.get(r) === null));
    if (unsure.length) inv.partial.push(`the read call of ${r.name} or of ${unsure.map((x) => x.name).join(', ')} (${r.read.tool}) could not be rendered with the resource's vars, so the objects this run created under one cannot be told apart from other objects of the other`);
  }
  const mine = (r: ResourceSpec, id: unknown) => sameKind(r).some((x) => own.has(`${x.name}|${idKey(id)}`));
  const call = async (tool: string, args: unknown) => ctx.session.call(label, tool, args, { write: false, step: ctx.session.stepId(`bystanders.${res.name}`) });
  /** One list call: its items, or why there are none (skip: not a list of the objects; fail: no list in the answer). */
  const listOnce = async (l: ListSpec, r: ResourceSpec, vars: Record<string, unknown>): Promise<{ xs: unknown[] } | { skip: string } | { fail: string }> => {
    if (needsId(l.args)) return { skip: `${l.tool} needs an object's id ({{id}} in its arguments), so it is not a list of the objects` };
    if (needsMarker(l.args)) return { skip: `${l.tool} is narrowed by the run's marker, so it lists only the tester's own objects` };
    // why: rendered with an empty prefix, so that a list narrowed by {{prefix}} lists everything. Every page where list.next says how.
    const c = await listAll(ctx.session, label, l, render(l.args, baseVars(r, '', vars)), ctx.session.stepId(`bystanders.${res.name}`));
    if (!c.ok) return { fail: `${l.tool}${vars['scope'] !== undefined ? ` (scope ${JSON.stringify(vars['scope'])})` : ''} did not answer with a list` };
    inv.covered.lists.push(l.tool);
    if (c.partial) inv.partial.push(`${c.partial}${vars['scope'] !== undefined ? ` (scope ${JSON.stringify(vars['scope'])})` : ''}; only that page was listed`);
    // why: gate-2 re-run on 0295ed6 (nx1-x-lie): a paged list shown earlier in this run to leave out an object that still exists.
    const shown = l.next ? pagingOf(ctx).get(pagingKey(l.tool, vars['scope'])) : undefined;
    if (shown && !inv.partial.includes(shown)) inv.partial.push(shown);
    return { xs: c.items };
  };
  /**
   * Corpus target t14: the declared fixtures of other resources that the list `l` of `r` may show under r's own key. For each
   * resource with a fixture, of another kind than r, whose read goes through the list's tool with the same fixed arguments,
   * the fixture is read by its own id. Read once per inventory; a read that fails or shows no object names no fixture, and
   * the entry is then an ordinary bystander.
   */
  const fixtureReads = new Map<ResourceSpec, unknown>();
  const fixtureForms = async (r: ResourceSpec, l: ListSpec): Promise<{ x: ResourceSpec; obj: unknown }[]> => {
    const out: { x: ResourceSpec; obj: unknown }[] = [];
    for (const x of ctx.manifest.resources) {
      if (!x.fixture || x === r || sameKind(r).includes(x) || !sameFixedArgs(x, x.read, r, l)) continue;
      if (!fixtureReads.has(x)) {
        let obj: unknown = null;
        try {
          const c = await call(x.read.tool, render(x.read.args, baseVars(x, ctx.prefix, { id: x.fixture.id })));
          obj = c.ok ? (objectFrom(x, c.data, x.fixture.id) ?? null) : null;
        } catch {
          obj = null;
        }
        fixtureReads.set(x, obj);
      }
      const obj = fixtureReads.get(x);
      if (obj !== null && typeof obj === 'object') out.push({ x, obj });
    }
    return out;
  };
  /** The fields the declaration lets the tester write on a fixture: its two fields and its restorable arguments. */
  const written = (x: ResourceSpec): string[] => [...new Set([...(x.fields ?? []).map((f) => f.path), ...x.restorable.filter((a) => !a.call_only).map((a) => a.path)])];
  const keep = (k: string, it: unknown, r: ResourceSpec, scope: unknown, id: unknown, ignore: string[], fixtures: { x: ResourceSpec; obj: unknown }[] = [], idPath = '') => {
    if (id !== undefined && id !== null && mine(r, id)) return;
    const e: Entry = { item: it, scope, id, res: r.name, ignore: [...r.read.ignore, ...ignore] };
    // The entry is a fixture where the fixture, read by its own id, carries this entry's key and is the same form.
    const fx = id === undefined || id === null ? undefined : fixtures.find((f) => {
      const key = getPath(f.obj, idPath);
      return key !== undefined && key !== null && idKey(key) === idKey(id) && withoutIgnored(diff(f.obj, it), [...f.x.read.ignore, ...e.ignore]).length === 0;
    });
    if (fx) {
      e.own_fields = written(fx.x);
      e.ignore = [...e.ignore, ...e.own_fields];
      (inv.covered.fixtures ??= []).push(`${k} is the declared fixture of ${fx.x.name} (${short(fx.x.fixture!.id, 40)}): the fields the tester writes on it (${e.own_fields.join(', ') || 'none'}) are not compared`);
    }
    inv.items.set(k, e);
  };
  if (!res.scope) {
    const l = listOf(res);
    if (!l) return { ...inv, unavailable: `${res.name} declares no list block, so objects outside the tester's own cannot be listed` };
    const got = await listOnce(l, res, {});
    if ('skip' in got) return { ...inv, unavailable: `${got.skip}; declare a list block for ${res.name} so that objects outside the tester's own can be listed` };
    if ('fail' in got) return { ...inv, unavailable: got.fail };
    const fixtures = await fixtureForms(res, l);
    for (const it of got.xs) keep(`/${JSON.stringify(getPath(it, l.id))}`, it, res, null, getPath(it, l.id), l.ignore, fixtures, l.id);
  } else {
    const scopeRes = ctx.manifest.resources.find((r) => r.name === res.scope!.resource);
    const sl = scopeRes ? listOf(scopeRes) : null;
    const scopes: unknown[] = [];
    if (sl && scopeRes) {
      const got = await listOnce(sl, scopeRes, {});
      if ('fail' in got) return { ...inv, unavailable: `${got.fail} of scopes` };
      if ('skip' in got) inv.partial.push(`the scopes could not be listed (${got.skip}), so only the default scope ${JSON.stringify(res.scope.default)} was listed`);
      else
        for (const it of got.xs) {
          const key = getPath(it, sl.id);
          keep(`scope:${JSON.stringify(key)}`, it, scopeRes, key, key, sl.ignore);
          if (key !== undefined && key !== null) scopes.push(key);
        }
    } else inv.partial.push(`${res.scope.resource} declares no list block, so only the default scope ${JSON.stringify(res.scope.default)} was listed; objects in any other scope are not covered (declare a list block for ${res.scope.resource})`);
    if (res.scope.default !== null && !scopes.some((s) => s === res.scope!.default)) scopes.push(res.scope.default);
    if (!scopes.length) return { ...inv, unavailable: 'no scope could be listed' };
    const l = res.scope.list;
    const fixtures = await fixtureForms(res, l);
    for (const scope of scopes) {
      // why: a scope this run created holds only the tester's own objects; it is not listed (and a failed list of it, a scope
      // deleted mid-run, say, does not make the inventory unavailable). A fixture scope is listed: it may hold others' objects.
      if (scopeRes && sameKind(scopeRes).some((x) => created.has(`${x.name}|${idKey(scope)}`))) continue;
      const got = await listOnce(l, res, { scope });
      if ('skip' in got) return { ...inv, unavailable: got.skip };
      if ('fail' in got) return { ...inv, unavailable: got.fail };
      for (const it of got.xs) keep(`${JSON.stringify(scope)}/${JSON.stringify(getPath(it, l.id))}`, it, res, scope, getPath(it, l.id), l.ignore, fixtures, l.id);
    }
    inv.covered.scopes = scopes.filter((s) => !(scopeRes && mine(scopeRes, s)));
  }
  inv.covered.objects = [...inv.items.keys()].filter((k) => !k.startsWith('scope:')).length;
  if (o.readById) {
    inv.covered.read_back_by_id = true;
    // why: review: the server's answer for a missing id is taken before the call, not after it, when the server may be degraded.
    if (readsById(res)) await notFoundAnswer(ctx.session, res, ctx.prefix, label, [...inv.items.values()].find((e) => e.res === res.name)?.id);
    for (const e of inv.items.values()) {
      const r = ctx.manifest.resources.find((x) => x.name === e.res)!;
      if (!readsById(r) || e.id === undefined || e.id === null) {
        if (r === res) inv.covered.read_back_by_id = false;
        continue;
      }
      const back = await readBack(ctx, r, label, e);
      e.read = back.kind === 'present' ? back.obj : null;
      if (r === res && e.read === null) inv.covered.read_back_by_id = false;
    }
  }
  return inv;
}

/**
 * Around a selector call: an object an earlier inventory (before the fixtures) listed that the inventory just before the call
 * does not show (a list that leaves an entry out now and then, i13b) is added to it and read by id, so that it is compared too.
 */
export async function withEarlier(ctx: RunContext, label: string, inv: Inventory, earlier: Inventory): Promise<Inventory> {
  if (inv.unavailable || earlier.unavailable) return inv;
  for (const [k, e] of earlier.items) {
    if (inv.items.has(k)) continue;
    const r = ctx.manifest.resources.find((x) => x.name === e.res)!;
    const copy = { ...e };
    if (readsById(r) && e.id !== undefined && e.id !== null) {
      const back = await readBack(ctx, r, label, copy);
      // why: k1 brackets: an object already gone is the earlier comparison's loss; it is not compared again (as "missing").
      if (back.kind === 'gone') continue;
      copy.read = back.kind === 'present' ? back.obj : null;
      // why: nx1-x-lie: the list just read left out an object that still exists; for a paged list the inventory is partial.
      if (back.kind === 'present') {
        const why = notListedButPresent(ctx, k, e);
        if (why && !inv.partial.includes(why)) inv.partial.push(why);
      }
    }
    inv.items.set(k, copy);
  }
  return inv;
}

type Back = { kind: 'gone' } | { kind: 'present'; obj: unknown } | { kind: 'unknown'; why: string };

/** Read one bystander back by id: gone only on a definite answer; the server's not-found answer counts only where the object read back before. */
async function readBack(ctx: RunContext, r: ResourceSpec, label: string, e: Entry): Promise<Back> {
  let args: unknown;
  try {
    args = render(r.read.args, baseVars(r, ctx.prefix, { id: e.id, scope: e.scope }));
  } catch (err) {
    return { kind: 'unknown', why: `the read could not be rendered for it (${short((err as Error).message, 60)})` };
  }
  const c = await ctx.session.call(label, r.read.tool, args, { write: false, step: ctx.session.stepId(`bystanders.${r.name}.readback`) });
  if (c.timed_out || c.transport_error !== null) return { kind: 'unknown', why: 'the read-back timed out or broke' };
  const obj = c.ok ? objectFrom(r, c.data, e.id) : null;
  if (obj !== null && obj !== undefined) return { kind: 'present', obj };
  if (definitelyGone(c) || notFoundWithoutError(c, obj)) return { kind: 'gone' };
  // why: the server's answer for an id that never existed shows an object gone only where this read showed it before the call
  // (a read whose arguments do not reach the object, or a fixed answer, gives the same answer for everything).
  if (e.read !== undefined && e.read !== null && (await goneByAnswer(ctx.session, r, ctx.prefix, label, c, e.id))) return { kind: 'gone' };
  return { kind: 'unknown', why: short(c.text ?? c.rpc_error?.message ?? 'no object in the answer', 80) };
}

/**
 * Compare two inventories. `selector`: the call between them can remove objects; every bystander is then read back by id.
 * The before inventory of a selector call must have been taken with `readById`.
 */
/** Fields a backend sets once, when it creates an object: a change in one says the object was made again (i8). */
const CREATION_FIELD = /^(created|createdAt|created_at|createdOn|created_on|creationTimestamp|creation_time|createTime|create_time|uid)$/;

export async function compare(ctx: RunContext, res: ResourceSpec, label: string, before: Inventory, after: Inventory, o: { selector?: boolean; fixtures?: boolean } = {}): Promise<Loss> {
  const unavailable = before.unavailable ?? after.unavailable;
  const gone: string[] = [];
  const changed: string[] = [];
  let missing: string[] = [];
  const changedCand = new Map<string, string[]>();
  const volatile = new Set<string>();
  const pagingPartial = new Set<string>();
  const byName = (n: string) => ctx.manifest.resources.find((x) => x.name === n)!;
  // Time-like changes (an ISO time, an age): set aside at once around a create; around a selector call only where a listing
  // with no call in between shows them moving (a reset that re-created a bystander moves its updated_at once, i8).
  const timeishCand = new Map<string, Set<string>>();
  const fieldsChanged = (a: unknown, b: unknown, ignore: string[], key?: string): string[] => {
    // why: gate-2 safety re-run on 0295ed6 (i8): a bystander deleted and made again with the same id differs in its creation
    // fields; read.ignore (or a time set aside as moving by itself) never hides that: it is a loss.
    const remade = diff(a, b).filter((x) => x.kind === 'changed' && CREATION_FIELD.test(x.path.split(/[.[\]]/).filter(Boolean).pop() ?? '')).map((x) => `${x.path} (re-created)`);
    const rest = fieldsChangedInner(a, b, ignore, key);
    return [...remade, ...rest.filter((p) => !remade.some((r) => r.startsWith(`${p} `)))];
  };
  const fieldsChangedInner = (a: unknown, b: unknown, ignore: string[], key?: string): string[] => {
    const d = withoutIgnored(diff(a, b), ignore);
    const real = d.filter((x) => !(timeish(x.before) && timeish(x.after)));
    const t = d.filter((x) => !real.includes(x));
    if (o.selector && key) {
      // why: review (4): an age that only grew (Kubernetes Age crossing a unit) changes by itself; one that fell (an object made
      // again) and an ISO time are changes unless a listing with no call in between shows them moving.
      const grew = t.filter((x) => ageMs(x.before) !== null && ageMs(x.after) !== null && ageMs(x.after)! >= ageMs(x.before)!);
      for (const x of grew) volatile.add(x.path);
      // why: gate-2 safety re-run on 0295ed6 (i8): around a selector call an ignored time (updated_at) that moved is a candidate too:
      // a bystander deleted and made again moves it once; only a listing with no call in between can set it aside.
      const kept = new Set(d.map((x) => x.path));
      const ignoredTimes = diff(a, b).filter((x) => !kept.has(x.path) && isoTime(x.before) && isoTime(x.after));
      const cand = [...t.filter((x) => !grew.includes(x)), ...ignoredTimes];
      if (cand.length) timeishCand.set(key, new Set([...(timeishCand.get(key) ?? []), ...cand.map((x) => x.path)]));
      return [...d.filter((x) => !grew.includes(x)), ...ignoredTimes].map((x) => x.path);
    }
    for (const x of t) volatile.add(x.path);
    return real.map((x) => x.path);
  };
  // why: review of the note-19 set (i9): an inventory that fails after a selector call still leaves every bystander that read back
  // before to be read back by id; what is gone is reported, and the record stays not held (the inventory is unavailable).
  if (!before.unavailable && after.unavailable && o.selector) {
    for (const [k, v] of before.items) {
      const r = byName(v.res);
      if (!readsById(r) || v.id === undefined || v.id === null || v.read === null || v.read === undefined) continue;
      const back = await readBack(ctx, r, label, v);
      if (back.kind === 'gone') gone.push(k);
      else if (back.kind === 'present') {
        const ch = fieldsChanged(v.read, back.obj, [...r.read.ignore, ...(r.version ? [r.version.read] : []), ...(v.own_fields ?? [])]);
        if (ch.length) changed.push(`${k} (read back changed: ${ch.slice(0, 4).join(', ')})`);
      }
    }
  }
  if (!unavailable) {
    for (const [k, v] of before.items) {
      const now = after.items.get(k);
      const r = byName(v.res);
      // why: review: where the read before the call did not show the object (v.read null: another scope, another id form, a
      // read the token may not make), a not-found afterwards proves nothing; the list decides, as for a resource without a read by id.
      if ((o.selector || !now) && readsById(r) && v.id !== undefined && v.id !== null && v.read !== null) {
        const back = await readBack(ctx, r, label, v);
        if (back.kind === 'gone') {
          gone.push(k);
          continue;
        }
        // why: review: around a selector call, an object that read back before and cannot be read after is not cleared by a list
        // that still shows it (a list can lag behind a delete, i4).
        if (back.kind === 'unknown' && o.selector && v.read !== undefined) {
          changed.push(`${k} (read back before the call, could not be read back after it: ${back.why})`);
          continue;
        }
        if (back.kind === 'present') {
          // why: i5: a bystander the list hides that still reads back may have been changed (trashed); the read forms decide.
          const readChange = v.read !== undefined && v.read !== null ? fieldsChanged(v.read, back.obj, [...r.read.ignore, ...(r.version ? [r.version.read] : []), ...(v.own_fields ?? [])]) : [];
          const listChange = now ? fieldsChanged(v.item, now.item, v.ignore, k) : [];
          if (readChange.length) changed.push(`${k} (read back changed: ${readChange.slice(0, 4).join(', ')})`);
          else if (listChange.length) changedCand.set(k, listChange);
          // why: it reads back unchanged, so missing from the list means it moved (paging or ordering), not gone. For a list read
          // through list.next that is a page the cursor did not reach (nx1-x-lie): the inventory is partial.
          if (!now) {
            const why = notListedButPresent(ctx, k, v);
            if (why) pagingPartial.add(why);
          }
          continue;
        }
        if (!now) {
          changed.push(`${k} (missing from the list and could not be read back: ${back.why})`);
          continue;
        }
      }
      if (!now) {
        missing.push(k);
        continue;
      }
      const ch = fieldsChanged(v.item, now.item, v.ignore, k);
      if (ch.length) changedCand.set(k, ch);
    }
    // why: note 14 item 4 (i11): a list can leave an entry out once (paging, lag). What no read by id can confirm is listed
    // again, twice at most, before it counts; and a field that differs again between two listings with no call in between
    // changes by itself (item 2, i12).
    for (let i = 0; i < 2 && (missing.length || changedCand.size); i++) {
      const again = await inventory(ctx, res, label);
      if (again.unavailable) break;
      missing = missing.filter((k) => !again.items.has(k));
      for (const [k, paths] of [...changedCand]) {
        const a = after.items.get(k);
        const b = again.items.get(k);
        if (!a || !b) continue;
        // why: review: around a selector call a field that keeps moving may be a change the call started (a delete in progress),
        // so only fields that move around a create or a fixture are set aside.
        const movingAll = (o.selector ? diff(a.item, b.item) : withoutIgnored(diff(a.item, b.item), a.ignore)).map((x) => x.path);
        const moving = o.selector ? movingAll.filter((p) => timeishCand.get(k)?.has(p)) : movingAll;
        for (const p of paths.filter((x) => moving.includes(x))) volatile.add(p);
        const left = paths.filter((p) => !moving.includes(p));
        if (left.length) changedCand.set(k, left);
        else changedCand.delete(k);
      }
      // why: a confirming listing that showed nothing new ends the loop; only a missing entry earns the second one.
      if (!missing.length) break;
    }
    for (const [k, paths] of changedCand) {
      // why: review: the tester's own fixtures land in scopes (the default one too) and change their listed form (a count).
      if (o.fixtures && k.startsWith('scope:')) {
        for (const p of paths) volatile.add(`${k} ${p} (the tester's own creates)`);
        continue;
      }
      changed.push(`${k} (${paths.slice(0, 4).join(', ')})`);
    }
  }
  return { gone, changed, missing, unavailable, partial: [...new Set([...before.partial, ...after.partial, ...pagingPartial])], covered: before.covered, volatile: [...volatile] };
}
