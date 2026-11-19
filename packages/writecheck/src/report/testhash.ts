/**
 * The per-record test_hash (`mws-test-hash/2`): a hash of exactly what defines one record's test, so that two runs of the same
 * test on two server builds can be compared record by record even when the builds offer different tool lists. Each record also
 * carries `test_inputs`, the parts the hash is made of, so that compare can apply owner rule A (a fix after which the same call
 * is accepted by both builds is the same test) where two hashes differ. test_hash is `sha256:` + sha256 of the RFC 8785
 * canonical JSON of { format, tester, rest, tools, probed?, subject?, extras? }:
 *
 *   format   "mws-test-hash/2"
 *   tester   { name, version, commit, dirty } of the build that judged the record (commit null when unstamped)
 *   rest     `sha256:` of the canonical JSON of: spec, requirement, level, scenario { id, version }, write_path, case (where
 *            the procedure makes several records on one write path), the record's resource block as loaded (paths relative to
 *            the manifest), the declaration (every top-level member except server, target, resources, limits, prefix; with
 *            `review` the answers in force, a `--review` file included; and `server` restricted to restart, processes, decode,
 *            extract and protocol), target.guard, and every limit except write_budget (writes_per_second only for MWS-CONC-*
 *            and MWS-RETRY-2)
 *   tools    for the write path's tool and every tool the resource block names: a ToolShape of the arguments the test sends
 *            (`p`: per argument a Shape, `r`: their required names, `ro`: the other required names, `h`: the keywords that
 *            constrain the arguments together), or null for a tool the catalog does not list
 *   probed   MWS-IN-1 to IN-7 only: a ToolShape of every argument of the write path's tool (the schema probes probe each)
 *   subject  the judged part of the entry other than the schema, hashed: the annotations for MWS-ANN-*, the description for
 *            MWS-IN-5, MWS-CONC-5, MWS-RETRY-2 and MWS-TGT-3
 *   extras   MWS-IN-5 only: the tester's reading (`in5_reading`) and the sha256 of each in5.docs document (`in5_docs`)
 *
 * A Shape is `h`, the hash of the argument's schema without `properties`, `required` and a single-schema `items` (with every
 * local `$ref` reachable from it resolved), `p`, a Shape per nested property, `r`, the nested required names, and `i`, the
 * Shape of the array items. Annotation keywords (description,
 * title, examples, $comment, deprecated) are left out of every schema, except for MWS-IN-5, whose search reads descriptions.
 * A top-level `$ref` (the argument object behind a definition), `$anchor` references and draft-07 `dependencies` are followed.
 *
 * test_hash_core, on a record whose requirement judges part of the entry, is the same without `subject` (and without `probed`
 * for MWS-IN-2/3/5/6/7). Not included, on purpose: the rest of the tool list, the catalog fingerprint, the manifest sha256 and
 * the plan hash, the server block other than the members above, the rest of the target block, target.provenance, and anything
 * the run measured. MANIFEST.md (test_hash) is the reference.
 */

import { readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';

import type { Manifest } from '../core/manifest.js';
import { canonical, isObj, sha256 } from '../core/util.js';
import { TEST_HASH_FORMAT } from '../core/identity.js';
import { SPEC_VERSION } from '../requirements.js';
import { SUITE_NAME, SUITE_VERSION } from '../version.js';
import type { Result } from './verdicts.js';

/** Manifest members that never enter a test hash as a whole (see the header; four members of `server` do, SERVER_HASHED). */
export const HASH_EXCLUDED_TOP = ['server', 'target', 'resources', 'limits', 'prefix', 'source'] as const;
export const HASH_EXCLUDED_LIMITS = ['write_budget', 'writes_per_second'] as const;
/** The members of `server` that change what a test does (M6): the stop kind of a restart, a second process, how answers are read, the protocol revision. */
export const SERVER_HASHED = ['restart', 'processes', 'decode', 'extract', 'protocol'] as const;

/** The part of the tool entry a requirement judges. */
export type Facet = 'schema' | 'annotations' | 'description';
export function subjectFacets(requirement: string): Facet[] {
  if (requirement === 'MWS-IN-5') return ['schema', 'description'];
  if (/^MWS-IN-[2367]$/.test(requirement)) return ['schema'];
  if (/^MWS-ANN-\d+$/.test(requirement)) return ['annotations'];
  if (['MWS-CONC-5', 'MWS-RETRY-2', 'MWS-TGT-3'].includes(requirement)) return ['description'];
  return [];
}

/** The schema-probe requirements (MWS-IN-1 to IN-7): their records are about every argument of the write path tool (`probed`). */
export const isSchemaProbe = (requirement: string): boolean => /^MWS-IN-[1-7]$/.test(requirement);

/** Command-line settings of a tester build that change a verdict, and inputs read from outside the manifest (set by the run before stamping; see the header). */
export interface HashExtras {
  in5_reading?: string;
  /** sha256 of each document MWS-IN-5 reads (in5.docs), by its path relative to the manifest. */
  in5_docs?: Record<string, string | null>;
}

/**
 * The extras of this build, where its modules define them: the MWS-IN-5 reading (checks/in5search.ts, IN5_READING) is read
 * when that module exists, so a build without the MWS-IN-5 search hashes nothing for it. With a manifest, the content of the
 * documents MWS-IN-5 reads (`in5.docs`).
 */
export async function hashExtras(m?: Manifest): Promise<HashExtras> {
  const out: HashExtras = {};
  if (m?.in5?.docs?.length) {
    const docs: Record<string, string | null> = {};
    for (const d of m.in5.docs) {
      const k = relativized(d, baseOf(m)) as string;
      try {
        docs[k] = sha256(readFileSync(d));
      } catch {
        docs[k] = null;
      }
    }
    out.in5_docs = docs;
  }
  const spec = '../checks/in5search.js';
  try {
    const mod = (await import(spec)) as { IN5_READING?: { value?: unknown } };
    if (typeof mod.IN5_READING?.value === 'string') out.in5_reading = mod.IN5_READING.value;
  } catch (e) {
    if ((e as { code?: string }).code !== 'ERR_MODULE_NOT_FOUND') {
      // why: re-review: a build that has the module but cannot load it must not hash IN-5 records as if it had no reading.
      process.stderr.write(`warning: the MWS-IN-5 reading could not be read (${(e as Error).message}); MWS-IN-5 test hashes do not include it\n`);
    }
  }
  return out;
}

/** The tester build that judged a record: name, version, git commit (null when unstamped) and whether its tree was dirty. */
export interface TesterId {
  name: string;
  version: string;
  commit: string | null;
  dirty?: boolean | null;
}

export interface TestHashContext {
  manifest: Manifest;
  tools: { name: string; [k: string]: unknown }[];
  tester?: TesterId;
  extras?: HashExtras;
  /** The review answers in force (a `--review` file replaces the manifest's block); default the manifest's. */
  review?: unknown;
}

/** JSON-only copy (drops undefined and functions the way JSON does), so canonical() never meets a non-JSON value. */
const plain = (v: unknown): unknown => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

/**
 * The loader makes some paths absolute against the manifest's folder (documents a check reads). The same manifest checked
 * out in two folders is the same test, so such a path enters the hash relative to that folder (`./docs/api.md`).
 */
export function relativized(v: unknown, base: string): unknown {
  const pre = base.endsWith(sep) ? base : base + sep;
  const walk = (x: unknown): unknown => {
    if (typeof x === 'string') return x.startsWith(pre) ? `./${relative(base, x).split(sep).join('/')}` : x;
    if (Array.isArray(x)) return x.map(walk);
    if (isObj(x)) return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y)]));
    return x;
  };
  return walk(v);
}

const baseOf = (m: Manifest): string => dirname(resolve(m.source.path));

/** Every string under a `tool` key anywhere in a block (update.tool, read.tool, multi[].tool, control … ). */
export function toolsNamedIn(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) for (const x of v) toolsNamedIn(x, out);
  else if (isObj(v)) {
    for (const [k, x] of Object.entries(v)) {
      if (k === 'tool' && typeof x === 'string') out.add(x);
      else toolsNamedIn(x, out);
    }
  }
  return out;
}

