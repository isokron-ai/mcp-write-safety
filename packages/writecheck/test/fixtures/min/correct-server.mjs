#!/usr/bin/env node
// The correct-server fixture of min mode's mock-limit set (R-MIN-15, R-MIN-16): a small MCP server over stdio, our own code, that
// meets the MCP-layer requirements and uses its backend (correct-api.yaml) in the ways a mock made from that description cannot
// model fully. Min mode must give it no violated record:
//
//   search_items   a read that uses POST /items/search (an action endpoint the mock answers without modelling)
//   create_item    a create whose idempotency key is a request-body member the description declares
//   create_note    a create whose key goes in a header the description does not declare (X-Request-Id), and whose resource's
//                  identifier member the path does not name for certain (/notes/{noteIdOrKey})
//   add_tag        an additive list write done as read-modify-write: it reads the item and PATCHes the whole tag list back, with
//                  every member re-serialized in another key order
//   rename_item    a write whose argument is sent under another name (item_title -> title), with a member the resource does not
//                  have (client), that leaves the length limit to the backend (which declares it)
//   get_item       a read by a handle-style identifier (/items/{item_number})
//   create_label   a create the backend deduplicates by name (it declares a 409 for an existing name), so it needs no key
//
// FIX_HEARTBEAT=1 also writes POST /heartbeats every 200 ms in the background, and on every read call sends one it does not wait
// for (so it reaches the backend while the call is open) before it answers, 30 ms later. FIX_READ_ONLY: true (read-only), false, enabled
// (writes on, as the declaration says) or unset; any other value stops the server (exit 2). FIX_API_URL is the backend, and
// FIX_API_TOKEN its bearer token. No dependency.
import { createInterface } from 'node:readline';

const BASE = process.env.FIX_API_URL;
const TOKEN = process.env.FIX_API_TOKEN ?? '';
const ro = process.env.FIX_READ_ONLY ?? '';
if (!['', 'true', 'false', 'enabled'].includes(ro)) {
  process.stderr.write(`FIX_READ_ONLY=${JSON.stringify(ro)} is not one of true, false, enabled. Not starting.\n`);
  process.exit(2);
}
if (!BASE) {
  process.stderr.write('FIX_API_URL is not set. Not starting.\n');
  process.exit(2);
}
const readOnly = ro === 'true';

