/**
 * Cleanup by ledger, newest first, through each resource's declared policy:
 *
 *   delete          the manifest's delete tool
 *   control_delete  the control's delete request (the platform's own API)
 *   archive         the manifest's archive (or close) tool; the object stays, closed
 *   ephemeral       nothing: the backend is disposable (the user said so)
 *   leave           nothing: the user chose to leave objects behind; they are listed as leftovers
 *
 * Only objects in the ledger are touched, and each only after it reads back carrying the run's prefix. Cleanup calls do not count against the write budget (a
 * run stopped by the budget must still be able to clean up). A create whose outcome is unknown is looked for with the
 * optional `list` tool by the run prefix. Three failed cleanup calls in a row stop the cleanup; what
 * is left stays open in the ledger and is listed with the prefix to search for.
 */

import { baseVars, callKind, deleteArgs, Driver, needsVersion, objectFrom } from './driver.js';
import type { Ledger, OpenIntent } from './ledger.js';
import type { Manifest, ResourceSpec } from './manifest.js';
import type { Session } from './session.js';
import { render, type Env } from './template.js';
import { getPath, short } from './util.js';
import { listAll } from './lists.js';
import { definitelyGone, goneByAnswer, listed, nameIsMarker, notFoundWithoutError } from './objects.js';

export interface Leftover {
  resource: string;
  id: unknown;
  name: string | null;
  how: string;
  reason: string;
}

export interface CleanupReport {
  deleted: { resource: string; id: unknown; via: string }[];
  left: Leftover[];
  failed: Leftover[];
  unknown: OpenIntent[];
  stopped: string | null;
  prefix: string;
}

export const MAX_FAILED_CLEANUPS = 3;

/**
 * Why a clean-up did not finish (an object of the run may be left behind), or [] (review of the held set, S5: one predicate
 * for `run` and `cleanup`): it stopped, a delete failed, a create's outcome is unknown, or an object could not be verified as
 * the run's. Objects left by a declared policy (archive) are not. `cleanup --abandon` exits 4 too: the creates it abandons may
 * have left objects, which is what the exit status tells a CI job.
 */
