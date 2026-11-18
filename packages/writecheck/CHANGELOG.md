# Changelog

All notable changes to `@mcp-write-safety/writecheck` (the `mcp-writecheck` command). The format follows Keep a Changelog; versions follow Semantic Versioning once published.

## Unreleased

### Fixed
- Wrapped results are read (t17): a tool that answers structuredContent `{"result": "<a JSON document as a string>"}`, as Python FastMCP does with a wrap-result output schema, had its answer read from the wrapper, so paths found nothing (a read's `items`/`match`, the fixture lookup, `target.guard.path`) and the fixture was "not found". The JSON inside the string now replaces structuredContent in every reading of that tool's structured answer, for reads and writes: paths, the declared `outcome_field`, the structured signals (conflict, version-required, validation), the CONC-2/4/6 conflict readings, the text the patterns search, and an adopted result shape (read from the decoded document, as the patterns are). It applies only where the tool's `outputSchema` marks a wrapped result (`result` as its only property, of type string or untyped, with or without `x-fastmcp-wrap-result`) or the manifest declares `decode: json`, and only where structuredContent has `result` as its only member and that string is a JSON object or array. `decode: none` (on `read`, `list`, `target.guard`, or per tool under the new `server.decode`) keeps a marked tool's results as received. Each decoded call record carries `decoded` and `raw_structured` (structuredContent as received), and `target.mcp.notes` names each decoded tool and why. Results of servers that do not wrap are read as before; plan hashes of existing manifests do not change.
- A backend URL in the server's command line (`server.stdio`, `server.launch.command`; e.g. `redis://host:6379` or `--url=postgres://…`) is now a target host. It is shown in the plan and checked by the production-host refusal; before, such a host was neither. Plans for servers with such an argument get a new hash. A run left open by an earlier version on such a manifest is refused at cleanup ("environment now points at …") and needs `--abandon`.

## 0.1.0 (16 Nov 2026): preview for MWS 0.9

First published version. Follows the MCP Write-Safety Requirements 0.9 (37 requirements, 26 MUST, 11 SHOULD).

### Added
- `run`, `plan`, `review`, `recheck`, `rerun`, `cleanup`, `init` and `demo` commands; `catalog` (catalog-only mode: the verdicts that need only `tools/list`, no tool call, no account).
- Executable checks for a stated subset of the 37 requirements; the README's coverage table lists each requirement as covered in full or in part, and what is not built is reported `not tested` with the reason.
- The backend gate (base-URL rewrite or `node --import` hook) for proxy-assisted tests: held requests, failed requests, and answers cut after the backend applied the write.
- Results per write path in `results.json` (schema `mws-results-1`), `report.md` (violations first), `junit.xml`, a redacted capture of every call, `SHA256SUMS` and an optional ssh signature.
- Seat belts: target confirmation, plan hash, tenant guard, write budget, run prefix on every object, a ledger and cleanup, egress limited to the declared hosts.
