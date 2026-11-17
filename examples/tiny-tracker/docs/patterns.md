# Write-safety patterns in tiny-tracker

Each row is one pattern the correct build follows: what the code does, where it does it, the requirement of the MCP Write-Safety Requirements (MWS 0.9) it meets, and the defect that breaks it. Switch a defect on with `--defect <name>` to see the pattern fail; the self-test (`test/selftest.test.ts`) shows each defect `violated` on its own requirement and the correct build `held`.

The requirement titles here are short labels; the normative text is in [`spec/mws.md`](../../../spec/mws.md). The README's defect table gives each defect's published finding.

## Update what was named

| Pattern | Correct code | Requirement | Broken by |
|---|---|---|---|
| A field update is a per-field PATCH of the fields the caller named; omitted fields keep their values | `updateTicket` (`src/mcp/tools/tickets.ts`) | MWS-UPD-1 | `update-adds-defaults` |
| A list element is addressed by a stable id, not by its position | `removeLabel` (`src/mcp/tools/labels.ts`) | MWS-UPD-2 | `label-by-position` |
| `null` means "clear this field" and is sent, never dropped as "not given" | `namedFields` in `updateTicket` | MWS-RES-1 | `skip-null-assignee` |

## Concurrency: never lose a write silently

| Pattern | Correct code | Requirement | Broken by |
|---|---|---|---|
| A replace needs `expected_version`; skipping the check takes an explicit `force: true`, off by default | `replaceTicket` | MWS-CONC-1 | `force-by-default` |
| The caller's `expected_version` is sent as given (`If-Match`), never refreshed from a new read | `deleteTicket` | MWS-CONC-2 | `delete-refetches-version` |
| An update sends only its fields in one conditional PATCH; no read, merge and full PUT | `updateTicket` | MWS-CONC-3 | `read-merge-put` |
| A refused conflict is a tool error (`isError`) that says nothing was written | `updateTicket`'s conflict result (`src/mcp/results.ts`) | MWS-CONC-4 | `conflict-without-iserror` |
| A tool whose backend cannot detect stale writes says so in its description | `deleteProject`'s description (`src/mcp/tools/projects.ts`) | MWS-CONC-5 | `stale-unannounced` |
| A conflict error carries the current state, or says to re-read | `setLabels`' error mapping | MWS-CONC-6 | `conflict-as-generic-error` |

## Target exactly what was asked

| Pattern | Correct code | Requirement | Broken by |
|---|---|---|---|
| A scope argument (`project`) is honored or the call is refused | `createTicket` | MWS-TGT-1 | `ignore-project-scope` |
| An empty filter matches nothing; deleting everything needs `all: true` | the empty-filter guard in `deleteTickets` | MWS-TGT-2 | `empty-filter-deletes-all` |
| A create refuses an existing key (POST, 409); it never upserts | `createProject` (`src/mcp/tools/projects.ts`) | MWS-TGT-3 | `create-overwrites` |

## Say what happened, truthfully

| Pattern | Correct code | Requirement | Broken by |
|---|---|---|---|
| `applied` only when the state asked for is in effect | `updateTicket` | MWS-RES-1 | `shape-claims-applied` |
| A backend refusal is a tool error, never text that reads as success | `addComment` (`src/mcp/tools/comments.ts`) | MWS-RES-2 | `error-as-text` |
| A lost backend answer is reported as `unknown`, with a read to make first, in the shape and in the sentence | `unknownOutcome()` and `fromBackend` (`src/mcp/results.ts`) | MWS-RES-2 | `shape-unknown-as-failed`, `shape-text-says-failed`, `shape-text-invites-retry` |
| A create returns the new object's id | `addComment`'s answer | MWS-RES-3 | `comment-id-dropped` |
| A write returns a receipt: id, fields changed, new version | `updateTicket`'s receipt and `applied()` | MWS-RES-4 | `receipt-missing-version`, `shape-wrong-version` |

## Many objects: all or nothing, and say which

| Pattern | Correct code | Requirement | Broken by |
|---|---|---|---|
| A multi-item update is one all-or-nothing batch, and every item's outcome is reported | `bulkUpdateTickets` (`src/mcp/tools/bulk.ts`) | MWS-ATOM-1 | `shape-missing-failed`, `shape-text-says-all-saved`, `bulk-misreports-partial` |
| A multi-item delete is one all-or-nothing batch | `deleteTickets` | MWS-ATOM-2 | `bulk-without-transaction` |

