# Wire gate (B1) and database control arm (B2, outline)

Status: B1 design and first implementation (Postgres, Redis, MongoDB). B2 is outlined in §9 and not built.

Sources: `research-rating/B-GAP.md` §2b and §5; `company-audit/research/batch-runs/DATA-CAPTURE-SPEC.md` Phase 3 (B1, B2, B12); `COVERAGE-GAPS.md` §2a "B1 design notes" and §4.

## 1. What it is for

The backend gate interposes on the hop between the server under test and its backend, so that a check can:

| Capability | Used by | HTTP gate (today) | Wire gate (this doc) |
|---|---|---|---|
| (a) hold one named backend request until released | MWS-CONC-3 held request, MWS-CONC-1 proxy form | yes | yes |
| (b) let a write commit and then lose its answer | MWS-RES-2 lost-answer trial, MWS-RETRY-2 proxy step and crash form | yes | yes, at the commit point (§5.3) |
| (c) fail one named backend request without forwarding it | MWS-RES-2 provoked fault, MWS-ATOM-1/2 proxy positions | yes | yes, in the protocol's own error form |
| (d) name requests as write or read | the learning pass (`lastMutating`, `nthOf`) | HTTP method | classifier per protocol (§4), unknown counts as a write |

Database drivers open raw TCP sockets (`net.Socket`), never `fetch`, so the `node_import` hook cannot see them, and `assertEgress` refused any non-HTTP scheme (`src/core/egress.ts:113` before this change). The wire gate is a loopback TCP listener in the CLI process that the server is pointed at in place of its database.

## 2. Manifest

No new key. The protocol is chosen by the scheme of the URL that `backend.gate.rewrite_env` names in the tester's environment:

| Scheme in the tester's value | Gate | Default port | Rewrite given to the server |
|---|---|---|---|
| `http:` / `https:` | HTTP forwarder (unchanged) | 80 / 443 | `http://127.0.0.1:<port>/<path>` |
| `postgres:` / `postgresql:` | wire gate, Postgres v3 | 5432 | same URL, host:port replaced |
| `redis:` | wire gate, RESP2/RESP3 | 6379 | same URL, host:port replaced |
| `mongodb:` | wire gate, OP_MSG | 27017 | same URL, host:port replaced, `directConnection=true` added |

```yaml
backend:
  gate: { rewrite_env: DATABASE_URL }          # postgres://user:pw@b0:5432/mwsc
  # gate: { rewrite_env: REDIS_URL }           # redis://b0:6379/0
  # gate: { rewrite_env: MDB_MCP_CONNECTION_STRING }   # mongodb://b0:27017/mwsc
```

The rewrite keeps scheme, credentials, database and query and replaces only the authority. Refused at gate construction (exit 2, with the reason), because the gate could not interpose faithfully:

- `rediss:`, Postgres `sslmode=require|verify-ca|verify-full`, Mongo `tls=true`/`ssl=true`: upstream TLS is not built in this preview. In-job databases do not use TLS.
- `mongodb+srv:` and any multi-host authority (`h1,h2`): SRV and seed-list discovery would let the driver connect around the gate.
- Unix-socket hosts.

The gate answers `N` to a Postgres SSLRequest and GSSENCRequest itself, so a client with the default `sslmode=prefer` (libpq) or no SSL (node-postgres) proceeds in plaintext to the gate.

Not built here, needed for t09 (URL in argv): an argv route (`rewrite_arg: N`). That touches `src/core/session.ts` (argv rewrite) and the plan (B9); it is listed in §8.

Also refused: Postgres `host=`, `hostaddr=`, `port=` or `service=` in the query, and a server given `PGHOSTADDR`, `PGSERVICE` or `PGSERVICEFILE` (each would route libpq around the gate); Mongo `compressors=` and `loadBalanced=true`.

Egress: `assertEgress` takes `{ wire: true }` for the gate's upstream only; the tester's own HTTP client still refuses every non-HTTP scheme, and the gate keeps its upstream on a list of its own (the shared egress list is not changed). `egressFor` now uses the scheme's default port (a `postgres://b0` allow entry is `b0:5432`, not `b0:80`). The upstream connection goes through `vettedLookup` (no metadata address by name or by resolution), as the HTTP forwarder does.

