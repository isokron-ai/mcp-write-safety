/**
 * A minimal stdio MCP server backed by Postgres (through DATABASE_URL), for the end-to-end test of
 * the wire gate: whoami (the guard), get_item and update_item (a field patch: one single-row UPDATE
 * per call, the way a per-field database server writes). Items live in the fake Postgres's kv table
 * as `<field>:<id>` keys. Newline-delimited JSON-RPC. Test fixture only.
 *
 * With B1_IR set it also lists create_item (two INSERTs: title, then status), list_items, delete_item, close_item and
 * close_items (one UPDATE per item, no transaction), for MWS-RETRY-3, the multi-item trials and the create's late failure
 * through the wire gate: close_item
 * answers input_required (revision 2026-07-28) and closes the item on the retry with the confirmation. B1_IR=early: it writes
 * `status = closed` to the database before it answers input_required (the defect the proxy position of MWS-RETRY-3 sees);
 * B1_IR=correct: it writes nothing before the confirmation.
 */

import { createInterface } from 'node:readline';

import { PgClient } from './pg.js';

const url = new URL(process.env['DATABASE_URL'] ?? 'postgres://127.0.0.1:5432/x');
let conn: Promise<PgClient> | null = null;
let chain: Promise<unknown> = Promise.resolve();
/** One connection per process; statements are sent one at a time, as a pool of size one would. */
function sql<T>(f: (c: PgClient) => Promise<T>): Promise<T> {
  conn ??= PgClient.connect(Number(url.port || 5432));
  const next = chain.then(async () => {
    let c = await conn!;
    // why: after the gate cut the connection (a lost-answer trial) the next call opens a new one, as a pool would.
    if (c.closed) c = await (conn = PgClient.connect(Number(url.port || 5432)));
    return f(c);
  });
  chain = next.catch(() => undefined);
  return next;
}

const FIELDS = ['title', 'status'];
async function read(id: string): Promise<Record<string, string> | null> {
  const out: Record<string, string> = { id, name: id };
  for (const f of FIELDS) {
    const a = await sql((c) => c.send(PgClient.ext('SELECT v FROM kv WHERE k = $1', [`${f}:${id}`])));
    if (a.error) throw new Error(`database error ${a.error}`);
    // An item exists while its title row does; a field whose row is missing (a create cut after its first INSERT) is left out.
    if (!a.rows.length) {
      if (f === 'title') return null;
      continue;
    }
    out[f] = a.rows[0]!;
  }
  return out;
}

const tools: { name: string; description: string; inputSchema: Record<string, unknown>; annotations: Record<string, boolean> }[] = [
  { name: 'whoami', description: 'Who the server acts as.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'get_item', description: 'Read one item.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false }, annotations: { readOnlyHint: true } },
  {
    name: 'update_item',
    description: 'Set one field of an item. Other fields are left as they are.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, field: { type: 'string', enum: FIELDS }, value: { type: 'string' } }, required: ['id', 'field', 'value'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
];

const IR = process.env['B1_IR'] ?? '';
if (IR)
  tools.push(
    { name: 'create_item', description: 'Create an item named name (its id is the name), status open.', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false } },
    { name: 'delete_item', description: 'Delete an item.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true } },
    { name: 'list_items', description: 'List every item.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
    { name: 'close_items', description: 'Close several items, one after the other (no transaction).', inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } } }, required: ['ids'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true } },
    { name: 'close_item', description: 'Close an item. Asks for a confirmation first (an input_required result); nothing is written before it.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true } },
  );

async function exec(stmt: string, params: string[]): Promise<{ error: string | null; tags: string[]; state: unknown }> {
  return sql((c) => c.send(PgClient.ext(stmt, params), { ms: 8000 })) as never;
}

const text = (o: unknown, isError = false) => ({ content: [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o) }], ...(isError ? { isError: true } : {}) });

