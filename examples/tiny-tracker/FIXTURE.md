# tiny-tracker as a shared write-safety fixture

**Status: draft, in development.** This page describes the fixture interface that tiny-tracker is growing from 0.2.0 on. Nothing here is in a published release yet: `npx -y @mcp-write-safety/tiny-tracker` still runs 0.1.0, and everything 0.1.0 does is unchanged. Where a part is not built yet, this page says which release builds it. Feedback is welcome (see [Feedback](#feedback)).

tiny-tracker is a teaching server for the MCP Write-Safety Requirements (MWS). As a **shared fixture** it is also a known target that other people's harnesses can run against: one countable side effect per write, a lookup by idempotency key, a committed digest you can verify without trusting us, server-side fault points, and evidence that names the exact build it came from.

## Contents

- [Profiles and features](#profiles-and-features)
- [Starting it](#starting-it)
- [Two namespaces and their tokens](#two-namespaces-and-their-tokens)
- [The build descriptor](#the-build-descriptor)
- [Runs, attribution and reset](#runs-attribution-and-reset)
- [Digests](#digests)
- [Records](#records)
- [Answers on keyed calls](#answers-on-keyed-calls)
- [Clock, commits and keys](#clock-commits-and-keys)
- [Defects, placement and the compatibility table](#defects-placement-and-the-compatibility-table)
- [Fault points](#fault-points)
- [Transports, the container and caps](#transports-the-container-and-caps)
- [Known answers and reproducibility](#known-answers-and-reproducibility)
- [Identifiers](#identifiers)
- [Versions and stability](#versions-and-stability)
- [Limits: what a run against this fixture does not show](#limits-what-a-run-against-this-fixture-does-not-show)
- [Feedback](#feedback)

## Profiles and features

A **profile** names a fixed surface.

| Profile | What it is |
|---|---|
| `0.1` | Exactly the surface of the published 0.1.0: `tools/list`, every tool result's text and structured content, the instructions and the first stdout line, for a recorded scenario set (only `serverInfo.version` and result `_meta` excluded). Checked against a transcript captured from the 0.1.0 tarball. Takes no feature. |
| `default` | What runs when no profile is named. From 0.2.0 it turns on each feature a release ships once that release's gate is met: `execution-records`, `lookup` and `principals` from 0.2.0; `inflight` and `retention` from 0.3.0. `durable` stays named, since it needs `--data-dir`; the fixture-layer features stay named, since they need tokens the operator gives. Before 0.2.0 it had the 0.1 surface. |

A **feature** is switched on with `--features a,b` or `TRACKER_FEATURES`. An unknown name, or a feature this version does not build yet, stops the process (exit 2) and says which release builds it.

| Feature | Release | Layer | What it adds |
|---|---|---|---|
| `evidence` | 0.2.0 (stub now) | fixture | The read-only evidence namespace and the build descriptor, mirrored in the MCP instructions and result `_meta`; run and operation tags carried to every backend request |
| `strict-input` | 0.2.0 (built now) | core | The backend checks idempotency keys itself and refuses strings that are not well-formed Unicode |
| `execution-records` | 0.2.0 | core | One execution record per applied write, with served canonical bytes and digest |
| `lookup` | 0.2.0 | core | `GET /operations/:key`; `get_operation` and `get_execution` tools |
| `principals` | 0.2.0 | core | Two or more backend tokens; key records and lookups scoped to the principal |
| `ledger` | 0.2.0 | fixture | The append-only execution ledger |
| `faults` | 0.2.0 | fixture | Server-side fault points, armed on the control listener |
| `durable` | 0.3.0 | core | A journal in `--data-dir` ([decision 0003](docs/decisions/0003-journal-format.md)) |
| `inflight` | 0.3.0 | core | A pending key record; a same-key call meanwhile answers `in_progress` |
| `retention` | 0.3.0 | core | A stated 7-day key retention with tombstones ([decision 0004](docs/decisions/0004-key-retention-and-expiry.md)) |
| `clock` | 0.3.0 | fixture | A fixture clock for retention rehearsals |

**Core** features are part of the teaching server. **Fixture** features, and the control listener, live in `src/fixture`, which the teaching server never imports: the command line loads it with a dynamic import only when one of them is named, and a test proves that profile 0.1 and a build with no fixture feature load no module from it.

## Starting it

Tokens come from the environment, from a file only the owner can read, or from a token folder (`--token-dir DIR`, a 0700 directory where tiny-tracker generates any token you did not supply, as a 0600 file, and prints only the folder's path). They are never accepted on the command line and never printed. The `evidence` feature runs with `tiny-tracker all` only, so one build descriptor covers both layers.

```sh
# a token file for the evidence namespace, readable by you only
umask 077
openssl rand -hex 24 > ~/.tt-evidence.token
export TRACKER_EVIDENCE_TOKEN_FILE=~/.tt-evidence.token

node dist/src/cli.js all --features evidence --port 4600 --backend-port 4601
# {"backend":"http://127.0.0.1:4601","mcp":"http://127.0.0.1:4600/mcp","defects":[],"read_only":false,
#  "profile":"default","features":["evidence"],"evidence":"http://127.0.0.1:4601/build"}

curl -s -H "Authorization: Bearer $(cat ~/.tt-evidence.token)" http://127.0.0.1:4601/build

# the 0.1.0 surface, exactly
node dist/src/cli.js all --profile 0.1
```

## Two namespaces and their tokens

**Evidence (read-only)**, on the backend listener, with the **evidence token** (`TRACKER_EVIDENCE_TOKEN` or `TRACKER_EVIDENCE_TOKEN_FILE`). Only `GET`.

| Path | What it serves | Release |
|---|---|---|
| `GET /build` | The build descriptor; header `Tiny-Tracker-Build: <build_hash>` | stub now |
| `GET /export` | Every project and ticket, as stored | now |
| `GET /ledger` | The execution ledger | 0.2.0 |
| `GET /executions/:id` | One execution record | 0.2.0 |
| `GET /operations/:key` | The operation record of a key | 0.2.0 |

A path not built yet answers `501 {"error":"not_built","available_from":"0.2.0"}`. A request on these paths without the evidence token goes on to the API, where it needs the backend token like any other (so `GET /export` with the backend token works as in 0.1.0). The evidence token opens nothing else: it cannot write, and on any other path it is a wrong token.

**Control**, on its own loopback listener, only with `--fixture-control` (and, in this version, only with `tiny-tracker all`), with the **control token** (`TRACKER_CONTROL_TOKEN` or `TRACKER_CONTROL_TOKEN_FILE`).

| Path | What it does | Release |
|---|---|---|
| `GET /_fixture/clock` | The clock domain and offset | now |
| `POST /_fixture/clock` | Move the fixture clock | 0.3.0 |
| `GET /_fixture/faults` | The fault point table and what is armed | now |
| `POST /_fixture/faults` | Arm a fault | 0.2.0 |
| `POST /_fixture/runs` | Allocate a run id (`{"label": "..."}` optional) | now |
| `GET /_fixture/runs` | The runs allocated since start | now |
| `POST /_fixture/runs/:id/reset` | Reset one run's objects and key records | 0.2.0 |

The control listener refuses a non-loopback `Host`, **any** request that carries an `Origin` header, a `POST` without `content-type: application/json`, and bodies over 64 KiB. Tokens are compared in constant time. A run belongs to one principal (`{"principal": "p-..."}`, default `p-default`); at most 1000 runs are allocated per process (429 after that).

**Token rules:**

- 16 to 256 printable characters, no spaces.
- A token file must be a regular file that no group or other user can read or write (`chmod 600`). Setting both the variable and the file is an error.
- The backend, principal, evidence and control tokens must all differ.
- A process whose command line contains any of its tokens refuses to start. Both rules hold on every start, fixture layer or not.
- With `--token-dir`, a token the environment or a file gives wins; otherwise it is generated in the folder and reused on restart. A folder that others can read is refused.
- No token appears on stdout or stderr, in the build descriptor, in a record, in the instructions or in a result.

## The build descriptor

`GET /build` answers what this process runs ([schema](schemas/build-descriptor-1.schema.json), [example](schemas/examples/build-descriptor.json), [decision 0005](docs/decisions/0005-build-descriptor.md)): package version, profile, features, defects of both layers, variants, control on or off, durability, the pinned contract commit, the process layout, boot id, restart count, journal head, armed faults and the clock.

- **`build_hash`** covers the configuration (including the MCP settings: read-only mode, the allow and deny lists, the default project, and whether a key journal is set) and is the same on every start with the same settings. Known-answer files are keyed by it.
- **`descriptor_hash`** covers every field, including this process's state (boot id, restart count, journal head, armed faults, clock offset).

Both are SHA-256 over RFC 8785 bytes, under the domain tags `dev.writesafety.tiny-tracker/build/1` and `dev.writesafety.tiny-tracker/build-descriptor/1`. With the `evidence` feature, the MCP instructions carry the descriptor's facts in one JSON line (with a banner when the backend runs defects), and every tool result carries `build_hash`, `descriptor_hash` and `boot_id` in `_meta` under `dev.writesafety.tiny-tracker/build`. A process that holds only one layer reports the other as `null`.

## Runs, attribution and reset

A harness allocates a **run id** on the control listener and tags each call with it, plus its own **operation tag**, in the request `_meta`:

```json
{"_meta": {"dev.writesafety.tiny-tracker/run": "run-3f9a01c2-8e41b07d29a6", "dev.writesafety.tiny-tracker/operation": "a1-attempt-1"}}
```

The server reads both tags before any tool handler runs and stamps them on every backend request the call makes, as `Tiny-Tracker-Run` and `Tiny-Tracker-Operation`. No handler and no defect sits on that path, so an effect is attributed to its run and operation even in a build that drops or mangles the idempotency key. A tag that is not 1 to 128 of `A-Z a-z 0-9 . _ : -` is dropped, never forwarded. Direct backend callers send the same headers.

From 0.2.0, objects, key records and execution records are tagged with their run, and `POST /_fixture/runs/:id/reset` removes one run's objects and key records. The ledger keeps every entry, and records the reset itself. A lookup by key is scoped to the principal only, never to the run: the contract's key-only recovery, and the delayed one, may come from a later run of the same caller ([INTERFACES.md](docs/INTERFACES.md), D5).

## Digests

([decision 0002](docs/decisions/0002-digest-domain.md))

- **Canonical bytes:** RFC 8785. Member names sorted by UTF-16 code units, no whitespace, numbers as ECMAScript writes them (`1.0` is `1`, `-0.0` is `0`, `1e-7` stays `1e-7`, `1e21` is `1e+21`), no Unicode normalization. A string holding a lone surrogate is refused.
- **Digest:** lower-case hex SHA-256 over `UTF-8(domain) || 0x0A || UTF-8(canonical)`.
- **Served:** a record carries `{"alg": "sha-256", "domain": "...", "canonical": "...", "digest": "..."}` ([schema](schemas/served-digest-1.schema.json)). To verify, hash the served bytes; to check canonical form too, parse them and canonicalize again.
- **Vectors:** [`vectors/digest-1.json`](vectors/digest-1.json), including member order across planes, the float cases and refusals. A standard-library Python verifier is in [`verify/python/tt_digest.py`](verify/python/tt_digest.py):

```sh
python3 -I verify/python/tt_digest.py --vectors vectors/digest-1.json
# 20 vectors, 0 problems

printf '%s\n%s' 'dev.writesafety.tiny-tracker/execution-result/1' "$CANONICAL" | sha256sum
```

## Records

The records 0.2.0 serves, as draft schemas (`$id` under `https://writesafety.dev/schemas/tiny-tracker/`), each with an example in [`schemas/examples`](schemas/examples):

| Record | Schema | Served at |
|---|---|---|
| Execution record: one applied write, as committed, with its served digest | [`execution-record-1`](schemas/execution-record-1.schema.json) | `GET /executions/:id`, tool `get_execution` |
| Operation record: one key's state, scoped to its principal | [`operation-record-1`](schemas/operation-record-1.schema.json) | `GET /operations/:key`, tool `get_operation` |
| Ledger entry: one line of the append-only ledger | [`ledger-entry-1`](schemas/ledger-entry-1.schema.json) | `GET /ledger`, export |
| Known-answer file | [`expected-1`](schemas/expected-1.schema.json) | `expected/<version>.json` in each release |

Every record carries the principal (one constant value until there are two), `clock_offset_ms` and the `boot_id` of the process that wrote it. An execution record's `seq` is the store's commit sequence (a journal commit line carries it as `commit_seq`; it is not the line's position in the journal); the ledger has its own sequence and links to it by `execution_id`. The ledger is written below every MCP-layer defect and is never edited; it records executions, replays, refusals, fault arming and firing, run allocation and reset. A replay serves the same execution record as the first answer.

## Answers on keyed calls

([decision 0004](docs/decisions/0004-key-retention-and-expiry.md)) A keyed call's result describes the write the key identifies, even where the call itself applied nothing.

| Situation | `outcome` | `code` / `replayed` | `repeat` |
|---|---|---|---|
| First call, applied | `applied` | | |
| Same key, same arguments, record present | `applied` | `replayed: true` | `same_key` |
| Same key, different arguments | `not_applied` | `idempotency_key_reused` | |
| Same key while the first is still pending (0.3.0) | `unknown` | `in_progress` | `same_key` |
| Expired key, same arguments, tombstone present (0.3.0) | `applied` | `replayed: true`; the execution record id from the tombstone | `read_first` |
| Expired key, different arguments (0.3.0) | `not_applied` | refused | |

A refused first call (the backend answered 300 or above) stores nothing and does not hold the key. A lookup for a key with no record says "no record of this key now": it never says nothing was written, because a held request can still arrive.

## Clock, commits and keys

- **Clock domains.** Wall time is the process clock. The fixture clock (0.3.0) moves only through the control listener and only for retention. With `durable` (0.4.0) each move is a journal `clock` line, written before the offset is stored (if it cannot be written, the clock does not move: 503 `journal_unavailable`), and the offset is restored at the next start, so record time never moves back across a restart. Every record and the descriptor carry `clock_offset_ms`; a delayed-recovery run whose evidence is published shows offset 0 and control off.
- **Commits stay synchronous, in a fixed order:** validate, append to the journal, apply in memory, ledger, reply. A journal error aborts the write with nothing applied (503); a ledger error stops the store. Where a write has a pending state, the pending record is written first and the commit is one synchronous section after it. Conditional writes and batches are one section each. Fault delays sit before the section, never inside it.
- **Request fingerprints.** Every record's `fingerprint_hash` is SHA-256 under `dev.writesafety.tiny-tracker/request-fingerprint/1` over the RFC 8785 bytes of `{"body", "method", "path", "principal"}`.
- **Keys.** With `strict-input`, the backend accepts an `Idempotency-Key` only as 8 to 128 of `A-Z a-z 0-9 . _ : -` (400 `bad_idempotency_key`), the same format the MCP tools declare, because other harnesses call the backend directly. It also refuses a body holding a string that is not well-formed Unicode (400 `not_well_formed`).
- **One instance.** More than one server instance on the same data is a non-goal; from 0.3.0 the data-dir lock refuses a second writer, and from 0.4.0 a lease with a heartbeat fences a holder that lost it (see the limits).

## Defects, placement and the compatibility table

Defects live in two registries: the MCP layer's (`src/defects`, 47 today) and the backend's (`src/backend/defects`, 1 today). Each defect is one file, is off unless named, and has a `requires` list of the features it needs.

- `--defect all` and a requirement ID take every such defect **valid for the active features**. A defect named on its own whose features are off stops the process.
- A **backend** defect replaces one or more named **seams** of the backend (`patchTicket`, `inputRules`, and from later releases `digest`, `keyRecord`, `lookup`, `journal`, `keyExpiry`). A defect on a seam that is not built yet, an unknown name, a missing feature or a non-loopback bind stops the process. A backend defect build prints a banner on stderr; with the `evidence` feature the MCP instructions name its defects with a `backend:` prefix.
- **Placement map.** `src/defect-placement.ts` computes where each defect lands (a tool's handler, description, schema or annotations; a validation step; a configuration rule; a backend seam) by applying it to a fresh build. Defects that share a piece can hide each other under `--defect all`; the map lists them, and lists where each planned defect will land.

| Planned defect | Trips | Lands on | Needs | Release |
|---|---|---|---|---|
| `digest-of-current-state` | FX-DIG-1 | backend `digest` | `execution-records` | 0.2.0 |
| `replay-digest-mismatch` | FX-DIG-2 | backend `digest`, `keyRecord` | `execution-records` | 0.2.0 |
| `digest-not-canonical` | FX-DIG-3 | backend `digest` | `execution-records` | 0.2.0 |
| `lookup-wrong-record` | FX-LOOK-1 | backend `lookup` | `lookup` | 0.2.0 |
| `lookup-reexecutes` | FX-LOOK-2, MWS-ANN-1 | `get_operation` | `lookup` | 0.2.0 |
| `lookup-unscoped` | FX-LOOK-3 | backend `lookup` | `lookup`, `principals` | 0.2.0 |
| `key-record-not-durable` | FX-DUR-1, MWS-RETRY-2 | backend `journal` | `durable` | 0.3.0 |
| `key-record-after-effect` | FX-DUR-2 | backend `journal` | `durable` | 0.3.0 (built; shown from outside the process by `backend/after-effect-before-key/crash` under `--supervise`: the retry applies a second time) |
| `journal-without-fsync` | FX-DUR-3 | backend `journal` | `durable` | 0.3.0 |
| `key-expires-early` | FX-KEY-1 | backend `keyExpiry` | `retention` | 0.3.0 |
| `retention-unstated` | FX-KEY-2 | `create_ticket`, `create_project`, `add_comment` | `retention` | 0.3.0 |
| `in-flight-key-race` | MWS-RETRY-2 | backend `keyRecord` | `inflight` | 0.3.0 |
| `in-flight-phantom-success` | FX-KEY-3, MWS-RES-1 | backend `keyRecord` | `inflight` | 0.3.0 |
| `in-progress-reported-not-applied` | MWS-RES-2 | `create_ticket` | `inflight` | 0.3.0 |
| `settle-miss-reported-not-applied` | MWS-RES-1 | `create_ticket` | `inflight` (built in 0.3.0 against the settle-by-lookup leg of the self-test) | 0.3.0 |
| `settled-reported-unknown` | FX-LOOK-4 | `create_ticket` | `lookup`, variant `settle-by-lookup` | 0.3.0 |

The ledger, the fixture clock and the fault controller are the instruments other harnesses trust, so they get no defects. They are tested against each other instead: the ledger, a journal replay and the export must agree, a second recount is written independently in the tests, and the Python side recounts from the exported file.

**Compatibility table** (`src/compat.ts`). A combination the table refuses stops the process with exit 2 and the rule's reason. Profile 0.1 keeps the 0.1.0 command line, so rules that would refuse something 0.1.0 accepted do not apply to it.

| Rule | Refuses |
|---|---|
| CMP-1, CMP-2 | Any feature, or `--fixture-control`, under profile 0.1 |
| CMP-3 | A feature this version does not build yet |
| CMP-4 | `durable` without `--data-dir` (and `--data-dir` without `durable`) |
| CMP-5 | The `key-store-honest` variant with a `lookup` named with `--features` or `TRACKER_FEATURES`: its keys live in the MCP server, where a backend lookup cannot see them. A `lookup` that comes only from the default profile is not refused: the build turns it off and says so (owner decision, 16 Nov 2026). The state line carries `"features_off": ["lookup off: key-store-honest keeps keys in the MCP server"]`, a notice goes to stderr, and the build descriptor's `features` and `build_hash` are those of the build without `lookup`. |
| CMP-6 | A fault demonstration without the defect or variant that makes it meaningful (for example a crash between effect and key record needs `key-record-after-effect` or `key-store-honest`); a fault name the point table replaced; an unknown point |
| CMP-7 | A fault armed at start without the `faults` feature, or at a point this build cannot arm (the answer names the release that builds the point, or says it is not planned). Faults are armed on the control listener (`POST /_fixture/faults`); in 0.2.0 the armable point is `mcp/after-backend-reply/drop`, and 0.3.0 adds the three crash points |
| CMP-8 | `--fixture-control` outside `tiny-tracker all` (this version) |
| CMP-9 | `--backend-defect` in `tiny-tracker server`, where no backend runs |
| CMP-10 | `strict-input` in `tiny-tracker server` |
| CMP-11 | `evidence` outside `tiny-tracker all` in this version (the build descriptor must cover both layers) |
| CMP-20 | `lookup` without `execution-records` (an operation record names the execution record of its write) |
| CMP-21 | `principals` named in `tiny-tracker server` (it is a backend feature) |
| CMP-30, CMP-31 | `ledger` without `evidence`, or without `strict-input` (the ledger hashes every request) |
| CMP-32, CMP-33 | `faults` without the `ledger`, or without `--fixture-control` (faults are armed on the control listener only) |
| CMP-50 | `durable` without `strict-input`: every journal line is checksummed over RFC 8785 bytes, so a string with a lone surrogate must be refused at the door (decision 0003 §7) |
| CMP-51 | The `settle-by-lookup` variant without `inflight` (it fences keys through the backend's key states) |
| CMP-52 | Two key variants at once (`key-store-honest`, `key-store-durable`, `settle-by-lookup`, `settle-by-client-reference`) |
| CMP-53 | `key-store-durable` or `settle-by-client-reference` with a named `lookup` or `inflight` (they stand for a backend with no idempotency key). As with CMP-5, a `lookup` or (from 0.3.0) an `inflight` that comes only from the default profile is turned off for the build, not refused, and the state line names it in `features_off` |
| CMP-54 | `durable`, `inflight` or `retention` named in `tiny-tracker server` (backend features). The default profile's `inflight` and `retention` are not refused there: the backend is another process, and `--key-retention` given to `server` sets the retention its tools state |
| CMP-55 | The `settle-by-lookup` variant with `--key-expiry forget`, or with the `key-expires-early` backend defect: a missing record may then be a forgotten applied write, and the fence would close it as never applied. A backend under `forget` started apart from its MCP server never fences a miss: the fence route answers 404 `state: "unknown"`, `fenced: false`, and the outcome stays open (G2 fold-in 2) |
| CMP-60 | `clock` without `--fixture-control` (the fixture clock moves only through the control listener) |
| CMP-61, CMP-62 | `--supervise` under profile 0.1, or outside `tiny-tracker all` |
| CMP-63 | A crash fault point without `--supervise`: in one process a crash stops both layers and nothing restarts them. On the control listener the same arming is refused 409 `needs_supervise` |
| CMP-64 | Under `--supervise`, `--fault` naming a point that is not a crash point (the supervisor's arming store is read by the crash checks only; arm the others on the control listener) |
| CMP-65 | Retired in 0.4.0. In 0.3.0 it refused `durable` with `clock`, because the journal did not keep the fixture clock's offset and after a restart record time would have moved back (G2 fold-in 9). From 0.4.0 every clock move is a journal `clock` line, written before the offset is stored, and the offset is restored at load; a data dir with clock lines refuses to start without the `clock` feature |
| CMP-66 | `--fault backend/after-effect-before-key/crash` without `durable` (the point lies between the journalled effect and the key record). On the control listener the same arming is refused 400 `needs_feature` |
| CMP-70 | `--supervise` over stdio: the supervisor's MCP child is a separate process that a restart replaces, and the client's stdin and stdout cannot move with it. (Narrowed at the 0.4.0 integration: stdio runs through the same start as `all`, so the fixture features, the evidence listener and `--fixture-control` work over stdio.) |

Tests check the command line against the table on a pairwise set of combinations, not the full product.

## Fault points

Faults are named **process / position / action**. A fault's arming state lives in the supervisor or the data dir, never on the command line, so a `once` fault does not re-arm when a child restarts. Every arming and every firing is a ledger entry, with the sequence number it fired on.

| Point | What a caller sees | Release |
|---|---|---|
| `mcp/after-backend-reply/drop` | The backend committed and answered; the MCP server never answers. The lost response, server-side. | 0.2.0 |
| `mcp/after-backend-reply/close` | As drop, with the connection closed without a body | 0.3.0 |
| `mcp/after-backend-reply/crash` | The MCP process exits after the backend answered; needs `--supervise` (the backend stays up) | 0.3.0 |
| `mcp/after-backend-reply/delay` | The answer is held for a set, capped time | 0.3.0 |
| `backend/before-commit/crash` | After the pending key record, before the commit section: the backend exits and nothing is written; at the next start the pending line is ended `aborted` (`orphan_at_start`) | 0.3.0 |
| `backend/before-commit/delay` | A delay between the pending record and the commit: the in-flight window | 0.3.0 |
| `backend/after-commit/crash` | After the ledger, before the reply: written, journalled and in the ledger; the backend exits, so the client sees `unknown` | 0.3.0 |
| `backend/after-commit/error` | The backend commits, then answers 500 | 0.3.0 |
| `backend/after-commit/drop` | The backend commits and never answers (capped hold) | 0.3.0 |
| `backend/after-effect-before-key/crash` | Keyed writes with `durable` (CMP-66): after the write is journalled and applied, before its key record is kept apart from it. The correct build keeps the key record in the commit line, so the retry replays; under `key-record-after-effect` the record is lost and the retry applies a second time. The client sees `unknown` | 0.3.0 (G2 fold-in 11) |

A backend crash after commit and an MCP-process crash after the backend replied are different faults with different expected answers. **Built in 0.3.0:** the four crash points, under `tiny-tracker all --supervise` only. They are armed at start (`--fault POINT[:once]`) or on the control listener, into the supervisor's arming store, which both children read; a crash point fires once and takes no other selector. `/build` lists them in `faults.armed` as `S-<n> <point> {"once":true}`, after the fault controller's own `F-<n>` entries. Resource caps: holds and delays are capped in time and count, run allocation at 1000 per process, control bodies at 64 KiB, and the data dir is created 0700.

## Transports, the container and caps

- **Transports.** Streamable HTTP (both protocol eras) and stdio (both eras, settled on the opening exchange). `tiny-tracker stdio` is `tiny-tracker all` with the MCP layer on stdin and stdout: the same features, fixture layer, evidence and control listeners and fault controller, and the same build descriptor. The tools, instructions and capabilities are the same over both; a test checks stdio against the published 0.1.0 surface under `--profile 0.1`, and against the default surface (0.1.0 plus the lookup tools) by default, in both eras. A reduced self-test matrix runs over stdio: every check against the correct build, and one defect per requirement (the MWS-CFG checks start their own servers over HTTP and are covered by the full matrix). A held answer (`mcp/after-backend-reply/drop`) over stdio is a reply line written late or never. The transport is not part of the build descriptor: a harness names it in its own run notes.
- **Listener caps (X5).** The MCP listener caps a request body at 4 MiB, connections at 256 and requests in flight at 64 (503 with `Retry-After` beyond), allows 10 s for headers and 30 s for a request, and cuts off a POST left unanswered for 120 s by closing the connection without a reply. A fault's hold or delay has its own, smaller cap; the listener's is the backstop. A stdio message is capped at 4 MiB: a longer one closes the connection, the reason goes to stderr and the process exits 1.
- **Container (X1).** Container mode (`TRACKER_CONTAINER=1`, set by the image) listens on the container's interfaces, needs a bearer token for `/mcp` and refuses to start without one. The backend API stays on the container's loopback. **Evidence from outside the container** (owner decision: reachable behind its token): `TRACKER_EVIDENCE_LISTEN=0.0.0.0:PORT` with the `evidence` feature serves the evidence routes only, for any Host, behind the evidence token; every other path answers 404 there. In container mode a defect build does this too, with no opt-in (owner decision); the write surface stays behind the bearer token either way. Outside container mode a defect build keeps every listener on loopback. `TRACKER_CONTAINER_ALLOW_DEFECTS`, an opt-in tried before 0.4.0 shipped, does not exist: a start that sets it is refused, naming it.
- **Tokens.** The MCP bearer token, the backend and principals' tokens, and the evidence and control tokens all differ, however they are given (environment, a 0600 file, or the token folder), and none is ever on the command line or printed.
- **Data dir.** Created 0700; an existing one that others can read, write or search is refused, as is a symlink.

## Known answers and reproducibility

- **The 0.4.0 matrix.** `expected/builds-0.4.0.json` is selected by `expected/select-0.4.0.mjs`, pairwise over four factors: the feature level (the 0.2.0 evidence set; with the 0.3.0 in-memory features; with `durable` and the fixture clock on a data dir of its own, so FX-KEY-1 runs on the durable rows; and evidence without a named `lookup`, so the key-store variants can run), the MCP-layer defect (or none), the backend defect (or none) and the variant (or none). Every pair of values that some legal build can hold is in at least one row; legal means the compatibility table and each defect's `requires`. The selection is deterministic (greedy, ties to a fixed order), so it reproduces byte for byte.
- **The answers.** `expected/generate.mjs` runs every row and writes `expected/0.4.0.json` (schema `expected-1`): `fx-check`'s answer per `FX-` property, and for the rows the contract driver runs (the 0.2.0 build list), the driver's own verdict strings. A durable row is started twice on its data dir: fx-check plants a keyed write, the generator restarts the build, and fx-check checks the repeat (FX-DUR-1). Each answer is the set of answers seen over three runs, and a second generation must give the same bytes.
- **fx-check's 0.4.0 checks.** FX-KEY-2 from the tool descriptions and instructions; FX-KEY-1 by moving the fixture clock to just inside the stated retention (`clock` feature, `--probe`); FX-DUR-1 across a restart (`--durability-plant`, then `--durability-verify`; the plant is made after FX-KEY-1 has moved the clock, since with `durable` the offset survives the restart); FX-DUR-2 from the data dir's files (`--data-dir`, read only; the pid lock's and the lease's own leftovers, `lock.new-*`, `lock.stale-*`, `lock.d.new-*`, `lock.d.stale-*` and `lock.d.released-*`, are not counted; the crash point `backend/after-effect-before-key/crash` under `--supervise` shows the same defect from outside by its effect, a second ticket). FX-DUR-3 and FX-KEY-3 need a crash between the journal append and the answer, or a request held before commit, which no fault point offers: they answer `not checked`, and the crash suite (T1) and the inflight tests cover them.
- **CI** runs the suite on Linux, macOS and Windows with Node 22 and 24, runs the registered generators (the surface transcript, the 0.4.0 selection, a 17-row sample of the matrix) three times per platform in fresh processes, and on Linux regenerates the whole matrix and compares it with the committed file. Any byte difference fails the run, and the bytes are kept as build artifacts so anyone can compare platforms.

## Identifiers

`src/fixture-properties.ts` is the only file that spells them.

- **`FX-`** are properties of this fixture, not MWS requirements: FX-DIG (digests), FX-LOOK (lookup), FX-DUR (durability), FX-KEY (keys), FX-FLT (faults), FX-BLD (the build descriptor).
- **`LRT-A1` to `LRT-A5`** refer to the assertions of the shared lost-response test contract, `zambodotdev/lost-response-test-contract`, pinned to commit `92bf1ba5f8226a67409fd8a7a68411b5c4a7258d`.
- **MWS IDs** stay in `src/requirements.ts`.
- Wire names: `_meta` keys under `dev.writesafety.tiny-tracker/` (`idempotency-key`, `run`, `operation`, `build`); HTTP headers `Tiny-Tracker-*`.

## Versions and stability

- The fixture interface is **`fixture-api/1`** from 0.2.0 (it was `fixture-api/0` before): the control API arms faults (`POST /_fixture/faults`) and resets runs (`POST /_fixture/runs/:id/reset`), and the evidence namespace serves `/ledger`, `/executions` and `/operations` with their features. It is still a draft in 0.x: paths, fields and names on this page can change; a change is listed in the CHANGELOG and bumps the number, and a removal is announced one release ahead.
- The journal format (`journal-format/1`), each schema (`-1` in its file name) and each digest domain (`/1` in its tag) have their own versions, separate from the package version.
- `--profile 0.1` keeps the 0.1.0 surface in every later release.

### Planned for 0.4.0

| Item | Why | Options |
|---|---|---|
| writecheck rows for the inflight-gated MCP defects | they have no expectation row in 0.3.0 | rows measured with a same-key call while the first is in flight (`inflight` is on in the default profile from 0.3.0) |

## Limits: what a run against this fixture does not show

- **It shows how a harness behaves against this server, nothing about any other server.** A harness that reports the expected answers here has been checked against one small, deliberately simple target.
- **Same author.** The fixture, its defects, its known answers and our contract adapter are written by the same team. An outside run is worth more than ours.
- **Local runs.** The evidence is produced on the machine that ran the harness. A third party can recount from published raw outputs and the ledger export, not from a live public record.
- **The instruments are in the system under test.** The ledger and the build descriptor run in the same process as the code they describe. They sit below every MCP-layer defect and are cross-checked against each other and against the export, but they are not independent hardware.
- **Classification is trusted.** Until the contract driver compares recovered digests itself, its K-only recovery verdict trusts the adapter's classification; we label that verdict self-attested.
- **The contract is a draft.** The lost-response contract is under joint review. Runs before it freezes are historical baselines and are repeated after the freeze.
- **Time.** Rehearsals with the fixture clock prove nothing about elapsed time. Only a wall-clock run with offset 0 and control off is published as a delayed-recovery result.
- **`lookup-reexecutes` is detected by fx-check only.** Detected by fx-check (FX-LOOK-2, with --mcp); writecheck does not observe it yet: the re-executed write creates a new object outside the one MWS-ANN-1 watches.
- **Windows.** The suite runs on Windows in CI without the Python checks (no `python3` command there), and POSIX file modes (the 0700 data dir, 0600 token files) are not checked on Windows: the folder's ACL is the operator's to set.
- **Durability.** Until 0.3.0 everything is in memory. From 0.3.0, with `durable`, data, key records, tombstones, fences, run allocations and execution records survive a restart through the journal. **The ledger is still kept in memory, for one boot:** after a restart it holds only that boot's entries, so a recount that includes the ledger covers one boot (the durable A5 plan recounts before its restart; `docs/a5-durable.md`).
- **"Flushed" on macOS is not power-cut-safe.** The journal flushes each line with `fsync` before the write is applied. On macOS Node's `fsync` is not `F_FULLFSYNC` (Node does not expose it), so the drive may still hold the line in its cache: there `after-fsync` is crash-safe, not power-cut-safe. A durable backend on macOS says so on stderr at start. On Linux `fsync` flushes to stable storage.
- **writecheck coverage.** The two inflight-gated MCP-layer defects, `in-progress-reported-not-applied` and `settle-miss-reported-not-applied`, have no expectation row in writecheck's tiny-tracker integration test: its per-defect runs say nothing about them (tiny-tracker's own tests show both). From 0.3.0 the default profile turns `inflight` on, so its `--defect all` run includes them. Rows are listed for 0.4.0.
- **Crash points between the effect and the key record.** `key-record-after-effect` shows from outside the process only through `backend/after-effect-before-key/crash`, which needs `tiny-tracker all --supervise` and `durable`; a run with no crash between the two (the restart leg of a planted A5, say) shows nothing against it. The in-process T1 shows it too.
- **One instance.** Behaviour with more than one server instance on the same data is out of scope.
- **The data-dir lease and lock (G13: one instance, enforced best-effort).** Node has no OS-held file lock (flock or fcntl). From 0.4.0 the primary guard is a **lease**: the directory `lock.d` in the data dir, created whole (a temp directory with an `owner` file naming the pid, host and a nonce, renamed into place, so of several starters exactly one gets it), whose mtime the holder refreshes every 2 s. A start takes a lease over when its heartbeat is more than 20 s old, or, on the same host, when its process is gone (or names this pid with a text this process did not write, as a container's pid 1 after an unclean stop does); the takeover is a compare-and-rename (moved aside, removed only if it is the lease judged stale, else put back or left and the start refuses). **The holder checks before every journal append that the lease is still its own (same directory, same owner text) and that its last heartbeat is less than 10 s old; if not, it is fenced: it appends nothing more, every write answers 503 `journal_unavailable`, and it has to be restarted.** A process paused or blocked for more than 10 s therefore fences itself even when nobody took its lease over. The 0.3.0 pid lock (`lock`, with a nonce) stays as a second check for this release: a start needs both. The residual races of 0.3.0 are closed for data and restated for availability:
  - a starter that crashes or stalls between moving a stale lease or lock aside and putting it back, or three starts at the same instant where one moves a live holder's lease aside and another creates its own, can still leave two processes running on one dir; but only the one whose lease is in place appends, and the other is fenced at its next append (with the pid lock, a clean close in the three-starter window can still delete another start's pid lock; the lease decides who writes);
  - a live holder can be fenced by such a race, or by a pause, and then refuses writes until restarted (fail closed).

  `--supervise` serializes its own children (it restarts the backend child only after the old one has exited).
- **Two containers on one data-dir volume.** Each container has its own hostname, so a start does not judge the other container's lease by its pid (which it cannot see): it is refused while the other's heartbeat is fresh. If both share a hostname (host networking), the pid-1 rule can take a live lease over, and the other server is then fenced at its next append. Give each container its own data dir.
- **Forced overlaps are not guaranteed.** A simultaneous same-key repeat can only be observed or not observed; known answers list both where both can happen.

## Feedback

Questions, objections and requests are welcome as GitHub issues and discussions on [isokron-ai/mcp-write-safety](https://github.com/isokron-ai/mcp-write-safety). The larger choices are recorded as short [decision records](docs/decisions/README.md); a change to one is a new record.
