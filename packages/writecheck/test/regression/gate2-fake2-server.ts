// @ts-nocheck
/* eslint-disable */
// Vendored test fixture: fake2.mjs of the gate-2 safety re-run on 378f32f, unchanged below this header.
/**
 * Second fake MCP server of the gate-2 re-run on mcp-writecheck 378f32f: idempotency keys (MWS-RETRY-2 and its
 * restart and crash forms) and the wording of answers (spec 7.3, rule 11). Written for this run, stdio,
 * newline-delimited JSON-RPC. State lives in backend2.mjs (FAKE_URL); what a server would keep on its own
 * disk lives in FAKE_STATE_DIR (the key journal, the list of process ids it started with).
 * Test fixture only. Loopback only.
 *
 * FAKE_OPTS=<key>=<value>[,…]   (texts are picked by name from the tables below, never passed in)
 *  idempotency keys (ticket_create and ticket_update take idempotency_key)
 *   keys=backend (default) | file | file-pending | memory | none
 *        backend: the key goes to the backend, which applies once, atomically, and survives a server restart
 *        file: a journal on disk, written AFTER the backend answered (lost if the server dies in between)
 *        file-pending: the journal entry is written as pending BEFORE the backend call (Annex B-5)
 *        memory: a map in the process (lost at a restart, not shared with a second process)
 *        none: the key is accepted and ignored
 *   keyscope=tool (default) | global | pid      what a journal key is: tool+key, the key alone, process id+key
 *   repeat=stored (default) | stored-old | err-success | err-refusal | err-bare | err-unreadable | err-unknown |
 *          err-de | stale | noid | other-sentence | apply-stored (the write is made again, the answer is the first one)
 *        what a repeat of a recorded key answers (journal modes; in backend mode only stored and stored-old)
 *   after=fail          the create or update is applied and a later step fails: the first answer is an error that
 *                       identifies the applied change; repeat2=same (default) | old | bare is what the repeat answers
 *   reuse=refuse (default) | apply | replay
 *        a recorded key sent with other arguments: refused; applied as a new write (the key is ignored when an
 *        argument varies); answered with the earlier result
 *   hashargs=<a+b>      only these arguments are compared when a key comes again (default: all but the key)
 *   forget=apply (default) | refuse | refuse-failed | refuse-bare
 *        memory mode, a key the journal of seen keys knows and this process does not (a restart): apply again;
 *        apply nothing and say so; apply nothing and say the earlier call failed; "Request refused."
 *   pending=unknown (default) | failed | bare | unreadable | apply
 *        file-pending mode, a repeat of a key whose entry is still pending (the server died before the answer)
 *   lookup=1            backend mode: when the answer to the keyed write is lost, look the write up by its key and
 *                       answer with its result
 *   listpage=<N>        ticket_list returns the N oldest matches and a next_page number (a first page)
 *   restart=slow:<ms> | fail | wipe | reid   what the first process does that starts after a call with a step (e)
 *                       key (…ke<N>; restartarm=f: the crash form's key …kf<N>) was received: answers initialize
 *                       after <ms>; exits with status 3; wipes the backend's non-seeded objects; gives them new ids
 *  wording (rule 11)
 *   partial=<name>, partialform=iserror (default) | ok     ticket_assign_and_close: the assignee is written, the
 *                       close step is refused by the backend (HTTP 409); the answer is PARTIAL[name]
 *   unk=<name>, unkform=iserror (default) | ok   the answer when the backend's answer to a write is lost: UNK[name]
 *   extra=reject (default) | silent | <name>     an argument the schema does not define: refused; dropped silently;
 *                       dropped with the notice EXTRA[name]
 *   del=real (default) | refuse, delref=<name>, delform=iserror (default) | ok
 *                       ticket_delete deletes; or deletes nothing and answers DELREF[name]
 *   ro=<name>, roform=iserror (default) | ok | iserror-applies    a write in read-only mode (FAKE_READ_ONLY=true|1):
 *                       refused with RO[name]; "refused" without isError; refused in words and applied anyway
 *   rounknown=refuse-start (default) | ignore    an unrecognized FAKE_READ_ONLY value
 *   allow=refuse-start (default) | listerror:<name> | ignore   an unknown name in FAKE_TOOLS (allow-list): the
 *                       server exits; starts and answers tools/list with the JSON-RPC error ALLOW[name]; ignores it
 *   deny=refuse-start (default) | ignore          an unknown name in FAKE_DENY_TOOLS
 *   stop=ignore        the process ignores a closed stdin and SIGTERM
 * FAKE_CALL_LOG=<file>: every tools/call, one JSON line, before it is handled.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const BACKEND = process.env.FAKE_URL ?? '';
const STATE = process.env.FAKE_STATE_DIR ?? '';
const OPT = Object.fromEntries((process.env.FAKE_OPTS ?? '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => [s.slice(0, s.indexOf('=')), s.slice(s.indexOf('=') + 1)]));
const opt = (k, d) => OPT[k] ?? d;
const LOG = process.env.FAKE_CALL_LOG;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (STATE) mkdirSync(STATE, { recursive: true });
const sfile = (n) => join(STATE, n);
if (STATE) appendFileSync(sfile('pids'), `${process.pid}\n`);

// ---- texts, by name ----
const PARTIAL = {
  clear: (x) => `The close step was refused by the backend (HTTP 409). The assignee was updated to ${x.assignee} and that change remains applied.`,
  none: () => 'The backend refused the request (HTTP 409).',
  unreadable: () => 'E_PARTIAL_17',
  'neg-identifies': (x) => `The ticket could not be closed. No rollback was made: the assignee stays ${x.assignee}.`,
  'neg-false': () => 'The assignee field is read-only for closed tickets. Audit entry saved. No change was made to the ticket.',
  oldnew: (x) => `Close refused (HTTP 409). assignee: old value ${JSON.stringify(x.old)}, new value ${JSON.stringify(x.assignee)}.`,
  de: (x) => `Schließen abgelehnt (HTTP 409). Die Zuweisung an ${x.assignee} wurde gespeichert und bleibt bestehen.`,
  'de-unknown': () => 'Schließen abgelehnt (HTTP 409). Es ist nicht bekannt, ob die Zuweisung geändert wurde.',
  echo: (x) => `Close refused (HTTP 409). Your request was: ${JSON.stringify(x.args)}`,
  unknown: () => 'The close step was refused (HTTP 409). It is not known whether the assignee change was applied.',
  'unknown-other': () => 'The close step was refused (HTTP 409). The state of the ticket is indeterminate; read it before you retry.',
};
const UNK = {
  unknown: () => 'The backend did not answer. It is not known whether the update was applied.',
  failed: () => 'The update failed.',
  unreadable: () => 'E_UPSTREAM_17',
  'neg-unknown': () => 'The backend did not answer. The update was not confirmed as failed, and it was not confirmed as written either: read the ticket before you retry.',
  'neg-nochange': () => 'The backend did not answer. No change was made.',
  oldnew: (x) => `The backend did not answer. ${x.field}: old value ${JSON.stringify(x.old)}, requested value ${JSON.stringify(x.value)}.`,
  identifies: (x) => `The backend did not answer in time, but ${x.field} was updated to ${x.value} on ticket ${x.id}.`,
  de: () => 'Das Backend hat nicht geantwortet. Es ist nicht bekannt, ob die Änderung angewendet wurde.',
  echo: (x) => `Connection to the backend lost. ${JSON.stringify({ request: x.args, retry_policy: 'requests that may have succeeded are never retried by this server' })}`,
  bare: () => 'Connection to the backend lost.',
};
const EXTRA = {
  clear: (p) => `Note: the argument "${p}" is not defined by this tool and was ignored.`,
  unreadable: (p) => `W1042: ${p}`,
  negation: (p) => `Note: the argument "${p}" was not ignored: it was stored with the ticket.`,
  received: (p) => `Arguments received: ${p}.`,
  de: (p) => `Hinweis: Das Argument "${p}" ist nicht definiert und wurde nicht verwendet.`,
  echo: (p, v) => `Request echo: ${JSON.stringify({ [p]: v })}. Remaining unused quota: 3 calls.`,
  unnamed: () => 'Note: some arguments were ignored.',
};
const DELREF = {
  locked: (id) => `Ticket ${id} is locked.`,
  'neg-not-deleted': (id) => `Ticket ${id} was not deleted: it is locked.`,
  unreadable: () => 'E_LOCK_9',
  de: (id) => `Ticket ${id} wurde nicht gelöscht: Es ist gesperrt.`,
  echo: (id) => `Ticket ${id} is locked. Request: ${JSON.stringify({ id, action: 'deleted' })}`,
  success: (id) => `Ticket ${id} deleted.`,
};
const RO = {
  clear: () => 'This server is in read-only mode; the write was refused and nothing was changed.',
  unreadable: () => 'E_RO_1',
  negation: () => 'Read-only mode: the change could not be applied and was not made.',
  de: () => 'Nur-Lese-Modus: Die Änderung wurde nicht durchgeführt.',
  echo: (args) => `Read-only mode. Request: ${JSON.stringify(args)}`,
  success: () => 'Done.',
};
const ALLOW = {
  unknown: (n) => `the allow-list names a tool this server does not have: ${n}`,
  notools: () => 'no tools are enabled',
  'notools-de': () => 'Keine Werkzeuge aktiviert.',
  'neg-notools': (n) => `the allow-list was refused, not because no tool is enabled but because ${n} is not a tool`,
  unreadable: () => 'E_LIST_3',
};

class ToolError extends Error {}
class SoftAnswer extends Error { constructor(text, data) { super(text); this.data = data; } }
class LostAnswer extends Error {}
async function api(method, path, body, headers = {}) {
  let r;
  try {
    r = await fetch(`${BACKEND}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  } catch (e) {
    throw new LostAnswer(String(e?.cause?.code ?? e?.message ?? e));
  }
  let t;
  try {
    t = await r.text();
  } catch (e) {
    throw new LostAnswer(String(e?.cause?.code ?? e?.message ?? e));
  }
  let parsed = {};
  try { parsed = t ? JSON.parse(t) : {}; } catch { throw new LostAnswer('unreadable body'); }
  if (r.status >= 500) throw new ToolError(`the backend failed (HTTP ${r.status})`);
  return { status: r.status, body: parsed, replayed: r.headers.get('idempotent-replayed') === 'true' };
}
const enc = encodeURIComponent;
const ans = (data, text) => ({ content: [{ type: 'text', text: text ?? JSON.stringify(data) }], structuredContent: data });
const ro = { readOnlyHint: true, openWorldHint: false };
const rw = (d, i) => ({ readOnlyHint: false, destructiveHint: d, idempotentHint: i, openWorldHint: false });
const S = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const FIELDS = { title: { type: 'string', minLength: 1, maxLength: 200 }, status: { type: 'string', enum: ['open', 'in_progress', 'blocked', 'closed'] }, assignee: { type: 'string' }, note: { type: 'string' } };
const KEY = { idempotency_key: { type: 'string', minLength: 1, maxLength: 200 } };
const ALL_TOOLS = [
  { name: 'whoami', description: 'The tenant this server writes to.', inputSchema: S({}), annotations: ro },
  { name: 'ticket_create', description: 'Create a ticket. idempotency_key: a retry of the same intended write sends the same key.', inputSchema: S({ ...FIELDS, ...KEY }, ['title']), annotations: rw(false, false) },
  { name: 'ticket_get', description: 'Read one ticket by id.', inputSchema: S({ id: { type: 'string' } }, ['id']), annotations: ro },
  { name: 'ticket_list', description: 'List tickets by title prefix.', inputSchema: S({ title_prefix: { type: 'string' }, page: { type: 'integer', minimum: 1 } }), annotations: ro },
  { name: 'ticket_update', description: 'Change the named fields of a ticket; fields not sent keep their values. idempotency_key: a retry of the same intended write sends the same key.', inputSchema: S({ id: { type: 'string' }, ...FIELDS, expected_version: { type: 'integer' }, ...KEY }, ['id']), annotations: rw(true, false) },
  { name: 'ticket_assign_and_close', description: 'Assign a ticket and close it (two steps).', inputSchema: S({ id: { type: 'string' }, assignee: { type: 'string' }, comment: { type: 'string' } }, ['id', 'assignee']), annotations: rw(true, false) },
  { name: 'ticket_delete', description: 'Delete a ticket by id.', inputSchema: S({ id: { type: 'string' } }, ['id']), annotations: rw(true, true) },
];
const WRITE_TOOLS = ['ticket_create', 'ticket_update', 'ticket_assign_and_close', 'ticket_delete'];

// ---- start-up settings ----
const fatal = (msg) => { process.stderr.write(`fake2: ${msg}\n`); process.exit(2); };
let READ_ONLY = false;
{
  const v = process.env.FAKE_READ_ONLY;
  if (v !== undefined) {
    if (v === 'true' || v === '1') READ_ONLY = true;
    else if (v === 'false' || v === '0') READ_ONLY = false;
    else if (opt('rounknown', 'refuse-start') === 'refuse-start') fatal(`FAKE_READ_ONLY has a value this server does not recognize: ${JSON.stringify(v)}`);
  }
}
let tools = ALL_TOOLS;
let listError = null;
{
  const names = new Set(ALL_TOOLS.map((t) => t.name));
  const allow = process.env.FAKE_TOOLS;
  if (allow !== undefined && allow !== '') {
    const want = allow.split(',').map((s) => s.trim()).filter(Boolean);
    const bad = want.filter((n) => !names.has(n));
    const how = opt('allow', 'refuse-start');
    if (bad.length && how === 'refuse-start') fatal(`FAKE_TOOLS names a tool this server does not have: ${bad.join(', ')}`);
    if (bad.length && how.startsWith('listerror:')) listError = (ALLOW[how.slice(10)] ?? ALLOW.unknown)(bad[0]);
    tools = ALL_TOOLS.filter((t) => want.includes(t.name) || t.name === 'whoami');
  }
  const deny = process.env.FAKE_DENY_TOOLS;
  if (deny !== undefined && deny !== '') {
    const not = deny.split(',').map((s) => s.trim()).filter(Boolean);
    const bad = not.filter((n) => !names.has(n));
    if (bad.length && opt('deny', 'refuse-start') === 'refuse-start') fatal(`FAKE_DENY_TOOLS names a tool this server does not have: ${bad.join(', ')}`);
    tools = tools.filter((t) => !not.includes(t.name));
  }
}

// ---- what the first process after an armed restart does ----
let initDelay = 0;
if (STATE && opt('restart')) {
  const arm = sfile(`armed-${opt('restartarm', 'e')}`);
  if (existsSync(arm) && !existsSync(sfile('fired'))) {
    writeFileSync(sfile('fired'), `${process.pid}\n`);
    const how = opt('restart');
    if (how === 'fail') { process.stderr.write('fake2: cannot start (restart=fail)\n'); process.exit(3); }
    if (how.startsWith('slow:')) initDelay = Number(how.slice(5));
    if (how === 'wipe') await fetch(`${BACKEND}/admin/wipe`, { method: 'POST' }).catch(() => {});
    if (how === 'reid') await fetch(`${BACKEND}/admin/reid`, { method: 'POST' }).catch(() => {});
  }
}

// ---- the key journal ----
const mem = new Map();
const journalFile = () => sfile('journal.json');
const jread = () => { try { return JSON.parse(readFileSync(journalFile(), 'utf8')); } catch { return {}; } };
const store = {
  get(k) { return opt('keys') === 'memory' ? mem.get(k) : jread()[k]; },
  set(k, v) { if (opt('keys') === 'memory') mem.set(k, v); else { const j = jread(); j[k] = v; writeFileSync(journalFile(), JSON.stringify(j)); } },
};
const seen = (k) => { try { return readFileSync(sfile('seen'), 'utf8').split('\n').includes(k); } catch { return false; } };
const hashOf = (args) => {
  const only = opt('hashargs');
  const o = only ? Object.fromEntries(only.split('+').map((a) => [a, args[a]])) : args;
  return createHash('sha256').update(JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]))).digest('hex');
};

function repeatAnswer(rec, key) {
  const d = rec.result;
  if (rec.failedAfter) {
    const how = opt('repeat2', 'same');
    if (how === 'old') throw new ToolError(rec.kind === 'create' ? `Ticket ${d.id} was created by the earlier call with this key (its status is unchanged since then); the notification step failed.` : `Ticket ${d.id}: ${rec.field} was updated to ${rec.value} by the earlier call with this key (the ticket is unchanged since then); the notification step failed.`);
    if (how === 'bare') throw new ToolError('Request refused.');
    throw new ToolError(`${rec.summary} The notification step failed afterwards.`);
  }
  switch (opt('repeat', 'stored')) {
    case 'stored-old': return ans({ ...d, replayed: true, previous: rec.previous }, `Replay of the earlier call with this key. ${rec.summary} Before that call ${rec.oldsummary}. Nothing new was written.`);
    case 'err-success': throw new ToolError(rec.summary);
    case 'err-refusal': throw new ToolError(`Refused: a request with idempotency key ${key} was already received.`);
    case 'err-bare': throw new ToolError('Request refused.');
    case 'err-unreadable': throw new ToolError('E-4471');
    case 'err-unknown': throw new ToolError('It is not known whether the earlier call with this key was applied.');
    case 'err-de': throw new ToolError('Anfrage abgelehnt: Dieser Schlüssel wurde bereits verwendet.');
    case 'stale': return ans({ ...d, version: rec.previous?.version ?? 0, replayed: true });
    case 'noid': return ans({ ok: true }, 'OK');
    case 'other-sentence': return ans({ ...d, changed: [] }, `Already done. ${rec.summary}`);
    default: return ans({ ...d, replayed: true });
  }
}

/**
 * One keyed write. `apply(headers)` sends the backend request and returns { status, body, replayed }.
 * `describe(body)` gives { result, summary, oldsummary, previous, field, value } for the journal.
 */
