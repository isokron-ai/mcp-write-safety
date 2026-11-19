/**
 * Real databases and real drivers through the wire gate (docs/WIRE-GATE.md §7, items 1, 2, 5, 6, 7).
 * Not part of `npm test`: it needs Docker containers and the drivers installed in B1_DRV.
 *
 *   B1_DRV=<dir with node_modules: pg postgres redis@5 ioredis mongodb>  B1_PY=<python with psycopg>
 *   PG_SCRAM_URL PG_MD5_URL REDIS_URL REDIS_ACL_URL MONGO_URL MONGO_RS_URL
 *   node test/wire/real/real-db-check.mjs     (after npm run build)
 *
 * Each check prints `ITEM <n> <name>: PASS|FAIL <detail>`; the exit code is the number of failures.
 */

import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', '..', '..', 'dist', 'src');
const { WireGate } = await import(join(dist, 'gate', 'wire', 'proxy.js'));
const { PostgresSession } = await import(join(dist, 'gate', 'wire', 'postgres.js'));
const { RedisSession } = await import(join(dist, 'gate', 'wire', 'redis.js'));
const { MongoSession, sharedMongo } = await import(join(dist, 'gate', 'wire', 'mongodb.js'));
const { egressFor } = await import(join(dist, 'core', 'egress.js'));

const req = createRequire(join(process.env.B1_DRV ?? process.cwd(), 'noop.js'));
const pg = req('pg');
const postgres = req('postgres');
const { createClient } = req('redis');
const IORedis = req('ioredis');
const { MongoClient } = req('mongodb');
const env = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is not set`);
  return v;
};

let failures = 0;
const results = [];
function report(item, name, ok, detail = '') {
  if (!ok) failures++;
  const line = `ITEM ${item} ${name}: ${ok ? 'PASS' : 'FAIL'}${detail ? ` ${detail}` : ''}`;
  results.push(line);
  console.log(line);
}
async function check(item, name, f) {
  try {
    const d = await f();
    report(item, name, d?.ok ?? true, d?.detail ?? '');
  } catch (e) {
    report(item, name, false, `threw: ${e?.stack?.split('\n').slice(0, 3).join(' | ') ?? e}`);
  }
}
const gates = [];
async function gate(protocol, url, codec) {
  const g = new WireGate(protocol, 'X', url, egressFor([]), 5000, codec);
  await g.start();
  gates.push(g);
  return { g, url: g.serverEnv()['X'] };
}
const pgCodec = (k) => new PostgresSession(k);
const redisCodec = (k) => new RedisSession(k);
const mongoCodec = () => {
  const s = sharedMongo();
  return (k) => new MongoSession(k, s);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const firstDiff = (a, b) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (!same(a[i], b[i])) return `op ${i}: direct ${JSON.stringify(a[i])?.slice(0, 200)} gated ${JSON.stringify(b[i])?.slice(0, 200)}`;
  return '';
};
/** The gate's log must hold no lost framing, and every write named. */
function logHealth(g) {
  const log = g.log ?? [];
  const lost = log.filter((r) => r.method === '?');
  const unc = log.filter((r) => r.wire?.uncertain);
  return { n: log.length, lost: lost.length, uncertain: [...new Set(unc.map((r) => `${r.method}: ${r.wire.uncertain}`))].slice(0, 5) };
}

// ---------- Postgres ----------

async function pgOps(client, t) {
  const out = [];
  const rec = async (f) => {
    try {
      const r = await f();
      const one = (x) => ({ command: x.command, rowCount: x.rowCount, rows: x.rows });
      out.push(Array.isArray(r) ? r.map(one) : one(r));
    } catch (e) {
      out.push({ error: e.code ?? e.message });
    }
  };
  await client.query(`DROP TABLE IF EXISTS ${t}`);
  await client.query(`CREATE TABLE ${t} (id text PRIMARY KEY, title text, n int NOT NULL DEFAULT 0, tags text[], doc jsonb)`);
  for (let i = 0; i < 300; i++) {
    const id = `k${i % 20}`;
    switch (i % 8) {
      case 0: await rec(() => client.query(`INSERT INTO ${t} (id, title, n, tags, doc) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING RETURNING id, n`, [id, `t'${i}`, i, ['a', `b${i}`], { i, s: 'x"y' }])); break;
      case 1: await rec(() => client.query(`UPDATE ${t} SET n = n + 1, title = $2 WHERE id = $1 RETURNING n, title`, [id, `u${i}`])); break;
      case 2: await rec(() => client.query(`SELECT id, title, n, tags, doc FROM ${t} WHERE id = $1`, [id])); break;
      case 3: await rec(() => client.query(`SELECT count(*)::int AS c, coalesce(sum(n), 0)::int AS s FROM ${t}`)); break;
      case 4: await rec(() => client.query(`BEGIN; UPDATE ${t} SET n = n * 2 WHERE id = '${id}'; COMMIT`)); break;
      case 5:
        await rec(async () => {
          await client.query('BEGIN');
          await client.query(`INSERT INTO ${t} (id, title) VALUES ($1, 'sp') ON CONFLICT DO NOTHING`, [`s${i}`]);
          await client.query('SAVEPOINT s');
          try {
            await client.query(`INSERT INTO ${t} (id, title) VALUES ($1, 'dup')`, [id]);
          } catch {
            await client.query('ROLLBACK TO s');
          }
          return client.query('COMMIT');
        });
        break;
      case 6: await rec(() => client.query(`WITH x AS (UPDATE ${t} SET title = 'w' WHERE id = $1 RETURNING *) SELECT count(*)::int AS c FROM x`, [id])); break;
      case 7: await rec(() => client.query(`DELETE FROM ${t} WHERE id = $1 AND n > 50 RETURNING id`, [id])); break;
    }
  }
  await rec(() => client.query(`SELECT * FROM ${t} ORDER BY id`));
  await client.query(`DROP TABLE ${t}`);
  return out;
}

