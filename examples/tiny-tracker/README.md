<img src="https://raw.githubusercontent.com/isokron-ai/mcp-write-safety-kits/main/assets/mws-mark-128.png" alt="MCP Write-Safety Requirements mark" width="72" height="72">

# tiny-tracker

**A teaching server, not a starting template.** tiny-tracker is a small issue tracker with an MCP server in front of it. Its default build is meant to meet every applicable requirement of the MCP Write-Safety Requirements (MWS). Its broken builds switch on deliberate defects, one per requirement, each in its own clearly labelled file. It exists to show what each requirement means in code and to be the fixed target that `mcp-writecheck` tests itself against.

If you want a starting point for your own server, read the correct handlers in `src/mcp/tools/` and ignore `src/defects/`.

- Node 22 or later, TypeScript, the official MCP TypeScript SDK (`@modelcontextprotocol/server` 2.4.0).
- Streamable HTTP. Protocol revision 2026-07-28, with the SDK's stateless fallback for 2025-11-25 clients.
- One direct runtime dependency (the SDK, which brings `zod` with it). No network access beyond 127.0.0.1.
- npm package `@mcp-write-safety/tiny-tracker` (command `tiny-tracker`): `npx -y @mcp-write-safety/tiny-tracker all`, or build it from this folder (below). Its `writecheck.yaml` is the `mcp-writecheck` manifest for it.
- The requirements: [MCP Write-Safety Requirements 0.9](https://isokron.ai/mws). Source: [isokron-ai/mcp-write-safety](https://github.com/isokron-ai/mcp-write-safety/tree/main/examples/tiny-tracker).

## Contents

- [Shape](#shape)
- [Run it](#run-it)
- [Tools](#tools)
- [Defects](#defects)
- [The platform verdict](#the-platform-verdict)
- [Tests: the self-test matrix](#tests-the-self-test-matrix)
- [Safety of the broken builds](#safety-of-the-broken-builds)
- [What this does not cover yet](#what-this-does-not-cover-yet)
- [Shared fixture (in development)](#shared-fixture-in-development)

## Shape

```
MCP client ──Streamable HTTP──▶ MCP server (src/mcp) ──HTTP──▶ [optional gate] ──▶ backend (src/backend)
                                 18 tools, thin                                     REST API, in memory
```

The **backend** is deliberately correct. It is the "platform" whose checks the MCP layer must not lose:

| Route | What it does |
|---|---|
| `GET /projects`, `POST /projects`, `GET/DELETE /projects/:key` | Projects. POST refuses an existing key (409); DELETE refuses a project with tickets (409). |
| `PUT /projects/:key` | Create or replace. The correct MCP layer never uses it to create. |
| `GET /tickets?project=&status=&title_prefix=`, `POST /tickets` | List and create. |
| `GET/PATCH/PUT/DELETE /tickets/:id` | The version is the `ETag`. `If-Match` is checked (412 with the current ticket). PATCH changes only the fields sent; PUT replaces the scalar fields and needs `If-Match` or `?force=true` (428). A re-sent conditional write that was already applied is answered as a replay. |
| `POST /tickets/:id/comments`, `POST /tickets/:id/labels`, `DELETE /tickets/:id/labels/:labelId` | Comments; labels with stable row ids. |
| `POST /batch` | All-or-nothing patch and delete operations. |
| `GET /export` | Every project and ticket (for tests and the suite's oracle). |

Every request needs `Authorization: Bearer <TRACKER_BACKEND_TOKEN>`. A POST with `Idempotency-Key` is applied once; the same key with a different request is refused (422).

The **MCP layer** talks to the backend only over HTTP, so a loopback gate can sit in between (base-URL rewrite through `TRACKER_BACKEND_URL`). That is how the suite forces an interleaving or a fault on the server-to-backend hop.

## Run it

```sh
cd examples/tiny-tracker
npm ci
npm run build

# correct build: backend and MCP server in one process, random loopback ports
node dist/src/cli.js all
# {"backend":"http://127.0.0.1:53211","mcp":"http://127.0.0.1:53212/mcp","defects":[],"read_only":false}

# broken build: one defect by name, all defects for a requirement, or all of them
node dist/src/cli.js all --defect read-merge-put
node dist/src/cli.js all --defect MWS-RETRY-2
node dist/src/cli.js all --defect all

# the backend itself loses concurrent updates (for the platform verdict)
node dist/src/cli.js all --backend-defect lost-update
```

The first line on stdout is JSON with the URLs. A broken build prints a banner on stderr. Stop with Ctrl-C.

Backend and server as separate processes (for example, to put a gate between them):

```sh
export TRACKER_BACKEND_TOKEN=some-local-test-token
node dist/src/cli.js backend --port 4100
TRACKER_BACKEND_URL=http://127.0.0.1:4200 node dist/src/cli.js server --port 4300   # gate on 4200 forwards to 4100
```

| Setting | Flag | Meaning |
|---|---|---|
| `TRACKER_BACKEND_URL` | `--backend-url` | Backend base URL (server mode). A build with defects accepts only a loopback URL. |
| `TRACKER_BACKEND_TOKEN` | | Bearer token for the backend. `all` generates one if unset. |
| `TRACKER_READ_ONLY` | `--read-only` | `true`/`1`/`yes`/`on` or `false`/`0`/`no`/`off`; unset or empty means off. Any other value stops the server (exit 2). |
| `TRACKER_TOOLS` | `--tools` | Comma-separated allow-list. An unknown name, or a list that names no tool, stops the server (exit 2). |
| `TRACKER_DENY_TOOLS` | | Comma-separated deny-list. An unknown name stops the server (exit 2): a typo would leave the tool it meant switched on. |
| `TRACKER_DEFAULT_PROJECT` | `--default-project` | Project for `create_ticket` when the caller names none. Default `inbox` (seeded). |
| `TRACKER_DEFECTS` | `--defect`, `--defects` | Defects to switch on. An unknown name stops the server (exit 2). |
| `TRACKER_VARIANTS` | | Correct variants to switch on (see [Variants](#variants)). An unknown name stops the server (exit 2). |
| `TRACKER_KEY_JOURNAL` | | The journal file of the `key-store-honest` variant (required with it). |
| | `--backend-defect` | `lost-update`. |
| `TRACKER_MCP_TOKEN` / `TRACKER_MCP_TOKEN_FILE` | | Bearer token for `/mcp`. Required in container mode; optional otherwise. Refused with `stdio`. |
| `TRACKER_CONTAINER` | | `1` in the image: listen on every interface, and refuse to start without an MCP token. Only `1` or `0`. Refuses `tiny-tracker backend`. |
| `TRACKER_EVIDENCE_LISTEN` | | `HOST:PORT`: a listener with the evidence routes only, behind the evidence token (needs `evidence` and `all`). Off loopback a defect build is refused outside container mode; in container mode it serves its evidence there too, behind the evidence token. |

**Over stdio.** `npx -y @mcp-write-safety/tiny-tracker stdio` speaks MCP on stdin and stdout, so a client that launches servers as a command can run it directly. It is `tiny-tracker all` with the MCP layer on stdio: the backend runs in the same process on a loopback port, and every option of `all` works (defects, `--profile`, `--features`, the fixture features, `--fixture-control`) except `--port` and `--supervise`. `--backend-url URL` (with `TRACKER_BACKEND_TOKEN`) points it at a backend you run yourself, as `server` does. stdout carries only protocol messages: the state line and the broken-build banner go to stderr. The process exits when stdin closes.

**In a container.** The image runs `tiny-tracker all` on port 47310 in container mode. Container mode listens on every interface inside the container, so it needs a bearer token for `/mcp` and will not start without one:

```sh
docker build -t tiny-tracker examples/tiny-tracker
install -m 600 /dev/null mcp.token && openssl rand -hex 24 > mcp.token
docker run --rm --init -p 127.0.0.1:47310:47310 \
  -v "$PWD/mcp.token:/run/secrets/mcp.token:ro" -e TRACKER_MCP_TOKEN_FILE=/run/secrets/mcp.token tiny-tracker
```

Send `Authorization: Bearer <token>` with every request to `http://127.0.0.1:47310/mcp`. Publish the port on `127.0.0.1` only: Host and Origin checks on `/mcp` still allow only `localhost` and `127.0.0.1`. To read the evidence from outside the container (the build descriptor, the ledger, execution and operation records), name the `evidence` feature and set `TRACKER_EVIDENCE_LISTEN=0.0.0.0:47312` with an evidence token; that listener serves the evidence routes only, for any Host, and only with the evidence token (the Dockerfile shows the command). A build with defects does the same, with no opt-in. `docker run --rm -i tiny-tracker stdio` needs no token. The image runs as the unprivileged `node` user; `/data` and `/tokens` are 0700 for `--data-dir` and `--token-dir`.

**A bearer token outside a container.** Set `TRACKER_MCP_TOKEN` (or `TRACKER_MCP_TOKEN_FILE`, a file only you can read) and `/mcp` answers 401 without it. The token follows the rules of every other token: 16 to 256 printable characters, different from every other token (the principals', evidence and control tokens included), never on the command line, never printed.

Objects are named for cleanup by run prefix: project keys are chosen by the caller (`mwsc-<run>-a`), and tickets can be listed and deleted by `title_prefix`. `test/cleanup.test.ts` shows a full sweep through the MCP tools.

## Tools

Annotations in the correct build. Every tool also declares `openWorldHint: false`: each reaches only the tracker's own backend. Read-only mode is enforced from the server's own record of which tools write, never from these annotations.

| Tool | readOnly | destructive | idempotent | Notes |
|---|---|---|---|---|
| `list_projects`, `list_tickets`, `get_ticket` | true | | | `get_ticket` shows label ids and the version. |
| `get_operation`, `get_execution` | true | | | From 0.2.0, with the `lookup` feature (on in the default profile; not under `--profile 0.1`, which lists the 16 tools of 0.1.0). `get_operation {idempotency_key}` looks up the write a key made, among your own writes; a miss says "no record of this key now", which never means nothing was written. `get_execution {id}` reads an execution record (`X-<n>`) with its committed result's canonical bytes and digest. |
| `create_project` | false | false | false | POST; an existing key is an error; optional `idempotency_key`, sent to the backend. |
| `delete_project` | false | true | true | Only an empty project. |
| `create_ticket` | false | false | false | `project` honored; optional `idempotency_key`. |
| `update_ticket` | false | true | true | One per-field PATCH; needs `expected_version`, or `force: true` to write without the check; `assignee: null` unassigns; `description` may be set to an empty string; `details` (nested) sets only the sub-fields named. |
| `replace_ticket` | false | true | true | Needs `expected_version`; `force: true` is the explicit, off-by-default override. |
| `delete_ticket` | false | true | true | Needs `expected_version` (sent as given), or `force: true` to delete without the check. |
| `delete_tickets` | false | true | true | Needs a filter or `all: true`; one all-or-nothing batch. |
| `bulk_update_tickets` | false | true | true | One all-or-nothing batch; every item's outcome reported. |
| `add_comment` | false | false | false | Returns the comment id; optional `idempotency_key`. |
| `add_label` | false | false | true | Adding an existing label changes nothing. |
| `remove_label` | false | true | true | By stable label id. |
| `set_labels` | false | true | true | Replaces the whole list; needs `expected_version`, or `force: true` (the explicit, off-by-default override). |
| `close_ticket` | false | true | true | Asks for confirmation first (an `input_required` result, revision 2026-07-28); writes only on the confirmed retry. |

Ticket writes answer with one plain sentence and a compact receipt in `structuredContent` (`id`, `version`, `changed`, `replayed`); project and bulk writes return what they made, deleted or applied. Every write tool's result, success and error alike, also carries the result shape `write-result/0.1` (MWS Annex B-9) as `structuredContent.mws`: `outcome` (`applied`, `not_applied`, `unknown`; `partial` and `accepted` are never true of this backend), `repeat` (after `applied`, `same_key` or `same_version` where the call carried one, else `no`; `read_first` on every conflict), `operation`, `object` (`type`, `id`, `version` as the backend's integer, `scope` only from a scope argument, `parent` for a comment's ticket), `changed` as JSON Pointers (a create lists the fields the caller set, not the scope argument), `replayed` (a repeat with a key that applied nothing; the members describe the keyed write), `items` for the bulk tools (all or nothing: the item that stopped the batch is `not_applied` with its reason and its own `conflict`, the rest `not_attempted`), `applied_count` for `delete_tickets`, `code` (the reserved `conflict`, `version_required`, `invalid_argument`, `not_found`, `idempotency_key_reused`, `key_not_known`, `not_permitted` for a write tool called in read-only mode, `not_sent`, `no_answer`, `backend_error`, and tiny-tracker's own such as `already_exists`, `empty_filter`), `argument`, `conflict` (`current_version`, `checked_by: backend`, `current_state`, `omitted: ["/comments"]`), `read_with` and `version_argument`. A second text block carries the serialized `structuredContent`, after the sentence; the sentence does not restate the conflict's state. A replay of a conditional write leaves `changed` out where the backend does not return the first call's list (a missing member says nothing; `changed: []` would say nothing changed). The helpers are in `src/mcp/results.ts`; `mcp-writecheck` adopts the shape in the shipped manifest (`results: { shape: write-result/0.1 }`). Input-validation refusals made by the SDK, before a handler runs, carry no shape and are read as text. Failures are always `isError: true` and say whether anything was written; when the backend cannot be reached or the connection breaks, they say the outcome is unknown and to read before retrying. A conflict says that nothing was changed and asks the caller to read the ticket before writing again; the current state and version are in the JSON block, with or without the shape, and the sentence is the same in both and never restates them. It is worded by the MCP Write-Safety kits' rules (`src/mcp/text.ts`), pinned by their shared golden file (`test/golden/first-sentence.json`, a byte-for-byte copy). `get_ticket`'s text gives label names quoted with their ids in JSON, and the version on its own line (`current expected_version: 3`); `list_tickets` quotes each title as a JSON string, with the version on its own. The version and a compact current state (no comment history, so the body stays small however long the ticket's history) are in `structuredContent`. In read-only mode, write tools stay listed and refuse every call with a tool error that says why; the server instructions say so too.

## Defects

Each defect is one file in `src/defects/`, starting with a comment that names the requirement, what goes wrong, the published finding it imitates (by class, with the article link; no vendor code is copied) and the correct code it replaces. Read each next to the correct handler: the fix is always the code it replaces.

Requirement IDs come from `src/requirements.ts`, the only file that spells them. They follow the draft spec (0.9); if the spec renumbers, only that file changes.

| Flag | Requirement | What goes wrong | What the self-test sees | Mirrors |
|---|---|---|---|---|
| `update-adds-defaults` | MWS-UPD-1 | update_ticket resets status and priority to create-time defaults when the caller omits them | A title-only update also changes status and priority | Grafana GF-03; PostHog G1 |
| `label-by-position` | MWS-UPD-2 | remove_label removes the label at a list position, which shifts when the list changes | After another writer inserts, removes or reorders labels, removing "b" as read removes another label | Grafana GF-02; Payload PAY-06 |
| `force-by-default` | MWS-CONC-1 | replace_ticket overwrites without the version check unless the caller passes force: false | A replace from a stale read overwrites the newer ticket | Grafana GF-01; Payload PAY-01, PAY-02 |
| `delete-refetches-version` | MWS-CONC-2 | delete_ticket replaces the caller's expected_version with the current one, so stale deletes succeed | A delete with a stale version deletes the edited ticket | GitHub GH-02; Grafana GF-19 |
| `read-merge-put` | MWS-CONC-3 | update_ticket reads, merges and force-PUTs the whole ticket, losing concurrent changes to other fields | With the gate holding writer A's PUT until B finishes, both report success and B's change is gone | GitHub GH-01; Grafana GF-01 |
| `conflict-as-generic-error` | MWS-CONC-6 | set_labels reports a version conflict as "Request failed with status 412. Nothing was written." | The conflict carries neither the current state nor a re-read hint | Payload conflict recovery; PostHog what held up (passing reference) |
| `ignore-project-scope` | MWS-TGT-1 | create_ticket ignores its project argument and always writes to the default project | A ticket created for project P lands in `inbox` | Kubernetes K8S-20 |
| `empty-filter-deletes-all` | MWS-TGT-2 | delete_tickets with no filter deletes every ticket in the project | 3 of 3 tickets deleted by a call with no filter and no `all` | Payload PAY-03; GitHub GH-03 |
| `create-overwrites` | MWS-TGT-3 | create_project replaces an existing project with the same key and reports it as created | The second create renames the existing project and says "Created" | Kubernetes K8S-08 |
| `skip-null-assignee` | MWS-RES-1 | update_ticket drops assignee: null (unassign), writes the rest and reports success | Success reported; the ticket is still assigned | GitHub GH-06; Grafana GF-08 |
| `shape-claims-applied` | MWS-RES-1 | update_ticket answers a rename that unassigns (title and `assignee: null`) with `"outcome": "applied"` and the fields in `changed`, and writes nothing | The result says applied; the ticket keeps its title and assignee | Payload PAY-04; GitHub GH-06 |
| `error-as-text` | MWS-RES-2 | add_comment returns a backend refusal as plain text without isError | A comment on a missing ticket comes back without `isError` | Payload PAY-05, PAY-01 |
| `shape-unknown-as-failed` | MWS-RES-2 | every write tool's shape turns an open outcome into `"outcome": "not_applied"`, `"repeat": "no"`; the text still says it is not known | After a lost backend answer the update is in effect and the shape says not applied | GitHub GH-05; the unknown-outcome study |
| `shape-text-says-failed` | MWS-RES-2 | after a lost backend answer, update_ticket and replace_ticket say "Update failed … Nothing was written" while the shape correctly says `"outcome": "unknown"` | The text states a failure for a write that is in effect; the true shape does not repair it (spec 7.3, rule 11) | GitHub GH-05; the unknown-outcome study |
| `shape-text-invites-retry` | MWS-RES-2 | after a lost backend answer, update_ticket and replace_ticket say "… It is not known whether the change was applied. Please retry the call." while the shape correctly says `"outcome": "unknown"` with a read to make first | The text invites a blind repeat of a write whose outcome is open; the true shape does not repair it (kind retry-invited; spec 7.3, rule 11) | GitHub GH-05; the unknown-outcome study |
| `comment-id-dropped` | MWS-RES-3 | add_comment does not return the id of the comment it created | The new comment's id is nowhere in the answer | GitHub GH-05 |
| `receipt-missing-version` | MWS-RES-4 | update_ticket answers only "Updated T-12." | The receipt has no changed fields and no new version | Grafana B1, B2 |
| `shape-wrong-version` | MWS-RES-4 | update_ticket's structured receipt (`mws.object.version`) gives the version before the write; the text gives the right one | The shape's version is one behind the ticket's | Grafana B1, B2 (class) |
| `shape-missing-failed` | MWS-ATOM-1 | bulk_update_tickets writes one by one; on a failure its shape lists only the tickets updated, under `"outcome": "applied"` | The missing ticket is covered by the outcome, so the shape reports it applied (also MWS-ATOM-2 through `mcp-writecheck`: the earlier writes stay) | Kubernetes K8S-01; Payload PAY-05 |
| `shape-text-says-all-saved` | MWS-ATOM-1 | bulk_update_tickets writes one by one; after a partial apply its shape is right (`"outcome": "partial"`, each ticket in `items`) but its sentence says "All 3 tickets saved" | A declared `patterns.applied_all` matches the sentence while a ticket was not applied (also MWS-ATOM-2 through `mcp-writecheck`: the earlier writes stay); without that pattern the shape alone would read as `held` | Payload PAY-05; Kubernetes K8S-01 |
| `bulk-misreports-partial` | MWS-ATOM-1 | bulk_update_tickets claims the items before a failing one were applied when the batch applied nothing | Reported applied [T-a, T-b]; actually applied [] | Kubernetes K8S-01, K8S-06, K8S-15 |
| `bulk-without-transaction` | MWS-ATOM-2 | delete_tickets deletes one ticket at a time and leaves earlier deletes in place when a later one fails | With the gate holding the first delete while the third ticket changes, 2 of 3 are deleted | Kubernetes K8S-01 class; Payload rollback (what held up) |
| `no-idempotency-key` | MWS-RETRY-1 | add_comment has no idempotency_key argument | The catalog shows no key on add_comment | GitHub other observations; Kubernetes K8S-05 |
| `idempotency-key-dropped` | MWS-RETRY-2 | create_ticket accepts idempotency_key but does not forward it, so a retry creates a duplicate | The same keyed call twice makes two tickets, neither answer says replay | GitHub other observations; Kubernetes K8S-05 |
| `idempotency-key-ignores-args` | MWS-RETRY-2 | create_ticket answers any call with a seen idempotency_key from a cache, even with different arguments | A reused key with a different title is answered as a replay; no ticket is made | none published; the MWS-RETRY-2 negative case |
| `retry-without-key` | MWS-RETRY-2 | create_ticket re-sends a create without its idempotency_key after a broken connection, so the ticket is created twice | After a lost backend answer, one key made two tickets | none published; the MWS-RETRY-2 proxy-assisted step |
| `key-store-in-memory` | MWS-RETRY-2 | create_ticket keeps idempotency keys only in the server's memory, so after a restart a repeat creates the ticket again | After a restart of the server, one key made two tickets | none published; Annex B-5, the MWS-RETRY-2 restart step |
| `coerce-types` | MWS-IN-1 | values are coerced to the declared type ("false" becomes true, null becomes 0, an object becomes "[object Object]") | `delete_tickets` with `all: "false"` deletes every ticket; `assignee: {"a": 1}` is stored as "[object Object]" (also MWS-IN-6: a meaning-changing conversion is a conversion) | PostHog X1 |
| `drop-unknown-args` | MWS-IN-2 | arguments the schema does not define are silently dropped (also MWS-IN-7: not rejected) | `asignee` (misspelled) is dropped, the title is written, success | GitHub GH-06; Payload PAY-11; Kubernetes K8S-09 |
| `skip-limits` | MWS-IN-3 | advertised enums, lengths and ranges are not enforced | `status: "archived"` (not in the enum) archives the ticket; a 201-character title is stored | GitHub GH-12; Grafana GF-18; Kubernetes K8S-11; Payload PAY-12 |
| `vague-validation-error` | MWS-IN-4 | validation failures say only 'Invalid input', without the field or the reason | The error for `title: 42` names neither the field nor the reason | Payload PAY-13; GitHub GH-13 |
| `read-only-strict-true` | MWS-CFG-1 | only TRACKER_READ_ONLY=true turns read-only on; yes, 1 or a typo start the server with writes on | `TRACKER_READ_ONLY=yes` and `=enabled` start with writes on | GitHub GH-08 |
| `unknown-tools-ignored` | MWS-CFG-4 | unknown names in TRACKER_TOOLS (allow-list) are skipped instead of stopping the server | `TRACKER_TOOLS=get_ticket,update_tikcet` starts | GitHub GH-10; Kubernetes K8S-14 |
| `read-only-by-annotation` | MWS-CFG-3 | read-only mode hides only tools annotated destructive; additive write tools still work | In read-only mode create_project, create_ticket, add_comment and add_label still write | PostHog R6 |
| `comment-marked-read-only` | MWS-ANN-1 | add_comment is annotated readOnlyHint: true but creates a comment | A tool declared read-only changes state | rule 9 (honest annotations); no single published finding |
| `set-labels-non-destructive` | MWS-ANN-5 | set_labels removes unlisted labels but is annotated destructiveHint: false | A tool declared non-destructive replaces a list (the list was named, so MWS-ANN-2 is not broken) | GitHub GH-07; Kubernetes K8S-02 |
| `create-marked-idempotent` | MWS-ANN-3 | create_ticket is annotated idempotentHint: true; repeated calls without a key make new tickets | The second identical call makes a second ticket | Kubernetes K8S-12 |
| `missing-annotations` | MWS-ANN-4 | remove_label declares no annotations | remove_label has no readOnlyHint | Payload PAY-08 |
| `conflict-without-iserror` | MWS-CONC-4 | update_ticket and set_labels return a version conflict as an ordinary result, without isError | A stale update is not applied but the answer is not an error | Payload PAY-01 |
| `stale-unannounced` | MWS-CONC-5 | delete_project's description does not say that stale deletes are not detected | Projects have no backend version check, and the description is silent | Annex B-8 |
| `close-before-confirm` | MWS-RETRY-3 | close_ticket closes the ticket before it asks for confirmation (input_required) | The ticket is closed while the question is still open | MCP 2026-07-28 input_required retries |
| `undeclared-title-limit` | MWS-IN-5 | update_ticket refuses titles over 100 characters while its schema says 200 | A 150-character title, valid by the schema, is refused | Payload PAY-12 |
| `convert-numeric-strings` | MWS-IN-6 | a numeric string ("5") is accepted for a number argument and used as 5 | `priority: "5"` is stored as 5 (not MWS-IN-1: the meaning is kept, NF-21) | PostHog X1 (harmless form) |
| `ignore-unknown-args-with-notice` | MWS-IN-7 | arguments the schema does not define are ignored, and the answer says so, instead of being refused | `asignee` (misspelled) is ignored with "Ignored argument asignee: … not used"; the title is written | SDK defaults that strip unknown properties |
| `unknown-denied-tools-ignored` | MWS-CFG-2 | unknown names in TRACKER_DENY_TOOLS are skipped | `TRACKER_DENY_TOOLS=delete_ticket,update_tikcet` starts with writes on | GitHub GH-10; Kubernetes K8S-14 |
| `add-label-replaces-list` | MWS-ANN-2 | add_label replaces the whole label list with the one label it was given | A non-destructive tool removes labels the call did not name (also MWS-ANN-5) | GitHub GH-07; Kubernetes K8S-02 |
| `token-in-error` | MWS-SEC-1 | get_ticket's error result includes the backend request with its Authorization header | The backend credential (a canary) appears in an error result | GitHub GH-09 (class: credential in a tool result) |

Defects that need a feature (`requires`). A defect listed here runs only with the features in its "Requires" column on; `--defect all` and a requirement ID take it only when they are active, and naming it without them stops the server (exit 2). The 0.1 profile and the table above are unchanged by them.

| Flag | Requirement | Requires | What goes wrong | What the self-test sees |
|---|---|---|---|---|
| `lookup-reexecutes` | MWS-ANN-1 | execution-records, lookup | `get_operation` (declared read-only) sends a create with the key when the backend has no record of it, so a lookup writes (fixture property FX-LOOK-2) | MWS-ANN-1: calling the read-only lookup tool changed the state. Detected by fx-check (FX-LOOK-2, with --mcp); writecheck does not observe it yet: the re-executed write creates a new object outside the one MWS-ANN-1 watches. |
| `in-progress-reported-not-applied` | MWS-RES-2 | inflight | A same-key call while the first is still being applied is reported as not applied (nothing written), though the keyed write is about to apply | the second call's result says `not_applied` while the first call's ticket appears |
| `settle-miss-reported-not-applied` | MWS-RES-1 | inflight | After a lost backend answer, a lookup with no fence finds no record and reports not applied; the held request lands afterwards | the call reports `not_applied`, then the ticket exists |

Backend defect:

| Flag | Context | What goes wrong | What the test sees |
|---|---|---|---|
| `--backend-defect lost-update` | MWS-CONC-3, `platform` verdict | The backend's own PATCH copies the record, waits, writes the stale copy back, then patches it | Concurrent pairs lose an update through the MCP server **and** through the REST API directly |

Article links: GitHub, Grafana, PostHog, Kubernetes and Payload audits under `https://isokron.ai/research/`; each defect file links its findings register and names the finding IDs.

Some defects sit on a second tool on purpose, so that `--defect all` hides nothing: `no-idempotency-key` is on `add_comment` (so `create_ticket` keeps its key for the two MWS-RETRY-2 defects), and `comment-id-dropped` is on `add_comment` (so `create_ticket` keeps returning ids for every other check). Defects that wrap a handler are applied after defects that replace one. The lying-shape defects (`shape-*`) change only `structuredContent.mws` and its mirror, so the text still tells the truth, except `shape-text-says-failed` and `shape-text-invites-retry`, which change only the sentence and keep a true shape; with every defect on, `shape-missing-failed` is replaced by `bulk-misreports-partial` (both replace `bulk_update_tickets`; MWS-ATOM-1 stays violated), and the older defects that replace a handler answer without the shape, which is how a tester's fallback to its declared patterns is exercised. Overlaps remain inside MWS-RETRY-2, whose four defects all replace or wrap `create_ticket`: with all of them on, `key-store-in-memory` is the handler in place (it replaces the handlers of `idempotency-key-dropped` and `retry-without-key`), and `idempotency-key-ignores-args` answers the same-key retry from its cache. Each of the others shows only when it is on alone; the requirement is still `violated`.

## Variants

A variant is a correct alternative to one piece of the build, switched on with `TRACKER_VARIANTS`; a run against it must give no `violated`.

| Variant | What it does | What a tester sees |
|---|---|---|
| `key-store-honest` | `create_ticket` keeps idempotency keys itself (it does not send them to the backend, standing for a backend that offers none): a record in memory answers a repeat, and a journal of used keys (`TRACKER_KEY_JOURNAL`, keys only, no results) survives a restart. After a restart a journalled key is refused with an error that says the earlier result was not kept and nothing was written; after a lost backend answer the repeat says the outcome is not known (Annex B-5). | MWS-RETRY-2 `held` with the note "key record not kept" on the restart step and "outcome not established" on the proxy-assisted step and the crash form, where the declaration does not claim a backend key; never two tickets for one key. `test/variants.test.ts`. In the default profile the variant turns `lookup` off for that build (no `get_operation` or `get_execution`), and the state line says so (`features_off`); naming `--features lookup` with it is refused (CMP-5). |

## The platform verdict

`--backend-defect lost-update` makes the backend lose one of two concurrent updates. A tester then sees the loss through the MCP server, sends the same pair to the backend's REST API (the control arm), sees it there too, and must report `platform`: the MCP layer is no worse than the platform it wraps. With the correct backend neither arm loses anything. `test/platform.test.ts` shows both.

## Tests: the self-test matrix

```sh
npm test        # builds, then runs node:test over dist/test
```

`test/support/checks.ts` holds one scripted check per requirement. Each check drives tiny-tracker only through an MCP client, uses the backend's REST API only to set up state and to read the truth afterwards, and returns `held`, `violated` or `not tested`. Two checks (MWS-CONC-3 and MWS-ATOM-2) use the loopback gate in `test/support/gate.ts` to hold one backend request and force an interleaving; the CFG checks launch separate servers.

`test/selftest.test.ts` runs:

1. every check against the correct build, over protocol 2026-07-28 and over 2025-11-25: all `held`;
2. every check against each single-defect build: the defect's own requirement `violated`, the same check `held` on the correct build, and **no other requirement violated** (an overlap would have to be listed in `ALSO_TRIPS`). The MWS-RETRY-2 check also cuts the backend's answer to one keyed create (the gate's `cutNext`) and restarts the server between a keyed create and its repeat;
3. every check against `--defect all`: every requirement `violated`, so no requirement's defect is hidden by another (see the MWS-RETRY-2 note above).

These are tiny-tracker's own scripted checks. Through `mcp-writecheck` (`mcp-writecheck demo --defect all`) the result differs in four places, by the spec's rules and not because a defect is hidden: MWS-TGT-2 is `not tested`, because its selector forms are sent only after MWS-TGT-1 is `held` for the selector tool (spec 7.3, rule 1) and with every defect on MWS-TGT-1 is `violated` (`--defect empty-filter-deletes-all` alone gives MWS-TGT-2 `violated`); MWS-ATOM-2 is `not tested` for the same reason, because its bulk delete `delete_tickets` is named its container by the scope argument (`--defect bulk-without-transaction` alone gives it `violated`); and MWS-CONC-5 and MWS-CONC-6 are review-only clauses, recorded as `self-attested: no`. The shipped manifest opts in to MWS-TGT-2's destructive forms (`selector.send_empty_forms: true`) because the demo's backend is disposable.

Also: `test/platform.test.ts` (the backend defect), `test/backend.test.ts` (the backend's own contract), `test/cli.test.ts` (launch behavior of the built CLI), `test/cleanup.test.ts` (prefix sweep through the MCP tools), `test/transport.test.ts` (an unreachable backend gives `written: "unknown"`), `test/variants.test.ts` (the `key-store-honest` variant).

Shared-fixture groundwork ([FIXTURE.md](FIXTURE.md)): `test/surface.test.ts` (the 0.1 surface against a transcript of the published 0.1.0 tarball), `test/import-graph.test.ts` (the teaching server never loads `src/fixture`), `test/digest.test.ts` (digest vectors in Node and Python), `test/foundation.test.ts` (profiles, features, the compatibility table, both defect registries, the placement map), `test/fixture.test.ts` (evidence namespace, control listener, tokens, build descriptor, attribution) and `test/schemas.test.ts`.

## Safety of the broken builds

- The correct build is the default. Defects need a flag and print a banner on stderr; MCP-layer defects also put a warning in the server's MCP `instructions`.
- Both processes bind to 127.0.0.1 only; the MCP endpoint serves only loopback `Host` and `Origin` values. Container mode is the one exception: it listens on the container's interfaces and never starts without a bearer token on `/mcp`.
- A build with defects refuses a backend URL that is not loopback.
- The backend keeps its data in memory; nothing survives a restart, unless the `durable` feature is named with `--data-dir` (a 0700 directory of its own).
- Unknown defect names, settings and tool names stop the process (exit 2).

## What this does not cover yet

- **MWS-RES-3, second clause** ("including when a later step of the same call fails") and **MWS-RES-2, second clause** (an error that leaves a change applied): every correct create is a single backend request, so there is no later step to fail. A defect for this needs a multi-step create and a gate fault (`status` on the k-th request).
- **MWS-CONC-3** is forced in one schedule (hold A, run B); the mirrored schedule and the statistical barrier pairs belong to the suite.
- **MWS-SEC-1** is a search for one canary and bearer-token patterns, as the design says: it can only ever be `violated` or `not observed`.

## Shared fixture (in development)

tiny-tracker is also becoming a shared fixture for write-safety harnesses: a lookup by idempotency key, committed digests you can verify yourself, server-side fault points, and evidence that names the build it came from. The design, the parts built so far and their limits are in [FIXTURE.md](FIXTURE.md), with the larger choices in [docs/decisions](docs/decisions/README.md).

- `--profile 0.1` runs exactly the surface of the published 0.1.0 (its tools, texts and structured results, checked against a transcript of the 0.1.0 tarball). Until 0.2.0 the default build was the same.
- The default profile turns on each feature a release ships once its gate is met: `execution-records`, `lookup` and `principals` from 0.2.0, and `inflight` and `retention` from 0.3.0 (every key-accepting tool states the retention, 7 days unless `--key-retention` says otherwise). `durable` stays named, since it needs `--data-dir`.
- New behaviour is switched on with `--features` (`TRACKER_FEATURES`). A name this version does not build yet stops the process and says which release builds it.

Feedback is welcome: open an issue or a discussion on [isokron-ai/mcp-write-safety](https://github.com/isokron-ai/mcp-write-safety).

## License

Apache-2.0, like the rest of the code in this repository.

Made by [IsoKron](https://isokron.ai/?utm_source=npm&utm_medium=readme&utm_campaign=tiny-tracker).