/** Argument names the test sends to tool `t`: keys of `args` templates in blocks for `t`, and every declared `arg` of the block. */
export function usedArgs(t: string, res: unknown, underTest: boolean): Set<string> {
  const out = new Set<string>();
  const argsKeys = (v: unknown, own: boolean): void => {
    if (Array.isArray(v)) v.forEach((x) => argsKeys(x, own));
    else if (isObj(v)) {
      const mine = typeof v['tool'] === 'string' ? v['tool'] === t : own;
      for (const [k, x] of Object.entries(v)) {
        if (mine && k === 'args' && isObj(x)) for (const a of Object.keys(x)) if (!a.includes('{{')) out.add(a);
        argsKeys(x, mine);
      }
    }
  };
  const declared = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(declared);
    else if (isObj(v)) for (const [k, x] of Object.entries(v)) (k === 'arg' && typeof x === 'string' ? out.add(x) : declared(x));
  };
  argsKeys(res, false);
  // why: fields, version, key, scope, restorable and idempotency name arguments of the tools under test by `arg`.
  if (underTest && isObj(res)) {
    declared(res);
    for (const r of Array.isArray(res['restorable']) ? res['restorable'] : []) if (typeof r === 'string') out.add(r);
  }
  return out;
}

/** Top-level schema keywords that constrain the arguments as a whole: they enter whole (re-review 3; `dependencies` is draft-07's spelling of dependentRequired and dependentSchemas). */
export const SCHEMA_WHOLE = ['allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else', 'dependentRequired', 'dependentSchemas', 'dependencies', 'additionalProperties', 'patternProperties', 'propertyNames', 'unevaluatedProperties', 'minProperties', 'maxProperties'] as const;

/**
 * Keywords that only annotate a schema: left out of every hashed schema, except for MWS-IN-5, whose search reads bounds stated
 * in descriptions (checks/in5gen.ts). A keyword is left out only where it stands as a keyword of a schema object, never where it
 * is the name of an argument (`properties.description`).
 */
export const ANNOTATION_KEYWORDS = ['description', 'title', 'examples', '$comment', 'deprecated'] as const;

/** Schema keywords whose value is a map of names to schemas. */
const SCHEMA_MAPS = ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'];
/** Schema keywords whose value is a schema or a list of schemas. */
const SCHEMA_SUBS = ['items', 'additionalItems', 'prefixItems', 'contains', 'additionalProperties', 'unevaluatedProperties', 'unevaluatedItems', 'propertyNames', 'not', 'if', 'then', 'else', 'allOf', 'anyOf', 'oneOf'];

/** An object without a prototype, so that a member named `constructor` or `__proto__` is only ever a member. */
const dict = <T = unknown>(): Record<string, T> => Object.create(null) as Record<string, T>;
const own = (o: unknown, k: string): boolean => isObj(o) && Object.prototype.hasOwnProperty.call(o, k);

/** A schema with the annotation keywords left out (schema-aware: argument names are kept), as plain JSON. */
export function stripAnnotations(schema: unknown, keep = false): unknown {
  if (keep) return plain(schema);
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!isObj(v)) return plain(v);
    const out = dict();
    for (const k of Object.keys(v)) {
      const x = v[k];
      if ((ANNOTATION_KEYWORDS as readonly string[]).includes(k)) continue;
      if (SCHEMA_MAPS.includes(k) && isObj(x)) {
        const m = dict();
        for (const n of Object.keys(x)) m[n] = walk(x[n]);
        out[k] = m;
      } else if (k === 'dependencies' && isObj(x)) {
        const m = dict();
        for (const n of Object.keys(x)) m[n] = Array.isArray(x[n]) ? plain(x[n]) : walk(x[n]);
        out[k] = m;
      } else if (SCHEMA_SUBS.includes(k)) out[k] = walk(x);
      else out[k] = plain(x);
    }
    return out;
  };
  return walk(schema);
}

