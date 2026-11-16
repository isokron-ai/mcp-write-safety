/**
 * `init`: draft a manifest from tools/list. It makes no call beyond initialize and tools/list. It
 * pairs tools by shared id parameters and name stems (get_x / update_x / create_x / delete_x /
 * list_x, either order), proposes the update mode (field patch, full replace, command, composite)
 * from the update tool's schema, picks two scalar fields, and marks every guess `# guessed`. A
 * manifest with any marker left refuses to run until a person has read it and removed them.
 */

import { writeFileSync } from 'node:fs';

import { stringify } from 'yaml';

import type { Tool } from '../checks/types.js';
import { NO_CAPTURE } from '../core/capture.js';
import { egressFor, lockGlobalFetch } from '../core/egress.js';
import { GUESSED, type Manifest } from '../core/manifest.js';
import { Redactor } from '../core/redact.js';
import { Session } from '../core/session.js';
import { isObj, WritecheckError, type Obj } from '../core/util.js';

const ROLES: [string, RegExp][] = [
  ['read', /^(get|read|fetch|show|view|describe)$/],
  ['update', /^(update|patch|edit|modify|set|change)$/],
  ['replace', /^(replace|put|save|upsert|write)$/],
  ['create', /^(create|add|new|insert|post)$/],
  ['delete', /^(delete|remove|destroy|drop)$/],
  ['archive', /^(archive|close|disable)$/],
  ['list', /^(list|search|find|query)$/],
];

/** `get_ticket` / `ticket_get` / `getTicket` → { verb: get, noun: ticket }. */
export function split(name: string): { verb: string; noun: string } | null {
  const parts = name.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().split(/[_\-.]/).filter(Boolean);
  if (parts.length < 2) return null;
  const first = parts[0]!;
  const last = parts[parts.length - 1]!;
  const isVerb = (w: string) => ROLES.some(([, re]) => re.test(w));
  if (isVerb(first)) return { verb: first, noun: parts.slice(1).join('_').replace(/s$/, '') };
  if (isVerb(last)) return { verb: last, noun: parts.slice(0, -1).join('_').replace(/s$/, '') };
  return null;
}

const roleOf = (verb: string) => ROLES.find(([, re]) => re.test(verb))?.[0] ?? null;
const propsOf = (t: Tool): Record<string, Obj> => (isObj(t.inputSchema) && isObj(t.inputSchema['properties']) ? (t.inputSchema['properties'] as Record<string, Obj>) : {});
const ID_PROP = /^(id|uid|uuid|key|number|.*_(id|uid|number|key))$/i;
const VERSION_PROP = /^(version|etag|expected_version|if_match|sha|revision|rev|base_version)$/i;

interface Drafted {
  name: string;
  tools: Partial<Record<string, Tool>>;
}

export function groupTools(tools: Tool[]): Drafted[] {
  const by = new Map<string, Drafted>();
  for (const t of tools) {
    const s = split(t.name);
    if (!s) continue;
    const role = roleOf(s.verb);
    if (!role) continue;
    const g = by.get(s.noun) ?? { name: s.noun, tools: {} };
    g.tools[role] ??= t;
    by.set(s.noun, g);
  }
  return [...by.values()].filter((g) => g.tools['read'] && (g.tools['update'] || g.tools['replace']));
}

export function guessMode(t: Tool): NonNullable<Manifest['resources'][number]['update']>['mode'] {
  const p = propsOf(t);
  const names = Object.keys(p);
  if (names.some((n) => /^(operations|ops|patch|patches|actions|commands)$/i.test(n) && p[n]!['type'] === 'array')) return 'command';
  if (names.some((n) => p[n]!['type'] === 'object' && !/^(meta|options|_meta)$/i.test(n))) return 'full_replace';
  return 'field_patch';
}