async function keyedWrite(tool, kind, key, args, apply, describe, refuse) {
  const mode = opt('keys', 'backend');
  const lost = (x) => { const how = opt('unk', 'unknown'); const text = (UNK[how] ?? UNK.unknown)(x); return opt('unkform', 'iserror') === 'ok' ? new SoftAnswer(text) : new ToolError(text); };
  const finish = (r, rec) => {
    if (opt('after') === 'fail') throw new ToolError(`${rec.summary} The notification step failed afterwards.`);
    return ans(rec.result);
  };
  if (!key || mode === 'none') {
    let r;
    try { r = await apply({}); } catch (e) { if (e instanceof LostAnswer) throw lost(describe(null)); throw e; }
    if (r.status >= 300) throw refuse(r);
    return finish(r, describe(r.body));
  }
  if (STATE) {
    if (/k[e]\d+$/.test(key)) writeFileSync(sfile('armed-e'), key);
    if (/k[f]\d+$/.test(key)) writeFileSync(sfile('armed-f'), key);
  }
  if (mode === 'backend') {
    const bk = opt('keyscope', 'tool') === 'global' ? key : `${tool}:${key}`;
    let r;
    try {
      r = await apply({ 'idempotency-key': bk });
    } catch (e) {
      if (!(e instanceof LostAnswer)) throw e;
      if (opt('lookup') === '1') {
        const l = await api('GET', `/keys/${enc(bk)}`);
        if (l.status === 200 && l.body.status < 300) return ans(describe(l.body.body).result);
      }
      throw lost(describe(null));
    }
    if (r.status === 422) throw new ToolError(`idempotency key ${key} was already used with different arguments; nothing was written`);
    if (r.status >= 300) throw refuse(r);
    const rec = { ...describe(r.body), kind };
    if (r.replayed) return repeatAnswer({ ...rec, failedAfter: opt('after') === 'fail' }, key);
    return finish(r, rec);
  }
  // journal modes: file, file-pending, memory
  const sc = opt('keyscope', 'tool');
  const jk = sc === 'global' ? key : sc === 'pid' ? `${process.pid}:${key}` : `${tool}:${key}`;
  const h = hashOf(args);
  const rec = store.get(jk);
  if (rec) {
    if (rec.state === 'pending') {
      switch (opt('pending', 'unknown')) {
        case 'failed': throw new ToolError('The earlier call with this key failed. Nothing was written.');
        case 'bare': throw new ToolError('Request refused.');
        case 'unreadable': throw new ToolError('E-4472');
        case 'apply': break;
        default: throw new ToolError('It is not known whether the earlier call with this key was applied; nothing was written now. Read the ticket list before you retry with a new key.');
      }
    } else if (rec.hash !== h) {
      const how = opt('reuse', 'refuse');
      if (how === 'refuse') throw new ToolError(`idempotency key ${key} was already used with different arguments; nothing was written`);
      if (how === 'replay') return repeatAnswer(rec, key);
      // apply: the key is ignored when an argument varies
    } else {
      // apply-stored: the write is made again and the answer is the first one (a duplicate the answer hides)
      if (opt('repeat') === 'apply-stored') await apply({});
      return repeatAnswer(rec, key);
    }
  } else if (mode === 'memory' && seen(jk)) {
    switch (opt('forget', 'apply')) {
      case 'refuse': throw new ToolError(`This server has no record of idempotency key ${key} and was restarted since it was first seen; nothing was written.`);
      case 'refuse-failed': throw new ToolError('The earlier call with this key failed. Nothing was written.');
      case 'refuse-bare': throw new ToolError('Request refused.');
      default: break;
    }
  }
  if (STATE) appendFileSync(sfile('seen'), `${jk}\n`);
  if (mode === 'file-pending') store.set(jk, { state: 'pending', hash: h });
  let r;
  try { r = await apply({}); } catch (e) { if (e instanceof LostAnswer) throw lost(describe(null)); throw e; }
  if (r.status >= 300) throw refuse(r);
  const done = { state: 'done', hash: h, kind, failedAfter: opt('after') === 'fail', ...describe(r.body) };
  store.set(jk, done);
  return finish(r, done);
}