/** Percent-decode a JSON Pointer token; a token that is not valid percent-encoding is taken as written. */
function decodeToken(raw: string): string {
  let k = raw;
  try {
    k = decodeURIComponent(raw);
  } catch {
    k = raw;
  }
  return k.replace(/~1/g, '/').replace(/~0/g, '~');
}

/**
 * Resolve a local reference in a schema: a JSON Pointer (`#/$defs/X`, `#/definitions/X`, `#`) or a plain-name fragment
 * (`#Name`, an `$anchor`, or a draft-07 `$id: "#Name"`). Undefined when it does not resolve.
 */
export function resolveRef(root: unknown, ref: string): unknown {
  if (!ref.startsWith('#')) return undefined;
  const frag = ref.slice(1);
  if (frag === '' || frag.startsWith('/')) {
    let v: unknown = root;
    for (const raw of frag.split('/').slice(1)) {
      const k = decodeToken(raw);
      if (Array.isArray(v)) v = /^\d+$/.test(k) ? v[Number(k)] : undefined;
      else if (isObj(v)) v = own(v, k) ? v[k] : undefined;
      else return undefined;
    }
    return v;
  }
  let hit: unknown;
  const find = (v: unknown): void => {
    if (hit !== undefined) return;
    if (Array.isArray(v)) v.forEach(find);
    else if (isObj(v)) {
      if (v['$anchor'] === frag || v['$id'] === `#${frag}`) {
        hit = v;
        return;
      }
      for (const k of Object.keys(v)) find(v[k]);
    }
  };
  find(root);
  return hit;
}

/** Every local `$ref` reachable from `node`, resolved against `root` (annotations left out unless `keep`), by its text. */
function reachableRefs(node: unknown, root: unknown, keep: boolean): Record<string, unknown> {
  const refs = dict();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (isObj(v)) {
      for (const k of Object.keys(v)) {
        const x = v[k];
        if (k === '$ref' && typeof x === 'string' && x.startsWith('#')) {
          if (own(refs, x)) continue;
          const t = resolveRef(root, x);
          refs[x] = t === undefined ? null : stripAnnotations(t, keep);
          walk(t);
        } else walk(x);
      }
    }
  };
  walk(node);
  return refs;
}

/**
 * The schema whose `properties` describe the arguments: the input schema itself, or, where it is a top-level `$ref` (the
 * whole argument object behind a definition, as FastMCP and Pydantic write it), the definition it points at, merged under the
 * schema's own other members (followed up to 8 references deep).
 */
export function effectiveSchema(schema: unknown): unknown {
  let cur = schema;
  for (let i = 0; i < 8 && isObj(cur) && typeof cur['$ref'] === 'string' && !isObj(cur['properties']); i++) {
    const t = resolveRef(schema, cur['$ref'] as string);
    if (!isObj(t)) break;
    const { $ref: _r, ...rest } = cur;
    cur = { ...t, ...rest };
  }
  return cur;
}

const shortHash = (v: unknown): string => sha256(canonical(v)).slice(0, 32);

/**
 * One argument's schema as compare needs it for rule A: `h`, a hash of the schema with its `properties` and `required` left
 * out (and every local `$ref` reachable from the rest, resolved); `p`, the same for each nested property; `r`, the nested
 * required names. Annotation keywords are left out unless `keep`.
 */
export interface Shape {
  h: string;
  p?: Record<string, Shape>;
  r?: string[];
  /** The shape of an array's items, where `items` is one schema. */
  i?: Shape;
}

export function shapeOf(schema: unknown, root: unknown, keep = false): Shape {
  if (!isObj(schema)) return { h: shortHash({ s: plain(schema) }) };
  const s = stripAnnotations(schema, keep) as Record<string, unknown>;
  const core = dict();
  const items = isObj(schema['items']) ? schema['items'] : null;
  for (const k of Object.keys(s)) if (k !== 'properties' && k !== 'required' && !(k === 'items' && items)) core[k] = s[k];
  const props = isObj(schema['properties']) ? schema['properties'] : null;
  const req = Array.isArray(schema['required']) ? [...new Set(schema['required'].filter((x): x is string => typeof x === 'string'))].sort() : null;
  const out: Shape = { h: shortHash({ s: core, refs: reachableRefs(core, root, keep) }) };
  if (props) {
    const p = dict<Shape>();
    for (const n of Object.keys(props).sort()) p[n] = shapeOf(props[n], root, keep);
    out.p = p;
  }
  if (req) out.r = req;
  if (items) out.i = shapeOf(items, root, keep);
  return out;
}