/** Draft the manifest text (YAML with `# guessed` markers on every guess). */
export function draftManifest(tools: Tool[], server: { stdio?: string[]; url?: string }, passthrough: string[] = []): string {
  const groups = groupTools(tools);
  const resources: Obj[] = [];
  const guessed = new Set<string>();
  const mark = (path: string) => guessed.add(path);
  for (const [i, g] of groups.entries()) {
    const read = g.tools['read']!;
    const upd = (g.tools['update'] ?? g.tools['replace'])!;
    const mode = guessMode(upd);
    const idProp = Object.keys(propsOf(read)).find((k) => ID_PROP.test(k)) ?? 'id';
    const updProps = propsOf(upd);
    const scalars = Object.entries(updProps).filter(([k, s]) => s['type'] === 'string' && !ID_PROP.test(k) && !VERSION_PROP.test(k) && !Array.isArray(s['enum'])).map(([k]) => k);
    const fields = (scalars.length >= 2 ? scalars.slice(0, 2) : [...scalars, 'FIELD_A', 'FIELD_B'].slice(0, 2)).map((f) => ({ path: f, values: ['mwsc-a', 'mwsc-b'] }));
    const versionProp = Object.keys(updProps).find((k) => VERSION_PROP.test(k));
    const r: Obj = { name: g.name.replace(/[^a-z0-9_-]/g, '-').slice(0, 40) || `resource${i}` };
    const base = `resources[${i}]`;
    const create = g.tools['create'];
    if (create) {
      const cp = propsOf(create);
      const nameProp = Object.keys(cp).find((k) => /^(title|name|summary|label)$/i.test(k)) ?? 'name';
      r['create'] = { tool: create.name, args: { [nameProp]: '{{prefix}}' + g.name }, id: 'id' };
      mark(`${base}.create`);
    } else {
      r['fixture'] = { id: 'PRE-MADE-OBJECT-ID', name: 'mwsc-fixture' };
      mark(`${base}.fixture`);
    }
    // why: fields that change on every write (timestamps, versions) would read as unrelated changes; proposed, to be confirmed.
    r['read'] = { tool: read.name, args: { [idProp]: '{{id}}' }, object: '$', settle_ms: 0, ignore: ['updated_at', 'updatedAt', 'modified_at', 'etag', 'version'] };
    mark(`${base}.read`);
    const updArgs: Obj = { [Object.keys(updProps).find((k) => ID_PROP.test(k)) ?? idProp]: '{{id}}' };
    if (mode === 'full_replace') updArgs[Object.keys(updProps).find((k) => updProps[k]!['type'] === 'object') ?? 'object'] = '{{object}}';
    else updArgs['{{field}}'] = '{{value}}';
    if (versionProp) updArgs[versionProp] = '{{version}}';
    r['update'] = { tool: upd.name, mode, args: updArgs };
    mark(`${base}.update`);
    r['fields'] = fields;
    mark(`${base}.fields`);
    if (versionProp) {
      r['version'] = { read: 'version', arg: versionProp };
      mark(`${base}.version`);
    }
    if (g.tools['delete']) {
      r['delete'] = { tool: g.tools['delete'].name, args: { [Object.keys(propsOf(g.tools['delete'])).find((k) => ID_PROP.test(k)) ?? 'id']: '{{id}}' } };
      r['cleanup'] = 'delete';
    } else if (g.tools['archive']) {
      r['archive'] = { tool: g.tools['archive'].name, args: { id: '{{id}}' } };
      r['cleanup'] = 'archive';
    } else r['cleanup'] = 'leave';
    mark(`${base}.cleanup`);
    if (g.tools['list']) {
      r['list'] = { tool: g.tools['list'].name, args: {}, items: '$', id: 'id', name: 'name' };
      mark(`${base}.list`);
    }
    resources.push(r);
  }
  if (!resources.length) throw new WritecheckError('init: no pair of read and update tools found in tools/list; write the manifest by hand (see the README for the 15-line minimum)', 4);
  const guardTool = tools.find((t) => /(^|_)(whoami|me|current_user|get_me|tenant|workspace|org|organization|project)(_|$)/i.test(t.name) && t.annotations?.['readOnlyHint'] === true) ?? tools.find((t) => t.annotations?.['readOnlyHint'] === true);
  const doc: Obj = {
    mws: '0.9',
    server: { ...(server.stdio ? { stdio: server.stdio } : { url: server.url }), env_passthrough: passthrough, processes: 'separate' },
    target: { environment: 'test', confirm: 'NAME-OF-YOUR-TEST-TENANT', guard: { tool: guardTool?.name ?? 'READ_ONLY_TOOL', args: {}, path: 'name', pattern: '^REPLACE-WITH-YOUR-TEST-TENANT$' } },
    resources,
  };
  mark('target');
  let text = stringify(doc, { lineWidth: 0 });
  // Put a marker on the first line of every guessed block.
  const lines = text.split('\n');
  const marks = new Set<number>();
  let res = -1;
  for (const [n, l] of lines.entries()) {
    if (/^ {2}- name:/.test(l)) res++;
    const key = /^ {4}([a-z_]+):/.exec(l)?.[1];
    if (res >= 0 && key && guessed.has(`resources[${res}].${key}`)) marks.add(n);
    if (/^target:/.test(l)) marks.add(n);
  }
  text = lines.map((l, n) => (marks.has(n) ? `${l} ${GUESSED}` : l)).join('\n');
  return `# Drafted by mcp-writecheck init from tools/list. Every line that ends with the "guessed" marker is a guess:\n# read it, correct it, and remove the marker. A manifest with markers left refuses to run.\n${text}`;
}

export async function initCommand(o: { server: { stdio?: string[]; url?: string }; passthrough: string[]; out: string | null; env: NodeJS.ProcessEnv; log: (s: string) => void }): Promise<string> {
  const manifest = { server: { stdio: o.server.stdio ?? null, url: o.server.url ?? null, headers_env: {}, env_passthrough: o.passthrough, env_public: [], env: {}, cwd: null, processes: 'separate' }, limits: { timeout_ms: 30_000 } } as unknown as Manifest;
  const egress = egressFor([o.server.url]);
  const unlock = lockGlobalFetch(egress);
  const s = new Session({ manifest, capture: NO_CAPTURE, redactor: new Redactor([]), egress, env: o.env, write_budget: 0, min_interval_ms: 0, timeout_ms: 30_000 });
  let tools: Tool[];
  try {
    tools = (await s.listTools('INIT')) as Tool[];
  } finally {
    await s.close();
    unlock();
  }
  const text = draftManifest(tools, o.server, o.passthrough);
  if (o.out) {
    writeFileSync(o.out, text, { flag: 'wx' });
    o.log(`wrote ${o.out} (${tools.length} tools read; every guess is marked "${GUESSED}")`);
  } else o.log(text);
  return text;
}
