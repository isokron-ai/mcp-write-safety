# Stream D: 0.3.0 durability (text for FIXTURE.md and the README at release)

## Durability (`durable`, needs `--data-dir`)

- **One journal** `journal.jsonl` in the data dir (decision 0003, `docs/INTERFACES.md` §1.9). Every line carries `jseq` (0 for the header, contiguous) and `checksum` (SHA-256 of its RFC 8785 bytes without the checksum).
  - The header holds the seed.
  - A commit line holds `commit_seq` (the execution record's `seq`) and the complete committed transaction.
  - Pending and aborted lines (with `inflight`) bracket a keyed write that has begun.
- **Answers wait for the flush.** A write is answered only after its line is written and flushed. If the line cannot be written, nothing is applied and the request gets 503 `journal_unavailable`.
- **A restart replays post-state only.** It reads no clock and re-runs no operation, so every stored time, id, key record and digest is the same as before the restart.
- **Recovery:**
  - A torn last line is dropped and logged.
  - A bad line anywhere else stops the start.
  - A pending line with no commit is ended with an `aborted` line (`orphan_at_start`) before the backend serves.
- **The data dir:**
  - It is created `0700`.
  - An existing one is refused when other users can reach it, when it is a symbolic link, when it belongs to another user, or when it is not empty and was not made by tiny-tracker.
- **One writer per data dir.** A pid lock refuses a second process, and a second open in the same process. The lock of a process that is gone is taken over (logged).
- **Run resets are kept too.** A run reset is a commit line, so a restart does not bring the run back.
- **The state line names the journal:** `"journal": {"data_dir": ..., "head": "<jseq>:<checksum prefix>"}`.

## In-flight keys (`inflight`)

- **Pending record.** A keyed write writes a pending record before the commit section.
- **Answers about a pending key:**
  - A same-key request meanwhile is answered `409 in_progress` (`Retry-After: 1`). At the MCP layer this is outcome `unknown`, code `in_progress`, repeat `same_key` (decision 0004). It is never `not_applied`.
  - A request with the same key and a different body is refused (`422 idempotency_key_reused`).
- **`POST /operations/:key/fence`** (backend token; body `{"fence": false}` only looks) answers by the key's state:

  | The key's state | Answer |
  |---|---|
  | A record | 200 `completed`, with the stored answer and the execution id |
  | A tombstone | 200 `expired` |
  | Pending | 409 `in_progress` |
  | No record | A fence, 200 `fenced` |

  A fenced key refuses a late original with `409 key_fenced`. Fences are held in memory (see "Open").

## Retention (`retention`)

- **Retention period.** Keys are remembered for 7 days (`--key-retention` / `TRACKER_KEY_RETENTION`, e.g. `24h`), measured in the record clock.
- **Expiry policy** (`--key-expiry` / `TRACKER_KEY_EXPIRY`):
  - `refuse` (default) keeps a tombstone for the life of the data dir. It holds the fingerprint hash, the execution id, the result digest, the committed time and the objects.
    - A repeat with the same request is answered `409 key_expired`, with outcome `applied` and the execution id. At the MCP layer: `applied`, `replayed: true`, repeat `read_first`, with `read_with`.
    - A repeat with a different request is refused.
  - `forget`: an expired key is new.
- **Stated in the tools.** Every key-accepting tool's description states the retention.

## Variants

| Variant | What it does | Needs |
|---|---|---|
| `key-store-durable` | The MCP server keeps key, fingerprint, state and result in its own fsynced journal (`TRACKER_KEY_JOURNAL`), for a backend with no idempotency. A repeat after a restart replays; a lost answer stays `unknown`. | — |
| `settle-by-lookup` | After a lost backend answer it looks the key up behind a fence. A record found means `applied`; a fenced key means `not_applied` (final: the late original is refused); pending means `unknown in_progress`. | `inflight` |
| `settle-by-client-reference` | The server labels the ticket `ref-<24 hex>` from the key and settles a lost answer by reading it back. A miss stays `unknown` (repeat `read_first`), because there is no fence. | — |

## Defects

| Flag | Trips | Requires | What goes wrong |
|---|---|---|---|
| `in-progress-reported-not-applied` | MWS-RES-2 | `inflight` | The pending same-key call is reported `not_applied` |
| `settle-miss-reported-not-applied` | MWS-RES-1 | `inflight` | After a lost answer, a lookup with no fence that finds nothing is reported `not_applied`, and the held request lands afterwards |
| backend `key-record-not-durable` | FX-DUR-1 | `durable` | The key records are not journalled; after a restart a repeat duplicates |
| backend `key-record-after-effect` | FX-DUR-2 | `durable` | The key records go to a second file after the apply; a crash between the two loses the key (the persistence gap) |
| backend `key-expires-early` | FX-KEY-1 | `retention` | Keys are kept a thousandth of the stated time |

## Compatibility

| Rule | Refuses |
|---|---|
| CMP-50 | `durable` without `strict-input` (seams v2.1; added at the 0.3.0 integration) |
| CMP-54 | `durable`, `inflight` or `retention` with `server` (was CMP-50 in the stream) |
| CMP-51 | `settle-by-lookup` without `inflight` |
| CMP-52 | Two key variants at once |
| CMP-53 | `key-store-durable` or `settle-by-client-reference` with `lookup` or `inflight` |

The CLI also refuses `--key-retention` and `--key-expiry` without `retention`.

## How the fixture tests itself

| Test | What it does |
|---|---|
| T1 (`test/crash.test.ts`) | Crashes every write operation at every point of the commit path, in-process and as a SIGKILLed child |
| T2 (`test/histories.test.ts`) | Seeded histories; `TT_SEEDS=1,2,…` picks the seeds |
| T3 (`test/histories.test.ts`) | Recounts five ways: the ledger, a journal replay, the export, a second recount written in the test, and a Python recount from the journal file. Sabotage of each is caught. |

## Open

1. **Fences survive in memory only.** `journal-format/1` has no fence line. A late original that arrives after a restart is not refused. Two options: a `fence` line kind in `journal-format/1` (a format change that needs the lead), or document the limit.
2. **A custom `--key-retention` isn't stated by the tools.** It is set on the backend, so the MCP descriptions keep stating 7 days. Retention isn't in the server `instructions` yet (`server.ts`, stream F).
3. **`settle-by-client-reference` stores its reference in a label,** because the backend has no `external_id` field.
