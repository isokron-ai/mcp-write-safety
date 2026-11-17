# Changelog

All notable changes to `@mcp-write-safety/tiny-tracker`, the sample server for the MCP Write-Safety Requirements. The format follows Keep a Changelog; versions follow Semantic Versioning once published.

## Unreleased

Groundwork for the shared-fixture releases (0.2.0 on). The default build's surface is unchanged: it is checked call for call against a transcript captured from the published 0.1.0 tarball.

### Added
- `--profile 0.1`: exactly the surface of the published 0.1.0, kept in every later release. `--profile default` is what runs when none is named.
- `--features` (`TRACKER_FEATURES`): strict feature switches; a name not built in this version stops the process (exit 2) and says which release builds it. Built now: `strict-input` (the backend checks idempotency keys itself and refuses strings that are not well-formed Unicode) and `evidence` (a stub: the read-only evidence namespace with `GET /build`, the build descriptor and its two hashes, mirrored in the MCP instructions and every result's `_meta`; run and operation tags from request `_meta` stamped on every backend request).
- `--fixture-control`: a separate, hardened loopback control listener with its own token (run ids; clock and fault tables, read-only for now).
- Tokens for the evidence namespace and the control listener are read from the environment or a 0600 file, never from the command line, and never printed.
- A compatibility table: illegal combinations of profile, features, defects, variants, faults and process layout stop the process (exit 2).
- Defects carry a `requires` list; `--defect all` means every defect valid for the active features. The backend has its own defect registry (seams, banner, refusal rules), and a computed defect placement map.
- `--token-dir`: a 0700 folder where evidence and control tokens are generated (0600) when not supplied; only its path is printed.
- Each write's committed transaction carries its complete post-state (objects, deletes, id counters, owners, applied-write entries), its request body and reply headers, the boot id and one record-clock time used for every stored time. A re-sent If-Match write that was already applied is reported as a replay, not a second commit. A journal failure is reported to the ledger. Backend fault hooks (before and after the commit section) and a run reset through the commit path.
- Seams v2.1: key records answer in a fixed order (completed, pending as 409 `in_progress`, fenced as 409 `key_fenced`, expired as 410 `key_expired`), and every keyed answer reaches the ledger. A run reset fences its run's pending keys, so a write in flight during the reset never lands after it. Run ids are random; with the control listener on, a run tag that was never allocated is refused. A generated token file is written whole before it appears.
- The backend's single commit path (validate, journal, apply, ledger, reply), an injected clock for every timestamp, typed backend seams, principals with key records scoped by principal, and frozen record field names (`docs/INTERFACES.md`).
- RFC 8785 canonical bytes and domain-tagged SHA-256 digests, with cross-language vectors (`vectors/digest-1.json`) and a standard-library Python verifier (`verify/python`).
- `FIXTURE.md`, JSON Schemas with `$id`s (`schemas/`), and decision records (`docs/decisions/`).

### Stream C
- `harness/`: the lost-response contract adapter 0.2.0 (`harness/adapters/tiny_tracker.py`), pinned to the contract at `92bf1ba`. It counts effects from the execution ledger, drops the lost response server-side (`mcp/after-backend-reply/drop`), serves exactly one digest (`result_digest`), recomputes it with the domain tag, and recovers by key alone through `get_operation`. A3's key-only verdict is labelled self-attested until the driver compares recovered digests. `harness/adapter_config.py` prints a config for a running build; `harness/selfcheck.py` exercises the adapter, or runs the driver itself.
- `fx-check` (`src/fx-check.ts`): checks a running fixture's FX- properties through its evidence API and answers each one held, violated, not checked or not applicable. Read-only by default; `--probe` writes probe tickets in a run of its own and resets it.
- `expected/generate.mjs`: generates known-answer files keyed by `build_hash`, by running each build; `expected/builds-0.2.0.json` lists the 0.2.0 builds.
- `verify/python/tt_recount.py`: recounts executions and objects from the export, the ledger, the execution records and (from 0.3.0) the journal, independently of tiny-tracker.

### Changed in the default profile (ships with 0.2.0; `--profile 0.1` keeps the 0.1.0 behaviour except where noted)
- The default profile turns on `execution-records`, `lookup` and `principals` (owner decision 1). `tools/list` gains `get_operation` and `get_execution` (18 tools), every committed write's answer carries `Tiny-Tracker-Execution`, and `--defect all` includes `lookup-reexecutes`; every other text and structured result is the 0.1.0 one. `TRACKER_VARIANTS=key-store-honest` turns `lookup` off for that build (lookup cannot see the keys the variant keeps; owner decision, 16 Nov 2026): the state line carries `features_off`, a notice goes to stderr, and the build descriptor and `build_hash` follow the features the build runs. A `lookup` named with `--features` or `TRACKER_FEATURES` alongside the variant is refused (CMP-5, exit 2). Under `--profile 0.1` the variant runs as in 0.1.0.
- `tiny-tracker server --backend-defect NAME` stops with exit 2 instead of starting with the backend defect silently unused (CMP-9).
- The `evidence` feature runs with `tiny-tracker all` only (CMP-11).
- A start whose command line holds one of its tokens (8 characters or more), or where two tokens are equal, stops with exit 2. This holds under every profile, `--profile 0.1` included.

### Fixed
- A re-sent If-Match write from another principal was answered as a replay of the first principal's write; it now gets the normal 412.
- A failure completing a key record after the journal append no longer skips the ledger: the ledger is told, then the store stops.
- The 0.1.0 entry below says "41 deliberate defects"; 0.1.0 shipped 47 MCP-layer defects and 1 backend defect.

### Stream A
- Feature `execution-records`: one execution record per applied write (`X-<seq>`), with the principal, the run and operation tags, the request's `fingerprint_hash` and the committed result's RFC 8785 bytes and digest. Each committed answer, and each replay, carries `Tiny-Tracker-Execution`; `GET /executions/:id` with the caller's token shows that principal's records.
- Feature `lookup`: `GET /operations/:key` in the caller's own scope; a miss answers "no record of this key now", which never means nothing was written. New read-only tools `get_operation` and `get_execution`, listed only with the feature.
- Feature `principals`: `TRACKER_BACKEND_TOKENS_FILE` (0600 JSON) gives two or more principals. Every token must differ and none may be on the command line; records and lookups are scoped to the principal.
- The evidence read side (`EvidenceReader`) with the `?principal=<id>` rule, and `TRACKER_EVIDENCE_LISTEN` (container mode): the evidence routes alone, on another address, behind the evidence token.
- Six fixture defects, each needing its features: `digest-of-current-state`, `replay-digest-mismatch`, `digest-not-canonical`, `lookup-wrong-record`, `lookup-unscoped` (backend) and `lookup-reexecutes` (MCP layer, MWS-ANN-1).
- Compatibility rules CMP-20 (`lookup` needs `execution-records`) and CMP-21 (`principals` runs where the backend runs).

### Stream B
- `ledger` feature: an append-only execution ledger, one of the store's commit sinks, written below every MCP-layer defect. It records every write, replay and refusal with its principal, run and operation tags and request fingerprint, a write whose journal append failed (`journal-unavailable`), a run reset (from the reset's own commit), and the fixture's own start, fault arming and firing and run allocation. A ledger that cannot append stops the store (503). Read at `GET /ledger` (filters, paging, JSONL) and in `GET /export` with the evidence token, for one principal (`?principal=`, required when more than one is configured). Needs `evidence` and `strict-input`.
- `faults` feature: faults armed on the control listener (`POST /_fixture/faults`), never on the command line. Backend points fire through the backend fault hooks and MCP points through the MCP result hook. This version arms `mcp/after-backend-reply/drop`, which holds the MCP answer after the backend committed (the lost response, server-side), selected by tool, run, operation, nth and count; when the hold ends the true answer is sent. Every arming and firing is a ledger entry. Needs the ledger and `--fixture-control`.
- CMP-7 now refuses a fault armed at start only without the faults feature or for a point this build cannot arm (it used to refuse every fault).
- The build descriptor's `fixture_api` is `fixture-api/1`: the control API arms faults and resets runs.
- `POST /_fixture/runs/:id/reset` removes one principal's run's objects and key records as one commit through the commit path, recorded in the ledger from that commit; run allocation is recorded too, and runs are allocated only for configured principals.
- `GET /executions`, `GET /executions/:id` and `GET /operations/:key` serve execution and operation records in the evidence namespace when their features are on; otherwise they answer 501 and name the feature.
- Caps: 100000 ledger entries per process, 32 armed faults, 16 held answers, a 10-minute hold, 32 control connections and a 10-second request timeout on the control listener.

