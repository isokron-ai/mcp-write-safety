# Cells, applicability rules and evidence validity

`mcp-writecheck` writes one record per requirement per write path per scenario. A **cell** is the unit a coverage count needs: one MUST requirement on one declared write tool, or one server-level MUST requirement on the server. This page defines the cells, the written rules that make a cell `not applicable`, how records are merged into a cell, and the validity block on every `violated` record. The code is `src/checks/cells.ts` and `src/report/validity.ts`.

The tester prints no total, no percentage and no letter. `cells` is a merged view of the records, one entry per cell.

## The cell universe

- **Write tools:** the tools the declaration names as write tools (`declaredWriteTools` in `checks/coverage.ts`). A tool that is a read tool of a resource, or that declares `readOnlyHint: true`, is not a write tool. Read tools are not cells. Their records, such as MWS-IN-* on `get_ticket` or MWS-ANN-1 on `list_projects`, stay in `results` with no `cell`.
- **Per-tool requirements:** the 23 MUST requirements other than MWS-CFG-1..3. Each makes one cell per write tool: `<requirement>@<tool>`.
- **Server-level requirements:** MWS-CFG-1, MWS-CFG-2, MWS-CFG-3. Each makes one cell, `<requirement>@(server)`. Any record of these requirements lands there, whatever setting it names in `write_path.tool`.
- SHOULD requirements make no cells.

Every cell has at least one record. Where no check made a record, the cell pass adds one with scenario `cells@1`:

- `not applicable`, when an applicability rule below excludes the cell. The reason names the rule id.
- Otherwise `not tested`, with the reason: "no check of this release exercised \<tool\> for \<requirement\>", "\<tool\> is not in tools/list", or the reason the run stopped.

The run-wide `(declaration)` row that `everyRequirement` writes for a requirement with no record at all is dropped for per-tool requirements, because the cells now carry them.

## How a check takes part

A check needs to do nothing new. A record whose requirement is a per-tool MUST and whose `write_path.tool` is a declared write tool lands in the cell `<requirement>@<tool>`, whatever its resource or scenario. Rules for checks:

1. Put the tool the requirement is about in `write_path.tool`: the real tool name, never a placeholder such as `(all)`.
2. Records from different resources or scenarios for the same tool merge into one cell. A record does not need to know about the others.
3. `not applicable` from a check is a ruling for its own write path. Give the reason.
4. A check that knows its evidence passes `evidence` to `result()`: `{ acknowledged, read_back, synthetic_fault }`. Leave out what it does not know. A synthetic fault (a status the gate injects) must be stated, unless the scenario is already listed in `validity.ts` (`SYNTHETIC`).
5. Never stamp `cell` or `validity` yourself. The cell pass does that at the end of the run and in `recheck`.

## Merging records into a cell

A cell's verdict comes from its records, in this order:

1. `violated`, then `platform`, then `held`, then `not observed`, then `self-attested`: the first verdict any record has decides.
2. If only `not applicable` and `not tested` remain:
   - all `not applicable` gives `not applicable`;
   - a check's `not applicable` beats a `not tested` row on the **same write path** (resource and tool), and the generic rows of the coverage and cell passes (scenarios `coverage` and `cells`). This is TB-B2-2 (t23).
   - a `not tested` row from a check on **another resource** stands: in doubt, a cell is applicable.
   - if no check said `not applicable` but an applicability rule excludes the cell, and every record is a generic `not tested` row, the cell is `not applicable` under that rule.
3. Otherwise the cell is `not tested`.

`applicable` is false only for a `not applicable` cell. `rule` is the rule id where a rule decided it.

**Duplicates.** A record written twice word for word is kept once (TB-B2-1, t11: a tool that is both the read and the update tool was probed twice). The fix at the source is to deduplicate `toolsOf` in `schema.ts`. The cell pass makes the result right either way.

**Split by resource.** `delete_ticket` is declared under `ticket` (with the version) and `ticket-replace` (with `force: true`). Its MWS-CONC-2 records, `held` and `not tested`, are one cell, and that cell is `held`. The `not tested` record stays, because it says what the second write path did not test.

## Applicability rules

Roles come from the declaration: `create`, `creates`, `key`, `update.mode`, `delete`, `archive`, `versioned`, `no_version_check`, `selector`, `multi`, `list_edit`, `idempotency`, `input_required`, `scope`. They also come from the catalog: argument names and annotations.

A tool with no declared role, such as one named only in `calls`, is treated as one that modifies an object. "Create-only" means it creates objects and has no modifying or deleting role. "Delete-only" means it deletes and has no modifying or creating role.

A rule only excludes. A forced record from a check always overrides a rule.