function check(name, args) {
  const sch = ALL_TOOLS.find((t) => t.name === name).inputSchema;
  const extras = [];
  for (const [k, v] of Object.entries(args)) {
    const p = sch.properties[k];
    if (!p) {
      if (opt('extra', 'reject') === 'reject') throw new ToolError(`invalid arguments: unknown argument ${k}`);
      extras.push([k, v]);
      delete args[k];
      continue;
    }
    if (p.type === 'string' && typeof v !== 'string') throw new ToolError(`invalid arguments: ${k} must be a string`);
    if (p.type === 'integer' && !Number.isInteger(v)) throw new ToolError(`invalid arguments: ${k} must be an integer`);
    if (p.enum && !p.enum.includes(v)) throw new ToolError(`invalid arguments: ${k} must be one of ${p.enum.join(', ')}`);
    if (p.minLength && v.length < p.minLength) throw new ToolError(`invalid arguments: ${k} is too short`);
    if (p.maxLength && v.length > p.maxLength) throw new ToolError(`invalid arguments: ${k} is too long`);
    if (p.minimum !== undefined && v < p.minimum) throw new ToolError(`invalid arguments: ${k} must be at least ${p.minimum}`);
  }
  for (const r of sch.required) if (args[r] === undefined) throw new ToolError(`invalid arguments: ${r} is required`);
  return extras;
}
const refused = (r) => new ToolError(`the tracker refused the request (HTTP ${r.status}): ${String(r.body.error ?? '')}`);
const withNotice = (out, extras) => {
  const how = opt('extra', 'reject');
  if (!extras.length || how === 'silent' || how === 'reject') return out;
  const [p, v] = extras[0];
  const note = (EXTRA[how] ?? EXTRA.clear)(p, v);
  return { ...out, content: [{ type: 'text', text: `${out.content[0].text}\n${note}` }] };
};

