# Stream B: the ledger, faults, evidence routes and run reset (0.2.0)

Text for the lane lead to merge into FIXTURE.md and the README at release. It replaces the "0.2.0" markers in the evidence, control, runs and fault-point sections.

## Features

| Feature | Since | Layer | Needs |
|---|---|---|---|
| `ledger` | 0.2.0 | fixture | `evidence`, `strict-input` (CMP-30, CMP-31) |
| `faults` | 0.2.0 | fixture | `ledger`, `--fixture-control` (CMP-32, CMP-33) |

`strict-input` is required because the ledger hashes every request: a string that is not well-formed Unicode cannot be hashed the same way in every language, and strict-input refuses it before anything is stored.

## The execution ledger

An append-only list of every backend write attempt, written below every MCP-layer defect. It is one of the store's commit sinks (role `ledger`), given to the backend at start: the store tells it of each commit, replay and refusal inside the commit section, after the write is applied and before the reply. The `fingerprint_hash` of every entry is the backend's own `fingerprintHash`, computed once per write. If the ledger cannot append, the store stops and answers 503 from then on (fail-stop): the data and the evidence would otherwise disagree.

Each entry ([schema](../../schemas/ledger-entry-1.schema.json)) carries the ledger's own `seq` (from 1), wall time, `clock_offset_ms`, `boot_id`, the principal, the run and operation tags the server wrapper read from request `_meta`, the request (method, path, key, `fingerprint_hash`), the status, the execution it belongs to (`execution_id`, `X-<commit seq>`), the objects and, for fault entries, the fault.

| Kind | Written when |
|---|---|
| `start` | the fixture layer starts (always entry 1) |
| `execution` | a write is applied |
| `replay` | a keyed repeat is answered from its key record; `execution_id` names the original execution |
| `refusal` | a write is refused before any effect |
| `journal-unavailable` | a write whose journal append failed: nothing applied, status 503 |
| `fault-armed` | a fault is armed on the control listener |
| `fault-fired` | an armed fault fires; `fault.fired_on_seq` names the ledger entry it fired on |
| `run-allocated` | a run id is allocated |
| `run-reset` | a run is reset: written from the reset's own commit (`tx.reset`), with the objects it removed |

Entries are never edited or removed. The ledger has no defects (owner decision 5): the tests recount it against the export, independently of its code, and show that the recount catches a ledger that drops, doubles or mislinks an entry.

## Evidence routes (evidence token)

| Route | Answer |
|---|---|
| `GET /ledger` | `{"principal", "entries": [...], "next_after": <seq or null>}`: that principal's entries and the fixture's own (principal null). Filters (exact match): `key`, `run`, `operation`, `kind`. Paging: `after` (a ledger seq), `limit` (1 to 10000, default 10000). `format=jsonl` gives one entry per line. An unknown parameter is refused (400). |
| `GET /export` | `principal`, every project and ticket (the whole store: the seed has no owner), plus that principal's `ledger` entries (with the fixture's own) and `executions`. With the backend token it is the 0.1.0 export, unchanged. |
| `GET /executions`, `GET /executions/:id` | That principal's execution records (feature `execution-records`). On `/executions/:id` `?principal=` is optional (seams v2.1): another principal's record, or an id that is not configured, answers as an unknown id (404 `not_found`). |
| `GET /operations/:key` | The operation record of a key in that principal's scope; a miss is 404 "no record of this key now" (feature `lookup`). |

Every route above takes `?principal=<id>` (optional on `/executions/:id`): required when more than one principal is configured (400 `principal_required`), the single configured principal otherwise; an id that is not configured is 400 `unknown_principal`. The answer names the principal.

A route whose feature this process does not run answers 501 `{"error": "not_enabled", "feature": ..., "available_from": "0.2.0"}`.

## Control listener (control token)

| Route | Answer |
|---|---|
| `POST /_fixture/faults` | Arms a fault: `{"point": "mcp/after-backend-reply/drop", "selector": {...}}` → 201 `{"fault": {"id": "F-1", ...}}`. Needs the faults feature. |
| `GET /_fixture/faults` | `armed`, `spent`, `held` (answers held now), `caps`, and the point table. |
| `POST /_fixture/runs` | Allocates a run for a configured principal (`{"principal": "p-..."}`, default `p-default`; otherwise 400 `unknown_principal`); recorded in the ledger. |
| `POST /_fixture/runs/:id/reset` | Removes that principal's run's objects and key records as one commit through the commit path (`dropRun`, kind `run-reset`) → 200 `{"run_id", "principal", "dropped": {"objects", "keys"}, "ledger_seq"}`. Needs the ledger, which records the reset from its commit. |

The control listener refuses a non-loopback `Host`, any request with an `Origin` header, a `POST` without `content-type: application/json` and bodies over 64 KiB; it holds at most 32 connections and a request must arrive whole within 10 s.

## Fault points and where they fire

MCP points fire in the MCP result hook; backend points fire in the backend fault hooks: `backend/before-commit` before the commit section (nothing written yet), `backend/after-commit` after it and before the reply. A point is armable when this build has an action for it. This version has one; the 0.3.0 points add theirs. A firing at `backend/after-commit` names the execution it fired on exactly.

## The drop fault

`mcp/after-backend-reply/drop`: the backend committed and answered; the MCP server holds its answer to the client. This is the lost response, server-side. The selector picks the calls:

| Member | Meaning | Default |
|---|---|---|
| `tool` | only this tool (MCP points only) | any |
| `run`, `operation` | only calls with these tags in request `_meta` | any |
| `nth` | fire from the nth matching call on | 1 |
| `count` (or `once: true`) | firings before the fault is spent | 1 |
| `hold_ms` | how long the answer is held | 60000 (at most 600000) |

The first armed fault whose selector matches a call decides for it. There is no key selector: where the key travels depends on the code under test, so calls are picked by their tags. When the hold ends, the true answer is sent, late and unchanged. A harness that tags each call with its own operation tag gets an exact link from the firing to the execution; an untagged call fires with `fired_on_seq` null.

Arming state lives in the controller. A fault named at start (the 0.3.0 `--fault`) needs the faults feature and an armable point (CMP-7). Other points answer 501 with the release that builds them.

The control API is `fixture-api/1` from this release (the FIXTURE.md line that says `fixture-api/0` changes with it).

## Caps (X5)

| What | Cap |
|---|---|
| Ledger entries per process | 100000; the append beyond it stops the store |
| A `/ledger` page | 10000 entries |
| Faults armed at once | 32 (429 beyond) |
| Firings per arming | 1000 |
| Answers held at once | 16; a matching call beyond it is answered at once, does not fire, and is counted as `skipped_at_cap` |
| One hold | 600000 ms |
| Control connections | 32 |
