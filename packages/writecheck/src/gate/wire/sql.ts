/**
 * A Postgres SQL classifier for the wire gate: write or read, verb and target table, with the
 * values removed. It tokenizes (comments, '…', E'…', "…", $tag$…$tag$), splits at top-level `;`,
 * and reads each statement's first keyword. The rule is conservative: a statement counts as a
 * write unless it is known not to write; when unsure it says why (docs/WIRE-GATE.md §4.1).
 */

import { cut, type Classified } from './codec.js';

type Tok = { t: 'word' | 'qident' | 'str' | 'num' | 'param' | 'punct'; v: string; depth: number };

/**
 * Split SQL into tokens; comments and whitespace dropped. Never throws: an unterminated literal ends the text.
 * `backslashEscapes`: standard_conforming_strings is off, so a backslash escapes inside '…' as well as E'…'.
 */
export function tokenize(sql: string, o: { backslashEscapes?: boolean } = {}): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  let depth = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      let lvl = 1;
      i += 2;
      while (i < n && lvl > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') (lvl++, (i += 2));
        else if (sql[i] === '*' && sql[i + 1] === '/') (lvl--, (i += 2));
        else i++;
      }
      continue;
    }
    if (c === "'" || ((c === 'E' || c === 'e') && sql[i + 1] === "'")) {
      const esc = c !== "'" || o.backslashEscapes === true;
      i += esc ? 2 : 1;
      while (i < n) {
        if (esc && sql[i] === '\\') i += 2;
        else if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") break;
        else i++;
      }
      i++;
      out.push({ t: 'str', v: '?', depth });
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let v = '';
      while (j < n) {
        if (sql[j] === '"' && sql[j + 1] === '"') (v += '"', (j += 2));
        else if (sql[j] === '"') break;
        else v += sql[j++];
      }
      i = j + 1;
      out.push({ t: 'qident', v, depth });
      continue;
    }
    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        i = end < 0 ? n : end + tag.length;
        out.push({ t: 'str', v: '?', depth });
        continue;
      }
      const p = /^\$\d+/.exec(sql.slice(i));
      if (p) {
        out.push({ t: 'param', v: p[0], depth });
        i += p[0].length;
        continue;
      }
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(sql[i + 1] ?? ''))) {
      const m = /^(?:0x[0-9a-fA-F_]+|[0-9_]*\.?[0-9_]+(?:[eE][+-]?[0-9]+)?)/.exec(sql.slice(i));
      const len = m && m[0].length ? m[0].length : 1;
      out.push({ t: 'num', v: '?', depth });
      i += len;
      continue;
    }
    if (/[A-Za-z_\u0080-￿]/.test(c)) {
      const m = /^[A-Za-z_\u0080-￿][A-Za-z0-9_$\u0080-￿]*/.exec(sql.slice(i))!;
      out.push({ t: 'word', v: m[0], depth });
      i += m[0].length;
      continue;
    }
    if (c === '(') {
      out.push({ t: 'punct', v: c, depth });
      depth++;
      i++;
      continue;
    }
    if (c === ')') {
      depth = Math.max(0, depth - 1);
      out.push({ t: 'punct', v: c, depth });
      i++;
      continue;
    }
    if (c === ':' && sql[i + 1] === ':') {
      out.push({ t: 'punct', v: '::', depth });
      i += 2;
      continue;
    }
    out.push({ t: 'punct', v: c, depth });
    i++;
  }
  return out;
}

/** Top-level statements (split at `;` outside parentheses). */
export function statements(toks: Tok[]): Tok[][] {
  const out: Tok[][] = [];
  let cur: Tok[] = [];
  for (const t of toks) {
    if (t.t === 'punct' && t.v === ';' && t.depth === 0) {
      if (cur.length) out.push(cur);
      cur = [];
    } else cur.push(t);
  }
  if (cur.length) out.push(cur);
  return out;
}

