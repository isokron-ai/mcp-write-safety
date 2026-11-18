# Changelog

All notable changes to `@mcp-write-safety/writecheck` (the `mcp-writecheck` command). The format follows Keep a Changelog; versions follow Semantic Versioning once published.

## Unreleased

### Fixed
- A backend URL in the server's command line (`server.stdio`, `server.launch.command`; e.g. `redis://host:6379` or `--url=postgres://…`) is now a target host. It is shown in the plan and checked by the production-host refusal; before, such a host was neither. Plans for servers with such an argument get a new hash. A run left open by an earlier version on such a manifest is refused at cleanup ("environment now points at …") and needs `--abandon`.
- A backend host given without a URL is now a target host too: a host variable the server is started with (`server.env`, `env_passthrough`, `env_public`) whose name ends in `HOST`, `HOSTNAME`, `SERVER`, `ADDR`, `ADDRESS` or `ENDPOINT` at the start or after an underscore (`DB_HOST`, `MYSQL_HOST`, `CACHE_SERVER`, `HOST`), or `PGHOST`, with the port from its sibling `*_PORT` (`PGPORT`) when given; and a host after `--host`, `--hostname` or `-h` in the server's command line, with the port from `--port`. `HOST_HEADER` and `GHOST` are not host variables, and a value that is not a hostname or an IP address (empty, `true`, a number alone, a path, `0.0.0.0`) is skipped. Such a host is shown in the plan and checked by the production-host refusal; before, the plan said "none" and the host was not checked. Plans for servers with such a variable or flag get a new hash. A run left open by an earlier version on such a manifest is refused at cleanup ("environment now points at …") and needs `--abandon`.

## 0.1.0 (16 Nov 2026): preview for MWS 0.9

First published version. Follows the MCP Write-Safety Requirements 0.9 (37 requirements, 26 MUST, 11 SHOULD).

### Added
- `run`, `plan`, `review`, `recheck`, `rerun`, `cleanup`, `init` and `demo` commands; `catalog` (catalog-only mode: the verdicts that need only `tools/list`, no tool call, no account).
- Executable checks for a stated subset of the 37 requirements; the README's coverage table lists each requirement as covered in full or in part, and what is not built is reported `not tested` with the reason.
- The backend gate (base-URL rewrite or `node --import` hook) for proxy-assisted tests: held requests, failed requests, and answers cut after the backend applied the write.
- Results per write path in `results.json` (schema `mws-results-1`), `report.md` (violations first), `junit.xml`, a redacted capture of every call, `SHA256SUMS` and an optional ssh signature.
- Seat belts: target confirmation, plan hash, tenant guard, write budget, run prefix on every object, a ledger and cleanup, egress limited to the declared hosts.