async function pgjsOps(sql, t) {
  await sql.unsafe(`DROP TABLE IF EXISTS ${t}`);
  await sql.unsafe(`CREATE TABLE ${t} (id text PRIMARY KEY, n int NOT NULL DEFAULT 0)`);
  const out = [];
  for (let round = 0; round < 10; round++) {
    // why: issued together on one connection (max: 1), postgres.js pipelines them.
    const batch = [];
    for (let i = 0; i < 20; i++) {
      const id = `k${i % 7}`;
      if (i % 3 === 0) batch.push(sql`INSERT INTO ${sql(t)} (id, n) VALUES (${id}, ${i}) ON CONFLICT (id) DO UPDATE SET n = ${sql(t)}.n + 1 RETURNING id, n`);
      else if (i % 3 === 1) batch.push(sql`SELECT id, n FROM ${sql(t)} WHERE id = ${id}`);
      else batch.push(sql`UPDATE ${sql(t)} SET n = n + ${round} WHERE id = ${id} RETURNING n`);
    }
    for (const r of await Promise.allSettled(batch)) out.push(r.status === 'fulfilled' ? { count: r.value.count, rows: [...r.value] } : { error: r.reason?.code });
    out.push(await sql.begin(async (tx) => [...(await tx`UPDATE ${tx(t)} SET n = 0 WHERE id = 'k0' RETURNING n`)]));
  }
  out.push([...(await sql`SELECT * FROM ${sql(t)} ORDER BY id`)]);
  await sql.unsafe(`DROP TABLE ${t}`);
  return out;
}

const PSY = `
import json, sys, psycopg
out = []
with psycopg.connect(sys.argv[1], autocommit=True) as c:
    t = sys.argv[2]
    c.execute(f"DROP TABLE IF EXISTS {t}")
    c.execute(f"CREATE TABLE {t} (id text PRIMARY KEY, n int)")
    for i in range(100):
        k = f"k{i % 9}"
        try:
            if i % 4 == 0: cur = c.execute(f"INSERT INTO {t} (id, n) VALUES (%s, %s) ON CONFLICT (id) DO UPDATE SET n = {t}.n + 1 RETURNING n", (k, i))
            elif i % 4 == 1: cur = c.execute(f"SELECT id, n FROM {t} WHERE id = %s", (k,))
            elif i % 4 == 2:
                with c.transaction():
                    cur = c.execute(f"UPDATE {t} SET n = n * 2 WHERE id = %s RETURNING n", (k,))
            else: cur = c.execute(f"INSERT INTO {t} (id, n) VALUES (%s, 0)", (k,))
            out.append({"rowcount": cur.rowcount, "rows": cur.fetchall() if cur.description else None})
        except psycopg.Error as e:
            out.append({"error": e.sqlstate})
    out.append(c.execute(f"SELECT * FROM {t} ORDER BY id").fetchall())
    c.execute(f"DROP TABLE {t}")
    out.append({"ssl_in_use": c.pgconn.ssl_in_use})
print(json.dumps(out))
`;

