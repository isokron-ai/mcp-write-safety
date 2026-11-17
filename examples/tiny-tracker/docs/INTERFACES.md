# Frozen interfaces for the parallel build of 0.2.0, 0.3.0 and 0.4.0

Status: frozen at the seams commit on top of Phase 0 (`469e92c`), revised by seams v2 (on `9754124`): the complete `CommittedTransaction`, replayed conditional writes, journal line numbering, the run reset through the commit path, the fault hooks, owners, principals and one ports table. Revised by seams v2.1 (on `e4b42b6`, coordinator note 7 and stream D's input): key-record states and the frozen keyed branch order, `abort(scope, key, reason)` that never throws, fenced keys, `principal` on applied-write entries, `request: null` for a run reset, `afterJournal` fail-stop, random run ids and refusal of unallocated run tags, the `fence` and `run-alloc` journal lines, the torn-line rule, `?principal=` on executions, and `durable` requiring `strict-input`. Six streams build against this page without talking to each other. A stream that needs to change anything listed here does not change it in its branch: it writes the change into its gate note, and the lane lead lands it as a separate commit that every stream rebases on.

`test/interfaces.test.ts` and the tests named below hold these contracts.

## 1. Frozen contracts

### 1.1 The commit path (`src/backend/commit.ts`, `Store.commit`)

- **One entry point for writes.** Every write the backend applies goes through `Store.commit(meta: TxMeta, mutate: (seq) => SectionReply, afterJournal?: (tx, reply) => void, kind?)`. The section is synchronous, and `Store.commit` refuses a thenable. Commit sections do not nest.
- **Frozen order** (`COMMIT_STEPS` = `pending`, `validate`, `journal`, `apply`, `ledger`, `reply`; `SECTION_STEPS` = the four in the middle):
  0. **Before the section (may await).** `BackendOps.beforePatch` (a backend defect's read and wait), then on a keyed write under 0.3.0 `inflight` the pending record (`InflightKeyRecordSeam.begin`), then the `backend/before-commit` fault hook (`BackendOptions.faults.beforeCommit`). Nothing is validated or written yet.
  1. **Validate and compute.** `mutate` runs; validation and the store changes are one call. A refusal (an `ApiError`) changes nothing; `onRefusal` is called and the error is thrown. A reply with `replayOf` (a re-sent conditional write that was already applied) changes nothing and goes to `Store.replay` with `originalSeq = replayOf`: no commit sequence, no journal line, an `onReplay` event.
  2. **Journal append.** The sink with `role: "journal"` (at most one) gets `onCommit` first.
     - If it throws, every `Store.STATE_FIELDS` value is put back (objects, id counters, applied-write log, owners, commit sequence). Nothing is applied and no key is held; the pending record is aborted.
     - The ledger is told: `onRefusal` with status 503 and code `journal_unavailable` (ledger kind `journal-unavailable`). The request gets 503 `journal_unavailable`, and the store carries on.
  3. **Apply.** The write is now in effect. `afterJournal` completes the key record with `storedReplyOf(tx)`. If `afterJournal` throws, the ledger and observers are still told of the commit, then the store stops (fail-stop, `CommitSinkError` named `afterJournal`, 503 `stopped`): the write is journalled and applied, so the evidence must have it.
  4. **Ledger, then observers.** Every `role: "ledger"` sink first, then every `"observer"`, each group in the order added. Backend defects that watch commits add observers through `BackendOps.observers` (added after the sinks given to `startBackend`), never through `store.addSink` from a side registry. If a sink throws, the store stops: every later request gets 503 (fail-stop).
  5. **After the section.** The `backend/after-commit` fault hook (`faults.afterCommit`), then the reply.
- **`CommitSink`.** Its shape is `{ name; role: "journal" | "ledger" | "observer"; onCommit(CommittedTransaction); onReplay?(ReplayedTransaction); onRefusal?(RefusedTransaction) }`. Sinks are synchronous; the journal flushes with `writeSync` + `fsyncSync`. They are given as `startBackend({ sinks })` or added with `store.addSink`.
- **`TxMeta`.** It carries:
  - `principal`;
  - `attribution { run, operation }`, from `Tiny-Tracker-Run` and `Tiny-Tracker-Operation`, with a malformed tag set to `null`;
  - `request { method, path, key, fingerprint, fingerprintHash, body }`, or **`null` for a run reset** (`Store.dropRun`, its commit and its refusal): no client request carries it, so its ledger entry has `request: null` and no `fingerprint_hash` is made up. A client write always has one (`WriteMeta`). Fields:
    - `key` is the Idempotency-Key of a keyed POST, else `null`: a key header on a PATCH, PUT or DELETE is ignored and not recorded, so an execution record never names a key that has no key record.
    - `fingerprint` is the backend's own key-reuse comparison string `METHOD path canonicalJson(body)` for a keyed POST, else `null`. Records never hash it.
    - `fingerprintHash` is the records' `fingerprint_hash`, computed once by the HTTP layer for every write: `fingerprintHash(principal, method, path, body)` (see below). Sinks use it as given.
    - `body` is the parsed request body, or `null`.
- **Events.** Every event carries `bootId`, `at` (wall time), `clockOffsetMs` and `status`. A replay adds `body` and `originalSeq`; a refusal adds `code`.
- **`CommittedTransaction`** (complete post-state: replaying a journal's commits onto its header's seed rebuilds the store with no clock call and no operation re-run; `test/interfaces.test.ts` does exactly that):
  - `kind`: `"write"` (a client request; it has an execution record) or `"run-reset"` (`Store.dropRun`; no execution record).
  - `seq`, `committedAt`, `body` (the response as committed), `headers` (the reply headers as committed, the ETag among them), `objects`.
  - `post.upserts { projects, tickets }`: every object created or changed, whole (comments and labels inside, so a batch carries every ticket's state and its new label ids).
  - `post.deletes { projects, tickets }`: keys and ids removed; their owners and applied-write entries go with them.
  - `post.counters { ticket, label, comment }`: the id counters after the commit.
  - `post.owners`: the owners of the objects the commit created (below).
  - `post.applied`: the applied-write entries the commit added, each `{ ticket, principal, fromVersion, toVersion, fingerprint, seq }`.
  - `reset { principal, run, objects, keys }` on a run reset; `keys` is `null` when the journal is told and the count by the time the ledger is told.
- **`committedAt`: one record-clock read per commit.** `Store.commit` reads `Clock.now()` once at the start of the section. Every time the write stores (`created_at`, `updated_at`, a comment's `created_at`), the key record's `committedAt` and the execution record's `committed_at` are that value. Journal replay (`applyPostState`) reuses the stored value and never recomputes it.
- **The commit sequence.** `seq` counts commits only, starting at 1. It is never reused. A refusal, a replay (keyed or conditional) and an aborted write consume none. A run reset consumes one.
  - A write's execution record is `X-<seq>`, and its `seq` is this value; execution ids skip the seq of a run reset.
  - It is **not** a journal line number (§1.9). The ledger keeps its own `seq` and links by `execution_id`.
- **Object owners (decided: owners travel in the transaction).** The store keeps who created each project and ticket (`principal`, and the run tag of the creating request) beside the objects, not in them, so the 0.1 surface is unchanged. `post.owners` carries the new entries; `applyPostState` restores them from the line; there is no separate `recordOwners` call. `Store.ownerOf(ref)` reads them, and the run reset and run-ownership checks use them. The seed has no owner.
- **Re-sent conditional writes.** The applied-write log stores the `seq` and the `principal` of the commit that applied each entry, and keeps the **last 20 entries per ticket** (`Store.APPLIED_CAP`; an older re-send gets the normal 412). An If-Match PATCH or PUT re-sent **by the same principal** after it applied, with nothing changed since, is answered `idempotent-replayed: true` and reported as a replay of that `seq`. Another principal sending the same write gets the normal 412 `precondition_failed` (seams v2.1 fixed a replay across principals).
- **The backend fault hooks** (`BackendOptions.faults: BackendFaultHooks`). Streams B and E arm backend faults here, without editing `http.ts`:
  - `beforeCommit({ meta }) → Promise<void>`: `backend/before-commit`, after the pending record and before the section. Throw an `ApiError` to answer with it (reported as a refusal; the pending record is aborted); await to delay (the `delay` action); exit to crash. On a keyed write without a pending-record seam the key record is looked up again after the hook, so a same-key request that committed meanwhile is answered as a replay, never applied twice.
  - `afterCommit({ meta, tx }) → Promise<undefined | "drop" | { status, body }>`: `backend/after-commit`, only for a committed write. `undefined` sends the reply; `"drop"` closes the connection with no answer; `{ status, body }` answers that instead (the `error` action). Await to hold; exit to crash.
- **The keyed path** (`http.ts`, A owns it; D's call sites are in place). Every step below is inside one `try`, so every answer reaches the ledger.
  1. `get(scope, key)` returns `KeyRecordState | undefined`, answered in this **frozen order**:
     - `{ state: "completed", reply }`: same backend fingerprint → the stored reply, `idempotent-replayed: true`, a replay of `reply.seq`; else 422 `idempotency_key_reused` (a refusal).
     - `{ state: "pending", since }`: 409 `in_progress` (body carries `since`), a refusal in the ledger; the MCP layer reports outcome `unknown`, `repeat: same_key` (rule 4, decision 0004). Nothing begins.
     - `{ state: "fenced", run }`: 409 `key_fenced`, a refusal. Nothing begins. The key's pending record was ended by a run reset; it stays fenced for the life of the store.
     - `{ state: "expired", tombstone }`: the B10 answer. `tombstone.fingerprintHash` equals `request.fingerprintHash` → **410 `key_expired`**, `idempotent-replayed: true`, body `{ error, message, execution_id, result_digest, committed_at }`, told to the ledger as a replay of the tombstone's commit (`originalSeq` from `execution_id`); the MCP layer reports outcome `applied`, `replayed: true`, `repeat: read_first`. A different fingerprint → 422 `idempotency_key_reused` (a refusal).
     - `undefined` → begin.

     The order between `pending` and `fenced` doesn't matter: they can't both hold (a fence ends the pending record).
  2. `begin` (only when the seam `isInflight`). A throw from `begin` is told to the ledger (an `ApiError` as its refusal; a `JournalError` as 503 `journal_unavailable`; any other throw as 500 `internal`). A `begin` that throws leaves no pending record of its own, so `abort` is **not** called for it (it could end another request's record; G1 fold-in, coordinator note 11).
  3. `beforeCommit`. Without a pending-record seam the key record is looked up again after it (step 1's order). With one, the write re-checks its own record: `fenced` → 409 `key_fenced`, nothing applied and no `abort` (the fence ended the record); anything but `pending` → an internal error (aborted `internal_error`).
  4. The section; its `afterJournal` marks the write committed, then calls `put(scope, key, storedReplyOf(tx))`.
     Before it, every write (keyed or not) checks that no run it touches was reset during the awaits before the section (`BackendOps.beforePatch`, `beforeCommit`): the request's own run tag, and the run that owns the ticket its path names (`/tickets/:id...`, from `Store.ownerOf`; G1 review fold-in 5). `Store.resetCount(principal, run)` is read before them and compared after; a change → 409 `run_reset`, a refusal, nothing applied (G1 fold-in, coordinator note 11; with a pending-record seam the fence answers first, 409 `key_fenced`). Any throw that is not an `ApiError`, `JournalError` or `CommitSinkError` is told to the ledger as a refusal, 500 `internal`, so every answer reaches the ledger.
  5. `afterCommit`, then the reply.
- **`abort(scope, key, reason)`** is called on every way out after `begin` that commits nothing, with the reason: `fault` (the `beforeCommit` hook threw, an armed `ApiError` included; the ledger still records that `ApiError` as a refusal), `refused` (an `ApiError` from the section, or a reply of 300 and above), `journal_unavailable` (`JournalError`), `internal_error` (any other throw). D writes `orphan_at_start` at load. **`abort` never throws:** it runs where the answer is already decided (a 503, say); the keyed path also wraps it, logging any error and keeping the answer. `abort` must accept a key with no pending record. A committed write is never aborted, even when `put` throws (fail-stop, step 3 of the commit order).
- **Run tags and principals in the backend.** `BackendOptions.runOwner(run)` (the fixture layer's run registry) names the principal a run belongs to. The CLI gives it only when the control listener allocates runs (`--fixture-control`). When it is given:
  - a write tagged with another principal's run is refused 403 `run_not_owned`;
  - a write tagged with a run the registry **never allocated** is refused 403 `run_not_allocated` (seams v2.1);
  - `Store.dropRun` of a run never allocated is refused 404 `run_not_allocated`.
  Each is reported as a refusal. Without `runOwner` a run tag is a tag only.
- **Run ids** are `run-<boot8>-<12 random hex>` (seams v2.1): the boot id is public, so a counter suffix was guessable. `RunRegistry.onAllocate(run)` runs before a run is registered or answered (the 0.3.0 journal appends a `run-alloc` line there; a throw refuses the allocation with 503 `journal_unavailable` and registers nothing), and `RunRegistry.restore(run)` puts a journalled run back at load, so the 403 checks hold after a `--supervise` restart. `FixtureLayer.runs` exposes the registry.
- **`fingerprint_hash`.** In every record it is `fingerprintHash(principal, method, path, body)`: SHA-256 under `dev.writesafety.tiny-tracker/request-fingerprint/1` over the RFC 8785 bytes of `{body, method, path, principal}`. It is in the vectors, in Node and Python, and it is `TxRequest.fingerprintHash`.

### 1.2 The clock (`src/clock.ts`)

- The interface is `Clock { domain: "wall" | "fixture"; now(): Date; wallNow(): Date; offsetMs(): number }`, and `wallClock` is the default.
- Every timestamp goes through a `Clock`. Nothing in `src/backend` or `src/fixture` calls `new Date()`.
  - `now()` gives record times: `created_at`, `committed_at`, `expires_at`, and a run's `created_at`. Inside a commit it is read once (`committedAt`, §1.1).
  - `wallNow()` gives the times a schema says are wall time: an event's or ledger entry's `at`, and the descriptor's `started_at`.
- It is given as `new Store(seed, clock, bootId)`, `startBackend({ clock })`, `createFixtureLayer({ clock })`, `new BuildDescriptor(input, clock)` and `new RunRegistry(bootId, clock)`. The fixture clock (stream E) implements it.

### 1.3 Backend seams (`src/backend/seams.ts`; names in `BACKEND_SEAMS`)

| Seam | Interface | State | Implemented by |
|---|---|---|---|
| `patchTicket` | `BackendOps.patchTicket` (sync, inside the section) plus optional `beforePatch` (async, before it) | wired | — |
| `inputRules` | `InputRules { checkKey; checkStrings }` | wired | — |
| `keyRecord` | `KeyRecordSeam { get(scope, key): KeyRecordState \| undefined; put(scope, key, StoredReply); dropRun(scope, run) }`; `KeyRecordState` = `{state: "completed", reply}` \| `{state: "pending", since}` \| `{state: "fenced", run}` \| `{state: "expired", tombstone: KeyTombstone}` | wired (memory: `completed` only) | A uses it; D replaces it with `InflightKeyRecordSeam` (`begin`, `abort(scope, key, reason: AbortReason)`, `tombstone`; `isInflight(seam)` selects the call sites) |
| `digest` | `DigestSeam { resultDigest(body): ServedDigest }` | named | A |
| `lookup` | `LookupSeam { find(scope, key): StoredReply \| undefined }` | named | A |
| `journal` | `JournalSeam extends CommitSink { load(); recordRun(run); close() }` | named | D |
| `keyExpiry` | `KeyExpirySeam { retentionMs; expiresAt(d); isExpired(reply, now) }` | named | D |

**`dropRun` and pending records.** `KeyRecordSeam.dropRun(scope, run)` removes the run's completed records and returns how many. An `InflightKeyRecordSeam` also **fences** the run's pending records (not counted): each becomes `{state: "fenced", run}`, and under `durable` a journal `fence` line ends its pending line (no `aborted` line). The held write finds the fence after `beforeCommit` and is refused 409 `key_fenced` (§1.1), so a write in flight when its run is reset never lands after the reset. Writes that hold no pending record (unkeyed writes, or keyed writes on the memory seam) and are held at `beforeCommit` across a reset commit after it, as writes that arrived after it.

A backend defect replaces a seam by assigning the `BackendOps` member. Its file declares `seams` and `requires`. A backend defect that watches commits sets `BackendOps.observers` (§1.1).

### 1.4 Key-record scope (D5), principals and runs (`src/principals.ts`, `src/backend/seams.ts`)

- **Scope.** `KeyScope = { principal }`, so key records are scoped by (principal, key). The run is recorded on every key record (`StoredReply.run`) but is never part of a lookup.
- **Runs are scoped per principal.** A run is allocated for one **configured** principal (`POST /_fixture/runs {"principal": "p-…"}`, default `p-default`; an id that is not configured is 400 `unknown_principal`). `KeyRecordSeam.dropRun(scope, run)` and `Store.dropRun(scope, run)` touch only that principal's records, and the backend refuses another principal's run tag (§1.1).
- **Principals.** The operator assigns ids; they are never derived from a token.
  - `TRACKER_BACKEND_TOKENS_FILE` is a 0600 JSON file of the form `{"principals":[{"id":"p-…","token":"…"}]}`.
  - Ids match `^p-[a-z0-9-]{1,62}$`.
  - Without the file there is one principal, `p-default`, holding `TRACKER_BACKEND_TOKEN`.
- **All tokens differ** across every principal, evidence and control (`src/tokens.ts checkDistinct`). That rule and the refusal of a token on argv run on every start, with or without the fixture layer.
  - The argv check looks for a token of 8 characters or more anywhere in an argument. A shorter one (only a 0.1-style backend token can be that short) must equal a whole argument, or the part after `=`; it is never skipped.
- **Authentication.** `principalFor(header, principals)` compares in constant time. `startBackend({ principals })` accepts the list.
- **Stream A's obligations (0.2.0, feature `principals`):**
  - wire `TRACKER_BACKEND_TOKENS_FILE` into the command line (until then the CLI refuses the variable, in a block marked `// ---- lane lead: principals ----` that A replaces);
  - put every principal token into the start-up checks (`checkDistinct`, `checkArgv` in `cli.ts`) and give the list to `startBackend({ principals })` and `createFixtureLayer({ principals })`, which uses it for its own checks and gives the ids to the control listener;
  - give `runOwner` and `bootId` from the fixture layer to `startBackend` (the CLI does this now for `all`).
- **Evidence reads across principals (frozen for A, B, C and the OpenAPI; revised in seams v2.1).** The evidence token is read-only and may read any principal's records. Every response names `principal`. The A5 delayed leg reads with the writing principal's id. F's OpenAPI documents the parameters this way.
  - `GET /operations/:key?principal=<id>`: keys are per principal, so the parameter is **required** when more than one principal is configured (400 `principal_required` without it), and defaults to the single configured principal otherwise.
  - `GET /executions/:id[?principal=<id>]`: execution ids are global, so the parameter is **optional** under any number of principals. Given and equal to the record's principal: the record. Given and different, or naming no configured principal: **404 `not_found`**, the same body as an unknown id, so it leaks neither the record nor whose it is.
- **Container mode (stream A's obligation, owner decision):** in container mode the evidence routes listen on all interfaces, behind the evidence token only; A builds the bind switch, F's container uses it.

### 1.5 Records (`src/records.ts`, `schemas/*-1.schema.json`)

- The field names of `ExecutionRecord`, `OperationRecord` and `LedgerEntry` are frozen. `RECORD_FIELDS` equals each schema's `required` and `properties` order, and the examples. This is checked at compile time and by a test.
- **Additions do not need a new version.** A `/1` schema allows additional top-level members, and a consumer ignores members it does not know. A new member is added to the schema, the type and the example in one commit. Renames and removals mean `/2`.
- **`EvidenceSource`** (`seams.ts`) is the read side, `{ execution(id); operation(scope, key); executions() }`. Stream A provides it, stream B serves it, and A's tools call it.
- **`ExecutionRecord.committed_at`** is `CommittedTransaction.committedAt`; `request.fingerprint_hash` is `TxRequest.fingerprintHash`. The nested `request` object allows additional members, like the top level.
- **Ledger kinds** add `journal-unavailable` (a write whose journal append failed; status 503, `execution_id` null). A `run-reset` entry is written from the reset's `CommittedTransaction` (`tx.reset`).
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

- **`Store.dropRun(scope: KeyScope, run): { objects; keys; tx }`** (built in seams v2, through the commit path). It removes the projects and tickets one principal's run created (by owner, §1.1; a project that still holds another run's ticket stays) and that run's key records, as one commit of kind `run-reset`: journalled, so a restart does not bring them back, and told to the ledger with `tx.reset`. It is refused 403 `run_not_owned` when the run belongs to another principal. `RunningBackend.dropRun` is the same call; B's reset route calls it.
- **D's block at the end of the `Store` class**, marked `// ---- stream D: journal replay ----` … `// ---- end stream D ----`, lands with two stubs that throw until D builds them:
  - `applySeed(seed: SeedState)`: replaces the constructor's seed with the journal header's;
  - `applyPostState(tx: CommittedTransaction)`: restores one commit line: upserts, deletes, counters, owners, applied-write entries and the commit sequence, with no clock call. Key records are rebuilt from the same line with `storedReplyOf(tx)`; a `run-reset` line drops `tx.reset`'s key records.
- **`--token-dir DIR` (D1), built.**
  - DIR is created 0700. An existing DIR that others can read, that is a symbolic link (checked with `lstat`, never followed) or that another user owns is refused. The token files get the same checks.
  - `evidence.token` and `control.token` are generated there (0600, created with `wx`) when the environment gives none, and are reused on restart. A token the operator supplies by environment or file wins.
  - Two starts at once on one folder: the second sees `EEXIST` and reads the file; if it is still empty it stops with "another tiny-tracker is starting with the same --token-dir".
  - The state line prints `"tokens": "<DIR>"`, never a token.
  - `--token-dir` without a fixture feature exits 2.

### 1.9 The journal's lines (`journal-format/1`; types in `src/backend/commit.ts`, written and read by D)

- Every line carries **`jseq`**: its own number in the file, from 0 (the header), contiguous, never reused. A reader checks it; nobody counts lines.
- **Header** (`jseq` 0): `{ line: "header", journal: "journal-format/1", writer, boot_id, seed: { projects, counters } }`. **The seed lives in the header**: a restart restores the seeded projects, `created_at` included, with `applySeed`, instead of seeding fresh ones.
- **Commit line:** `{ line: "commit", commit_seq, pending_jseq, tx }`. Only a commit line has `commit_seq`; it equals `tx.seq` and the execution record's `seq`. `pending_jseq` names the pending line it completes, or is `null`.
- **Pending line** (0.3.0 `inflight`): `{ line: "pending", principal, key, fingerprint, run, created_at, clock_offset_ms }`. It has no `commit_seq`: it is written before the section, when the commit's number is not known.
- **Aborted line:** `{ line: "aborted", pending_jseq, reason }`, `reason` one of `refused`, `journal_unavailable`, `orphan_at_start`. It ends a pending line nothing applied for: a refusal, a fault-hook error, a journal failure, or a pending line with no commit found at start (D writes the aborted line before serving).
- **Fence line** (seams v2.1, 0.3.0 `inflight`): `{ line: "fence", principal, key, run, pending_jseq, reset_seq }`. Written when a run reset (`KeyRecordSeam.dropRun`, in the reset's apply step, after its commit line, `reset_seq` = that commit's `commit_seq`) fences a pending record. It ends the pending line it names (no `aborted` line for it), and at load it restores `{state: "fenced", run}`, so the key stays refused (409 `key_fenced`) across a restart. **Fenced keys never expire** (owner decision, 16 Nov 2026): a fence lasts for the life of the data dir, like a tombstone; retention does not remove it and the key is never reusable.
- **Run-alloc line** (seams v2.1, decided: allocating a run gets a journal line): `{ line: "run-alloc", run_id, principal, created_at, label }`. Written by `JournalSeam.recordRun` from `RunRegistry.onAllocate` before the run is answered; at load each goes back with `RunRegistry.restore`. It has no `commit_seq` and takes no commit sequence.
- The aborted line's `reason` is `AbortReason` (`src/backend/seams.ts`): `refused`, `journal_unavailable`, `fault`, `internal_error`, `orphan_at_start`.
- Every line has `checksum`: lower-case hex SHA-256 of the line's RFC 8785 bytes without `checksum`.
- **Torn lines (seams v2.1).** Only a torn **last** line is tolerated at load. "The store carries on" after a journal failure must not leave a torn line mid-file, so: after a failed append, D's journal **truncates the file back to the end of the last good line** (`ftruncate`, then `fsync`) before any later append, and keeps its next `jseq`; if it cannot truncate, it **fails stop**: every later append throws, and every write answers 503. A journal never appends after a partial line. (Decision 0003, section 5.)

## 2. D1–D6: coordinator answers, approved by the owner

These are the coordinator's answers (16 Nov 2026, NOTE-FROM-COORDINATOR-TT-UPGRADE-3), approved by the owner on 16 Nov (21:17 AZ, "go with your recommendations"). The owner did not write them; he approved the coordinator's recommendations as a set. If one needs his own call later, the coordinator brings it to him.

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
| **A. 0.2.0 core** | The 0.2.0 default-feature flip (with its edits to `test/surface.test.ts` and `test/cli.test.ts`; the golden transcript itself is never edited), execution records, `digest`/`lookup` seams, `EvidenceSource`, `get_operation`/`get_execution`, principals wiring, run-tagged objects, `Store.dropRun`, the FX-DIG/FX-LOOK defects, `test/fx.test.ts` | `src/backend/store.ts`, `src/backend/http.ts`, `src/backend/execution.ts`*, `src/backend/lookup.ts`*, `src/mcp/tools/operations.ts`*, `src/mcp/build.ts`, `src/backend/defects/*` (new files), `test/surface.test.ts` and `test/cli.test.ts` (for the flip only), `src/defects/lookup-*.ts`*, `test/fx.test.ts`* | Freeze (this commit) | **Yes** |
| **B. 0.2.0 fixture** | Ledger as a `CommitSink`, fault controller plus `mcp/after-backend-reply/drop` via `onResult`, evidence routes over `EvidenceSource`, run reset, `--token-dir` (D1) | `src/fixture/*` (except `clock.ts`), `src/fixture/ledger.ts`*, `src/fixture/faults.ts`* | Freeze. Its final wiring needs A's `EvidenceSource` and `dropRun`; build against a fake until then | **Yes** |
| **C. 0.2.0 harness** | Python adapter (MWS-repo copy pinned to the contract), `fx-check`, the `expected/` generator | `harness/`*, `expected/`*, `src/fx-check.ts`*, `verify/python/*` (new files) | Schemas and endpoints. Final runs need A and B merged | **Yes**, against the schemas and the 501 stubs |
| **D. 0.3.0 durability** | Journal as `JournalSeam`, `InflightKeyRecordSeam`, `KeyExpirySeam`, data-dir lock, `Store.applyPostState`, T1 crash points, T2 seeded histories | `src/backend/journal.ts`*, `src/backend/keyrecords.ts`*, `src/backend/expiry.ts`*, `test/crash.test.ts`*, `test/histories.test.ts`*, the block at the end of `store.ts` marked `// ---- stream D: journal replay ----` | Freeze. **Merges after A** (it needs A's run-tagged post-state) | **Yes**; rebase onto A before merging |
| **E. 0.3.0 process and clock** | `--supervise` (two children), arming state outside argv, `boot_id`/`restart_count`, fixture clock as `Clock`, crash points | `src/cli.ts`, `src/supervisor.ts`*, `src/fixture/clock.ts`*, `src/fixture/descriptor.ts` | Freeze. Its crash points use B's controller; its durable checks need D | **Yes** |
| **F. 0.4.0 kit** | stdio (`src/stdio.ts`, reuses `createMcpServer`), container with `/mcp` bearer token and refusal to start without it (X1), X5 caps, CI (Linux/macOS/Windows, Node 22 and 24), CONTRIBUTING, stability policy, patterns page, OpenAPI | `src/mcp/server.ts` (transport and auth parts), `src/stdio.ts`*, `Dockerfile`*, `.github/workflows/tiny-tracker*.yml`*, `CONTRIBUTING.md`*, `docs/patterns.md`*, `openapi.yaml`* | Nothing beyond Phase 0. OpenAPI is final after A and B | **Yes** |

\* new file.

**Defects that need a feature.** Streams A and D add feature-gated defects to `DEFECTS` (MCP layer) or `BACKEND_DEFECTS` with a non-empty `requires`, never to a side registry. The registry and the tests support them: `ungatedDefects()` is the 0.1 set (47) and the whole of `--defect all` without features; the self-test runs a gated defect with its `requires` features on; the README lists it in the "Defects that need a feature" table with a Requires column. The 0.1 golden is unaffected, because profile 0.1 has no features.

**`durable` requires `strict-input` (decided in seams v2.1, on stream D's input).** A journal line is checksummed over RFC 8785 bytes, which a request body with a lone surrogate does not have, so under `durable` without `strict-input` such a write would be refused 503 `journal_unavailable` after validation. Stream D adds the compat rule **CMP-50** in its range: `durable` without `strict-input` in the effective feature set exits 2 and names the missing feature. (`strict-input` refuses such strings at the door, 400, before anything is begun.)

**Compatibility rules see the effective feature set.** `checkCompat` evaluates each rule on the profile's features plus the named ones (`c.features`); only CMP-1 reads the named set (`c.named`). A rule such as CMP-5 therefore still refuses after a release flips its feature into the default profile.

**Sequential, after the streams:** the 0.4.0 pairwise known-answer matrix; the T3 three-way recount (ledger, journal replay and export: A, B and D merged); each release's `expected/` files and its default-feature flip, at release time; the durable A5 run (D and E).

## 4. Files that will conflict, and the rule for each

| File | Rule |
|---|---|
| `src/profile.ts` | Each stream edits only its own rows of `FEATURES`: A (`execution-records`, `lookup`, `principals`), B (`ledger`, `faults`, `evidence`), D (`durable`, `inflight`, `retention`), E (`clock`). `PROFILE_FEATURES.default` is flipped at release time; for 0.2.0, stream A does it (§3). |
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
| Ports | One table, below. Every new test binds port 0 and reads the address it got; no stream has a port slice. |

### Ports (the one table)

New tests use **port 0** only. A test that cannot (one that must know a port before it starts a process) asks the lane lead for a fixed port, which is added here first. Tests never touch 47310/47311 or a port outside this table.

| Port(s) | Bound by | Why fixed |
|---|---|---|
| 4610–4613 | `test/capture-surface.ts` (golden capture; a script, not a test) | none since seams v2: `recordSurface` binds port 0 and ignores `portBase` |
| 4630–4633 | `test/import-graph.test.ts` | started through the CLI with a known port |
| 4650–4655 | `test/foundation.test.ts` | started through the CLI with a known port |
| 4660–4669, 4677–4679 | `test/fixture.test.ts` | started through the CLI with a known port |
| 4690–4691 | `test/schemas.test.ts` | started through the CLI with a known port |

Freed by seams v2: 4620–4623 (`test/surface.test.ts` still gives a `portBase`, which is ignored), 4670–4672 (fixture control-listener test) and 4692–4699 (`test/interfaces.test.ts`), all now port 0. The per-stream slices of the first freeze and of the stream note (A 4600–15 and so on) are withdrawn.

**Merge order** within a release: A → B → C for 0.2.0; D → E for 0.3.0; F at any time. A stream that finishes early rebases on whatever has landed and keeps every suite green, including `test/surface.test.ts`.
