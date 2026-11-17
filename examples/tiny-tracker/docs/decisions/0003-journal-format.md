# 0003. The durable store is a JSONL journal of committed post-state (`journal-format/1`)

- Status: accepted (16 Nov 2026; owner decision 2)
- Applies from: 0.3.0 (feature `durable`, needs `--data-dir`)

## Context

A delayed-recovery check (24 hours) should not depend on one process staying up. The store has to survive a restart, and a restart must not change anything a digest covers. Node's built-in SQLite module is still experimental on the Node 22 line, and tiny-tracker supports Node 22.12 and later with one runtime dependency.

## Decision

1. **One JSONL journal** in the data dir. The first line is a header: `{"journal":"journal-format/1","writer":"<package version>"}`.
2. **Post-state only, never commands.** A line records what a transaction committed: ids, versions, timestamps and the id counters as committed, the operation record and the execution record. Replaying a journal never calls the clock or re-runs an operation, so a restart cannot change a digest.
3. **One line per transaction.** The effect, its key record and its execution record are in the same line, so the "same transaction" of the idempotency pattern is literal and readable. Each line carries a sequence number and a checksum. The answer is sent only after the line is flushed (`fsync`).
4. **Commits stay synchronous.** Where a write has a pending state, the pending line is written first; the commit is one synchronous section after it. Conditional writes and batches are one section each.
5. **Recovery:** only a torn **last** line is tolerated (it is dropped and the drop is logged). A bad line anywhere else stops the start with an error. A pending line with no commit becomes `aborted`: nothing was applied.
6. **One process per data dir.** A pid lock refuses a second writer, including a stale child next to its supervisor. More than one server instance is a non-goal.
7. The data dir is created `0700`; a directory that is not empty and was not created by tiny-tracker is refused.

## Consequences

- A whole-stack restart keeps data, key records and digests; delayed recovery no longer needs a pinned process.
- The journal is readable with standard tools, and a third party can recount effects from it.
- The journal format has its own version, separate from the package version and from `fixture-api`.
