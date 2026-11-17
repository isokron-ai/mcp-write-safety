# Frozen interfaces for the parallel build of 0.2.0, 0.3.0 and 0.4.0

Status: frozen at the seams commit on top of Phase 0 (`469e92c`). Six streams build against this page without talking to each other. A stream that needs to change anything listed here does not change it in its branch: it writes the change into its gate note, and the lane lead lands it as a separate commit that every stream rebases on.

`test/interfaces.test.ts` and the tests named below hold these contracts.

## 1. Frozen contracts

### 1.1 The commit path (`src/backend/commit.ts`, `Store.commit`)

- **One entry point for writes.** Every write the backend applies goes through `Store.commit(meta: TxMeta, mutate: (seq) => Reply, afterJournal?: (tx, reply) => void)`. The whole call is one synchronous section, and `Store.commit` refuses a thenable.
- **Frozen order.**
  1. **Validate and compute.** `mutate` runs. A refusal (an `ApiError`) changes nothing; `onRefusal` is called and the error is thrown.
  2. **Journal append.** The sink with `role: "journal"` (at most one) gets `onCommit` first.
     - If it throws, the store is put back exactly as it was: objects, id counters and the commit sequence.
     - Nothing is applied and no key is held. The request gets 503 `journal_unavailable`, and the store carries on.
  3. **Apply.** The write is now in effect. `afterJournal` records what goes with it (the key record).
  4. **Ledger and observers.** Sinks with `role: "ledger"` or `"observer"` get `onCommit`. If one throws, the store stops: every later request gets 503 (fail-stop), because memory and journal agree but the evidence does not.
  5. **Reply.**
- **Waiting happens before the section.** A write that waits waits in `BackendOps.beforePatch`, before the commit section. Only a backend defect waits (`lost-update`), and its stale write runs inside the section, with the same behaviour as 0.1.0.
- **`CommitSink`.** Its shape is `{ name; role: "journal" | "ledger" | "observer"; onCommit(CommittedTransaction); onReplay?(ReplayedTransaction); onRefusal?(RefusedTransaction) }`. Sinks are synchronous; the journal flushes with `writeSync` + `fsyncSync`. They are given as `startBackend({ sinks })` or added with `store.addSink`.
- **`TxMeta`.** It carries:
  - `principal`;
  - `attribution { run, operation }`, from `Tiny-Tracker-Run` and `Tiny-Tracker-Operation`, with a malformed tag set to `null`;
  - `request { method, path, key, fingerprint }`, where `fingerprint` is the backend's own comparison string `METHOD path canonicalJson(body)` for a keyed POST, else `null`.
- **Events.** Every event carries `at` (wall time), `clockOffsetMs` and `status`.
  - A commit adds `seq`, `body` (post-state, as committed) and `objects`.
  - A replay adds `body` and `originalSeq`.
  - A refusal adds `code`.
- **The commit sequence.** `seq` counts applied writes only, starting at 1. It is never reused, and an aborted write does not consume one.
  - It is the execution record's `seq`, and the id is `X-<seq>`.
  - From 0.3.0 it is the journal line number.
  - The ledger keeps its own `seq` and links by `execution_id`.
- **Fault positions against the path** (`COMMIT_STEPS` in `src/fault-points.ts`):
  - `backend/before-commit` is after validate and before the journal append: nothing is written.
  - `backend/after-commit` is after the ledger and before the reply: the write is applied, journalled and in the ledger, but unanswered.
  - `mcp/after-backend-reply` is in the MCP process, after the backend answered.
- **`fingerprint_hash`.** In every record it is `fingerprintHash(principal, method, path, body)`: SHA-256 under `dev.writesafety.tiny-tracker/request-fingerprint/1` over the RFC 8785 bytes of `{body, method, path, principal}`. It is in the vectors, in Node and Python.

### 1.2 The clock (`src/clock.ts`)

- The interface is `Clock { domain: "wall" | "fixture"; now(): Date; wallNow(): Date; offsetMs(): number }`, and `wallClock` is the default.
- Every timestamp goes through a `Clock`. Nothing in `src/backend` or `src/fixture` calls `new Date()`.
  - `now()` gives record times: `created_at`, `committed_at`, `expires_at`, and a run's `created_at`.
  - `wallNow()` gives the times a schema says are wall time: an event's or ledger entry's `at`, and the descriptor's `started_at`.
- It is given as `new Store(seed, clock)`, `startBackend({ clock })`, `createFixtureLayer({ clock })`, `new BuildDescriptor(input, clock)` and `new RunRegistry(bootId, clock)`. The fixture clock (stream E) implements it.

