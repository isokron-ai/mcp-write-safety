/**
 * The MCP server behind the gate-2 regression tests (stdio, newline-delimited JSON-RPC), in the
 * style of test/fake/server.ts. Each profile returns the shapes a real server returned in the
 * validation runs (Payload, Kubernetes, Grafana), cut down to the
 * tools a test needs. The shapes were copied from the captures of those runs; where a fixture
 * departs from the real server, the test that uses it says so.
 *
 *   SHAPE_PROFILE=payload   @payloadcms/plugin-mcp 3.93.0: no annotations, prose followed by JSON,
 *                           `id` typed ["string","number"], refusals as text without isError
 *   SHAPE_PROFILE=k8s       kubernetes-mcp-server v0.1.2: `null` read as "not sent", unknown
 *                           arguments ignored, a default namespace
 *   SHAPE_PROFILE=tracker   a ticket tracker with projects (scopes), a bulk delete and a save tool;
 *                           the correct handlers are the default
 *
 * SHAPE_OPTS=<opt>[,<opt>…] switches one behaviour each (listed beside the code that reads it).
 * SHAPE_CALL_LOG=<file>: every tools/call is appended there as one JSON line, before it is handled,
 * so a test can assert that a request was never sent.
 *
 * Loopback backend only (SHAPE_URL, test/regression/backend.ts). Test fixture only.
 */

import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const BACKEND = process.env['SHAPE_URL'] ?? '';
const PROFILE = process.env['SHAPE_PROFILE'] ?? 'tracker';
const OPTS = new Set((process.env['SHAPE_OPTS'] ?? '').split(',').map((s) => s.trim()).filter(Boolean));
const on = (o: string) => OPTS.has(o);
/** slow-putback: priority 5 was written, so the next priority change is the put-back. */
let sawFive = false;
const CALL_LOG = process.env['SHAPE_CALL_LOG'];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

class ToolError extends Error {}
/** A refusal the server words as an error but returns without isError (the Payload shape). */
class SoftError extends Error {}
/** Notices the server adds to the current answer (odd-notice). */
const notices: string[] = [];

