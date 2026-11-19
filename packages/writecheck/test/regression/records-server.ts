/**
 * A stdio MCP server over one table of records, in the shape of corpus target t14 (a CRUD server over an SQL table): rows are
 * read, updated and deleted by `conditions` (any column), a create answers with the new row's integer `rid`, no tool has
 * annotations, and unknown arguments are dropped without a word. Loopback backend only (RECORDS_URL). Test fixture only; not
 * a starting point for a server.
 */

import { createInterface } from 'node:readline';

const BACKEND = process.env['RECORDS_URL'] ?? '';
type Obj = Record<string, unknown>;
const TABLE = 'mwsc_items';
const prim = { type: ['string', 'number', 'boolean', 'null'] };
const TOOLS: Obj[] = [
  { name: 'list_tables', description: 'List all tables in the database.', inputSchema: { type: 'object', properties: {} } },
  { name: 'read_records', description: 'Read records from a table, with optional conditions.', inputSchema: { type: 'object', properties: { table: { type: 'string' }, conditions: { type: 'object', additionalProperties: prim }, limit: { type: 'number' }, offset: { type: 'number' } }, required: ['table'] } },
  { name: 'create_record', description: 'Insert a new record into a table.', inputSchema: { type: 'object', properties: { table: { type: 'string' }, data: { type: 'object', additionalProperties: prim } }, required: ['table', 'data'] } },
  { name: 'update_records', description: 'Update records in a table that match the conditions.', inputSchema: { type: 'object', properties: { table: { type: 'string' }, data: { type: 'object', additionalProperties: prim }, conditions: { type: 'object', additionalProperties: prim } }, required: ['table', 'data', 'conditions'] } },
  { name: 'delete_records', description: 'Delete records from a table that match the conditions.', inputSchema: { type: 'object', properties: { table: { type: 'string' }, conditions: { type: 'object', additionalProperties: prim } }, required: ['table', 'conditions'] } },
];

class ToolError extends Error {}

async function db(body: Obj): Promise<Obj> {
  const r = await fetch(BACKEND, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const out = (await r.json()) as Obj;
  if (!r.ok) throw new ToolError(`Error: ${String(out['error'])}`);
  return out;
}

const text = (v: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(v, null, 2) }] });
const isRecord = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v) && Object.values(v).every((x) => x === null || ['string', 'number', 'boolean'].includes(typeof x));

async function call(name: string, a: Obj): Promise<unknown> {
  if (name === 'list_tables') return text([{ name: TABLE }]);
  if (typeof a['table'] !== 'string') throw new ToolError('Invalid arguments: table: Required');
  if (a['table'] !== TABLE) throw new ToolError(`Error: SQLITE_ERROR: no such table: ${a['table']}`);
  const needs = (k: string) => {
    if (!isRecord(a[k])) throw new ToolError(`Invalid arguments: ${k}: Expected object, received ${a[k] === undefined ? 'undefined' : typeof a[k]}`);
    return a[k] as Obj;
  };
  switch (name) {
    case 'read_records': {
      if (a['conditions'] !== undefined) needs('conditions');
      const { rows } = (await db({ op: 'select', conditions: a['conditions'] ?? {} })) as { rows: Obj[] };
      return text(rows);
    }
    case 'create_record': {
      const data = needs('data');
      if (!Object.keys(data).length) throw new ToolError('Error: SQLITE_ERROR: near ")": syntax error');
      const r = await db({ op: 'insert', data });
      return text({ message: 'Record created successfully', insertedId: r['lastID'] });
    }
    case 'update_records': {
      const data = needs('data');
      const conditions = needs('conditions');
      // The real server builds `SET … WHERE …` from the keys: an empty object is a syntax error, never "every row".
      if (!Object.keys(data).length || !Object.keys(conditions).length) throw new ToolError('Error: SQLITE_ERROR: near "WHERE": syntax error');
      const r = await db({ op: 'update', data, conditions });
      return text({ message: 'Records updated successfully', rowsAffected: r['changes'] });
    }
    case 'delete_records': {
      const conditions = needs('conditions');
      if (!Object.keys(conditions).length) throw new ToolError('Error: SQLITE_ERROR: incomplete input');
      const r = await db({ op: 'delete', conditions });
      return text({ message: 'Records deleted successfully', rowsAffected: r['changes'] });
    }
  }
  throw new ToolError(`unknown tool ${name}`);
}

const send = (m: Obj) => process.stdout.write(JSON.stringify(m) + '\n');

createInterface({ input: process.stdin }).on('line', (line) => {
  let msg: Obj;
  try {
    msg = JSON.parse(line) as Obj;
  } catch {
    return;
  }
  const id = msg['id'];
  const method = msg['method'];
  if (id === undefined) return;
  const params = (msg['params'] ?? {}) as Obj;
  void (async () => {
    try {
      if (method === 'initialize') return send({ jsonrpc: '2.0', id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'records-fake', version: '0.0.0' } } });
      if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
      if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      if (method === 'tools/call') {
        const name = String(params['name']);
        if (!TOOLS.some((t) => t['name'] === name)) return send({ jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool ${name}` } });
        try {
          return send({ jsonrpc: '2.0', id, result: await call(name, { ...((params['arguments'] as Obj) ?? {}) }) });
        } catch (e) {
          return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: (e as Error).message }], isError: true } });
        }
      }
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${String(method)}` } });
    } catch (e) {
      send({ jsonrpc: '2.0', id, error: { code: -32603, message: (e as Error).message } });
    }
  })();
});