/** The statement with values removed: literals and numbers as ?, quoted identifiers kept. */
export function normalized(toks: Tok[]): string {
  let s = '';
  for (const t of toks) {
    const v = t.t === 'qident' ? `"${t.v}"` : t.v;
    const glue = s === '' || t.v === ')' || t.v === ',' || t.v === '.' || t.v === '::' || s.endsWith('(') || s.endsWith('.') || s.endsWith('::');
    s += glue ? v : ` ${v}`;
  }
  return cut(s);
}

const W = (t: Tok | undefined) => (t && t.t === 'word' ? t.v.toUpperCase() : '');

/** A (possibly schema-qualified) name starting at i: [name, next index]. */
function nameAt(toks: Tok[], i: number): [string, number] {
  const parts: string[] = [];
  let j = i;
  while (j < toks.length) {
    const t = toks[j]!;
    if (t.t !== 'word' && t.t !== 'qident') break;
    parts.push(t.t === 'word' ? t.v.toLowerCase() : t.v);
    if (toks[j + 1]?.v === '.' && (toks[j + 2]?.t === 'word' || toks[j + 2]?.t === 'qident')) j += 2;
    else {
      j++;
      break;
    }
  }
  return [parts.join('.'), j];
}

function skipWords(toks: Tok[], i: number, words: string[]): number {
  while (i < toks.length && words.includes(W(toks[i]))) i++;
  return i;
}

/** Functions known to read only (and pure operators written as functions). Anything else called in a read is an uncertain write. */
const SAFE_FUNCS = new Set(
  (
    'count sum avg min max array_agg string_agg json_agg jsonb_agg json_object_agg jsonb_object_agg bool_and bool_or every bit_and bit_or ' +
    'json_build_object jsonb_build_object json_build_array jsonb_build_array row_to_json to_json to_jsonb array_to_json jsonb_set jsonb_insert jsonb_strip_nulls jsonb_pretty ' +
    'json_extract_path json_extract_path_text jsonb_extract_path jsonb_extract_path_text jsonb_array_elements jsonb_array_elements_text json_array_elements json_array_elements_text ' +
    'jsonb_each jsonb_each_text json_each json_each_text jsonb_object_keys json_object_keys jsonb_typeof json_typeof jsonb_array_length json_array_length jsonb_path_query jsonb_path_exists jsonb_path_match jsonb_path_query_first ' +
    'coalesce nullif greatest least lower upper initcap length char_length character_length octet_length bit_length substr substring trim btrim ltrim rtrim replace translate concat concat_ws format left right lpad rpad repeat reverse ' +
    'position strpos split_part regexp_replace regexp_matches regexp_match regexp_split_to_array regexp_split_to_table starts_with string_to_array array_to_string quote_ident quote_literal quote_nullable ' +
    'now current_timestamp current_date current_time localtime localtimestamp clock_timestamp statement_timestamp transaction_timestamp timeofday date_trunc date_part extract to_char to_date to_timestamp to_number age make_date make_timestamp make_timestamptz make_interval justify_days justify_hours justify_interval isfinite ' +
    'abs ceil ceiling floor round trunc mod power pow sqrt cbrt exp ln log log10 sign pi random gen_random_uuid uuid_generate_v4 md5 sha256 encode decode digest ' +
    'array_length array_position array_positions array_append array_prepend array_cat array_remove array_replace array_lower array_upper array_dims array_ndims cardinality unnest generate_series generate_subscripts ' +
    'row_number rank dense_rank percent_rank cume_dist ntile lag lead first_value last_value nth_value percentile_cont percentile_disc mode stddev stddev_pop stddev_samp variance var_pop var_samp corr ' +
    'current_setting version current_database current_schema current_schemas current_user session_user current_catalog inet_client_addr pg_backend_pid txid_current_if_assigned ' +
    'pg_typeof format_type obj_description col_description shobj_description has_table_privilege has_column_privilege has_schema_privilege has_database_privilege has_function_privilege ' +
    'pg_table_is_visible pg_type_is_visible pg_function_is_visible pg_relation_size pg_total_relation_size pg_table_size pg_indexes_size pg_database_size pg_size_pretty pg_column_size ' +
    'pg_get_constraintdef pg_get_indexdef pg_get_viewdef pg_get_functiondef pg_get_function_arguments pg_get_function_result pg_get_expr pg_get_serial_sequence pg_get_triggerdef pg_get_keywords pg_get_userbyid ' +
    'pg_is_in_recovery pg_postmaster_start_time pg_encoding_to_char to_regclass to_regtype to_regproc array_fill num_nulls num_nonnulls width_bucket set_masklen host family'
  ).split(' '),
);
/** Functions called in a SELECT that write or take side effects. */
const UNSAFE_FUNCS = /^(nextval|setval|pg_advisory\w*|pg_try_advisory\w*|lo_\w+|dblink\w*|set_config|pg_notify|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|pg_switch_wal|pg_create_\w+|pg_drop_\w+|pg_replication_\w+|pg_logical_\w+|txid_current|pg_current_xact_id)$/i;
/** Words that take parentheses but are not function calls. */
const NOT_CALLS = new Set(
  'IN EXISTS ANY ALL SOME VALUES CAST ARRAY ROW OVER FILTER WITHIN AS ON USING JOIN LATERAL AND OR NOT WHERE SELECT FROM CASE WHEN THEN ELSE IS LIKE ILIKE BETWEEN GROUPING ORDER BY PARTITION INTERVAL EXTRACT POSITION SUBSTRING TRIM OVERLAY NULLIF COALESCE GREATEST LEAST TABLE INTO WITH RECURSIVE MATERIALIZED UNION INTERSECT EXCEPT HAVING GROUP LIMIT OFFSET FETCH FOR DISTINCT ROWS RANGE GROUPS PRECEDING FOLLOWING CURRENT UNBOUNDED VARCHAR CHAR CHARACTER NUMERIC DECIMAL TIMESTAMP TIME BIT VARYING FLOAT DOUBLE PRECISION XMLELEMENT XMLFOREST XMLPARSE XMLSERIALIZE XMLEXISTS JSON_TABLE COLUMNS LIKE_REGEX SIMILAR TO ESCAPE OUTER INNER LEFT RIGHT FULL CROSS NATURAL'.split(' '),
);

