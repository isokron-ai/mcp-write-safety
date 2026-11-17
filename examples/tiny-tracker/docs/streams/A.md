# Stream A: the 0.2.0 evidence core

This section goes into FIXTURE.md and the README at the 0.2.0 release. It covers execution records, lookup by idempotency key, principals, run tags on objects and the run-scoped reset.

## Features

| Feature | What it adds | Needs |
|---|---|---|
| `execution-records` | One execution record per applied write, `X-<seq>` from the store's commit sequence. Every committed write's answer carries `Tiny-Tracker-Execution: X-<seq>`; a keyed replay carries the id of the write it answers for. `GET /executions/:id` with the caller's own backend token shows that principal's records. Request bodies holding a string that is not well-formed Unicode are refused (400 `not_well_formed`), because a record serves canonical bytes of the request and the result. | — |
| `lookup` | `GET /operations/:key` with the caller's own backend token: the operation record of that key in that principal's scope (D5: never scoped by run). A miss answers 404 `no_record`, "no record of this key now; this does not mean nothing was written". MCP tools `get_operation` and `get_execution`, both `readOnlyHint: true`. | `execution-records` (CMP-20) |
| `principals` | `TRACKER_BACKEND_TOKENS_FILE`: a 0600 JSON file `{"principals":[{"id":"p-…","token":"…"}]}`. Every token must differ from every other one, the evidence and control tokens included, and none may be on the command line. In `tiny-tracker all` the MCP server talks to the backend as the first principal, or as the principal whose token `TRACKER_BACKEND_TOKEN` gives. Runs only where the backend runs (CMP-21). Profile 0.1 never reads the file. | — |

## Records

**Execution record** (`schemas/execution-record-1.schema.json`). It holds:
- `principal`, `run` and `operation_tag`. The tags come from `Tiny-Tracker-Run` and `Tiny-Tracker-Operation`, which the MCP layer stamps outside every handler (rule 3).
- `boot_id`, the process's. In `tiny-tracker all` with the fixture layer it is the build descriptor's.
- `request`: `method`, `path`, `key` and `fingerprint_hash` (`request-fingerprint/1`).
- `objects`.
- `result`: the committed response body's RFC 8785 bytes and their SHA-256 under `execution-result/1`. For a 204 it holds the bytes `null`.
- `committed_at`: the commit's one record-clock read (`CommittedTransaction.committedAt`), the same value as the objects' `created_at`/`updated_at` and the key record's time. Also `clock_offset_ms`.

A replay serves the same record: a keyed replay, and a re-sent conditional write (`idempotent-replayed`) both carry the `Tiny-Tracker-Execution` of the write they repeat. A run reset is a commit with no execution record, so execution ids skip its sequence number. The digest is taken through the `digest` seam each time a record is read. The correct seam hashes the committed body, which never changes.

**Operation record** (`schemas/operation-record-1.schema.json`). In 0.2.0 its `state` is always `completed` and `expires_at` is null; pending, aborted and expired arrive with 0.3.0. `fingerprint_hash` is the execution record's. `result_digest` is taken over the stored reply through the digest seam, so a stored answer that drifts from the committed result shows as a mismatch.

## Reading the evidence across principals

`store.evidence` (and `RunningBackend.evidence`) is an `EvidenceReader`: the `EvidenceSource` plus `principals` and `serve(pathname, query)`. The evidence namespace answers `GET /executions/:id` and `GET /operations/:key` with it:
- `?principal=<id>` names whose records to read. It is required when more than one principal is configured (400 `principal_required`); with one principal it defaults to that one. An id that is not configured is 400 `unknown_principal`.
- Every answer names `principal`. A miss is 404 `no_record`, "no record of this key now; this does not mean nothing was written".

## Container mode

`TRACKER_EVIDENCE_LISTEN=HOST:PORT` (with `evidence`, in `tiny-tracker all`) starts a second listener on that address. It serves the evidence routes only, behind the evidence token; every other path answers 404 there, the API included. The API itself stays on 127.0.0.1. The state line names the listener as `evidence_listener`.

On this listener the evidence namespace's loopback-Host check is replaced by the token: the request is passed on as a loopback request. A build with defects refuses a non-loopback address. The container (stream F) sets `TRACKER_EVIDENCE_LISTEN=0.0.0.0:<port>` and publishes that port.

## Run tags on objects and the run reset
- Owners travel in the transaction (`post.owners`, seams v2). The store keeps who made each project and ticket beside the object, never in it, so no answer changes.
- `Store.dropRun` / `RunningBackend.dropRun` (seams v2) is a `run-reset` commit.

## Defects (0.2.0)

| Defect | Trips | Layer | Needs |
|---|---|---|---|
| `digest-of-current-state` | FX-DIG-1 | backend (`digest`) | execution-records |
| `replay-digest-mismatch` | FX-DIG-2 | backend (`keyRecord`) | execution-records |
| `digest-not-canonical` | FX-DIG-3 | backend (`digest`) | execution-records |
| `lookup-wrong-record` | FX-LOOK-1 | backend (`lookup`) | execution-records, lookup |
| `lookup-reexecutes` | FX-LOOK-2, MWS-ANN-1 | MCP (`get_operation`) | execution-records, lookup |
| `lookup-unscoped` | FX-LOOK-3 | backend (`lookup`) | execution-records, lookup, principals |

Each backend defect wraps the seam it replaces, so with all six on none hides another. The lookup defects index committed keys through `BackendOps.observers`. All six are in the main registries with `requires`; the self-test runs `lookup-reexecutes` with its features on, against MWS-ANN-1. `test/fx.test.ts` shows:
- each defect trips exactly what this table lists;
- the correct build holds every property;
- with all six on, every property is violated.

`--defect all` takes `lookup-reexecutes` only when `lookup` is on.

## Default profile (0.2.0)

`default` turns on `execution-records`, `lookup` and `principals`. `--profile 0.1` is unchanged and keeps the 0.1.0 surface call for call.