/** A tool's input schema as compare needs it for rule A: the arguments the test sends (`p`), their required names (`r`), the other required names (`ro`), and `h`, the keywords that constrain the arguments together. */
export interface ToolShape {
  h: string;
  p: Record<string, Shape>;
  r: string[];
  ro: string[];
}

/** `used`: the arguments the test sends (null: every declared argument, for the schema probes, which probe each of them). */
export function toolShape(schema: unknown, used: Set<string> | null, keep = false): ToolShape {
  const eff = effectiveSchema(schema);
  if (!isObj(eff)) return { h: shortHash({ s: plain(schema) }), p: dict(), r: [], ro: [] };
  const props = isObj(eff['properties']) ? eff['properties'] : dict();
  const req = Array.isArray(eff['required']) ? [...new Set(eff['required'].filter((x): x is string => typeof x === 'string'))].sort() : [];
  const whole = dict();
  whole['type'] = plain(eff['type']);
  for (const k of SCHEMA_WHOLE) if (own(eff, k)) whole[k] = stripAnnotations(eff[k], keep);
  const args = Object.keys(props).filter((a) => !used || used.has(a)).sort();
  const p = dict<Shape>();
  for (const a of args) p[a] = shapeOf(props[a], schema, keep);
  const inArgs = new Set(args);
  return { h: shortHash({ s: whole, refs: reachableRefs(whole, schema, keep) }), p, r: req.filter((x) => inArgs.has(x)), ro: req.filter((x) => !inArgs.has(x)) };
}

/**
 * The part of an input schema a test depends on, for a reader (testHashInput shows the shapes that enter the hash): `type`; the
 * subschemas of the arguments the test uses; `required` restricted to them and `required_other`, the names of the other required
 * arguments; every top-level keyword that constrains the arguments together (SCHEMA_WHOLE), whole; and `refs`, every local
 * `$ref` reachable from those, resolved. Annotation keywords are left out unless `keep`. A top-level `$ref` is followed.
 */
export function narrowSchema(schema: unknown, used: Set<string>, keep = false): unknown {
  const eff = effectiveSchema(schema);
  if (!isObj(eff)) return plain(schema);
  const props = isObj(eff['properties']) ? eff['properties'] : dict();
  const req = Array.isArray(eff['required']) ? eff['required'].filter((x): x is string => typeof x === 'string') : [];
  const keepProps = dict();
  for (const u of [...used].sort()) if (own(props, u)) keepProps[u] = stripAnnotations(props[u], keep);
  const whole = dict();
  for (const k of SCHEMA_WHOLE) if (own(eff, k)) whole[k] = stripAnnotations(eff[k], keep);
  const refs = { ...reachableRefs(keepProps, schema, keep), ...reachableRefs(whole, schema, keep) };
  return { type: plain(eff['type']), properties: keepProps, required: req.filter((r) => used.has(r)).sort(), required_other: req.filter((r) => !used.has(r)).sort(), ...(Object.keys(whole).length ? { whole } : {}), ...(Object.keys(refs).length ? { refs } : {}) };
}

