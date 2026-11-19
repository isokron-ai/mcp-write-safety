# 0001. The 0.1 surface is frozen as `--profile 0.1`; the default moves with each release

- Status: accepted (16 Nov 2026)
- Applies from: Phase 0 (no release); `--profile 0.1` ships in 0.2.0

## Context

tiny-tracker 0.1.0 is pinned by earlier studies and by the `mcp-writecheck demo`. Published versions on npm cannot change, so those studies stay reproducible whatever later versions do. But a reference build that never gains the features it teaches (key retention, in-flight state, a lookup by key) would stay thin.

"Unchanged" also needs a definition. The MCP `initialize` result carries the package version, so no later release can be byte-identical to 0.1.0 as a whole.

## Decision

1. **The 0.1 surface** is `tools/list`, every tool result's text and structured content (and every other result member but `_meta`), the MCP `instructions` and capabilities, and the command line's first stdout line, for a recorded scenario set. It excludes `serverInfo.version` and result `_meta`. Timestamps and loopback ports are masked; nothing else is.
2. The surface is checked against a transcript captured from the **published 0.1.0 tarball**, run in its own directory, never from the working tree (`test/golden/surface-0.1.0.json`, `test/surface.test.ts`). The capture records twice and is refused if the two records differ.
3. **`--profile 0.1`** reproduces that surface in every later release. It takes no feature and no `--fixture-control`, and keeps the 0.1.0 command line: nothing 0.1.0 accepted is refused under it.
4. **The default profile** turns on the features each release ships once they meet that release's gate, from 0.2.0. Each release re-runs the `npx` demo, the README examples and the published walkthrough commands and updates them in the same release.
5. Fixture code (evidence namespace, control listener, ledger, faults, clock, supervisor) lives in `src/fixture` and is loaded only when a fixture feature or `--fixture-control` is named. A test proves profile 0.1 and the default build never load it (`test/import-graph.test.ts`).

## Consequences

- A study can pin `@0.1.0`, or run any later version with `--profile 0.1`, and see the same surface.
- Until 0.2.0 the default build has the 0.1 surface too, and the golden test checks both.
- The build descriptor (0005) is outside the surface: it is served at `/build` and in `_meta`, and in the instructions only when a fixture feature is on.