const CONTROL = new Set(['BEGIN', 'START', 'COMMIT', 'END', 'ROLLBACK', 'ABORT', 'SAVEPOINT', 'RELEASE', 'SET', 'RESET', 'DISCARD', 'DEALLOCATE', 'LISTEN', 'UNLISTEN', 'NOTIFY', 'VACUUM', 'ANALYZE', 'ANALYSE', 'CHECKPOINT', 'LOCK', 'REINDEX', 'CLUSTER', 'LOAD']);
const READS = new Set(['SELECT', 'VALUES', 'TABLE', 'SHOW', 'FETCH', 'MOVE', 'CLOSE', 'DECLARE']);
const DDL = new Set(['CREATE', 'ALTER', 'DROP', 'GRANT', 'REVOKE', 'COMMENT', 'SECURITY', 'IMPORT', 'REFRESH']);
const MODIFY = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE']);

export interface StatementClass {
  verb: string;
  path: string;
  mutating: boolean;
  uncertain?: string;
  statement: string;
}

/** Statements prepared with SQL PREPARE on this connection (name → class), for EXECUTE. */
export type Prepared = Map<string, StatementClass>;

/** The first function call, in a read, that is not on the read-only list. */
function unsafeCall(toks: Tok[]): string | null {
  for (let i = 0; i + 1 < toks.length; i++) {
    const t = toks[i]!;
    if ((t.t !== 'word' && t.t !== 'qident') || toks[i + 1]!.v !== '(') continue;
    if (toks[i - 1]?.v === '::') continue; // a type with a modifier: x::varchar(10)
    const name = t.v.toLowerCase();
    if (t.t === 'word' && NOT_CALLS.has(t.v.toUpperCase())) continue;
    // why: a schema-qualified name is trusted only in pg_catalog (myschema.count() can be anything).
    const qual = toks[i - 1]?.v === '.' ? (toks[i - 2]?.t === 'word' || toks[i - 2]?.t === 'qident' ? toks[i - 2]!.v.toLowerCase() : '?') : null;
    if (t.t === 'word' && SAFE_FUNCS.has(name) && (qual === null || qual === 'pg_catalog')) continue;
    return qual ? `${qual}.${name}` : name;
  }
  return null;
}