const str = (o = {}) => ({ type: 'string', ...o });
const int = (o = {}) => ({ type: 'integer', ...o });
const TOOLS = [
  { name: 'search_items', description: 'Search items by text.', inputSchema: { type: 'object', properties: { q: str({ maxLength: 100 }) }, additionalProperties: false }, annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'get_item', description: 'Read one item by its number.', inputSchema: { type: 'object', properties: { item_number: int({ minimum: 1 }) }, required: ['item_number'], additionalProperties: false }, annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'create_item', description: 'Create an item. Pass an idempotency_key so that a retry after a lost answer does not create a second one.', inputSchema: { type: 'object', properties: { title: str({ minLength: 1, maxLength: 50 }), idempotency_key: str({ minLength: 8, maxLength: 64, pattern: '^[A-Za-z0-9_-]+$' }) }, required: ['title'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
  { name: 'create_note', description: 'Create a note. Pass a request_id so that a retry does not create a second one.', inputSchema: { type: 'object', properties: { text: str({ minLength: 1, maxLength: 200 }), request_id: str({ minLength: 8, maxLength: 64, pattern: '^[A-Za-z0-9_-]+$' }) }, required: ['text'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
  { name: 'add_tag', description: 'Add one tag to an item; other tags stay.', inputSchema: { type: 'object', properties: { item_number: int({ minimum: 1 }), name: str({ minLength: 1, maxLength: 20 }), color: str({ minLength: 1, maxLength: 20 }) }, required: ['item_number', 'name', 'color'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: 'rename_item', description: 'Rename an item. Pass expected_version from get_item: if the item changed since, nothing is changed.', inputSchema: { type: 'object', properties: { item_number: int({ minimum: 1 }), item_title: str({ minLength: 1, maxLength: 50 }), expected_version: int({ minimum: 1 }) }, required: ['item_number', 'item_title', 'expected_version'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } },
];
TOOLS.push({ name: 'create_label', description: 'Create a label. A label name is unique: creating an existing one is refused.', inputSchema: { type: 'object', properties: { name: str({ minLength: 1, maxLength: 30 }) }, required: ['name'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } });
const WRITES = new Set(['create_item', 'create_note', 'add_tag', 'rename_item', 'create_label']);
const heartbeat = process.env.FIX_HEARTBEAT === '1';

/** The server's own input check: types, required, unknown arguments, and the limits it enforces itself (not item_title's). */
function check(tool, args) {
  const s = tool.inputSchema;
  for (const k of Object.keys(args)) if (!(k in s.properties)) return `Invalid argument ${k}: not an argument of ${tool.name} (expected one of ${Object.keys(s.properties).join(', ')}). Nothing was changed.`;
  for (const k of s.required ?? []) if (args[k] === undefined) return `Invalid argument ${k}: it is required. Nothing was changed.`;
  for (const [k, v] of Object.entries(args)) {
    const p = s.properties[k];
    if (p.type === 'string' && typeof v !== 'string') return `Invalid argument ${k}: must be a string. Nothing was changed.`;
    if (p.type === 'integer' && !Number.isInteger(v)) return `Invalid argument ${k}: must be an integer. Nothing was changed.`;
    if (k === 'item_title') continue; // left to the backend, which declares the limit
    if (typeof v === 'string' && p.maxLength !== undefined && v.length > p.maxLength) return `Invalid argument ${k}: must be at most ${p.maxLength} characters. Nothing was changed.`;
    if (typeof v === 'string' && p.minLength !== undefined && v.length < p.minLength) return `Invalid argument ${k}: must be at least ${p.minLength} characters. Nothing was changed.`;
    if (typeof v === 'string' && p.pattern && !new RegExp(p.pattern).test(v)) return `Invalid argument ${k}: must match ${p.pattern}. Nothing was changed.`;
    if (typeof v === 'number' && p.minimum !== undefined && v < p.minimum) return `Invalid argument ${k}: must be at least ${p.minimum}. Nothing was changed.`;
  }
  return null;
}

async function api(method, path, body, headers = {}) {
  try {
    const r = await fetch(new URL(path, BASE), { method, headers: { authorization: `Bearer ${TOKEN}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: r.status, body: json };
  } catch {
    return { status: 0, body: null };
  }
}

const ok = (text, structured) => ({ content: [{ type: 'text', text }], structuredContent: structured });
const err = (text) => ({ content: [{ type: 'text', text }], isError: true });
/** A failed backend request, said as what it is: a refusal applied nothing; no answer or a server error leaves it open. */
function failed(res, what, read) {
  if (res.status === 412) {
    const v = res.body?.current?.version;
    return err(`${what}: the item changed since the version you read${v !== undefined ? ` (current version ${v})` : ''}; nothing was changed. Read it with get_item and try the change on what it shows.`);
  }
  if (res.status >= 400 && res.status < 500) return err(`${what}: refused (status ${res.status}); nothing was changed.`);
  return err(`${what}: ${res.status ? `the API answered ${res.status}` : 'no answer from the API'}. It is not known whether the change was applied; ${read} before making it again.`);
}

async function call(name, args) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return err(`Unknown tool ${name}.`);
  const bad = check(tool, args ?? {});
  if (bad) return err(bad);
  if (readOnly && WRITES.has(name)) return err(`The server is in read-only mode (FIX_READ_ONLY=true); ${name} is refused. Nothing was changed.`);
  if (heartbeat && !WRITES.has(name)) {
    void api('POST', '/heartbeats', { at: new Date().toISOString() });
    await new Promise((r) => setTimeout(r, 30));
  }
  if (name === 'create_label') {
    const r = await api('POST', '/labels', { name: args.name });
    if (r.status === 201 && r.body?.label) return ok(`Created label ${r.body.label.id} (${JSON.stringify(r.body.label.name)}).`, { id: r.body.label.id, name: r.body.label.name });
    if (r.status === 409) return err(`A label named ${JSON.stringify(args.name)} already exists; nothing was created.`);
    if (r.status >= 400 && r.status < 500) return err(`Refused (status ${r.status}); nothing was created.`);
    return err(`${r.status ? `The API answered ${r.status}` : 'No answer from the API'}. It is not known whether the label was created; a repeat is refused if it was.`);
  }
  if (name === 'search_items') {
    const r = await api('POST', '/items/search', { q: args.q ?? '' });
    if (r.status !== 200) return err(`Search failed (status ${r.status}).`);
    const items = r.body?.items ?? [];
    return ok(`${items.length} item(s).`, { items: items.map((i) => ({ number: i.number, title: i.title })) });
  }
  if (name === 'get_item') {
    const r = await api('GET', `/items/${args.item_number}`);
    if (r.status !== 200) return err(`Item #${args.item_number}: not found or not readable (status ${r.status}).`);
    const i = r.body.item;
    return ok(`Item #${i.number}: ${JSON.stringify(i.title)}, tags ${JSON.stringify((i.tags ?? []).map((t) => t.name))}, current version ${i.version}.`, { number: i.number, title: i.title, tags: i.tags, version: i.version });
  }
  if (name === 'create_item') {
    const r = await api('POST', '/items', { title: args.title, ...(args.idempotency_key ? { idempotency_key: args.idempotency_key } : {}) });
    if (r.status === 201 && r.body?.item) {
      const i = r.body.item;
      return ok(`Created item #${i.number} (id ${i.id}), version ${i.version}.`, { number: i.number, id: i.id, version: i.version });
    }
    if (r.status === 422) return err(`Refused (status 422): ${r.body?.message ?? 'invalid'}; nothing was created.`);
    if (r.status >= 400 && r.status < 500) return err(`Refused (status ${r.status}); nothing was created.`);
    return err(`${r.status ? `The API answered ${r.status}` : 'No answer from the API'}. It is not known whether the item was created; list items with search_items before creating it again${args.idempotency_key ? ', or repeat with the same idempotency_key' : ''}.`);
  }
  if (name === 'create_note') {
    const r = await api('POST', '/notes', { text: args.text }, args.request_id ? { 'x-request-id': args.request_id } : {});
    if (r.status === 201 && r.body?.note) return ok(`Created note ${r.body.note.id} (key ${r.body.note.key}).`, { id: r.body.note.id, key: r.body.note.key });
    if (r.status >= 400 && r.status < 500) return err(`Refused (status ${r.status}); nothing was created.`);
    return err(`${r.status ? `The API answered ${r.status}` : 'No answer from the API'}. It is not known whether the note was created; repeat only with the same request_id.`);
  }
  if (name === 'add_tag') {
    const g = await api('GET', `/items/${args.item_number}`);
    if (g.status !== 200) return err(`Item #${args.item_number}: could not be read (status ${g.status}); nothing was changed.`);
    const item = g.body.item;
    if ((item.tags ?? []).some((t) => t.name === args.name)) return ok(`Item #${item.number} already has tag ${args.name}; nothing changed (version ${item.version}).`, { number: item.number, version: item.version, changed: [] });
    // Read-modify-write: every tag the item has, re-serialized in another key order, and the new one.
    const tags = [...(item.tags ?? []).map((t) => ({ color: t.color, name: t.name })), { color: args.color, name: args.name }];
    const r = await api('PATCH', `/items/${args.item_number}`, { tags }, { 'if-match': `"${item.version}"` });
    if (r.status !== 200) return failed(r, `Adding tag ${args.name} to item #${args.item_number}`, `read item #${args.item_number} with get_item`);
    return ok(`Added tag ${args.name} to item #${item.number}; tags changed. Now at version ${r.body.item.version}.`, { number: item.number, version: r.body.item.version, changed: ['tags'] });
  }
  if (name === 'rename_item') {
    const r = await api('PATCH', `/items/${args.item_number}`, { title: args.item_title, client: 'correct-server-fixture' }, { 'if-match': `"${args.expected_version}"` });
    if (r.status !== 200) return failed(r, `Renaming item #${args.item_number}`, `read item #${args.item_number} with get_item`);
    return ok(`Renamed item #${r.body.item.number}: title changed. Now at version ${r.body.item.version}.`, { number: r.body.item.number, version: r.body.item.version, changed: ['title'] });
  }
  return err(`Unknown tool ${name}.`);
}

if (heartbeat) setInterval(() => void api('POST', '/heartbeats', { at: new Date().toISOString() }), 200).unref();

const say = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
createInterface({ input: process.stdin }).on('line', async (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.id === undefined) return;
  if (m.method === 'initialize') return say({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'min-correct-server', version: '1.0.0' } } });
  if (m.method === 'tools/list') return say({ jsonrpc: '2.0', id: m.id, result: { tools: TOOLS } });
  if (m.method === 'tools/call') return say({ jsonrpc: '2.0', id: m.id, result: await call(m.params?.name, m.params?.arguments ?? {}) });
  if (m.method === 'ping') return say({ jsonrpc: '2.0', id: m.id, result: {} });
  say({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `method ${m.method} not found` } });
});
process.stdin.on('end', () => process.exit(0));