async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Obj }> {
  const r = await fetch(`${BACKEND}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text();
  return { status: r.status, body: text ? (JSON.parse(text) as Obj) : {} };
}
const enc = encodeURIComponent;
const json = (data: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });

interface Tool {
  name: string;
  description: string;
  inputSchema: Obj;
  annotations?: Obj;
}
interface Profile {
  tools: Tool[];
  call(name: string, args: Obj): Promise<unknown>;
}

// ───────────────────────────── tracker ─────────────────────────────

function tracker(): Profile {
  const STATUS = ['open', 'in_progress', 'blocked', 'closed'];
  // strict-empty: every string field declares minLength 1 and no field is nullable or a list, so the
  // schema allows none of the explicit-null, empty-string and empty-list probes of MWS-UPD-1.
  const text = (): Obj => ({ type: 'string', ...(on('strict-empty') ? { minLength: 1 } : {}) });
  const FIELDS: Record<string, Obj> = { title: { type: 'string', minLength: 1, maxLength: 200 }, status: { type: 'string', enum: STATUS }, assignee: text(), priority: { type: 'integer', minimum: 1, maximum: 5 }, note: text(), paused: { type: 'boolean' } };
  const DEFAULTS: Obj = { status: 'open', assignee: '', priority: 3, note: null, paused: false };
  const ro = { readOnlyHint: true, openWorldHint: false };
  const rw = (destructive: boolean, idempotent: boolean) => ({ readOnlyHint: false, destructiveHint: destructive, idempotentHint: idempotent, openWorldHint: false });
  const tools: Tool[] = [
    { name: 'whoami', description: 'The tenant this server writes to.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: ro },
    { name: 'project_create', description: 'Create a project (a container for tickets).', inputSchema: { type: 'object', properties: { key: { type: 'string', minLength: 1 }, name: { type: 'string' } }, required: ['key'], additionalProperties: false }, annotations: rw(false, false) },
    { name: 'project_list', description: 'List the projects.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: ro },
    { name: 'project_delete', description: 'Delete a project.', inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false }, annotations: rw(true, true) },
    { name: 'ticket_create', description: 'Create a ticket in a project (default: inbox).', inputSchema: { type: 'object', properties: { project: { type: 'string' }, ...FIELDS, meta: { type: 'object' } }, required: ['title'], additionalProperties: false }, annotations: rw(false, false) },
    { name: 'ticket_get', description: 'Read one ticket by id.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false }, annotations: ro },
    { name: 'ticket_list', description: 'List tickets, by project and by title prefix.', inputSchema: { type: 'object', properties: { project: { type: 'string' }, title_prefix: { type: 'string' } }, additionalProperties: false }, annotations: ro },
    { name: 'ticket_update', description: 'Change the named fields of a ticket; fields not sent keep their values.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, ...FIELDS }, required: ['id'], additionalProperties: false }, annotations: rw(true, true) },
    { name: 'ticket_replace', description: 'Replace a whole ticket.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, ticket: { type: 'object' } }, required: ['id', 'ticket'], additionalProperties: false }, annotations: rw(true, false) },
    { name: 'ticket_save', description: 'Save a whole ticket. An existing ticket is replaced only with overwrite: true.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, ticket: { type: 'object' }, overwrite: { type: 'boolean', default: false, description: 'Replace an existing ticket whatever its version (default false).' } }, required: ['id', 'ticket'], additionalProperties: false }, annotations: rw(true, false) },
    { name: 'ticket_delete', description: 'Delete a ticket by id.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false }, annotations: rw(true, true) },
    { name: 'tickets_delete', description: 'Delete the tickets of a project whose title starts with a prefix. Pass all: true to delete every ticket of the project.', inputSchema: { type: 'object', properties: { project: { type: 'string' }, title_prefix: { type: 'string' }, all: { type: 'boolean', default: false } }, required: ['project'], additionalProperties: false }, annotations: rw(true, true) },
    // bulk-close (owners' safety item 1): a bulk update bounded by its project alone; close-ignores-scope closes in the default project.
    ...(on('bulk-close') ? [{ name: 'tickets_close', description: 'Close every ticket of a project.', inputSchema: { type: 'object', properties: { project: { type: 'string' } }, required: ['project'], additionalProperties: false }, annotations: rw(false, true) }] : []),
  ];

  function check(name: string, args: Obj): void {
    const schema = tools.find((t) => t.name === name)!.inputSchema as { properties: Record<string, Obj>; required?: string[] };
    const fail = (m: string): never => {
      throw new ToolError(`invalid arguments: ${m}`);
    };
    for (const [k, v] of Object.entries(args)) {
      const s = schema.properties[k];
      if (!s) {
        // drop-unknown-args: an argument the schema does not define is dropped without a word (spec-recheck E-7).
        if (on('drop-unknown-args') || on('odd-notice')) {
          delete args[k];
          // odd-notice: the drop is said, in words outside the tester's default pattern for "not used".
          if (on('odd-notice')) notices.push(`Heads up: ${k} is something this tool disregards.`);
          continue;
        }
        fail(`${k} is not an argument of ${name}`);
      }
      const type = s!['type'];
      const typeOk = type === 'string' ? typeof v === 'string' : type === 'integer' ? Number.isInteger(v) : type === 'boolean' ? typeof v === 'boolean' : type === 'object' ? isObj(v) : true;
      if (!typeOk) {
        // lenient: the conversions spec MWS-IN-1 lists as keeping the meaning, and nothing else (grafana/CLI-BUGS.md 8).
        // A converted value is then checked against the argument's constraints like any other.
        const lenient = on('lenient') && k !== 'id';
        if (lenient && v === null && !(schema.required ?? []).includes(k)) {
          delete args[k];
          continue;
        }
        if (lenient && type === 'integer' && typeof v === 'string' && /^-?(0|[1-9]\d*)$/.test(v)) args[k] = Number(v);
        else if (lenient && type === 'string' && (typeof v === 'number' || typeof v === 'boolean')) args[k] = JSON.stringify(v);
        else if (on('drop-bad-types')) {
          // drop-bad-types: a wrongly typed value is dropped without a word (the shape of K8S-09).
          delete args[k];
          continue;
        } else fail(`${k} must be ${type === 'integer' ? 'an integer' : `a ${String(type)}`}`);
      }
      const val = args[k];
      if (Array.isArray(s!['enum']) && !(s!['enum'] as unknown[]).includes(val)) fail(`${k} must be one of ${(s!['enum'] as string[]).join(', ')}`);
      if (typeof val === 'number' && ((typeof s!['minimum'] === 'number' && val < s!['minimum']) || (typeof s!['maximum'] === 'number' && val > s!['maximum']))) fail(`${k} must be from ${String(s!['minimum'])} to ${String(s!['maximum'])}`);
      if (typeof val === 'string' && ((typeof s!['maxLength'] === 'number' && val.length > s!['maxLength']) || (typeof s!['minLength'] === 'number' && val.length < s!['minLength']))) fail(`${k} must be ${String(s!['minLength'] ?? 0)} to ${String(s!['maxLength'] ?? 'any number of')} characters`);
    }
    for (const r of schema.required ?? []) {
      if (args[r] !== undefined) continue;
      // default-missing-scope: a bulk delete with no project acts on the default project.
      if (name === 'tickets_delete' && r === 'project' && on('default-missing-scope')) continue;
      fail(`${r} is required`);
    }
  }

  const refused = (r: { status: number; body: Obj }) => new ToolError(`the tracker refused the request (HTTP ${r.status}): ${String(r.body['error'] ?? '')}`);

  return {
    tools,
    async call(name, args) {
      check(name, args);
      switch (name) {
        case 'whoami':
          return json((await api('GET', '/whoami')).body);
        case 'project_create': {
          // project-create-fails: no project can be created (the tester's run scope then falls back to the default project).
          if (on('project-create-fails')) throw new ToolError('the tracker refused the request (HTTP 403): this account may not create projects; nothing was written');
          const r = await api('POST', '/c/projects', { id: args['key'], key: args['key'], name: args['name'] ?? '' });
          if (r.status !== 201) throw refused(r);
          return json({ key: r.body['key'], project: r.body });
        }
        case 'project_list':
          return json({ projects: [{ key: 'inbox', name: 'inbox' }, ...(((await api('GET', '/c/projects?field=key')).body['items'] as Obj[]) ?? [])] });
        case 'project_delete': {
          const r = await api('DELETE', `/c/projects/${enc(String(args['key']))}`);
          if (r.status !== 204) throw refused(r);
          return json({ deleted: args['key'] });
        }
        case 'ticket_create': {
          const { project, ...fields } = args;
          const r = await api('POST', '/c/tickets', { scope: project ?? 'inbox', ...DEFAULTS, labels: [], meta: {}, ...fields });
          if (r.status !== 201) throw refused(r);
          return json({ id: r.body['id'], ticket: r.body });
        }
        case 'ticket_get': {
          const r = await api('GET', `/c/tickets/${enc(String(args['id']))}`);
          if (r.status !== 200) throw refused(r);
          // hidden-paused (review of 3283a69, 3): the read does not show paused, though ticket_update still sets it.
          if (on('hidden-paused')) delete r.body['paused'];
          return json({ ticket: r.body });
        }
        case 'ticket_list': {
          const q = `prefix=${enc(String(args['title_prefix'] ?? ''))}${args['project'] !== undefined ? `&scope=${enc(String(args['project']))}` : ''}`;
          return json({ tickets: (await api('GET', `/c/tickets?${q}`)).body['items'] ?? [] });
        }
        case 'ticket_update': {
          const { id, ...fields } = args;
          const path = `/c/tickets/${enc(String(id))}`;
          if (on('rebuild') || on('rebuild-drop')) {
            // rebuild: the whole ticket is rebuilt from the arguments, so every field the call does not name
            // goes back to its default (the shape of GF-03, grafana/CLI-BUGS.md 1 and 2). rebuild-drop: the
            // fields the call does not name are left out, so they are removed (GF-03 as Grafana 13 answers it,
            // grafana/CLI-BUGS-d3b536f.md 1: labels or annotations missing from the read).
            const cur = await api('GET', path);
            if (cur.status !== 200) throw refused(cur);
            const r = await api('PUT', path, { scope: cur.body['scope'], title: cur.body['title'], labels: cur.body['labels'], meta: cur.body['meta'], ...(on('rebuild-drop') ? {} : DEFAULTS), ...fields });
            if (r.status !== 200) throw refused(r);
            return json({ ticket: r.body });
          }
          // paused-locks: paused is checked as a boolean, and a paused ticket refuses every later update (the shape of Payload's
          // archived task kept from updates by a hook, and of Grafana's provenance answering 409; action dogfood SH-6).
          // slow-priority-5 (review of 3283a69, 1): priority 5 is applied, and the answer comes after the client's timeout.
          // slow-putback: after priority 5, the next change of priority is applied and answered after the timeout (the put-back).
          if ((on('slow-priority-5') && fields['priority'] === 5) || (on('slow-putback') && typeof fields['priority'] === 'number' && fields['priority'] !== 5 && sawFive)) {
            const r = await api('PATCH', path, fields);
            await new Promise((res) => setTimeout(res, 2500));
            if (r.status !== 200) throw refused(r);
            return json({ ticket: r.body });
          }
          if (fields['priority'] === 5) sawFive = true;
          // priority-ratchet: priority only goes up; a lower value is dropped without a word (a one-way field that answers success).
          if (on('priority-ratchet') && typeof fields['priority'] === 'number') {
            const cur = await api('GET', path);
            if (cur.status === 200 && typeof cur.body['priority'] === 'number' && (fields['priority'] as number) < (cur.body['priority'] as number)) delete fields['priority'];
          }
          if (on('paused-locks')) {
            if (Object.hasOwn(fields, 'paused') && typeof fields['paused'] !== 'boolean') throw new ToolError(`invalid arguments: paused must be a boolean, got ${typeof fields['paused']}`);
            const cur = await api('GET', path);
            if (cur.status === 200 && cur.body['paused'] === true) throw new ToolError(`ticket ${String(id)} is paused, and a paused ticket cannot be changed`);
          }
          const r = await api('PATCH', path, fields);
          if (r.status !== 200) throw refused(r);
          return json({ ticket: r.body });
        }
        case 'ticket_replace': {
          const t = args['ticket'] as Obj;
          // no-precondition: the whole object is written with no version, whatever the caller read
          // (the shape of an apply sent without resourceVersion, kubernetes/CLI-BUGS.md B3).
          // apply-force: the write is a forced apply by the server's own field manager (header x-field-manager, x-force), as
          // kubernetes-mcp-server sends (kubernetes/CLI-BUGS-d3b536f.md B3).
          const fm: Record<string, string> = on('apply-force') ? { 'x-field-manager': 'tracker-server', 'x-force': 'true' } : {};
          const r = await api('PUT', `/c/tickets/${enc(String(args['id']))}`, t, on('no-precondition') ? fm : { ...fm, 'if-match': String(t['version'] ?? '') });
          if (r.status === 412) throw new ToolError(`conflict: ticket ${String(args['id'])} changed since version ${String(t['version'])}; nothing was written. Re-read it and retry.`);
          if (r.status !== 200) throw refused(r);
          return json({ ticket: r.body });
        }
        case 'ticket_save': {
          // The shape of grafana update_dashboard on a v2 dashboard (grafana/CLI-BUGS.md 4): no version argument; a
          // full-body save of an existing object is refused unless the caller sets overwrite, and with overwrite the
          // tool copies the current version onto the caller's body.
          const path = `/c/tickets/${enc(String(args['id']))}`;
          const cur = await api('GET', path);
          if (cur.status !== 200) throw refused(cur);
          if (args['overwrite'] !== true) throw new ToolError(`ticket ${String(args['id'])} already exists; nothing was written. A full-body save of an existing ticket needs overwrite.`);
          const r = await api('PUT', path, args['ticket'], { 'if-match': String(cur.body['version']) });
          if (r.status === 412) throw new ToolError(`conflict: ticket ${String(args['id'])} changed while it was being saved; nothing was written. Re-read it and retry.`);
          if (r.status !== 200) throw refused(r);
          return json({ ticket: r.body });
        }
        case 'ticket_delete': {
          const r = await api('DELETE', `/c/tickets/${enc(String(args['id']))}`);
          if (r.status !== 204) throw refused(r);
          return json({ deleted: args['id'] });
        }
        case 'tickets_close': {
          const scope = on('close-ignores-scope') ? 'inbox' : String(args['project']);
          const items = ((await api('GET', `/c/tickets?prefix=&scope=${enc(scope)}`)).body['items'] ?? []) as Obj[];
          for (const t of items) await api('PATCH', `/c/tickets/${enc(String(t['id']))}`, { status: 'closed' });
          return json({ closed: items.map((t) => t['id']) });
        }
        case 'tickets_delete': {
          const prefix = typeof args['title_prefix'] === 'string' ? args['title_prefix'] : '';
          // empty-selector-matches-all: no guard on an empty or missing selector (the defect of MWS-TGT-2).
          if (!prefix && args['all'] !== true && !on('empty-selector-matches-all')) throw new ToolError('invalid arguments: title_prefix is empty or missing, which would match every ticket of the project; nothing was deleted');
          // delete-ignores-scope: the project argument is not used; the delete runs in the default project (the defect of MWS-TGT-1).
          // empty-falls-to-default (re-run S1): the scope is honoured with a selector; an empty or missing one runs in the default project.
          // empty-all-projects (S1b): an empty or missing selector runs in every project. delete-ignores-prefix (S2): the narrowing is not used.
          const scope = on('delete-ignores-scope') ? 'inbox' : !prefix && on('empty-all-projects') ? '*' : !prefix && on('empty-falls-to-default') ? 'inbox' : (args['project'] ?? 'inbox');
          const r = await api('POST', '/c/tickets/delete-where', { scope, prefix: on('delete-ignores-prefix') ? '' : prefix });
          if (r.status !== 200) throw refused(r);
          return json({ deleted: r.body['deleted'] });
        }
      }
      throw new Error(`unknown tool ${name}`);
    },
  };
}

// ───────────────────────────── payload ─────────────────────────────

function payload(): Profile {
  const ID = { type: ['string', 'number'], description: 'The ID of the document' };
  const OPS = { locale: { type: 'string', description: 'Optional: locale code' }, draft: { type: 'boolean', default: false, description: 'Whether to write the document as a draft' } };
  const FIELDS = { title: { type: 'string' }, status: { type: 'string', enum: ['todo', 'doing', 'done'] }, owner: { type: ['string', 'null'] }, priority: { type: ['number', 'null'] } };
  const schema = (properties: Obj, required: string[] = []): Obj => ({ type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false, $schema: 'http://json-schema.org/draft-07/schema#' });
  // No tool carries an annotation (PAY-08; payload/CLI-BUGS.md 1).
  const tools: Tool[] = [
    { name: 'createTasks', description: 'Create a document in a collection.', inputSchema: schema({ ...FIELDS, ...OPS }, ['title']) },
    { name: 'updateTasks', description: 'Update documents in a collection by ID or where clause.', inputSchema: schema({ ...FIELDS, id: ID, ...OPS, where: { type: 'string', description: 'JSON string for where clause to update multiple documents' } }) },
    { name: 'findTasks', description: 'Find documents in a collection by ID or where clause using Find or FindByID.', inputSchema: schema({ id: ID, limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 }, where: { type: 'string', description: 'Optional: JSON string for where clause' } }) },
    { name: 'deleteTasks', description: 'Delete documents in a collection by ID or where clause.', inputSchema: schema({ id: ID, where: { type: 'string', description: 'Optional: JSON string for where clause to delete multiple documents' } }) },
    // guard: the one synthetic tool the validation shim added, so that a run could start at all.
    ...(on('guard') ? [{ name: 'mwsv_guard', description: 'Synthetic tester-side tool: returns the title of the seeded guard task.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } }] : []),
  ];
  // structured: what the validation shim did: the JSON a result already carries in its text is copied into structuredContent.
  const out = (text: string, data: unknown) => ({ content: [{ type: 'text', text }], ...(on('structured') ? { structuredContent: data } : {}) });
  const fence = (d: unknown) => '```json\n' + JSON.stringify(d) + '\n```';
  const clean = (d: Obj): Obj => {
    const { version: _v, updated_at: _u, scope: _s, ...rest } = d;
    return rest;
  };

  /** The SDK's schema check: a wrongly typed or out-of-range value is a tool execution error; an unknown argument is stripped without a word (PAY-11). */
  function check(name: string, args: Obj): void {
    const props = (tools.find((t) => t.name === name)!.inputSchema['properties'] ?? {}) as Record<string, Obj>;
    const required = (tools.find((t) => t.name === name)!.inputSchema['required'] ?? []) as string[];
    const bad = (k: string): never => {
      throw new ToolError(`MCP error -32602: Input validation error: Invalid arguments for tool ${name}: Invalid input at ${k}`);
    };
    for (const r of required) if (args[r] === undefined) bad(r);
    for (const [k, v] of Object.entries(args)) {
      const s = props[k];
      if (!s) {
        delete args[k];
        continue;
      }
      const types = Array.isArray(s['type']) ? (s['type'] as string[]) : [String(s['type'])];
      const t = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : typeof v === 'object' ? 'object' : typeof v;
      if (!(types.includes(t) || (t === 'integer' && types.includes('number')))) bad(k);
      if (Array.isArray(s['enum']) && !(s['enum'] as unknown[]).includes(v)) bad(k);
      if (typeof v === 'number' && ((typeof s['minimum'] === 'number' && v < s['minimum']) || (typeof s['maximum'] === 'number' && v > s['maximum']))) bad(k);
    }
  }

  const byWhere = async (where: unknown): Promise<Obj[]> => {
    const all = ((await api('GET', '/c/tasks')).body['items'] as Obj[]) ?? [];
    if (typeof where !== 'string' || !where) return all;
    let w: Obj;
    try {
      w = JSON.parse(where) as Obj;
    } catch {
      throw new SoftError('Error: Invalid JSON in where clause');
    }
    return all.filter((d) => Object.entries(w).every(([k, cond]) => !isObj(cond) || !Object.hasOwn(cond, 'equals') || JSON.stringify(d[k]) === JSON.stringify(cond['equals'])));
  };

  return {
    tools,
    async call(name, args) {
      check(name, args);
      switch (name) {
        case 'mwsv_guard':
          return { content: [{ type: 'text', text: JSON.stringify({ tenant: 'mwsv-guard-task' }) }] };
        case 'createTasks': {
          // Fields named like the tool's own operation arguments (locale, draft) are taken for those and not stored (PAY-04).
          const { locale: _l, draft: _d, ...fields } = args;
          // unique-title: a second task with a title already in use is refused in text, without isError and without an id
          // (the shape of Payload's unique sku, payload/CLI-BUGS-d3b536f.md 7: "The following field is invalid: sku").
          if (on('unique-title') && (((await api('GET', '/c/tasks')).body['items'] as Obj[]) ?? []).some((d) => d['title'] === fields['title'])) throw new SoftError('Error creating resource in collection "tasks": The following field is invalid: title');
          const r = await api('POST', '/c/tasks', { status: 'todo', owner: null, priority: null, archived: false, locale: null, draft: false, ...fields });
          if (r.status !== 201) throw new SoftError(`Error creating resource in collection "tasks": ${String(r.body['error'] ?? r.status)}`);
          const doc = clean(r.body);
          return out(`Resource created successfully in collection "tasks"!\nCreated resource:\n${fence(doc)}`, { doc });
        }
        case 'findTasks': {
          if (args['id'] !== undefined) {
            const r = await api('GET', `/c/tasks/${enc(String(args['id']))}`);
            // missing-as-empty-list (169b0cb re-run, Payload 2): a missing id is answered with the empty list's text, no isError.
            if ((r.status !== 200 || r.body['trashed'] === true) && on('missing-as-empty-list')) return { content: [{ type: 'text', text: 'Collection: "tasks"\nTotal: 0 documents\nPage: 1 of 1\n' }] };
            // soft-delete (S5): a trashed row reads as not found through the tool; the platform's API still returns it.
            if (r.status !== 200 || r.body['trashed'] === true) throw new SoftError(`Error: Document with ID "${String(args['id'])}" not found in collection "tasks"`);
            const doc = clean(r.body);
            return out(`Resource from collection "tasks":\n${JSON.stringify(doc)}`, doc);
          }
          const docs = (await byWhere(args['where'])).map(clean);
          const body = docs.length === 0 ? '' : `\n${fence(docs.length === 1 ? docs[0] : docs)}`;
          return out(`Collection: "tasks"\nTotal: ${docs.length} documents\nPage: 1 of 1\n${body}`, { docs, totalDocs: docs.length, page: 1, totalPages: 1 });
        }
        case 'updateTasks': {
          const { id, where: _w, locale: _l, draft: _d, ...fields } = args;
          if (typeof fields['priority'] === 'number' && (fields['priority'] < 1 || fields['priority'] > 5)) throw new SoftError('Error updating resource in collection "tasks": The following field is invalid: Priority');
          const r = await api('PATCH', `/c/tasks/${enc(String(id))}`, fields);
          if (r.status !== 200) throw new SoftError('Error updating resource in collection "tasks": Not Found');
          const doc = clean(r.body);
          return out(`Document updated successfully in collection "tasks"!\nUpdated document:\n${fence(doc)}`, { doc });
        }
        case 'deleteTasks': {
          // delete-says-not-found (S6): the delete answers a not-found sentence without isError and deletes nothing.
          if (on('delete-says-not-found')) return { content: [{ type: 'text', text: `Error: Document with ID "${String(args['id'])}" not found` }] };
          if (on('soft-delete')) {
            const r0 = await api('PATCH', `/c/tasks/${enc(String(args['id']))}`, { trashed: true });
            if (r0.status !== 200) throw new SoftError('Error deleting resource in collection "tasks": Not Found');
            return out('Document deleted successfully from collection "tasks"!', { doc: clean(r0.body) });
          }
          const cur = await api('GET', `/c/tasks/${enc(String(args['id']))}`);
          if (cur.status !== 200) throw new SoftError('Error deleting resource in collection "tasks": Not Found');
          await api('DELETE', `/c/tasks/${enc(String(args['id']))}`);
          const doc = clean(cur.body);
          return out(`Document deleted successfully from collection "tasks"!\nDeleted document:\n${fence(doc)}`, { doc });
        }
      }
      throw new Error(`unknown tool ${name}`);
    },
  };
}

// ───────────────────────────── k8s ─────────────────────────────

function k8s(): Profile {
  const S = { type: 'string' };
  const ro = (title: string) => ({ destructiveHint: false, idempotentHint: false, openWorldHint: true, readOnlyHint: true, title });
  // As in the real catalog, no schema says additionalProperties, and unknown arguments are ignored.
  const tools: Tool[] = [
    { name: 'namespaces_list', description: 'List all the Kubernetes namespaces in the current cluster', inputSchema: { type: 'object' }, annotations: ro('Namespaces: List') },
    { name: 'resources_get', description: 'Get a Kubernetes resource in the current cluster', inputSchema: { type: 'object', properties: { apiVersion: S, kind: S, name: S, namespace: S }, required: ['apiVersion', 'kind', 'name'] }, annotations: ro('Resources: Get') },
    { name: 'resources_list', description: 'List Kubernetes resources and objects in the current cluster', inputSchema: { type: 'object', properties: { apiVersion: S, kind: S, labelSelector: S, limit: { type: 'integer', minimum: 0 }, namespace: S }, required: ['apiVersion', 'kind'] }, annotations: ro('Resources: List') },
    { name: 'resources_create_or_update', description: 'Create or update a Kubernetes resource in the current cluster by providing a YAML or JSON representation of the resource', inputSchema: { type: 'object', properties: { resource: S }, required: ['resource'] }, annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true, readOnlyHint: false, title: 'Resources: Create or Update' } },
    { name: 'resources_delete', description: 'Delete a Kubernetes resource in the current cluster', inputSchema: { type: 'object', properties: { apiVersion: S, kind: S, name: S, namespace: S }, required: ['apiVersion', 'kind', 'name'] }, annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true, readOnlyHint: false, title: 'Resources: Delete' } },
  ];
  const plural = (kind: string) => `${kind.toLowerCase()}s`;
  /** A string argument as the real server reads it: null is "not sent"; another type is refused by name. */
  const str = (args: Obj, k: string, verb: string, required: boolean): string | undefined => {
    const v = args[k];
    if (v === undefined || v === null) {
      if (required) throw new ToolError(`failed to ${verb} resource, missing argument ${k}`);
      return undefined;
    }
    if (typeof v !== 'string') throw new ToolError(`${k} is not a string`);
    return v;
  };
  const idOf = (kind: string, ns: string, name: string) => `${kind}:${ns}:${name}`;
  const nsOf = (kind: string, ns: string | undefined) => (kind === 'Namespace' ? '' : (ns ?? 'default'));
  const clean = (d: Obj): Obj => {
    const { id: _i, version: _v, updated_at: _u, scope: _s, title: _t, ...rest } = d;
    return rest;
  };
  const text = (t: string) => ({ content: [{ type: 'text', text: t }] });

  return {
    tools,
    async call(name, args) {
      switch (name) {
        case 'namespaces_list':
          return text(JSON.stringify((((await api('GET', '/c/k8s')).body['items'] as Obj[]) ?? []).filter((d) => d['kind'] === 'Namespace').map(clean)));
        case 'resources_get': {
          for (const k of ['apiVersion', 'kind', 'name']) str(args, k, 'get', true);
          const kind = String(args['kind']);
          const ns = nsOf(kind, str(args, 'namespace', 'get', false));
          const r = await api('GET', `/c/k8s/${enc(idOf(kind, ns, String(args['name'])))}`);
          if (r.status !== 200) throw new ToolError(`failed to get resource: ${plural(kind)} "${String(args['name'])}" not found`);
          return text(JSON.stringify(clean(r.body)));
        }
        case 'resources_list': {
          for (const k of ['apiVersion', 'kind']) str(args, k, 'list', true);
          const ns = str(args, 'namespace', 'list', false);
          str(args, 'labelSelector', 'list', false);
          // Departure from the real server, which uses limit 0.5 as 0 (kubernetes/CLI-BUGS.md B19): a fraction is
          // refused here, so that the only accepted probes are the nulls that B4 is about.
          if (args['limit'] !== undefined && args['limit'] !== null && !Number.isInteger(args['limit'])) throw new ToolError('limit is not an integer');
          if (typeof args['limit'] === 'number' && args['limit'] < 0) throw new ToolError('limit must not be negative');
          let items = (((await api('GET', '/c/k8s')).body['items'] as Obj[]) ?? []).filter((d) => d['kind'] === args['kind'] && (ns === undefined || d['scope'] === ns));
          if (typeof args['limit'] === 'number' && args['limit'] > 0) items = items.slice(0, args['limit']);
          return text(JSON.stringify({ items: items.map(clean) }));
        }
        case 'resources_create_or_update': {
          const src = str(args, 'resource', 'create or update', true)!;
          const done: Obj[] = [];
          for (const part of src.split(/^---.*$/m)) {
            if (!part.trim()) continue;
            let doc: Obj;
            try {
              doc = JSON.parse(part) as Obj;
            } catch (e) {
              throw new ToolError(`failed to create or update resources: ${(e as Error).message}`);
            }
            const meta = (doc['metadata'] ?? {}) as Obj;
            const kind = String(doc['kind']);
            const ns = nsOf(kind, typeof meta['namespace'] === 'string' ? meta['namespace'] : undefined);
            const id = idOf(kind, ns, String(meta['name']));
            const cur = await api('GET', `/c/k8s/${enc(id)}`);
            const body = { ...doc, metadata: { name: meta['name'], ...(ns ? { namespace: ns } : {}) }, title: meta['name'], scope: ns };
            const r = cur.status === 200 ? await api('PUT', `/c/k8s/${enc(id)}`, body, meta['resourceVersion'] !== undefined ? { 'if-match': String(meta['resourceVersion']) } : {}) : await api('POST', '/c/k8s', { ...body, id });
            if (r.status === 412) throw new ToolError(`failed to create or update resources: Operation cannot be fulfilled on ${plural(kind)} "${String(meta['name'])}": the object has been modified; please apply your changes to the latest version and try again`);
            if (r.status !== 200 && r.status !== 201) throw new ToolError(`failed to create or update resources: HTTP ${r.status}`);
            const stored = clean(r.body);
            done.push({ ...stored, metadata: { ...(stored['metadata'] as Obj), resourceVersion: String(r.body['version']) } });
          }
          return text(`# The following resources (YAML) have been created or updated successfully\n${JSON.stringify(done)}`);
        }
        case 'resources_delete': {
          for (const k of ['apiVersion', 'kind', 'name']) str(args, k, 'delete', true);
          const kind = String(args['kind']);
          const r = await api('DELETE', `/c/k8s/${enc(idOf(kind, nsOf(kind, str(args, 'namespace', 'delete', false)), String(args['name'])))}`);
          if (r.status !== 204) throw new ToolError(`failed to delete resource: ${plural(kind)} "${String(args['name'])}" not found`);
          return text('Resource deleted successfully');
        }
      }
      throw new Error(`unknown tool ${name}`);
    },
  };
}