async function postgresChecks() {
  const scram = env('PG_SCRAM_URL');
  const md5 = env('PG_MD5_URL');
  const { g, url } = await gate('postgres', scram, pgCodec);

  await check(1, 'postgres / pg (node-postgres, extended protocol): 300 mixed statements identical direct and gated', async () => {
    const d = new pg.Client({ connectionString: scram });
    const v = new pg.Client({ connectionString: url });
    await d.connect();
    await v.connect();
    const m0 = g.mark();
    const a = await pgOps(d, 'b1_pg_t');
    const b = await pgOps(v, 'b1_pg_t');
    await d.end();
    await v.end();
    const log = await g.since(m0);
    const writes = log.filter((r) => r.mutating).length;
    const h = logHealth({ log });
    return { ok: same(a, b) && h.lost === 0 && writes > 100, detail: `${a.length} results ${same(a, b) ? 'identical' : `DIFFER ${firstDiff(a, b)}`}; gate logged ${log.length} units, ${writes} writes, ${h.lost} framing losses; uncertain: ${JSON.stringify(h.uncertain)}` };
  });

  await check(1, 'postgres / postgres.js (pipelined on one connection): identical direct and gated', async () => {
    const d = postgres(scram, { max: 1, onnotice: () => {} });
    const v = postgres(url, { max: 1, onnotice: () => {} });
    const m0 = g.mark();
    const a = await pgjsOps(d, 'b1_pgjs_t');
    const b = await pgjsOps(v, 'b1_pgjs_t');
    await d.end();
    await v.end();
    const log = await g.since(m0);
    return { ok: same(a, b) && !log.some((r) => r.method === '?'), detail: `${a.length} results ${same(a, b) ? 'identical' : `DIFFER ${firstDiff(a, b)}`}; gate logged ${log.length} units (${log.filter((r) => (r.wire?.statements ?? 1) > 1).length} with several statements)` };
  });

  await check(1, 'postgres / psycopg 3 (libpq: SSLRequest first): identical direct and gated', async () => {
    const py = env('B1_PY');
    const file = join(tmpdir(), 'b1-psy.py');
    writeFileSync(file, PSY);
    const run = (u) => {
      const r = spawnSync(py, [file, u, 'b1_psy_t'], { encoding: 'utf8', timeout: 60_000 });
      if (r.status !== 0) throw new Error(`psycopg: ${r.stderr.slice(-500)}`);
      return JSON.parse(r.stdout);
    };
    const a = run(scram);
    const b = run(url);
    // why: the direct connection may use TLS (sslmode=prefer) where the gate answers N; that one line may differ.
    const strip = (x) => x.slice(0, -1);
    return { ok: same(strip(a), strip(b)) && b[b.length - 1].ssl_in_use === false, detail: `${a.length} results ${same(strip(a), strip(b)) ? 'identical' : `DIFFER ${firstDiff(a, b)}`}; ssl direct ${a[a.length - 1].ssl_in_use}, gated ${b[b.length - 1].ssl_in_use}` };
  });

  await check(2, 'postgres auth through the gate: SCRAM-SHA-256 and md5', async () => {
    const out = [];
    for (const [name, u] of [['scram', scram], ['md5', md5]]) {
      const gg = await gate('postgres', u, pgCodec);
      const c = new pg.Client({ connectionString: gg.url });
      await c.connect();
      const r = await c.query('SELECT current_user AS u');
      out.push(`${name}=${r.rows[0].u}`);
      await c.end();
    }
    const bad = await gate('postgres', scram.replace(/:([^:@/]+)@/, ':wrong@'), pgCodec);
    const c = new pg.Client({ connectionString: bad.url });
    const err = await c.connect().then(() => 'connected', (e) => e.code);
    out.push(`wrong password: ${err}`);
    return { ok: err === '28P01', detail: out.join(', ') };
  });

  await check(5, 'postgres: a lost-answer fault on an UPDATE inside BEGIN … COMMIT lands on COMMIT, and the write is durable', async () => {
    const d = new pg.Client({ connectionString: scram });
    await d.connect();
    await d.query('DROP TABLE IF EXISTS b1_d5; CREATE TABLE b1_d5 (id text PRIMARY KEY, n int); INSERT INTO b1_d5 VALUES ($$k$$, 0)');
    const c = new pg.Client({ connectionString: url });
    c.on('error', () => {});
    await c.connect();
    const f = g.fault({ method: 'UPDATE', path: 'b1_d5', nth: 1, kind: 'commit_then_reset' });
    await c.query('BEGIN');
    const u = await c.query("UPDATE b1_d5 SET n = 1 WHERE id = 'k'");
    const before = (await d.query("SELECT n FROM b1_d5 WHERE id = 'k'")).rows[0].n;
    const commitErr = await c.query('COMMIT').then(() => 'answered', (e) => e.message);
    const hit = await f.waitHit(3000);
    const after = (await d.query("SELECT n FROM b1_d5 WHERE id = 'k'")).rows[0].n;
    // A rolled-back transaction is not a trial.
    const c2 = new pg.Client({ connectionString: url });
    c2.on('error', () => {});
    await c2.connect();
    const f2 = g.fault({ method: 'UPDATE', path: 'b1_d5', nth: 1, kind: 'commit_then_reset' });
    await c2.query('BEGIN');
    await c2.query("UPDATE b1_d5 SET n = 2 WHERE id = 'k'");
    await c2.query('ROLLBACK');
    const hit2 = await f2.waitHit(500);
    const usable = (await c2.query('SELECT 1 AS one')).rows[0].one;
    await c2.end();
    await d.query('DROP TABLE b1_d5');
    await d.end();
    const ok = u.rowCount === 1 && before === 0 && commitErr !== 'answered' && hit?.wire?.deferred?.outcome === 'committed' && after === 1 && hit2 === null && /not committed/.test(f2.why ?? '') && usable === 1;
    return { ok, detail: `UPDATE answered rowCount ${u.rowCount}; not visible before COMMIT (n=${before}); COMMIT -> "${commitErr}"; deferred ${JSON.stringify(hit?.wire?.deferred)}; durable after (n=${after}); rollback case: hit ${hit2 ? 'yes' : 'no'}, why "${f2.why}"` };
  });

  await check(6, 'postgres: node-postgres keeps the pooled connection usable after an error injected mid-transaction', async () => {
    const d = new pg.Client({ connectionString: scram });
    await d.connect();
    await d.query('DROP TABLE IF EXISTS b1_d6; CREATE TABLE b1_d6 (id text PRIMARY KEY, n int); INSERT INTO b1_d6 VALUES ($$k$$, 0)');
    const pool = new pg.Pool({ connectionString: url, max: 1 });
    pool.on('error', () => {});
    const notes = [];
    // A: error, then ROLLBACK (the usual code path).
    g.fault({ method: 'UPDATE', path: 'b1_d6', nth: 1, kind: 'status' });
    let cl = await pool.connect();
    const pid1 = (await cl.query('SELECT pg_backend_pid() AS p')).rows[0].p;
    await cl.query('BEGIN');
    await cl.query("INSERT INTO b1_d6 VALUES ('a', 1)");
    const eA = await cl.query("UPDATE b1_d6 SET n = 9 WHERE id = 'k'").then(() => 'ok', (e) => e.code);
    const nextA = await cl.query('SELECT 1').then(() => 'ok', (e) => e.code);
    await cl.query('ROLLBACK');
    cl.release();
    notes.push(`A: UPDATE -> ${eA}, next statement -> ${nextA}, ROLLBACK ok`);
    // B: error, then COMMIT: answered ROLLBACK, nothing committed.
    g.fault({ method: 'UPDATE', path: 'b1_d6', nth: 1, kind: 'status' });
    cl = await pool.connect();
    const pid2 = (await cl.query('SELECT pg_backend_pid() AS p')).rows[0].p;
    await cl.query('BEGIN');
    await cl.query("INSERT INTO b1_d6 VALUES ('b', 1)");
    const eB = await cl.query("UPDATE b1_d6 SET n = 9 WHERE id = 'k'").then(() => 'ok', (e) => e.code);
    const commitB = await cl.query('COMMIT').then((r) => r.command, (e) => e.code);
    cl.release();
    notes.push(`B: UPDATE -> ${eB}, COMMIT -> ${commitB}`);
    // C: outside a transaction, then the pool goes on.
    g.fault({ method: 'UPDATE', path: 'b1_d6', nth: 1, kind: 'status' });
    const eC = await pool.query("UPDATE b1_d6 SET n = 9 WHERE id = 'k'").then(() => 'ok', (e) => e.code);
    const after = await pool.query("SELECT count(*)::int AS c, pg_backend_pid() AS p, (SELECT n FROM b1_d6 WHERE id = 'k') AS n FROM b1_d6 WHERE id IN ('a', 'b')");
    const row = after.rows[0];
    const real = await d.query("SELECT count(*)::int AS c FROM b1_d6 WHERE id IN ('a', 'b')");
    notes.push(`C: UPDATE -> ${eC}; afterwards the pool's query answers (rows a/b ${row.c}, n ${row.n}); one backend connection throughout: ${pid1 === pid2 && pid2 === row.p}`);
    await pool.end();
    await d.query('DROP TABLE b1_d6');
    await d.end();
    const ok = eA === 'XX000' && nextA === '25P02' && eB === 'XX000' && commitB === 'ROLLBACK' && eC === 'XX000' && row.c === 0 && row.n === 0 && real.rows[0].c === 0 && pid1 === pid2 && pid2 === row.p;
    return { ok, detail: notes.join('; ') };
  });

  await check(7, 'postgres latency: 2000 sequential statements and 1500 pairs, direct vs gated', async () => {
    const t = async (u) => {
      const c = new pg.Client({ connectionString: u });
      await c.connect();
      const ms = [];
      for (let i = 0; i < 2000; i++) {
        const s = performance.now();
        await c.query(i % 2 ? 'SELECT $1::int AS x' : 'SELECT 1', i % 2 ? [i] : undefined);
        ms.push(performance.now() - s);
      }
      await c.end();
      ms.sort((x, y) => x - y);
      return { p50: ms[1000], p99: ms[1980], mean: ms.reduce((x, y) => x + y, 0) / ms.length };
    };
    const pairs = async (u) => {
      const s = new pg.Client({ connectionString: scram });
      await s.connect();
      await s.query('DROP TABLE IF EXISTS b1_d7; CREATE TABLE b1_d7 (id int PRIMARY KEY, a int, b int); INSERT INTO b1_d7 VALUES (1, 0, 0)');
      const A = new pg.Client({ connectionString: u });
      const B = new pg.Client({ connectionString: u });
      await A.connect();
      await B.connect();
      const st = performance.now();
      for (let i = 0; i < 1500; i++) await Promise.all([A.query('UPDATE b1_d7 SET a = $1 WHERE id = 1', [i]), B.query('UPDATE b1_d7 SET b = $1 WHERE id = 1', [i])]);
      const wall = performance.now() - st;
      await A.end();
      await B.end();
      await s.query('DROP TABLE b1_d7');
      await s.end();
      return wall;
    };
    const d = await t(scram);
    const v = await t(url);
    const pd = await pairs(scram);
    const pv = await pairs(url);
    const f = (x) => x.toFixed(3);
    const extra = v.p50 - d.p50;
    return { ok: extra < 2 && pv / pd < 3, detail: `per statement ms direct p50 ${f(d.p50)} p99 ${f(d.p99)} | gated p50 ${f(v.p50)} p99 ${f(v.p99)} (added p50 ${f(extra)}); 1500 pairs: direct ${(pd / 1000).toFixed(2)} s, gated ${(pv / 1000).toFixed(2)} s (x${(pv / pd).toFixed(2)})` };
  });
}

