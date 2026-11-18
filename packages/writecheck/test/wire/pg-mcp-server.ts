/**
 * A minimal stdio MCP server backed by Postgres (through DATABASE_URL), for the end-to-end test of
 * the wire gate: whoami (the guard), get_item and update_item (a field patch: one single-row UPDATE
 * per call, the way a per-field database server writes). Items live in the fake Postgres's kv table
 * as `<field>:<id>` keys. Newline-delimited JSON-RPC. Test fixture only.
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
    if (!a.rows.length) return null;
    out[f] = a.rows[0]!;
  }
  return out;
}

const tools = [
  { name: 'whoami', description: 'Who the server acts as.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'get_item', description: 'Read one item.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false }, annotations: { readOnlyHint: true } },
  {
    name: 'update_item',
    description: 'Set one field of an item. Other fields are left as they are.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, field: { type: 'string', enum: FIELDS }, value: { type: 'string' } }, required: ['id', 'field', 'value'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
];

const text = (o: unknown, isError = false) => ({ content: [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o) }], ...(isError ? { isError: true } : {}) });

async function call(name: string, a: Record<string, unknown>): Promise<unknown> {
  if (name === 'whoami') return text({ tenant: 'mwsc-test-1' });
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
    const r = await sql((c) => c.send(PgClient.ext('UPDATE kv SET v = $1 WHERE k = $2', [a['value'] as string, `${a['field']}:${a['id']}`]), { ms: 8000 }));
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
  const msg = JSON.parse(line) as { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown>; protocolVersion?: string } };
  const id = msg.id;
  if (id === undefined) return;
  if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'b1-pg-fixture', version: '0.0.0' } } });
  if (msg.method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools } });
  if (msg.method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (msg.method === 'tools/call')
    return void call(msg.params?.name ?? '', msg.params?.arguments ?? {}).then(
      (result) => send({ jsonrpc: '2.0', id, result }),
      (e: Error) => send({ jsonrpc: '2.0', id, result: text(e.message, true) }),
    );
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } });
});
process.stdin.on('end', () => process.exit(0));