## 3. Architecture

```
server under test ──TCP──▶ 127.0.0.1:<gate> ──TCP──▶ real database (tester's own URL)
                            │
                            ├─ codec session per client connection (framer + classifier + reply tracker)
                            ├─ per-connection queue: units are forwarded in order; a held or barrier unit blocks
                            │  only its own connection (head-of-line); writer B runs on another connection
                            └─ the Gate interface (mark/since/hold/fault/clear), unchanged for the checks
```

Files: `src/gate/wire/proxy.ts` (the `WireGate`, protocol-neutral), `src/gate/wire/codec.ts` (the codec contract), `src/gate/wire/postgres.ts` + `src/gate/wire/sql.ts`, `src/gate/wire/redis.ts`, `src/gate/wire/mongodb.ts` + `src/gate/wire/bson.ts`, `src/gate/wire/url.ts` (scheme, rewrite, refusals).

A **unit** is what the gate logs, holds and faults: the smallest client message group that the backend answers as one.

| Protocol | Unit | Reply ends at |
|---|---|---|
| Postgres | a simple `Query`; or the extended messages (Parse/Bind/Describe/Execute/Close) up to and including `Sync`; or up to `Flush`; or one `FunctionCall` | `ReadyForQuery` (Sync, Query, FunctionCall); for a Flush unit, when every Parse/Bind/Close/Describe/Execute in it is answered, or at the first `ErrorResponse` |
| Redis | one command (RESP array or inline line) | one reply value (attributes `\|` belong to it; RESP3 pushes `>` are out of band) |
| Mongo | one `OP_MSG` (or legacy `OP_QUERY`) | the reply whose `responseTo` is the unit's `requestID`; no reply when the request sets `moreToCome` |

Messages that are not requests (Postgres startup and authentication, `CopyData`/`CopyDone`/`CopyFail`, `Terminate`) are passthrough units: queued in order with the rest, never logged or counted. Server messages that belong to no unit (Postgres `NoticeResponse`/`ParameterStatus`/`NotificationResponse`, authentication, RESP3 pushes, Mongo exhaust continuations) go to the client unbuffered.

Pipelining is kept: a client that sends several units without waiting gets them forwarded without waiting. A unit carrying a `commit_then_*` fault is a **barrier**: nothing after it on that connection is forwarded until its reply is complete, so a cut or swallowed answer affects that unit only.

## 4. Classification (write vs read)

`GateRequest` keeps its HTTP shape so the checks need no new logic: `method` is the verb, `path` the target, `mutating` the classification. New optional field `wire: { protocol, statement, uncertain?, statements?, reply?, txn?, synthetic?, note?, deferred? }`. Framing that is lost mid-connection is logged as a write (`method: '?'`, `wire.uncertain: framing lost …`) and the connection is closed.

**Rule: a unit counts as a write unless the classifier is sure it does not write. When it is unsure it records why in `wire.uncertain`.** A false write makes the learning pass hold or fail a read (the check then reports "the held request changed nothing", never a false `held` of a write); a false read could hide the write that matters, which is the error that produces a false `held` (B-GAP §5 "Wire-gate misframing").

### 4.1 Postgres (`sql.ts`)

A tokenizer that understands `--` and nested `/* */` comments, `'…'` (with `''`), `E'…'` (with backslashes), `"…"` identifiers and `$tag$…$tag$` bodies, splits a Query at top-level `;`, and classifies each statement by its first keyword:

