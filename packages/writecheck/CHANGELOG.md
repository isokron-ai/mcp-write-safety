# Changelog

All notable changes to `@mcp-write-safety/writecheck` (the `mcp-writecheck` command). The format follows Keep a Changelog; versions follow Semantic Versioning once published.

## Unreleased

### Fixed
- MWS-CONC-3 (barrier pairs): a pair in which one answer, without `isError`, shows a conflict by a structured signal or the declared `patterns.conflict` is no longer counted as one where both calls reported success, so it is not a loss (spec MWS-CONC-3: `held` covers "one caller received a conflict"; that answer's form is MWS-CONC-4's to judge in its own trials). A conflict read only by the built-in words gives `not tested` (needs reading), per spec 7.3 rule 11. The record's numbers gain `conflict_shown` and `needs_reading`.
- MWS-CONC-3 (held request): the same reading applies to a forced trial. A trial in which an answer, without `isError`, shows a conflict by a structured signal or the declared `patterns.conflict` is not counted as lost (it goes to `conflict_shown`, with a note pointing to MWS-CONC-4), and the trial notes say "answered without isError but showed a conflict" instead of "reported success". A conflict read only by the built-in words gives `not tested` (needs reading). The numbers gain `conflict_shown` and `needs_reading` only when a change was lost in a trial where both calls answered without isError.
- MWS-CONC-3 (barrier pairs and held request): a pair or trial in which the answer that showed a conflict had its own change in effect afterwards, while the other writer's change, reported as a success, was lost, is recorded as `conflict_shown_own_applied` with a note (a false refusal). It is still not counted as a loss, because both calls did not report success.
- MWS-CONC-3 (barrier pairs): the experiment's own verdict in the observation (`verdict`, from its mechanical rule `test.silent_loss`, which reads `isError` only) is unchanged, so plan hashes are too. Where it says `reproduced` and the requirement record, reading a shown conflict, does not say `violated` or `platform`, the record now carries a note saying the two differ and that the record's verdict is the one that counts.
- A call's recorded data that is clipped (over about 4,000 characters) now keeps the short scalar members at its top level and in its `error` object, where structured signals are read (the keys the signals read, such as `conflict`, `status`, `code` and `error`, always; up to 64 others), and the declared outcome field at its path. Before, the clip replaced the data with `{ clipped, bytes }` and could hide a structured conflict (`"conflict": true`, a 409 status, a conflict code) from MWS-CONC-3's reading of a shown conflict and from the other structured-signal readers. Other readers of the recorded data can decide differently on a clipped answer too: the declared outcome field (`outcomeByField`, read by MWS-RES-2 in the held-request check, by MWS-RETRY-2 and by the shared readers in `checks/types.ts`) now decides where the field is at the top level, where before it gave nothing; MWS-CONC-6's reading of the current version and the other writer's value (`versionIn` and `mentions`) can now find them among the kept members; and MWS-RES-4's note on server-managed fields (`extraManaged`) can now name a kept top-level member (a note only, no verdict). Evidence already recorded is not affected: the clip is made when a call is collected, so a recheck of a recorded run reads the data as it was recorded.

## 0.1.0 (16 Nov 2026): preview for MWS 0.9

First published version. Follows the MCP Write-Safety Requirements 0.9 (37 requirements, 26 MUST, 11 SHOULD).

### Added
- `run`, `plan`, `review`, `recheck`, `rerun`, `cleanup`, `init` and `demo` commands; `catalog` (catalog-only mode: the verdicts that need only `tools/list`, no tool call, no account).
- Executable checks for a stated subset of the 37 requirements; the README's coverage table lists each requirement as covered in full or in part, and what is not built is reported `not tested` with the reason.
- The backend gate (base-URL rewrite or `node --import` hook) for proxy-assisted tests: held requests, failed requests, and answers cut after the backend applied the write.
- Results per write path in `results.json` (schema `mws-results-1`), `report.md` (violations first), `junit.xml`, a redacted capture of every call, `SHA256SUMS` and an optional ssh signature.
- Seat belts: target confirmation, plan hash, tenant guard, write budget, run prefix on every object, a ledger and cleanup, egress limited to the declared hosts.
