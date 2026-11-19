# Decision records

Short records of the choices that shape tiny-tracker as a shared fixture. Each says what was decided, why, and what follows from it. A record is changed by a new record that supersedes it, never by editing the decision in place.

| # | Decision | Status |
|---|---|---|
| [0001](0001-surface-and-profiles.md) | The 0.1 surface is frozen as `--profile 0.1`; the default moves with each release | Accepted |
| [0002](0002-digest-domain.md) | Digests: RFC 8785 canonical bytes, served, under a type/version domain tag | Accepted |
| [0003](0003-journal-format.md) | The durable store is a JSONL journal of committed post-state (`journal-format/1`) | Accepted; built in 0.3.0 |
| [0004](0004-key-retention-and-expiry.md) | Keys are kept 7 days; an expired key is refused against a tombstone kept for the life of the data dir | Accepted; built in 0.3.0 |
| [0005](0005-build-descriptor.md) | Every run identifies its build: `GET /build`, two hashes, mirrored over MCP | Accepted; stub in Phase 0 |

Feedback on any of them is welcome through GitHub issues and discussions on [isokron-ai/mcp-write-safety](https://github.com/isokron-ai/mcp-write-safety).
