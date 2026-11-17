# Contributing to tiny-tracker

tiny-tracker is the sample server of the MCP Write-Safety Requirements and a shared fixture for write-safety harnesses. This file covers changes to tiny-tracker itself: a new defect, a new fault point, a new feature. The repository's [CONTRIBUTING.md](../../CONTRIBUTING.md) covers changes to the specification, the sign-off (DCO) every commit needs, and how to report a security problem privately. Where the two differ for a change to the specification, the repository's file governs.

Questions and ideas are welcome as GitHub issues or discussions. To ask for a fixture you need (a defect, a fault point, a feature), open an issue with the **tiny-tracker fixture request** form; it asks for what you need it to show and who would use it.

## Before you start

- Read [FIXTURE.md](FIXTURE.md) (what the fixture promises and its limits), [docs/INTERFACES.md](docs/INTERFACES.md) (the frozen contracts) and [docs/STABILITY.md](docs/STABILITY.md) (what may change and how).
- `npm ci` and `npm test` in this folder. The suite runs in about a minute. `TT_GATE=1 npm test` also needs `python3` with `jsonschema` and `referencing`; without the gate those checks skip, with it they fail. CI runs the gate on Linux and macOS.
- Tests use port 0, or a fixed port from the slice the file already uses. Never bind 47310 or 47311 (the documented defaults), and never sleep for wall-clock time to wait for something: wait for the event (review T5). Where a cap must elapse (a hold, a delay), make the cap small in the test.
- The 0.1 surface is frozen: `--profile 0.1` must reproduce `test/golden/surface-0.1.0.json` call for call. Nobody edits that file. A change that breaks it is a defect.
- Names on the wire are fixed: fixture properties are `FX-`, shared-contract references are `LRT-`, the `_meta` key is `dev.writesafety.tiny-tracker/idempotency-key`, and headers are `Tiny-Tracker-*`.
- Results are `held`, `violated`, `not tested` or `platform`, per requirement. Do not add totals, levels or any aggregate verdict, in code, output or docs.

## Add a defect

A defect is a deliberate, switchable fault that one check detects. It is off unless named with `--defect` (MCP layer) or `--backend-defect` (backend).

**MCP-layer defect** (`src/defects/`):

1. **One file**, `src/defects/<name>.ts`, named in kebab case after what goes wrong. It exports `defect: Defect` (`src/defects/types.ts`).
2. **The header**, in this order: `// DEFECT <name> -- <requirement> (<MUST|SHOULD>)`; the requirement's sense in one or two sentences; `WRONG ON PURPOSE. Correct code: <function> in <file>`; what goes wrong; `Mirrors:` the published finding(s) it imitates, with links, or `none published` and the reason it exists.
3. **The fields:** `requirement`, a one-sentence `summary`, `mirrors`, `replaces` (the correct code it stands in for), `wraps: true` if it wraps the handler in place instead of replacing it, and `requires` (the features it needs; empty or absent for none). `--defect all` and a requirement ID take only the defects whose features are all active.
4. **Register it:** append the import and the array entry in `src/defects/index.ts`. Nothing else in that file changes.
5. **Placement:** if it lands somewhere new, add it to the placement map in `src/defect-placement.ts`; the placement test fails until you do.
6. **Test:** the self-test matrix (`test/selftest.test.ts`) picks it up and checks that its requirement is `violated` with it on and `held` without it, and that with every defect on it hides no other. If it also trips another check, add that to `ALSO_TRIPS` with the reason, and prefer a placement that keeps the list empty.
7. **Docs:** a row in the README's defect table (the self-test checks it), a row in [docs/patterns.md](docs/patterns.md) under the correct pattern it breaks (the kit test checks it), and a CHANGELOG line under `## Unreleased`.
8. **Known answers:** when the defect changes a released `expected/` file, regenerate the files for the release it ships in and check that they reproduce (`node dist/test/repro-known-answers.js --runs 3`).