async function call(name: string, a: Record<string, unknown>, p?: Record<string, unknown>): Promise<unknown> {
  if (name === 'whoami') return text({ tenant: 'mwsc-test-1' });
  if (IR && name === 'create_item') {
    if (typeof a['name'] !== 'string' || !a['name']) return text('name must be a non-empty string', true);
    for (const [f, v] of [['title', a['name']], ['status', 'open']] as const) {
      const r = await exec('INSERT INTO kv (k, v) VALUES ($1, $2)', [`${f}:${a['name']}`, v]);
      if (r.error) return text(`the item was not created (database error ${r.error})`, true);
    }
    return text({ created: true, id: a['name'], name: a['name'] });
  }
  if (IR && name === 'list_items') {
    const r = (await sql((c) => c.send(PgClient.ext('SELECT k FROM kv WHERE k LIKE $1', ['title:%']), { ms: 8000 }))) as { error: string | null; rows: string[] };
    if (r.error) return text(`database error ${r.error}`, true);
    const items: Record<string, string>[] = [];
    for (const k of r.rows) {
      const o = await read(k.slice('title:'.length));
      if (o) items.push({ ...o, name: o['title']! });
    }
    return text({ items });
  }
  if (IR && name === 'close_items') {
    const ids = a['ids'];
    if (!Array.isArray(ids) || !ids.every((x) => typeof x === 'string')) return text('ids must be a list of strings', true);
    const done: string[] = [];
    for (const id of ids as string[]) {
      const r = await exec('UPDATE kv SET v = $1 WHERE k = $2', ['closed', `status:${id}`]);
      if (r.state === null) return text(`the connection was lost at ${id}; closed before it: ${done.join(', ') || 'none'}`, true);
      if (r.error) return text(`${id} was not closed (database error ${r.error}); closed before it: ${done.join(', ') || 'none'}`, true);
      if (r.tags[0] !== 'UPDATE 1') return text(`item ${id} not found; closed before it: ${done.join(', ') || 'none'}`, true);
      done.push(id);
    }
    return text({ closed: done });
  }
  if (IR && name === 'delete_item') {
    if (typeof a['id'] !== 'string') return text('id must be a string', true);
    let n = 0;
    for (const f of FIELDS) {
      const r = await exec('DELETE FROM kv WHERE k = $1', [`${f}:${a['id']}`]);
      if (r.error) return text(`the item was not deleted (database error ${r.error})`, true);
      if (r.tags[0] === 'DELETE 1') n++;
    }
    return n ? text({ deleted: true, id: a['id'] }) : text(`item ${a['id']} not found`, true);
  }
  if (IR && name === 'close_item') {
    if (typeof a['id'] !== 'string') return text('id must be a string', true);
    const close = async () => {
      const r = await exec('UPDATE kv SET v = $1 WHERE k = $2', ['closed', `status:${a['id']}`]);
      return r.error ? `database error ${r.error}` : r.tags[0] === 'UPDATE 1' ? null : `item ${a['id']} not found`;
    };
    if (!p?.['inputResponses']) {
      // B1_IR=early (the defect): the write goes to the database before the confirmation is asked for.
      if (IR === 'early') {
        const e = await close();
        if (e) return text(e, true);
      }
      return { resultType: 'input_required', inputRequests: { confirm: { method: 'elicitation/create', params: { mode: 'form', message: `Close ${a['id']}?`, requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean' } }, required: ['confirm'] } } } }, requestState: `close:${a['id']}` };
    }
    const ans = (p['inputResponses'] as Record<string, { action?: string; content?: { confirm?: boolean } }>)['confirm'];
    if (ans?.action !== 'accept' || ans.content?.confirm !== true) return text('not closed: the confirmation was declined', true);
    const e = await close();
    return e ? text(e, true) : text({ closed: true, id: a['id'] });
  }
  const known = new Set(name === 'get_item' ? ['id'] : ['id', 'field', 'value']);
  const extra = Object.keys(a).find((k) => !known.has(k));
  if (extra) return text(`unknown argument ${extra}`, true);
  if (typeof a['id'] !== 'string') return text('id must be a string', true);
  if (name === 'get_item') {
    const o = await read(a['id']);
    return o ? text(o) : text(`item ${a['id']} not found`, true);
  }
  if (name === 'update_item') {
    if (typeof a['field'] !== 'string' || !FIELDS.includes(a['field'])) return text('field must be title or status', true);
    if (typeof a['value'] !== 'string') return text('value must be a string', true);
    const upd = PgClient.ext('UPDATE kv SET v = $1 WHERE k = $2', [a['value'] as string, `${a['field']}:${a['id']}`]);
    // B1_TXN=commit: the write inside an explicit transaction, as BEGIN, the UPDATE and COMMIT on one connection.
    const r = await sql(async (c) => {
      if (process.env['B1_TXN'] !== 'commit') return c.send(upd, { ms: 8000 });
      const b = await c.query('BEGIN', 8000);
      if (b.state === null || b.error) return b;
      const u = await c.send(upd, { ms: 8000 });
      if (u.state === null || u.error) return u.state === null ? u : (await c.query('ROLLBACK', 8000), u);
      const cm = await c.query('COMMIT', 8000);
      return cm.state === null || cm.error ? cm : u;
    });
    if (r.state === null) return text('the database connection was lost; the update may or may not have been applied', true);
    if (r.error) return text(`the update was not applied (database error ${r.error})`, true);
    if (r.tags[0] !== 'UPDATE 1') return text(`item ${a['id']} not found`, true);
    const o = await read(a['id']);
    return text({ updated: true, item: o });
  }
  return text(`unknown tool ${name}`, true);
}

const send = (m: unknown) => process.stdout.write(`${JSON.stringify(m)}\n`);
createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line) as { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown>; protocolVersion?: string } & Record<string, unknown> };
  const id = msg.id;
  if (id === undefined) return;
  if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'b1-pg-fixture', version: '0.0.0' } } });
  if (msg.method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools } });
  if (msg.method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (msg.method === 'tools/call')
    return void call(msg.params?.name ?? '', msg.params?.arguments ?? {}, msg.params).then(
      (result) => send({ jsonrpc: '2.0', id, result }),
      (e: Error) => send({ jsonrpc: '2.0', id, result: text(e.message, true) }),
    );
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } });
});
process.stdin.on('end', () => process.exit(0));