### 1.3 Backend seams (`src/backend/seams.ts`; names in `BACKEND_SEAMS`)

| Seam | Interface | State | Implemented by |
|---|---|---|---|
| `patchTicket` | `BackendOps.patchTicket` (sync, inside the section) plus optional `beforePatch` (async, before it) | wired | — |
| `inputRules` | `InputRules { checkKey; checkStrings }` | wired | — |
| `keyRecord` | `KeyRecordSeam { get(scope, key); put(scope, key, StoredReply); dropRun(run) }` | wired (memory) | A uses it; D replaces it with `InflightKeyRecordSeam` (`begin`, `abort`, `tombstone`) |
| `digest` | `DigestSeam { resultDigest(body): ServedDigest }` | named | A |
| `lookup` | `LookupSeam { find(scope, key): StoredReply \| undefined }` | named | A |
| `journal` | `JournalSeam extends CommitSink { load(); close() }` | named | D |
| `keyExpiry` | `KeyExpirySeam { retentionMs; expiresAt(d); isExpired(reply, now) }` | named | D |

A backend defect replaces a seam by assigning the `BackendOps` member. Its file declares `seams` and `requires`.

### 1.4 Key-record scope (D5), principals and runs (`src/principals.ts`, `src/backend/seams.ts`)

- **Scope.** `KeyScope = { principal }`, so key records are scoped by (principal, key). The run is recorded on every key record (`StoredReply.run`) but is never part of a lookup.
- **Runs are scoped per principal.** A run is allocated for one principal (`POST /_fixture/runs {"principal": "p-…"}`, default `p-default`). `KeyRecordSeam.dropRun(scope, run)` and `Store.dropRun` touch only that principal's records.
- **Principals.** The operator assigns ids; they are never derived from a token.
  - `TRACKER_BACKEND_TOKENS_FILE` is a 0600 JSON file of the form `{"principals":[{"id":"p-…","token":"…"}]}`.
  - Ids match `^p-[a-z0-9-]{1,62}$`.
  - Without the file there is one principal, `p-default`, holding `TRACKER_BACKEND_TOKEN`.
- **All tokens differ** across every principal, evidence and control (`src/tokens.ts checkDistinct`). That rule and the refusal of a token on argv run on every start, with or without the fixture layer.
  - The argv check skips tokens under 8 characters, which only a 0.1-style backend token can be.
- **Authentication.** `principalFor(header, principals)` compares in constant time. `startBackend({ principals })` accepts the list; stream A wires the file into the command line and flips the feature.

### 1.5 Records (`src/records.ts`, `schemas/*-1.schema.json`)

- The field names of `ExecutionRecord`, `OperationRecord` and `LedgerEntry` are frozen. `RECORD_FIELDS` equals each schema's `required` and `properties` order, and the examples. This is checked at compile time and by a test.
- **Additions do not need a new version.** A `/1` schema allows additional top-level members, and a consumer ignores members it does not know. A new member is added to the schema, the type and the example in one commit. Renames and removals mean `/2`.
- **`EvidenceSource`** (`seams.ts`) is the read side, `{ execution(id); operation(scope, key); executions() }`. Stream A provides it, stream B serves it, and A's tools call it.
- **The build descriptor** has a `config` block in `build_hash`: `read_only`, `tools`, `deny_tools`, `default_project` and `key_journal`. It is set from the started server before the state line is printed.
  - `evidence` runs only in `tiny-tracker all` (CMP-11), so one descriptor covers both layers.

### 1.6 The MCP-layer hooks (`ServerExtras` in `src/mcp/server.ts`)

- `attribution`: run and operation tags read from request `_meta`.
- `mirror`: the build descriptor, carried in the instructions and in `_meta`.
- `onResult(tool, result, ctx) → Promise<result>`: the MCP fault point. It runs inside the call's attribution context, after the handler and before the answer.
- Stream B arms faults through `onResult` only. No other stream edits the wrapper.

### 1.7 Already frozen in Phase 0

- Feature names and their `since` values (`src/profile.ts`).
- Compat rule ids.
- Fault point ids (`src/fault-points.ts`).
- Evidence and control paths, with their 501 bodies.
- `_meta` keys and `Tiny-Tracker-*` headers.
- Build descriptor fields and both hashes.
- The digest domain and preimage.
- The keyed-call answer table (decision 0004).
- `createMcpServer(build, config, deps, extras)` as the transport-independent factory.
- The 0.1 golden transcript (nobody edits it).

### 1.8 Contracts declared here and built by their stream