/** What compare reads to decide whether two records are the same test (rule A; MANIFEST.md, test_hash). Stored on each record. */
export interface TestInputs {
  scheme: string;
  tester: TesterId;
  /** Hash of every input other than the tester, the tool shapes, the probed arguments, the subject and the extras. */
  rest: string;
  /** Hash of the part of `rest` that is not the record itself: spec, resource block, declaration, guard and limits (compare's set-up rule reads it). */
  context?: string;
  /** Per tool the record's resource block names (and the write path's tool): the arguments the test sends, or null for a tool the catalog does not list. */
  tools: Record<string, ToolShape | null>;
  /** Schema probes (MWS-IN-1 to IN-7): every argument of the write path's tool, or null where the catalog does not list it. */
  probed?: ToolShape | null;
  /** Hashes of the judged parts of the entry other than the schema (annotations, description). */
  subject?: Record<string, string | null>;
  /** Settings of the tester build and inputs read from outside the manifest that change a verdict (MWS-IN-5: the reading, the documents' sha256). In clear, so a recheck can say its own. */
  extras?: Record<string, unknown>;
}

function facetPart(tools: TestHashContext['tools'], name: string, f: Facet): unknown {
  const t = tools.find((x) => x.name === name);
  if (!t) return null;
  return plain(f === 'schema' ? t['inputSchema'] : f === 'annotations' ? t['annotations'] : t['description']);
}

/** The members of the manifest every record's hash includes (computed once per run). */
export function sharedInputs(m: Manifest, review?: unknown): { declaration: unknown; limits: unknown; guard: unknown; rate: number } {
  const decl: Record<string, unknown> = Object.fromEntries(Object.entries(m).filter(([k]) => !(HASH_EXCLUDED_TOP as readonly string[]).includes(k)));
  if (review !== undefined) decl['review'] = review;
  // why: review M6: these members of `server` change what a test does, not which build it runs on.
  const sv = m.server as unknown as Record<string, unknown>;
  decl['server'] = Object.fromEntries(SERVER_HASHED.filter((k) => sv?.[k] !== undefined).map((k) => [k, sv[k]]));
  const limits = Object.fromEntries(Object.entries(m.limits).filter(([k]) => !(HASH_EXCLUDED_LIMITS as readonly string[]).includes(k)));
  return { declaration: relativized(plain(decl), baseOf(m)), limits: plain(limits), guard: m.target.guard ? plain(m.target.guard) : null, rate: m.limits.writes_per_second };
}

type RecordKey = Pick<Result, 'requirement' | 'level' | 'scenario' | 'write_path'> & { case?: string };

/** Requirements whose verdict depends on the pace of writes: the concurrency checks and MWS-RETRY-2's simultaneous pairs. */
const paced = (req: string): boolean => /^MWS-CONC-/.test(req) || req === 'MWS-RETRY-2';

/** The record's test inputs (mws-test-hash/2), from the manifest and the tool list. */
export function testInputs(r: RecordKey, ctx: TestHashContext, shared = sharedInputs(ctx.manifest, ctx.review)): TestInputs {
  const res = ctx.manifest.resources.find((x) => x.name === r.write_path.resource) ?? null;
  const names = new Set<string>([r.write_path.tool, ...(res ? toolsNamedIn(res) : [])]);
  const keep = r.requirement === 'MWS-IN-5';
  const underTest = new Set([r.write_path.tool, res?.update?.tool, res?.create?.tool].filter((x): x is string => !!x));
  const tools: Record<string, ToolShape | null> = {};
  for (const n of [...names].sort()) {
    const t = ctx.tools.find((x) => x.name === n);
    tools[n] = t ? toolShape(t['inputSchema'], usedArgs(n, res ? plain(res) : null, underTest.has(n)), keep) : null;
  }
  const limits = paced(r.requirement) ? { ...(shared.limits as Record<string, unknown>), writes_per_second: shared.rate } : shared.limits;
  const extras: Record<string, unknown> = {};
  if (r.requirement === 'MWS-IN-5') {
    if (ctx.extras?.in5_reading !== undefined) extras['in5_reading'] = ctx.extras.in5_reading;
    if (ctx.extras?.in5_docs !== undefined) extras['in5_docs'] = ctx.extras.in5_docs;
  }
  const restInput = {
    spec: SPEC_VERSION,
    requirement: r.requirement,
    level: r.level,
    scenario: { id: r.scenario.id, version: r.scenario.version },
    write_path: { resource: r.write_path.resource, tool: r.write_path.tool, arm: r.write_path.arm },
    ...(r.case !== undefined ? { case: r.case } : {}),
    resource: res ? relativized(plain(res), baseOf(ctx.manifest)) : null,
    declaration: shared.declaration,
    ...(shared.guard !== null ? { guard: shared.guard } : {}),
    limits,
  };
  const contextInput = { spec: restInput.spec, resource: restInput.resource, declaration: restInput.declaration, guard: shared.guard, limits: shared.limits };
  const wt = ctx.tools.find((x) => x.name === r.write_path.tool);
  const facets = subjectFacets(r.requirement).filter((f) => f !== 'schema');
  const t = ctx.tester ?? { name: SUITE_NAME, version: SUITE_VERSION, commit: null };
  return {
    scheme: TEST_HASH_FORMAT,
    tester: { name: t.name, version: t.version, commit: t.commit, dirty: t.dirty ?? null },
    rest: `sha256:${sha256(canonical(restInput))}`,
    context: `sha256:${sha256(canonical(contextInput))}`,
    tools,
    ...(isSchemaProbe(r.requirement) ? { probed: wt ? toolShape(wt['inputSchema'], null, keep) : null } : {}),
    ...(facets.length ? { subject: Object.fromEntries(facets.map((f) => [f, wt ? `sha256:${sha256(canonical(facetPart(ctx.tools, r.write_path.tool, f)))}` : null])) } : {}),
    ...(Object.keys(extras).length ? { extras: plain(extras) as Record<string, unknown> } : {}),
  };
}