## Retries: apply once, answer the same

| Pattern | Correct code | Requirement | Broken by |
|---|---|---|---|
| A non-idempotent create accepts an `idempotency_key` | `addComment`'s input schema | MWS-RETRY-1 | `no-idempotency-key` |
| The key goes to the backend, which keeps the record; a repeat is answered with the first outcome, a reused key with other arguments is refused, a retry after a lost answer keeps the key, and the record survives a server restart | `createTicket` | MWS-RETRY-2 | `idempotency-key-dropped`, `idempotency-key-ignores-args`, `retry-without-key`, `key-store-in-memory` |
| Nothing is written before the confirmation (`input_required`) is answered | `closeTicket` | MWS-RETRY-3 | `close-before-confirm` |
| **Variant** `key-store-honest`: where the backend keeps no keys, the server keeps them with a journal of used keys; after a restart a journalled key is refused, never applied twice | `src/variants/key-store-honest.ts` | MWS-RETRY-2 (`held`, with notes) | (correct alternative; no defect) |

## Inputs: refuse rather than guess

| Pattern | Correct code | Requirement | Broken by |
|---|---|---|---|
| A value of the wrong type is refused, never coerced into another meaning | `correctValidation.checkType` (`src/mcp/validate.ts`) | MWS-IN-1 | `coerce-types` |
| An unknown argument is refused, never dropped | `correctValidation.checkUnknown` | MWS-IN-2 | `drop-unknown-args` |
| Declared enums, lengths and ranges are enforced | `correctValidation.checkLimits` | MWS-IN-3 | `skip-limits` |
| A validation error names the argument and the reason | `correctValidation.describe` | MWS-IN-4 | `vague-validation-error` |
| Every limit the server enforces is in the schema | `updateTicket`'s limits | MWS-IN-5 | `undeclared-title-limit` |
| A wrong type is refused even when the conversion would keep its meaning | `correctValidation.checkType` | MWS-IN-6 | `convert-numeric-strings` |
| An unknown argument is refused, not ignored with a notice | `correctValidation.checkUnknown` | MWS-IN-7 | `ignore-unknown-args-with-notice` |

## Configuration fails closed

| Pattern | Correct code | Requirement | Broken by |
|---|---|---|---|
| An unrecognized read-only value stops the start | `correctConfigRules.parseReadOnly` (`src/mcp/config.ts`) | MWS-CFG-1 | `read-only-strict-true` |
| An unknown name in the deny-list stops the start | `correctConfigRules.resolveDenyList` | MWS-CFG-2 | `unknown-denied-tools-ignored` |
| Read-only mode refuses every write tool, whatever its annotations | `correctConfigRules.isEnabled` | MWS-CFG-3 | `read-only-by-annotation` |
| An unknown name in the allow-list stops the start | `correctConfigRules.resolveToolList` | MWS-CFG-4 | `unknown-tools-ignored` |

## Annotations tell the truth

| Pattern | Correct code | Requirement | Broken by |
|---|---|---|---|
| A tool that writes is not marked `readOnlyHint: true` | `addComment` annotations | MWS-ANN-1 | `comment-marked-read-only` |
| A tool marked `destructiveHint: false` never removes data the call did not name | `addLabel` | MWS-ANN-2 | `add-label-replaces-list` |
| A create without a key is not marked `idempotentHint: true` | `createTicket` annotations | MWS-ANN-3 | `create-marked-idempotent` |
| Every tool declares `readOnlyHint` and `destructiveHint` | `removeLabel` annotations | MWS-ANN-4 | `missing-annotations` |
| A tool that replaces a list is marked destructive | `setLabels` annotations | MWS-ANN-5 | `set-labels-non-destructive` |

## Secrets stay out of results

| Pattern | Correct code | Requirement | Broken by |
|---|---|---|---|
| Errors never echo the backend request or its credentials | `getTicket` | MWS-SEC-1 | `token-in-error` |

## The platform underneath

| Pattern | Correct code | Context | Broken by |
|---|---|---|---|
| The backend's PATCH reads, checks the version and writes with no await between (one synchronous commit section) | `Store.commit`, `Store.patchTicket` (`src/backend/store.ts`) | MWS-CONC-3, `platform` verdict | `--backend-defect lost-update`: the platform itself loses updates, so a tester reports `platform`, not `violated` |

Fixture defects (`FX-` properties, from 0.2.0) get their own rows here as each release builds them; [FIXTURE.md](../FIXTURE.md) lists the planned ones.