// ---------- Redis ----------

async function redisOpsNode(c, p) {
  const out = [];
  const rec = async (f) => {
    try {
      out.push(await f());
    } catch (e) {
      out.push({ error: String(e.message).split(' ')[0] });
    }
  };
  for (let i = 0; i < 300; i++) {
    const k = `${p}:k${i % 15}`;
    switch (i % 7) {
      case 0: await rec(() => c.set(k, `v${i}`)); break;
      case 1: await rec(() => c.get(k)); break;
      case 2: await rec(() => c.incr(`${p}:n`)); break;
      case 3: await rec(async () => [await c.hSet(`${p}:h${i % 5}`, `f${i % 3}`, `v${i}`), await c.hGetAll(`${p}:h${i % 5}`)]); break;
      case 4: await rec(() => c.multi().set(k, `m${i}`).incr(`${p}:n`).get(k).exec()); break;
      case 5: await rec(() => c.del(k)); break;
      case 6: await rec(async () => [await c.lPush(`${p}:l`, `x${i}`), await c.lRange(`${p}:l`, 0, 3)]); break;
    }
  }
  await rec(() => c.incr(k0(p)));
  for (const k of await c.keys(`${p}:*`)) await c.del(k);
  return out;
}
const k0 = (p) => `${p}:k0`;

