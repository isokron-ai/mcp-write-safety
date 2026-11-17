/**
 * A minimal in-repo stand-in for the tiny-tracker MCP server (stdio, newline-delimited JSON-RPC),
 * used until the sample server lands. The correct handlers are the default; each defect, switched on
 * with TRACKER_DEFECTS=<id>[,<id>…], replaces one correct behaviour with the shape of a published
 * defect class, named by the requirement it violates. Loopback backend only (TRACKER_URL).
 * Test fixture only; not a starting point for a server.
 */

import { createInterface } from 'node:readline';

const BACKEND = process.env['TRACKER_URL'] ?? '';
const DEFECTS = new Set((process.env['TRACKER_DEFECTS'] ?? '').split(',').map((s) => s.trim()).filter(Boolean));
const on = (d: string) => DEFECTS.has(d);
if (DEFECTS.size) process.stderr.write(`tiny-tracker (fake): DEFECTS ON: ${[...DEFECTS].join(', ')}\n`);

type Obj = Record<string, unknown>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const STATUS = ['open', 'closed', 'blocked'];
const TOOLS: Obj[] = [
  { name: 'whoami', description: 'The tenant this server writes to.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'ticket_get', description: 'Read one ticket by id.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false }, annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } },
  { name: 'ticket_list', description: 'List tickets whose title starts with a prefix.', inputSchema: { type: 'object', properties: { prefix: { type: 'string' } }, additionalProperties: false }, annotations: on('MWS-ANN-4') ? undefined : { readOnlyHint: true, openWorldHint: false } },
  {
    name: 'ticket_create',
    description: 'Create a ticket. Pass idempotency_key to make a retry safe.',
    inputSchema: { type: 'object', properties: { title: { type: 'string', minLength: 1, maxLength: 200 }, status: { type: 'string', enum: STATUS }, assignee: { type: 'string' }, priority: { type: 'integer', minimum: 1, maximum: 5 }, idempotency_key: { type: 'string' } }, required: ['title'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: on('MWS-ANN-3'), openWorldHint: false },
  },
  {
    name: 'ticket_update',
    description: 'Change the named fields of a ticket; fields not sent keep their values.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string', minLength: 1 }, status: { type: 'string', enum: STATUS }, assignee: { type: 'string' }, priority: { type: 'integer', minimum: 1, maximum: 5 } }, required: ['id'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: !on('MWS-ANN-2'), idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'ticket_replace',
    description: 'Replace a whole ticket. The ticket must carry the version it was read at; a stale version is refused.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, ticket: { type: 'object' } }, required: ['id', 'ticket'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  // Variant versioned-delete (not a defect): the delete needs the version just read (research builds N4).
  on('versioned-delete')
    ? { name: 'ticket_delete', description: 'Delete a ticket. Pass the version you read; a stale or missing version is refused.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, version: { type: 'integer' } }, required: ['id', 'version'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } }
    : { name: 'ticket_delete', description: 'Delete a ticket.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } },
];

class ToolError extends Error {}
/** connection-keyed: the version this connection last saw, per ticket. */
const lastSeen = new Map<string, unknown>();
class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Obj; headers: Headers }> {
  const r = await fetch(`${BACKEND}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text();
  return { status: r.status, body: text ? (JSON.parse(text) as Obj) : {}, headers: r.headers };
}

function check(name: string, args: Obj): void {
  const tool = TOOLS.find((t) => t.name === name)!;
  const schema = tool['inputSchema'] as { properties: Record<string, Obj>; required?: string[] };
  const fail = (m: string) => {
    if (on('MWS-IN-4')) throw new RpcError(-32603, `TypeError: Cannot read properties of undefined (reading '${m.split(' ')[0]}')`);
    throw new ToolError(`invalid arguments: ${m}`);
  };
  for (const r of schema.required ?? []) if (args[r] === undefined) fail(`${r} is required`);
  for (const [k, v] of Object.entries(args)) {
    const s = schema.properties[k];
    if (!s) {
      if (on('MWS-IN-2')) {
        delete args[k];
        continue;
      }
      fail(`${k} is not an argument of ${name}`);
      continue;
    }
    const type = s['type'];
    const typeOk = type === 'string' ? typeof v === 'string' : type === 'integer' ? Number.isInteger(v) : type === 'object' ? typeof v === 'object' && v !== null && !Array.isArray(v) : true;
    if (!typeOk) {
      if (on('MWS-IN-1')) {
        // The coercion defect: the value is converted instead of refused.
        // (An object or a list is flattened to a string: a conversion that changes the meaning, spec MWS-IN-1.)
        if (type === 'string' && v !== null) args[k] = String(v);
        else if (type === 'integer' && v !== null && Number.isFinite(Number(v))) args[k] = Math.trunc(Number(v));
        else if (type === 'integer' && v === null) args[k] = 0;
        else fail(`${k} must be ${type}`);
        continue;
      }
      if (on('MWS-RES-2') && name === 'ticket_update' && k === 'assignee') continue; // handled in the handler
      fail(`${k} must be ${type === 'integer' ? 'an integer' : `a ${type}`}`);
      continue;
    }
    if (Array.isArray(s['enum']) && !(s['enum'] as unknown[]).includes(v)) {
      if (on('MWS-IN-3')) {
        delete args[k];
        continue;
      }
      fail(`${k} must be one of ${(s['enum'] as string[]).join(', ')}`);
    }
    if (typeof v === 'number' && ((typeof s['minimum'] === 'number' && v < s['minimum']) || (typeof s['maximum'] === 'number' && v > s['maximum']))) {
      if (on('MWS-IN-3')) {
        args[k] = Math.min(Math.max(v, (s['minimum'] as number) ?? v), (s['maximum'] as number) ?? v);
        continue;
      }
      fail(`${k} must be from ${s['minimum']} to ${s['maximum']}`);
    }
    if (typeof v === 'string' && ((typeof s['maxLength'] === 'number' && v.length > s['maxLength']) || (typeof s['minLength'] === 'number' && v.length < s['minLength']))) {
      if (on('MWS-IN-3')) continue;
      fail(`${k} must be ${s['minLength'] ?? 0} to ${s['maxLength'] ?? '∞'} characters`);
    }
  }
}

const ok = (data: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });
const backendError = (r: { status: number; body: Obj }) => new ToolError(`the tracker refused the request (HTTP ${r.status}): ${String(r.body['error'] ?? '')}`);
const keyMap = new Map<string, string>();

async function call(name: string, args: Obj): Promise<unknown> {
  check(name, args);
  switch (name) {
    case 'whoami':
      // Variant whoami-writes (review B2): a "touch"-like call that answers the same each time and creates a ticket each time.
      if (on('whoami-writes')) await api('POST', '/tickets', { title: 'guard-touch' });
      return ok((await api('GET', '/whoami')).body);
    case 'ticket_get': {
      const r = await api('GET', `/tickets/${encodeURIComponent(String(args['id']))}`);
      if (r.status !== 200) throw backendError(r);
      lastSeen.set(String(args['id']), r.body['version']);
      return ok({ ticket: r.body });
    }
    case 'ticket_list': {
      const r = await api('GET', `/tickets?prefix=${encodeURIComponent(String(args['prefix'] ?? ''))}`);
      const items = (r.body['items'] as Obj[]) ?? [];
      if (on('MWS-ANN-1')) for (const t of items) await api('POST', `/tickets/${encodeURIComponent(String(t['id']))}/seen`);
      return ok({ items });
    }
    case 'ticket_create': {
      const { idempotency_key: key, ...body } = args;
      if (typeof key === 'string' && on('MWS-RETRY-2:reuse')) {
        // Defect: the server keeps its own key map and replays without comparing the arguments.
        const prev = keyMap.get(key);
        if (prev) return ok({ id: prev, ticket: (await api('GET', `/tickets/${prev}`)).body, replayed: true });
      }
      if (on('MWS-RETRY-2:args')) {
        // Defect: deduplicates by title, whatever the key.
        const same = ((await api('GET', `/tickets?prefix=${encodeURIComponent(String(body['title']))}`)).body['items'] as Obj[]).find((t) => t['title'] === body['title']);
        if (same) return ok({ id: same['id'], ticket: same, replayed: true });
      }
      const headers: Record<string, string> = typeof key === 'string' && !on('MWS-RETRY-2') && !on('MWS-RETRY-2:reuse') && !on('MWS-RETRY-2:args') ? { 'idempotency-key': key } : {};
      const r = await api('POST', '/tickets', body, headers);
      if (r.status !== 201 && r.status !== 200) throw backendError(r);
      if (typeof key === 'string') keyMap.set(key, String(r.body['id']));
      return ok({ id: r.body['id'], ticket: r.body, replayed: r.headers.get('idempotent-replayed') === 'true' });
    }
    case 'ticket_update': {
      const { id, ...fields } = args;
      const path = `/tickets/${encodeURIComponent(String(id))}`;
      if (on('MWS-RES-2') && fields['assignee'] !== undefined && typeof fields['assignee'] !== 'string') {
        // Defect: stores the value, then reports the validation error.
        await api('PATCH', path, { assignee: String(fields['assignee']) });
        throw new ToolError('invalid arguments: assignee must be a string');
      }
      if (on('MWS-RES-1')) for (const [k, v] of Object.entries(fields)) if (v === '') delete fields[k]; // Defect: empty values skipped, success reported.
      if (on('MWS-UPD-1') && fields['status'] === undefined) fields['status'] = 'open'; // Defect: an omitted field reset to its default.
      if (on('MWS-CONC-3')) {
        // Defect: read, merge, and write the whole ticket back without a precondition.
        const cur = await api('GET', path);
        if (cur.status !== 200) throw backendError(cur);
        await sleep(40);
        const r = await api('PUT', path, { ...cur.body, ...fields });
        if (r.status !== 200) throw backendError(r);
        return ok({ ticket: r.body });
      }
      const r = await api('PATCH', path, fields);
      if (r.status !== 200) throw backendError(r);
      return ok({ ticket: r.body });
    }
    case 'ticket_replace': {
      const t = args['ticket'] as Obj;
      const path = `/tickets/${encodeURIComponent(String(args['id']))}`;
      // Variant connection-keyed (not a defect; MWS-CONC-2 option A, RB-1): like the Payload research build, the server keeps,
      // per connection (this process, one credential), the version it last showed for each ticket and uses that as the
      // precondition, ignoring the version the call carries. It refuses a replace on a ticket this connection never read.
      const keyed = on('connection-keyed') ? lastSeen.get(String(args['id'])) : undefined;
      if (on('connection-keyed') && keyed === undefined) throw new ToolError(`read ticket ${String(args['id'])} first; nothing was written`);
      const headers: Record<string, string> = on('MWS-CONC-2') ? {} : { 'if-match': String(on('connection-keyed') ? keyed : (t['version'] ?? '')) };
      const r = await api('PUT', path, t, headers);
      if (r.status === 412) {
        const msg = `conflict: ticket ${String(args['id'])} changed since version ${String(t['version'])}; nothing was written. Re-read it and retry.`;
        if (on('MWS-CONC-4')) throw new RpcError(-32000, msg);
        throw new ToolError(msg);
      }
      if (r.status !== 200) throw backendError(r);
      lastSeen.set(String(args['id']), r.body['version']);
      return ok({ ticket: r.body });
    }
    case 'ticket_delete': {
      if (on('versioned-delete')) {
        const cur = await api('GET', `/tickets/${encodeURIComponent(String(args['id']))}`);
        if (cur.status !== 200) throw backendError(cur);
        if (cur.body['version'] !== args['version']) throw new ToolError(`version ${JSON.stringify(args['version'] ?? null)} is not the ticket's current version; nothing was deleted`);
      }
      const r = await api('DELETE', `/tickets/${encodeURIComponent(String(args['id']))}`);
      if (r.status !== 204) throw backendError(r);
      return ok({ deleted: args['id'] });
    }
  }
  throw new RpcError(-32602, `unknown tool ${name}`);
}