| Statement | Class | `path` |
|---|---|---|
| INSERT, UPDATE, DELETE, MERGE, TRUNCATE, COPY … FROM | write | target table |
| CREATE, ALTER, DROP, GRANT, REVOKE, COMMENT, SECURITY LABEL, IMPORT, REFRESH, SELECT … INTO | write (DDL) | object name when simple |
| `WITH …` | write if any INSERT/UPDATE/DELETE/MERGE keyword occurs anywhere in it (data-modifying CTE), else as its final SELECT | the modified table |
| SELECT, VALUES, TABLE, SHOW, EXPLAIN (without ANALYZE), COPY … TO, FETCH, DECLARE, MOVE, CLOSE | read, **unless** it calls a function not on the read-only list | first FROM table |
| SELECT calling `nextval`/`setval`/`pg_advisory*`/`lo_*`/`dblink*`/`set_config`/`pg_notify`/any unknown function | write, uncertain ("calls f(), which may write") | first FROM table |
| CALL, DO, EXECUTE (of a name not prepared on this connection), FunctionCall (`F`) | write, uncertain ("procedure body not inspected") | procedure name |
| EXPLAIN ANALYZE of a write | write (it executes) | inner target |
| BEGIN/START, COMMIT/END, ROLLBACK/ABORT, SAVEPOINT, RELEASE, SET, RESET, DISCARD, DEALLOCATE, LISTEN, UNLISTEN, NOTIFY, PREPARE, VACUUM, ANALYZE, CHECKPOINT, LOCK, REINDEX, CLUSTER | not a write (transaction control, session state or maintenance: no change to row data) | — |
| anything else | write, uncertain ("unknown statement") | — |

Extended protocol: a per-connection map `statement name → classification` (from Parse) and `portal → statement` (from Bind); each Execute is classified by its portal; a unit is a write if any Execute in it is. `PREPARE n AS …` / `EXECUTE n` are tracked the same way. An Execute of an unknown portal is a write, uncertain. A unit with several statements takes the verb and table of its first write and records `statements: n`.