async function redisOpsIo(c, p) {
  const out = [];
  for (let r = 0; r < 6; r++) {
    const pl = c.pipeline();
    for (let i = 0; i < 50; i++) {
      const k = `${p}:k${i % 9}`;
      if (i % 4 === 0) pl.set(k, `v${r}-${i}`);
      else if (i % 4 === 1) pl.get(k);
      else if (i % 4 === 2) pl.incr(`${p}:n`);
      else pl.hset(`${p}:h`, `f${i % 3}`, `${r}`);
    }
    out.push((await pl.exec()).map(([e, v]) => (e ? { error: String(e.message).split(' ')[0] } : v)));
    out.push(await c.multi().incr(`${p}:n`).get(`${p}:k1`).exec());
  }
  out.push(await c.eval("return redis.call('INCR', KEYS[1])", 1, `${p}:n`));
  for (const k of await c.keys(`${p}:*`)) await c.del(k);
  return out;
}

async function redisChecks() {
  const u = env('REDIS_URL');
  const acl = env('REDIS_ACL_URL');
  const { g, url } = await gate('redis', u, redisCodec);
  await check(1, 'redis / node-redis v5 with RESP3 (HELLO 3): 300 mixed commands identical direct and gated', async () => {
    const mk = async (x) => {
      const c = createClient({ url: x, RESP: 3 });
      c.on('error', () => {});
      await c.connect();
      return c;
    };
    const d = await mk(u);
    const v = await mk(url);
    const m0 = g.mark();
    const a = await redisOpsNode(d, 'b1');
    const b = await redisOpsNode(v, 'b1');
    const log = await g.since(m0);
    await (d.close ? d.close() : d.quit());
    await (v.close ? v.close() : v.quit());
    return { ok: same(a, b) && !log.some((r) => r.method === '?') && log.some((r) => r.method === 'HELLO' && r.status === 200), detail: `${a.length} results ${same(a, b) ? 'identical' : `DIFFER ${firstDiff(a, b)}`}; gate logged ${log.length} commands, ${log.filter((r) => r.mutating).length} writes; HELLO ${log.find((r) => r.method === 'HELLO')?.wire?.reply}` };
  });
  await check(1, 'redis / ioredis (RESP2, pipelines of 50, MULTI, EVAL): identical direct and gated', async () => {
    const d = new IORedis(u, { lazyConnect: true });
    const v = new IORedis(url, { lazyConnect: true });
    await d.connect();
    await v.connect();
    const m0 = g.mark();
    const a = await redisOpsIo(d, 'b1io');
    const b = await redisOpsIo(v, 'b1io');
    const log = await g.since(m0);
    d.disconnect();
    v.disconnect();
    return { ok: same(a, b) && !log.some((r) => r.method === '?'), detail: `${a.length} results ${same(a, b) ? 'identical' : `DIFFER ${firstDiff(a, b)}`}; gate logged ${log.length} commands; EVAL uncertain: ${!!log.find((r) => r.method === 'EVAL')?.wire?.uncertain}` };
  });
  await check(2, 'redis auth through the gate: requirepass (default user) and an ACL user; a wrong password is refused', async () => {
    const out = [];
    for (const [name, x] of [['default', u], ['acl', acl]]) {
      const gg = await gate('redis', x, redisCodec);
      const c = createClient({ url: gg.url, RESP: 3 });
      c.on('error', () => {});
      await c.connect();
      out.push(`${name}=${await c.sendCommand(['ACL', 'WHOAMI'])}`);
      await (c.close ? c.close() : c.quit());
    }
    const bad = await gate('redis', u.replace(/:([^:@/]*)@/, ':wrong@'), redisCodec);
    const io = new IORedis(bad.url, { lazyConnect: true, retryStrategy: () => null, maxRetriesPerRequest: 0 });
    io.on('error', () => {});
    const err = await io.connect().then(() => 'connected', (e) => String(e.message).split(' ')[0]);
    io.disconnect();
    out.push(`wrong password: ${err}`);
    return { ok: out[0] === 'default=default' && out[1] === 'acl=b1u' && /WRONGPASS/.test(err), detail: out.join(', ') };
  });
  await check(7, 'redis latency: 2000 sequential GETs, direct vs gated', async () => {
    const t = async (x) => {
      const c = new IORedis(x);
      const ms = [];
      for (let i = 0; i < 2000; i++) {
        const s = performance.now();
        await c.get('b1:none');
        ms.push(performance.now() - s);
      }
      c.disconnect();
      ms.sort((p, q) => p - q);
      return ms;
    };
    const d = await t(u);
    const v = await t(url);
    const f = (x) => x.toFixed(3);
    return { ok: v[1000] - d[1000] < 2, detail: `ms direct p50 ${f(d[1000])} p99 ${f(d[1980])} | gated p50 ${f(v[1000])} p99 ${f(v[1980])}` };
  });
}

