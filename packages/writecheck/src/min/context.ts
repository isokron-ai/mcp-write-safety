/**
 * Min mode: the run context the checks share. It owns the mock and the server process, makes the base call of each
 * tool (arguments generated from the tool's input schema, with identifiers of objects the mock holds), runs every call
 * as a named step so that the mock attributes each backend request to it, and collects the trials the checks record.
 */

import { split } from '../cli/init.js';
import { isObj, type Obj } from '../core/util.js';
import type { MinDeclaration } from './declaration.js';
import { batchOps, type Mock, type MockRecord } from './mock.js';
import { succeeded, StdioServer, type ServerSpec, type ToolResult } from './mcp.js';
import { matchOperation, type Collection } from './openapi.js';
import { mainType, matches, stringFor, typesOf } from './values.js';

export interface Tool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: Obj;
}

export type Verdict = 'violated' | 'held' | 'not observed' | 'not tested' | 'not applicable' | 'self-attested';

export interface Trial {
  requirement: string;
  tool: string;
  case: string;
  verdict: Verdict;
  reason: string;
  reason_code?: string;
  method: 'catalog' | 'black-box' | 'proxy-assisted' | 'launch' | 'review';
  steps: string[];
  answer?: boolean;
  numbers?: Obj;
}

export interface Step {
  id: string;
  tool: string;
  args: Obj;
  first: ToolResult;
  final: ToolResult;
  /** Backend requests the server sent during the call (before an input_required answer, for `first`). */
  recs: MockRecord[];
  firstRecs: MockRecord[];
  /** The server process went away during the call: our reply or our harness, never judged against the server. */
  crashed: boolean;
}

export interface Base {
  tool: string;
  args: Obj;
  step: Step;
  /** Collections and ids the base call's arguments named. */
  named: { arg: string; collection: string; id: string }[];
  mutated: boolean;
}

export const KEY_ARG = /(idempot|request_id|client_token|dedup|nonce)/i;
export const VERSION_ARG = /^(version|etag|expected_version|if_match|sha|revision|rev|base_version)$/i;
const SWITCH_ARG = /^(force|all|dry_?run|confirm|overwrite|upsert|cascade|recursive)$/i;

/** Mutating requests the mock applied (a 2xx answer, or applied before a lost answer); a replay applied nothing. */
export const mutating2xx = (recs: MockRecord[]): MockRecord[] => recs.filter((r) => r.mutating && r.applied);

