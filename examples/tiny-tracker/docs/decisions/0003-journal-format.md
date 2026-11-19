# 0003. The durable store is a JSONL journal of committed post-state (`journal-format/1`)

- Status: accepted (16 Nov 2026; owner decision 2)
- Applies from: 0.3.0 (feature `durable`, needs `--data-dir`)

## Context

A delayed-recovery check (24 hours) should not depend on one process staying up. The store has to survive a restart, and a restart must not change anything a digest covers. Node's built-in SQLite module is still experimental on the Node 22 line, and tiny-tracker supports Node 22.12 and later with one runtime dependency.

## Decision

1. **One JSONL journal** in the data dir. The first line is a header: `{"jseq":0,"line":"header","journal":"journal-format/1","writer":"<package version>","boot_id":…,"seed":{…}}`. The seed (the seeded projects as created, and the id counters) lives in the header, so a restart keeps the seed's `created_at`.
2. **Post-state only, never commands.** A line records what a transaction committed: ids, versions, timestamps and the id counters as committed, the operation record and the execution record. Replaying a journal never calls the clock or re-runs an operation, so a restart cannot change a digest.
3. **One line per transaction.** The effect, its key record and its execution record are in the same line, so the "same transaction" of the idempotency pattern is literal and readable. Each line carries its own line number `jseq` (0 for the header, contiguous) and a checksum; a commit line also carries `commit_seq`, the store's commit sequence (the execution record's `seq`), which is not derived from the line's position. Line shapes: `docs/INTERFACES.md` 1.9. The answer is sent only after the line is flushed (`fsync`).
4. **Commits stay synchronous.** Where a write has a pending state, the pending line is written first; the commit is one synchronous section after it. Conditional writes and batches are one section each.
5. **Recovery:** only a torn **last** line is tolerated (it is dropped and the drop is logged). A bad line anywhere else stops the start with an error. A pending line with no commit becomes `aborted` (an `aborted` line naming it by `pending_jseq`, reason `orphan_at_start`): nothing was applied.
   - **No torn line mid-file (seams v2.1).** After a journal failure the write is refused 503 and the store carries on, so a failed partial append must not stay in the file under later good lines. After a failed append the writer truncates the file back to the end of the last good line (`ftruncate`, then `fsync`) before any later append; if it cannot, it fails stop (every later append throws and every write answers 503). It never appends after a partial line, so the only torn line a reader can meet is the last one.
   - Aborted lines carry a reason: `refused`, `journal_unavailable`, `fault`, `internal_error` or `orphan_at_start`.
6. **Fences and runs are journalled (seams v2.1).**
   - A run reset that fences a pending key record writes a `fence` line (`principal`, `key`, `run`, `pending_jseq`, `reset_seq`) after the reset's commit line. It ends that pending line (no `aborted` line), and at load it restores the fence, so the key stays refused (409 `key_fenced`) after a restart.
   - **Fenced keys never expire** (owner decision, 16 Nov 2026). A fence lasts for the life of the data dir, like a tombstone: key retention (decision 0004) does not remove it, and a fenced key is never reusable. A write in flight when its run was reset can therefore never land later under that key, across any restart.
   - Allocating a run writes a `run-alloc` line (`run_id`, `principal`, `created_at`, `label`) before the run is answered; at load the run registry is rebuilt from these lines, so run-ownership checks (403 `run_not_owned`, `run_not_allocated`) hold after a `--supervise` restart.
   - Neither takes a commit sequence.
7. **`durable` requires `strict-input`** (compat rule CMP-50): every line is checksummed over RFC 8785 bytes, which a string with a lone surrogate does not have, so such input is refused at the door instead of failing the journal append.
8. **One process per data dir.** A pid lock refuses a second writer, including a stale child next to its supervisor. More than one server instance is a non-goal.
9. The data dir is created `0700`; a directory that is not empty and was not created by tiny-tracker is refused.

## Consequences

- A whole-stack restart keeps data, key records and digests; delayed recovery no longer needs a pinned process.
- The journal is readable with standard tools, and a third party can recount effects from it.
- The journal format has its own version, separate from the package version and from `fixture-api`.