`wire.statement` keeps the SQL with every literal replaced by `?` and cut to 200 characters (values written are never logged; `ErrorResponse` is reduced to its SQLSTATE; SET and RESET keep the setting's name only). `COPY (query) TO` takes the class of its query. A function call in a read is trusted only if it is on the read-only list and unqualified or in `pg_catalog`. `DECLARE … CURSOR FOR q` runs nothing; FETCH and MOVE on that cursor take the class of q. `standard_conforming_strings` is read from the backend's ParameterStatus: when off, a backslash escapes a quote inside '…'.

### 4.2 Redis

Command tables from the Redis command flags: about 110 write commands (SET, DEL, HSET, EXPIRE, LPUSH, ZADD, XADD, BITOP, FLUSHDB, …), about 90 read commands, and control (PING, AUTH, HELLO, SELECT, CLIENT, MULTI/EXEC/DISCARD, WATCH/UNWATCH, SUBSCRIBE…, INFO, COMMAND). EVAL/EVALSHA/FCALL are writes, uncertain ("script body not inspected"); their `_RO` forms are reads. SORT with STORE, GEORADIUS(BYMEMBER) with STORE/STOREDIST are writes. Two-word admin commands are read by subcommand (CONFIG GET is a read; CONFIG SET is a write, uncertain). Unknown commands (module commands such as `JSON.SET` are listed; others are not) are writes, uncertain. `path` is the first key (EVAL family: the first key after `numkeys`; BITOP: the destination). Arguments are never logged except the key; AUTH and HELLO record no arguments at all.

After SUBSCRIBE/PSUBSCRIBE/SSUBSCRIBE on RESP2, or MONITOR, the connection becomes passthrough (its replies are no longer one per command).

### 4.3 MongoDB

The first key of the `OP_MSG` body (kind-0 section) names the command; `path` is `<$db>.<collection>` when the first value is a string.

| Command | Class |
|---|---|
| insert, update, delete, findAndModify/findandmodify, bulkWrite, create, drop, dropDatabase, createIndexes, dropIndexes, renameCollection, collMod, applyOps, createUser/updateUser/dropUser and role commands | write |
| aggregate whose pipeline has `$out` or `$merge`; mapReduce with `out` other than `{inline: 1}` | write |
| find, getMore, count, distinct, aggregate (otherwise), listCollections, listIndexes, listDatabases, hello/isMaster, ping, buildInfo, saslStart/saslContinue, endSessions, killCursors, explain, dbStats, collStats, serverStatus, getParameter, connectionStatus | read |
| commitTransaction, abortTransaction, startSession, refreshSessions | transaction control |
| unknown commands; `OP_COMPRESSED` (body not inspected); legacy `OP_INSERT`/`OP_UPDATE`/`OP_DELETE` (certain write) | write, uncertain unless legacy |
| legacy `OP_QUERY` of `hello`/`isMaster` on `*.$cmd` (driver handshake) | read |

`OP_MSG` checksums (flag bit 0) are verified only in length; a reply the gate writes never carries one. Run Mongo without wire compression (do not set `compressors`): a compressed unit is a write, uncertain, and its reply cannot be read for an outcome.

## 5. Hold, faults and transactions

### 5.1 Hold

`hold({method, path, nth})` matches the nth unit with that verb and target, counted on arrival from when it was armed (as the HTTP forwarder does). The held unit and everything after it on that connection stay in the gate until release (ceiling 120 s). Nothing has reached the database, so a held `UPDATE` holds no row lock; a held write inside a transaction holds the locks the transaction already took (the scheduler then records "serialized by the server", which is what the database did).

### 5.2 Faults, written in each protocol

| Fault | Postgres | Redis | Mongo |
|---|---|---|---|
| `status` (not forwarded) | `ErrorResponse` (`S ERROR`, `C XX000`, `M injected by the mcp-writecheck gate`) for the unit, then `ReadyForQuery` with the state the backend would report | `-ERR injected by the mcp-writecheck gate` | `OP_MSG` `{ok: 0, code: 1, codeName: "InternalError", errmsg}` with `responseTo` |
| `commit_then_status` | forward, wait for the whole reply, replace it with the above | same | same |
| `commit_then_reset` | forward, wait for the whole reply, drop it, destroy both sockets | same | same |
| `commit_then_hang` | forward, wait for the whole reply, drop it, keep the socket open until the server goes away (ceiling 120 s) | same | same |

Every injected answer sets `wire.synthetic: true` on the record (B-GAP §5 "Gate artefacts": a forced error the real backend never sends has no production path, and the record must say the fault was synthetic).

The gate keeps the client and the database in step after an injected error, where the protocol would otherwise diverge:

- **Postgres, inside a transaction.** The backend never saw the failed unit and is still `T`, while the client was told `E`. The connection enters *emulated-failed* mode: any unit except ROLLBACK/ABORT/ROLLBACK TO/COMMIT/END is answered with `25P02 current transaction is aborted` and not forwarded; ROLLBACK, ABORT and ROLLBACK TO are forwarded as they are (leaving the mode); COMMIT/END is replaced by a `ROLLBACK` sent to the backend and answered to the client as Postgres answers a COMMIT of a failed transaction (`CommandComplete ROLLBACK`, `ReadyForQuery I`).
- **Postgres, Flush unit.** The backend would skip everything up to the next Sync after an error; the gate answers those units itself (nothing, then `ReadyForQuery`) without forwarding them.
- **Redis, inside MULTI.** Real Redis discards the transaction at EXEC after a queueing error. The gate replaces the EXEC with DISCARD and answers `-EXECABORT Transaction discarded because of previous errors.`
- **Mongo, inside a transaction:** not emulated in this preview, so the gate does not inject the error: the request goes on as it is and `FaultHandle.why` says so (the check records `not tested`). Transactions need a replica set (C1) anyway.

**Ordering.** An answer the gate writes (an injected error, or an emulated one) waits until every unit already forwarded on that connection is answered, so a pipelining client gets the answers in order, and the transaction state an injected error is judged by is the backend's after them (MULTI state in Redis is taken from the backend's answers, never from what the client sent). A barrier (a unit carrying a `commit_then_*` fault, or one whose answer the gate replaces) lets pass-through units go on while it waits (COPY data the backend needs before it can answer). Both waits have a ceiling (60 s): after it the gate logs an uncertain write and closes the connection. Any error inside the gate (framing or otherwise) closes that connection and is logged; it never reaches the CLI.

### 5.3 The commit point (lost answer)

The lost-answer trial needs the write to be **committed** before the answer is lost. With autocommit the write's own unit is the commit point. Inside an explicit transaction it is not: an `UPDATE`'s `CommandComplete` under `BEGIN` commits nothing, and cutting it would test a rolled-back write.