/** Every text a result shows, for "is X mentioned": the text blocks and the structured content. */
export const said = (r: ToolResult): string => `${r.text}\n${r.structured === undefined ? '' : JSON.stringify(r.structured)}\n${r.rpcError ? r.rpcError.message : ''}`;
/** The text blocks a person reads, without a block that is serialized JSON. */
export const prose = (r: ToolResult): string =>
  r.text
    .split('\n')
    .filter((l) => !/^\s*[{[]/.test(l))
    .join('\n');

export class Ctx {
  readonly trials: Trial[] = [];
  readonly steps: Step[] = [];
  readonly notes: string[] = [];
  server: StdioServer;
  tools: Tool[] = [];
  readonly bases = new Map<string, Base>();
  readonly noBase = new Map<string, string>();
  private n = 0;
  private used = new Set<string>();

  constructor(
    readonly mock: Mock,
    readonly decl: MinDeclaration,
    readonly spec: ServerSpec,
    readonly canaries: string[],
    readonly timeoutMs = 15_000,
  ) {
    this.server = new StdioServer(spec, timeoutMs);
  }

  add(t: Trial): void {
    this.trials.push(t);
  }

  tool(name: string): Tool | undefined {
    return this.tools.find((t) => t.name === name);
  }

  ann(name: string): Obj {
    const t = this.tool(name);
    return t && isObj(t.annotations) ? t.annotations : {};
  }

  props(name: string): { props: Record<string, Obj>; required: string[] } {
    const s = this.tool(name)?.inputSchema;
    const props = isObj(s) && isObj(s['properties']) ? (s['properties'] as Record<string, Obj>) : {};
    const required = isObj(s) && Array.isArray(s['required']) ? (s['required'] as string[]) : [];
    return { props, required };
  }

  /** The adopted result shape on a result (spec 7.3 rule 11), or null where none is adopted or the result has none. */
  shape(r: ToolResult): Obj | null {
    if (!this.decl.shape || !/^write-result\//.test(this.decl.shape)) return null;
    const sc = r.structured;
    const m = isObj(sc) && isObj(sc['mws']) ? sc['mws'] : null;
    return m && m['shape'] === this.decl.shape ? m : null;
  }

  pattern(name: string): RegExp | null {
    return this.decl.patterns[name] ?? null;
  }

  /** Starts the server and reads its tools; null when it is up, else why not. */
  async open(): Promise<string | null> {
    const why = await this.server.open();
    if (why) return why;
    const tools = await this.server.listTools();
    if (!tools) return `tools/list gave no tool list${this.server.hasExited ? ' (the server exited)' : ''}`;
    this.tools = tools.filter((t) => typeof t['name'] === 'string') as unknown as Tool[];
    return null;
  }

  async restart(env?: Record<string, string>): Promise<string | null> {
    await this.server.stop();
    this.server = new StdioServer(env ? { ...this.spec, env } : this.spec, this.timeoutMs);
    const why = await this.server.open();
    if (why) return why;
    return (await this.server.listTools()) ? null : 'no tool list after the restart';
  }

  /** One call as a named step. An input_required answer is retried with accepting answers unless `accept` is false. */
  async call(tool: string, args: Obj, label: string, o: { accept?: boolean } = {}): Promise<Step> {
    const id = `s${++this.n}-${label}`;
    this.mock.step = id;
    const first = await this.server.call(tool, args);
    const firstRecs = this.mock.recordsOf(id);
    let final = first;
    if (first.inputRequired && o.accept !== false) {
      this.mock.step = `${id}/retry`;
      final = (await this.retry(tool, args, first)).final;
    }
    await new Promise((r) => setTimeout(r, 30));
    this.mock.step = null;
    const recs = this.mock.records.filter((r) => r.step === id || r.step === `${id}/retry`);
    const crashed = this.server.hasExited;
    const s: Step = { id, tool, args, first, final, recs, firstRecs, crashed };
    this.steps.push(s);
    if (crashed) {
      this.notes.push(`${id}: the server exited during the call (${JSON.stringify(this.server.exitInfo)}); it was started again and the call was not judged. Last stderr: ${this.server.stderrTail(3).slice(0, 300)}`);
      await this.restart();
    }
    return s;
  }

  private async retry(tool: string, args: Obj, first: ToolResult): Promise<{ final: ToolResult }> {
    const answers: Obj = {};
    const reqs = first.inputRequired && isObj(first.inputRequired.inputRequests) ? first.inputRequired.inputRequests : {};
    for (const [k, v] of Object.entries(reqs)) {
      const params = isObj(v) && isObj(v['params']) ? v['params'] : isObj(v) ? v : {};
      const schema = isObj(params['requestedSchema']) ? params['requestedSchema'] : {};
      const content: Obj = {};
      for (const [pk, ps] of Object.entries(isObj(schema['properties']) ? schema['properties'] : {})) {
        const t = isObj(ps) ? ps['type'] : undefined;
        content[pk] = t === 'boolean' ? true : isObj(ps) && Array.isArray(ps['enum']) ? (ps['enum'] as unknown[])[0] : t === 'number' || t === 'integer' ? 1 : 'yes';
      }
      answers[k] = { action: 'accept', content };
    }
    const final = await this.server.call(tool, args, { inputResponses: answers, ...(first.inputRequired?.requestState ? { requestState: first.inputRequired.requestState } : {}) });
    return { final };
  }

  /** Which mock collection an argument names, by its pattern or its name. */
  collectionFor(tool: string, arg: string, s: Obj): Collection | null {
    const pattern = typeof s['pattern'] === 'string' ? s['pattern'] : isObj(s['items']) && typeof (s['items'] as Obj)['pattern'] === 'string' ? ((s['items'] as Obj)['pattern'] as string) : null;
    const tops = this.mock.model.collections.filter((c) => !c.parent && c.schema);
    const base = arg.replace(/_?(ids?|keys?)$/i, '').toLowerCase();
    const noun = split(tool)?.noun ?? '';
    const byName = tops.find((c) => base && (c.singular.toLowerCase() === base || c.segment.toLowerCase() === base)) ?? (/^(id|key|ids|keys)$/i.test(arg) ? tops.find((c) => c.singular.toLowerCase() === noun) : undefined);
    if (pattern) {
      const fits = tops.filter((c) => this.mock.objects(c.path).some((o) => matches(pattern, String(o[c.idField]))));
      if (byName && fits.includes(byName)) return byName;
      if (fits.length === 1) return fits[0]!;
      if (fits.length > 1) return fits.find((c) => c.singular.toLowerCase() === noun) ?? null;
      return null;
    }
    return byName ?? null;
  }

  /** A fresh object of a collection: one no earlier call has used, added to the mock when none is left. */
  fresh(c: Collection, where: Obj = {}): Obj {
    const pick = this.mock.objects(c.path).find((o) => !this.used.has(`${c.path} ${String(o[c.idField])}`) && Object.entries(where).every(([k, v]) => o[k] === v));
    const o = pick ?? this.mock.addObject(c, where);
    this.used.add(`${c.path} ${String(o[c.idField])}`);
    return o;
  }

  /**
   * Base arguments for a tool, from its input schema. `variant` 0: the required arguments; 1: also the first optional
   * plain argument; 2: also every optional plain argument. Identifier arguments name fresh objects of the mock; a version
   * argument is the version the mock holds for the object named; switches (force, all, dry_run ...) and idempotency keys
   * are left out. Returns null when a required argument cannot be made.
   */
  baseArgs(tool: string, variant: number): { args: Obj; named: Base['named'] } | null {
    const { props, required } = this.props(tool);
    const verb = split(tool)?.verb ?? '';
    const creates = /^(create|add|new|insert|post)$/.test(verb);
    const plain = (k: string) => !KEY_ARG.test(k) && !VERSION_ARG.test(k) && !(SWITCH_ARG.test(k) && mainType(props[k]) === 'boolean');
    const optional = Object.keys(props).filter((k) => !required.includes(k) && plain(k) && ['string', 'integer', 'number'].includes(mainType(props[k]) ?? ''));
    const chosen = [...required, ...(variant >= 1 ? optional.slice(0, variant === 1 ? 1 : optional.length) : [])];
    const args: Obj = {};
    const named: Base['named'] = [];
    // Scope-like and identifier arguments first, so that lists of identifiers can follow them (tickets in the project named).
    const order = [...chosen].sort((a, b) => Number(mainType(props[a]) === 'array') - Number(mainType(props[b]) === 'array'));
    for (const k of order) {
      const s = props[k] ?? {};
      if (VERSION_ARG.test(k)) continue;
      const v = this.valueFor(tool, k, s, args, named, creates);
      if (v === undefined) {
        if (required.includes(k)) return null;
        continue;
      }
      args[k] = v;
    }
    // Version arguments: the version the mock holds for the object named (always given where the tool takes one).
    for (const k of Object.keys(props).filter((x) => VERSION_ARG.test(x))) {
      const first = named[0];
      const o = first ? this.mock.get(first.collection, first.id) : undefined;
      if (o && o['version'] !== undefined) args[k] = mainType(props[k]) === 'string' ? String(o['version']) : o['version'];
      else if (required.includes(k)) return null;
    }
    return { args, named };
  }

  private valueFor(tool: string, k: string, s: Obj, args: Obj, named: Base['named'], creates: boolean): unknown {
    const t = mainType(s);
    const c = t === 'string' || t === 'integer' || (t === 'array' && isObj(s['items'])) ? this.collectionFor(tool, k, t === 'array' ? (s['items'] as Obj) : s) : null;
    const seed = this.n * 31 + k.length;
    if (c && t !== 'array') {
      // A create names a new identifier for its own collection (a key the caller chooses); anything else an existing object.
      if (creates && (k === c.idField || k === 'key' || k === 'id') && (split(tool)?.noun ?? '') === c.singular.toLowerCase()) {
        return stringFor(s, `mwsmin${this.n}k${seed}`, seed) ?? undefined;
      }
      const where: Obj = {};
      for (const [ak, av] of Object.entries(args)) if (c.schema && isObj(c.schema['properties']) && ak in (c.schema['properties'] as Obj)) where[ak] = av;
      const o = this.fresh(c, where);
      named.push({ arg: k, collection: c.path, id: String(o[c.idField]) });
      return t === 'integer' ? Number(o[c.idField]) : String(o[c.idField]);
    }
    if (c && t === 'array') {
      const where: Obj = {};
      for (const [ak, av] of Object.entries(args)) if (c.schema && isObj(c.schema['properties']) && ak in (c.schema['properties'] as Obj)) where[ak] = av;
      const n = Math.max(typeof s['minItems'] === 'number' ? s['minItems'] : 0, 3);
      const ids: string[] = [];
      for (let i = 0; i < n; i++) {
        const o = this.fresh(c, where);
        ids.push(String(o[c.idField]));
        named.push({ arg: k, collection: c.path, id: String(o[c.idField]) });
      }
      return ids;
    }
    // A nested identifier (a label id): a child of the object already named.
    if (t === 'string' && typeof s['pattern'] === 'string') {
      for (const nm of named) {
        const parent = this.mock.get(nm.collection, nm.id);
        if (!parent) continue;
        for (const ch of this.mock.model.collections.filter((x) => x.parent?.path === nm.collection)) {
          const arr = parent[ch.parent!.field];
          const hit = Array.isArray(arr) ? (arr as Obj[]).find((x) => matches(s['pattern'], String(x[ch.idField]))) : undefined;
          if (hit) return String(hit[ch.idField]);
        }
      }
    }
    return this.plainValue(s, `mwsmin-${this.n}-${k}`, seed, named, k);
  }

  plainValue(s: Obj, stem: string, seed: number, named: Base['named'] = [], k = ''): unknown {
    const t = mainType(s);
    if ('const' in s) return s['const'];
    if (Array.isArray(s['enum'])) {
      const vals = (s['enum'] as unknown[]).filter((x) => x !== null);
      // Prefer a value the object named does not hold already, so that an update changes something.
      const cur = named[0] ? this.mock.get(named[0].collection, named[0].id)?.[k] : undefined;
      return vals.find((v) => v !== cur) ?? vals[0];
    }
    if (t === 'string') return stringFor(s, stem, seed) ?? undefined;
    if (t === 'integer' || t === 'number') {
      const min = typeof s['minimum'] === 'number' ? s['minimum'] : 1;
      const max = typeof s['maximum'] === 'number' ? s['maximum'] : min + 10;
      return Math.min(max, Math.max(min, 3));
    }
    if (t === 'boolean') return false;
    if (t === 'array') {
      const it = isObj(s['items']) ? (s['items'] as Obj) : { type: 'string' };
      const n = Math.max(typeof s['minItems'] === 'number' ? s['minItems'] : 1, 1);
      const out: unknown[] = [];
      for (let i = 0; i < n; i++) {
        const v = this.plainValue(it, `${stem.slice(0, 20)}${i}`, seed + i);
        if (v === undefined) return undefined;
        out.push(v);
      }
      return out;
    }
    if (t === 'object') {
      const props = isObj(s['properties']) ? (s['properties'] as Record<string, Obj>) : {};
      const req = Array.isArray(s['required']) ? (s['required'] as string[]) : Object.keys(props).slice(0, 1);
      const out: Obj = {};
      for (const pk of req) {
        const v = this.plainValue(props[pk] ?? {}, `${stem.slice(0, 20)}-${pk}`, seed + pk.length);
        if (v !== undefined) out[pk] = v;
      }
      return out;
    }
    if (typesOf(s).length === 0) return stem;
    return undefined;
  }

  /** Finds a working base call for every tool (read-only ones too). */
  async discover(): Promise<void> {
    for (const t of this.tools) {
      let last = 'no arguments could be made from the input schema';
      let fallback: Base | null = null;
      for (const variant of [0, 1, 2]) {
        const b = this.baseArgs(t.name, variant);
        if (!b) continue;
        const step = await this.call(t.name, b.args, `base-${t.name}`);
        if (step.crashed) {
          last = 'the server exited during the base call';
          continue;
        }
        const ok = succeeded(step.final);
        const mutated = mutating2xx(step.recs).length > 0;
        if (ok && (mutated || this.ann(t.name)['readOnlyHint'] === true)) {
          this.bases.set(t.name, { tool: t.name, args: b.args, step, named: b.named, mutated });
          fallback = null;
          break;
        }
        if (ok && !fallback) fallback = { tool: t.name, args: b.args, step, named: b.named, mutated };
        last = ok ? 'the call succeeded but sent no write the mock accepted' : `the call was not a success (${step.final.isError ? 'an error result' : step.final.rpcError ? `JSON-RPC error ${step.final.rpcError.code}` : step.final.timedOut ? 'timed out' : (step.final.transportError ?? step.final.resultType ?? 'no result')})`;
        if (step.recs.some((r) => r.kind === 'unmatched')) last += `; it sent ${step.recs.filter((r) => r.kind === 'unmatched').map((r) => `${r.method} ${r.path}`).join(', ')}, which the description does not have (mock_incomplete)`;
      }
      if (!this.bases.has(t.name)) {
        if (fallback) this.bases.set(t.name, fallback);
        else this.noBase.set(t.name, last);
      }
    }
  }

  /** Write tools: a base call that sent a write the mock applied. */
  writeTools(): Base[] {
    return [...this.bases.values()].filter((b) => b.mutated);
  }

  /** A fresh copy of a tool's base arguments (new objects, current versions). */
  again(tool: string): Obj | null {
    const b = this.bases.get(tool);
    if (!b) return null;
    // The same variant: the same argument names as the base call that worked.
    for (const variant of [0, 1, 2]) {
      const x = this.baseArgs(tool, variant);
      if (x && sameKeys(x.args, b.args)) return x.args;
    }
    return null;
  }

  /** The object identifiers a request acts on: its item path, or the ids of a batch. */
  targets(r: MockRecord): string[] {
    const ops = batchOps(r.body);
    if (ops) return ops.map((o) => String(o['id']));
    const m = matchOperation(this.mock.model, r.method, r.path);
    if (!m) return [];
    const c = this.mock.model.collections.find((x) => x.itemPath === m.op.template);
    if (!c || c.parent) {
      // A nested write acts on its parent (a label on a ticket).
      const vals = Object.values(m.params);
      return vals.length ? [vals[0]!] : [];
    }
    return Object.values(m.params).slice(-1);
  }
}

const sameKeys = (a: Obj, b: Obj): boolean => {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i]);
};