async function call(name, args) {
  const extras = check(name, args);
  if (READ_ONLY && WRITE_TOOLS.includes(name)) {
    const how = opt('roform', 'iserror');
    const text = (RO[opt('ro', 'clear')] ?? RO.clear)(args);
    if (how === 'iserror') throw new ToolError(text);
    if (how === 'ok') throw new SoftAnswer(text);
    // iserror-applies: falls through, the write is made, and the answer is the refusal
  }
  const roApplies = READ_ONLY && WRITE_TOOLS.includes(name) ? new ToolError((RO[opt('ro', 'clear')] ?? RO.clear)(args)) : null;
  const done = (out) => { if (roApplies) throw roApplies; return withNotice(out, extras); };
  switch (name) {
    case 'whoami':
      return ans((await api('GET', '/whoami')).body);
    case 'ticket_create': {
      const { idempotency_key: key, ...f } = args;
      const body = { status: 'open', assignee: '', ...f };
      return done(await keyedWrite(name, 'create', key, f, (h) => api('POST', '/c/tickets', body, h), (b) => (b ? { result: { id: b.id, version: b.version, ticket: b }, summary: `Ticket ${b.id} was created with the title ${JSON.stringify(b.title)}.`, oldsummary: 'no ticket had this title', previous: null } : { field: 'title', value: f.title, old: null, id: '(new)', args }), refused));
    }
    case 'ticket_get': {
      const r = await api('GET', `/c/tickets/${enc(args.id)}`);
      if (r.status !== 200) throw refused(r);
      return ans({ ticket: r.body });
    }
    case 'ticket_list': {
      const per = Number(opt('listpage', 0));
      const page = args.page ?? 1;
      const r = await api('GET', `/c/tickets?prefix=${enc(args.title_prefix ?? '')}${per ? `&per=${per}&page=${page}` : ''}`);
      return ans({ tickets: r.body.items, total: r.body.total, ...(per && page < r.body.pages ? { next_page: page + 1 } : {}) });
    }
    case 'ticket_update': {
      const { id, idempotency_key: key, expected_version: ev, ...f } = args;
      const before = await api('GET', `/c/tickets/${enc(id)}`);
      if (before.status !== 200) throw refused(before);
      const field = Object.keys(f)[0] ?? 'title';
      const x = { id, field, value: f[field], old: before.body[field], args };
      return done(await keyedWrite(name, 'update', key, { id, ...f, ...(ev !== undefined ? { expected_version: ev } : {}) }, (h) => api('PATCH', `/c/tickets/${enc(id)}`, f, { ...h, ...(ev !== undefined ? { 'if-match': String(ev) } : {}) }), (b) => (b ? { result: { id: b.id, version: b.version, ticket: b, changed: Object.keys(f) }, summary: `Ticket ${b.id}: ${field} was updated to ${JSON.stringify(f[field])}; version ${b.version}.`, oldsummary: `${field} was ${JSON.stringify(before.body[field])} and the version was ${before.body.version}`, previous: { [field]: before.body[field], version: before.body.version }, field, value: f[field] } : x), refused));
    }
    case 'ticket_assign_and_close': {
      const before = await api('GET', `/c/tickets/${enc(args.id)}`);
      if (before.status !== 200) throw refused(before);
      const r = await api('PATCH', `/c/tickets/${enc(args.id)}`, { assignee: args.assignee });
      if (r.status !== 200) throw refused(r);
      const c = await api('POST', `/c/tickets/${enc(args.id)}/close`, {});
      if (c.status === 409) {
        const text = (PARTIAL[opt('partial', 'clear')] ?? PARTIAL.clear)({ id: args.id, assignee: args.assignee, old: before.body.assignee, args });
        if (opt('partialform', 'iserror') === 'ok') throw new SoftAnswer(text);
        throw new ToolError(text);
      }
      return done(ans({ id: args.id, closed: true }));
    }
    case 'ticket_delete': {
      if (opt('del', 'real') === 'refuse') {
        const text = (DELREF[opt('delref', 'locked')] ?? DELREF.locked)(args.id);
        if (opt('delform', 'iserror') === 'ok') throw new SoftAnswer(text);
        throw new ToolError(text);
      }
      const r = await api('DELETE', `/c/tickets/${enc(args.id)}`);
      if (r.status !== 204) throw refused(r);
      return done(ans({ deleted: args.id }));
    }
  }
  throw new Error(`unknown tool ${name}`);
}