// ───────────────────────────── stdio ─────────────────────────────

const profile: Profile = PROFILE === 'payload' ? payload() : PROFILE === 'k8s' ? k8s() : tracker();
const send = (m: Obj) => process.stdout.write(JSON.stringify(m) + '\n');

createInterface({ input: process.stdin }).on('line', (line) => {
  let msg: Obj;
  try {
    msg = JSON.parse(line) as Obj;
  } catch {
    return;
  }
  const id = msg['id'];
  if (id === undefined) return;
  const method = msg['method'];
  const params = (msg['params'] ?? {}) as Obj;
  void (async () => {
    try {
      if (method === 'initialize') return send({ jsonrpc: '2.0', id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: `regression-${PROFILE}`, version: '0.0.0' } } });
      if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
      if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: profile.tools } });
      if (method === 'tools/call') {
        const name = String(params['name']);
        const args = { ...((params['arguments'] as Obj) ?? {}) };
        if (CALL_LOG) appendFileSync(CALL_LOG, JSON.stringify({ tool: name, args }) + '\n');
        if (!profile.tools.some((t) => t.name === name)) return send({ jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool ${name}` } });
        try {
          notices.length = 0;
          const res = (await profile.call(name, args)) as { content?: { type: string; text: string }[] };
          if (notices.length && Array.isArray(res.content)) res.content = [...res.content, { type: 'text', text: notices.join(' ') }];
          return send({ jsonrpc: '2.0', id, result: res });
        } catch (e) {
          if (e instanceof SoftError) return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: e.message }] } });
          if (e instanceof ToolError) return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: e.message }], isError: true } });
          throw e;
        }
      }
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${String(method)}` } });
    } catch (e) {
      send({ jsonrpc: '2.0', id, error: { code: -32603, message: (e as Error).message } });
    }
  })();
});