const send = (m: Obj) => process.stdout.write(JSON.stringify(m) + '\n');

let initialized = false;
// templates-not-found (robustness item 2): resources and prompts are declared, and their lists answer -32601 Method not found.
createInterface({ input: process.stdin }).on('line', (line) => {
  let msg: Obj;
  try {
    msg = JSON.parse(line) as Obj;
  } catch {
    return;
  }
  const id = msg['id'];
  const method = msg['method'];
  // exit-before-initialize (corpus verification, robustness item 1): the shape of a server on the MCP Python SDK 1.6, which exits
  // on any message before initialize.
  if (on('exit-before-initialize') && !initialized && method !== 'initialize') process.exit(3);
  if (method === 'initialize') initialized = true;
  // discover-crash (corpus run 3, t05): the shape of a server on an older MCP Python SDK, which fails validation on a method it
  // does not know (server/discover) and exits 1.
  if (on('discover-crash') && method === 'server/discover') {
    process.stderr.write('pydantic_core._pydantic_core.ValidationError: 1 validation error for ClientRequest\n');
    process.exit(1);
  }
  if (id === undefined) return;
  const params = (msg['params'] ?? {}) as Obj;
  void (async () => {
    try {
      if (method === 'initialize') return send({ jsonrpc: '2.0', id, result: { protocolVersion: on('old-revision') ? '2024-11-05' : '2025-11-25', capabilities: on('templates-not-found') ? { tools: {}, resources: {}, prompts: {} } : { tools: {} }, serverInfo: { name: 'tiny-tracker-fake', version: '0.0.0' } } });
      if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
      // Variant no-readonly-hints (review B2): no tool declares readOnlyHint: true, so the guard can only be a declared call.
      const listed = on('no-readonly-hints') ? TOOLS.map((t) => ((t['annotations'] as Obj | undefined)?.['readOnlyHint'] === true ? { ...t, annotations: undefined } : t)) : TOOLS;
      if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: listed.map((t) => Object.fromEntries(Object.entries(t).filter(([, v]) => v !== undefined))) } });
      if (method === 'tools/call') {
        const name = String(params['name']);
        if (!TOOLS.some((t) => t.name === name)) return send({ jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool ${name}` } });
        try {
          return send({ jsonrpc: '2.0', id, result: await call(name, { ...((params['arguments'] as Obj) ?? {}) }) });
        } catch (e) {
          // Test switch: deliver error answers late, after the client has given up.
          if (process.env['TRACKER_SLOW_ERRORS_MS']) await sleep(Number(process.env['TRACKER_SLOW_ERRORS_MS']));
          if (e instanceof RpcError) return send({ jsonrpc: '2.0', id, error: { code: e.code, message: e.message } });
          return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: (e as Error).message }], isError: true } });
        }
      }
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${String(method)}` } });
    } catch (e) {
      send({ jsonrpc: '2.0', id, error: { code: -32603, message: (e as Error).message } });
    }
  })();
});