function fromTable(toks: Tok[]): string {
  for (let i = 0; i < toks.length; i++) if (W(toks[i]) === 'FROM') return nameAt(toks, skipWords(toks, i + 1, ['ONLY', 'LATERAL']))[0];
  return '';
}

function readClass(verb: string, toks: Tok[], stmt: string): StatementClass {
  // SELECT … INTO new_table creates a table (outside PL/pgSQL).
  for (let i = 1; i < toks.length; i++) {
    if (W(toks[i]) === 'INTO' && toks[i]!.depth === 0 && verb === 'SELECT') {
      const [name] = nameAt(toks, skipWords(toks, i + 1, ['TEMP', 'TEMPORARY', 'UNLOGGED', 'TABLE']));
      return { verb: 'SELECT INTO', path: name, mutating: true, statement: stmt };
    }
  }
  const f = unsafeCall(toks);
  const path = verb === 'TABLE' ? nameAt(toks, 1)[0] : fromTable(toks);
  if (f) return { verb, path, mutating: true, uncertain: UNSAFE_FUNCS.test(f) ? `calls ${f}(), which writes or takes a lock` : `calls ${f}(), which is not on the read-only list and may write`, statement: stmt };
  return { verb, path, mutating: false, statement: stmt };
}

function modifyClass(toks: Tok[], at: number, stmt: string): StatementClass {
  const verb = W(toks[at]);
  let i = at + 1;
  if (verb === 'INSERT' || verb === 'MERGE') i = skipWords(toks, i, ['INTO']);
  if (verb === 'DELETE') i = skipWords(toks, i, ['FROM']);
  i = skipWords(toks, i, ['ONLY']);
  return { verb, path: nameAt(toks, i)[0], mutating: true, statement: stmt };
}

