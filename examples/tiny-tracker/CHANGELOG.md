# Changelog

All notable changes to `@mcp-write-safety/tiny-tracker`, the sample server for the MCP Write-Safety Requirements. The format follows Keep a Changelog; versions follow Semantic Versioning once published.

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