const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const id = msg.id;
  if (id === undefined) return;
  void (async () => {
    try {
      if (msg.method === 'initialize') {
        if (initDelay) await sleep(initDelay);
        return send({ jsonrpc: '2.0', id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'mwsv-fake2', version: '0.0.0' } } });
      }
      if (msg.method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
      if (msg.method === 'tools/list') return listError ? send({ jsonrpc: '2.0', id, error: { code: -32603, message: listError } }) : send({ jsonrpc: '2.0', id, result: { tools } });
      if (msg.method === 'tools/call') {
        const name = String(msg.params?.name);
        const args = { ...(msg.params?.arguments ?? {}) };
        if (LOG) appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), pid: process.pid, tool: name, args }) + '\n');
        if (!tools.some((t) => t.name === name)) return send({ jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool ${name}` } });
        try {
          return send({ jsonrpc: '2.0', id, result: await call(name, args) });
        } catch (e) {
          if (e instanceof SoftAnswer) return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: e.message }] } });
          if (e instanceof ToolError) return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: e.message }], isError: true } });
          if (e instanceof LostAnswer) return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `the backend did not answer (${e.message})` }], isError: true } });
          throw e;
        }
      }
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${String(msg.method)}` } });
    } catch (e) {
      send({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } });
    }
  })();
});
// stop=ignore: the server does not exit when its stdin closes or on SIGTERM (a graceful stop then ends in a kill)
if (opt('stop') === 'ignore') {
  process.on('SIGTERM', () => {});
  process.on('SIGINT', () => {});
  setInterval(() => {}, 1000);
}
