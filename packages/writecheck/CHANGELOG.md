# Changelog

All notable changes to `@mcp-write-safety/writecheck` (the `mcp-writecheck` command). The format follows Keep a Changelog; versions follow Semantic Versioning once published.

## Unreleased

### Fixed
- MWS-CONC-3 (barrier pairs): a pair in which one answer, without `isError`, shows a conflict by a structured signal or the declared `patterns.conflict` is no longer counted as one where both calls reported success, so it is not a loss (spec MWS-CONC-3: `held` covers "one caller received a conflict"; that answer's form is MWS-CONC-4's to judge in its own trials). A conflict read only by the built-in words gives `not tested` (needs reading), per spec 7.3 rule 11. The record's numbers gain `conflict_shown` and `needs_reading`.
- MWS-CONC-3 (held request): the same reading applies to a forced trial. A trial in which an answer, without `isError`, shows a conflict by a structured signal or the declared `patterns.conflict` is not counted as lost (it goes to `conflict_shown`, with a note pointing to MWS-CONC-4), and the trial notes say "answered without isError but showed a conflict" instead of "reported success". A conflict read only by the built-in words gives `not tested` (needs reading). The numbers gain `conflict_shown` and `needs_reading` only when a change was lost in a trial where both calls answered without isError.

## 0.1.0 (16 Nov 2026): preview for MWS 0.9

First published version. Follows the MCP Write-Safety Requirements 0.9 (37 requirements, 26 MUST, 11 SHOULD).

### Added
- `run`, `plan`, `review`, `recheck`, `rerun`, `cleanup`, `init` and `demo` commands; `catalog` (catalog-only mode: the verdicts that need only `tools/list`, no tool call, no account).
- Executable checks for a stated subset of the 37 requirements; the README's coverage table lists each requirement as covered in full or in part, and what is not built is reported `not tested` with the reason.
- The backend gate (base-URL rewrite or `node --import` hook) for proxy-assisted tests: held requests, failed requests, and answers cut after the backend applied the write.
- Results per write path in `results.json` (schema `mws-results-1`), `report.md` (violations first), `junit.xml`, a redacted capture of every call, `SHA256SUMS` and an optional ssh signature.
- Seat belts: target confirmation, plan hash, tenant guard, write budget, run prefix on every object, a ledger and cleanup, egress limited to the declared hosts.