// ---------- MongoDB ----------

async function mongoOps(client, coll, rs) {
  const c = client.db('b1').collection(coll);
  await c.drop().catch(() => {});
  const out = [];
  const rec = async (f) => {
    try {
      out.push(await f());
    } catch (e) {
      out.push({ error: e.code ?? e.message });
    }
  };
  for (let i = 0; i < 200; i++) {
    const _id = `k${i % 20}`;
    switch (i % 7) {
      case 0: await rec(() => c.insertOne({ _id, n: i, tags: ['a', `b${i}`] })); break;
      case 1: await rec(() => c.updateOne({ _id }, { $inc: { n: 1 }, $set: { t: `u${i}` } })); break;
      case 2: await rec(() => c.findOne({ _id })); break;
      case 3: await rec(() => c.aggregate([{ $group: { _id: null, s: { $sum: '$n' }, c: { $sum: 1 } } }]).toArray()); break;
      case 4: await rec(() => c.bulkWrite([{ updateOne: { filter: { _id }, update: { $set: { b: i } } } }, { insertOne: { document: { _id: `b${i}` } } }])); break;
      case 5: await rec(() => c.findOneAndUpdate({ _id }, { $inc: { n: 10 } }, { returnDocument: 'after' })); break;
      case 6: await rec(() => c.deleteOne({ _id, n: { $gt: 100 } })); break;
    }
    if (rs && i % 25 === 0) {
      const s = client.startSession();
      await rec(() => s.withTransaction(async () => {
        await c.updateOne({ _id }, { $inc: { n: 100 } }, { session: s });
        await c.insertOne({ _id: `tx${i}` }, { session: s });
      }).then(() => 'committed'));
      await s.endSession();
    }
  }
  await rec(() => c.find({}).sort({ _id: 1 }).toArray());
  await c.drop();
  // why: bulkWrite and insert results carry driver objects; JSON form is what is compared.
  return JSON.parse(JSON.stringify(out));
}

