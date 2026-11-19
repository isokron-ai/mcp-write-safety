/**
 * What the tester writes is published as it stands, so two things are checked on what it wrote, not on what a schema or a
 * reviewer expects it to write:
 *
 * - `undeclaredMembers`: a document validates against its published schema, and carries no member the schema does not name
 *   (where the schema names members at all: an object with no `properties` is open on purpose, `numbers` for one). A member
 *   added in the code and not in the schema fails the test that produces it, on open objects too.
 * - `bannedIn`: no text the tester composes names a server or product the tester was tried on, or cites a review of the tester
 *   (a review round, a note, a research build, a target id). Such a reference belongs in a `// why:` comment; in a record it
 *   would be published in the results of an unrelated server.
 *
 * The shared harnesses call `assertPublishable` on every fixture run; test/unit/publish.test.ts applies `bannedIn` to every
 * string literal of src/.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validates } from '../src/core/jsonschema.js';
import { isObj } from '../src/core/util.js';

/** The package folder (this file is built to dist/test/). */
export const PKG = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const schemaFile = (name: 'mws-results-1' | 'mws-compare-1'): Record<string, unknown> => JSON.parse(readFileSync(join(PKG, 'schema', `${name}.schema.json`), 'utf8')) as Record<string, unknown>;

/**
 * Names and references that no emitted text may carry. Each is matched as a word of its own (`in5_payload_bytes` is a limit).
 * `source`: looked for in the tester's own strings only, since a server's data may spell it (a ticket with the id T32).
 */
export const BANNED: { what: string; re: RegExp; source?: true }[] = [
  { what: 'a product name', re: /grafana|posthog|kubernetes|\bk8s\b|\bkubectl\b|\bloki\b|\bstrapi\b|github|payload[ -]?cms/i },
  // why: `payload` is also a common word; the product is the capitalised one.
  { what: 'a product name', re: /\bPayload\b/ },
  { what: 'a review round', re: /\bgate[- ]?\d|\bre-?review\b|\bresearch builds?\b/i },
  // why: case matters: `stale-write.review v4` is a procedure id, `review R2` is a round.
  { what: 'a review round', re: /\breview(er)? (round |item |note )?[A-Z]\d/ },
  { what: 'a review note or item', re: /\bnotes? \d+\b|\bitem \d+\b|\bfinding \d+\b/i },
  { what: 'a target id', re: /\bt\d{2}\b/i, source: true },
  { what: 'an internal design document', re: /before\/after design|\binterim rule\b/i },
];

/**
 * Strings that carry one of the names for a reason of their own: the CI system a run was made on is part of its identity
 * (`identity.runner.ci.provider`, and the variables that system sets).
 */
export const ALLOWED: RegExp[] = [/^github-actions$/, /^GITHUB_[A-Z_]+$/];

/** What `text` carries that it may not, as `<what>: <the words>`; empty when clean. `written`: text of a run, with a server's data in it. */
export function bannedIn(text: string, o: { written?: boolean } = {}): string[] {
  if (ALLOWED.some((a) => a.test(text))) return [];
  const out: string[] = [];
  for (const b of BANNED) {
    if (b.source && o.written) continue;
    const m = b.re.exec(text);
    if (m) out.push(`${b.what}: ${JSON.stringify(text.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40))}`);
  }
  return out;
}

/** Every string and member name of a JSON value, with its path. */
function strings(v: unknown, path: string, out: [string, string][]): void {
  if (typeof v === 'string') out.push([path, v]);
  else if (Array.isArray(v)) v.forEach((x, i) => strings(x, `${path}[${i}]`, out));
  else if (isObj(v)) {
    for (const [k, x] of Object.entries(v)) {
      out.push([`${path} (member name)`, k]);
      strings(x, `${path}.${k}`, out);
    }
  }
}