/** Classify one statement (tokens without the trailing `;`). */
export function classifyStatement(toks: Tok[], prepared: Prepared = new Map()): StatementClass {
  const stmt = normalized(toks);
  let s = 0;
  while (toks[s]?.v === '(') s++;
  const first = W(toks[s]);
  if (!first) return { verb: '?', path: '', mutating: true, uncertain: 'the statement does not start with a keyword', statement: stmt };
  if (MODIFY.has(first)) return modifyClass(toks, s, stmt);
  if (first === 'TRUNCATE') return { verb: first, path: nameAt(toks, skipWords(toks, s + 1, ['TABLE', 'ONLY']))[0], mutating: true, statement: stmt };
  if (first === 'COPY') {
    if (toks[s + 1]?.v === '(') {
      // why: COPY (query) TO runs the query: COPY (DELETE … RETURNING *) TO STDOUT writes.
      const d = toks[s + 1]!.depth;
      const end = toks.findIndex((t, k) => k > s + 1 && t.v === ')' && t.depth === d);
      const inner = classifyStatement(toks.slice(s + 2, end < 0 ? toks.length : end), prepared);
      return inner.mutating ? { ...inner, verb: `COPY (${inner.verb})`, statement: stmt } : { verb: 'COPY TO', path: inner.path, mutating: false, statement: stmt };
    }
    const [name] = nameAt(toks, s + 1);
    const dir = toks.slice(s + 2).find((t) => t.depth === 0 && (W(t) === 'FROM' || W(t) === 'TO'));
    return W(dir) === 'TO' ? { verb: 'COPY TO', path: name, mutating: false, statement: stmt } : { verb: 'COPY FROM', path: name, mutating: true, statement: stmt };
  }
  if (first === 'WITH') {
    for (let i = s + 1; i < toks.length; i++) {
      const w = W(toks[i]);
      if (!MODIFY.has(w)) continue;
      const prev = W(toks[i - 1]);
      // why: FOR UPDATE / FOR NO KEY UPDATE are locking reads, ON CONFLICT DO UPDATE belongs to an INSERT already counted.
      if (w === 'UPDATE' && (prev === 'FOR' || prev === 'KEY' || prev === 'DO')) continue;
      return { ...modifyClass(toks, i, stmt), verb: `WITH ${w}` };
    }
    const main = toks.findIndex((t, i) => i > s && t.depth === 0 && ['SELECT', 'VALUES', 'TABLE'].includes(W(t)));
    return readClass('WITH SELECT', main < 0 ? toks : toks.slice(main), stmt);
  }
  if (READS.has(first)) {
    if (first === 'DECLARE') {
      // why: the cursor's query runs as it is fetched; DECLARE itself runs nothing, FETCH and MOVE take the query's class.
      const [name] = nameAt(toks, s + 1);
      const q = toks.findIndex((t) => W(t) === 'FOR' && t.depth === 0);
      const inner = q < 0 ? null : classifyStatement(toks.slice(q + 1), prepared);
      if (inner) prepared.set(`cursor:${name}`, inner);
      return { verb: first, path: inner?.path ?? '', mutating: false, statement: stmt };
    }
    if (first === 'FETCH' || first === 'MOVE') {
      const words = toks.filter((t) => t.t === 'word' || t.t === 'qident');
      const last = words[words.length - 1];
      const name = last ? (last.t === 'word' ? last.v.toLowerCase() : last.v) : '';
      const c = prepared.get(`cursor:${name}`);
      if (c?.mutating) return { verb: first, path: c.path, mutating: true, uncertain: `fetches from cursor ${name}, whose query ${c.uncertain ? 'may write' : 'writes'}`, statement: stmt };
      return { verb: first, path: c?.path ?? '', mutating: false, statement: stmt };
    }
    if (first === 'SHOW' || first === 'CLOSE') return { verb: first, path: '', mutating: false, statement: stmt };
    return readClass(first, toks.slice(s), stmt);
  }
  if (first === 'EXPLAIN') {
    let i = s + 1;
    let analyze = false;
    if (toks[i]?.v === '(') {
      for (; i < toks.length && !(toks[i]!.v === ')' && toks[i]!.depth === 0); i++) if (W(toks[i]) === 'ANALYZE' || W(toks[i]) === 'ANALYSE') analyze = !['FALSE', 'OFF', '0'].includes(W(toks[i + 1]));
      i++;
    } else
      for (; i < toks.length && ['ANALYZE', 'ANALYSE', 'VERBOSE'].includes(W(toks[i])); i++) if (W(toks[i]) !== 'VERBOSE') analyze = true;
    const inner = classifyStatement(toks.slice(i), prepared);
    return analyze && inner.mutating ? { ...inner, verb: `EXPLAIN ANALYZE ${inner.verb}`, statement: stmt } : { verb: 'EXPLAIN', path: inner.path, mutating: false, statement: stmt };
  }
  if (first === 'PREPARE') {
    if (W(toks[s + 1]) === 'TRANSACTION') return { verb: 'PREPARE TRANSACTION', path: '', mutating: false, statement: stmt };
    const [name, j] = nameAt(toks, s + 1);
    const as = toks.findIndex((t, k) => k >= j && W(t) === 'AS' && t.depth === 0);
    if (as >= 0) prepared.set(name, classifyStatement(toks.slice(as + 1), prepared));
    return { verb: 'PREPARE', path: name, mutating: false, statement: stmt };
  }
  if (first === 'EXECUTE') {
    const [name] = nameAt(toks, s + 1);
    const p = prepared.get(name);
    return p ? { ...p, statement: stmt } : { verb: 'EXECUTE', path: name, mutating: true, uncertain: `executes ${name || 'a statement'} not prepared on this connection`, statement: stmt };
  }
  if (first === 'CALL') return { verb: first, path: nameAt(toks, s + 1)[0], mutating: true, uncertain: 'calls a procedure whose body is not inspected', statement: stmt };
  if (first === 'DO') return { verb: first, path: '', mutating: true, uncertain: 'an anonymous code block whose body is not inspected', statement: stmt };
  if (DDL.has(first)) {
    let i = skipWords(toks, s + 1, ['OR', 'REPLACE', 'TEMP', 'TEMPORARY', 'UNLOGGED', 'GLOBAL', 'LOCAL', 'UNIQUE', 'MATERIALIZED', 'RECURSIVE']);
    const kind = W(toks[i]);
    i = skipWords(toks, i + 1, ['IF', 'NOT', 'EXISTS', 'CONCURRENTLY', 'ONLY']);
    return { verb: kind ? `${first} ${kind}` : first, path: ['GRANT', 'REVOKE', 'COMMENT', 'SECURITY'].includes(first) ? '' : nameAt(toks, i)[0], mutating: true, statement: stmt };
  }
  if (CONTROL.has(first)) {
    if (first === 'ROLLBACK' && W(toks[s + 1]) === 'PREPARED') return { verb: 'ROLLBACK PREPARED', path: '', mutating: false, statement: stmt };
    if (first === 'COMMIT' && W(toks[s + 1]) === 'PREPARED') return { verb: 'COMMIT PREPARED', path: '', mutating: true, uncertain: 'commits a prepared transaction whose statements were not seen', statement: stmt };
    if (first === 'ROLLBACK' && toks.slice(s + 1).some((t) => W(t) === 'TO')) return { verb: 'ROLLBACK TO', path: '', mutating: false, statement: stmt };
    const verb = first === 'START' ? 'BEGIN' : first === 'END' ? 'COMMIT' : first === 'ABORT' ? 'ROLLBACK' : first === 'ANALYSE' ? 'ANALYZE' : first;
    // why: a SET value can be unquoted (SET app.token = abc123): record the setting's name only.
    if (first === 'SET' || first === 'RESET') {
      const i = skipWords(toks, s + 1, ['SESSION', 'LOCAL']);
      const [name] = nameAt(toks, i);
      return { verb, path: '', mutating: false, statement: `${first} ${name || W(toks[i])}`.trim() };
    }
    return { verb, path: '', mutating: false, statement: stmt };
  }
  return { verb: first, path: '', mutating: true, uncertain: `unknown statement ${first}`, statement: stmt };
}

/** Classify a whole SQL text (one or more statements). Each statement's class, in order. */
export function classifySql(sql: string, prepared: Prepared = new Map(), o: { backslashEscapes?: boolean } = {}): StatementClass[] {
  const st = statements(tokenize(sql, o));
  if (!st.length) return [{ verb: 'EMPTY', path: '', mutating: false, statement: '' }];
  return st.map((t) => classifyStatement(t, prepared));
}

/** One class for a unit made of several statements: the first write's verb and table, every uncertainty. */
export function combine(cs: StatementClass[]): Classified {
  if (!cs.length) return { verb: 'EMPTY', path: '', mutating: false, statement: '' };
  const w = cs.find((c) => c.mutating) ?? cs[0]!;
  const unc = [...new Set(cs.map((c) => c.uncertain).filter((u): u is string => !!u))];
  return {
    verb: w.verb,
    path: w.path,
    mutating: cs.some((c) => c.mutating),
    ...(unc.length ? { uncertain: unc.join('; ') } : {}),
    statement: cs.length > 1 ? cut(cs.map((c) => c.statement).join('; ')) : w.statement,
    ...(cs.length > 1 ? { statements: cs.length } : {}),
  };
}