- **`Store.dropRun(principal, run): { objects: number; keys: number }`** (A). It removes the objects and key records one principal's run made, and B's run reset calls it. Objects record their run from 0.2.0.
- **`Store.applyPostState(tx: CommittedTransaction)`** (D). It restores one journal line's post-state with no clock call. It goes in a delimited block at the end of `store.ts` (§4).
- **`--token-dir DIR` (D1), built in this commit.**
  - DIR is created 0700. An existing DIR that others can read is refused.
  - `evidence.token` and `control.token` are generated there (0600) when the environment gives none, and are reused on restart. A token the operator supplies by environment or file wins.
  - The state line prints `"tokens": "<DIR>"`, never a token.
  - `--token-dir` without a fixture feature exits 2.

## 2. Owner answers (approved 16 Nov 2026, 21:17 AZ)

| # | Answer | Where it is encoded |
|---|---|---|
| D1 | The evidence token, when not supplied, is generated into a 0600 file in a 0700 token folder; only the path is printed | `src/fixture/tokens.ts` (`--token-dir`) |
| D2 | Keep the domain tag in the digest preimage | `src/digest.ts`, decision 0002 |
| D3 | Defect headers that name an audited system stay, as citations of published research | no code |
| D4 | `--profile 0.1` keeps refusing `evidence`: the mirror changes the instructions, which are part of the 0.1 surface | `src/compat.ts` CMP-1 |
| D5 | Key records are scoped by (principal, key), never by run | `src/backend/seams.ts` (`KeyScope`, `memoryKeyRecords`) |
| D6 | Schema `$id` base is `https://writesafety.dev/schemas/tiny-tracker/` | `schemas/*`, `verify/python/check_schemas.py`, `test/schemas.test.ts` |

**D5 reasoning.**
- **What the contract says.** Contract A3 (`CONTRACT.md` at `92bf1ba5f8226a67409fd8a7a68411b5c4a7258d`) says the recovery caller "holds only K" and "must not possess the original run ID". It adds that "using only K" "does not exclude caller authentication, operation scoping, or the caller's permission to retrieve the historical outcome".
- **What the driver does.** `recover_by_key(*, operation_key)` takes only K (`fixtures/harness/adapters/base.py:145`). The key-only leg (`lost_response.py:229`) and the 24-hour A5 leg may run from a fresh process. The harness README gives each assertion run a fresh run-scoped session identity.
- **Why the run cannot be in the scope.** A scope of (principal, run, key) would make the A5 key-only lookup miss on the correct build. Scoping by principal is the caller authentication A3 allows, so the run stays a record field. It drives the ledger and run-scoped reset, never lookup.

## 3. Streams and ownership

"Owns" means only that stream edits the file. Every stream may add new files under its own names.

Every stream branches from the head of `tiny-tracker/shared-fixture` after the seams commit. A stream that must wait for another (D after A) rebases on it before merging.