## 0.1.0 (16 Nov 2026) for MWS 0.9

First published version. Follows the MCP Write-Safety Requirements 0.9 (37 requirements).

### Changed
- The conflict text and `get_ticket`'s text give state values unambiguously (proposal P-8 of the conflict-wording study, re-pilot 3; spec R12-1): label names are quoted as a JSON list (`labels ["content", "v3"]`), and the version is given on its own (`current expected_version: 3`; in `get_ticket`, on its own line, with each label's id beside its quoted name in JSON); an assignee is quoted too (`assignee "ann"`; `assignee none` only when there is none); `list_tickets` quotes each title as a JSON string and gives the version on its own (`T-3 [docs] open "Fix the docs"; current expected_version: 3`). The texts changed, so the build hash moves: a study run must name the build it used.

### Added (spec R15-3)
- Defect `shape-text-says-all-saved` (MWS-ATOM-1): `bulk_update_tickets` writes one by one, and after a partial apply its shape is right (`"outcome": "partial"`, each ticket in `items` with its own outcome) but its sentence says "All 3 tickets saved". A tester reads the sentence by the declaration's pattern for a statement that the whole write took effect (`patterns.applied_all`). The self-test's MWS-ATOM-1 check reads that sentence too.

### Added
- A small issue tracker (backend and MCP server, Streamable HTTP, protocol revisions 2026-07-28 and 2025-11-25) whose correct build is meant to meet every applicable requirement.
- 41 deliberate defects, one per requirement (four for MWS-RETRY-2), each in its own file and off unless named with `--defect`.
- MWS-RETRY-2 (spec R8-3): `create_project` accepts an `idempotency_key`, sent to the backend (a new key for a key that exists is refused by the duplicate check, a refusal on its own merits). Two defects: `retry-without-key` (after a broken connection, `create_ticket` re-sends the create without its key, so it is applied twice) and `key-store-in-memory` (keys kept only in the server's memory, so a repeat after a restart applies the create again). A correct variant, `key-store-honest` (`TRACKER_VARIANTS`, with `TRACKER_KEY_JOURNAL`): keys kept by the server with a journal of used keys, so that after a restart a repeat is refused, never applied twice. The self-test's MWS-RETRY-2 check cuts one backend answer and restarts the server.
- A self-test that checks each defect trips its own requirement and, with every defect on, that no defect hides another.
- Settings for the launch requirements: read-only mode (`TRACKER_READ_ONLY`), an allow-list (`TRACKER_TOOLS`) and a deny-list (`TRACKER_DENY_TOOLS`), each refusing to start on a value it does not recognise.
- Tickets carry a free-text `description` (may be empty) and a nested `details` object (`component`, `severity`) whose sub-fields an update sets one by one, so the empty-string and nested probes of MWS-UPD-1 can be shown.
- `update_ticket`, `set_labels` and `delete_ticket` need `expected_version`, or `force: true` (default off) to write without the check.