function resolve(root: unknown, ref: string): unknown {
  let cur: unknown = root;
  for (const k of ref.replace(/^#\/?/, '').split('/').filter(Boolean)) cur = isObj(cur) ? cur[k] : undefined;
  return cur;
}

/**
 * Paths of the members of `v` that schema `s` does not name. Followed: `properties`, `items`, `$ref`, `allOf`, `then`/`else`
 * as they apply, and the branches of `oneOf`/`anyOf` that the value validates against. An object whose schema has no
 * `properties`, or gives a schema for additional ones, is open.
 */
export function undeclaredMembers(s: unknown, v: unknown, root: unknown = s, path = '$', out = new Set<string>()): string[] {
  if (!isObj(s)) return [...out];
  if (typeof s['$ref'] === 'string') undeclaredMembers(resolve(root, s['$ref']), v, root, path, out);
  for (const b of Array.isArray(s['allOf']) ? s['allOf'] : []) undeclaredMembers(b, v, root, path, out);
  for (const k of ['oneOf', 'anyOf']) for (const b of Array.isArray(s[k]) ? (s[k] as unknown[]) : []) if (validates(b, v, root) === true) undeclaredMembers(b, v, root, path, out);
  if (Array.isArray(v) && s['items'] !== undefined) v.forEach((x) => undeclaredMembers(s['items'], x, root, `${path}[]`, out));
  if (isObj(v) && isObj(s['properties'])) {
    const props = s['properties'];
    for (const [k, x] of Object.entries(v)) {
      if (Object.hasOwn(props, k)) undeclaredMembers(props[k], x, root, `${path}.${k}`, out);
      else if (!isObj(s['additionalProperties'])) out.add(`${path}.${k}`);
    }
  }
  return [...out].sort();
}

/** `doc` validates against the published schema and has no member the schema does not name. */
export function assertMatchesSchema(name: 'mws-results-1' | 'mws-compare-1', doc: unknown, what: string): void {
  const schema = schemaFile(name);
  assert.equal(validates(schema, doc), true, `${what} validates against schema/${name}.schema.json`);
  assert.deepEqual(undeclaredMembers(schema, doc), [], `${what}: members that schema/${name}.schema.json does not name`);
}

/** No string or member name of a results or compare document, and no line of a report, carries a banned reference. */
export function assertNoBannedText(doc: unknown, reports: Record<string, string>): void {
  // why: the signature and key are base64, which spells anything; where the run was made (the CI run) is the runner's own.
  const d = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
  if (isObj(d['evidence'])) delete d['evidence']['signature'];
  if (isObj(d['identity']) && isObj(d['identity']['runner'])) delete d['identity']['runner']['ci'];
  // why: observations copy the server's own tool descriptions; they are the server's words, not the tester's.
  if (Array.isArray(d['observations'])) for (const o of d['observations']) if (isObj(o) && isObj(o['data'])) delete o['data']['descriptions'];
  const all: [string, string][] = [];
  strings(d, '$', all);
  for (const [file, text] of Object.entries(reports)) text.split('\n').forEach((line, i) => all.push([`${file}:${i + 1}`, line]));
  const bad = all.flatMap(([where, text]) => bannedIn(text, { written: true }).map((b) => `${where}: ${b}`));
  assert.deepEqual(bad, [], 'text the tester wrote names a product or cites a review (say it in a `// why:` comment, not in a record)');
}

/** A run folder as written: results.json against its schema, and results.json and report.md free of banned references. */
export function assertPublishable(outDir: string, o: { text?: boolean } = {}): void {
  const doc = JSON.parse(readFileSync(join(outDir, 'results.json'), 'utf8')) as unknown;
  assertMatchesSchema('mws-results-1', doc, `${outDir}/results.json`);
  if (o.text === false) return;
  const report = join(outDir, 'report.md');
  assertNoBannedText(doc, existsSync(report) ? { 'report.md': readFileSync(report, 'utf8') } : {});
}