async function mongoChecks() {
  for (const [label, u, rs] of [['standalone (SCRAM)', env('MONGO_URL'), false], ['single-node replica set', env('MONGO_RS_URL'), true]]) {
    const { g, url } = await gate('mongodb', u, mongoCodec());
    await check(1, `mongodb / official driver 6, ${label}: 200 mixed operations${rs ? ' and transactions' : ''} identical direct and gated`, async () => {
      const directUrl = u.includes('directConnection') ? u : `${u}${u.includes('?') ? '&' : '?'}directConnection=true`;
      const d = new MongoClient(directUrl, { serverSelectionTimeoutMS: 5000 });
      const v = new MongoClient(url, { serverSelectionTimeoutMS: 5000 });
      await d.connect();
      await v.connect();
      const m0 = g.mark();
      const a = await mongoOps(d, 'b1_m', rs);
      const b = await mongoOps(v, 'b1_m', rs);
      const log = await g.since(m0);
      await d.close();
      await v.close();
      const h = logHealth({ log });
      return { ok: same(a, b) && h.lost === 0, detail: `${a.length} results ${same(a, b) ? 'identical' : `DIFFER ${firstDiff(a, b)}`}; gate logged ${log.length} messages, ${log.filter((r) => r.mutating).length} writes, ${h.lost} framing losses; uncertain: ${JSON.stringify(h.uncertain)}` };
    });
    if (!rs) {
      await check(2, 'mongodb auth through the gate: SCRAM-SHA-256 and SCRAM-SHA-1; a wrong password is refused', async () => {
        const out = [];
        for (const mech of ['SCRAM-SHA-256', 'SCRAM-SHA-1']) {
          const c = new MongoClient(`${url}&authMechanism=${mech}`, { serverSelectionTimeoutMS: 5000 });
          await c.connect();
          const st = await c.db('admin').command({ connectionStatus: 1 });
          out.push(`${mech}=${st.authInfo.authenticatedUsers[0]?.user}`);
          await c.close();
        }
        const bad = await gate('mongodb', u.replace(/:([^:@/]+)@/, ':wrong@'), mongoCodec());
        const c = new MongoClient(bad.url, { serverSelectionTimeoutMS: 3000 });
        const err = await c.connect().then(() => 'connected', (e) => e.codeName ?? e.name);
        await c.close().catch(() => {});
        out.push(`wrong password: ${err}`);
        return { ok: out[0] === 'SCRAM-SHA-256=root' && out[1] === 'SCRAM-SHA-1=root' && /AuthenticationFailed|MongoServerError/.test(err), detail: out.join(', ') };
      });
    } else {
      // Informational (not a §7 item of this lane): what a real retryable write does after a lost answer.
      await check('4i', 'mongodb replica set: a lost answer to updateOne($inc) — driver retry and server de-duplication', async () => {
        const c = new MongoClient(url, { serverSelectionTimeoutMS: 5000, retryWrites: true });
        await c.connect();
        const col = c.db('b1').collection('b1_retry');
        await col.deleteMany({});
        await col.insertOne({ _id: 'r', n: 0 });
        const m0 = g.mark();
        const f = g.fault({ method: 'update', path: 'b1.b1_retry', nth: 1, kind: 'commit_then_reset' });
        const r = await col.updateOne({ _id: 'r' }, { $inc: { n: 1 } }).then((x) => `answered modified ${x.modifiedCount}`, (e) => `error ${e.name}`);
        const hit = await f.waitHit(2000);
        const n = (await col.findOne({ _id: 'r' })).n;
        const sent = (await g.since(m0)).filter((x) => x.method === 'update').length;
        await col.drop();
        await c.close();
        return { ok: n === 1, detail: `${r}; fault hit ${!!hit}; update sent ${sent} time(s); n = ${n} (1 means applied once)` };
      });
    }
  }
}

const which = (process.argv[2] ?? 'all').split(',');
try {
  if (which.includes('all') || which.includes('postgres')) await postgresChecks();
  if (which.includes('all') || which.includes('redis')) await redisChecks();
  if (which.includes('all') || which.includes('mongodb')) await mongoChecks();
} finally {
  for (const g of gates) await g.stop().catch(() => {});
}
console.log(`\nSUMMARY ${results.length - failures} pass, ${failures} fail`);
process.exit(failures);