| Stream | Content | Owns | Depends on | Can start now? |
|---|---|---|---|---|
| **A. 0.2.0 core** | Execution records, `digest`/`lookup` seams, `EvidenceSource`, `get_operation`/`get_execution`, principals wiring, run-tagged objects, `Store.dropRun`, the FX-DIG/FX-LOOK defects, `test/fx.test.ts` | `src/backend/store.ts`, `src/backend/http.ts`, `src/backend/execution.ts`*, `src/backend/lookup.ts`*, `src/mcp/tools/operations.ts`*, `src/mcp/build.ts`, `src/backend/defects/*` (new files), `src/defects/lookup-*.ts`*, `test/fx.test.ts`* | Freeze (this commit) | **Yes** |
| **B. 0.2.0 fixture** | Ledger as a `CommitSink`, fault controller plus `mcp/after-backend-reply/drop` via `onResult`, evidence routes over `EvidenceSource`, run reset, `--token-dir` (D1) | `src/fixture/*` (except `clock.ts`), `src/fixture/ledger.ts`*, `src/fixture/faults.ts`* | Freeze. Its final wiring needs A's `EvidenceSource` and `dropRun`; build against a fake until then | **Yes** |
| **C. 0.2.0 harness** | Python adapter (MWS-repo copy pinned to the contract), `fx-check`, the `expected/` generator | `harness/`*, `expected/`*, `src/fx-check.ts`*, `verify/python/*` (new files) | Schemas and endpoints. Final runs need A and B merged | **Yes**, against the schemas and the 501 stubs |
| **D. 0.3.0 durability** | Journal as `JournalSeam`, `InflightKeyRecordSeam`, `KeyExpirySeam`, data-dir lock, `Store.applyPostState`, T1 crash points, T2 seeded histories | `src/backend/journal.ts`*, `src/backend/keyrecords.ts`*, `src/backend/expiry.ts`*, `test/crash.test.ts`*, `test/histories.test.ts`*, the block at the end of `store.ts` marked `// ---- stream D: journal replay ----` | Freeze. **Merges after A** (it needs A's run-tagged post-state) | **Yes**; rebase onto A before merging |
| **E. 0.3.0 process and clock** | `--supervise` (two children), arming state outside argv, `boot_id`/`restart_count`, fixture clock as `Clock`, crash points | `src/cli.ts`, `src/supervisor.ts`*, `src/fixture/clock.ts`*, `src/fixture/descriptor.ts` | Freeze. Its crash points use B's controller; its durable checks need D | **Yes** |
| **F. 0.4.0 kit** | stdio (`src/stdio.ts`, reuses `createMcpServer`), container with `/mcp` bearer token and refusal to start without it (X1), X5 caps, CI (Linux/macOS/Windows, Node 22 and 24), CONTRIBUTING, stability policy, patterns page, OpenAPI | `src/mcp/server.ts` (transport and auth parts), `src/stdio.ts`*, `Dockerfile`*, `.github/workflows/tiny-tracker*.yml`*, `CONTRIBUTING.md`*, `docs/patterns.md`*, `openapi.yaml`* | Nothing beyond Phase 0. OpenAPI is final after A and B | **Yes** |

\* new file.

**Sequential, after the streams:** the 0.4.0 pairwise known-answer matrix; the T3 three-way recount (ledger, journal replay and export: A, B and D merged); each release's `expected/` files and its default-feature flip, at release time; the durable A5 run (D and E).

## 4. Files that will conflict, and the rule for each

| File | Rule |
|---|---|
| `src/profile.ts` | Each stream edits only its own rows of `FEATURES`: A (`execution-records`, `lookup`, `principals`), B (`ledger`, `faults`, `evidence`), D (`durable`, `inflight`, `retention`), E (`clock`). `PROFILE_FEATURES.default` is set by the lane lead at release time. |
| `src/compat.ts` | Append only. Reserved rule ids: A `CMP-20`–`29`, B `30`–`39`, C `40`–`49`, D `50`–`59`, E `60`–`69`, F `70`–`79`. Existing rules are not edited. |
| `src/fixture-properties.ts` | Append only. New FX ids in the stream's own family (A: DIG, LOOK; B: FLT, BLD; D: DUR, KEY). |
| `src/backend/store.ts`, `src/backend/http.ts` | A owns them. D writes only its delimited block in `store.ts`. B and E plug in through `sinks`, `clock` and `extension`, never by editing. |
| `src/cli.ts` | E owns it. Others add their flags in one block each, marked `// ---- stream X ----`, after the `parseArgs` options and after the fixture-layer start. |
| `src/mcp/server.ts` | F owns it. B uses `ServerExtras.onResult` only. A adds tools through `src/mcp/build.ts`. |
| `src/defects/index.ts`, `src/backend/defects/index.ts` | Append the import and the array entry only. |
| `package.json` | The lane lead only. A stream lists the `files`, `bin` or `scripts` changes it needs in its gate note. |
| `FIXTURE.md`, `README.md`, `CHANGELOG.md` | Each stream writes its section into `docs/streams/<X>.md` and its CHANGELOG lines under `## Unreleased` in its own `### Stream X` subsection. The lane lead merges the text into FIXTURE.md and the README at release. |
| `test/golden/surface-0.1.0.json`, `test/surface.test.ts` | Nobody edits them. A stream that breaks the 0.1 surface has a defect. |
| `schemas/*`, `src/records.ts` | Additions only, in both places in the same commit, through the lane lead (§1.5). |
| Ports | Tests use 4600–4699 only, or port 0. Ports in use today: 4610–4613 (golden capture), 4620–4623 (surface), 4630–4633 (import graph), 4650–4655 (foundation), 4660–4679 (fixture; the attribution test uses port 0), 4690–4699 (schemas, interfaces). Reserved per stream: A 4600–4605, B 4606–4609, C 4614–4619, D 4634–4641, E 4642–4649, F 4683–4689. A test reuses its ports sequentially and never binds outside its slice. |

**Merge order** within a release: A → B → C for 0.2.0; D → E for 0.3.0; F at any time. A stream that finishes early rebases on whatever has landed and keeps every suite green, including `test/surface.test.ts`.
