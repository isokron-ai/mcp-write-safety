/**
 * Shared pieces of the tester-safety tests (SPEC-RECHECK.md S-07 and S-08; spec-recheck B-13 and E-7).
 * Each test seeds objects the tester did not create (bystanders) in the server's default project, runs
 * the tester against a server with the defect that makes a probe dangerous, and asserts two things: the
 * bystanders are untouched, and the dangerous request was never sent.
 */

import type { ShapeBackend } from './backend.js';
import type { Call } from './harness.js';

export const BYSTANDERS = ['B1', 'B2'];

/** Two tickets in the default project that are not the tester's: no run prefix, made before the run. */
export const seedBystanders = (b: ShapeBackend): void => {
  for (const id of BYSTANDERS) b.seed('tickets', { id, scope: 'inbox', title: `customer ticket ${id}`, status: 'open', assignee: 'carol', priority: 2, note: null, paused: false, labels: [], meta: {} });
};

export const bystandersLeft = (b: ShapeBackend): string[] => b.all('tickets').filter((t) => BYSTANDERS.includes(String(t['id']))).map((t) => String(t['id']));

export interface Danger {
  call: Call;
  why: string;
}

/** The projects the run created (the only containers a bulk call may name). */
const ownProjects = (calls: Call[]): Set<unknown> => new Set(calls.filter((c) => c.tool === 'project_create').map((c) => c.args['key']));

/**
 * Calls to a deleting or bulk-updating tool in which an identifier, a scope argument or a selector is
 * missing, replaced by a value of another type, or empty: the calls spec 7.3 allows only inside a
 * container the tester created and confirmed, and, where a scope argument names it, only after
 * MWS-TGT-1 was `held` for that tool. In these fixtures neither condition can be met (the default
 * project holds bystanders, and the bulk tool does not confine itself to the project it is given), so
 * every such call is one that must not be sent.
 */
export function dangerous(calls: Call[]): Danger[] {
  const own = ownProjects(calls);
  const out: Danger[] = [];
  for (const call of calls) {
    const a = call.args;
    if (call.tool === 'ticket_delete') {
      if (typeof a['id'] !== 'string' || !a['id']) out.push({ call, why: 'the identifier is missing or replaced' });
    } else if (call.tool === 'tickets_delete') {
      if (typeof a['project'] !== 'string' || !own.has(a['project'])) out.push({ call, why: 'the scope argument is missing, replaced, or not a project the run created' });
      else if (a['all'] !== true && (typeof a['title_prefix'] !== 'string' || !a['title_prefix'])) out.push({ call, why: 'the selector is empty, missing or replaced' });
    }
  }
  return out;
}

/** The same, limited to calls that also carry an argument the tool's schema does not define (the misspelled or unrelated extra argument of MWS-IN-2). */
export function dangerousWithExtra(calls: Call[]): Danger[] {
  const known: Record<string, string[]> = { ticket_delete: ['id'], tickets_delete: ['project', 'title_prefix', 'all'] };
  return dangerous(calls).filter((d) => Object.keys(d.call.args).some((k) => !known[d.call.tool]!.includes(k)));
}

export const showDanger = (ds: Danger[]): string[] => ds.map((d) => `${d.call.tool} ${JSON.stringify(d.call.args)}: ${d.why}`);
