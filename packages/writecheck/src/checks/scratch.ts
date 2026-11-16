/**
 * Scratch objects: extra objects of a resource a check creates for itself (a stale delete, a list
 * edit, a bulk call), each through the ledger and verified like the object under test, in the
 * resource's run scope when it has one. Through the create tool, or through the control's create
 * when the check asks for it and the manifest declares one (setup that must not depend on the tool
 * under test, for example items for a bulk call inside a container).
 */

import { baseVars, Driver } from '../core/driver.js';
import type { ResourceSpec } from '../core/manifest.js';
import { listAll } from '../core/lists.js';
import { createVerified, createViaControl } from '../core/objects.js';
import { render, type Env } from '../core/template.js';
import { getPath } from '../core/util.js';
import type { RunContext } from './types.js';

export interface Scratch {
  ok: boolean;
  id: unknown;
  marker: string;
  reason: string;
  /** A driver bound to the scratch object. */
  driver: Driver | null;
}

export async function scratch(ctx: Omit<RunContext, 'driver'> & { driver?: Driver }, res: ResourceSpec, o: { tag: string; purpose: string; label: string; via?: 'tool' | 'control'; scope?: unknown; marker?: string; extra?: Env }): Promise<Scratch> {
  const marker = o.marker ?? ctx.marker(o.tag);
  const scope = o.scope !== undefined ? o.scope : (ctx.driver?.scope ?? null);
  const env = baseVars(res, ctx.prefix, { scope, marker, key: marker, ...(o.extra ?? {}) });
  const step = ctx.session.stepId(`scratch.${res.name}.${o.tag}`);
  const useControl = o.via === 'control' && !!res.control?.create;
  if (!useControl && !res.create) return { ok: false, id: null, marker, reason: 'the resource has no create block', driver: null };
  const c = useControl
    ? await createViaControl(ctx.session, ctx.ledger, res, ctx.prefix, {
        purpose: o.purpose,
        label: o.label,
        step,
        create: async () => {
          const d = new Driver(ctx.session, ctx.manifest, res, ctx.prefix, ctx.env);
          d.scope = scope;
          const r = await d.controlCreate({ marker, ...(o.extra ?? {}) }, step);
          return { ok: r.r.ok, id: r.id, status: r.r.status, error: r.r.error };
        },
      })
    : await createVerified(ctx.session, ctx.ledger, res, ctx.prefix, { tool: res.create!.tool, args: render(res.create!.args, env), purpose: o.purpose, label: o.label, step });
  if (!c.ok) return { ok: false, id: c.id, marker, reason: c.reason, driver: null };
  const d = new Driver(ctx.session, ctx.manifest, res, ctx.prefix, ctx.env);
  d.id = c.id;
  d.scope = scope;
  return { ok: true, id: c.id, marker, reason: '', driver: d };
}

/** Create one scope (a container) through the scope resource, named with a fresh marker; returns its key. */
export async function newScope(ctx: Omit<RunContext, 'driver'>, res: ResourceSpec, tag: string, label: string): Promise<{ ok: boolean; key: unknown; reason: string }> {
  const scopeRes = ctx.manifest.resources.find((r) => r.name === res.scope!.resource)!;
  const key = ctx.marker(tag);
  const env = baseVars(scopeRes, ctx.prefix, { key, marker: key });
  const c = await createVerified(ctx.session, ctx.ledger, scopeRes, ctx.prefix, { tool: scopeRes.create!.tool, args: render(scopeRes.create!.args, env), purpose: `scope ${tag} for ${res.name}`, label, step: ctx.session.stepId(`scope.${res.name}.${tag}`) });
  return { ok: c.ok, key: c.ok ? c.id : null, reason: c.reason };
}

/** The ids listed in one scope (through the scope's list call), or null when the list failed. */
export async function listScope(ctx: Omit<RunContext, 'driver'>, res: ResourceSpec, scope: unknown, label: string, extra: Env = {}): Promise<{ id: unknown; name: unknown }[] | null> {
  const l = res.scope!.list;
  // why: gate-2 safety re-run on 0295ed6 (F1): every page, where list.next says how; a list that shows a further page it
  // cannot read gives no count (null), so a check that needs the scope's contents is not run on a partial list.
  const r = await listAll(ctx.session, label, l, render(l.args, baseVars(res, ctx.prefix, { scope, ...extra })), ctx.session.stepId(`scope.${res.name}.list`));
  if (!r.ok || r.partial) return null;
  return r.items.map((it) => ({ id: getPath(it, l.id), name: getPath(it, l.name) }));
}
