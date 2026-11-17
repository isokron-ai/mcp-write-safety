# 0004. Keys are kept 7 days; an expired key is refused against a tombstone kept for the life of the data dir

- Status: accepted (16 Nov 2026; owner decision 3)
- Applies from: 0.3.0 (feature `retention`); the answers on keyed calls (rule 4) from the release that builds each state

## Context

The idempotency-key draft asks a resource to state an expiry policy. The MWS retry guidance asks a tool's description to say how long a key is remembered. tiny-tracker 0.1.0 remembers keys for the life of the process and says nothing.

A keyed call's result describes the write the key identifies, even where the call itself applied nothing (a replay, a call while the first is in progress). A result that says `not_applied` about a write that was applied, or is about to be, is false.

## Decision

1. **Retention: 7 days**, longer than the 24-hour delayed-recovery window. It is stated in every key-accepting tool's description, in the instructions, and as `expires_at` in the operation record. `expires_at` is in the fixture clock's domain, and every record carries `clock_offset_ms`.
2. **Expiry policy `refuse`** (default) keeps a tombstone for each expired key: key, fingerprint hash, execution record id, result digest, committed time. Tombstones are kept for the life of the data dir. `forget` (the key is treated as new) is a correct variant with its own known answers.
3. **Answers on keyed calls:**
   - same key, same fingerprint, record present: the stored answer, `replayed: true`, `repeat: same_key`;
   - same key, different fingerprint: refused, nothing applied (`idempotency_key_reused`);
   - same key while the first is pending: `code: in_progress`, `outcome: unknown`, `repeat: same_key`;
   - an expired key whose fingerprint matches the tombstone: `outcome: applied`, `replayed: true`, `repeat: read_first`, with the execution record id from the tombstone and a text that says the stored answer is gone and the object should be read;
   - an expired key with a different fingerprint: refused, nothing applied.
   At the backend (seams v2.1, `docs/INTERFACES.md` 1.1) these are: the stored reply with `idempotent-replayed: true`; 422 `idempotency_key_reused`; 409 `in_progress`; 410 `key_expired` with `idempotent-replayed: true` and `{execution_id, result_digest, committed_at}` from the tombstone, told to the ledger as a replay; 422 `idempotency_key_reused`. A key whose pending record was fenced by a run reset answers 409 `key_fenced`, nothing applied, for the life of the data dir.
4. **A refused first call does not hold the key.** A backend refusal (status 300 and above) is decided before any effect and stores nothing, so a repeat with the same key is a new attempt.
5. **`get_operation` on a key with no record** answers "no record of this key now". It never says nothing was written: a held request can still arrive.

## Consequences

- The correct build never reports `not_applied` for a write that was, or may yet be, applied.
- Tombstones grow with use; for a fixture's data dir that is acceptable and stated.
- Two correct builds (`refuse`, `forget`) ship known answers, so harnesses can tell the policies apart.