**Backend defect** (`src/backend/defects/`): the same file and header rules. It names the backend **seams** it replaces (`BACKEND_SEAMS` in `src/backend/defects/index.ts`); a seam that is not wired yet cannot take a defect, and the start is refused. Add its entry to `BACKEND_DEFECTS`. A backend defect build binds loopback only and prints a banner. Name the requirement or `FX-` property it demonstrates in `context`.

**A fixture defect** trips an `FX-` property (`src/fixture-properties.ts`) and, where listed, an MWS requirement too. Its `FX-` property must exist first, in its stream's family, with the release that first holds it.

## Add a fault point

A fault point is a place where the fixture fails on request: process × position × action (`src/fault-points.ts`), such as `mcp/after-backend-reply/drop`.

1. **Name it against the commit path.** The positions are fixed by the frozen commit order (validate, journal, apply, ledger, reply; `COMMIT_STEPS`). Say in the note what a caller sees and what has been written when it fires. A new position needs a change to `docs/INTERFACES.md`, which the lane lead lands as its own commit.
2. **Add it to `FAULT_POINTS`** with `since` (the release that builds it, or `null` for legal but not planned). Ids are frozen once released: a point is retired, never renamed (see `RETIRED_FAULT_NAMES`).
3. **Arm it through the control listener only.** Arming state lives outside argv (in the supervisor or the data dir), so a `once` fault does not re-arm after a restart. The MCP-layer points fire through `ServerExtras.onResult`; no other code edits the wrapper in `src/mcp/server.ts`.
4. **Cap it** (review X5). A hold or delay has a maximum duration and a maximum count, below the listener's own `responseCapMs` and `maxInFlight` (`MCP_HTTP_CAPS` in `src/mcp/server.ts`).
5. **Record it.** The ledger records the arming and the firing (`FX-FLT-1`), and the build descriptor lists armed faults, so the evidence names what was armed.
6. **Compatibility:** if the point only means something with a given defect, variant or feature, add it to `FAULT_DEMOS` or a compatibility rule (`src/compat.ts`, append only, in your reserved id range).
7. **Test** that it fires only at its point and that the expected answer class is what a client sees, on every platform CI runs.

## Add a feature

A feature is a switch named with `--features` (`TRACKER_FEATURES`). Unknown names, and names not built in this version, stop the process with exit 2.

1. **Declare it** in `FEATURES` (`src/profile.ts`): `name`, `since`, `built`, `layer` and a one-sentence `summary`. `layer: "fixture"` code lives in `src/fixture/` and is loaded only by a dynamic import; the import-graph test (`test/import-graph.test.ts`) proves the teaching server never loads it.
2. **Compatibility:** add the combinations it cannot run with to `src/compat.ts` (append only, ids in your range, `post01: true` unless the rule must hold under `--profile 0.1` too). Coverage is pairwise (`test/cli.test.ts`).
3. **Evidence:** a feature that changes what a run can observe is named in the build descriptor (`GET /build`, `build_hash`), so known-answer files keyed by the hash move with it.
4. **Records:** a new record field goes into the schema, `src/records.ts` and the example in one commit (additions only in a `/1` schema; see [docs/STABILITY.md](docs/STABILITY.md)).
5. **Default:** a feature becomes default only at release time, once it passes that release's gate. `PROFILE_FEATURES.default` is set by the lane lead; `--profile 0.1` never gains a feature.
6. **Docs:** its section in FIXTURE.md, its rows in the README, a CHANGELOG line, and the `expected/` files for the release that ships it.

## Every change

- Each commit is green on its own: `npm test`, and `TT_GATE=1 npm test` where `python3` is available.
- Tokens never appear on the command line, on stdout, in a record or in a result. A new listener checks Host, refuses an `Origin` where it serves no browser, compares tokens in constant time, and caps bodies.
- Write plainly: say what the code does and what it does not. No vendor or product names except as citations of published research.
- Sign off every commit (`git commit -s`; see the repository's CONTRIBUTING.md).