So a `commit_then_*` fault that hits a write inside a transaction is **deferred**: the write's own answer is delivered, and the fault is applied to the unit that ends the transaction, if that unit commits it (Postgres: `ReadyForQuery` goes from `T` to `I` with a `COMMIT` tag and no `ROLLBACK` or `PREPARE TRANSACTION` tag; Redis: EXEC answered with an array; Mongo: `commitTransaction` answered `ok: 1` on the same `lsid`). The faulted record is the write (so `nthOf`, the res2u "sent the cut request again" check and the report name the UPDATE), with `wire.deferred = { to: <seq of the commit>, outcome: 'committed' | 'not committed' }` and `status: null`.

**A lost-answer fault is a trial only of a write that was carried out and kept.** The gate does not apply it, delivers the real answer, never resolves `waitHit`, and sets `FaultHandle.why` (the checks put it in the `not tested` reason) when: the write itself was refused (status ≥ 400); the unit undid its own change (a ROLLBACK, ROLLBACK TO or PREPARE TRANSACTION tag); the transaction was not committed (ROLLBACK, a COMMIT answered ROLLBACK, PREPARE TRANSACTION, a Redis EXEC aborted by WATCH, a failed commitTransaction); a ROLLBACK TO SAVEPOINT came after the write; the write's own element of the EXEC answer is an error; the request expects no answer (moreToCome); or the connection closed first.

The hold (CONC-3) is not deferred: it holds the write statement itself, before the database sees it, which is the interleaving the requirement is about. A hold on COMMIT would only show that row locks serialize writers.

### 5.4 Status equivalence

The checks read `GateRequest.status` with HTTP meanings (2xx done, 4xx refused and settled, 5xx and `null` unknown). The wire gate maps:

| Outcome | status |
|---|---|
| Postgres: no ErrorResponse in the unit; Redis: any non-error reply; Mongo: `ok: 1` without `writeErrors`/`writeConcernError` | 200 |
| Mongo `ok: 1` with `writeConcernError` (applied on the primary, durability unknown) | 202 |
| Postgres ErrorResponse with any SQLSTATE except the classes below; Redis `-ERR`/`-WRONGTYPE`/…; Mongo `ok: 0` or `writeErrors` | 400 (the backend refused: settled, not applied) |
| Postgres SQLSTATE class 08, 53, 57, 58, XX; Redis `-LOADING`/`-BUSY`/`-READONLY`/`-MASTERDOWN`/`-CLUSTERDOWN`/`-TRYAGAIN`; Mongo NotWritablePrimary-family codes, shutdown and network codes | 503 |
| answer injected by the gate | the FaultSpec status (default 500), `wire.synthetic: true` |
| cut or swallowed | `null` |

`wire.reply` carries the protocol's own answer class, for the settled-outcome answers (spec RES-2: "for a backend that does not answer in HTTP, only the answers that the declaration lists report that a request was carried out or refused"): `CommandComplete UPDATE 1`, `ErrorResponse 23505`, `+OK`, `:1`, `-WRONGTYPE`, `ok:1 n:1`, `ok:1 writeErrors 11000`.

## 6. Plumbing changes outside `src/gate/wire/`

