# Stability policy

tiny-tracker is used two ways: as the sample server of the MCP Write-Safety Requirements, and as a shared fixture that other harnesses run against and whose evidence they check. A harness author needs to know which parts can change under them and how they will hear about it. This page says so. It applies from 0.2.0; until 1.0 every package release is 0.x.

## What carries its own version

The package version (`@mcp-write-safety/tiny-tracker` on npm) says what was released. It does not say whether your harness still works. These do, and each moves on its own:

| Surface | Version | Where it is stated | Changes when |
|---|---|---|---|
| The 0.1.0 surface | `--profile 0.1` | `test/golden/surface-0.1.0.json` (from the published 0.1.0 tarball) | Never. Every later release reproduces it call for call. |
| The fixture API: evidence and control paths, their answers and error codes, the `Tiny-Tracker-*` headers, the `_meta` keys, fault point ids, feature names, compatibility rule ids | `fixture-api/0` | `GET /build` (`fixture_api`), [openapi.yaml](../openapi.yaml) (`info.version`) | A path, member, header, code or id is removed or changes meaning. |
| The journal | `journal-format/1` | The journal's first line; [decision 0003](decisions/0003-journal-format.md) | A line can no longer be read by the previous reader. |
| Each JSON Schema | its `$id`, ending `-1.schema.json` | `schemas/`; `$id` base `https://writesafety.dev/schemas/tiny-tracker/` | A top-level member is renamed or removed, or changes type or meaning. |
| The digest | its domain tag, ending `/1` | [decision 0002](decisions/0002-digest-domain.md), `vectors/digest-1.json` | The preimage or canonical form changes. |
| A build | `build_hash` | `GET /build`; mirrored in the MCP instructions and every result's `_meta` | Anything that can change a result: version, features, defects, variants, settings. |

Known-answer files (`expected/`) are keyed by `build_hash`, so a harness that compares against them compares against the build that produced them.

## What may change in 0.x

**Within one version of a surface** (additions only):

- A schema may gain top-level members. A consumer ignores members it does not know. The new member lands in the schema, the TypeScript type and the example in the same commit.
- The fixture API may gain paths, optional request members, response members, error codes and headers. A path that answers `501 not_built` today (with `available_from`) answers for real in the release it names.
- New features, defects, variants, fault points and compatibility rules may be added. A new compatibility rule may refuse a combination that started before; that is listed in the CHANGELOG under "Changed in the default profile".
- The default profile gains the features each release ships once they pass that release's gate (owner decision 1). Name `--profile 0.1`, or name your features, to pin what you run against.
- Texts that are not part of the 0.1 surface may be reworded. A harness should read structured results, not prose.

**Only with a new version of that surface:**

- Renaming or removing a schema member, a path, a header, a `_meta` key, a fault point id or a feature name; changing a member's type or meaning.
- Changing the journal so the previous reader cannot replay it.
- Changing the digest preimage or the canonical form.

## How a removal is announced

1. **The CHANGELOG** names it under `## Unreleased` as soon as it is decided, with the replacement and the release that removes it.
2. **One release of overlap at least.** The old and the new form are both served for at least one minor release: a new schema `$id` (`-2`) beside the old one, a new path beside the old one, a renamed fault point recognized under its old name with a pointer to the new one (as `RETIRED_FAULT_NAMES` does today).
3. **The build descriptor** reports `fixture_api` and the versions in use, so a harness can check before it runs.
4. **Removal** lands in a later release, never in a patch release, and the CHANGELOG says so again.

A security fix may shorten the overlap. The CHANGELOG then says why.

## What is never promised

- Timings, ports chosen by the OS, ids beyond what a schema states, and the order of members in JSON (canonical bytes are served where order matters).
- Behaviour of a defect build beyond the requirement or `FX-` property it demonstrates.
- Running more than one server instance against one data dir (a non-goal; the data-dir lock refuses it).

Questions about this policy are welcome as GitHub issues or discussions.