| Requirement | Applies to | Rule id when not applicable |
|---|---|---|
| MWS-UPD-1 | tools that modify an existing object | `UPD-1.create` (create-only), `UPD-1.delete` (delete-only), `UPD-1.replace` (declared `full_replace`: judged by MWS-CONC-2) |
| MWS-UPD-2 | a `list_edit` tool, or a tool with a position, index, offset, pointer or path argument | `UPD-2.no-address` |
| MWS-CONC-1 | every tool except create-only | `CONC-1.create` |
| MWS-CONC-2, MWS-CONC-4 | tools that delete, replace a whole object, or take the version (a `{{version}}` in their declared arguments, or the resource's version argument in their schema), including `no_version_check` deletes | `CONC-2.create` / `CONC-4.create`, `CONC-2.no-version` / `CONC-4.no-version` |
| MWS-CONC-3 | every tool except create-only and delete-only | `CONC-3.create`, `CONC-3.delete` |
| MWS-TGT-1 | tools whose schema has the resource's scope argument | `TGT-1.no-scope` |
| MWS-TGT-2 | the `selector` tool, or a tool with a filter-like argument (`filter`, `where`, `query`, `selector`, `match`, `q`, `all`, `*_prefix`, `*_filter`, `*_query`) | `TGT-2.no-selector` |
| MWS-TGT-3 | creates whose resource declares `key`, or whose schema has `id`, `key`, `slug` or `uid` (not a `creates` entry) | `TGT-3.not-create`, `TGT-3.server-id` |
| MWS-RES-1, MWS-RES-2, MWS-SEC-1 | every write tool | none |
| MWS-RES-3 | tools that create (`create`, `creates`, a key create, an idempotency create) | `RES-3.not-create` |
| MWS-ATOM-1 | `multi` and `selector` tools, and tools with a list-of-objects argument (`ids`, `*_ids`, `items`, `objects`, `operations`, `updates`, `batch`) | `ATOM-1.single` |
| MWS-RETRY-2 | tools that take an idempotency key (declared, or an argument whose name contains "idempoten") | `RETRY-2.no-key` |
| MWS-RETRY-3 | tools declared under `input_required`, or seen answering `input_required` in the run (`target.mcp.input_requests`) | `RETRY-3.no-input` |
| MWS-IN-1..4 | tools with at least one argument | `IN.no-args` |
| MWS-ANN-1 / ANN-2 / ANN-3 | tools declaring `readOnlyHint: true` / `destructiveHint: false` / `idempotentHint: true` | `ANN-1.hint`, `ANN-2.hint`, `ANN-3.hint` |
| MWS-CFG-1..3 | the server (one cell each) | as the launch check records |

## Validity of a violated record

Every `violated` record carries `validity`:

```json
{ "class": "valid" | "platform" | "harness-suspect", "counts": true, "failed": [], "synthetic_fault": false,
  "evidence": { "acknowledged": null, "read_back": null, "synthetic_fault": null } }
```

Rules, all of which a record must meet:

| Rule | The record must show |
|---|---|
| V-STEPS | the step ids of its trace (at least one), so the capture shows what happened |
| V-RUN | the run completed: it was not stopped by the write budget, a rate limit or an error |
| V-ACK | every write the violation rests on was acknowledged as a success: from `evidence.acknowledged`, or for barrier pairs from `numbers` (`both_ok >= lost >= 1`) |
| V-READBACK | the final state was read back (`evidence.read_back`; not `false`) |

Classes:

- **valid:** meets every rule. Counts.
- **platform:** meets every rule, and its attribution is `unresolved` (spec 8.2 rule 3: no control arm decided whether the backend does the same). It counts, and is printed apart as "attribution unresolved". An undisclosed loss is the caller's loss either way. Leaving the control block out of a declaration must not turn a violation into no finding. A record where the control arm showed the platform does the same has the verdict `platform`, not `violated`.
- **harness-suspect:** failed at least one rule. It does not count until a re-run reproduces it. `failed` names the rules.

`synthetic_fault` is true where the violation was provoked with a status the gate injected (gated.ts: MWS-RES-2 and MWS-ATOM-1 under `held-request`, or `evidence.synthetic_fault`). It is printed. It does not disqualify the record, because what is tested is how the server reports a backend refusal.

## Pair budget

The MWS-CONC-3 barrier-pair record carries:

- `numbers.pair_budget`: `{ repeats, pairs }`, default 2 × 1500;
- `repeats_run`;
- `pairs_run`: the valid pairs per repeat;
- `budget_met`.

`not observed` reads "Not observed at the full pair budget" or "Not observed, below the pair budget (N of R × P pairs run)". Pairs never give `held`, and a stopped repeat gives `not tested`. See MANIFEST.md, `limits`.