/** The member that is the record's subject (the judged schema) when the requirement judges the schema. */
const subjectIsProbed = (requirement: string): boolean => subjectFacets(requirement).includes('schema');

/** What test_hash is the sha256 of (canonical JSON), from stored inputs. `core`: without the judged part of the entry. */
export function hashBody(requirement: string, i: TestInputs, core = false): Record<string, unknown> {
  return {
    format: i.scheme,
    tester: i.tester,
    rest: i.rest,
    tools: i.tools,
    ...(i.probed !== undefined && !(core && subjectIsProbed(requirement)) ? { probed: i.probed } : {}),
    ...(i.subject !== undefined && !core ? { subject: i.subject } : {}),
    ...(i.extras !== undefined ? { extras: i.extras } : {}),
  };
}

export const hashOfInputs = (requirement: string, i: TestInputs, core = false): string => `sha256:${sha256(canonical(hashBody(requirement, i, core)))}`;

/** What the hash is computed over, for one record, with the parts behind `rest` written out (so a reader can see exactly what entered it). */
export function testHashInput(r: RecordKey, ctx: TestHashContext, shared = sharedInputs(ctx.manifest, ctx.review), core = false): Record<string, unknown> {
  const i = testInputs(r, ctx, shared);
  return hashBody(r.requirement, i, core);
}

export function testHash(r: RecordKey, ctx: TestHashContext, shared?: ReturnType<typeof sharedInputs>, core = false): string {
  return hashOfInputs(r.requirement, testInputs(r, ctx, shared ?? sharedInputs(ctx.manifest, ctx.review)), core);
}

/** Set test_hash, test_hash_core (subject requirements) and test_inputs on a record from its inputs (in place; added last). */
export function applyInputs(r: Result, i: TestInputs): void {
  const x = r as Result & { test_hash?: string; test_hash_core?: string; test_inputs?: TestInputs };
  delete x.test_hash;
  delete x.test_hash_core;
  delete x.test_inputs;
  x.test_hash = hashOfInputs(r.requirement, i);
  if (subjectFacets(r.requirement).length) x.test_hash_core = hashOfInputs(r.requirement, i, true);
  x.test_inputs = i;
}

/** Stamp `test_hash` (and test_hash_core, test_inputs) on every record (in place; the members are added last, so the other members keep their order). */
export function stampTestHashes(results: Result[], ctx: TestHashContext): void {
  const shared = sharedInputs(ctx.manifest, ctx.review);
  for (const r of results) applyInputs(r, testInputs(r as RecordKey, ctx, shared));
}