- `src/core/egress.ts`: `assertEgress(url, policy, { wire: true })`; default ports per scheme in `hostAllowed` and `egressFor`.
- `src/gate/gate.ts`: `Gate.route` gains `'wire'`; `GateRequest.wire?`; `isMutating(r)` (= `r.mutating` when present, else the HTTP method set); `lastMutating` uses it; `createGate` picks the wire gate by scheme.
- `src/checks/gated.ts`: the ATOM learned-write filter and the R9-1 settled-outcome filter use `isMutating` instead of the HTTP method list; `Req` keeps `mutating`.
- `src/checks/inputrequired.ts` (MWS-RETRY-3, proxy position), `src/checks/multi.ts` (the ATOM trials' learning pass) and `src/checks/creates.ts` (MWS-RES-3's late failure) count writes with `isMutating`. By HTTP method alone they saw no write on the wire gate: the RETRY-3 proxy record said `held` for a server that wrote before input_required, and the other two skipped their trials. `test/integration/wire-gate-retry3.test.ts` runs all three through the Postgres fake.
- Still HTTP-only, by design: the forwarder and the hook gate (their requests are HTTP), and `undoneBy` in `src/checks/idempotency.ts` (MWS-RETRY-2 proxy step: a DELETE whose path ends in the object's id). On the wire gate the path is a table, so a server that undoes its first write is not recognised there and the trial is judged on the read-back.

## 7. Tests

No Docker and no database here. Proven in-process:

- **Codec unit tests** on synthetic frames built byte by byte from the protocol specifications: framing across arbitrary chunk splits (every byte boundary for a pipelined stream), classification tables, literal stripping, BSON round trips, reply-boundary detection (Postgres Sync/Flush/error-skip, RESP3 nesting and attributes, Mongo `responseTo`/`moreToCome`).
- **Proxy tests** against a minimal in-process fake server per protocol (a TCP server that speaks just enough of the protocol: Postgres startup + trust auth + simple and extended query with a tiny key/value table and transactions; RESP with GET/SET/DEL/MULTI/EXEC; OP_MSG with hello/find/update/insert and `lsid` transactions), driven by a minimal client written in the test: pass-through, request log, hold-and-release with a second connection finishing first, nth matching, the four faults, deferred commit faults, emulated-failed mode, EXECABORT emulation.

Files: `test/unit/wire-{postgres,redis,mongodb}.test.ts`, `test/integration/wire-gate-{postgres,redis,mongodb}.test.ts`, fakes and clients in `test/wire/{pg,redis,mongo}.ts`. The Mongo fake reuses the gate's BSON writer; the BSON reader is checked against the bsonspec.org vectors.

**Must be verified on the Mac (Docker), not provable here:**

1. Real drivers through the gate, one script per protocol: `pg` (node-postgres, extended protocol), `postgres` (postgres.js, pipelining), `psycopg` (libpq: SSLRequest first); `redis` (node-redis v4, RESP3 via HELLO), `ioredis`; the official `mongodb` driver 6.x (hello handshake, `directConnection`, monitoring connection, `lsid`), on standalone and on a single-node replica set (C1). Each: pass-through of a few hundred mixed statements with byte-identical results versus direct.
2. Real authentication through the gate: Postgres SCRAM-SHA-256 and md5, Redis `requirepass` and ACL, Mongo SCRAM-SHA-256 (all passthrough; must just work).
3. The held request on t08 (Postgres `execute`), t09 (Redis `set`), t13 (Mongo `update-many`): `CONC-3` gives a real verdict; the learned sequence names the right statement (the B-GAP risk list: CTEs, pipelined groups, `aggregate` + `$merge`).
4. The lost-answer trial on each: the driver error the server sees (`Connection terminated unexpectedly`, `ECONNRESET`, Mongo `MongoNetworkError`), and on the replica set the driver's retryable write deduplicated by the server.
5. A Postgres server that wraps writes in `BEGIN … COMMIT`: the deferred fault lands on COMMIT and the write is durable after the cut (read it back directly).
6. Injected `ErrorResponse` mid-transaction with node-postgres: the pool keeps the connection usable (emulated-failed mode), or record what the driver does.
7. Timing: the gate's added latency on a few thousand statements (a pair budget of 2 × 1500 goes through it).

## 8. Not built in this preview (follow-ups)

- Argv rewrite (`rewrite_arg`) for servers that take the URL as an argument (t09); `session.ts` and the plan (B9).
- Upstream TLS (Postgres SSLRequest upstream, `rediss:`, Mongo `tls=true`).
- Mongo transaction emulation after an injected error; OP_COMPRESSED decompression (zlib is in Node; snappy and zstd are not).
- Redis `CLIENT REPLY OFF|SKIP`, RESP2 pub/sub multiplexed with commands (handled as passthrough).
- Postgres replication protocol, `COPY BOTH`, and the `pipeline` mode of libpq 14+ with several Syncs in flight across an injected error (each Sync unit is handled; not proven against libpq).
- The manifest keys the settled-outcome declaration needs (`backend.gate.answers`: which `wire.reply` classes count as carried out or refused), and the report text for `wire.synthetic`.

## 9. B2: database control arm (outline only, not implemented)

**Purpose.** A control arm sends the same forced schedule straight to the platform, bypassing the server, so a loss can be attributed: `platform` when the platform's own default write loses too, `violated (server)` when only the server's path does. Without it every database loss is `violated (unresolved)`, which the rating reads as confirmed (B-GAP §2b, §5). It also records CONC-1 `not applicable` honestly (the platform's default write makes no refusing check) and CONC-2 rows 2 and 3 for tools without a version, and raises CONC-5.

**Unlocks** (COVERAGE-GAPS §2a): CONC-1, CONC-2 rows 2/3, CONC-5; attribution upgrades on UPD-1, UPD-2, CONC-3, TGT-1, TGT-3, RES-1.

**Manifest.**

```yaml
control:
  wire:
    url_env: DATABASE_URL              # the tester's own value; the same upstream the gate forwards to
    read:   { sql: "SELECT id, title, status, version FROM mwsc_items WHERE id = $1", params: ["{{id}}"], row: 0 }
    patch:  { sql: "UPDATE mwsc_items SET {{field:ident}} = $1 WHERE id = $2", params: ["{{value}}", "{{id}}"] }
    write:  { sql: "UPDATE mwsc_items SET title = $1, status = $2 WHERE id = $3", params: ["{{obj.title}}", "{{obj.status}}", "{{id}}"] }
    write_if_version: { sql: "… WHERE id = $3 AND version = $4", params: [...], refused_when: { rows: 0 } }
    delete: { sql: "DELETE FROM mwsc_items WHERE id = $1", params: ["{{id}}"] }
    create: { sql: "INSERT …", params: [...] }
  # redis: { read: [GET, "{{id}}"], write: [SET, "{{id}}", "{{json:object}}"], write_if_version: WATCH/MULTI/EXEC form }
  # mongodb: { read: { find: mwsc_items, filter: { _id: "{{id}}" } }, patch: { update: mwsc_items, updates: [ { q: { _id: "{{id}}" }, u: { $set: { "{{field}}": "{{value}}" } } } ] } }
```

The protocol comes from the URL scheme, as for the gate. Postgres statements always go as extended-protocol Parse/Bind with parameters (no value is ever spliced into SQL text; identifiers only through `{{field:ident}}`, checked against the declared field paths). The defaults the arm sends must be the platform's own default write (a plain `UPDATE`, `SET`, `updateMany`/`$set`), so the arm measures the platform, not a shim (COVERAGE-GAPS C6 is the shim alternative and stays a stopgap).

**Design.**

- New `src/core/wirecontrol.ts`: a small client per protocol, reusing the B1 codecs for framing and reply parsing. Each implements the existing control interface (`controlRead`, `controlPatch`, `controlWrite`, `controlCreate`, `controlDelete`) that `driver.ts` dispatches through `hasControl`, so `stale.ts`, `pairs.ts`, `gated.ts`, `creates.ts` and `targeting.ts` need only the dispatch change.
- Authentication it must do itself (the gate only passes it through): Postgres trust, md5 and SCRAM-SHA-256 (`node:crypto`: PBKDF2, HMAC); Redis AUTH (password and ACL user); Mongo SCRAM-SHA-256 and SCRAM-SHA-1. No dependency added.
- Status mapping as §5.4, so `p.status === 409 || 412` style checks get an equivalent: a `write_if_version` that matches zero rows (Postgres `UPDATE 0`, Mongo `n: 0`, Redis EXEC nil after WATCH) is reported as 412.
- Egress: the arm connects only to the upstream already on the list for the gate, through `vettedLookup`. It never goes through the gate (its traffic must not be counted, held or faulted).
- The record names the arm's statements with literals stripped (§4.1) and states that the arm's default write is the platform default.

**Order.** After B1 lands and items 1–4 of §7 are verified on the Mac. B12 (update-operator keys in `list_edit`) is independent of B2 and can go in parallel.

**Tests.** Same split as B1: codec-level and fake-server tests here (including SCRAM against RFC 7677 test vectors), real databases on the Mac.