export function unfinished(r: CleanupReport): string[] {
  const notVerified = r.left.filter((x) => /without this run's prefix/.test(x.reason));
  return [r.stopped && `clean-up stopped (${r.stopped})`, r.failed.length && `${r.failed.length} delete(s) failed`, r.unknown.length && `${r.unknown.length} create(s) have an unknown outcome`, notVerified.length && `${notVerified.length} object(s) could not be verified as this run's`].filter((x): x is string => !!x);
}

export async function cleanupLedger(ledger: Ledger, manifest: Manifest, session: Session, env: NodeJS.ProcessEnv, prefix: string, o: { abandon?: boolean } = {}): Promise<CleanupReport> {
  const rep: CleanupReport = { deleted: [], left: [], failed: [], unknown: [], stopped: null, prefix };
  const verify: { ob: { resource: string; id: unknown; name: string | null }; res: ResourceSpec; vars: Env; text: string | null }[] = [];
  const byName = new Map(manifest.resources.map((r) => [r.name, r]));
  let open = ledger.open();
  if (o.abandon) {
    for (const ob of open.objects) {
      ledger.append({ kind: 'abandoned', resource: ob.resource, id: ob.id, intent: ob.intent, reason: 'cleanup --abandon' });
      rep.left.push({ resource: ob.resource, id: ob.id, name: ob.name, how: 'created by this tester', reason: 'abandoned by cleanup --abandon' });
    }
    for (const i of open.intents) {
      ledger.append({ kind: 'abandoned', resource: i.resource, id: null, intent: i.intent, reason: 'cleanup --abandon' });
      rep.unknown.push(i);
    }
    return rep;
  }
  // A create with an unknown outcome: look for it by the run prefix, if the manifest gives a list tool.
  for (const i of open.intents) {
    const res = byName.get(i.resource);
    const sw = res ? sweepList(manifest, res) : null;
    if (!res || !sw) {
      rep.unknown.push(res && !res.list ? { ...i, reason: `${i.reason}; ${res.name} declares no list block, so whether the object exists cannot be looked up (declare one to let cleanup sweep by prefix)` } : i);
      continue;
    }
    const { list, via } = sw;
    try {
      // why: note 19 (R6): every page, where list.next says how; a list that shows a page it cannot read proves no absence.
      const lr = await listAll(session, 'CLEANUP', list, render(list.args, { prefix, ...res.vars }), session.stepId(`cleanup.${res.name}.sweep`));
      const r = lr.first;
      const items = lr.ok ? lr.items : null;
      // why: gate-2 Payload N3 / P2: an answer with no list at `items` (or a failed call) is not "nothing is there"; the entry
      // stays open, and the report says the sweep could not look. Only a list that answered, or an answer that says it found
      // nothing, shows the object does not exist.
      if (!Array.isArray(items) && !(r?.ok && emptyAnswer(r.text))) {
        rep.unknown.push({ ...i, reason: `${i.reason}; the sweep through ${list.tool} could not look: ${lr.reason ?? 'no answer'}, so whether the object exists is not known` });
        continue;
      }
      const found = Array.isArray(items) ? items.filter((it) => String(getPath(it, list.name) ?? '').includes(prefix)) : [];
      const known = knownIds(ledger, manifest, res, list);
      const fresh = found.filter((it) => !known.has(JSON.stringify(getPath(it, list.id))));
      if (fresh.length) for (const it of fresh) ledger.append({ kind: 'created', intent: i.intent, resource: res.name, id: getPath(it, list.id), name: String(getPath(it, list.name) ?? ''), via: 'sweep' });
      else if (lr.partial) rep.unknown.push({ ...i, reason: `${i.reason}; the sweep through ${list.tool} found no new object of this run on the page it could read, but ${lr.partial}, so whether the object exists is not known` });
      else ledger.append({ kind: 'abandoned', resource: res.name, id: null, intent: i.intent, reason: `outcome unknown; a sweep by prefix ${prefix}${via ? ` through ${via}'s list (the same create tool)` : ''} answered without any new object of this run` });
    } catch (e) {
      rep.unknown.push({ ...i, reason: `${i.reason}; the prefix sweep failed: ${(e as Error).message}` });
    }
  }
  // why: gate-2 re-run on 378f32f (note 19, R7): a create answered with an error may have been applied before the error. Each
  // such create whose marker is in the ledger is looked for, by that exact marker, through the resource's list (every page);
  // an object found is the run's and is cleaned up like the others. A create without a marker, or a resource without a list,
  // is left as refused (as before).
  const failedMarkers = ledger.entries().filter((e): e is Extract<typeof e, { kind: 'create_failed' }> => e.kind === 'create_failed' && typeof (e as { marker?: unknown }).marker === 'string');
  const byRes = new Map<string, { intent: number; marker: string }[]>();
  for (const e of failedMarkers) byRes.set(e.resource, [...(byRes.get(e.resource) ?? []), { intent: e.intent, marker: e.marker! }]);
  for (const [name, fails] of byRes) {
    const res = byName.get(name);
    const sw = res ? sweepList(manifest, res) : null;
    if (!res || !sw) continue;
    try {
      const lr = await listAll(session, 'CLEANUP', sw.list, render(sw.list.args, { prefix, ...res.vars }), session.stepId(`cleanup.${res.name}.sweep_failed`));
      // why: review of note 19 (12): a sweep that could not look says so; a create that applied before its error may be left.
      if (!lr.ok) {
        rep.unknown.push({ resource: res.name, intent: fails[0]!.intent, tool: res.create?.tool ?? '', reason: `creates answered with an error may have been applied; the sweep through ${sw.list.tool} by their markers could not look (${lr.reason ?? 'no answer'}), so whether such an object exists is not known` });
        continue;
      }
      const known = knownIds(ledger, manifest, res, sw.list);
      for (const f of fails) {
        for (const it of lr.items.filter((x) => nameIsMarker(getPath(x, sw.list.name), f.marker))) {
          const id = getPath(it, sw.list.id);
          if (id === null || id === undefined || known.has(JSON.stringify(id))) continue;
          known.add(JSON.stringify(id));
          ledger.append({ kind: 'created', intent: f.intent, resource: res.name, id, name: String(getPath(it, sw.list.name) ?? ''), via: 'sweep' });
        }
      }
      if (lr.partial) rep.unknown.push({ resource: res.name, intent: fails[0]!.intent, tool: res.create?.tool ?? '', reason: `creates answered with an error may have been applied; the sweep through ${sw.list.tool} by their markers read one page only (${lr.partial}), so objects on a further page are not known` });
    } catch (e) {
      rep.unknown.push({ resource: res.name, intent: fails[0]!.intent, tool: res.create?.tool ?? '', reason: `creates answered with an error may have been applied; the sweep by their markers failed (${(e as Error).message}), so whether such an object exists is not known` });
    }
  }
  open = ledger.open();
  let failedInRow = 0;
  /** An object the server's read calls gone that the declared control read still returns: reported as left (soft delete), the entry stays open. */
  const softLeft = async (res: ResourceSpec, ob: { resource: string; id: unknown; name: string | null }, text = 'the server\'s read no longer shows the object'): Promise<boolean> => {
    const soft = res.control?.read ? await controlStillHas(session, manifest, res, prefix, env, ob.id) : null;
    if (!soft) return false;
    const why = `${text}, but the platform's API still returns it (${soft}): a soft delete, or a read that hides it; it is still on the backend`;
    ledger.append({ kind: 'delete_failed', resource: ob.resource, id: ob.id, reason: why });
    rep.failed.push({ resource: ob.resource, id: ob.id, name: ob.name, how: 'created by this tester', reason: why });
    return true;
  };
  for (const ob of open.objects) {
    const res = byName.get(ob.resource);
    const left = (policy: string, reason: string) => {
      ledger.append({ kind: 'left', resource: ob.resource, id: ob.id, policy, reason });
      rep.left.push({ resource: ob.resource, id: ob.id, name: ob.name, how: 'created by this tester', reason });
    };
    if (rep.stopped) {
      rep.failed.push({ resource: ob.resource, id: ob.id, name: ob.name, how: 'created by this tester', reason: 'not attempted: cleanup stopped' });
      continue;
    }
    if (!res) {
      rep.failed.push({ resource: ob.resource, id: ob.id, name: ob.name, how: 'created by this tester', reason: 'the resource is no longer in the manifest' });
      continue;
    }
    const policy = res.cleanup;
    if (policy === null || policy === 'leave' || policy === 'ephemeral') {
      left(policy ?? 'none', policy === 'ephemeral' ? 'the backend is declared disposable (cleanup: ephemeral)' : policy === 'leave' ? 'cleanup: leave' : 'no cleanup policy');
      continue;
    }
    const vars = baseVars(res, prefix, { id: ob.id });
    let ok = false;
    let why = '';

    // Ownership first: the id must still read back as an object carrying this run's prefix. An id can be
    // reused, or the manifest or the environment can point at another backend since the run.
    try {
      const own = await session.call('CLEANUP', res.read.tool, render(res.read.args, vars), { step: session.stepId(`cleanup.${res.name}.verify`), write: false });
      if (!own.ok) {
        if (definitelyGone(own) || (await goneByAnswer(session, res, prefix, 'CLEANUP', own, ob.id))) {
          if (await softLeft(res, ob)) continue;
          ledger.append({ kind: 'deleted', resource: ob.resource, id: ob.id, via: 'already gone (reads as not found)' });
          rep.deleted.push({ resource: ob.resource, id: ob.id, via: 'already gone' });
          continue;
        }
        failedInRow++;
        const reason = `could not read the object to verify it is this run's (${short(own.text ?? own.rpc_error?.message ?? own.transport_error ?? (own.timed_out ? 'timed out' : 'error'), 120)}); not touched`;
        ledger.append({ kind: 'delete_failed', resource: ob.resource, id: ob.id, reason });
        rep.failed.push({ resource: ob.resource, id: ob.id, name: ob.name, how: 'created by this tester', reason });
        if (failedInRow >= MAX_FAILED_CLEANUPS) rep.stopped = `${MAX_FAILED_CLEANUPS} cleanup calls failed in a row; the rest is left in the ledger`;
        continue;
      }
      const obj = objectFrom(res, own.data, ob.id);
      if (notFoundWithoutError(own, obj) || (obj === null && (await goneByAnswer(session, res, prefix, 'CLEANUP', own, ob.id)))) {
        if (await softLeft(res, ob)) continue;
        ledger.append({ kind: 'deleted', resource: ob.resource, id: ob.id, via: 'already gone (reads as not found, without isError)' });
        rep.deleted.push({ resource: ob.resource, id: ob.id, via: 'already gone' });
        continue;
      }
      if (obj === null && listed(res, own.data)) {
        // why: a list read that answered without the id means the object is gone.
        ledger.append({ kind: 'deleted', resource: ob.resource, id: ob.id, via: 'already gone (not in the list read)' });
        rep.deleted.push({ resource: ob.resource, id: ob.id, via: 'already gone' });
        continue;
      }
      // why: writesafe self-test T2 (run0 left 58 objects): a delete that takes the version gets the version just read.
      if (res.delete && needsVersion(res.delete.args)) Object.assign(vars, { version: res.version ? (getPath(obj, res.version.read) ?? null) : null, object: obj });
      const name = res.create?.name_path ? getPath(obj, res.create.name_path) : null;
      const mine = typeof name === 'string' ? name.includes(prefix) : JSON.stringify(obj ?? null).includes(prefix);
      if (!mine) {
        left('not verified', `the id now reads back as an object without this run's prefix ${prefix}; it was not touched (the id may have been reused, or the target changed)`);
        continue;
      }
    } catch (e) {
      rep.failed.push({ resource: ob.resource, id: ob.id, name: ob.name, how: 'created by this tester', reason: `verification failed: ${(e as Error).message}` });
      continue;
    }
    try {
      if (policy === 'delete' || policy === 'archive') {
        const t = policy === 'delete' ? res.delete! : res.archive!;
        const r = await session.call('CLEANUP', t.tool, policy === 'delete' ? deleteArgs(res, vars, await deleteSchema(session, res.delete!.tool)) : render(t.args, vars), { step: session.stepId(`cleanup.${res.name}.${policy}`), counted: true });
        ok = r.ok;
        why = r.ok ? '' : short(r.text ?? r.rpc_error?.message ?? r.transport_error ?? 'error', 200);
        // why: gate-2 re-run on 169b0cb (S6, Payload N3): a delete answered without isError is done only where the object no
        // longer reads back. The read-back is a second pass after every delete has been sent (below), so that a slow or late
        // answer to a read cannot hold up the deletes themselves.
        if (ok && policy === 'delete') verify.push({ ob, res, vars, text: r.text });
        if (!ok && policy === 'delete') {
          // why: an object deleted earlier (or shared by two ledger entries) fails to delete again; if it no longer reads back, it is gone.
          const back = await session.call('CLEANUP', res.read.tool, render(res.read.args, vars), { step: session.stepId(`cleanup.${res.name}.check`), write: false });
          if (definitelyGone(back) || (back.ok && listed(res, back.data) && objectFrom(res, back.data, ob.id) === null) || (await goneByAnswer(session, res, prefix, 'CLEANUP', back, ob.id))) {
            ok = true;
            why = 'already gone';
          }
        }
      } else {
        const d = new Driver(session, manifest, res, prefix, env);
        d.id = ob.id;
        const r = await d.controlRequest(res.control!.delete!, {}, session.stepId(`cleanup.${res.name}.control_delete`), { counted: true });
        ok = r.ok || r.status === 404;
        why = ok ? '' : `HTTP ${r.status ?? r.error}`;
      }
    } catch (e) {
      why = (e as Error).message;
    }
    if (ok) {
      failedInRow = 0;
      if (policy === 'archive') left('archive', 'archived (the object remains, closed)');
      else if (policy === 'delete' && verify.length && verify[verify.length - 1]!.ob === ob) {
        /* judged in the read-back pass below */
      } else {
        ledger.append({ kind: 'deleted', resource: ob.resource, id: ob.id, via: why ? `${policy} (${why})` : policy });
        rep.deleted.push({ resource: ob.resource, id: ob.id, via: why ? `${policy} (${why})` : policy });
      }
    } else {
      failedInRow++;
      ledger.append({ kind: 'delete_failed', resource: ob.resource, id: ob.id, reason: why });
      rep.failed.push({ resource: ob.resource, id: ob.id, name: ob.name, how: 'created by this tester', reason: why });
      if (failedInRow >= MAX_FAILED_CLEANUPS) rep.stopped = `${MAX_FAILED_CLEANUPS} cleanup calls failed in a row; the rest is left in the ledger`;
    }
  }
  // The read-back pass: each delete answered as done is confirmed by a read that no longer shows the object.
  for (const v of verify) {
    // why: dogfood C10: an asynchronous delete (a Kubernetes namespace that is terminating) is gone seconds later; the read-back
    // is repeated within read.settle_ms, or 30 s for a delete the declaration lists in async_operations, before it counts.
    const isAsync = manifest.async_operations.includes(v.res.delete?.tool ?? '');
    const deadline = Date.now() + Math.max(v.res.read.settle_ms ?? 0, isAsync ? 30_000 : 0);
    let back: Awaited<ReturnType<typeof session.call>>;
    let still: unknown;
    let gone = false;
    for (let i = 0; ; i++) {
      back = await session.call('CLEANUP', v.res.read.tool, render(v.res.read.args, v.vars), { step: session.stepId(`cleanup.${v.res.name}.verify_delete${i ? `.${i}` : ''}`), write: false });
      still = back.ok ? objectFrom(v.res, back.data, v.ob.id) : null;
      // why: a read that timed out may be answered late; on a server that answers one request at a time that answer would hold up
      // the next read, so the tester waits a few timeouts before going on.
      if (back.timed_out) await new Promise((r) => setTimeout(r, Math.min(10_000, 3 * manifest.limits.timeout_ms)));
      gone = definitelyGone(back) || notFoundWithoutError(back, still) || (back.ok && still === null && listed(v.res, back.data)) || (still === null && (await goneByAnswer(session, v.res, prefix, 'CLEANUP', back, v.ob.id)));
      if (gone || Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    if (gone) {
      // why: gate-2 re-run on 6b028ec (T10, n2): after a soft delete the server's read says not found while the row stays. Where
      // the declaration gives the platform's own read, it decides: an object it still returns is left behind, not deleted.
      if (await softLeft(v.res, v.ob, 'the delete was answered without isError and the server\'s read no longer shows the object')) continue;
      ledger.append({ kind: 'deleted', resource: v.ob.resource, id: v.ob.id, via: 'delete (read back: gone)' });
      rep.deleted.push({ resource: v.ob.resource, id: v.ob.id, via: 'delete' });
      continue;
    }
    const why = still !== null ? `the delete was answered without isError (${short(v.text ?? '', 120)}), and the object still reads back${isAsync ? ' after 30 s (the delete is listed in async_operations: it may still be pending)' : ''}` : `the delete was answered without isError, and the read-back could not confirm the object is gone (${short(back.text ?? back.rpc_error?.message ?? back.transport_error ?? (back.timed_out ? 'timed out' : 'no answer'), 120)})`;
    ledger.append({ kind: 'delete_failed', resource: v.ob.resource, id: v.ob.id, reason: why });
    rep.failed.push({ resource: v.ob.resource, id: v.ob.id, name: v.ob.name, how: 'created by this tester', reason: why });
  }
  // why: gate-2 re-run on 378f32f (note 19 item 5): where a list the run used shows a page the tester cannot read (no list.next),
  // objects of this run on a further page (a duplicate a paged trace did not see) cannot be found; the report says so.
  // why: review (9): only for a resource the run created objects of, once (not beside a sweep's own partial entry), not after a stop.
  const used = new Set(ledger.entries().filter((e) => e.kind === 'created').map((e) => (e as { resource: string }).resource));
  for (const name of rep.stopped ? [] : used) {
    const res = byName.get(name);
    const sw = res ? sweepList(manifest, res) : null;
    if (!res || !sw || sw.list.next || rep.unknown.some((u) => u.resource === name && /page/.test(u.reason))) continue;
    try {
      const lr = await listAll(session, 'CLEANUP', sw.list, render(sw.list.args, { prefix, ...res.vars }), session.stepId(`cleanup.${res.name}.last_look`));
      if (lr.ok && lr.partial) rep.unknown.push({ resource: res.name, intent: 0, tool: res.create?.tool ?? sw.list.tool, reason: `after clean-up ${lr.partial}; objects of this run on a further page, if any, could not be looked for` });
    } catch {
      /* the last look only reports */
    }
  }
  return rep;
}

/** Does the declared control read still return the object? A short description (`HTTP 200`) when it does; null when it does not or cannot say. */
async function controlStillHas(session: Session, manifest: Manifest, res: ResourceSpec, prefix: string, env: NodeJS.ProcessEnv, id: unknown): Promise<string | null> {
  try {
    const d = new Driver(session, manifest, res, prefix, env);
    d.id = id;
    const r = await d.controlRead(session.stepId(`cleanup.${res.name}.control_read`));
    // why: review: an empty body (`{}`, `[]`) is not the object.
    const o = r.obj;
    const some = o !== null && typeof o === 'object' && Object.keys(o as object).length > 0;
    return r.ok && some ? `HTTP ${r.http?.status ?? '?'}` : null;
  } catch {
    return null;
  }
}

/**
 * The list a prefix sweep for an unknown create of `res` goes through: its own list block, else (gate-2 Payload P3) the list
 * block of another resource made by the same create tool, in the same place (no scope, the same vars), whose listed name
 * field is the field this resource's create fills with the run's marker or key. Such a list lists the objects this create
 * makes, so an answer without the object shows it does not exist.
 */
/**
 * The ids this run already created in the collection a sweep lists (research builds N1): only objects of this resource, or of
 * a resource whose objects the same list shows (the same create tool, or the same list call). An id created in another
 * collection (post 6) never hides an object of this one (task 6).
 */
export function knownIds(ledger: Ledger, manifest: Manifest, res: ResourceSpec, list: NonNullable<ResourceSpec['list']>): Set<string> {
  // why: review: a generic create tool (create_item {collection}) is shared across collections, so it says nothing; the list call,
  // or the read call apart from the id, does. Review B1: both rendered with the resource's vars (callKind); a call that cannot
  // be rendered matches nothing, so its resource's ids hide nothing and the sweep looks at every object with the run's prefix.
  const owner = manifest.resources.find((r) => r.list === list) ?? res;
  const listKind = callKind(owner, list);
  const readKind = callKind(res, res.read);
  const same = new Set(manifest.resources.filter((r) => r === res || (listKind !== null && !!r.list && callKind(r, r.list) === listKind) || (readKind !== null && callKind(r, r.read) === readKind)).map((r) => r.name));
  return new Set(ledger.entries().filter((e) => e.kind === 'created' && same.has((e as { resource: string }).resource)).map((e) => JSON.stringify((e as { id: unknown }).id)));
}

export function sweepList(manifest: Manifest, res: ResourceSpec): { list: NonNullable<ResourceSpec['list']>; via: string | null } | null {
  if (res.list) return { list: res.list, via: null };
  if (!res.create?.name_path || res.scope) return null;
  const sib = manifest.resources.find((r) => r !== res && !!r.list && r.create?.tool === res.create!.tool && !r.scope && r.list.name === res.create!.name_path && JSON.stringify(r.vars) === JSON.stringify(res.vars));
  return sib?.list ? { list: sib.list, via: sib.name } : null;
}

/** An answer whose text says it found nothing ("Total: 0 documents"), as objects.ts reads it for a read. */
const emptyAnswer = (text: string | null): boolean => notFoundWithoutError({ ok: true, timed_out: false, transport_error: null, text }, null) && !/not[ _-]?found|no such|does not exist|doesn't exist|\b404\b/i.test(text ?? '');

const schemas = new WeakMap<Session, Promise<Record<string, unknown>[]>>();
/** The delete tool's input schema, from one tools/list per session (for the override, deleteArgs). */
async function deleteSchema(session: Session, tool: string): Promise<unknown> {
  let p = schemas.get(session);
  if (!p) {
    p = session.listTools('CLEANUP').catch(() => []);
    schemas.set(session, p);
  }
  return (await p).find((t) => t['name'] === tool)?.['inputSchema'];
}
