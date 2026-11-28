<img src="https://raw.githubusercontent.com/isokron-ai/mcp-write-safety-kits/main/assets/mws-mark-128.png" alt="MCP Write-Safety Requirements mark" width="72" height="72">

# mcp-writecheck

Tests your own MCP server, in a test environment, against the MCP Write-Safety Requirements (MWS 0.9). It makes real writes. Point it only at a test environment you are allowed to change. Apache-2.0, provided without warranty.

No model, no account, no telemetry. The tool connects to your server, to the hosts your manifest names, and to nothing else (enforced in code; cloud metadata addresses are refused by the address a name resolves to).

Packages: `@mcp-write-safety/writecheck` (this tool; the command is `mcp-writecheck`) and `@mcp-write-safety/tiny-tracker` (the sample server). The requirements: [MCP Write-Safety Requirements 0.9](https://isokron.ai/mws?utm_source=writecheck-readme&utm_medium=readme). Source: [isokron-ai/mcp-write-safety](https://github.com/isokron-ai/mcp-write-safety/tree/main/packages/writecheck). Node 22 or later.

## Before you run: a full run makes real writes, up to about 1,800 for the sample server

`run` creates, changes and deletes real objects in whatever system the manifest points at, and sends the destructive MWS-TGT-2 forms only where you opt in. Read this first.

- **Use a disposable backend.** A backend that you start for the test (a container, an in-memory build) or a tenant that exists only for testing, with a credential that is valid only there. Never a shared or production system.
- **Read the plan before you run.** `plan` calls no tool and writes nothing; it prints the largest number of writes and creates and the plan hash. For the sample server, tiny-tracker, it is up to about 1,800 real writes (at most 1,789 writes and 307 creates); the default `limits.write_budget` is 20,000, and `--pair-budget 2x1500` adds about 12,000 writes per resource. `run` takes the plan hash back from a person (`--plan-hash`), and the target (`--confirm-target`); there is no `--yes`.
- **Destructive forms need an explicit flag.** The empty and match-all selector forms of MWS-TGT-2 are sent only with `selector.send_empty_forms: true` in the manifest, which you set only for a backend where every object is disposable. Without it MWS-TGT-2 is `not tested`.
- **The checks refuse obvious mistakes; they do not prove a target is a test system.** The manifest must say `environment: test`, hosts that look like production are refused unless listed, and a read-only guard call must match before any write (see Seat belts below). The decision to point the manifest at a system is yours.

Status: a preview for the MWS 0.9 comment window. It covers a stated subset of the 37 requirements (the coverage table below); a requirement or a tool it does not exercise is reported `not tested`, with the reason, never guessed.

## Try it in about a minute

`demo` runs the suite against tiny-tracker, the MWS sample server: a small issue tracker whose default build is written to meet the requirements and whose broken builds switch on deliberate defects, one per requirement. (A run reports per requirement and write path; no run says a server meets MWS as a whole.) Everything runs on 127.0.0.1 and stops when the demo ends; nothing leaves the machine.

With npm (Node 22 or later):

```sh
npx -y -p @mcp-write-safety/writecheck@0.1.0 -p @mcp-write-safety/tiny-tracker@0.1.0 mcp-writecheck demo --defect all   # every defect on
npx -y -p @mcp-write-safety/writecheck@0.1.0 -p @mcp-write-safety/tiny-tracker@0.1.0 mcp-writecheck demo                # the correct build
```

From a checkout of this repository:

```sh
(cd examples/tiny-tracker && npm ci && npm run build)
cd packages/writecheck && npm ci && npm run build
npm run demo -- --defect all   # every defect on
npm run demo                   # the correct build
```

The demo finds a checkout's `examples/tiny-tracker` by itself, and a `tiny-tracker` command on `PATH` (as `npx -p` gives it).

Expected output with every defect on:

```
tiny-tracker with defects: all — backend http://127.0.0.1:<port>, MCP server started by the tester behind the loopback gate
plan <hash>; the demo confirms the target itself because it started it (on 127.0.0.1, in memory). `run` always asks.

MWS-UPD-1    MUST   violated in ticket:update_ticket
MWS-UPD-2    MUST   violated in ticket:remove_label
MWS-CONC-1   MUST   violated in ticket:delete_ticket, ticket-replace:replace_ticket
MWS-CONC-2   MUST   violated in ticket:delete_ticket, ticket-replace:replace_ticket
MWS-CONC-3   MUST   violated in ticket-replace:replace_ticket
MWS-CONC-4   MUST   violated in ticket:set_labels
MWS-CONC-5   SHOULD self-attested, not applicable, not tested; review answer "no" in project:delete_project
MWS-CONC-6   SHOULD self-attested; review answer "no" in ticket:set_labels
MWS-TGT-1    MUST   violated in ticket:create_ticket, ticket-replace:create_ticket
MWS-TGT-2    MUST   not tested, not applicable
MWS-TGT-3    MUST   violated in project:create_project
MWS-RES-1    MUST   violated in ticket:update_ticket
MWS-RES-2    MUST   violated in ticket:add_comment, ticket-replace:replace_ticket
MWS-RES-3    MUST   violated in ticket:add_comment
MWS-RES-4    SHOULD violated in ticket:update_ticket
MWS-ATOM-1   MUST   violated in ticket:bulk_update_tickets
MWS-ATOM-2   SHOULD held, not tested
MWS-RETRY-1  SHOULD violated in ticket:add_comment
MWS-RETRY-2  MUST   violated in ticket:create_ticket
MWS-RETRY-3  MUST   violated in ticket:close_ticket
MWS-IN-1     MUST   violated in ticket:update_ticket, ticket-replace:replace_ticket
MWS-IN-2     MUST   violated in project:list_projects, ticket:get_ticket, ticket-replace:get_ticket, ticket-replace:replace_ticket
MWS-IN-3     MUST   violated in ticket:update_ticket
MWS-IN-4     MUST   violated in ticket:get_ticket, ticket:update_ticket, ticket-replace:get_ticket, ticket-replace:replace_ticket; review answer "no" in ticket:get_ticket, ticket-replace:get_ticket
MWS-IN-5     SHOULD violated in ticket:update_ticket
MWS-IN-6     SHOULD violated in ticket:update_ticket, ticket-replace:replace_ticket
MWS-IN-7     SHOULD violated in project:list_projects, ticket:get_ticket, ticket:update_ticket, ticket-replace:get_ticket, ticket-replace:replace_ticket
MWS-CFG-1    MUST   violated in (server):TRACKER_READ_ONLY
MWS-CFG-2    MUST   violated in (server):TRACKER_DENY_TOOLS
MWS-CFG-3    MUST   violated in (server):TRACKER_READ_ONLY
MWS-CFG-4    SHOULD violated in (server):TRACKER_TOOLS
MWS-ANN-1    MUST   violated in ticket:add_comment
MWS-ANN-2    MUST   violated in project:create_project, ticket:add_label
MWS-ANN-3    MUST   violated in ticket:create_ticket, ticket-replace:create_ticket
MWS-ANN-4    SHOULD violated in (catalog):remove_label
MWS-ANN-5    SHOULD violated in project:create_project, ticket:add_label, ticket:set_labels
MWS-SEC-1    MUST   violated in (server):get_ticket

442 records in <seconds> s. One line per requirement; the report has one row per write path. There is no total.
mcp-writecheck is a preview: of the 37 requirements of MWS 0.9 it executes the test of 14 in full and of 23 in part; what is not built is reported "not tested" with the reason (README: Coverage in this preview).
report: <tmp>/mwsc-demo-results/<run id>/report.md
```

Expected output for the correct build:

```
tiny-tracker (correct build) — backend http://127.0.0.1:<port>, MCP server started by the tester behind the loopback gate
plan <hash>; the demo confirms the target itself because it started it (on 127.0.0.1, in memory). `run` always asks.

MWS-UPD-1    MUST   held, not applicable, not tested
MWS-UPD-2    MUST   held, not applicable
MWS-CONC-1   MUST   held, not applicable, not tested
MWS-CONC-2   MUST   not tested, held, not applicable
MWS-CONC-3   MUST   not observed, held, not applicable, not tested
MWS-CONC-4   MUST   held, self-attested, not applicable, not tested
MWS-CONC-5   SHOULD self-attested, not applicable, not tested
MWS-CONC-6   SHOULD held
MWS-TGT-1    MUST   not tested, held, not applicable
MWS-TGT-2    MUST   held, not applicable
MWS-TGT-3    MUST   held, not applicable
MWS-RES-1    MUST   held
MWS-RES-2    MUST   held, not tested
MWS-RES-3    MUST   held, not tested, not applicable
MWS-RES-4    SHOULD held
MWS-ATOM-1   MUST   held, not applicable
MWS-ATOM-2   SHOULD held
MWS-RETRY-1  SHOULD held
MWS-RETRY-2  MUST   held, not observed, not applicable, not tested
MWS-RETRY-3  MUST   not observed, held, not applicable
MWS-IN-1     MUST   not applicable, held, not tested
MWS-IN-2     MUST   held, not tested
MWS-IN-3     MUST   not applicable, held, not tested
MWS-IN-4     MUST   held, self-attested, not tested
MWS-IN-5     SHOULD not tested, not observed
MWS-IN-6     SHOULD not applicable, held, not tested
MWS-IN-7     SHOULD held, not tested
MWS-CFG-1    MUST   held
MWS-CFG-2    MUST   held
MWS-CFG-3    MUST   held
MWS-CFG-4    SHOULD held
MWS-ANN-1    MUST   not observed, not applicable
MWS-ANN-2    MUST   not observed, not applicable
MWS-ANN-3    MUST   not applicable, not observed, not tested
MWS-ANN-4    SHOULD held
MWS-ANN-5    SHOULD not observed, not applicable
MWS-SEC-1    MUST   not observed

454 records in <seconds> s. One line per requirement; the report has one row per write path. There is no total.
mcp-writecheck is a preview: of the 37 requirements of MWS 0.9 it executes the test of 14 in full and of 23 in part; what is not built is reported "not tested" with the reason (README: Coverage in this preview).
report: <tmp>/mwsc-demo-results/<run id>/report.md
```

The demo prints one line per requirement so that it fits a terminal; the report and `results.json` have one record per requirement and write path, and nothing adds them up. With every defect on, two requirements are not `violated`, on purpose: MWS-CONC-5 and MWS-CONC-6 have review-only clauses here, so their records are `self-attested`, with the answer "no". On the correct build no line says `violated`; each `not tested` and `not applicable` record says why (for example, a write tool no check exercises for a requirement, or a part of a test not built in this preview).

The demo confirms the target and the plan hash itself, because it started the target on loopback with an in-memory backend. `run` never does.

## Coverage in this preview

Each requirement of MWS 0.9 (spec text: MWS 0.9 as published for comment; 37 requirements, 26 MUST, 11 SHOULD), and whether this preview has an executable check for it. "Partial" says what is not built; those parts are reported `not tested` with the reason "not built in this preview". Every declared write tool that no check exercised for a per-tool requirement (MWS-RES-1, RES-2, IN-1 to IN-4, IN-6, IN-7, CONC-2) gets its own `not tested` row, so a `held` on one tool never stands for another.

| Requirement | Level | Executable check | Not built in this preview |
|---|---|---|---|
| MWS-UPD-1 | MUST | yes |  |
| MWS-UPD-2 | MUST | partial | the control arm (insertion, removal and reordering are all forced) |
| MWS-CONC-1 | MUST | partial | a control that is not a version precondition, such as a lock held by another user (the lock branch, with its unengaged baseline and the rule that a refusal must show the control, R10-10); a client that declares the elicitation capability and declines a confirmation (spec 7.3, rule 10): the tester declares none, so no confirmation is asked |
| MWS-CONC-2 | MUST | partial | tools other than the update, delete and `versioned` tools |
| MWS-CONC-3 | MUST | yes |  |
| MWS-CONC-4 | MUST | yes |  |
| MWS-CONC-5 | SHOULD | yes |  |
| MWS-CONC-6 | SHOULD | yes |  |
| MWS-TGT-1 | MUST | partial | update and delete tools that take a scope argument (an object of the same name in each scope), except the selector tool, which is tested only with `selector.narrow` and `selector.send_empty_forms` |
| MWS-TGT-2 | MUST | partial | a client that declares the elicitation capability and declines a confirmation (spec 7.3, rule 10). The forms are destructive by design and run only with `selector.send_empty_forms: true`, on a backend where every object is disposable |
| MWS-TGT-3 | MUST | partial | a client that declares the elicitation capability and declines a confirmation (spec 7.3, rule 10) |
| MWS-RES-1 | MUST | partial | a write tool with no declared effect (`effects`, an `input_required` effect, or a `multi` block) other than the update and delete tools; the control arm for those effects (`platform`) |
| MWS-RES-2 | MUST | partial | a write tool the manifest declares no call for (the failed request and the lost answer run for each declared write call with backend.gate: create, delete, `calls`, `versioned`, `input_required`, `creates`, the update tool and the multi-item tools); judging an `input_required` result after the retry, or a task on what the terminal task carries; the settled-outcome runs of provoked failures through the interposer (the run without a fault and the lost-answer trial are built) |
| MWS-RES-3 | MUST | yes |  |
| MWS-RES-4 | SHOULD | yes |  |
| MWS-ATOM-1 | MUST | partial | a multi-item delete that takes the scope argument, unless it is the selector tool and its MWS-TGT-1 is held in the run (spec 7.3, rule 1); a multi-item delete with no container of the tester's own. A multi-item bulk update is called in the tester's container without an MWS-TGT-1 of its own |
| MWS-ATOM-2 | SHOULD | partial | as MWS-ATOM-1 |
| MWS-RETRY-1 | SHOULD | yes |  |
| MWS-RETRY-2 | MUST | partial | an append (`idempotency.kind: append`); judging a task or `input_required` answer on its final result; seeing at the interposer that the server undid an update after the cut (the delete of a created object is seen) |
| MWS-RETRY-3 | MUST | partial | deciding whether a backend write before the result was staged state the retry completes |
| MWS-IN-1 | MUST | partial | the probes of an identifier, element id or selector of a write tool other than the update tool are sent only under the disposable-backend declaration (`selector.send_empty_forms`); the scope and version arguments are not probed; a write tool whose declaration gives no call that succeeds is `not tested`; a refused probe whose counterpart would send another value to a tool that writes an existing object is not judged unless the declaration lists the argument (`inputs.<tool>.counterpart_args`; spec R15-4) |
| MWS-IN-2 | MUST | partial | the probes of an identifier, element id or selector of a write tool other than the update tool are sent only under the disposable-backend declaration (`selector.send_empty_forms`); the scope and version arguments are not probed; a write tool whose declaration gives no call that succeeds is `not tested`; nested levels; a notice the default "not used" pattern cannot decide is `not tested` (declare `patterns.not_used`) |
| MWS-IN-3 | MUST | partial | the probes of an identifier, element id or selector of a write tool other than the update tool are sent only under the disposable-backend declaration (`selector.send_empty_forms`); the scope and version arguments are not probed; a write tool whose declaration gives no call that succeeds is `not tested`; nested levels |
| MWS-IN-4 | MUST | partial | the probes of an identifier, element id or selector of a write tool other than the update tool are sent only under the disposable-backend declaration (`selector.send_empty_forms`); the scope and version arguments are not probed; a write tool whose declaration gives no call that succeeds is `not tested`; a refused probe whose counterpart control cannot be sent (spec R15-4) leaves the record not held |
| MWS-IN-5 | SHOULD | partial | the run-wide search of every refused call of the other checks; the search starts only from a resource's read, list, create and update calls (other write tools are `not tested`); identifiers, scope, version and idempotency-key arguments, enums, booleans, objects and formatted array items are not searched; at most `limits.in5_probes` calls per tool and `limits.in5_creates` per create tool. `violated` rests on the declaration (`fixed_constraints`); a constraint only the tester's differential reading confirms (neighbours accepted, the refusal repeated in a fresh context with its neighbour accepted again after it, a monotonic boundary found by bisection) is a candidate, seen, not judged, unless `--in5-reading=tester` (spec draft 0.10) |
| MWS-IN-6 | SHOULD | partial | the probes of an identifier, element id or selector of a write tool other than the update tool are sent only under the disposable-backend declaration (`selector.send_empty_forms`); the scope and version arguments are not probed; a write tool whose declaration gives no call that succeeds is `not tested` |
| MWS-IN-7 | SHOULD | partial | the probes of an identifier, element id or selector of a write tool other than the update tool are sent only under the disposable-backend declaration (`selector.send_empty_forms`); the scope and version arguments are not probed; a write tool whose declaration gives no call that succeeds is `not tested`; nested levels |
| MWS-CFG-1 | MUST | partial | settings applied with a request (sent with `tools/list` and a call to each write tool) |
| MWS-CFG-2 | MUST | partial | settings applied with a request (sent with `tools/list` and a call to each write tool); a declared tool that exists and is switched off |
| MWS-CFG-3 | MUST | partial | settings applied with a request (sent with each call) |
| MWS-CFG-4 | SHOULD | partial | settings applied with a request (sent with `tools/list`) |
| MWS-ANN-1 | MUST | yes |  |
| MWS-ANN-2 | MUST | yes |  |
| MWS-ANN-3 | MUST | yes |  |
| MWS-ANN-4 | SHOULD | yes |  |
| MWS-ANN-5 | SHOULD | yes |  |
| MWS-SEC-1 | MUST | yes |  |

## Use

```sh
mcp-writecheck init --out manifest.yaml --env BACKEND_URL -- node ./my-server.js   # drafts from tools/list; every guess is marked
mcp-writecheck plan -m manifest.yaml                                                # every call a run would make, and the plan hash
mcp-writecheck catalog -m manifest.yaml                                             # catalog-only: MWS-ANN-4 from tools/list, no tool call, no account
mcp-writecheck run  -m manifest.yaml                                                # asks for the target and the plan hash
mcp-writecheck run  -m manifest.yaml --confirm-target <target> --plan-hash <hash>   # in CI; there is no --yes
mcp-writecheck review  mwsc-results/<run>                                          # the review-only questions, with the evidence
mcp-writecheck recheck mwsc-results/<run> [--review answers.yaml]                  # re-apply the rules offline
mcp-writecheck rerun   mwsc-results/<run> -m manifest.yaml                         # run the same plan again
mcp-writecheck cleanup -m manifest.yaml                                             # what an interrupted run left
mcp-writecheck run  -m manifest.yaml --baseline baseline.yaml --sign ~/.ssh/key             # known violations that do not fail the run; ssh signature of SHA256SUMS
mcp-writecheck plan -m manifest.yaml --pair-budget 2x1500                           # opt in to the MWS-CONC-3 barrier-pair budget (about 12,000 writes per resource); give run the same flag
mcp-writecheck run  -m manifest.yaml --in5-reading=tester                           # MWS-IN-5: record a constraint only the tester's reading confirms as violated (spec draft 0.10)
mcp-writecheck cleanup -m manifest.yaml --abandon                                   # record leftover objects as left behind and touch nothing
mcp-writecheck run  -m manifest.yaml --server-commit <sha> --server-image <ref@sha256:…> --sign-key key.pem   # a pinned, signed run
mcp-writecheck verify-results mwsc-results/<run> --pubkey signer.pub                # signed by that key, and unchanged
mcp-writecheck compare before/<run> after/<run> --out cmp                           # before/after per cell, joined on test hashes; --fail-on-slot-regression false only warns on a slot regression
```

`mcp-writecheck <command> --help` describes each command and its options. An unknown option or command is refused with a pointer to that help.

## The manifest, at its smallest

```yaml
mws: "0.9"
server:
  stdio: [node, ./my-server.js]
  env_passthrough: [API_TOKEN]       # values are redacted everywhere, and looked for in results (MWS-SEC-1)
  env_public: [BACKEND_URL]          # passed through, not redacted
target:
  environment: test
  confirm: "staging-tracker.internal"
  guard: { tool: whoami, args: {}, path: tenant, pattern: "^test-" }
resources:
  - name: ticket
    create:  { tool: ticket_create, args: { title: "{{marker}}" }, id: id }
    read:    { tool: ticket_get, args: { id: "{{id}}" }, object: ticket, ignore: [updated_at] }
    update:  { tool: ticket_update, mode: field_patch, args: { id: "{{id}}", "{{field}}": "{{value}}" } }
    fields:  [ { path: assignee, values: [ann, bob] }, { path: status, values: [in_progress, closed] } ]
    cleanup: delete
    delete:  { tool: ticket_delete, args: { id: "{{id}}" } }
```

Pick each field's first value so that it is not the field's default: a tool that resets an omitted field to its default can only be seen when the field held something else. `{{marker}}` is a fresh value carrying the run's prefix (`mwsc-<run>-…`); cleanup recognises the run's objects by it. `{{?name}}` sends an argument only when it has a value.

`examples/tiny-tracker/writecheck.yaml` in this repository is a complete manifest for a 15-tool server.

## Optional blocks, and what each unlocks

Without a block, the requirements it unlocks are `not tested` (or `not applicable` where the declaration says the condition is false), with the reason and what to declare.

| Block | Unlocks |
|---|---|
| `server.launch` (or `server.stdio`) | A server the tester starts, which the backend gate and the launch checks need. `launch` starts a streamable HTTP server and reads its URL from its first stdout line. |
| `backend.gate` (`rewrite_env` or `node_import`) | The proxy-assisted tests: MWS-CONC-3 by held request; MWS-CONC-1 for a tool that reads and writes inside one call; MWS-RES-2, RES-3, RETRY-2, ATOM-1 and ATOM-2 by failing a named backend request |
| `version` (`read`, `arg`, `optional`, `override`) | MWS-CONC-2 and CONC-4 for the update tool; with `{{version}}` in `delete.args`, for the delete tool too. With `optional: true`, MWS-CONC-2 runs a second time with the version left out for a whole-object update tool and for the delete tool (never for a field patch, spec NF-12); `override` names the explicit argument (such as `force`) the tester sends to those tools wherever it sends no version, and leaves out in that run |
| `versioned` | MWS-CONC-2 and CONC-4 for other tools that take the version the caller read |
| `control` (`read`, `patch`, `write`, `delete`, `create`) | Attribution (`violated` versus `platform`), MWS-CONC-1, and setup through the platform's own API |
| `update.cases` | MWS-RES-1 cases of your own: an update, and what must be in effect afterwards |
| `effects` | MWS-RES-1 for every other write call: the call, and what must be in effect afterwards (created, deleted, a value set, an element added or removed) |
| `scope` | MWS-TGT-1, and a container of the run's own |
| `selector` (`narrow`, `send_empty_forms`) | MWS-TGT-2. **Destructive by design:** a server that ignores the scope or the selector deletes objects the tester did not create, and no order of black-box calls rules that out. The empty-selector forms, and the MWS-TGT-1 call on the selector tool that gates them, are sent only with `send_empty_forms: true`, which you set only where you, the operator, declare that every object the server's identity can change in the backend is disposable and that nothing else writes there during the test (spec 7.3, rule 1, R10-5); without it MWS-TGT-2 is `not tested` with that reason. With it: inside a container the tester created and confirmed holds only its objects, after MWS-TGT-1 is `held` for the selector tool itself (spec 7.3, rule 1). `narrow` (each value a string carrying `{{marker}}`, naming an argument the tool declares) lets the tester run that MWS-TGT-1. Before and after every targeting call the tester lists every object it can list outside its own, and around a selector call reads each back by id; a loss is in the record and at the top of the report, and that record is never `held`. The inventory is only as complete as the server's lists: the record and the report say what was listed, a selector record on a partial inventory is `not tested`, and a `held` record says the objects outside its own were "not seen to be lost" |
| `update.apply` | Declares that the update tool sends an apply with field ownership (spec section 4: neither field patch nor full replace): its MWS-CONC-2 rows are `not tested` and it gets no version-left-out run. The tool cannot infer this; without it, such a tool can get a false MWS-CONC-2 `violated` |
| `update.override` | Declares that the update arguments set an explicit override (NF-7): MWS-CONC-1 is then `not tested` instead of a false `violated`. The tool cannot infer this; without the line, a tool whose declared update arguments carry an override gets a false MWS-CONC-1 `violated` |
| `target.guard.read_only` | Declares that the guard tool only reads, for a server that annotates no tool `readOnlyHint: true` (a tool declaring `readOnlyHint: false` or `destructiveHint: true` is still refused). The tool cannot infer this; without it, `run` refuses such a server |
| `key` | MWS-TGT-3, and MWS-ANN-2 for a create with a caller-chosen key |
| `multi` | MWS-ATOM-1 and ATOM-2 |
| `list_edit` | MWS-UPD-2 |
| `list`, `creates` | MWS-RES-3, RES-4 and RETRY-1 for create tools (`list.consistency` for a list that shows a new object only after a while) |
| `idempotency` (with `list` and `{{marker}}` in its `args` for a create) | MWS-RETRY-2 steps (a) to (d); with `backend.gate`, the proxy-assisted step; with `server.restart`, step (e), and with both, its crash form. `own_checks`, `backend_key`, `key_record_survives` and `version_steps` (an update) are the declaration's statements the verdicts rely on (MANIFEST.md) |
| `server.restart` (`stop: graceful` or `kill`) | MWS-RETRY-2 step (e) and its crash form: the tester stops and starts the server it launched |
| `failures` | MWS-RES-2 for calls the backend will refuse |
| `patterns` (`applied`, `outcome_unknown`, `not_used`, `unavailable`, `no_tools`, …) | What a result says (spec 7.3, rule 11). A built-in default never decides a `held` or `violated` on its own: MWS-RES-2's second clause and MWS-ATOM-1 need `applied` and `outcome_unknown`, MWS-IN-2's notice `not_used`, MWS-CFG-4's list error `no_tools`, MWS-RETRY-2's reading of an error `applied` and `unavailable`; without them those records are `not tested`, quoting the text. MANIFEST.md lists every kind |
| `results: { shape: write-result/0.1 }` | A result shape adopted by name and version (spec 7.3, rule 11; draft Annex B-9). Where a result carries it well formed, it decides what the result says before the patterns, and the record quotes the member; the read-back still decides what happened, and a shape that cannot be read falls back to the patterns. MANIFEST.md, section results |
| `list.next` (`path`, `arg`) | Lists read to the end: the MWS-RETRY-2 trace, the bystander inventory and clean-up. Without it a paged answer makes the trace partial (no verdict from it) |
| `input_required` | MWS-RETRY-3: the tool, its arguments, and the answers to send on the retry (revision 2026-07-28) |
| `try_values` | MWS-IN-5: values valid by the update tool's schema to try (`{ arg, value }` or `{ arg, length }`), sent by the IN-5 search beside its own values; optional |
| `no_version_check` | MWS-CONC-5: tools for which the backend has no version check (MWS-CONC-2 is then `not applicable`) |
| `missing_id` | Error answers for the credential scan |
| `settings` (`read_only`, `tool_filters` with `kind: deny` or `kind: allow`, `per_request`) | MWS-CFG-1 and CFG-3 (read-only), CFG-2 (deny-list), CFG-4 (allow-list); launch checks. A setting applied with a request is declared under `per_request` and reported `not tested` in this preview |
| `secrets` (`canaries_env`, `token_params`, `issuing_tools`) | MWS-SEC-1 beyond the server's own credentials; `issuing_tools` lists tools that exist to issue a credential (spec NF-16) |
| `calls` | Annotation checks (MWS-ANN-1 to ANN-3, ANN-5) for other tools, on scratch objects |
| `jobs` | Annex A-1 round trips (measured, never judged) |
| `canaries` | Untouched state: read-only calls before and after the run, compared |
| `review` | Answers to review-only clauses, recorded as `self-attested` |
| `fixture` | A pre-made object named `mwsc-…` instead of a create; its two fields are put back afterwards |

Update modes: `field_patch`, `full_replace`, `command`, `composite` (several backend writes in one call; with the gate, its second and its last writes are failed for MWS-ATOM-1 and ATOM-2). The mode decides which requirements apply; it never excuses a lost update.

## Min mode: a mock of the backend from its OpenAPI description

Where the backend is somebody's hosted service, `mcp-writecheck min` runs the requirements that test the server's own layer against a mock of that backend made from its OpenAPI 3.x description, inside your sandbox:

```sh
mcp-writecheck min --spec openapi.yaml --spec-url https://example.com/openapi.yaml \
  --base-url-env API_BASE_URL --env API_TOKEN --declaration writecheck.yaml --out min-results -- node dist/server.js
```

- The mock is built in (no third-party mock server to fetch or pin). It keeps the objects a create made so they can be read back, honours a declared `Idempotency-Key` header, records every request the server sends, and fails a named request (the second mutating one, the batch naming its second item, a lost answer after the write was applied, a conflict) when a check asks for it. Every fault is listed in `results.json` (`faults_injected`).
- The server's base-URL variables (`--base-url-env`, and any `--env` name ending in `_URL`, `_HOST`, `_ENDPOINT` and the like) point at the mock; every other variable gets a dummy, a secret-like one a canary made for the run (MWS-SEC-1 looks for it in every result). Never give it a real credential. The plan is accepted without a person only when every target is the mock; any other URL refuses the run (`target_not_standin`).
- What runs, and why, is one data file: `src/min/requirements-min.json`. The nine requirements that need real backend semantics (MWS-UPD-1/2, MWS-CONC-1/2/3, MWS-TGT-1/3, MWS-RES-1, MWS-ATOM-2) are always `not tested`, status `not_testable_mock`, reason code `backend_semantics_not_exercised`: never held, never violated. MWS-RES-2, MWS-RETRY-2, MWS-ANN-2/3/5 and MWS-TGT-2 are judged on the half a mock can show and are never held. Every record says `basis: stateful-mock`.
- `--declaration` reads only the patterns, review answers, adopted result shape, settings, selector, `multi` reports, `fixed_constraints`, `try_values` and `no_version_check` of a manifest; a member marked `# guessed` is ignored, and a requirement that needs a member that is absent is `not tested` (`declaration_missing`).
- A server that will not start against the mock, crashes on its reply, or asks for an endpoint the description lacks is `not tested`: the mock's limit, never the server's violation.
- `results.json` is `mws-min-results/1`: `mode: "min"`, the spec's URL and sha256, the requirements that ran, and the records. Count it apart from a full run. Exit 0 complete, 1 a violated record, 3 refused or the server did not start against the mock.

## The backend gate

The gate interposes on the hop between your server and its backend, so that a concurrency or failure case is forced by holding or failing one named request, never by timing. Two routes:

- `backend.gate.rewrite_env: BACKEND_URL`: the tester starts a loopback forwarder and gives your server its URL in place of the real one (which the tester reads from its own environment). TLS to the real backend is verified normally.
- `backend.gate.node_import: true`: for Node servers, a hook loaded with `node --import` wraps `fetch` inside the server process. Every result obtained this way says so, because the server's author controls where such a hook sits.

A learning pass runs each write alone and records its backend requests; a schedule then holds the last mutating one, or fails a chosen one. Every proxy-assisted record states the route and which request was held or failed, and when it was released.

## Results

Per write path (resource and tool, or a setting), never per server: `violated`, `platform` (the platform's own API does the same), `held` (the situation was forced and the server did the right thing), `not observed` (attempted, not forced; with the numbers; not evidence of safety), `not tested` (with the reason), `not applicable`, `self-attested` (a review-only clause, with the answer and who gave it). No total, no score, no badge.

Each run writes `report.md` (first line: the scope), `results.json` (`schema/mws-results-1.schema.json`), `junit.xml` (only `held` passes, only `violated` fails, the rest is skipped), `capture/`, `history.jsonl`, `ledger.jsonl`, `SHA256SUMS`, and with `--sign <ssh key>` an `ssh-keygen -Y sign` signature. Exit status 1 only for a violated MUST not in the `--baseline` file, or for a baseline entry that came out definitely not violated. Exit status 4 for an incomplete run, whatever its verdicts: the target or its backend stopped answering (the tenant guard's read is made again between checks), or clean-up could not finish (a delete failed, a create's outcome is unknown, clean-up stopped); the report says why in its first lines, and such a run is never `complete`. Exit 4 takes precedence over 1, so a target that leaves objects behind on every run (a soft delete, a list with more pages and no `list.next`) exits 4 until that is fixed or declared. Neither the exit status nor `junit.xml` is a verdict on the server: exit 0 means no new violated MUST was found in what was tested, and the `not tested` rows say what was not.

Every `results.json` names what it came from: `identity` (the tester build and commit, the MWS version, the manifest, plan and tool-list hashes, the server build and backend images you state with `--server-commit`, `--server-image`, `--backend-image` or `--provenance`, the runner, and `gaps`, each member not stated or not pinned) and a `test_hash` on every record, a hash of exactly what defines that test and not the rest of the tool list. With `--sign-key` (an Ed25519 key, never written anywhere) results.json is signed in `evidence.signature`; `verify-results --pubkey` checks it against a key you pinned. `compare` joins two runs per cell on equal test hashes, rolls verdicts up by MWS 8.2 rule 13, and labels each cell `fixed` (violated → held only), `regressed`, `unchanged`, `changed` (never a fix) or `not comparable`, with the reason. [MANIFEST.md, Run identity](MANIFEST.md#run-identity) gives the exact hash inputs, the signature format and the compare rules.

## Review-only clauses

Some clauses are answered by a person, not measured: whether a conflict says the write was not applied (MWS-CONC-4), whether a refusal gives its reason (MWS-IN-4), whether a tool's description discloses that stale writes are not detected (MWS-CONC-2, asked only where the platform's API applies them), and whether a tool declaring `openWorldHint: false` reaches nothing outside its backend (MWS-ANN-4). `mcp-writecheck review <results>` lists them with the captured evidence. Answer them in the manifest's `review` block, as rules (for example, a pattern that a conflict's text must match) or as one answer per question id; the record is `self-attested` and names who answered. An unanswered clause is `not tested`.

## Seat belts

None of these proves that a target is a test system. The manifest must say `environment: test`; the target and the plan hash are typed back (there is no `--yes`); obvious production hosts and registered production catalogs are refused; a read-only guard call must match before any write; every object carries the run prefix and goes through a write-ahead ledger; cleanup deletes only ledger objects that still read back as the run's; a write budget and a rate limit apply, and the run stops at the first 429; server processes run under a supervisor that kills their process group when the tester exits, even on SIGKILL; canaries are compared before and after; a fixture is put back to its original values.

## Develop

```sh
npm ci && npm test                                        # unit, fake-server, safety and infrastructure tests
TINY_TRACKER_DIR="$PWD/../../examples/tiny-tracker" npm test   # also the tiny-tracker self-test (build tiny-tracker first; see "Try it"; the path must be absolute)
```

The tiny-tracker self-test (`test/integration/tiny-tracker.test.ts`) is the matrix of the spec's change process: the correct build gives no `violated` (over both protocol revisions), each defect gives its own requirement (plus the secondary effects the test lists, each a requirement the defect really breaks under the spec's method), all defects together leave only the two requirements noted above unviolated, and the backend's own lost update is `platform`.

Made by [IsoKron](https://isokron.ai/?utm_source=writecheck-readme&utm_medium=readme).
