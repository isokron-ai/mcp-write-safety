# MCP Write-Safety Requirements (MWS)

| | |
|---|---|
| Version | 0.9 (draft for public comment) |
| Date | 16 November 2026 |
| Author | Joshua Bryan, IsoKron |
| Steward | IsoKron (see [section 15](#15-governance)) |
| Licence | [Creative Commons Attribution 4.0 International][cc-by] (CC BY 4.0); see `LICENSE-spec` |
| Checked against | Model Context Protocol revisions `2025-11-25` and `2026-07-28` |
| Requirement IDs | `MWS-<AREA>-<n>`, stable, never renumbered or reused |
| Relation to MCP | Independent. Not a product of the MCP project and not endorsed by it ([section 1](#1-status-of-this-document)) |

## Contents

1. [Status of this document](#1-status-of-this-document)
2. [Scope](#2-scope)
3. [Conformance language](#3-conformance-language)
4. [Terms](#4-terms)
5. [Unit of conformance and conformance statements](#5-unit-of-conformance-and-conformance-statements)
6. [Structure of a requirement](#6-structure-of-a-requirement)
7. [Test methods](#7-test-methods)
8. [Verdicts](#8-verdicts)
9. [Requirements](#9-requirements)
10. [Non-findings](#10-non-findings)
11. [Relation to the MCP specification and to other work](#11-relation-to-the-mcp-specification-and-to-other-work)
12. [Limitations](#12-limitations)
13. [Versioning](#13-versioning)
14. [Change process](#14-change-process)
15. [Governance](#15-governance)
16. [Licence](#16-licence)

Annexes: [A. Measurements](#annex-a-informative-measurements) (informative), [B. Mitigation patterns](#annex-b-informative-mitigation-patterns) (informative), [C. Requirement index](#annex-c-informative-requirement-index) (informative), [D. Credential patterns](#annex-d-informative-credential-patterns) (informative), [E. The declaration](#annex-e-informative-the-declaration) (informative), [References](#references).

---

## 1. Status of this document

This is version 0.9, a draft. It is published for comment and is not final. Every requirement in it has the status `draft`. The status does not change in 0.9, whatever tests exist: a requirement leaves `draft` only through the change process of [section 14.4](#14-change-process), after the comment window.

The test tool, `mcp-writecheck`, is published with this version as a preview. It runs the tests for a subset of the requirements, and its documentation lists the requirements it covers and those it does not. A requirement outside that subset has a test method in this document and no executable test yet.

MWS is an independent document. It is not a product of the Model Context Protocol project or of the foundation that hosts it, and it is not endorsed by them or by the maintainers of any server it cites. "MCP" appears in the title only to say what the requirements apply to.

The date in the header is the date of publication. A 30-day public comment window opens on that date. Comments are open from 16 November 2026 to 16 December 2026. Comments are made as issues in the repository, and every comment gets a recorded disposition. A comment needs no particular form. Where a comment leads to a change, the steward prepares the change under [section 14](#14-change-process); the comment's author need not.

Version 1.0 follows the comment window and the exit criteria below. Requirement wording, levels and applicability conditions may change before then, and a requirement may be withdrawn. Requirement IDs will not be renumbered.

Version 1.0 is published when five things are true:

- every requirement that is `active` in 1.0 has an executable test, a sample-server defect and the fixed build;
- every comment received has a published disposition;
- the test suite has been run on at least five servers other than the sample server, each with results that are public by agreement with its maintainer. At least two of them are servers that the steward did not audit. Together they are written in at least three programming languages, sit in front of at least three kinds of backend (for example a database behind an application, a platform's control API and a hosted service's API), and are maintained by at least four organizations or independent maintainers, and none of them is maintained by the steward. The selection rationale below states the kind of backend of each;
- a selection rationale is published with the results. It says, for each server, who chose it and why, its language, its kind of backend and its maintainer, which of its write tools were declared and which were left out, and which servers were considered and not run, with the reason. For the servers that the steward chooses, it is published, as a dated commit in the repository, before their runs begin. A server that was run and whose maintainer did not agree to publish the results is listed as run, without its results;
- at least one of the runs counted in the third criterion was made by a tester outside the steward who did not write the test suite used for that run and is not employed or contracted by the steward. The tester either operated the reference suite or used another implementation of the test methods written outside the steward ([section 14.4](#14-change-process)). The results state any other relation of the tester to the steward.

The third to fifth criteria are not met in 0.9. Before publication the steward ran the preview test tool on the sample server, on three servers whose audits this document cites, on the steward's fixed build of one of them, and on test fakes. The three cited servers are written in two languages, sit in front of three kinds of backend (a database behind a content-management application, a container platform's control API and a monitoring application's HTTP API) and have three different maintainers. The steward made every one of those runs, did not publish them as results, and chose the servers because it had audited them. Each count in the third criterion is higher than that, except the kinds of backend, which is the same.

The steward of this document has a commercial interest in its subject. [Section 15.1](#15-governance) states it.

This document was drafted with the assistance of AI tools. The author reviewed every normative sentence and is responsible for the text. It was written in November 2026, within days of the last of the five audits it cites, and it has had no review by anyone outside the steward. The comment window is that review.

## 2. Scope

MWS states what a Model Context Protocol (MCP) server must do so that a write made through one of its tools has the effect the caller asked for, on the object the caller named, and is reported truthfully. It is a layer above the MCP specification. It adds no protocol messages, no tool annotations and no capabilities, and it never requires what the MCP specification forbids. In three places the MCP specification states a rule on the same point and MWS asks for more: MWS-IN-2 and MWS-IN-7 (arguments the schema does not define, which JSON Schema permits by default), MWS-RES-2, MWS-CONC-4 and MWS-IN-4 (an error form that the MCP specification describes is made a MUST, and the content of the error is specified) and area ANN (hints, which the MCP specification says are not guaranteed to be faithful, are treated as claims that can be false). [Section 11](#11-relation-to-the-mcp-specification-and-to-other-work) gives the details.

In one place MWS asks for more than a backend's own default client does. Under MWS-CONC-2 a tool that replaces a whole object or deletes one is expected to refuse a stale write wherever the backend can detect the change. In practice this means that the tool takes the version the caller read and sends it, although HTTP leaves a precondition to the client ([RFC 9110][rfc9110], section 13.1) and a platform's own command-line tool may send none. The reason is the caller: a model acts on a read that may be many steps old, and does not know to ask for the check.

In scope:

- tools that create, update or delete state in the system behind the server (the backend);
- how those tools behave when two writers act on one object, when a caller acts on state it read earlier, when a call is repeated, and when a call fails part-way;
- what those tools report, and what the server declares about them (input schemas and annotations);
- server settings that are meant to stop writes;
- credentials appearing in tool results.

Two things are in scope although they are wider than writes: input handling on read tools, and credentials in any result. They are included because the same code path serves writes, or because the audits found them beside write defects.

Out of scope:

- authentication, authorization and transport security;
- prompt injection, tool poisoning and other attacks on the model or the client;
- the behavior of clients, agents and models, including whether an agent recovers from a conflict;
- read-only tools, except where an input-handling, annotation or credential requirement applies to them;
- performance, cost and ease of use. Four related quantities are measured, never judged, in [Annex A](#annex-a-informative-measurements).

MWS has two audiences. The requirement sentences and applicability conditions of section 9 state requirements on servers. Sections 5, 7, 8 and 10, and the Test method and Verdicts parts of each entry in section 9, state requirements on anyone who tests a server against section 9 and reports the result, whether by hand or with a tool.

## 3. Conformance language

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in BCP 14 [[RFC 2119][rfc2119]] [[RFC 8174][rfc8174]] when, and only when, they appear in all capitals, as shown here.

A requirement in section 9 has exactly one of two levels, MUST or SHOULD. MAY appears in prose only and is never a requirement level.

This document has two conformance classes. A **server** is subject to the requirement sentences and applicability conditions of section 9. A **tester** is subject to sections 5, 7, 8 and 10 and to the Test method and Verdicts parts of each entry in section 9. In 0.9 a tester rule is cited by its section and rule number, for example "section 8.2, rule 4". Tester rules get permanent IDs in version 1.0.

Sections 1 to 10 and 13 to 16 are normative unless marked otherwise. Section 11, section 12, the annexes, and every paragraph headed "Rationale", "Evidence", "Guidance" or "Known limitations" are informative. Examples are informative. Sections 13 to 16 state what the steward undertakes. They place no requirement on a server or a tester.

## 4. Terms

**Server.** An MCP server: a program that offers tools to MCP clients.

**Backend.** The system in which the server's writes take effect, such as a hosted service, a database or a cluster.

**Platform API.** The backend's own programming interface, as a caller would use it without the MCP server.

**Write tool.** A tool that can create, change or delete state in the backend. A tool that only reads is a read tool.

**Object.** One addressable unit of backend state that a tool reads or writes, such as a ticket, a dashboard or a document. A **resource** is a kind of object.

**Field.** A named part of an object. A sub-field of a nested object is a field where the update tool's schema declares the nested object's properties and lets the caller omit some of them. A **server-managed field** is one the backend sets itself, such as a version, a timestamp or bookkeeping metadata.

**Update mode.** How an update tool treats the fields the caller does not send. The mode is taken from the tool's input schema, whatever its description says, with one exception. A tool whose schema lists the object's fields as separate arguments and lets the caller omit some is in **field-patch** mode. A tool whose schema requires every field is in **full-replace** mode. A tool that takes the whole object as one argument is classed by the platform operation it calls, which the declaration records: full-replace where the operation replaces the object, field-patch where it is a merge patch ([RFC 7396][rfc7396]), and neither where it is an apply with field ownership (MWS-UPD-1 is then `not applicable`). The declaration records the mode and the schema evidence for it; a declared mode that the schema contradicts is an error in the declaration. A description that contradicts the schema about the mode is recorded as an observation on the MWS-UPD-1 record and is not a verdict. A **command** tool performs a named operation (for example "close" or "scale") instead of setting fields. A **composite** tool performs more than one backend write in a call.

**Write path.** One way of changing one resource through the server: a write tool, the resource it changes, and where relevant the fields or the operation exercised. A server usually has many write paths.

**Scope argument.** A tool argument that selects where a write applies, such as a namespace, a project, a tenant or a locale, separately from the object's own identifier.

**Selector.** A tool argument that chooses a set of objects by a filter, a query or a path, where the set may hold more than one object. A **match-all selector** is a selector value that the backend treats as matching every object, such as an empty filter or a wildcard; the declaration lists the forms the backend has.

**Version.** A value that changes whenever an object changes, such as a version number, an entity tag, a revision hash or a modification timestamp, and that a caller can send back to say which state it read.

**Concurrency control.** A check the backend offers that refuses a write made against outdated or locked state: a version precondition, a document lock, a non-forced apply, or an equivalent.

**Bypass.** A tool bypasses a concurrency control when the tool's default request skips a check that the platform API's default request for the same operation performs.

**Conflict.** A write refused because the object changed, or is locked, since the state the caller acted on.

**Stale write.** A write computed from an earlier read of an object, sent after another writer has changed that object.

**Lost update.** Two writers change one object. Both are told the write succeeded, and one of the two changes is absent afterwards.

**Pair.** Two tool calls released together against one object. A pair **overlapped** when each call began before the other ended.

**Idempotency key.** A caller-chosen value sent with a write so that the server or the backend can recognize a repeat of the same write.

**Replay.** A repeated call that the server recognizes as a repeat and does not apply a second time.

**Receipt.** The part of a write tool's result that says what was written.

**Settled outcome.** The outcome of a backend request is **settled** for the server when the server has received the backend's own answer to it and that answer reports that the request was carried out or that it was refused, or when the server has established from a later answer of the backend, such as the answer to a read that looks the request up, whether the backend carried the request out. An answer that reports only that the request was accepted for later processing does neither. An outcome that the server no longer knows, because it lost its record of the request, for example in a restart, is not settled for it. It is **open** when the server sent the request, or may have sent it, and its outcome is not settled: for example, the server received no answer, an answer from an intermediary between the server and the backend, or an answer that reports an error of the backend itself (in HTTP, a server-error status) and that the declaration does not list as a refusal by this backend. The outcome of a request that the server knows it did not send is neither settled nor open. The outcome of a write is open when the outcome of a mutating backend request that it sent is open, unless the server has established that no change made by that request is in effect. A write whose mutating backend requests all have a settled outcome has a settled outcome. A write also has a settled outcome, as applied at least once, when the server has received the backend's own answer reporting that a request it sent again, in place of one whose outcome is open, was carried out.

**Result content.** The `content` array and `structuredContent` of a tool result. Where a test method checks the content of a result or of an error for a value or a statement, either place meets the check, and the record states where it was found. The scan of MWS-SEC-1 covers the whole result.

**Tool execution error.** A tool result with `isError: true`, as the MCP specification defines it. A **protocol error** is a JSON-RPC error response.

**Tester.** The person or program that calls the server to decide a verdict. A **declaration** is the tester's written description of the write paths under test: which tools read, create, update and delete each resource, each update tool's mode, two fields that are independent of each other, and any of the optional facts a requirement's test method asks for. The declaration is published with the conformance statement ([section 5](#5-unit-of-conformance-and-conformance-statements)). [Annex E](#annex-e-informative-the-declaration) lists its fields.

**Control arm.** The same operation as a test, sent to the platform API instead of through the server, so that the server's behavior can be told apart from the backend's. The declaration names the platform API operation used as the control arm, and each record states it.

**Trial.** One execution of a test case. A **forced** condition is one the tester brings about by the order of its own steps or by holding a request, without relying on timing.

## 5. Unit of conformance and conformance statements

5.1. A result is always about one requirement and one write path, tool or setting. It is never about a server as a whole. A server with one write path that loses updates and nine that do not is described by ten results.

5.2. This document defines no state called "compliant", "conformant", "certified" or "passing", no levels, no profiles, no score and no badge. A tester MUST NOT report a total, a percentage, a count of verdicts, a grade or any other aggregate of results, because rows with the verdicts `not tested` and `not applicable` make any count meaningless. Grouping or ordering rows by verdict is layout and is allowed. Totals, percentages and grades are not.

5.3. The only statement this document defines is a **conformance statement**: a document that lists every requirement in section 9 with its verdict or verdicts for each write path tested, and that states

- the version of this document;
- the server, its version, and the backend and its version;
- the write paths tested;
- the tester (the tool and its version, or the person) and the date;
- the MCP protocol revision and the transport used, and the client capabilities and extensions the tester declared;
- what was not tested, and why;

and includes the declaration used. A statement whose declaration is not shown cannot be checked.

A list that leaves out requirements is not a conformance statement.

A statement made without calling any tool says so in its first line, records how the server was started or reached (the command, the settings and the names of the variables given to it, and never their values; a credential given in the command or in a setting is left out as well), and gives no verdict other than `not tested` or `not applicable` for a requirement whose test method calls a tool. It is a statement about the catalog that launch produced, and is not quoted as a result about any write path.

5.4. A conformance statement made by a server's own maintainers is their statement about their server. Nothing in this document provides for a third party to endorse or countersign it.

## 6. Structure of a requirement

Each requirement in section 9 has these parts, in this order.

| Part | Meaning |
|---|---|
| ID | `MWS-<AREA>-<n>`. Stable: an ID is never renumbered and never reused. When a requirement is split, the part that stays keeps the ID and each new part gets a new ID. A requirement that is removed keeps its entry and its ID and is marked retired, with the status `removed`. |
| Level | MUST or SHOULD. MUST is used where a violation loses or damages data without telling the caller, tells the caller or the client something false, leaves a write enabled that a setting was meant to stop, or puts a credential into a result. SHOULD is used for a mitigation, for a disclosure and for a practice that helps a caller recover. Thin evidence is stated in the Evidence line and does not lower a level. |
| Status | `draft`, `active`, `deprecated` or `removed`, and the version in which the requirement first appeared. A requirement may also be marked "at risk". It then depends on a question that is open in the MCP specification, and it may be reworded or withdrawn when the MCP specification clarifies, without a new comment period. Raising its level always needs the comment period of [section 14.2](#14-change-process). |
| Applies when | The condition under which the requirement applies to a write path, tool or setting. Where the condition is false the verdict is `not applicable`. |
| Requirement | One normative sentence. This sentence and the applicability condition are the requirement; nothing else in the entry adds to it. |
| Rationale | Informative. The public, reproducible finding or findings that motivated the requirement, with links to the findings register in this repository (`spec/evidence/FINDINGS.md`), to the published write-up, and to the upstream issue or pull request where one exists. A finding is cited as evidence that the failure occurs in practice, not as a statement about the cited project's current release. |
| Evidence | Informative. One line that says how strong the evidence in the Rationale is, in a fixed vocabulary: `observed` (reproduced by the steward on *n* cited servers), `read` (found by reading code, not run), `derived` (from the MCP text or from reasoning). |
| Test method | One or more of the methods in [section 7](#7-test-methods), with the procedure in prose so that a second implementation of the test is possible. |
| Verdicts | Which of the verdicts in [section 8](#8-verdicts) the test can produce, beyond `not tested` and `not applicable`, which are always available. |
| Known limitations | Informative. What a result for this requirement does not show. |
| Guidance | Informative, optional. Advice that is not part of the requirement. |

The ten areas are:

| Code | Area | Entries in this version |
|---|---|---|
| UPD | Update semantics | 2 |
| CONC | Concurrency and preconditions | 6 |
| TGT | Targeting | 3 |
| RES | Truthful results | 4 |
| ATOM | Multi-step and multi-item writes | 2 |
| RETRY | Retries and replays | 3 |
| IN | Inputs | 7 |
| CFG | Safety settings | 4 |
| ANN | Annotations | 5 |
| SEC | Credentials in results | 1 |

The number of requirements is not fixed. It is the number of entries in section 9, and it changes when a requirement is added, split or retired. Each ID carries one requirement sentence. Where a sentence has more than one clause, a `violated` record states which clause was not met.

## 7. Test methods

7.1. Every requirement names one or more of three test methods.

| Method | Meaning | What the tester needs |
|---|---|---|
| **black-box** | The tester acts only as an MCP client. It calls tools, reads state back through the server's own read tools, and compares. Where a requirement concerns start-up settings, the tester also starts the server with the settings named in the procedure, and where a step restarts the server, the tester stops and starts it; this is written "black-box (launch)". Where such a setting is applied with a request instead, the tester sends it with the request and no launch is needed. | The declaration. For launch tests, a way to start the server, and, where a step restarts it, to stop it. |
| **proxy-assisted** | As black-box, and in addition the tester interposes on the hop between the server and its backend, so that it can hold one backend request until another call has finished, make a chosen backend request fail, or cut the answer to a chosen backend request. | A way to route the server's backend traffic through the interposer, or cooperative hooks inside the server. |
| **review-only** | A person reads the server's catalog, configuration or code, or a captured result, and answers a stated question. Nothing is measured. | Nothing. For a captured result, the black-box test that captured it. |

Every record states its method and its modifiers. There are two modifiers: launch, and control arm.

7.2. **Control arm.** A black-box or proxy-assisted test MAY add a control arm: the same operation sent to the platform API. A control arm is what distinguishes the verdict `violated` from the verdict `platform` ([section 8](#8-verdicts)). The declaration names the platform API operation used as the control arm, and the record states it. A record with the verdict `platform` MUST state both counts side by side: the number of trials that showed the behavior through the server, and the number that showed it in the control arm. Writes made by a control arm MUST be made only to objects the tester created for that arm.

7.3. **Rules for every test.**

1. A tester MUST write only to objects it created for the test, in a system its operator has declared to be a test system. A loss that the server causes under the operator's declaration of a disposable backend, below, is recorded as this rule says and is not a breach of this sentence by the tester. A tester also MUST NOT name, in a call to a write tool, an existing scope outside a system that its operator has declared to be a test system, such as a scope that belongs to another tenant or owner. Every scope of a system declared to be a test system, its default scope included, is part of it. A test that calls a deleting or bulk-updating tool with an empty, missing or match-all selector or with a container path (MWS-TGT-2) MUST NOT be run outside a container that the tester created for that test and has confirmed holds nothing but objects it created. Where that container is named to the tool by a scope argument, the test MUST NOT be run unless MWS-TGT-1 has been run for that tool with the verdict `held`. The forms of MWS-TGT-2 (an empty, missing or match-all selector, and a container path) are destructive by design. On a tool that does not meet that requirement they act on whatever the tool falls back to, which can lie outside the container and outside the scope the call names, and no earlier black-box result shows where. They MUST NOT be sent unless the operator has declared that every object the server's identity can change in the backend is disposable, and that nothing else writes there during the test ([Annex E](#annex-e-informative-the-declaration)). A `held` verdict under MWS-TGT-1 does not lift this rule. On a tool that deletes or bulk-updates, a probe of MWS-IN-1, MWS-IN-2 or MWS-IN-3 that replaces, removes or misspells an identifier, a scope argument or a selector is subject to the same rules, the rule on a disposable backend included, because a value that the server drops leaves the call matching more than it names. On a tool that deletes or bulk-updates and that chooses its objects by a selector or acts on every object in the scope it is given, every call of a test is sent only under the rule on a disposable backend: the base call and each probe of MWS-IN-1 to MWS-IN-3, and each MWS-TGT-1 call, the one made before the forms of MWS-TGT-2 included, because a tool that ignores the scope or loosely matches the selector acts on more than the call names. Just before and just after each form, probe or call that the rule on a disposable backend covers, the tester takes the inventory that the MWS-TGT-2 test method describes, and the record names every object that the tester did not create and that is gone or, for a tool that updates, changed. A call after which such an object is gone or changed adds no `held` to its record. Where such an object is gone or changed, the record is `violated` if a call on it showed the behavior that its requirement forbids (under MWS-TGT-2 the loss itself does), and otherwise `not tested`, with the loss as the reason. A partial inventory never gives `held` for MWS-TGT-2, nor for an MWS-TGT-1 record with a call that this rule covers; that record is then `not tested`, with that reason, unless a call on it showed the forbidden behavior. A probe that removes, replaces or misspells the scope argument itself is sent only where the server has a default scope and that scope is also a container that the tester created and has confirmed holds nothing but objects it created. Where the rules cannot be met, the test is not run or the probe is not sent, and the record says so; if no other probe remains, the verdict is `not tested`.
2. Before any concurrent or stale-write test, the tester MUST show that the two fields it uses are independent: two writes made one after the other, one to each field, both survive.
3. A read-back MAY be delayed by a settle interval that the declaration states, and MAY ignore server-managed fields that the declaration names. Both MUST be recorded in the result.
4. Every identifier a server returns MUST be checked by reading the object back before the tester updates or deletes by it.
5. A trial in which a call times out, or in which the outcome of a call is unknown, is recorded as indeterminate and excluded. It is never counted as a failure, and a write whose outcome is unknown is treated as possibly applied. If no usable trial remains, the verdict is `not tested`. "Indeterminate" describes a trial and is not a verdict.
6. A fault injected by a proxy-assisted test MUST be deterministic: a named request (for example the second mutating request of a call), never a probability.
7. A proxy-assisted result MUST state the schedule that was forced and how the traffic was routed. A result obtained through cooperative hooks inside the server MUST say so, because the server's author controls where the hook sits.
8. A result MUST record the number of trials run, the number that showed the behavior and the number excluded as indeterminate.
9. A tester sends requests that conform to the MCP revision it states. A probe value that a tool's input schema does not allow does not by itself make a request non-conforming. A server's rejection of a request that does not conform is the tester's error and is never a verdict.
10. Where a server asks for input during a call (an `elicitation/create` request in revision `2025-11-25`, an input request in an `input_required` result in revision `2026-07-28`), the record states what the tester answered. In a test of an override or an opt-in (MWS-CONC-1, MWS-TGT-2, MWS-TGT-3) the tester answers a request to confirm with a decline (in revision `2026-07-28`, by retrying the call with that answer), and the call is judged on the final result. A `held` record that rests on a declined confirmation says so, and says that a client that does not declare the capability was not tested. Whether an accepted confirmation counts as an explicit argument is open for comment.
11. Where a procedure asks what a result says, the tester decides it by patterns stated in the declaration or by a person's reading. A structured field that the declaration names for the purpose (for example an outcome field in `structuredContent`) is such a pattern, and so is a published library of patterns that the declaration adopts by name and version. So is a published result shape that the declaration adopts by name and version, such as `write-result/0.1` in [Annex B](#annex-b-informative-mitigation-patterns), B-9, for the members that the shape defines and as it defines them; a member whose value does not have the form that the shape gives it decides nothing as part of the shape, and the record quotes it as an observation, but a person may still read it as any other content of the result; and the shape never decides a clause that a requirement's test decides from the state read back. Where a member of an adopted shape and the rest of the result's content state different things about the same fact, each is read on its own: a statement in either that a requirement forbids gives the verdict that it gives, and a true statement in one does not make up for a false statement in the other. The record quotes the text or field relied on, says which source decided it and, for a person's reading, names the reader. Where neither decides, the record is `not tested` with the reason "needs reading" and quotes the text. A built-in word list, a model or any other automatic reading does not decide a verdict; it may add a note to the record, or a suggestion that a person then confirms. This does not make the verdict `self-attested`, which is used only for the clauses that an entry marks review-only (section 8.2, rule 11).

7.4. **Concurrency tests.** Three procedures are used by the requirements in area CONC, and are referred to there by name.

- **Stale write** (black-box, forced). Read the object through the server. As a second writer, change a different field of the same object, through the server from a second connection or directly through the platform API. Then send the first writer's write, built from the first read. The interleaving is forced by the order of the steps; no timing is involved.
- **Simultaneous pairs** (black-box, not forced). Release two calls that change different fields of one object at the same moment, from two connections or two server processes, and record for each pair whether the calls overlapped. After each pair, read back both fields.
- **Held request** (proxy-assisted, forced). First run writer A alone through the interposer and record its backend requests. Then start A again, let its requests through until its last mutating backend request, and hold that request. Run writer B to completion. Release A's held request. Read back both fields. Repeat with A and B exchanged. If B does not finish while A is held because the server serializes writers, release A, let both calls finish, and record "serialized by the server". If either call then times out, the trial is indeterminate (section 7.3). The control arm for a held request is the same forced schedule sent to the platform API: A's write, carrying what A read, sent after B's write has been applied.

## 8. Verdicts

8.1. A test result is a record of one requirement, one write path (or tool, or setting), one test method, and exactly one of seven verdicts. Where a requirement is tested by more than one method on the same write path, there is one record per method. An entry may give a step or a run its own record. There is no verdict called "pass".

| Verdict | Meaning |
|---|---|
| `violated` | The behavior the requirement forbids was reproduced, and the calls that show it were captured. For a requirement that lists `platform`, if a control arm ran, the platform API did not show the same behavior. |
| `platform` | The behavior was reproduced through the server and, in the control arm, through the platform API as well. The server passes on what the backend does. |
| `held` | The condition the requirement is about was forced, and the server did what the requirement says in every trial. |
| `not observed` | The condition could only be attempted and not forced, or the check is a search that cannot be exhaustive, and the forbidden behavior was not seen. This is not evidence that the requirement is met. |
| `not tested` | The test was not run, or its result cannot be used. The record states the reason and what would be needed to run it. |
| `not applicable` | The requirement's applicability condition is false for this write path, tool or setting. The record states which part of the condition is false. |
| `self-attested` | The method was review-only. The answer is recorded as the statement of the person who gave it, whoever that is. |

A fixed, published list of probes counts as a forced condition. Where a requirement's test sends such a list, `held` means that every probe in the list was handled as the requirement says.

8.2. **Rules for assigning verdicts.**

1. One trial that reproduces the forbidden behavior is enough for `violated` or `platform`. The record states how many trials did and did not reproduce it.
2. `platform` is available only for the requirements whose entry lists it. In 0.9 these are MWS-UPD-1, MWS-UPD-2, MWS-CONC-2, MWS-CONC-3, MWS-TGT-1, MWS-TGT-3 and MWS-RES-1. For every other requirement the behavior is under the server's own control, and a control arm does not change the verdict. MWS-CONC-1 is the one exception: its entry requires a control arm to show that the control exists.
3. For a requirement that lists `platform`, a `violated` or `platform` record MUST carry an attribution line with one of three values: `server` (a control arm ran and the platform API refused the write or did not show the behavior), `platform` (a control arm ran and the platform API showed the same behavior), or `unresolved` (no control arm ran, or a control arm of simultaneous pairs saw no loss in fewer than 30 overlapped pairs, so the behavior may be the backend's). A control arm of simultaneous pairs that showed no loss supports the attribution `server` only where at least 30 of its pairs overlapped, the floor of rule 6; with fewer, the attribution is `unresolved`. A `violated` record from simultaneous pairs with a control arm states the counts of both arms side by side, as section 7.2 asks of `platform`. A `violated` record is never quoted without its attribution line. An entry may state that this rule does not apply to it. Whether an unresolved reproduction should have a verdict word of its own is open for comment.
4. `held` requires a forced condition. A test that could not force the condition MUST NOT report `held`.
5. Beyond `not tested` and `not applicable`, a simultaneous-pairs test can produce only `violated`, `platform` or `not observed`. A pair in which both changes survived shows nothing about the next pair.
6. A `not observed` verdict from a simultaneous-pairs test needs at least 30 overlapped pairs with no loss seen. With fewer overlapped pairs and no loss seen, the verdict is `not tested`, with the reason "too few overlapped pairs".
7. A `not observed` record from a simultaneous-pairs test MUST state the number of pairs run, the number that overlapped, and the upper bound on the loss rate that the result still allows (with no loss in *n* overlapped pairs, a rate of about 3/*n* cannot be ruled out at 95% confidence). The bound assumes independent trials with a constant loss probability and is an illustration. The record MUST state in words that the result does not show the server is safe under concurrency.
8. A requirement that is a claim about all of a server's state or all of its results (MWS-ANN-1, MWS-ANN-2, MWS-ANN-3, MWS-ANN-5 and MWS-SEC-1), or whose check is a search for a constraint the schema does not declare (MWS-IN-5), or for a write in the state the tester reads (the black-box test of MWS-RETRY-3), can produce only `violated` or `not observed`, beyond `not tested` and `not applicable`, because a tester cannot examine everything.
9. A `violated` record from a concurrency test MUST say that the calls were deliberately made simultaneous or deliberately ordered, and that the result says nothing about how often the behavior occurs in normal use.
10. A `platform` verdict for a MUST does not excuse a SHOULD about mitigation. Where the backend loses updates, [Annex B](#annex-b-informative-mitigation-patterns) describes what a server can still do.
11. `self-attested` is used only for the clauses that a requirement's test method marks review-only. In 0.9 these are MWS-CONC-5, the wording clause of MWS-CONC-4, the re-read clause of MWS-CONC-6 and the reason clause of MWS-IN-4. A `self-attested` record is always printed with the answer that was given, for example "self-attested: no".
12. A verdict of `violated` for a SHOULD is reported with the same word as for a MUST. The level is part of the record, and a verdict is never printed without its level, for example "violated (SHOULD)". A conformance statement may carry the maintainer's stated reason for not following a SHOULD.
13. Where an entry's procedure has several steps, probes or calls for one write path and the entry does not say how they combine, the record still has one verdict. It is `violated` where any of them gave `violated`; otherwise `platform` where any gave `platform`; otherwise `held` where at least one of them was run and each of them that could be run was run, forced the condition and was handled as the requirement says; otherwise `not observed` where the forbidden behavior was not seen and a step could only attempt the condition or the check is a search; otherwise `not tested`, with the reason. A step or trial that adds no verdict is not counted. This rule never gives a verdict that the entry's Verdicts part or rules 2 and 4 to 8 do not allow. The record states what each step, probe or call showed.

8.3. The items in [section 10](#10-non-findings) are behaviors that MUST NOT be given the verdict `violated` under the requirements that the item's treatment says are not violated. A requirement the item says the behavior is judged by is not affected.

## 9. Requirements

In this section "the declaration" is the tester's declaration ([section 4](#4-terms)), and the three concurrency procedures are those of [section 7.4](#7-test-methods). Finding IDs such as GH-01 are those of the findings register in this repository, [`spec/evidence/FINDINGS.md`][reg], and of the published write-ups listed under [References](#references); counts such as "19 of 30" are quoted from them. A citation links the register first and the article second.

### 9.1 UPD: update semantics

An update that is meant to change one field can change others: by rebuilding the whole object from its arguments, by adding defaults, or by addressing the wrong element of a list.

#### MWS-UPD-1

- **Level:** MUST
- **Status:** draft, since 0.9
- **Applies when:** the server offers an update tool in field-patch mode. A tool in full-replace mode is judged by MWS-CONC-2 and MWS-CONC-3 instead.

> **Requirement.** An update tool in field-patch mode MUST change only the fields its arguments name, so that every other field of the object, apart from server-managed fields, keeps its stored value and no default is written that the caller did not send.

**Rationale.** [GF-03][reg-grafana] ([article][grafana]): an alert-rule update rebuilt the whole rule, and omitted optional fields were reset in 3 of 3 trials (proposed fix: upstream [pull request 1519][gf-pr-1519]). The article notes that the tool's description called the update a full replace while its schema marked the fields optional; that is why this document takes a tool's mode from its input schema ([section 4](#4-terms)). [G1][reg-posthog] ([article][posthog]): generated patch tools added nested schema defaults the caller did not send. [GH-01][reg-github] ([article][github]): a tool rewrote every issue-field value in order to change one, which is the mechanism behind the lost update cited under MWS-CONC-3 (upstream [issue 3751][gh-3751]). [RFC 7396][rfc7396] gives an explicit `null` in a merge patch the meaning "remove", which is why an explicit `null` is probed separately from a field that is absent.

**Evidence.** `observed` (3 servers; one case is classed by its article as usability).

**Test method.** black-box, with an optional control arm. Create an object with every optional field but one set to a value that is not its default, and that one left unset. Read the object through the server's read tool. Call the update tool naming one field. Read the object again through the same read tool, and compare every other field with its value in the first read, including the field that was unset. The comparison is between the read before the call and the read after it, never between what the tester sent at creation and what it reads later. Repeat for each declared field. A description that contradicts the schema about the tool's mode is recorded as an observation on this record ([section 4](#4-terms)). A control arm exists only where the platform API has a partial-update operation of its own: send the equivalent partial update to it and compare in the same way.

Then make four further calls, each naming one field, where the schema allows the value: one that sets the field to an explicit `null`, one to an empty string, one to an empty list, and one that sets a single sub-field of a nested object whose properties the schema declares and lets the caller omit ([section 4](#4-terms)). The explicit `null` is sent for a field that the first read shows set. After each, compare every field the call did not name, and for that nested object every other sub-field, in the same way, and send the same call to the control arm where there is one. Where the schema does not declare the nested object's properties, or requires all of them, the nested object is one field and this probe is not sent. What happens to the named field itself is judged by MWS-RES-1, except for the explicit `null` probe. This document does not say whether an explicit `null` clears a field or leaves it, so MWS-RES-1 gives no verdict on the named field for that probe; the record states which the tool did.

**Verdicts.** `violated`, `platform`, `held`. `platform` is available only where the platform API's own partial update resets the same fields. Where the platform API offers only whole-object replacement there is no control arm, and section 8.2, rule 3, does not apply: a tool that offers a field patch over such an API is responsible for reading the stored object first.

**Known limitations.** Only fields the server's read tool returns can be compared. A field the test did not set to a non-default value cannot show a reset. The nested probe covers one nested object, one level deep.

#### MWS-UPD-2

- **Level:** MUST
- **Status:** draft, since 0.9
- **Applies when:** the server offers a tool that edits, moves or removes one element of a list held inside an object.

> **Requirement.** A tool that edits, moves or removes one element of a list MUST apply the change to the element that the caller's address denoted in the list as the caller read it, or refuse the call, when elements have been inserted, removed or reordered since that read.

**Rationale.** [GF-02][reg-grafana] ([article][grafana]): patch paths addressed dashboard panels by array index only; after another writer inserted a panel, the edit hit the wrong panel in 5 of 5 trials (proposed fix: upstream [pull request 1521][gf-pr-1521]).

**Evidence.** `observed` (1 server).

**Test method.** black-box, with an optional control arm. Create an object whose list has at least three elements. Read it and note how the tool addresses the second element. As a second writer, insert an element ahead of it. Edit "the second element" using the address taken from the first read. Read back and establish which element changed. Repeat from a fresh object with a second writer that removes the first element and, where the list can be reordered, with one that moves the second element to another position. In the control arm, make the same change as the second writer and send the same edit to the platform API, with the platform API's own address for that element as the first read gave it.

**Verdicts.** `violated` (a different element changed and the call reported success), `platform` (the control arm shows that the platform API addresses list elements by position only and behaves the same), `held` (the intended element changed, or the edit was refused). The record states which of the three changes (insertion, removal, reordering) were forced. Where the platform API has no operation that edits one element of the list, there is no control arm and section 8.2, rule 3, does not apply: a tool that offers such an edit over a whole-object API is responsible for where the edit lands.

**Known limitations.** One insertion, one removal and one reordering are three of many ways a list can change.

**Guidance.** A stable identifier for each element, accepted by the edit tool, is the usual way to meet this requirement. A positional tool that refuses a stale edit under MWS-CONC-2 also meets it. [PAY-06][reg-payload] ([article][payload]) is a published case in which accepting row identifiers stopped an array edit in one locale from losing the row's values in other locales (an upstream issue reported by others, [issue 19435][pay-19435]). It is a case about locales and not about reordering, and is cited only for the use of row identifiers.

### 9.2 CONC: concurrency and preconditions

Two writers act on one object, or one writer acts on state it read some time ago. The backend often has a check for this. The failures are a tool that switches the check off, a tool that gives the caller no way to use it, and a tool that reports success to both writers while one change is gone.

#### MWS-CONC-1

- **Level:** MUST
- **Status:** draft, since 0.9
- **Applies when:** the backend offers a concurrency control for an operation that a write tool performs.

> **Requirement.** A write tool MUST NOT disable or bypass a concurrency control that the backend offers for the operation it performs, unless the caller sets an explicit override argument whose default is off.

**Rationale.** [GF-01][reg-grafana] ([article][grafana]): dashboard patch saves forced an overwrite, so the version check in the platform's save API never ran, while the platform API rejected a stale save in 10 of 10 trials (proposed fix: upstream [pull request 1518][gf-pr-1518]). [PAY-01, PAY-02][reg-payload] ([article][payload]): the update tool wrote through another user's document lock in 10 of 10 trials because its override defaulted to on, and the delete tool had no such argument and deleted a locked document in 10 of 10 trials, while the REST API refused both with HTTP 423 in 10 of 10 (upstream [issue 19591][pay-19591]). The [Kubernetes article][kubernetes-forced] measured a forced apply over another writer's change, which it describes as upstream's choice and did not file.

**Evidence.** `observed` (3 servers; on one the behavior was measured and not filed as a finding, and on one the article narrows the finding to an unsafe default with an opt-out).

**Test method.** "Bypass" has the meaning given in [section 4](#4-terms). A control arm is required: it sends the platform API's default request for the operation, against state that a second writer has changed or locked, and confirms that the platform API refuses it. Without a control arm the verdict is `not tested`. If the control arm's write is not refused, the verdict is `not applicable`, with the reason "the backend did not apply the declared control". The tool is then tested in one of two ways.

- black-box, for a lock, and for a tool that accepts a version or a whole object from the caller. Engage the control as the declaration describes: change the object as a second writer so that the first writer's version is outdated, or take a lock as a second user. Send through the tool, with default arguments, the same write that the control arm sent to the platform API, so that the only difference between the two arms is the server. Where the control under test is not a version precondition, send no version. For such a control, the control arm's request is first sent with the control not engaged, to an object created for that; if it is refused or takes no effect, the verdict is `not tested`, because a refusal while the control is engaged would not show the control. For such a control, too, the tool's write counts as refused only where it is not in effect and its result shows that this control was the reason: the result carries the platform API's refusal as the control arm received it, or says that an explicit override of this control is needed, or a pattern stated in the declaration or a person's reading finds that it names the control ([section 7.3](#7-test-methods), rule 11), or the request to confirm that the tester declined (section 7.3, rule 10) named this control. Where the write is not in effect and the result gives another reason, such as a missing version, or none, the verdict is `not tested`, and the record quotes the result.
- proxy-assisted, for a tool that reads and writes inside one call and accepts no version. Start the tool's write and hold its last mutating backend request. Change the object as a second writer directly through the platform API. Release the held request.

**Verdicts.** `violated` (the control arm was refused and the tool's write was applied over the second writer's change or lock), `held` (the tool's write was refused, and, in the black-box test of a control that is not a version precondition, refused because of the control as the test method says; or the tool repeated its read and kept the second writer's change). Where the control arm was not refused, the verdict is `not applicable`, as the test method says. In the black-box test of a control that is not a version precondition, a write that is not in effect and whose result does not show that this control was the reason (the platform API's refusal, an override of this control that the result says is needed, a declared pattern or a person's reading under section 7.3, rule 11, or a declined request to confirm that named this control) is `not tested`.

**Known limitations.** The test covers the controls the declaration names. A control the tester does not know about is not tested. A tool that reads and writes inside one call cannot be tested black-box, because a stale write cannot be staged through it.

**Guidance.** An override that exists but is off by default meets the requirement. So does a tool with no override at all. A refusal should not present the override as the way to make the call succeed.

#### MWS-CONC-2

- **Level:** MUST
- **Status:** draft, since 0.9
- **Applies when:** the server offers a tool that replaces a whole object, deletes an object, or accepts a version from the caller.

> **Requirement.** A tool that replaces a whole object, deletes an object or accepts a version MUST refuse the write with a conflict when the object has changed since the state the caller read, wherever the backend can detect the change.

**Rationale.** [GF-19][reg-grafana] ([article][grafana]): a full-body save copied the current resource version onto the caller's body, so a body read earlier replaced an intervening edit in 3 of 3 trials, while a direct request with the stale version was refused with HTTP 409 in 3 of 3 (proposed fix: upstream [pull request 1518][gf-pr-1518]). [GH-02][reg-github] ([article][github]): a file-delete tool took no version and deleted content written after the caller's read (upstream [issue 3757][gh-3757]). [GH-15][reg-github] ([article][github]): a multi-file push had no head check, and a stale push reverted a change to the same path (upstream [issue 3473][gh-3473] was opened by others and is about tool descriptions; the audit's reproduction is [a comment on it][gh-3473-comment]). The [PostHog article][posthog-held] notes an update tool that accepts a version and ignores it on some objects, so that two versioned edits both returned success and one replaced the other; the article classes this as a design gap. [K8S-04][reg-kubernetes] ([article][kubernetes]): a delete sent no precondition and deleted an object recreated after the caller's read, in 10 of 10 trials; the article classes this as a design gap and notes that the platform's command-line tool sends no such precondition either. [PAY-09][reg-payload] ([article][payload]): stale writes were accepted with no signal on every surface of the platform, which the article classes as a gap in the platform's core and not in the MCP layer (platform behavior, not yet reported upstream). In an exploratory test by the steward that changed only the content of the refusal (private research notes), an AI agent kept the other writer's change and made its own in 100 of 100 runs on two servers, whether the refusal carried the conflict and the current state or said only that the update failed: what protected the data was the refusal of the stale write. The test's limits are stated under MWS-CONC-6.

**Evidence.** `observed` (5 servers; three of the cases are classed by their articles as design gaps or platform gaps).

**Test method.** black-box (the stale-write procedure of section 7.4), with an optional control arm. For this requirement the stale-write procedure is run through one connection to the server (over stdio, one server process) and one credential: the first writer's read, the second writer's read and its change, and the first writer's write are all sent through it, in that order. A second writer that uses another connection, another credential or the platform API may be run in addition; each such run is a trial of the same record, and section 8.2, rule 13, combines them. Run the stale write through the tool, passing the version from the first read wherever the tool accepts one. In the control arm, send the same stale write to the platform API with the version from the first read. For a delete tool, the duty to refuse applies where the platform API's delete accepts a precondition that the tool could send, and the control arm sends a stale delete with that precondition. Where the platform API's delete accepts none, the control arm is a plain stale delete and row 3 applies. Where the tool replaces a whole object or deletes an object, and its version argument is optional, run the stale write a second time through the tool, from a fresh object, with the version left out. The control arm is unchanged and still sends the version from the first read. A tool in field-patch mode ([section 4](#4-terms)) is not run a second time. This includes a tool that takes the whole object as one argument and calls a merge patch. With no version sent, such a tool is in the position of a field-patch tool that accepts no version, to which this requirement does not apply. Where both changes survive, NF-12 covers it.

**Verdicts.** The first row of this table that fits decides the verdict. The attribution is the line that section 8.2, rule 3, requires.

| Row | Outcome | Verdict | Attribution |
|---|---|---|---|
| 1 | The tool refused the stale write with a conflict. | `held` | none |
| 2 | The tool applied the stale write, and the control arm refused it. | `violated` | `server` |
| 3 | The tool applied the stale write, and the control arm applied the same stale write. | `platform` | `platform` |
| 4 | The tool applied the stale write, and no control arm ran. | `violated` | `unresolved` |

Where the tool accepted a version and did not use it, the record gives that as the reason in row 2 or row 4. In row 3 the backend cannot detect the change, and the tool's description is examined under MWS-CONC-5. In row 4, where the declaration states that the backend has no version check for the operation, the record says so beside the attribution. Where the stale write was run a second time with an optional version left out, the second run has its own record, marked "version left out", and the same rows decide it. In that run a refusal that says a version or an explicit override is needed counts as row 1, although it is not a conflict, because the unchecked write was not made. Leaving out an optional version is not an override in the sense of NF-7, which is about an explicit argument whose default is off.

**Known limitations.** A stale write cannot be staged against a tool that reads and writes inside one call; that case belongs to MWS-CONC-1 and MWS-CONC-3. The test covers one intervening change to one other field. A check that the server keys to the credential, the user, the connection or its own process, and not to a version or a server-minted handle that the call carries, cannot tell the state the caller read from a later read made by another writer, and the test is staged so that it does not. Revision 2026-07-28 has no protocol-level sessions ([section 11.4](#114-what-revision-2026-07-28-changes-for-write-safety)).

**Guidance.** A tool can refuse a stale write only if it accepts the version, or an equivalent, that the caller read; returning a version from every read tool is what makes this requirement usable by a caller. Where the backend has no version check, a best-effort comparison in the server is recommended; see [Annex B](#annex-b-informative-mitigation-patterns), B-3. What the description should then say is the subject of MWS-CONC-5. On a tool that replaces a whole object or deletes, a version argument that the caller may leave out makes the unchecked write the default. Requiring the version, or offering an explicit override argument that is off by default, as MWS-CONC-1 asks of a concurrency control, meets the requirement.

#### MWS-CONC-3

- **Level:** MUST
- **Status:** draft, since 0.9
- **Applies when:** the server offers a write tool through which two different fields of one object can be changed, and the declaration names two such fields that are independent of each other.

> **Requirement.** Two concurrent writes through the server to different parts of one object MUST NOT both report success when either change is absent afterwards.

**Rationale.** [GH-01][reg-github] ([article][github]): two calls updating different issue fields lost one change in 19 of 30 pairs while both reported success; the platform's per-field update lost 0 of 28 (upstream [issue 3751][gh-3751], proposed fix [pull request 3781][gh-pr-3781]). Three published cases are wholly or partly platform behavior and are the reason the verdict `platform` exists. [C1][reg-posthog] ([article][posthog]): for insights, the loss occurred in 7 of 11 pairs through the server and 6 of 11 straight to the platform API (fixed upstream by a maintainer for one resource in [pull request 131620][ph-pr-131620]). [PAY-10][reg-payload] ([article][payload]): the REST API lost one of two simultaneous partial updates in 10 of 10 pairs (platform behavior, not yet reported upstream). [GF-01][reg-grafana] ([article][grafana]): 30 of 30 simultaneous pairs lost an edit through the tool, and the article states that the control is not clean, because simultaneous saves sent straight to the platform API also lost an edit, in 30 of 30 pairs on one platform version and 20 of 30 on another; what the tool added is cited under MWS-CONC-1.

**Evidence.** `observed` (4 servers; on three the loss was wholly or partly platform behavior).

**Test method.** black-box (simultaneous pairs) and proxy-assisted (held request), each with an optional control arm. After each pair or each held schedule, read back both fields. A loss is a case in which both calls reported success and one of the two values is not the value its writer sent. The control arm for simultaneous pairs is simultaneous pairs sent directly to the platform API's own update operation. The control arm for a held request is the same forced schedule sent to the platform API (section 7.4), so a `platform` record from a held request never describes a schedule that the platform API refuses. A `platform` record states both counts side by side (section 7.2). In the held-request procedure, if writer B has not finished within a timeout that the result states, release A, let both calls finish, and record "serialized by the server"; if either call then times out, the trial is indeterminate (section 7.3). Where the hop between the server and its backend cannot be interposed on, the held-request procedure is `not tested`.

**Verdicts.** From simultaneous pairs: `violated`, `platform`, `not observed`. From a held request: `violated`, `platform`, `held`. `held` covers three outcomes: both changes are present; one caller received a conflict or another error; or the server serialized the two writers. Whether such an error is truthful and well formed is judged by MWS-CONC-4 and MWS-RES-2.

**Known limitations.** A `held` verdict covers the schedule that was forced and its mirror, not every interleaving. A `not observed` verdict is not evidence of safety (section 8.2, rules 5 to 7).

#### MWS-CONC-4

- **Level:** MUST
- **Status:** draft, since 0.9
- **Applies when:** the server offers a write tool that can refuse a write because of a conflict.

> **Requirement.** A write refused because of a conflict MUST NOT be applied and MUST be returned as a tool execution error (`isError: true`) that says the write was not applied.

**Rationale.** [PAY-01][reg-payload] ([article][payload]): with the lock override switched off, the refusal came back as plain text without `isError` in 3 of 3 trials. The [Payload conflict-recovery runs][payload-conflict], in which the caller was an AI agent: on the steward's own modified build, which returns conflicts, the agent recovered 10 of 15 seeded conflicts, and the released build gave no signal in 15 of 15. The two builds differed in more than the conflict answer, so the gap is not evidence of what the answer said; in a test that changed only the answer, recovery was the same whether it carried the conflict or said only that the update failed (MWS-CONC-6). The [PostHog article][posthog-held] records, as behavior that held up, a conflict error that said nothing had been written. A conflict is the failure a caller is expected to recover from by reading again and retrying. A tool execution error is the form in which the MCP specification says such errors are reported in tool results ([section 11.2](#112-clauses-mws-builds-on)), and MWS-RES-2 asks the same wherever the backend or a rule of the tool refuses a write.

**Evidence.** `observed` (1 server).

**Test method.** black-box for the first two clauses; review-only for the wording. Force a conflict with the stale-write procedure, or by engaging the control the declaration names, such as a lock held by a second user. Check that the result has `isError: true`. Read the object back and check that the refused write is absent: for a tool that makes one backend write, the object is as the second writer left it. Then read the captured error content and answer whether it says the write was not applied.

**Verdicts.** `violated` (the refused write was applied in whole or in part, or `isError` is absent or false), `held` (both checks succeeded), `self-attested` (the wording). Where a composite tool applied an earlier step before the step that was refused, the earlier step is not judged here. It is judged by MWS-ATOM-1 and MWS-RES-2.

**Known limitations.** Whether a model or an agent acts correctly on the conflict is outside this document.

#### MWS-CONC-5

- **Level:** SHOULD
- **Status:** draft, since 0.9
- **Applies when:** the server offers a tool that replaces a whole object, deletes an object, or accepts a version from the caller, and the backend cannot detect that the object has changed since the state the caller read.

> **Requirement.** The description of a tool that replaces a whole object, deletes an object or accepts a version SHOULD state that stale writes are not detected, or are detected only on a best-effort basis by the server, where the backend cannot detect the change.

**Rationale.** [PAY-09][reg-payload] ([article][payload]): stale writes were accepted with no signal on every surface of the platform, which the article classes as a gap in the platform's core and not in the MCP layer, and which it says the MCP layer can mitigate with a best-effort check (platform behavior, not yet reported upstream). Where the backend cannot refuse a stale write, the description is the only place a caller can learn that it has to serialize its own work.

**Evidence.** `derived`. The cited case shows a backend that cannot detect a stale write. No cited finding is about what a description says.

**Test method.** review-only. The condition is shown in one of two ways: the control arm of MWS-CONC-2 applied the stale write (row 3 of its table), or the declaration states that the backend has no version check for the operation. Read the tool's description and answer whether it states that stale writes are not detected, or are detected only on a best-effort basis by the server.

**Verdicts.** `self-attested`, printed with the answer (section 8.2, rule 11). Where the control arm of MWS-CONC-2 refused the stale write, the backend can detect the change and the verdict is `not applicable`. Where neither a control arm nor the declaration shows whether the backend can detect the change, the verdict is `not tested`.

**Known limitations.** The answer is one reader's judgment of a text. Whether a caller reads the description and acts on it is outside this document.

**Guidance.** [Annex B](#annex-b-informative-mitigation-patterns), B-3 and B-8, describe a best-effort comparison and what a description can say. The MCP specification uses a tool's description in the same way for another limit a caller cannot otherwise see: the `2026-07-28` [Tools page][mcp-tools-2026] says, in guidance it marks as non-normative, that a server-minted handle's "retention policy should be stated in the creation tool's description". This requirement is a SHOULD because it is a disclosure: the loss itself is judged by MWS-CONC-2, where it is `platform`.

#### MWS-CONC-6

- **Level:** SHOULD
- **Status:** draft, since 0.9
- **Applies when:** the server offers a write tool that can refuse a write because the object has changed since the state the caller read.

> **Requirement.** A conflict error SHOULD tell the caller to read the object again before it retries, or carry the object's current state.

**Rationale.** What keeps the other writer's change is the refusal of the stale write (MWS-CONC-2), not what the conflict error says. In an exploratory test by the steward that changed only the content of the refusal (private research notes), an AI agent recovered, keeping the other writer's change and making its own, in 100 of 100 runs on two servers: both when the refusal said that nothing was written and carried the current state as JSON, the version and a hint to read again, and when it said only that the update failed. The content changed the effort and not the outcome. After the bare failure the agent first resent the stale write in 9 of 100 runs, which the server refused again, and runs given the bare failure cost 9 to 13% more on average; given the current state, the agent built the write from it without reading again in 9 of 60 runs on one server, each time correctly. The test used one model run without a system prompt, simple one-field tasks, and two servers built by the steward that require a version on every write and offer no override. A second exploratory test (private research notes) told the same model to work fast and not to read again unless necessary, on two tasks in which the other writer added a label shaped like a version number, such as `v3` at version 3. There the refusal still protected, except where the error misled the caller: no run lost the other writer's change with the current state quoted, as JSON, with the version alone or with only "the update failed" (0 of 48 in each arm, Wilson 95% interval 0% to 7%), though 4 of the 48 runs given only the failure gave up without making their own change. With the same state written as unquoted prose, 38 of 48 runs lost it (79%, Wilson 95% interval 66% to 88%): the agent resent its old label list under the new version without reading again. A state in unquoted prose did worse than no state at all. The second test's limits: one model, the instruction to work fast, simple label tasks, two tasks built so that a label could be taken for the version, one server built by the steward, 48 runs per arm, and an exploratory run outside the registered study. The value of this requirement is therefore efficiency and determinism: fewer blind resends, and a state that a caller and a tester can read from the result, given only in a form that can be read one way (Guidance). The [Payload conflict-recovery runs][payload-conflict] (10 of 15 seeded conflicts recovered on the steward's own modified build, which returns conflicts, and no signal in 15 of 15 on the released build) compared builds that differed in more than the conflict answer, and are not evidence of the answer's effect.

**Evidence.** `derived`. The Payload runs show recovery where a conflict was returned, on builds that differed in more than the conflict answer. The first exploratory test that changed only the conflict answer found no difference in recovery, and fewer blind resends where the answer carried the conflict and the current state. The second, under an instruction to work fast, found loss only where the current state was written as unquoted prose.

**Test method.** black-box for the current state; review-only for the re-read statement. Force a conflict as in MWS-CONC-4, by a second writer's change. Read the object back, and check whether the error content carries the object's current state: the value the second writer wrote and, where the declaration names a version field, the current version, as the value of a field of that name or stated in the text as the current version. If it does not, read the captured error content and answer whether it tells the caller to read the object again before retrying.

**Verdicts.** `held` (the error carries the object's current state), `self-attested` (it does not; the answer about the re-read statement is printed with the verdict, as section 8.2, rule 11, requires). The entry gives one record: black-box where the error carries the current state, review-only where it does not.

**Known limitations.** A conflict caused by a lock is outside this requirement: there the useful content is who or what holds the lock. Whether a model or an agent reads again is outside this document.

**Guidance.** An error that carries the current state and version saves the caller a read. What matters is that the state can be read only one way: quote strings and list members, or carry the state as a JSON object in the text. A caller that uses the state in the error instead of reading again acts on that text alone. In the second test cited in the Rationale (one model, an instruction to work fast, and a label shaped like a version number), a state written as unquoted prose led the caller to resend its old list under the new version and overwrite the other writer's change in 38 of 48 runs, and the same state quoted or given as JSON lost none (0 of 48 each). The prose did worse than no state: given the version alone, or only "the update failed", the caller read again and lost nothing (0 of 48 each). Where a server cannot give the state so that it can be read only one way, it leaves the state out and tells the caller to read the object again, naming the read. Where the error gives the current version, give it on its own under the name the write tool accepts, so that a caller and a tester can find it without parsing the text. That is for determinism, not protection: in the same test, adding the version on its own changed nothing, with the state in prose (38 of 48 lost with it and without it) or quoted (0 of 48 with it and without it). A version in the error is not a reason to retry with the new version alone. A caller that resends its old body with the new version passes the check and overwrites the other writer's change, which is the loss the conflict was raised to prevent; the losses above were of this kind. The Agentic State Transfer draft says the same of HTTP clients: a client must not retry only by replacing the validator it sent with the one the refusal returned ([section 11.7](#117-relationship-to-other-work)). [Annex B](#annex-b-informative-mitigation-patterns), B-9, describes a structured form for the current state and version.

### 9.3 TGT: targeting

The write succeeds, but on something other than what the caller named.

#### MWS-TGT-1

- **Level:** MUST
- **Status:** draft, since 0.9
- **Applies when:** the server offers a write tool that accepts a scope argument.

> **Requirement.** A write tool that accepts a scope argument MUST apply the write within the scope the argument names or reject the call, and MUST NOT apply it anywhere else.

**Rationale.** [K8S-20][reg-kubernetes] ([article][kubernetes]): an install tool given a namespace left its release record there but sent the chart's objects to the default namespace of the server's configuration, in 3 of 3 trials, where the install then failed for lack of permission; the platform's own command-line tool put everything in the named namespace. The article notes that the case in which such an install reports success follows from the code and was not run (upstream [issue 1658][k8s-1658]).

**Evidence.** `observed` (1 server; the misdirected request was reproduced, and it was refused for lack of permission); `read` (1 server; the case in which the write is applied and reported as a success).

**Test method.** black-box, with an optional control arm. Use two scopes the tester created, neither of them the server's default. For a tool that updates or deletes, first create an object with the same name or key in each of the two scopes and in the default scope, so that a misdirected write has something to act on; where a name cannot repeat across scopes, the record says so. Call the tool naming the first scope. Read back in the named scope, in the second scope and in the default scope, and establish where the write took effect. The server's identity has to be able to write in the default scope; otherwise a misdirected write is refused and not seen; the verdict is then `not tested`, with that reason.

**Verdicts.** `violated`, `platform`, `held`.

**Known limitations.** Only the scopes the tester reads back are examined. A write that lands in a place the tester cannot read is not seen. Where the server's identity cannot write in the default scope, a misdirected write is refused there and the test does not see it. The test is of targeting, not of authorization. It shows whether a write made naming a scope that the tester created lands there, and not in the second scope or the default scope. It does not show whether the caller may act in the scope it names: a `held` verdict does not say that the scope belongs to the caller, or that the server or the backend would refuse a scope that belongs to another tenant or owner. Whether a caller may act in a scope is decided by the access control of the server or the backend, and authorization is out of scope ([section 2](#2-scope)). A refusal for lack of permission that stops a misdirected write, as in the case cited in the Rationale, is access control at work, and the targeting is still wrong. A tester acts only in a system that its operator has declared to be a test system and names no scope outside it ([section 7.3](#7-test-methods), rule 1), so a result of this test says nothing about a boundary between tenants, or about whether a server would refuse a scope in which the caller may not act. Nor does a `held` verdict show that the scope the tool was told holds only the tester's objects, which the forms of MWS-TGT-2 need (section 7.3, rule 1).

#### MWS-TGT-2

- **Level:** MUST
- **Status:** draft, since 0.9
- **Applies when:** the server offers a tool that deletes, or that updates more than one object, and that accepts a selector or a path.

> **Requirement.** A tool that deletes or bulk-updates MUST NOT treat an empty, missing or match-all selector, or the path of a container, as selecting every object in the container or collection unless the caller sets an explicit argument that opts in.

**Rationale.** [PAY-03][reg-payload] ([article][payload]): update and delete with an empty filter matched every document, deleting 20 of 20, while the REST API given no filter answered HTTP 400 in 5 of 5 trials; the article classes this as a design gap. [GH-03][reg-github] ([article][github]): a file-delete tool given a folder path deleted the whole folder and reported success (upstream [issue 3757][gh-3757]).

**Evidence.** `observed` (2 servers; one case is classed by its article as a design gap).

**Test method.** black-box, and only inside a container (a folder, project, namespace or collection) that the tester created for this test and has confirmed holds nothing but objects it created, and only where the operator has declared that every object the server's identity can change in the backend is disposable ([section 7.3](#7-test-methods), rule 1). Create several objects in the container. Call the tool with an empty selector, then with the selector omitted, then with a selector the declaration names as match-all, then with the container's own path, each without any opt-in argument. After each call, count the objects that remain. For a tool that updates, also read back each object in the container and compare the fields that the tool under test can set ([Annex E](#annex-e-informative-the-declaration)) with a read made before the call, leaving out the server-managed fields the declaration names; an object that changed counts as acted on, as an object that is gone does for a delete. Create the objects again before the next call. Just before and just after each call, also take an inventory of the objects the tester did not create: the objects, of the kinds the tool can delete or update, that it can list in the default scope and in every other scope the server's identity can list, leaving out the kinds that the declaration names as removed or changed by the backend itself. After the call, each object in the inventory taken before it is read back by its identifier where a read tool reads one object by its identifier, because a list can lag behind a delete or miss a scope once; that read decides whether the object is gone ([section 7.3](#7-test-methods), rule 11), and only where there is none does the list decide. For a tool that updates, the read compares the fields that the tool under test can set, as for the container. An object that the tester did not create and that is gone after the call, or for a tool that updates changed, makes the record `violated`, and the record names it. The record states what each inventory covered: the scopes listed, the number of objects, and whether every page was read. An inventory is partial where the tester cannot establish that it reached every object the server's identity can change, for example because a scope cannot be listed, only one page was read, or a list hides some objects (drafts, trash, other locales or other owners). The container-path probe is not sent to a tool the declaration lists as existing to delete containers (NF-18). Without such a container, or without the operator's declaration, the test is not run, and the verdict is `not tested`.

**Verdicts.** `violated`, `held`. A control arm does not change the verdict: a guard on a destructive write that matches everything is the server's to add, whatever the backend accepts. A call after which an object the tester did not create is gone, or for a tool that updates changed, is `violated` and never `held`. A partial inventory never gives `held`: where no call showed the forbidden behavior and an inventory was partial, the verdict is `not tested`, with that reason.

**Known limitations.** The selector forms tried are those listed and those the declaration names as match-all. An object lost in a place that the server's identity cannot list is not seen. A server whose tools act on a collection that the tester cannot create, and that offer no container below it, cannot be tested, because every match-all form would reach objects the tester did not create. The verdict is `not tested`, and the record says so.

**Guidance.** A refusal should not present the opt-in argument as the way to make the call succeed. The argument stops an accident. It does not stop a caller that sets it in order to get past the refusal. A bulk tool that can report how many objects a selector matches, before it acts, lets a caller check first.

#### MWS-TGT-3

- **Level:** MUST
- **Status:** draft, since 0.9
- **Applies when:** the server offers a tool that its name and description present as a create, for a resource whose objects are identified by a name or key the caller chooses. A tool that its name and description present as an upsert or an apply is not a create for this purpose. A tool whose name and description present it as bringing a new object into being under a name the caller chooses (run, start, launch, deploy, install, clone; a start of an existing object does not) is a create for this purpose unless its name or description says that an existing object of that name is updated, replaced or applied over.

> **Requirement.** A create tool MUST NOT overwrite an existing object that has the same name or key unless the caller sets an explicit argument that asks for the overwrite.

**Rationale.** [K8S-08][reg-kubernetes] ([article][kubernetes]): a create tool given the name of an existing virtual machine overwrote it and answered "created successfully" in 3 of 3 trials, where a create sent to the platform API returns HTTP 409 (upstream [issue 1663][k8s-1663]).

**Evidence.** `observed` (1 server; the steward's follow-up on the upstream issue says that the overwrite may be an intended upsert and leaves the choice to the maintainers).

**Test method.** black-box, with an optional control arm. For a tool that does not call itself a create, upsert or apply, the declaration records which class the tool was put in under the applicability condition, and quotes the words of its name or description relied on; the text of a result does not count. Create an object. Change one of its fields so that it differs from what a fresh create would store. Call the create tool again with the same name or key and default arguments. Read back and compare.

**Verdicts.** `violated`, `platform`, `held`.

**Known limitations.** The test covers one name collision within one scope.

### 9.4 RES: truthful results

A caller, and above all a model, acts on what the tool result says and not on the state of the backend. A result that does not match what happened is a defect even when the backend state is correct.

#### MWS-RES-1

- **Level:** MUST
- **Status:** draft, since 0.9
- **Applies when:** the server offers a write tool.

> **Requirement.** A write tool MUST report success only when the state the caller asked for is in effect afterwards.

**Rationale.** [GH-06][reg-github] ([article][github]): an update that skipped an empty title or body returned success with nothing changed (upstream [issue 3759][gh-3759]). [K8S-10][reg-kubernetes] ([article][kubernetes]): a delete answered "deleted successfully" while a finalizer held the object; the article classes this as a design gap. [PAY-04][reg-payload] ([article][payload]): fields named like tool arguments were not stored, and the tool returned success text, in 5 of 5 trials (upstream [issue 19591][pay-19591]; present in release 3.93.0, the current stable release; on the 4.0 beta line the article's re-run found it fixed in 5 of 5 trials).

**Evidence.** `observed` (3 servers; one case is classed by its article as a design gap).

**Test method.** black-box, with an optional control arm. For each declared write path, send calls that the server may be unable to carry out as asked: an update that sets a field to an empty value, an update of each field the declaration lists, a delete, and any case the declaration adds. After the settle interval that the declaration states, read back and compare the state with what the call asked for. A change that has not taken effect by the end of the settle interval is read as not in effect.

**Verdicts.** `violated` (the result reports that the change was made, and the state asked for is not in effect), `platform` (the platform API's own answer to the same call says that the change was made, and not only that it was accepted, while the state asked for is not in effect), `held`.

**Known limitations.** The cases are those listed and those the declaration adds. A result depends on the settle interval the declaration states.

**Guidance.** A call that leaves things as they were because they were already as asked, such as a delete of an absent object named by its identifier, may report success (NF-5). Saying in the result that nothing was changed helps the caller. An empty list of changed fields in a receipt (MWS-RES-4) is how a no-op says so. A `replace` or a `remove` on a key that does not exist is not covered by any requirement in 0.9 and is reported as an observation ([GF-08][reg-grafana] ([article][grafana]): `replace` stored a stray key, and a no-op `remove` was accepted, both in 3 of 3 trials; [RFC 6902][rfc6902], sections 4.2 and 4.3). A result that says an operation was accepted or is pending, when it is, for an operation the declaration lists as completed asynchronously, is not a report of success (NF-19).

#### MWS-RES-2

- **Level:** MUST
- **Status:** draft, since 0.9
- **Applies when:** the server offers a write tool.

> **Requirement.** A write that fails in whole or in part MUST NOT be reported as a success; the error MUST identify any change that remains applied, or say that it is not known whether a change was applied, and MUST NOT report a settled outcome as not known, and MUST NOT tell the caller to repeat a write whose outcome is open, except after a read that it names or with the idempotency key or the version that the call carried; and where the failure is a refusal or failure of the backend, or of a rule the tool applies, the error MUST be returned as a tool execution error (`isError: true`).

**Rationale.** [PAY-05][reg-payload] ([article][payload]): bulk update and delete reported success with no `isError` when some documents failed, in 5 of 5 trials, while the REST API answered HTTP 400 with the errors (upstream [issue 19591][pay-19591]; proposed fix for the bulk delete: upstream [pull request 19592][pay-pr-19592]). [GH-05][reg-github] ([article][github]): an edit stayed applied although the call reported an error (upstream [issue 3756][gh-3756]). [K8S-17N][reg-kubernetes] ([article][kubernetes]): an uninstall whose lookup was refused for lack of permission answered "not found" as a success (upstream [issue 1666][k8s-1666]; the article notes that this finding has weaker validation than the others). An outside study of agents under injected faults reports that agents often repeat a write whose outcome they were not told: where a read-back could reveal the lost write the frontier models it tested mostly recovered, and where an immediate read-back could not, they repeated the write in more than half of the episodes ([arXiv 2609.29095][arxiv-2609-29095]; see [section 11.7](#117-relationship-to-other-work) of this document).

**Evidence.** `observed` (3 servers; one finding has weaker validation, as its article notes). For the unknown-outcome case, including the clauses on a settled outcome and on telling the caller to repeat the write: `derived` (the outside study cited above, and reasoning).

**Test method.** black-box and proxy-assisted. Black-box: provoke a failure through means the declaration provides, such as one invalid item among several, a second step that the backend will refuse, or a credential that lacks a permission. Proxy-assisted: make a chosen backend request of the call fail. In both, record the form of the result. A result whose `resultType` is `complete`, or is absent, and that has no `isError: true`, is a success, unless NF-19 applies to it or its content says that the write failed or that it is not known whether the write was applied. An `input_required` result (revision `2026-07-28`) is neither a success nor an error: the trial is judged on the final result, after the request has been retried with the answers. A task handle (`resultType: "task"`, under the [Tasks extension][mcp-tasks]) is neither. A task is judged on what the terminal task carries and not on its status word, by the same rules: a tool result that it carries is read as a tool result, including its `isError`, and a JSON-RPC error that it carries is a JSON-RPC error. Under the Tasks extension a `completed` task carries the result and a `failed` task carries the error. Under the tasks of revision `2025-11-25` a `failed` task can carry a tool result with `isError: true`, which is read from `tasks/result`. A result whose `resultType` the tester does not recognize is invalid under the MCP specification. The trial is indeterminate (section 7.3), and the record states the value. A JSON-RPC error is a protocol error. It does not report the failed write as a success, and the first two clauses apply to it as they do to a tool execution error. Read back the state, and compare what remains applied with what the error says. Proxy-assisted, for an unknown outcome: let the call's last mutating backend request reach the backend, let the backend apply it, and close the connection before the server receives the answer to that request. The request is identified from a run of the same call without a fault, as in the held-request procedure of section 7.4. Later backend requests of the same call, including a retry, pass unchanged. Read back the state. The tester knows from the interposer and the read-back that the write was applied, so the trial is not indeterminate in the sense of section 7.3 unless the tool call itself times out. Proxy-assisted, for a settled outcome: the run without a fault, and a run through the interposer of each failure that the black-box test provokes, are also used. For each, the tester records every backend request of the call and the answer that the interposer delivered to the server, and reads back the state. An answer counts as delivered only where the interposer sent it complete before the server closed or reset that connection and before the call's result was sent. The tester takes an answer that the interposer forwarded from the backend as the backend's own, and an answer that the interposer made itself as an intermediary's. It decides from the answer, its status and its body, and from the declaration (Annex E), whether the answer reports that the request was carried out, that it was refused, or neither: an error reported in the body, or a status given for each item, overrides the status for what it covers; an answer that reports only acceptance for later processing (in HTTP, 202) reports neither; and for a backend that does not answer in HTTP, only the answers that the declaration lists report that a request was carried out or refused. A statement by the server that the outcome is not known does not make these runs indeterminate in the sense of section 7.3: the tester knows the outcome from the interposer and the read-back. Proxy-assisted, for a same-key call while the first is in flight (the same-key trial), where the tool accepts an idempotency key: hold the first keyed write after the backend has taken its key and before it commits, by a cooperative hold inside the backend that the declaration names; while it is held, send the same call with the same key; once both calls have answered, read back the state. Where the declaration names no such hold, or the hold does not take effect, the trial is not made. An interposer that holds the request before the backend receives it does not bring the condition about, because the backend then holds no pending key for the second call to meet.

**Verdicts.** `violated` (the result is a success; or a change remains applied that the error neither identifies nor reports as unknown, or the error reports a settled outcome as not known, or tells the caller to repeat a write whose outcome is open; or a backend or rule failure is returned as a protocol error), `held`. A `violated` record states which of the three clauses it is, and names each that applies. In any trial, a result without `isError: true` whose content says that the write failed is `violated` under the third clause, and the record quotes the text. A JSON-RPC error that the MCP specification requires or defines for the case is not a failed write under the third clause: an unknown tool; a request that does not satisfy the `tools/call` request schema; in revision `2026-07-28`, a missing required `_meta` field, a header that does not match the body, an unsupported protocol version or a missing client capability; in revision `2025-11-25`, a URL elicitation that is required first, or a tool that must be called as a task. The first two clauses still apply where such an error is returned after the tool has made a change. Where no change was made, the trial adds no verdict to this record. Where no trial of a record adds a verdict, for this reason or under NF-19, the record is `not tested`, with that reason. A fault inside the server itself that is returned as a JSON-RPC error, which is the "Server errors" case of the MCP Tools page, is judged on the first two clauses only. Where a tester receives a JSON-RPC error and cannot establish its cause, the record is judged on the first two clauses and states that the third clause was not tested, and why. A result that is not a success reports the write as one that failed in whole or in part, so the second clause applies to it even where the write was carried out; in the run without a fault only the clause on a settled outcome is judged. A result that says it is not known whether the write, or a change, was applied reports a settled outcome as not known, and is `violated` under the second clause, kind `unknown-when-settled`, in two cases: in the run without a fault and in a run of a provoked failure, where the call sent at least one backend request, the interposer delivered to the server the backend's own answer to each, each answer reported that the request was carried out or refused, and the read-back agrees with what the answers reported; and in the lost-answer trial, where the interposer shows that the server sent the cut request again and delivered to the server the backend's own answer reporting that this repeated request was carried out, so that a change is known to the server to be applied. The record quotes the text. A result to which NF-19 applies is not such a statement. These runs add `violated` or no verdict to the proxy-assisted record, and never `held`. Outside these two cases a statement that the outcome is not known is judged by the rules that follow, and the black-box test does not judge it under this clause. In the unknown-outcome case the backend applied the write and the server did not receive the answer. The rules below apply where the read-back shows the write in effect. Where it does not, because the server undid the write, the trial is judged as any failed write: what the error says is compared with what remains applied. A result that is a success, and whose content does not say that the write failed, that nothing was changed or that it is not known whether the write was applied, reports no failure, and the write is in effect, so the trial adds no verdict to this record; if no other trial remains, the record is `not tested`, with that reason. Whether the success is true is judged by MWS-RES-1, and a second applied write caused by the server's own retry is recorded as an observation. Where the interposer shows that the server made no further backend request after the cut, the record also notes the observation `unverified-success`. Where the result is an error, or its content says that the write failed, that nothing was changed or that it is not known whether the write was applied, the server has not reported the write as a success, and the second and third clauses apply to it. The lost answer is a failure of the backend for the third clause. In this trial a change remains applied and the outcome of the cut request is open, so the kinds below are judged here, and only here; the kind `unknown-when-settled` is judged in the two cases above. A `violated` verdict from this trial, and one of kind `unknown-when-settled`, names its kind from this list, and names each that applies; a `violated` verdict from any other trial names its clause only:

| Kind | What the caller was told | Clause |
|---|---|---|
| `stated-failure` | A tool execution error or a JSON-RPC error whose content says that the write, or the operation the tool performs, failed, was not made or could not be made, or that nothing was changed, and does not say that it is not known whether the write was applied. | second |
| `retry-invited` | A tool execution error or a JSON-RPC error whose content tells the caller to repeat the call, and names neither a read to make first nor the idempotency key or the version that the call carried, or that names the version and a repeat with that version was applied again (the follow-through below). | second |
| `bare-transport` | A tool execution error or a JSON-RPC error whose content is the transport or client error, with or without the name of the operation, and says nothing about whether the write was applied. | second |
| `unknown-when-settled` | A result that says it is not known whether the write was applied, in one of the two cases above in which the outcome was settled. | second |
| `no-error-flag` | A result without `isError: true` whose content says that the write failed, that nothing was changed, or that it is not known whether the write was applied. | third |
| `protocol-error` | A JSON-RPC error, whatever it says. | third |

A statement about the write or its object ("failed to create", "unable to save", "was not applied") is `stated-failure`. A statement only that the call, the request or the tool had an error ("error calling tool", "request failed", "internal error") is `bare-transport`, unless the error also says that it is not known whether the write was applied. An error tells the caller to repeat the call where it proposes sending the same write again, as an instruction, a suggestion or a permission ("try again", "please retry", "you can retry"). Advice to send a corrected or different write is not a repeat, and a warning that a repeat may apply the write a second time is not an invitation. An error names a read where it names a read tool or the object to read, and names the idempotency key where it gives the key or tells the caller to use the same key. An error names the version where it gives the version the call carried or tells the caller to send the same version again. The tester then sends the call again with that version, with no fault injected, and reads back the state. In this trial the first write was applied, so a repeat that is applied again is `violated`, kind `retry-invited`, and the record says the version did not guard the repeat. A conflict, or a success that does not apply the write again (NF-24), meets the requirement. The tester decides by the declared patterns or by a person's reading (section 7.3, rule 11), and the record quotes the text. In this trial, a tool execution error that identifies the applied change, or that says it is not known whether the write was applied, and that is none of these kinds, is `held`.

In the same-key trial, where the read-back shows the write that the key identifies in effect, the answer to the second call is read as a statement about that write, as Annex B, B-9, *A repeat with a key*, says for an adopted shape, and in the same way for its text. An answer that says that the earlier call with that key failed, or that the write was not applied, including `outcome: "not_applied"` in an adopted shape, is `violated` under the second clause, whatever the second call itself did. An answer that says that a call with the same key is still in progress, in use or outstanding, and does not say that the write failed or was not applied, says that the outcome is open: it is `held`, and the record carries the observation that the form of B-9 (`outcome: "unknown"`, `code: "in_progress"`, `repeat: "same_key"`) is recommended. Until version 1.0, an error that says nothing about the write or the key, such as a bare "409 Conflict", is recorded as an observation and adds no verdict. Where the read-back does not show the write in effect, nothing contradicts the answer, and the trial adds no verdict. What the answer says is decided as section 7.3, rule 11, provides, and a `violated` record from this trial names its clause only.

**Known limitations.** The failures tested are those the declaration can provoke and those the interposer can inject. A tester can tell that an outcome was settled only where its interposer delivered the backend's answer to the server: in the run without a fault, in a run of a provoked failure, and where the server sent the cut request again and the backend's answer reported that request carried out. The tester takes an answer that its interposer forwarded as the backend's own, and cannot tell it from the answer of an intermediary beyond the interposer. A server that settles the outcome another way, for example by a read that it makes itself, and still reports it as not known is not detected, and the black-box test does not detect a settled outcome at all. Unlike the proxy-assisted step of MWS-RETRY-2, this requirement does not ask a server to look a write up where the backend offers a way to do so. The outcome of a request that the server knows it did not send is not settled (section 4), so a server that reports such a failure as not known is not judged on it, and nothing in this requirement stops such an error from suggesting a repeat. After a restart that the tester caused (MWS-RETRY-2, step (e) and its crash form), the server has no record of the earlier call, so the outcome of that call is not settled for it: an answer that says the outcome is not known, or that the key is not known, is not judged under the clause on a settled outcome, and the only trial of this requirement in that step is the one MWS-RETRY-2 states. An answer that then tells the caller to send the write again, for example with a new key, breaks the clause on repeating a write whose outcome is open, but no test of 0.9 judges it. Whether, for an error that only passes on the transport error, the duty to say that the outcome is not known should become a separate requirement at SHOULD, with the prohibitions staying in this requirement at MUST, is open for comment. Under the Tasks extension a server must not return a task to a client that did not declare support for it, so a tester that does not declare it cannot test a write that the server performs only as a task. The follow-through detects a version that does not guard the repeat only where no other writer acts; a version that returns to an earlier value is not detected. For a write that leaves the same state when applied twice, such as a whole-value set or a delete, a repeat that is applied again is seen only through a change of the version; where the version does not change, it is not seen.

**Guidance.** Both MCP revisions list API failures and business logic errors among tool execution errors, and server errors among protocol errors ([section 11.2](#112-clauses-mws-builds-on)). This requirement follows that division. A tool execution error is the form that reaches the caller as a tool result, so it is the better form wherever the caller could act on the failure. The overlap with MWS-RES-3 and MWS-ATOM-1 is intended. One partial failure can give three records about three facts: the failure is not reported as a success (MWS-RES-2), the identifiers of what was created survive (MWS-RES-3), and the partial outcome is itemized (MWS-ATOM-1). A server that cannot tell whether its write was applied, for example after a backend timeout, says that the outcome is unknown. Saying that the write failed invites a retry and a duplicate. A server that passes the error of its HTTP or database client to the caller as it stands, or behind words that say the operation failed, shows `violated` in the lost-answer trial. The fix is in the code that turns a backend client's error into a tool error. For a mutating request that was sent and whose answer did not arrive (a closed or reset connection, or a timeout after the request was sent), a tool execution error that says three things meets the requirement: that the request was sent and no answer was received; that it is not known whether the change was applied; and which read shows whether it was. Naming the read is not required, but it is what lets the caller settle the outcome without risking a duplicate. Such an error does not tell the caller to repeat the call, except after that read or with the idempotency key or the version that the call carried. A write that cannot take effect a second time, such as a whole-value set or a delete by identifier, is not safe to repeat blind: another writer's change made in between is undone, or an object recreated under the same identifier is deleted. Name a read, or invite the repeat with the version the call carried. For example: "Outcome unknown: the update to item 42 was sent and the connection closed before an answer arrived. The change may have been applied. Read item 42 with get_item before repeating the call." A settled outcome is reported as what it is, a refusal as a refusal. A failure before the request was sent, such as a refused connection, may be reported as a failure. Annex B, B-9, describes a structured form for an unknown outcome, the read that settles it and the repeat the caller may make.

#### MWS-RES-3

- **Level:** MUST
- **Status:** draft, since 0.9
- **Applies when:** the server offers a tool that creates an object.

> **Requirement.** A create tool MUST return the identifier of each object it created, including when a later step of the same call fails.

**Rationale.** [GH-05][reg-github] ([article][github]): when a pull request was created and a later step of the same call failed, the call returned an error and the new pull request's number and URL were lost (upstream [issue 3756][gh-3756]).

**Evidence.** `observed` (1 server).

**Test method.** black-box and proxy-assisted. Black-box: create an object, take the identifier from the result, and read the object back by it. Proxy-assisted, or black-box where the declaration can provoke it: make a step after the create fail, and check that the error result still carries the identifier of the object that now exists.

**Verdicts.** `violated`, `held`.

**Known limitations.** A create tool with a single backend step has no later step to fail; for it only the first check applies. The unknown-outcome trial of MWS-RES-2, in which the server did not receive the backend's answer to a create, is not a trial of this requirement.

#### MWS-RES-4

- **Level:** SHOULD
- **Status:** draft, since 0.9
- **Applies when:** the server offers a tool that creates or updates an object.

> **Requirement.** A write tool SHOULD return a receipt that identifies the object written, the fields changed and, where the resource has a version, its new version.

**Rationale.** The Grafana usability changes [B1 and B2][reg-grafana] ([article][grafana]) are not findings: returning the applied operations and the stored object saved a verify read after a write (proposed upstream in [pull request 1520][gf-pr-1520]).

**Evidence.** `derived`. The entry rests on two usability changes that the steward proposed upstream, not on a finding.

**Test method.** black-box. After a successful create, check that the result contains the object's identifier and the new version where the declaration names one. After a successful update, check also that it contains the name or the new value of each field the call changed, as the read-back shows, apart from server-managed fields.

**Verdicts.** `violated` (the identifier, a changed field or the declared version is missing), `held`.

**Known limitations.** The check is of presence only. How large a result is, and whether a full echo of the object is useful, is measured under [Annex A](#annex-a-informative-measurements), item A-3, and is not judged. The same item measures server-managed metadata in a write result that the server's own read tool omits.

**Guidance.** A receipt also covers the case in which the write succeeded and the server cannot read the backend's answer. [J1][reg-posthog] ([article][posthog]): a backend response with a success status and an unreadable body was returned as a successful result, which the article classes as an incomplete result. A receipt names a field that holds a secret and does not echo its value (MWS-SEC-1). Annex B, B-9, describes a structured form for a receipt.

### 9.5 ATOM: multi-step and multi-item writes

One call makes several backend writes. Some land and some do not.

#### MWS-ATOM-1

- **Level:** MUST
- **Status:** draft, since 0.9
- **Applies when:** the server offers a tool that writes more than one item, or makes more than one backend write, in one call.

> **Requirement.** A multi-item or multi-step write that is not applied completely MUST NOT report success and MUST name which items or steps were applied and which were not.

**Rationale.** [K8S-01][reg-kubernetes] ([article][kubernetes]): a multi-document apply stopped at the first refusal and did not say what had already been applied (upstream [issue 1660][k8s-1660]). [K8S-06 and K8S-15][reg-kubernetes] ([article][kubernetes]): some document separators caused later documents to be dropped while the call reported success (upstream [issue 1659][k8s-1659]). [K8S-03][reg-kubernetes] ([article][kubernetes]): a delete reported success when the deletion of its companion object was refused (upstream [issue 1665][k8s-1665]). [PAY-05][reg-payload] ([article][payload]): see MWS-RES-2. [GH-04][reg-github] ([article][github]): when a push created a new branch and then failed, the branch was left behind (upstream [issue 3755][gh-3755]).

**Evidence.** `observed` (3 servers).

**Test method.** black-box and proxy-assisted. Black-box: send a multi-item call in which one item is invalid or will be refused, in the first, a middle and the last position. Proxy-assisted: make the second and then the last backend write of the call fail. In each case read back every item and compare with what the result says about each. Where the declaration gives a pattern for a statement that the whole write took effect, with every item or step applied ([Annex E](#annex-e-informative-the-declaration)), the tester also matches it against the content of each result, as [Annex B](#annex-b-informative-mitigation-patterns), B-9, *Free words and the serialized block*, provides for a declared text pattern: the text blocks other than the serialized block, and the free words of a shape. Such a pattern is written so that it does not match a text that says that only some items or steps were applied, that names an item or step that failed, was not attempted or whose outcome is not known, or that repeats the call's arguments, such as "Partly applied: items 1 and 2" or "All 3 items saved, but the notification step failed". Where the declaration gives no such pattern, or gives one that cannot be applied as written, the test does not ask what the content says about the whole write, so the reason "needs reading" of [section 7.3](#7-test-methods), rule 11, does not arise from it, unless a person's reading, recorded as that rule says, takes the pattern's place.

**Verdicts.** `violated` (the result is a success, or its content says that the whole write took effect, although an item or step was not applied; or the result, read with the call, does not let the caller tell for each item or step whether it was applied), `held`. An item or step whose outcome is open for the server ([section 4](#4-terms)), as it is where the interposer itself answered the request with a failure, is named where the result says that it is not known whether that item or step was applied; MWS-RES-2 judges that statement. A result that says nothing was applied names every item as not applied. A result that names the items that failed and says all others were applied names both sets. For a write by selector the items are the objects the selector matched, and a count of those applied with the identifiers of those not applied meets the naming clause. A result whose content the pattern for a statement that the whole write took effect matches reports success: where the read-back shows that an item or step was not applied, the record is `violated`, whether or not the result is an error. A shape that names the items correctly does not make up for it, as section 7.3, rule 11, provides, and nor does another text that names them, by this requirement's sentence. For a delete, an item that the read-back finds absent is not one that was not applied (NF-5). A match where every item and step was applied adds nothing, and the absence of a match never gives `held` on its own: `held` rests on the read-back and the naming clause, as without the pattern. Where the declaration gives no such pattern, or gives one that cannot be applied as written, and no person read the content for that statement, the pattern decides nothing, and a `held` record says that the content was not read for a statement that the whole write took effect.

**Known limitations.** Dropped items are found only if the tester reads back every item it sent.

**Guidance.** Name each item or step by its position in the call or by its identifier, and say of each whether it was applied, failed or was not attempted. A result that names only the first item that failed leaves the caller to find out the rest.

#### MWS-ATOM-2

- **Level:** SHOULD
- **Status:** draft, since 0.9
- **Applies when:** the server offers a tool that writes more than one object in one call.

> **Requirement.** A multi-object write SHOULD be all-or-nothing, so that when any part of it fails none of its changes remains applied.

**Rationale.** The [Payload article][payload-held] records, as behavior that held up, that a server killed mid-write rolled back, with 0 of 3 writes landing. The [Kubernetes article][kubernetes] describes a build that validates every document before writing any, and notes that this prevents the partial writes tested but is not a transaction.

**Evidence.** `derived`. The cited cases show the behavior holding or describe a mitigation; none shows the failure.

**Test method.** black-box and proxy-assisted, with the same failures as MWS-ATOM-1. After the failed call, read back every item.

**Verdicts.** `violated` (some items of a failed call remain applied), `held` (none do).

**Known limitations.** A `held` verdict covers the failure positions tested.

**Guidance.** A backend transaction is the reliable way. Without one, validating every item before writing any and undoing what was written on a later failure comes close, but cannot prevent a failure caused by a change between validation and write ([Annex B](#annex-b-informative-mitigation-patterns), B-7).

### 9.6 RETRY: retries and replays

A caller that does not receive an answer sends the write again. The Key Changes page of revision `2026-07-28` says a request whose response stream broke is lost and is re-issued as a new request with a new request ID ([section 11.4](#114-what-revision-2026-07-28-changes-for-write-safety)). The same revision lets a server answer with an `input_required` result, after which the client retries the original request.

#### MWS-RETRY-1

- **Level:** SHOULD
- **Status:** draft, since 0.9
- **Applies when:** the server offers a create tool for which two calls with the same arguments create two objects.

> **Requirement.** A create tool whose repeated call would create a second object SHOULD accept an idempotency key from the caller.

**Rationale.** The [GitHub article][github-other] notes that two create tools send no idempotency key, so a retry after a lost response creates a duplicate; it describes this as platform API behavior to which the server adds no protection, and did not file it. [K8S-05][reg-kubernetes] ([article][kubernetes]): a client timeout hid the outcome of an install; the article classes this as a design gap. Offering a key is a SHOULD because it is a mitigation, and because the MCP specification defines no carrier for the key ([section 11.5](#115-idempotency-keys)).

**Evidence.** `derived`. One cited case shows a lost outcome (classed by its article as a design gap) and one was noted and not filed; neither shows a duplicate. Reports by others show the duplicate itself: first, the reproduction in MCP [issue 3394][mcp-issue-3394]; second, a create-issue call that made two issues when sent twice to release 1.14.0 of one of the servers cited above ([scan results][agentsafe-scan]); and third, four of eleven servers in the README of [`mcp-rig`][mcp-rig]. The steward has not reproduced them. Scans reported in the same thread found very few write tools that accept a key ([section 11.7](#117-relationship-to-other-work)).

**Test method.** black-box. Send the same create call twice, one after the other, with different JSON-RPC request IDs, as a client re-issuing a lost request would, and count the objects. If there are two, check whether the declaration names an idempotency key for the tool, and whether a call that carries the key in the place the declaration names is accepted.

**Verdicts.** `violated` (two objects, and no key is accepted), `held` (a key is accepted; its behavior is judged by MWS-RETRY-2). A create that refuses a duplicate of a name or key the caller chose, or that returns the existing object for it, is `not applicable`: two calls with the same arguments do not create two objects ([Annex B](#annex-b-informative-mitigation-patterns), B-6).

**Known limitations.** The MCP specification does not define a carrier for an idempotency key. The declaration says where the key goes: a tool argument or a `_meta` field. A key carried in `_meta` follows the MCP rules for `_meta` key names, which reserve some prefixes for MCP use.

**Guidance.** A model that retries tends to build the call again, with a new key. The tool's description should say that a retry of the same intended write sends the same key, and how long a key is remembered. The `2026-07-28` Tools page suggests the same for a handle's retention, in non-normative guidance ([section 11.2](#112-clauses-mws-builds-on)).

#### MWS-RETRY-2

- **Level:** MUST
- **Status:** draft, since 0.9
- **Applies when:** the server offers a write tool that accepts an idempotency key.

> **Requirement.** A write repeated with the same idempotency key and the same arguments MUST be applied at most once and, where the first call applied it and the server can establish that, MUST be answered with the outcome of that call; a write with a different key MUST be treated as a new write; and a write that reuses a key with different arguments MUST be refused.

**Rationale.** No published finding among those cited shows a server mishandling an idempotency key; this requirement rests on reasoning and on the change in revision `2026-07-28` that removes stream resumption, after which a caller that lost a response and holds no task handle can only send the request again ([section 11.4](#114-what-revision-2026-07-28-changes-for-write-safety)). A key that is accepted and not honored is worse than no key, because the caller relies on it. The second and third clauses guard against the two ways an idempotency check goes wrong: treating every call as a replay, and returning an earlier result for a different request. The first and third clauses take their rules from the IETF Internet-Draft [The Idempotency-Key HTTP Header Field][idem-draft] (revision 09; an Internet-Draft, not an RFC), which states them at SHOULD level and for HTTP ([section 11.5](#115-idempotency-keys)).

**Evidence.** `derived`.

**Test method.** black-box and proxy-assisted; step (e) and its crash form with launch. A second answer has the outcome of the first call when it identifies the object or change that the first call applied and reports it as applied. Where the first answer was a success, the second is a success too and gives the same identifier, where the first answer gave one, and the same version, where it gave one; a repeat of the first answer has its outcome, and a replay indicator, a different sentence and an empty list of changed fields are not a different result. A task or `input_required` answer is judged on its final result, as in MWS-RES-2. While the first call is still in progress there is no such outcome, and the repeat is judged only on whether the write is applied more than once; what its answer says about the first call is judged by MWS-RES-2, in its same-key trial. Where the first call did not apply the write there is no such outcome either, and the Verdicts line says what the step gives. Steps (a), (d) and (e), the crash form of step (e) and the proxy-assisted step use a write whose repeat leaves a trace the tester can read: a create, an append, or an update of an object whose version field the declaration names and whose version, the declaration says, the backend changes on every write it applies, even one that leaves the values as they were, and on nothing else, in steps the tester can count, such as a number that grows by one with each write, and to which, the declaration says, the tool makes no backend write except one for each application of the write. The tester reads the trace before the first call and after each answer: for an update, the version; for a create or an append, the objects or applied changes. The tester counts from before the first call. Black-box: (a) send a write with key K, wait for the answer, send the same write with K again, and count the objects or applied changes; (b) send the same write with a new key and check that it is treated as a new write: it is applied, or it is refused on its own merits; (c) send K again with arguments that differ and that the tool would apply under a fresh key, and check that the call is refused and the object is unchanged. Where the key is a tool argument the refusal is expected as a tool execution error, and where the key is carried outside the arguments it may be a JSON-RPC error, and the tester accepts either form here; (d) send pairs of writes, each pair with a fresh key, until at least 30 pairs have overlapped or a number of pairs stated in the record has been sent: the two writes of a pair carry the same key and the same arguments and are sent at the same moment; record for each pair whether the two calls overlapped, and count the objects or applied changes. Proxy-assisted: let the backend commit the first write, cut the response before the server receives it, let later backend requests pass unchanged, and repeat (a). Restart (black-box, launch): (e) send a write with key K and wait for the answer; stop and start the server, by the means the declaration gives, and read the trace; as soon as the server answers a `tools/list` request again, send the same write with K again, and count the objects or applied changes, reading the trace again after the settle interval where the declaration states one. The record states whether the stop was graceful or a kill, and the time between the first answer and the repeat; a graceful stop after which the process did not exit by itself, and was killed, counts as a kill. The crash form of step (e) (proxy-assisted, launch): let the backend commit the first write, hold its answer at the interposer, stop the server while the answer is held and before the server answers the call, start it with the interposer still in place, let later backend requests pass unchanged, read the trace, and send the same write with K again, as in step (e). A backend request that applies the write again, seen at the interposer after the restart, is counted as an application.

**Verdicts.** `violated`, `held`; step (d): `violated`, `not observed`. Steps (a), (b) and (c) share one black-box record: `violated` if any of them is, `held` if all three forced their condition and held, and otherwise `not tested`, naming the step. The record states what each of the three steps showed. Step (d) has its own record, marked "simultaneous repeat". It is not forced and can produce only `violated` or `not observed`; section 8.2, rules 5 to 7 and 9, apply to it, with the two calls counted as a pair and a pair in which the write was applied more than once counted as a loss. Section 7.3, rule 2, does not apply to it. The proxy-assisted step has its own record. Where the tool has no write whose repeat leaves a trace the tester can read, step (a), step (d), step (e), its crash form and the proxy-assisted step give `not tested`. In step (a), in step (d), in step (e) and its crash form, and in the proxy-assisted step, a write with key K that the trace counts as applied more than once is `violated`, whether the second application came from the repeat or from the server's own retry of the first call, except for a write that the server undid, as the proxy-assisted step says below. In step (e) and its crash form, this rule is applied before any other. In step (d), where the two calls overlapped, the pair is judged only on whether the write was applied more than once; an answer to the second call that gives the outcome of the first, and a refusal that says the first is still in progress, are examples of correct answers. What the answer to the second call says about the first is not judged in step (d); MWS-RES-2 judges it in its same-key trial, in which the first call is held inside the backend so that the second is sure to meet it in flight. Where they did not overlap, the pair is judged by the rules for step (a); its result goes to the step (d) record, where it can add only `violated`, and it is not counted as an overlapped pair. In step (a) and in the proxy-assisted step, where the first call with key K did not apply the write and the write was applied at most once, and in a pair of step (d), where neither call applied the write, the step did not force the condition and gives `not tested`; such a pair is not counted toward section 8.2, rule 6. In step (a), where the first call was answered with a success, or with an error that identifies the applied change, the server had the outcome: a repeat that gives it, with the write applied once, is `held`; a refusal that says nothing about the write itself, such as a rate limit or an unavailable backend, did not force the condition, and the step gives `not tested`; and any other answer, including one that says the outcome is not known, is `violated`, whatever the server kept afterwards. Where the first call applied the write and its answer did neither, and the write was applied at most once, step (a) did not force the condition and gives `not tested`; the proxy-assisted step is the forced form of that case. In step (b), a write with a new key that is answered as a replay of the earlier call, or refused because it repeats an earlier call, is `violated`. One that is refused on its own merits (a duplicate name under MWS-TGT-3, a stale version under MWS-CONC-2, an object that is already absent) was treated as a new write; a refusal by the backend's own check, or by one that the declaration says the tool makes whatever the key, of a version, a name or duplicate content is a refusal on its own merits, whatever its wording. A refusal that says nothing about the write itself, such as a rate limit or an unavailable backend, did not force the condition, and the step gives `not tested`. Where the write cannot take effect a second time (a delete whose object is now absent, an update that sets the values the object already has, a create of a name the caller chose that now exists, or of content that such a check finds to be a duplicate, or a write that carries the version the first call sent), a non-error answer that does not say it is a replay cannot be told from a replay, and the step gives `not tested` (NF-5, NF-24). That rule does not apply where an update leaves the trace the Test method describes and its version changed with the call: the write was applied, and a non-error answer that neither says it is a replay nor gives the earlier call's version was treated as a new write. In step (c), a write with different arguments that is applied, or that is answered with a success, including the earlier call's result, is `violated`. A refusal in any form, with the object unchanged, meets the third clause; MWS-RES-2 judges its form. A refusal that says nothing about the write itself, such as a rate limit or an unavailable backend, did not force the condition, and the step gives `not tested`. In the proxy-assisted step, where the first call was answered with a success, or with an error that identifies the applied change, the repeat is judged as in step (a). Where the server undid the first write after the cut (the interposer shows the request that undid it), the trial did not force the condition and gives `not tested`, unless more than one application of the write is in effect after the repeat, which is `violated`. Otherwise, where the first call was answered neither with a success nor with an error that identifies the applied change, the server did not receive the backend's answer to the first call, and the trace counts one application of the write after the repeat, a repeat that gives the outcome is `held` without the note, and a repeat that applies nothing and says that it is not known whether the first call was applied is `held`, and the record carries the note "outcome not established". A repeat that applies nothing and neither gives the outcome nor says that it is not known is also `held` with that note, because the requirement then asks only that the write be applied at most once; what its answer says is judged by MWS-RES-1 and MWS-RES-2. A `held` record with this note is never quoted without it. In that step, where the declaration says that the backend offers an idempotency key that answers a repeat with the result of the first request, or a lookup of a write by its idempotency key, that the tool could use, the server could have established the outcome, and a repeat that does not give it is `violated`. Where the declaration does not say, a `held` record with the note says that the declaration is silent. Section 7.3, rule 5, does not exclude a trial of the proxy-assisted step, or of the crash form of step (e), unless the repeat itself times out: an error or a timeout of the first call is the condition the step forces, the tester knows from the interposer that the first write was committed, and from the count whether the write was applied more than once. A repeat that says the outcome is not known is the answer being judged, not an unknown outcome. Step (e) has its own record, marked "restart", and its crash form has its own record, marked "restart during the first call". The restart in both is one the tester causes, by the means the declaration gives to stop and start the server; where the declaration gives none, step (e) and its crash form give `not tested`. Where the tool's description states how long a key is remembered, and that period is shorter than the time between the first answer and the repeat, the trial gives `not tested`, because how long a key is remembered is not tested (Known limitations), and the record quotes the stated period and the time measured. Next, where the first call applied the write and the trace read after the restart no longer counts that application, or no longer counts it after the repeat, the backend lost state in the restart: the trial did not force the condition and gives `not tested`, and the record says so. Otherwise, in step (e) and its crash form, the rule that a write with key K that the trace counts as applied more than once is `violated` is applied before any other rule of this entry, and before section 7.3, rule 5: it holds even where a call timed out. In step (e), where the first call with key K did not apply the write, or applied it and was answered neither with a success nor with an error that identifies the applied change, and the write was applied at most once, the step did not force the condition and gives `not tested`. Where the first call applied the write and was answered with a success, or with an error that identifies the applied change, and the trace counts one application of the write after the repeat: a repeat that gives the outcome is `held`; a refusal that says nothing about the write itself, such as a rate limit or an unavailable backend, did not force the condition, and the step gives `not tested`; and any other answer is to a repeat that applied nothing, which is `held`, and the record carries the note "key record not kept". Such a repeat is `violated` instead where the declaration says that the tool's key record survives a restart made by the kind of stop the tester used, or that the backend offers an idempotency key that answers a repeat with the result of the first request, or a lookup of a write by its idempotency key, that the tool could use: the server could then have established the outcome. A `held` record with the note "key record not kept" is never quoted without it, and where the declaration does not say whether the key record survives a restart, the record says that the declaration is silent. In the crash form, the repeat is judged as in the proxy-assisted step, with that step's note "outcome not established", except that a refusal that says nothing about the write itself, such as a rate limit or an unavailable backend, did not force the condition and gives `not tested`; what the declaration says about the key record surviving a restart does not change that verdict, because the server never received the outcome it would have recorded. Where the server answers the first call before it is stopped, the trial is not a trial of the crash form and is not counted; where no trial of the crash form can be completed, the crash form gives `not tested`. In step (e) and its crash form, what the answer to a repeat that applied nothing says is judged by MWS-RES-1 and MWS-RES-2, not here. Where the trace shows that the first call applied the write and that the write is still in effect when the repeat is answered, an answer to the repeat that says that the earlier call with key K failed, or that it did not apply the write, is also a trial of MWS-RES-2 for the same write path, and is `violated` under its second clause, because the write remains applied and the answer neither identifies it nor says that it is not known whether it was applied. That trial goes to the MWS-RES-2 record of the same method (black-box for step (e), proxy-assisted for its crash form), and the record states that this trial was made with launch and names this step; the trial is judged only as stated here. An answer that says that nothing was applied, or that the key is not known, and makes no statement about the earlier call, is not such a trial. This cross-record applies to step (e) and its crash form only. A repeat sent while the first call is still being processed is tried by MWS-RES-2 in its own same-key trial, under the rules stated there.

**Known limitations.** How long a key is remembered is not tested; the repeats are sent within seconds, and in step (e) as soon as the server answers again after the restart. A server that treats a key it no longer remembers because the key expired as a new key, as the Idempotency-Key draft and [Stripe][stripe-idem] do, is therefore not judged on that by 0.9. A key record lost in a restart is not an expired key in this sense: a server that applies the write again after a restart the tester caused is judged by step (e). A restart that the tester did not cause, between the calls of step (a), is not part of step (e), and that trial is judged as step (a). A repeat that carries a version and no key is judged by MWS-CONC-2. A tester cannot tell whether a server that says the outcome is not known, or that has no record of the key, could have established the outcome, beyond what the declaration says about the backend and about the key record. A repeat that reports a success it did not make, after a first call whose outcome the server could not establish, may be judged by no requirement in 0.9.

**Guidance.** A replay indicator, such as a result field that marks an answer as a replay, helps a caller and is not required. The declaration may name one.

#### MWS-RETRY-3

- **Level:** MUST
- **Status:** draft, since 0.9
- **Applies when:** the server offers a write tool that can answer with an `input_required` result (MCP revision `2026-07-28`).

> **Requirement.** A tool that answers with an `input_required` result MUST NOT have put into effect, in that call, the write the caller asked for, in whole or in part.

**Rationale.** Revision `2026-07-28` introduces a pattern in which a server answers with an `input_required` result and the client retries the original request with the answers ([section 11.4](#114-what-revision-2026-07-28-changes-for-write-safety)). The pattern is specified on the [Multi Round-Trip Requests page][mcp-mrtr] of that revision. A tool that writes before it answers `input_required` can write again on the retry. No published finding among those cited shows this; the requirement rests on the MCP text and on reasoning.

**Evidence.** `derived`.

**Test method.** black-box and proxy-assisted. The declaration says how to make the tool answer with an `input_required` result, and lists the state the tool can write. The tester declares the client capabilities that the input requests need, because the Multi Round-Trip Requests page forbids a server to send an input request that the client has not declared. Black-box: read that state. Call the tool so that it answers `input_required`. Before retrying, read the same state again and compare. Then retry under a new request ID, with the answers and with the `requestState` the server returned, where it returned one, and count the objects or applied changes. Proxy-assisted: record the backend requests the server makes from the start of the call until it returns the `input_required` result, and establish whether any of them changed the state that the declaration lists for the tool. A request that only reads, whatever its HTTP method, a request that the backend refused or rolled back, and a write to a log are not such changes.

**Verdicts.** Black-box: `violated`, `not observed`. Proxy-assisted: `violated`, `held`. `violated` means that the write the caller asked for, or part of it, was in effect before the `input_required` result was returned. State that the tool staged before the result in order to finish the write on the retry, such as a draft, a reservation or a lock, counts as part of that write unless the retry completes that same staged state and does not create it again. Staged state that is present twice after one retry was created again. `held` means that no backend request changed the declared state before the result was returned, or that the only change was staged state that the retry completed. The black-box test sees only the state it reads, so an unchanged state, or staged state that the retry completed, is `not observed` (section 8.2, rule 8).

**Known limitations.** The black-box test sees only the state it reads. The cases tested are those the declaration can bring about. Whether staged state is part of the write is decided by what the retry does with it, so the verdict on the first call depends on the retry.

**Guidance.** A tool that collects the missing input first and writes afterwards meets the requirement. So does a tool that stages a draft and commits that same draft on the retry, which is the two-stage pattern the CoSAI guide describes ([section 11.7](#117-relationship-to-other-work)). A tester records staged state as an observation. The [Multi Round-Trip Requests page][mcp-mrtr] says: "Servers **MUST NOT** assume that clients will fulfill the `inputRequests` or retry the original request." Staged state should therefore expire, and the tool's description should say what is left behind if the client does not retry.

### 9.7 IN: inputs

Arguments come from a model. A server that guesses what a malformed argument meant, or silently drops it, turns a mistake into a write nobody asked for, or into a success that changed nothing.

The requirements in this area apply to every tool, because the same handling serves read and write tools. A tester probes read tools freely and probes write tools only against objects it created.

#### MWS-IN-1

- **Level:** MUST
- **Status:** draft, since 0.9
- **Applies when:** the server offers a tool whose input schema declares a type for an argument.

> **Requirement.** A tool MUST NOT coerce an argument to a value whose meaning differs from the value the caller sent.

**Rationale.** [X1][reg-posthog] ([article][posthog]): generated schemas read the string `"false"` as true and `null` as 0 (upstream [pull request 131514][ph-pr-131514]). [K8S-09][reg-kubernetes] ([article][kubernetes]): wrongly typed values for two arguments were dropped silently. In each case the tool acted on a value the caller did not send. A related upstream report by others, [issue 1584][k8s-1584], is a fraction truncated to an integer.

**Evidence.** `observed` (2 servers).

**Test method.** black-box. For each typed argument, send each probe in the list below that is of another type than the schema declares. Probe list, version 1. For a boolean: `"false"`, `"true"`, `"yes"`, `0`, `1`, `null`. For a number or an integer: `"5"`, `"abc"`, `""`, `null`, `true`; and for an integer also `0.5`. For a string: `5`, `true`, `null`. For any scalar: `{"a": 1}` and `[1]`. A probe is skipped where the schema declares that type for the argument, for example `null` for an argument typed `["number", "null"]`. A probe is sent only where the arguments, with the probe in them, do not validate against the tool's whole input schema. Revision `2026-07-28` allows composition and conditional keywords in an input schema, and a constraint inside a branch that does not apply is not broken by a value that another branch accepts. Each probe is sent in a call that is otherwise valid: its other arguments are those of a base call, with valid values, that the tester has made through the tool and that succeeded, and the objects they name exist when the probe is sent. For a create, the probe uses a name not yet in use; an identifier is replaced by that of an object created for the probe. Where no base call succeeds, no probe is sent and the verdict is `not tested`. An error answer after which the base call, sent again at once, does not succeed, such as one caused by a duplicate name, shows that the call was not otherwise valid. The probe is sent again in a call that is otherwise valid; where that cannot be done, the probe is not judged, as MWS-IN-4 says for a control that cannot be sent. Whether an error answer to a probe is a rejection is decided as MWS-IN-4 says. For each probe that was accepted, establish the value the tool used, from the result and, for a write tool, by reading the object back.

A conversion keeps the meaning in these cases only: a string that is exactly a JSON number used as that number; the strings `"true"` and `"false"` used as true and false; a number or a boolean used as its JSON text for a string argument; `null` sent for an argument that the schema does not require and treated as if the argument had not been sent. A conversion changes the meaning in these cases: `"false"` used as true; `null` or `""` used as a number, as false or as an empty value, except where `null` was treated as not sent under the case above; `null` sent for a required argument and replaced by a default; a string that is not a number used as a number; a fraction rounded or truncated to an integer; an object or a list flattened to a string; a value other than `null` that was dropped. Any other accepted conversion, such as `1` used as true or `"yes"` used as true, is recorded as an observation and is not `violated`.

**Verdicts.** `violated` (a probe was accepted and the value used differs in meaning from the value sent, by the cases the test method lists), `held` (no accepted probe changed the meaning by those cases; a conversion recorded as an observation does not prevent `held`). Where the value used for an accepted probe cannot be established and no other probe shows a change of meaning, the verdict is `not tested`, and the record names the probe.

**Known limitations.** The probes are a fixed list and not every possible wrong value. The record states the version of the probe list. A conversion that keeps the meaning is judged by MWS-IN-6.

#### MWS-IN-2

- **Level:** MUST
- **Status:** draft, since 0.9
- **Applies when:** the server offers a tool whose input schema does not explicitly allow additional properties at the level probed.

> **Requirement.** A tool MUST NOT silently drop an argument that its input schema does not define.

**Rationale.** [GH-06][reg-github] ([article][github]): misspelled or unknown parameters were dropped and success was returned (upstream [issue 3759][gh-3759]). [PAY-11][reg-payload] ([article][payload]): argument names the advertised schema forbids were stripped without a word, and an update with only a misspelled argument answered success and changed nothing (present in release 3.93.0, the current stable release; the article reads the source of the 4.0 beta line as no longer having it, and did not run it). [K8S-09][reg-kubernetes] ([article][kubernetes]): the article notes ignored unknown arguments as a design gap. JSON Schema by itself permits properties that a schema does not mention unless `additionalProperties` is false. This requirement asks for more than that, because an argument a model misspells and a server drops becomes a success that did not do what was asked.

**Evidence.** `observed` (3 servers; one case is classed by its article as a design gap).

**Test method.** black-box. Make two calls that are otherwise valid, as MWS-IN-1 says (after a base call that succeeded): one with an extra argument whose name is a misspelling of a real one, and one with an extra argument whose name is unrelated. For a tool that has no argument, only the unrelated probe is sent. The record states the name and the value of each extra argument sent. For a write tool, read the object back. Where the call was accepted, check whether the content of the result contains the name of the extra argument and says that it was not used. The record quotes the text relied on. For a write tool, the read-back shows whether the extra argument had an effect. On a tool that deletes or bulk-updates, both probes are subject to the rules of section 7.3.

**Verdicts.** `violated` (for either probe, the call was accepted, the content of the result does not both name the argument and say that it was not used, and the read-back does not show that the argument had an effect), `held` (for every probe that is judged here, the call was rejected, or the content of the result names the argument and says that it was not used). A probe whose argument had an effect was not dropped. It is not judged here: the verdict is decided on the other probe, and where both probes had an effect the verdict is `not tested`, with that reason. The probe is recorded as an observation and under MWS-IN-7.

**Known limitations.** Only top-level arguments and the nested levels the declaration names are probed. Whether the tool rejects such an argument is judged by MWS-IN-7. For a read tool there is no read-back, so an extra argument that changed the result cannot be told from one that was dropped.

**Guidance.** A schema should declare `additionalProperties: false` wherever the tool rejects undefined arguments (MWS-IN-7), so that a client that checks a call against the schema sees the same rule.

#### MWS-IN-3

- **Level:** MUST
- **Status:** draft, since 0.9
- **Applies when:** the server offers a tool whose input schema declares a constraint with one of these keywords: `required`, `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`, `minLength`, `maxLength`, `pattern`, `minItems`, `maxItems`, `uniqueItems`, `minProperties`, `maxProperties`, `enum` or `const`.

> **Requirement.** A tool MUST reject a call that breaks a constraint its input schema declares with a keyword listed in the applicability condition.

**Rationale.** [GH-12][reg-github] ([article][github]): advertised page bounds were not enforced on four tools, and out-of-range values were forwarded to the backend (upstream [issue 3762][gh-3762]). [GF-18][reg-grafana] ([article][grafana]): advertised minimum bounds were not enforced (found by code reading only; proposed fix: upstream [pull request 1521][gf-pr-1521]).

**Evidence.** `observed` (1 server; the case is the paging arguments of four read tools, and no cited case shows a write tool accepting a value outside a declared bound); `read` (1 server; the article classes that case as hardening).

**Test method.** black-box. For each declared numeric or length bound, send a value just outside it and a value far outside it, including very large and negative numbers. For each `multipleOf`, send a value that is not a multiple. For each pattern, send a value that does not match. For each enumeration, send a value that is not a member. For each `const`, send a different value. For each `required` argument, send a call without it. For each `uniqueItems`, send a list with a repeated item. For each limit on the number of items or properties, send one more than the maximum and one fewer than the minimum. Constraints are probed at the top level and at the nested levels the declaration names. A probe is sent only where the arguments, with the probe in them, do not validate against the tool's whole input schema. Revision `2026-07-28` allows composition and conditional keywords in an input schema, and a constraint inside a branch that does not apply is not broken by a value that another branch accepts. Each probe is sent in a call that is otherwise valid, after a base call that succeeded, as MWS-IN-1 says. Where a probe was accepted, read back the value the tool used or stored. A refusal that comes from the backend and is passed on counts as a rejection. An error answer that is not a rejection in the sense of MWS-IN-4 is not judged here, and the record says so. The `format` keyword is not in the list and is not probed, because JSON Schema treats it as an annotation by default ([JSON Schema Validation][json-schema-validation], section 7).

**Verdicts.** `violated` (a call that breaks a declared constraint succeeded, including a call whose value was silently clamped or truncated to fit), `held` (every probe was refused, by the server or by the backend).

**Known limitations.** The test cannot tell which layer refused. The form of the refusal is judged by MWS-IN-4.

**Guidance.** MWS-IN-5 asks that the schema declare the constraints the server or its backend enforces.

#### MWS-IN-4

- **Level:** MUST
- **Status:** draft, since 0.9
- **Applies when:** the server offers a tool that can refuse an argument.

> **Requirement.** A tool MUST report an input validation failure as a tool execution error (`isError: true`) that names the argument at fault and the reason it was refused.

**Rationale.** [GH-13][reg-github] ([article][github]): an out-of-range value returned a raw decode error with internal type names (upstream [issue 3762][gh-3762]). [PAY-13][reg-payload] ([article][payload]): a validation refusal named the field but dropped the reason the REST API gives, with no `isError` (present in release 3.93.0, the current stable release; the article reads the source of the 4.0 beta line as no longer having it, and did not run it). The value refused in PAY-13 was valid by the schema; the case was found by hand and is outside the 0.9 test of this requirement (Known limitations). Both MCP revisions list input validation errors among tool execution errors ([section 11.2](#112-clauses-mws-builds-on)).

**Evidence.** `observed` (2 servers; one case is classed by its article as cosmetic).

**Test method.** black-box. Using the rejected probes of MWS-IN-1 to MWS-IN-3, check that each rejection has `isError: true` and that its content contains the name of the argument that was probed. Each of those probes was sent in a call that is otherwise valid, after a base call that succeeded (MWS-IN-1). A rejection is an error answer that the probed value caused, whether the server refused the value or passed on the backend's refusal of it, unless the tool used the value in a way that MWS-IN-1 lists as keeping the meaning. The tester decides this with two controls and does not read the error's text. First, the base call is sent again at once with its valid value; where it does not succeed, the call was not otherwise valid, and the probe is sent again as MWS-IN-1 says. Second, where the probe has a counterpart of the declared type with the same meaning by MWS-IN-1 (the number for a string that is exactly a JSON number, true or false for `"true"` or `"false"`, the JSON text of a number or a boolean sent for a string argument, and the call without the argument for `null` sent for an argument the schema does not require), the call with the counterpart is sent, subject to the conditions below. Where its answer is the same as the probe's, apart from the value's own text and any part that differed between two sends of the probe, the error follows from that use: the probe was accepted, the answer is not a rejection, and MWS-IN-1 and MWS-IN-6 judge it. Any other error answer that the first control shows the probed value caused is a rejection, including one that follows a conversion that changes the meaning or a value passed on to the backend, because MWS-IN-1 and MWS-IN-3 required the tool to refuse that value. On a tool that writes an object that exists before the call, a counterpart that sends the probed argument with a value other than the one the base call sent for it, or sends it where the base call did not, or, on a tool whose declared mode or platform operation replaces or applies the whole object, leaves out an argument that the base call sent, can change state that the base call, sent again, would not. Such a counterpart is sent only to a tool that updates one object named by its identifier, and only where the operator's declaration lists the argument among those that the tester may send through that tool and put back ([Annex E](#annex-e-informative-the-declaration)). The declaration is what vouches that the change can be undone; the tester does not infer it. Before the probe, the tester reads the object under test. After the counterpart call, it puts the object back to that state, through the same tool or the tool that the declaration names for the purpose, with the base call's other arguments and scope, and reads the object back, leaving out the server-managed fields that the declaration names. The probe is judged only where that read-back shows the object as it was before the probe. Where the argument is not listed, or the tool deletes or acts on more than one object, the counterpart is not sent. Where the read-back does not or cannot show the object as it was, or the call that puts it back fails or its outcome is not known, the record says so and names the object and the argument for clean-up, and the probe is not judged, as is said below for a control that cannot be sent. For the rest of the run the tester then sends no further probe or control to that tool and uses that object in no later test, and each probe not sent for this reason is treated in the same way. Where a control cannot be sent or gives no answer, the probe is not judged under this requirement, nor under MWS-IN-1, MWS-IN-6 or MWS-IN-7, and the record says so and quotes the error; a record with such a probe is never `held`, and is `violated` where another probe gives that, and otherwise `not tested`. MWS-IN-6 and MWS-IN-7 use the same reading of a rejection. Whether the content gives the reason is review-only: read the captured content and answer. A rejection that the MCP specification itself requires or defines as a JSON-RPC error is not judged by this requirement. In both revisions that is a request that does not satisfy the `tools/call` request schema. In revision `2026-07-28` it is also a request without the required `_meta` fields, a header that does not match the body, an unsupported protocol version and a missing client capability. A probe that cannot be sent as a conforming request, such as an object or a list for a parameter that the transport mirrors into a header, is not sent, and the record says so.

**Verdicts.** `violated` (a rejection without `isError: true`, or one that does not name the argument), `held` (at least one rejection was examined, and every rejection examined has `isError: true` and names the argument; the record says that only the rejections of probes that are invalid by the schema were examined), `self-attested` (the reason).

**Known limitations.** The rejections examined are those of the probes of MWS-IN-1 to MWS-IN-3, all of which are invalid by the schema. A refusal of a value that is valid by the schema is not examined here. Where the call was a write, its `isError` is judged by MWS-RES-2; whether it names the argument and the reason is not judged in 0.9.

**Guidance.** An error that exposes runtime internals, such as a stack trace or internal type names, does not help the caller correct the call and is best avoided.

#### MWS-IN-5

- **Level:** SHOULD
- **Status:** draft, since 0.9
- **Applies when:** the server offers a tool, and the server or its backend enforces a fixed constraint on the value of one of the tool's arguments that the keywords listed in MWS-IN-3 can express.

> **Requirement.** A tool's input schema SHOULD declare, with the keywords listed in MWS-IN-3, each fixed constraint on the value of a single argument that the server or its backend enforces.

**Rationale.** [PAY-12][reg-payload] ([article][payload]): schemas omitted the fields' limits, so values valid by the schema were refused; the article classes this as a design gap. A schema that declares the constraints saves the caller a refused call.

**Evidence.** `observed` (1 server, classed by its article as a design gap).

**Test method.** black-box. Over the whole test run, note each call whose arguments were valid by the tool's input schema and that was refused because of the value of an argument. The declaration may list further values to try. For each such refusal, check whether the schema declares the constraint that the refusal names. Only a fixed constraint on the value of one argument counts. A refusal that depends on another argument, on the state of the backend (such as a duplicate name or a missing permission), on the caller's identity or on settings that differ between tenants does not. A call was refused when its result is a tool execution error or a JSON-RPC error. For a value the declaration lists, a result without `isError: true` after which the value is not stored also counts as refused; its form is judged by MWS-RES-2. Whether a refusal rests on a fixed constraint is stated by the declaration, or by a person's reading recorded with the result in the way [section 7.3](#7-test-methods), rule 11, records a reading; the record says which, and who gave the reading.

**Verdicts.** `violated` (a value valid by the schema was refused under a fixed constraint on the value of that argument that the schema does not declare, and the declaration, or a person's reading recorded with the result, states that the constraint is fixed), `not observed`. A refusal that neither the declaration nor a recorded reading states to rest on a fixed constraint gives no `violated`: where no refusal gives `violated`, the verdict is `not observed`, and the record lists each such refusal with its text quoted in full, marked "seen, not judged".

**Known limitations.** This is a search. A tester finds an undeclared constraint only by sending a value that breaks it (section 8.2, rule 8).

#### MWS-IN-6

- **Level:** SHOULD
- **Status:** draft, since 0.9
- **Applies when:** the server offers a tool whose input schema declares a type for an argument.

> **Requirement.** A tool SHOULD reject an argument whose value is not of a type its input schema declares for that argument, rather than convert or drop it.

**Rationale.** [X1][reg-posthog] ([article][posthog]) and [K8S-09][reg-kubernetes] ([article][kubernetes]), cited under MWS-IN-1, both began with a wrongly typed value that was accepted. A tool that rejects such a value cannot convert it wrongly, and the caller learns of its mistake.

**Evidence.** `observed` (2 servers).

**Test method.** black-box, with the probes of MWS-IN-1. Record whether each probe was rejected.

**Verdicts.** `violated` (a probe was accepted), `held` (every probe was rejected).

**Known limitations.** The probes are a fixed list and not every possible wrong value. A probe that changed the meaning gives a record here and under MWS-IN-1. Some SDKs and validation libraries convert such values by default. The verdict is the same wherever the conversion happens, and the record may name the library. A maintainer may state this as the reason (section 8.2, rule 12).

#### MWS-IN-7

- **Level:** SHOULD
- **Status:** draft, since 0.9
- **Applies when:** the server offers a tool whose input schema does not explicitly allow additional properties at the level probed.

> **Requirement.** A tool SHOULD reject an argument that its input schema does not define.

**Rationale.** [GH-06][reg-github] ([article][github]) and [PAY-11][reg-payload] ([article][payload]), cited under MWS-IN-2, are arguments that were dropped without a word. A tool that rejects such an argument cannot drop it, and the caller learns of its mistake at once. This is a SHOULD because some widely used validation libraries ignore or strip unknown properties by default, and because a result that names the ignored argument already tells the caller.

**Evidence.** `observed` (2 servers; both cases are cited under MWS-IN-2).

**Test method.** black-box, with the probes of MWS-IN-2. Record whether each probe was rejected.

**Verdicts.** `violated` (a probe was accepted), `held` (every probe was rejected).

**Known limitations.** As for MWS-IN-2. A probe that was dropped silently gives a record here and under MWS-IN-2. Some SDKs and validation libraries ignore unknown properties by default, and a maintainer may state this as the reason (section 8.2, rule 12).

### 9.8 CFG: safety settings

Operators and callers rely on a read-only mode or a tool filter to keep an agent from writing. A setting that is misread leaves writes on without anyone noticing.

#### MWS-CFG-1

- **Level:** MUST
- **Status:** draft, since 0.9
- **Applies when:** the server has a read-only mode or another setting, applied at start or with a request, whose purpose is to restrict writes.

> **Requirement.** A server MUST NOT accept a write when a read-only or other write-restricting setting, applied at start or with a request, has a value it does not recognize.

**Rationale.** [GH-08][reg-github] ([article][github]): a read-only environment variable (and a second safety setting parsed the same way) was parsed so that values such as `yes`, `on` or a typo left the mode off, visible only in one start-up log line, while the equivalent command-line flag rejected such values (upstream [issue 3747][gh-3747]).

**Evidence.** `observed` (1 server).

**Test method.** black-box (launch). Start the server with the setting given each of the values below; where the setting is applied with a request, send it with a `tools/list` request and with a call to each declared write tool instead, whether or not `tools/list` was refused or offered the tool. The values are: `yes`, `on`, `enabled`, `1`, `TRUE`, and a misspelling of a value the declaration lists as valid. A probe that the declaration lists as a valid value that permits writes is not sent. A probe that the declaration lists as a valid value that restricts writes is sent. Where every declared write tool accepted a write under it, the server did not recognize the value, and that is judged here. Where some refused and others accepted, the server recognized the value; the accepted write is judged by MWS-CFG-3 and is recorded here as an observation. An empty value is tried only if the declaration says that the server distinguishes empty from unset. For each value, record whether the server started or answered. Unless it did not start, record whether a declared write tool is offered and accepts a call against an object the tester created. A call is accepted when the read-back shows its write. Where the setting is applied at start and the tester cannot start the server, the verdict is `not tested`.

**Verdicts.** `violated` (for some value, a write was accepted, other than a write that the test method leaves to MWS-CFG-3), `held` (for every value, the server did not start, refused the request, or refused writes; where the setting is applied with a request, every call that carried it was refused or had no effect).

**Known limitations.** The values tried are a fixed list. The test cannot tell a value the server recognized from one it did not recognize and treated as restrictive; both are `held`. A scope or a permission of the caller's credential is not a setting in this sense. Nor is a list of tools, which is judged by MWS-CFG-2 and MWS-CFG-4.

**Guidance.** Refusing to start, or refusing the request, is the recommended behavior for an unrecognized value, because it tells the operator or the caller about the mistake.

#### MWS-CFG-2

- **Level:** MUST
- **Status:** draft, since 0.9
- **Applies when:** the server has a setting, applied at start or with a request, that denies tools by name.

> **Requirement.** A server MUST refuse to start, refuse to serve the request that carries the list, or disable every write tool, when a tool deny-list contains a name that is not the name of a tool the server defines.

**Rationale.** [GH-10][reg-github] ([article][github]): configuration typos were handled inconsistently, and misspelled entries in an exclusion list were silent (upstream [issue 3761][gh-3761]). [K8S-14][reg-kubernetes] ([article][kubernetes]): misspelled names in the enabled and disabled tool lists were accepted silently (upstream [issue 1668][k8s-1668]). A misspelled entry in a deny-list leaves the tool it was meant to disable switched on, and nothing tells the operator. A tool that the server defines and that another setting switches off is not an unknown name. A tool that a later version renames becomes one, and the server then stops, refuses the request or serves without its write tools, until the list is corrected. That is the intended direction: the operator learns that the entry no longer denies anything. Neither upstream report behind this requirement insisted on a refusal: one asked that an unknown name be at least logged and said that an error would match the server's allow-list, and the other asked for a failed start and then left the choice between an error and a warning to the maintainers. This requirement asks for more, because a log line reaches neither the caller nor an operator who is not reading the log.

**Evidence.** `observed` (2 servers; both cases are classed by their articles as usability).

**Test method.** black-box (launch). Start the server with a deny-list that contains one misspelled tool name; where the deny-list is applied with a request, send it with a `tools/list` request and with a call to each declared write tool instead, whether or not `tools/list` was refused or offered the tool. Record whether the server returned a result to a `tools/list` request. Unless it did not start, record whether a declared write tool is offered and accepts a call against an object the tester created. A call is accepted when the read-back shows its write. Where the declaration names a tool that the server defines and that is switched off in the tested configuration, repeat with that name in the deny-list as well; a server that refuses for that name is recorded as an observation.

**Verdicts.** `violated` (a write was accepted), `held` (the server refused to start or refused the request, or every declared write tool was absent, refused the call or had no effect).

**Known limitations.** Lists of groups of tools, as opposed to tool names, are tested only if the declaration names them. Where the list is applied with a request, "disable every write tool" means for the requests that carry the list.

#### MWS-CFG-3

- **Level:** MUST
- **Status:** draft, since 0.9
- **Applies when:** the server has a read-only mode.

> **Requirement.** In read-only mode a server MUST refuse every call to a write tool, whatever that tool's annotations declare.

**Rationale.** [R6][reg-posthog] ([article][posthog]): read-only mode was decided by an annotation that some tools set loosely (found by code reading, not called live; the article classes this as a design gap).

**Evidence.** `read` (1 server).

**Test method.** black-box (launch). Start the server in read-only mode, or send the mode with each request where it is applied that way. For each write tool in the declaration, whether or not it is listed and whatever its annotations say, call it against an object the tester created before the mode was applied, and read the object back. A create tool is called with the arguments for a new object, and the tester reads back whether the object exists. Where the mode is applied at start, the objects are created before the server is started in the mode, through the server started without it or through the platform API.

**Verdicts.** `violated` (a write took effect), `held` (every declared write tool was absent or refused, and no object changed).

**Known limitations.** Only the write tools the declaration names are called. A write tool the tester does not know to be one is not tested.

#### MWS-CFG-4

- **Level:** SHOULD
- **Status:** draft, since 0.9
- **Applies when:** the server has a setting, applied at start or with a request, that allows tools by name.

> **Requirement.** A server SHOULD refuse to start, or refuse to serve the request that carries the list, when a tool allow-list contains a name that is not the name of a tool the server defines.

**Rationale.** [K8S-14][reg-kubernetes] ([article][kubernetes]): misspelled names in the enabled and disabled tool lists were accepted silently (upstream [issue 1668][k8s-1668]). A misspelled entry in an allow-list leaves a tool switched off. That is the safe direction, which is why this is a SHOULD, but the operator still does not get the server that was configured.

**Evidence.** `observed` (1 server; classed by its article as usability).

**Test method.** black-box (launch). Start the server with an allow-list that contains one valid tool name and one misspelled tool name; where the allow-list is applied with a request, send it with the request instead. Record whether the server returned a result, and not an error, to a `tools/list` request made with the list set.

**Verdicts.** `violated` (the server returned a result to a `tools/list` request made with the list set), `held` (the server refused to start, or refused the request). An error from `tools/list` that the server gives because no tool is enabled is not a refusal of the list; the verdict is then `not tested`, with that reason.

**Known limitations.** Lists of groups of tools, as opposed to tool names, are tested only if the declaration names them.

### 9.9 ANN: annotations

Tool annotations are hints. Clients use them to decide when to ask a person for confirmation, and some servers use them to decide which tools a restricted mode offers. The MCP schema's defaults are the cautious values (`readOnlyHint` false, `destructiveHint` true, `idempotentHint` false, `openWorldHint` true), so only an explicit claim in the optimistic direction can be wrong. The wording of each hint is quoted in [section 11.3](#113-tool-annotations).

#### MWS-ANN-1

- **Level:** MUST
- **Status:** draft, since 0.9
- **Applies when:** the server offers a tool that declares `readOnlyHint: true`.

> **Requirement.** A tool that declares `readOnlyHint: true` MUST NOT change state.

**Rationale.** The schema text for the hint: "If true, the tool does not modify its environment." No published finding among those cited shows a tool that declared `readOnlyHint: true` and changed state; this requirement rests on the schema text. An independent report by others, [issue 4721][mcp-servers-4721] in the MCP reference servers repository (since closed as completed), says that a reference server declared `readOnlyHint: true` and `idempotentHint: true` on a tool that keeps state between calls; the steward has not reproduced it. [R6][reg-posthog] ([article][posthog]) shows why the claim matters: read-only mode was decided by a hint that some tools set loosely; the article classes this as a design gap.

**Evidence.** `derived`.

**Test method.** black-box. Read the declared objects and any untouched-state objects the declaration names. Call the tool with valid arguments. Read the same objects again and compare. A tool that the declaration lists as a write tool and that declares `readOnlyHint: true` is `violated` as soon as one of its writes is observed.

**Verdicts.** `violated`, `not observed`.

**Known limitations.** A tester sees only the state it reads. A change elsewhere is not seen (section 8.2, rule 8).

#### MWS-ANN-2

- **Level:** MUST
- **Status:** draft, since 0.9
- **Applies when:** the server offers a tool that declares `destructiveHint: false` and does not declare `readOnlyHint: true`.

> **Requirement.** A tool that declares `destructiveHint: false` MUST NOT delete an object, and MUST NOT remove or replace data that the caller's arguments did not name.

**Rationale.** [K8S-02][reg-kubernetes] ([article][kubernetes]): a tool annotated non-destructive force-applied over an existing object with the same port in 3 of 3 trials, replacing parts of it (upstream [issue 1662][k8s-1662]). This requirement holds under every reading of the schema text, "If false, the tool performs only additive updates". The strict reading of that text is the subject of MWS-ANN-5.

**Evidence.** `observed` (1 server; the steward's follow-up on the upstream issue leaves the annotation and the behavior on an existing object to the maintainers as a design decision).

**Test method.** black-box. Create an object with known values. Call the tool so that it acts on that object or on an object of the same name. Read back and establish whether the object was deleted, and whether any value was removed or replaced that the call's arguments did not name. The arguments name a field when the call passes a value for that field, and name an element or a key when the call passes that element's or key's identifier. Replacing the whole value of a field that the call passed, such as a list of labels passed whole, is not a violation of this requirement and is judged by MWS-ANN-5. Clearing or replacing a field that the call did not pass is a violation, including a field left out of a whole object that the call passed. Where the caller did not identify an existing object as the target of a change, every value of an existing object that the call replaced counts as not named. Where a tool has more than one operation or mode, each one the declaration lists is called.

**Verdicts.** `violated`, `not observed`.

**Known limitations.** As for MWS-ANN-1.

#### MWS-ANN-3

- **Level:** MUST
- **Status:** draft, since 0.9
- **Applies when:** the server offers a tool that declares `idempotentHint: true` and does not declare `readOnlyHint: true`.

> **Requirement.** A tool that declares `idempotentHint: true` MUST have no further effect when it is called again with the same arguments.

**Rationale.** [K8S-12][reg-kubernetes] ([article][kubernetes]): a clone tool annotated idempotent created a new clone on every call, in 3 of 3 trials (upstream [issue 1670][k8s-1670]).

**Evidence.** `observed` (1 server).

**Test method.** black-box. Call the tool. Read the declared state and count the objects. Call the tool again with the same arguments. Read and count again, and compare, ignoring the server-managed fields the declaration names.

**Verdicts.** `violated`, `not observed`.

**Known limitations.** As for MWS-ANN-1.

#### MWS-ANN-4

- **Level:** SHOULD
- **Status:** draft, since 0.9
- **Applies when:** the server offers a tool.

> **Requirement.** A server SHOULD declare `readOnlyHint` explicitly on every tool and `destructiveHint` explicitly on every tool that does not declare `readOnlyHint: true`.

**Rationale.** [PAY-08][reg-payload] ([article][payload]): 0 of 12 tools carried annotations on the 3.x release line, which is the current stable release (annotations are present on the 4.0 beta line; raised as a question about the 3.x line in upstream [issue 19591][pay-19591]).

**Evidence.** `observed` (1 server).

**Test method.** black-box. Read the catalog and list each tool that omits `readOnlyHint`, and each tool that does not declare `readOnlyHint: true` and omits `destructiveHint`. The declaration's list of write tools is not used: both clauses are decided from the catalog alone.

**Verdicts.** `violated` (a hint is missing), `held`.

**Known limitations.** The catalog check finds missing declarations, not wrong ones. Wrong ones are the subject of MWS-ANN-1 to MWS-ANN-3 and MWS-ANN-5. A write tool that wrongly declares `readOnlyHint: true` is not asked for `destructiveHint` here; the false claim is judged by MWS-ANN-1, which a check of the catalog alone cannot run.

**Guidance.** The MCP schema says of `openWorldHint`: "If true, this tool may interact with an 'open world' of external entities. If false, the tool's domain of interaction is closed." A tool that declares `openWorldHint: false` is best checked against that text. [GF-11][reg-grafana] ([article][grafana]): a snapshot-creating tool declared `openWorldHint: false`; the article records that this was corrected upstream.

#### MWS-ANN-5

- **Level:** SHOULD
- **Status:** draft, since 0.9; at risk ([section 6](#6-structure-of-a-requirement))
- **Applies when:** the server offers a tool that declares `destructiveHint: false` and does not declare `readOnlyHint: true`.

> **Requirement.** A tool that declares `destructiveHint: false` SHOULD perform only additive updates, as the MCP schema states.

**Rationale.** [GH-07][reg-github] ([article][github]): a feature-flagged tool that replaces an issue's labels was annotated `destructiveHint: false` (upstream [issue 3760][gh-3760]). The schema text for the hint: "If false, the tool performs only additive updates."

**Evidence.** `observed` (1 server).

**Test method.** black-box. Create an object with known values. Call the tool so that it acts on that object or on an object of the same name. Read back and establish whether any value that existed before the call was changed or removed.

**Verdicts.** `violated`, `not observed`.

**Known limitations.** As for MWS-ANN-1. This requirement follows the strict reading of the schema text; see [section 11.3](#113-tool-annotations) for the open question about that text. It is marked at risk: it may be reworded or withdrawn when the MCP specification clarifies, and raising its level needs a comment period. Under the strict reading no tool that edits an existing value can declare the hint false, so the hint no longer separates an edit from a deletion. That cost is part of the open question.

### 9.10 SEC: credentials in results

Whatever a tool returns enters the model's context, and from there it can reach logs, transcripts and other tools.

#### MWS-SEC-1

- **Level:** MUST
- **Status:** draft, since 0.9
- **Applies when:** the server offers a tool, for every credential other than a credential that the tool exists to issue and the caller asked for.

> **Requirement.** A tool result, whether it reports success or an error, MUST NOT contain a credential, including a token, a secret, or a URL that carries a token or a signature.

**Rationale.** [GH-09][reg-github] ([article][github]): directory listings put tokenized download URLs for a private repository into the model's context. The register records the source as the platform API's response, passed on by the server (upstream [issue 3748][gh-3748]).

**Evidence.** `observed` (1 server; the article classes the finding as hardening, and the credential came from the platform API's response. The upstream report calls it a low-severity hardening suggestion and not a vulnerability report).

**Test method.** black-box. Scan every result captured during the whole test run, successes and errors alike, for the values of every credential the server was started with, for canary values the declaration names, and for URLs whose query carries a parameter that the declaration names as a token or a signature. A canary is placed in a credential store or a credential-typed field of the backend, never in ordinary content that a caller stored. A match on a general credential pattern that is none of these ([Annex D](#annex-d-informative-credential-patterns)) is listed for a person to examine and is not by itself `violated`. The declaration lists the tools that exist to issue a credential (NF-16). A credential the server itself uses to reach its backend is never excepted, whatever the tool's purpose.

**Verdicts.** `violated`, `not observed`. The verdict `platform` is not available: what a server passes on from its backend is under the server's control.

**Known limitations.** This is a search and can never show that no credential is returned (section 8.2, rule 8). A signed link that a tool returns in place of content it cannot return inline is `violated` in 0.9 unless the declaration lists the tool under NF-16. Whether a described, time-limited link to the content the caller asked for should be excepted is open for comment. Whether a secret inside ordinary content that a caller stored, returned by a read tool, is within this requirement is also open for comment; the test places no canary there (NF-25).

## 10. Non-findings

This section is normative for testers. Each item is a behavior that a test MUST NOT give the verdict `violated` under the requirements its treatment column excludes. The correct verdict, where there is one, is stated. Each item names the published case or the text that motivates it.

| ID | Behavior | Correct treatment | Published case |
|---|---|---|---|
| NF-1 | For a requirement whose entry lists `platform`, the platform API shows the same behavior as the server in a control arm. | `platform`. | [C1][reg-posthog] ([article][posthog]) (the loss occurred in the platform API, not the MCP layer); [PAY-10][reg-payload] ([article][payload]) (classed as platform behavior, not an MCP finding; not yet reported upstream). |
| NF-2 | A tool declares the cautious value of a hint, or omits a hint so that the cautious default applies, although its behavior is safer than the hint says. | Not a violation of MWS-ANN-1 to MWS-ANN-3 or MWS-ANN-5. Omission is reported only under MWS-ANN-4. | The schema defaults quoted in [section 11.3](#113-tool-annotations). |
| NF-3 | A tool refuses a write because the caller did not send a version that the tool's contract requires. | The refusal itself is not a violation of MWS-RES-1; its form is judged by MWS-IN-4. The refusal is the behavior MWS-CONC-2 asks for. | The [Grafana article][grafana-held] records a refuted candidate of this kind: an upsert that requires a version field by contract. |
| NF-4 | A field omitted from an update keeps its stored value, including a secret that the backend never returns. | Not a violation of MWS-UPD-1 or MWS-RES-1. A field the read tool does not return is not compared (MWS-UPD-1, Known limitations). | The [Grafana article][grafana-held] records a refuted candidate of this kind: an update that sends no secrets, where the backend keeps the stored secrets. |
| NF-5 | A delete or close of an object, named by its identifier, that is already absent or closed returns a non-error result. | `held` under MWS-RES-1. This item does not cover an operation on a field, key or path inside an object, or an operation whose contract requires the target to exist (for example JSON Patch `remove` and `replace`, [RFC 6902][rfc6902], sections 4.2 and 4.3). | [K8S-17][reg-kubernetes] ([article][kubernetes]) (an uninstall of a release that does not exist returns success; intended upstream and asserted by an upstream test). |
| NF-6 | An update tool in full-replace mode ([section 4](#4-terms)) stores exactly the object the caller sent, so that fields absent from that object are cleared. | `not applicable` under MWS-UPD-1. The tool is judged by MWS-CONC-2 and MWS-CONC-3. | [GF-19][reg-grafana] ([article][grafana]) concerns a full-body save and is judged as a stale write, not as a field reset. |
| NF-7 | A caller sets an explicit override or opt-in argument (to bypass a lock, to overwrite, or to match everything) and the tool does what the argument asks. | Not a violation of MWS-CONC-1, MWS-CONC-2, MWS-TGT-2 or MWS-TGT-3. | The override in [PAY-01][reg-payload] ([article][payload]), whose defect was its default and not its existence. |
| NF-8 | A tool that its name and description present as an upsert or an apply replaces an existing object. | `not applicable` under MWS-TGT-3. The tool is still subject to MWS-CONC-1, MWS-CONC-2, MWS-ANN-2 and MWS-ANN-5. | The apply tools in the [Kubernetes article][kubernetes-forced]. |
| NF-9 | Both changes survive in a simultaneous pair, or in every pair. | `not observed`, never `held` (section 8.2, rules 4 to 7). | [GH-01][reg-github] ([article][github]): a server lost a change in 19 of 30 pairs, so the pairs in which both changes survived showed nothing about the others. |
| NF-10 | The tester's call times out, or its response is cut off in transport, and no result is received. | The trial is recorded as indeterminate and excluded; if no usable trial remains, the verdict is `not tested` (section 7.3). Not a violation of MWS-RES-1 or MWS-RES-2. | The [PostHog article][posthog-held] records, as behavior that held up, a cut-off response reported as a transport error. |
| NF-11 | A read made within the declared settle interval does not yet show a write, on a backend that is eventually consistent. | The tester waits for the settle interval and reads again before deciding. | [K8S-10][reg-kubernetes] ([article][kubernetes]) shows why the interval has to be declared and bounded: a delete that never completes while a finalizer holds the object is reported, a delete that completes shortly after is not. |
| NF-12 | Writes made one after the other to different fields, with no version sent, both survive, and the server makes no version check on them. | Not a violation of any requirement in area CONC. This includes a field-patch tool whose version argument is optional, called with the version left out: the second run of MWS-CONC-2 is not made for it. A version that the caller did send and the tool did not use is judged by MWS-CONC-2. | The [Grafana article][grafana-held]: patches made one after the other lost nothing, 0 of 10 pairs. |
| NF-13 | A value that is valid by the tool's input schema is refused by the backend under a rule the schema does not advertise, and the refusal is a tool execution error that names the argument. | Not a violation of MWS-IN-3 or MWS-IN-4. The missing declaration is judged only by MWS-IN-5. | [PAY-12][reg-payload] ([article][payload]) (classed as a design gap). |
| NF-14 | Under a requirement whose entry lists `platform`, or where no requirement covers the behavior: the backend does something a caller might not expect, the platform API does the same, and the tool reports it truthfully. | `platform` where the requirement's entry lists `platform`. Where no requirement in section 9 covers the behavior, it gets no verdict; a tester may record it as an observation. This item never changes a verdict under a requirement that does not list `platform` (section 8.2, rule 2). | The [GitHub article][github] lists backend-side behaviors it noted and did not count, such as an unknown label name creating a new label. |
| NF-15 | A tool reads and writes inside one call and guards that interval with the backend's version check, but accepts no version from the caller. | `held` under MWS-CONC-1 and MWS-CONC-3 when the proxy-assisted procedures show it. MWS-CONC-2 is `not applicable` unless the tool replaces a whole object or deletes. | The [Kubernetes article][kubernetes-held] records a scale tool of this kind, and notes that the check guards the call and not an older view held by the caller. This is a known gap. The article's [addendum][kubernetes-addendum] records that in all 9 runs in which an AI agent set the count with the scale tool from an older read (7 on the released version and 2 on the steward's modified build), another writer's change was replaced with no error. No requirement in 0.9 covers that case ([section 12](#12-limitations)). |
| NF-16 | A tool that exists to issue a credential or a signed link, as its name and description say, returns the credential the caller asked for. | Not a violation of MWS-SEC-1. The declaration lists such tools. A credential the server itself uses to reach its backend is never covered by this item. | The applicability condition of MWS-SEC-1. |
| NF-17 | A field the caller never set reads back with a default that the backend supplies on read, and the value is the same in the read before the update and in the read after it. | Not a violation of MWS-UPD-1. | The test method of MWS-UPD-1, which compares the read before the call with the read after it. |
| NF-18 | A tool whose stated purpose is to delete a container (a folder, project, namespace or collection) deletes the container it was given. | Not a violation of MWS-TGT-2. | The sentence of MWS-TGT-2, which is about a selector or a path that a tool treats as selecting every object, and not about a container the caller named to a tool that exists to delete containers. |
| NF-19 | A result says that an operation was accepted or is pending, for an operation that the declaration lists as completed asynchronously by the backend, and it is. A task handle is such a result whether or not the declaration lists the operation. | Not a violation of MWS-RES-1 or MWS-RES-2. For such a result the verdict under MWS-RES-1 is `not tested` unless the state is in effect after the settle interval; for a task, the state is read after the task reaches a terminal status. A trial of MWS-RES-2 that ends in such a result, other than a task, adds no verdict to that record. For any other operation a result that says "accepted" or "pending" is read as a report of success. A result that says the change was made while it is still pending is not covered by this item and is judged by MWS-RES-1. | [K8S-10][reg-kubernetes] ([article][kubernetes]) is the contrast: a result that said "deleted successfully" while a finalizer held the object. |
| NF-20 | The backend stores a normalized form of a value (for example trimmed, case-folded or reformatted), and the platform API stores the same form. | Not a violation of MWS-RES-1 or MWS-UPD-1. The declaration names the normalized fields. The comparison uses the normalized form, and the verdict is decided as if that form had been asked for. This item covers only a stored value that denotes the same thing as the value sent. A value that denotes something else, such as a time moved to another instant, is not normalized and is compared as it is. | The comparisons in the test methods of MWS-RES-1 and MWS-UPD-1. |
| NF-21 | A tool converts a value to the type its schema declares without changing what the value denotes, such as `"5"` used as 5. | Not a violation of MWS-IN-1. The conversion is judged only by MWS-IN-6. | The test method of MWS-IN-1, which says when a conversion keeps the meaning. |
| NF-22 | Two overlapping writes each set the whole value of the same field, to different values, both report success, and one of the two values is in effect afterwards. | Not a violation of MWS-CONC-3 or MWS-RES-1. The server cannot know which order the callers intended. This item does not cover writes that add, remove or edit different elements of one list or different keys of one map; those are judged by MWS-CONC-3. It does not change a verdict under MWS-CONC-2. | The sentence of MWS-CONC-3, which is about writes to different parts of one object. |
| NF-23 | A delete moves the object to a trash or an archive from which it can be restored, and the declared read tool no longer returns it. | `held` under MWS-RES-1. | The test method of MWS-RES-1, which reads the state back through the declared read tool. |
| NF-24 | A caller repeats its own write with the version it sent the first time, the first call was applied, no other writer has changed the object since, and the tool answers with a success without applying the write a second time. | Not a violation of MWS-CONC-2 or MWS-CONC-4, and it gives no verdict under MWS-CONC-2. A conflict is also a correct answer. | [RFC 9110][rfc9110], section 13.1.1, which lets a server that does not perform the request again answer with a success when the change appears to have been applied already, for example because the first response was lost. |
| NF-25 | A read tool returns ordinary content that a caller stored, such as a ticket body or a file, and a general credential pattern matches inside it. | Not a violation of MWS-SEC-1 on that match alone. The test decides `violated` only from the exact values its method names, and it places no canary in ordinary content. The match is listed for a person to examine. | The test method of MWS-SEC-1 and [Annex D](#annex-d-informative-credential-patterns). |

A tester that reports a behavior in this list as `violated` under a requirement the item excludes has made an error. The tester owes a correction, published in the same place as the result.

## 11. Relation to the MCP specification and to other work

This section is informative. Quotations were checked against the published specification and schema on 14 November 2026.

### 11.1 Layering

MWS sits above the MCP specification. A server can implement every MCP requirement and still lose a write. MWS assumes a server that implements the MCP specification and does not test that. MWS 0.9 was checked against revisions `2025-11-25` and `2026-07-28`, and the requirements apply to both. They are about effects on backend state and about the content of tool results. [Section 11.4](#114-what-revision-2026-07-28-changes-for-write-safety) lists where revision `2026-07-28` adds a case or changes how a requirement is tested.

### 11.2 Clauses MWS builds on

The Tools pages ([2025-11-25][mcp-tools-2025], [2026-07-28][mcp-tools-2026]) and the schemas contain the following, which MWS builds on. Each item is in both revisions unless it names one.

- Under "Security Considerations", in the list headed "Servers **MUST**": "Validate all tool inputs". Area IN says what validating means for types, unknown arguments and bounds.
- Under "Error Handling": tool execution errors are reported "in tool results with `isError: true`" and include API failures, "Input validation errors (e.g., date in wrong format, value out of range)" and business logic errors, while protocol errors cover unknown tools, malformed requests and server errors. MWS-IN-4, MWS-RES-2 and MWS-CONC-4 apply this to validation failures, failed writes and conflicts. [SEP-1303][sep-1303] is the change that made input validation failures tool execution errors, and MWS-IN-4 follows it.
- The schema's comment on `isError` ([2025-11-25][mcp-schema-2025], [2026-07-28][mcp-schema-2026]): "Any errors that originate from the tool SHOULD be reported inside the result object, with `isError` set to true", while errors in finding the tool and other exceptional conditions "should be reported as an MCP error response". MWS-RES-2, MWS-CONC-4 and MWS-IN-4 raise that SHOULD to a MUST for the cases they name, and MWS-RES-2 counts a backend failure as an error that originates from the tool.
- In the same list: "Sanitize tool outputs". The MCP specification does not define the phrase. MWS-SEC-1 gives this document's reading of it for credentials.
- The `2026-07-28` Tools page, on server-minted handles, in guidance that the page marks as non-normative: the retention policy "should be stated in the creation tool's description", and a call against an expired or unknown handle "should return a tool execution error that says so". MWS-CONC-5 and MWS-CONC-4 apply the same two ideas to stale writes and conflicts.
- Under the description of a tool definition: "clients **MUST** consider tool annotations to be untrusted unless they come from trusted servers." Area ANN is the server-side counterpart: it asks that the claims be true.

### 11.3 Tool annotations

MWS adds no annotations and does not change what the existing ones mean. It does give them a status the MCP specification does not: an explicit hint is a claim, and a false claim is a violation. The `ToolAnnotations` interface is worded identically in the [2025-11-25 schema][mcp-schema-2025] and the [2026-07-28 schema][mcp-schema-2026] (quotation marks normalized in the table):

| Hint | Schema text | Default |
|---|---|---|
| `readOnlyHint` | "If true, the tool does not modify its environment." | false |
| `destructiveHint` | "If true, the tool may perform destructive updates to its environment. If false, the tool performs only additive updates." Meaningful only when `readOnlyHint` is false. | true |
| `idempotentHint` | "If true, calling the tool repeatedly with the same arguments will have no additional effect on its environment." Meaningful only when `readOnlyHint` is false. | false |
| `openWorldHint` | "If true, this tool may interact with an 'open world' of external entities. If false, the tool's domain of interaction is closed." | true |

The schema also notes that all properties of `ToolAnnotations` are hints and "are not guaranteed to provide a faithful description of tool behavior".

MWS treats each explicit hint as a claim and tests the claim against what the tool does. Because the defaults are the cautious values, MWS never treats a cautious declaration as wrong (NF-2).

The MCP blog post ["Tool Annotations as Risk Vocabulary"][mcp-ann-blog] (16 March 2026) says "Hints inform decisions; contracts enforce them", and that a proposal whose value depends on an annotation being true belongs in the authorization layer, the transport or the runtime. Area ANN does not make a hint a contract. A client still treats annotations as untrusted. Area ANN asks a server's author to publish hints that are true, and a result under it reports whether they were, for the cases tested.

**Open question on `destructiveHint`.** The schema text can be read strictly: additive updates only. Under that reading a tool that replaces existing values cannot declare the hint false, even when the replacement is what the caller asked for. MWS splits the question in two. MWS-ANN-2 is a MUST and asks only for what every reading supports: no deletion, and no removal or replacement of data that the caller's arguments did not name. MWS-ANN-5 follows the strict reading. It is a SHOULD and is marked at risk ([section 6](#6-structure-of-a-requirement)). The steward has reported annotation results from one published audit to the MCP tool annotations interest group, and has asked whether guidance for server authors should say that replacing existing values is not additive ([issue 10][mcp-ann-ig]). The issue had no reply when this version was written. The blog post cited above, which frames the group's work, advises server authors to set "`destructiveHint: false` on additive operations" and does not say what counts as additive. If the specification clarifies the meaning, MWS will follow the specification, and MWS-ANN-5 will be reworded, withdrawn or, after a comment period, raised.

**Alignment.** Area ANN follows the definitions of the hints in the MCP specification. Where the specification is silent, MWS takes account of what the MCP [Tool Annotations interest group][mcp-ann-group] publishes on how to read them. The group's output is advisory.

### 11.4 What revision 2026-07-28 changes for write safety

From the [Key Changes page of revision 2026-07-28][mcp-changelog-2026]:

- **A lost response now means a new request.** Major change 9 removes stream resumability and message redelivery from the Streamable HTTP transport: "A broken response stream loses the in-flight request; clients **MUST** re-issue it as a new request with a new request ID". The change proposal behind this removal, [SEP-2575][sep-2575], says that workloads which need durability or resumability use the tasks primitive, which lets a client fetch a result after a connection drop. Where the server returned no task, a client that wants the outcome of a call whose response was lost has to send the call again as a new request, and the protocol gives the server nothing with which to tell that request from a first attempt. The specification does not say whether a client must retry a tool call that may already have had an effect. MWS reads the change as making repeated writes routine, not as requiring them. This is the dated, external reason for area RETRY. The MUST is stated on the Key Changes page. SEP-2575 and the Streamable HTTP transport page of the same revision do not restate it, and the [stdio transport page][mcp-stdio-2026] says that, after the server process has exited, a client "can retry" in-flight requests against the fresh process. The Streamable HTTP page says that a server treats the closing of a response stream as cancellation of the request. Cancellation does not tell the client whether the first write was applied, so a re-issued write can be a second write.
- **No protocol-level sessions.** Major change 1 removes sessions; servers that need state across calls "use explicit, server-minted handles passed as ordinary tool arguments". A version or an idempotency key sent as a tool argument is consistent with that direction.
- **Multi round-trip requests.** Major change 7 introduces a pattern in which a server answers with an `input_required` result and the client retries the original request with the answers. The pattern is specified on the [Multi Round-Trip Requests page][mcp-mrtr]. A tool that writes before returning `input_required` could write again on the retry. MWS-RETRY-3 covers this case.
- **Catalog stability.** List endpoints no longer vary per connection (major change 1), and minor change 3 says: "Servers **SHOULD** return tools from `tools/list` in a deterministic order". Annex A, item A-4, measures this.

### 11.5 Idempotency keys

Neither revision's schema or Tools page defines an idempotency key for `tools/call`. A proposal to add one, [SEP-3182][sep-3182], was closed in August 2026 with the comment that it was AI-generated with no disclosure or context, and without a maintainer's review of its substance, and a proposal for a retry identity is under discussion in [issue 3394][mcp-issue-3394]. MWS is neutral about the carrier: MWS-RETRY-1 and MWS-RETRY-2 are about behavior, and the tester's declaration says whether the key is a tool argument or a `_meta` field. For HTTP APIs, the IETF HTTPAPI working group has an Internet-Draft, [The Idempotency-Key HTTP Header Field][idem-draft] (revision 09); it is a work in progress and not an RFC.

**Alignment.** Area RETRY follows the protocol's key carrier when MCP standardizes one. MWS-RETRY-2 takes its two main rules from the IETF Idempotency-Key draft: a repeat with the same key and the same payload is answered consistently with the first request, and a key reused with a different payload is an error. The draft states these at SHOULD level, for HTTP, and makes the payload check optional. MWS-RETRY-2 states them at MUST level for a tool that chooses to accept a key. The draft also says that a repeat arriving while the first request is still being processed should get an error saying that the first request is still outstanding (in HTTP, status 409), and MWS-RETRY-2 accepts that answer. What such an answer says about the first request is judged by MWS-RES-2, in its same-key trial: it says that the outcome is open, not that the write was not applied (Annex B, B-9, `in_progress`). Where a server cannot establish the outcome of a first request, MWS-RETRY-2 also accepts a repeat that applies nothing and says that the outcome is not known.

### 11.6 Protocol conformance testing

The MCP project publishes a [conformance test framework][mcp-conformance] for testing client and server implementations against the specification. It tests protocol behavior. MWS is complementary: it concerns what a tool call does to backend state. A server can reasonably be tested with both, and the results are separate.

### 11.7 Relationship to other work

MWS builds on, or sits beside, the following public work.

- **The MCP specification.** The Tools page requires servers to validate all tool inputs (section 11.2), and [SEP-1303][sep-1303] made input validation failures tool execution errors. Area IN starts from both.
- **SEP-2484.** [SEP-2484][sep-2484] (a process proposal, final) requires that, before a Standards Track proposal that changes observable protocol behavior becomes final, a conformance scenario is merged into the conformance repository with a file that maps each MUST and SHOULD to a check or to a documented exclusion. MWS aims at the same discipline one layer up: each requirement has a test method in prose, and a requirement leaves `draft` only with an executable test (section 14.4). In version 0.9 the preview test tool executes the tests of a stated subset of the requirements, and no requirement has yet left `draft`. MWS is not MCP protocol conformance, and a result under MWS says nothing about conformance to the MCP specification.
- **The official conformance suite.** The MCP project's [conformance test framework][mcp-conformance] tests the protocol behavior of clients and servers. It does not test what a tool call did to the backend (section 11.6).
- **The IETF Idempotency-Key draft.** [The Idempotency-Key HTTP Header Field][idem-draft] is an Internet-Draft of the HTTPAPI working group (revision 09, dated 21 November 2026), not an RFC. MWS-RETRY-2 takes its two main rules from it and states them at MUST level, where the draft has SHOULD (section 11.5).
- **RFC 9110.** [RFC 9110][rfc9110] defines conditional requests (`ETag`, section 8.8.3, and `If-Match`, section 13.1.1), which are the precedent for area CONC, and idempotent methods (section 9.2.2), which are the precedent for MWS-ANN-3 and for NF-5.
- **A paper on the agent-tool boundary.** ["When Tool Calls Succeed but Workflows Fail: Anomalies at the Agent-Tool Boundary"][arxiv-2609-15397] (Trofimov and Novikov, arXiv 2609.15397, 14 September 2026) gives a model of external effects and a catalog of eight anomalies, among them "Duplicated Effect" and "Missing Committed Effect". It derives the capability a tool boundary needs in order to exclude each one, names four points where black-box invocation cannot give a general guarantee, and measures the four MCP annotations across 98,291 tools in the official registry. It states the problem that areas RETRY, CONC, ATOM and RES address, its census is independent data for area ANN, and its limits on black-box testing apply to the methods in section 7. It defines capabilities and contracts, not tests for a server.
- **The CoSAI tool-design guide.** The Coalition for Secure AI's practical guide ["Tool Design for Secure Agentic Systems"][cosai-tool-design] gives advice and a checklist: classify tools as read-only, reversible or commit, preview or draft before a commit, and keep secrets out of the model's context. It is an implementation guide and defines no tests. MWS-RETRY-3 is worded so that its draft-then-commit pattern meets the requirement.
- **OWASP.** The [OWASP MCP Top 10][owasp-mcp-top10] is a list of security risks for MCP, in beta at the time of writing. Its first item, on token mismanagement and secret exposure, relates to MWS-SEC-1. Most of its other items are about attacks, access control and supply chain, which are out of scope here. The [OWASP MCP Security cheat sheet][owasp-mcp-cheatsheet] recommends strict input schemas that set `additionalProperties: false`, which relates to MWS-IN-2 and MWS-IN-7.
- **MCP issue 3394 and SEP-3182.** [Issue 3394][mcp-issue-3394] in the MCP specification repository (opened 27 September 2026) reports a reproduction, on one SDK with revision `2025-11-25`, in which an application's retry after a lost response makes a deliberately non-idempotent test tool act a second time, and a control in which an application-level key prevents it. Its author describes the behavior as permitted by the specification, asks whether the specification should say so, and proposes a conformance vector for the case. Commenters have added scans of public servers. One, a scan of declared schemas by another commenter ([results][agentsafe-scan], 9 October 2026), found no idempotency-key argument on any of the 266 tools not marked read-only in 24 servers; no tool was called in the scan. An earlier proposal, [SEP-3182][sep-3182], "Request Idempotency", would have added an `idempotencyKey` field to `tools/call` with the same rules as MWS-RETRY-2 for a repeat and for a key reused with different arguments; it was closed in August 2026 with the comment that it was AI-generated with no disclosure or context, and without a maintainer's review of its substance. This is independent public work on the problem that area RETRY addresses. MWS will align its tests with a shared fixture if one is agreed there.
- **The MCP blog on annotations.** ["Tool Annotations as Risk Vocabulary"][mcp-ann-blog] (16 March 2026) frames the interest group's work and advises server authors to set `destructiveHint: false` on additive operations (section 11.3).
- **Multi round-trip requests and tasks.** MWS-RETRY-3 is written against the [Multi Round-Trip Requests page][mcp-mrtr] of revision `2026-07-28`. A write that returns a task under the [Tasks extension][mcp-tasks] is judged on what the terminal task carries (MWS-RES-2).
- **Conditional updates for agents.** ["HTTP Profile for Conditional Updates to Shared Resource State (Agentic State Transfer)"][ast-draft] is an individual Internet-Draft (revision 02, dated 27 July 2026), not a working-group document and not an RFC. It is an HTTP profile for preventing lost updates: a missing required precondition gets status 428, and after a failed precondition a client "MUST NOT retry solely by replacing its supplied validator" with the one the response returned. It is the closest work to area CONC. It is at the HTTP level and defines no test procedures. MWS-CONC-2 addresses the same loss from the server's side, by refusing the stale write. MWS-CONC-6 addresses what the refusal tells the caller, which saves calls and, in the exploratory tests cited there, did not change whether the caller recovered, except that a current state written as unquoted prose led the caller to overwrite the other writer's change. The draft treats a validator and conflict context returned with the refusal as advisory and possibly stale.
- **Studies of agents and repeated writes.** ["Where Does Exactly-Once Live? Model, Harness, and Tool-Contract Effects on Duplicate Side Effects in LLM Agents"][arxiv-2609-29095] (Li, arXiv 2609.29095, 24 September 2026) grades 25,930 agent episodes under injected faults against a ledger of committed effects. Where an immediate read-back cannot reveal what happened, the frontier models it tested duplicated the write in 56% and 74% of episodes, and offering an idempotency key on every write lowered the duplicate rate from 28% to 4%. ["Verified Tool Calls Improve LLM Agent Reliability Under Non-Atomic Failures"][arxiv-2608-02645] (Mansoor, Phadke and Rana, arXiv 2608.02645, 31 July 2026) evaluates a wrapper on the caller's side that verifies before it retries. The first varies the tool contract as well as the caller, finds that the contract decides the cases a read-back cannot resolve, and argues for an idempotency-key argument on every non-idempotent tool, a declared read-back operation for every write, and documented bounds on visibility and in-flight time. The second is about the caller only. Both measure agents against simulated services, not shipped servers. They are outside evidence for areas RETRY and RES, and neither states requirements with tests.
- **An HTTP API profile for agents.** ["Design Considerations and Profile for HTTP APIs Consumed by AI Agents"][gaikwad-draft] is an individual Internet-Draft (revision 01, dated 30 June 2026, informational), not a working-group document and not an RFC. It gives guidance for HTTP APIs that agents call, including through tool layers such as MCP. It advises a client-supplied idempotency key, one result for each item of a batch operation, input objects that set `additionalProperties` to false, and errors that say whether a retry is safe. These overlap areas RETRY, ATOM and IN. It says its key words are guidance and not protocol requirements, and it defines no tests.
- **Agentic Commerce Protocol.** Section 6 of its [checkout specification][acp-checkout] (status Draft; the main branch as read on 15 November 2026, where the rewrite of section 6 is listed as unreleased) requires an idempotency key on every POST and refuses a key reused with a different body. It states at MUST level, for checkout sessions, rules of the kind that MWS-RETRY-2 states for tools.
- **Error formats and structured results.** [RFC 9457][rfc9457] (Problem Details), Google's [AIP-193][aip-193] and the error object of [JSON:API][jsonapi-errors] describe why a request failed. AIP-193 advises against partial errors and JSON:API forbids partial updates. None of them, nor the Agentic Commerce Protocol, states whether a write took effect or that this is not known. Annex B, B-9, takes from them what overlaps: a reader ignores, as a member of the shape, a member it does not know or whose value has the wrong form (RFC 9457, section 3), members are added and not removed (AIP-193), a stable code stands beside a message (AIP-193, JSON:API, the Agentic Commerce Protocol), and a field is named by a JSON Pointer (JSON:API). From the agent API profile draft it takes a result for each item of a batch, named by its position; from the Agentic Commerce Protocol, a marker for a replayed answer; and from the Agentic State Transfer draft, that conflict state returned with a refusal is advisory, is disclosed only as far as the caller may read it, and is not a reason to retry with the new version alone. In the MCP specification an `outputSchema` binds a tool's structured results, and whether it binds an error result is open ([issue 569][mcp-issue-569]). A proposal to define structured content for tool execution errors ([issue 3003][mcp-issue-3003]) and a proposal on how `tools/call` reports failures ([SEP-2145][sep-2145]) were open when this version was written (as read on 15 November 2026); neither defines the outcome of a write. The backends behind many servers already return the facts that B-9 names: a status that tells a refusal from an error of the backend, a refusal of a stale version, and the saved answer to a request repeated with the same key ([AIP-154][aip-154]; [Stripe][stripe-idem]). Several findings in the published audits cited in this document are cases of a server that dropped such a fact on the way to the caller (GF-01, GH-02, GH-05, PAY-05; Annex B, B-9).
- **Tolerant parsing.** [RFC 9413][rfc9413], "Maintaining Robust Protocols", gives the general argument against tolerating malformed input, which area IN applies to tool arguments.
- **API design guides.** Field masks for partial updates, entity tags for freshness and request identifiers for retries are established practice for web APIs, for example in Google's API Improvement Proposals [134][aip-134], [154][aip-154] and [155][aip-155], and in OASIS [Repeatable Requests Version 1.0][oasis-rr]. [RFC 6585][rfc6585], section 3, defines the status "428 Precondition Required", the precedent for NF-3.
- **Testing for lost updates.** Running concurrent operations, recording the history and checking it for anomalies such as lost updates is the method of the [Jepsen analyses][jepsen], and the [Elle][elle] checker infers such anomalies from a recorded history. Section 7.4 is a small application of that method, with forced and simultaneous schedules.
- **Existing tools.** MCP Inspector is a manual client, and scanners such as `mcp-scan` (since renamed `agent-scan`) examine tool metadata and tool descriptions. A few public test tools exercise writes. [`mcp-rig`][mcp-rig] (first released in September 2026) loses a response on purpose, retries the call and checks the server's state with further tool calls; its README reports that the retry applied the action twice on four of eleven open-source servers, a result the steward has not reproduced. [`mcp-test-harness`][mcp-test-harness] has assertions on a tool's answer to a replayed idempotency key and to an undefined field; they judge the response and not the stored state. [`mcp-wallfacer`][mcp-wallfacer] has a create, delete and read-back rule pack, and a lost-update check that applies to its own fixture tool. [MCProbe][mcprobe] counts calls that are accepted with an argument the schema does not define, by default only on tools annotated read-only or non-destructive. Each covers one or two of the behaviors in section 9. At the time of writing the authors know of no public tool that tests a server's own write tools for a lost update between two callers, for the refusal of a stale write, or for the report of a partly failed bulk write.

What MWS adds is narrow: requirement sentences about what a tool call does to backend state, each with a test method in prose and stated rules for verdicts, for servers whose authors mean well and still get a write wrong. Others have stated parts of the same problem and tested parts of it. The paper on the agent-tool boundary, issue 3394, the Agentic State Transfer draft, the agent API profile draft, the study of duplicate side effects (arXiv 2609.29095) and the test tool `mcp-rig` are about the same failures and are the closest to MWS. Most of the other work above is about the protocol or about attackers.

MWS makes two alignment promises. Area RETRY follows the protocol's key carrier when MCP standardizes one, and takes its two main rules from the IETF Idempotency-Key draft (section 11.5). Area ANN follows the definitions of the hints in the MCP specification and, where the specification is silent, takes account of what the MCP Tool Annotations interest group publishes; the group's output is advisory (section 11.3).

## 12. Limitations

This section is informative.

- **A result describes a test, not a server.** It covers the write paths, fields, inputs and schedules that were exercised, on the versions named, on the day named.
- **`held` is bounded.** It means the forced condition was handled correctly in the trials run. It does not cover interleavings, inputs or failure positions that were not forced.
- **`not observed` is not safety.** A race that was not seen in thirty overlapped attempts can still occur in about one attempt in ten.
- **Attribution needs a control arm.** Without one, a tester cannot tell a server defect from platform behavior, and section 8.2, rule 3, requires the record to say so in its attribution line.
- **A self-run result is the runner's own statement.** A signature or a timestamp on a result shows that the files were not changed afterwards. It does not show that there were no earlier runs, or that the declaration described the server fairly.
- **Some backends cannot be interposed on.** Where a server writes to its backend inside its own process, or over a protocol the tester's interposer does not speak, forced-interleaving and fault-injection tests are `not tested` unless the server offers cooperative hooks.
- **The declaration is trusted.** A tester tests the write paths it is told about. A write tool left out of the declaration is not tested, and a declaration that misstates a tool's mode, contrary to section 4, changes which requirements apply.
- **A server that declares less is judged by less.** Several requirements apply only to what a server declares: a schema constraint, a closed schema, a version argument, an idempotency key or a hint. A server that declares less is judged by fewer of them, and the harm can remain. The `not applicable` rows of a conformance statement show where.
- **Models and agents are out of scope.** MWS says whether a server reports a conflict truthfully. It does not say whether a given agent then does the right thing.
- **The evidence base is small.** The requirements in 0.9 were drawn from audits of five servers by one organization, the steward, published between 9 and 14 November 2026. Of the 26 requirements at MUST, 14 rest on a finding observed on one server, on code reading or on reasoning alone; each Evidence line says which. Every reproduction counted in an Evidence line is the steward's. The upstream reports that the steward filed and that this document links were filed in public between two days before the article that describes them and the day of that article, so no project had time to answer before it was named. The audits were carried out with AI assistance, as the articles say. When this version was written, most of the upstream reports from those audits had not yet been answered by the projects' maintainers. Each requirement cites the findings behind it so that a reader can judge the weight of the evidence, and the change process asks for cases from other sources.
- **Frequency is not measured.** A `violated` result from a deliberately simultaneous or deliberately ordered test says the behavior is possible. It says nothing about how often it occurs in ordinary use.
- **A candidate requirement: a tool that reads and writes in one call and accepts no version.** Such a tool can guard its own interval with the backend's version check and still replace a change that another writer made after the caller's older read (NF-15). No requirement in 0.9 covers this. It is a stated candidate for a later version, and the [Kubernetes article][kubernetes-addendum] records the published case.
- **A candidate requirement: a version argument that is accepted and not used.** A tool that accepts a version from the caller and ignores it gives a false assurance. Where the backend can detect the change this is `violated` under MWS-CONC-2. Where it cannot, 0.9 gives `platform`, and only MWS-CONC-5 applies. The [PostHog article][posthog-held] records a published case.
- **A candidate requirement: a list field set as a whole from an older read.** A field-patch tool that sets a list-valued field as a whole, such as labels, assignees or content blocks, and takes no version, or is called with its optional version left out, removes an element that another writer added after the caller's read. The same holds for a tool that sends a whole body as a merge patch. MWS-UPD-1 is `held`, because only the named field changed, and MWS-CONC-2 and MWS-UPD-2 do not apply. No requirement in 0.9 covers this. A test would be the stale-write procedure with the second writer adding an element to the same list.
- **A candidate requirement: a read that leaves out part of an object without saying so.** A read result that is truncated, paginated or redacted can be written back by a caller as if it were whole, and the rest is lost. No requirement in 0.9 makes a read result say that it is incomplete. This would widen the scope to read tools, as area IN already does.
- **A candidate requirement: a write that the server sends again by itself.** A server that repeats a write after a lost backend answer can create two objects while reporting one success. In 0.9 this is recorded as an observation under MWS-RES-2 and no requirement judges it.
- **A candidate requirement: an idempotency key on every write whose repeat has a further effect.** MWS-RETRY-1 asks for a key only on a create. An append, a send or an increment is duplicated by a repeat in the same way. Widening MWS-RETRY-1 to any such write is a stated candidate, and comment on it is asked for. An outside study argues for a key on every non-idempotent tool (arXiv 2609.29095; see section 11.7).
- **A candidate requirement: a write interrupted by cancellation.** In revision `2026-07-28` a server treats the closing of a response stream as cancellation (section 11.4). A composite write that stops at that point leaves part of itself applied with no result delivered, and the re-issued request meets that partial state. No requirement in 0.9 covers this.
- **A candidate requirement: a receipt for a delete.** MWS-RES-4 applies to a tool that creates or updates. No requirement in 0.9 asks a delete to say which objects it removed, or how many.
- **A candidate requirement: the scope that a default supplied.** MWS-TGT-1 applies where a scope argument is sent. Where it is left out, no requirement in 0.9 asks the result to say in which scope the write was made.
- **A candidate requirement: the final round of a multi round-trip request sent twice.** A retry that carries the same `requestState` and the same answers can be sent twice, and the write can then be made twice. The Multi Round-Trip Requests page leaves single use of `requestState` to the server. MWS-RETRY-3 judges only what was in effect before the `input_required` result.

## 13. Versioning

13.1. The version of this document is `MAJOR.MINOR`. Each release is dated and, once released, is not edited except for errata, which are listed in the changelog.

13.2. A MINOR release may add requirements, clarify wording, and add non-findings. A MAJOR release may also remove a requirement or change a level. There are two exceptions. A SHOULD that is not marked at risk becomes a MUST only in a MAJOR release, or in a MINOR release at least six months after the release that announced the change. A requirement marked at risk ([section 6](#6-structure-of-a-requirement)) may be reworded or withdrawn in a MINOR release when the MCP specification clarifies; raising its level follows the rule for any SHOULD.

13.3. A requirement has one of four statuses: `draft` (published for comment, may change), `active`, `deprecated` (still listed, scheduled for removal, with the reason) and `removed`. The last three follow the names of the feature states in the MCP specification's [feature lifecycle policy][mcp-lifecycle].

13.4. Requirement IDs and non-finding IDs are stable. An ID is never renumbered and never reused. When a requirement is split, the part that stays keeps the ID and each new part gets a new ID. A requirement that is removed is marked retired and keeps its entry.

13.5. Each release lists the MCP revisions it was checked against. When a new MCP revision is published, this document is reviewed against it within 60 days, and the outcome of the review is published even when nothing changes.

13.6. A test tool is versioned separately from this document and states both versions in its results. A test procedure whose steps change in a way that could change a verdict is given a new procedure version, which results also record.

## 14. Change process

14.1. Anyone may propose a change. A proposal is a pull request that adds a file under `spec/proposals/` with four parts:

1. a public, reproducible case: a link to a published finding or an upstream issue, or a failing case on the sample server;
2. the normative sentence and its applicability condition;
3. the test method, in prose;
4. a false-positive analysis that says when the test must not report `violated`.

A proposal to lower, narrow or withdraw a requirement gives, in place of part 1, a case in which the requirement gives a server a verdict that is wrong or that the server cannot avoid, and, in place of part 3, the change to the test.

14.2. A proposal for a new requirement or a change of level is open for comment for at least 14 days. A clarification is open for at least 7 days. A rewording or withdrawal of a requirement marked at risk, made because the MCP specification clarified, needs no comment period ([section 6](#6-structure-of-a-requirement)). Raising its level is a change of level and needs one.

14.3. Until the project has a maintainer from outside the steward, a change is accepted by the steward after the comment period, and the decision and its reasons are recorded. From then on, acceptance needs the approval of two maintainers, and one of the two approvals for any change to a MUST has to come from outside the steward. How a person becomes a maintainer is not yet defined. The steward will propose a rule during the comment window, and will appoint no maintainer by another route.

14.4. An accepted change lands as one pull request that contains four things: the normative text; a test; a defect in the sample server that the test detects; and the corrected sample server on which the test reports no violation. A requirement does not leave `draft` until it has been shown failing on the sample server and no longer failing on the corrected one. In 0.9 every requirement is `draft`, including those that the preview test tool and the sample server already show failing and no longer failing. None leaves `draft` before the comment window has closed, and each stays `draft` until its test, its sample-server defect and the fixed build exist. "A test" here is a check in the reference suite in this repository. That suite is one implementation of the test methods. Another tool that follows sections 5, 7, 8 and 10 and the Test method and Verdicts parts of section 9 is a tester on the same footing, and nothing in this document requires the steward's tool. `CONTRIBUTING.md` describes how this rule applies while the test suite and the sample server are being built.

14.5. Every decision, including each rejection and its reason, is recorded in `spec/DECISIONS.md`.

14.6. A proposal from the maintainers of a server about that server's own behavior is welcome and is labeled as such. A maintainer of a cited project may also ask, by an issue in this repository, for a dated note beside any row of the findings register that states the project's position, for example "intended", "disputed" or "fixed in version x". The steward adds the note in the project's words or a fair summary of them, as an erratum (section 13.1).

14.7. Contributions are made under the Developer Certificate of Origin ([DCO 1.1][dco]): each commit carries a `Signed-off-by` line. This applies to the steward's own commits as well. There is no contributor licence agreement.

14.8. During the comment window the steward will ask the maintainers of the servers cited in rationales to comment on the requirements that cite them, by a comment on an issue or pull request the steward has already opened in each project.

## 15. Governance

15.1. **Steward.** MWS is stewarded by IsoKron. Three facts belong together. IsoKron sells audits and builds of MCP servers. Those audits may report results against MWS, so IsoKron earns fees from work that uses this document and has a commercial interest in its subject. Every finding cited in version 0.9 comes from IsoKron's own audits, which IsoKron published between 9 and 14 November 2026 and which describe the audit method it sells. IsoKron charges nothing for the use of this document, its test suite, its sample server or its name, and gives no endorsement of any result, including results from its own audits. The upstream issues and pull requests that IsoKron opened as a result of those audits, and that this document links, were filed from the author's GitHub account, `rafe-walker`. A few linked items are other people's reports or fixes, and the text says so where it cites them. The rest of this section says how the commercial interest is contained.

15.2. **No endorsement.** This document defines no approval by the steward or by anyone else. The steward does not countersign results, and no statement of the form "verified by" the steward is defined here or in the test suite.

15.3. **No promotion.** Beyond the disclosures in 15.1 and 15.4, this document, the test suite and the sample server do not name the steward's services and carry no call to action, pricing or sign-up.

15.4. **Evidence is treated alike.** A finding published by the steward is admissible as a rationale on the same terms as anyone's: it has to be public and reproducible. Findings from other sources are welcome and are asked for in the proposal form (section 14.1). The findings cited in version 0.9 are listed in the findings register in this repository, [`spec/evidence/FINDINGS.md`][reg], under the same licence as this document, and each citation links there first. The articles behind them are published on the steward's website, which also carries its commercial offers, and the articles say that they show the audit method the steward sells. Requirement texts say "a tool" and "a server"; project names appear only where a citation needs them, in rationales, in sections 10 and 12, in the annexes and in the references.

15.5. **Name use.** The name "MCP Write-Safety Requirements" and the requirement IDs may be used by anyone to say which version was tested against, with what tool, and where the results are. The steward asks that they not be used to say that a product is approved, certified or endorsed. The steward approves, certifies and endorses nothing, and will say so if asked. A maintainer who wants to say that a server was tested can publish this sentence: "Tested against MWS 0.9 on [date] with [tool and version]; conformance statement at [URL]." Packages of the test tool and the sample server will be published from an npm scope named after the project, `@mcp-write-safety`.

15.6. **Path to a neutral home.** The steward does not intend to remain the sole maintainer. When the project has two maintainers from outside the steward, the steward will propose moving the repository to a neutral organization, or offering the document to the MCP project's own community structures. A merger into a larger neutral effort with the same aims would be counted as a success.

15.7. **Other auditors.** Use of MWS requirement IDs in other parties' reports, tools and audits is welcome and needs no permission beyond the licence.

15.8. **The steward's own reports.** Where the steward's audits or articles use MWS requirement IDs, they follow section 5 like anyone's: no totals, no counts of verdicts, and the declaration published.

## 16. Licence

The text of this document is licensed under the [Creative Commons Attribution 4.0 International][cc-by] licence (CC BY 4.0). The full licence text is in `LICENSE-spec` at the root of the repository.

Attribution: "MCP Write-Safety Requirements, version 0.9, Joshua Bryan, IsoKron, CC BY 4.0", with a link to the source where the medium allows.

The licence covers the text. It grants no rights in the names of the projects and products this document cites, which belong to their owners and are used only to identify what was tested. A changed version has to say that it was changed, as CC BY 4.0 requires. The steward asks that a changed version also carry another name and issue no requirement IDs with the `MWS-` prefix, so that an ID means one thing.

Software in the same repository is licensed separately, under the Apache License 2.0.

The MWS mark is not licensed under CC BY 4.0 or the Apache License 2.0; its use is described in `TRADEMARKS.md`.

---

## Annex A (informative): Measurements

The four items below are measured and reported as numbers. They have no verdict, no threshold and no requirement level, and a tester does not describe a server as good or bad on them. They concern cost and ease of use, not whether a write is safe, and any threshold would be arbitrary.

| Item | What is measured | Published illustration |
|---|---|---|
| A-1 Round trips | The number of tool calls needed to complete each job the tester's declaration names. | [GitHub article][github-benchmark]: a build that added two batch-read tools and other changes used 26% fewer tool calls over the same jobs. |
| A-2 Catalog size | The size of the `tools/list` result in bytes and characters, split into descriptions, input schemas and other content, with a token estimate only where the tester states the tokenizer. | [GitHub article][github-held]: about 10.7 thousand tokens (an estimate) for the 46 tools in the default set; icons were 56% of the full list's bytes ([catalog size][github-catalog]). |
| A-3 Result size | The largest tool results seen during the test; for write tools, the size of the result relative to the size of the change; and the server-managed metadata in a write result that the server's own read tool omits. | [R2][reg-posthog] ([article][posthog]): about 225,000 tokens (an estimate) in one response. [PAY-07][reg-payload] ([article][payload]): a 21-byte update answered with 384 bytes. [K8S-07][reg-kubernetes] ([article][kubernetes]): write results included bookkeeping metadata that the server's reads strip, 766 of 2,194 bytes (upstream [issue 1669][k8s-1669]). |
| A-4 Catalog hygiene | Tool descriptions that name tools absent from the catalog; whether the order of `tools/list` is the same across calls. | [L2][reg-posthog] ([article][posthog]): two descriptions named tools that were not in the catalog. Revision 2026-07-28 asks servers to return tools in a deterministic order (section 11.4). |

## Annex B (informative): Mitigation patterns

Patterns B-1 to B-8 are for servers whose backend lacks a version check or an idempotency key. B-9 is for any write tool. None of them is a requirement, with one exception: MWS-CONC-5 asks for the statement described in B-8, and for the same statement where B-3 is used. None makes a backend that loses updates safe. B-1 to B-8 reduce the window in which a loss can occur, or tell the caller that the window exists; B-9 tells the caller what a write did.

**B-1. Send only what changed.** Where the platform API has a per-field or partial-update endpoint, use it, and do not read the object, merge and write it back whole. This removes the server's own read-modify-write, which is the part the server controls. The proposed fix for [GH-01][reg-github] ([article][github]) takes this form.

**B-2. Pass the backend's precondition through.** Where the backend has a version, an entity tag or a lock, return the version from every read tool and accept it on every write tool, and send it to the backend as the precondition. In HTTP terms this is `ETag` with `If-Match`, to which a backend answers 412 (Precondition Failed) when the state has changed ([RFC 9110][rfc9110], sections 8.8.3, 13.1.1 and 15.5.13). The server adds no logic of its own.

**B-3. Best-effort comparison.** Where the backend has no version check, the server can derive a version itself, for example from the modification timestamp or from a hash of the fields a tool exposes, return it from reads, and on a write re-read the object and compare before writing. A gap remains between the comparison and the write, so this narrows the window and does not close it. The tool description should say so (MWS-CONC-5). [PAY-09][reg-payload] ([article][payload]) is the published case of a backend with no version check on any surface, which the article says the MCP layer can mitigate with a best-effort check (platform behavior, not yet reported upstream).

**B-4. Serialize writers in the server.** A per-object lock inside the server process prevents two calls through that process from interleaving. It does nothing for writers that reach the backend another way, or for a second instance of the server.

**B-5. Idempotency keys kept by the server.** Where the backend has no idempotency key, the server can keep a record of each key with a hash of the arguments and the result, for a stated period, and answer a repeat from the record. The record has to be written in the same transaction as the write, or a crash between the two brings the duplicate back. Where more than one instance of the server runs, every instance has to see the record. Where the record and the write cannot share a transaction, as with a backend reached over its own API, the server can store the key as pending before it calls the backend and complete the record from the backend's answer. Where that answer is lost and the backend offers no way to look the write up by its idempotency key, the server cannot learn the outcome: on a repeat it applies nothing and says that the outcome is not known (MWS-RETRY-2, proxy-assisted step). A record kept only in memory is lost when the server restarts. A server that then receives a key it has no record of, and cannot vouch for, applies nothing and says so (MWS-RETRY-2, step (e)); a key that carries its creation time, such as a UUIDv7, lets it tell such a key from a new one.

**B-6. Natural keys.** A create can be made idempotent without a key when the caller supplies the object's name or key and the backend refuses a second create of the same name (see MWS-TGT-3).

**B-7. Validate, then write, then undo.** Where the backend has no transaction across objects, validate every item before writing any (a dry run, where the backend offers one), and on a later failure undo what was written and report exactly what remains (MWS-ATOM-1, MWS-ATOM-2).

**B-8. Say what is not protected.** When none of the above is possible, the tool description is the place to say that concurrent or stale writes may be lost, so that the caller can serialize its own work (MWS-CONC-5).

**B-9. A result shape for write tools.** A caller and a tester learn what a write did from its result. Most servers say it in text, and text can be read more than one way. This item describes a JSON object that a write tool can return in `structuredContent` to say what the write did in fixed terms. It is a pattern, not a requirement. A server can meet every requirement in section 9 without it. A server that uses it is judged by the same requirements as one that does not: the members of the shape are statements in the result content ([section 4](#4-terms)), and each requirement judges them as it judges text. No requirement asks for the shape, and a malformed shape is not by itself a verdict.

The facts the shape carries are often available to the server already:

- many backends tell a refusal apart from a failure of their own by the status of their answer;
- they refuse a stale write when the request carries a version ([RFC 9110][rfc9110], section 13.1.1; [AIP-154][aip-154]);
- they answer a request sent again with the same idempotency key with the saved answer to the first ([Stripe][stripe-idem]).

In the published audits cited in this document, servers lost such facts between the backend and the caller:

- a save forced an overwrite past a version check that the platform's API applied ([GF-01][reg-grafana]);
- a delete tool took no version ([GH-02][reg-github]);
- bulk writes were reported as a success with no `isError` while the platform's API answered with the errors ([PAY-05][reg-payload]);
- the number of a created pull request was lost when a later step of the same call failed ([GH-05][reg-github]).

The shape gives a server one place to pass such facts on. It tells the caller and the tester what a write did, and does not by itself protect data: where a stale write is refused, the refusal is what keeps the other writer's change (MWS-CONC-2), and in the exploratory tests cited under MWS-CONC-6 the content of the refusal changed how many calls the caller made, not whether it recovered, except that a current state written as unquoted prose led the caller to overwrite the other writer's change.

*Name and version.* The shape is named `write-result`, and this document describes version 0.1.

- A version is written `MAJOR.MINOR`. A new MINOR version only adds optional members, codes or values. Any other change takes a new MAJOR version: removing a member, renaming it, or changing what it means.
- Before version 1.0, a new MINOR version may also make such changes.
- From version 1.0, a reader that knows version M.n reads a result of any version M.m. It reads the members it knows and ignores the others as members of the shape; they remain content of the result (section 7.3, rule 11).
- Before version 1.0, a reader reads only the version it knows. A result of another 0.x version is read as if it carried no shape, and so is a result of another MAJOR version.
- A code, or a value of a member, has the meaning that the result's own version gives it.
- A JSON Schema of version 0.1 is published with this document, under the same licence, as `spec/shapes/write-result-0.1.schema.json`. Where it and this item differ, this item governs.

*Placement.* The shape is the value of the member `mws` of `structuredContent`, which is then a JSON object. The tool's own output, if any, sits beside it in the same object. The shape sits in `structuredContent` because that member is checked against the tool's declared `outputSchema` and is the part of a result that clients and SDKs already give to programs. Proposals to the MCP project that record a related fact, such as whether an approved tool call ran ([SEP-2848][sep-2848]), place their record in the result's `_meta` under a namespaced key instead. Such a record answers a different question, whether the tool ran, where this shape says whether the requested state is in effect, and a result may carry both. The meaning of the shape's members does not depend on where the object is carried: should a later version of this document, or of the MCP specification, place it elsewhere in a result, the members and their meanings stay the same.

- The member `shape` is required and holds the name and version, for example `"write-result/0.1"`.
- The member `outcome` is required. Every other member is optional.
- A tool that uses the shape returns it on every result that its own code produces, success or error.
- The shape is for write tools. A read tool may return it on a refusal of its input, with `outcome: "not_applied"`.

*Identifiers and versions.* The following are each a string or an integer:

- `object.id` and `object.version`;
- the `id` and `version` of `object.parent`;
- an item's `id` and `version`;
- `conflict.current_version`.

Each takes the JSON type that the write tool's argument for that value accepts, so that a caller can pass the value on unchanged; otherwise it takes the type that the server's read tool returns. An integer lies between −(2<sup>53</sup>−1) and 2<sup>53</sup>−1; a larger value is given as a string. A tester compares such a value with the value it reads back as strings, an integer being written in its shortest decimal form.

*Members.*

| Member | Value | What it says | Bears on |
|---|---|---|---|
| `shape` | string, `write-result/` and the version | The name and version of the shape. | Section 7.3, rule 11 |
| `outcome` | one of the values in the Outcome table | What the write did, as a whole. On a call that carried an idempotency key, the write is the one that the key identifies (see *A repeat with a key*). | MWS-RES-1, MWS-RES-2, MWS-CONC-4, MWS-ATOM-1; NF-19 |
| `repeat` | one of the values in the Repeat table | Whether, and how, the same call may be sent again. | MWS-RES-2, MWS-CONC-6, MWS-RETRY-2 |
| `operation` | `create`, `update`, `delete`, or the name of a command | The kind of write. | MWS-RES-4 |
| `object` | object: `type`, `id`, `version`, `scope` and `parent`, each optional | The object written:<br>- `type`: its kind;<br>- `id`: its identifier;<br>- `version`: its version after the write;<br>- `scope`: the scope it was written in, as the tool's scope argument names it;<br>- `parent`: for an object written inside another, such as a comment on a ticket, an object with that other object's `type`, `id` and, where the write changed it, `version`.<br>On a result whose `outcome` is `not_applied`, `version` is left out (see *Conflict*). | MWS-RES-3, MWS-RES-4, MWS-TGT-1 |
| `changed` | array of strings, each a JSON Pointer ([RFC 6901][rfc6901]) into the object as the server's read tool returns it | The fields whose stored value the write changed (see *Changed fields*). An empty array says that nothing changed. A missing member says nothing. Names only: a field that holds a secret is named, and its value is not given. | MWS-RES-4, MWS-RES-1 (Guidance), MWS-SEC-1 |
| `replayed` | `true` | This call applied nothing. Its answer describes an earlier call with the same idempotency key. | MWS-RETRY-2 (Guidance) |
| `items` | array of objects | For a write of several items or steps, one entry for each (see *Items*). Each entry has `index`, `step`, `id`, `version`, `outcome` (`applied`, `not_applied`, `not_attempted` or `unknown`), `code`, `message` and `conflict`, each as described there. | MWS-ATOM-1, MWS-RES-2, MWS-RES-3 |
| `applied_count` | integer | For a write by selector: the number of objects the write was applied to. | MWS-ATOM-1 |
| `code` | string of lowercase letters, digits and underscores | A stable code for the reason the write was not applied, was not applied in full, or has an open outcome. The codes in the Codes table have the meaning given there. A server may define others. | MWS-CONC-1, MWS-CONC-2, MWS-CONC-4, MWS-IN-4, MWS-RES-2, MWS-RETRY-2 |
| `message` | string | The reason in words. It is for a reader, and the same reason may be worded differently from one call to the next. | None |
| `argument` | string, a JSON Pointer into the call's arguments | The argument that the reason concerns, for a refused input. Where several arguments were refused, it names one of them, and `argument_errors` lists each. The pointer names the argument once `~1` and `~0` are read as `/` and `~`. | MWS-IN-4 |
| `argument_errors` | array of objects: `argument` (as above), `code` and `message` | Each refused argument, with its own reason. | MWS-IN-4 |
| `conflict` | object, described under *Conflict* | The state that the write was refused against. Present only where `code` is `conflict` or `locked` and the refusal concerns one object. | MWS-CONC-6 |
| `read_with` | object: `tool` (a tool name) and `arguments` (an object) | A read that shows the current state: whether a write whose outcome is unknown was applied, or what the object holds after a conflict. The tool is a read tool that the server lists in `tools/list`, and the arguments address the object written. For a create whose answer was lost, there is no identifier to read by: the read is a list or search whose arguments find the object, or a read by the idempotency key where the server has one. | MWS-RES-2, MWS-CONC-6 |
| `version_argument` | string | The name of the write tool's argument that takes the version. | MWS-CONC-6 (Guidance) |

Members are named in lower case with underscores, as tool data, and not in the camel case of the protocol's own fields.

*Outcome.* Each value is defined by the terms of [section 4](#4-terms). The last column gives the value of `isError` that the cited requirements expect with it.

| `outcome` | Meaning | `isError` |
|---|---|---|
| `applied` | The state that the caller asked for is in effect. With `changed: []`, it was already in effect and nothing was changed (MWS-RES-1, Guidance; for a delete, NF-5). A write by selector that matched no object is `applied`, with `applied_count: 0`. This is not the case of an empty or match-all selector, which MWS-TGT-2 judges. | absent or `false` |
| `not_applied` | No change made by the call is in effect. Either the backend refused the write, or the call failed before any request that changes state was sent. The outcome is settled, or no such request was sent. On a call that carried an idempotency key, the write is the one that the key identifies (*A repeat with a key*): `not_applied` then says that no change made by that write is in effect and that its outcome is settled. It is never the answer while an earlier call with the same key is still being processed, whatever this call itself did; that answer is `unknown`, with the code `in_progress`. A write of several items that was refused as a whole, for example because one item was invalid, is `not_applied`, and `items` may say which item caused the refusal. | `true` (MWS-RES-2, MWS-CONC-4, MWS-IN-4) |
| `partial` | The call wrote several items or made several steps. Each has a settled outcome or was not attempted. At least one was applied and at least one was not. `items` says which. | `true` (MWS-ATOM-1, MWS-RES-2) |
| `unknown` | The outcome of at least one request that changes state is open. This value is used whenever any part is open, even where other parts are known to be applied; `items` says which parts are known. | `true` (MWS-RES-2) |
| `accepted` | The backend accepted the request for later processing and has not yet reported the result. A server uses this value only for an operation that the backend completes asynchronously. For any other operation it is a report that the write was made: a tester reads it as one (NF-19), and MWS-RES-1 judges it as it judges `applied`. `changed` and `object.version` are left out: a result that gives them with `accepted` says that the change was made, which NF-19 does not cover (MWS-RES-1). | absent or `false` |

*Repeat.*

| `repeat` | Meaning | Where it fits |
|---|---|---|
| `no` | Do not send the same call again. | Any outcome. It is the value after a refusal that a repeat would meet again, such as invalid input, and after `applied` where the call carried neither an idempotency key nor a version. |
| `yes` | The same call, sent again unchanged, cannot apply the write more than once. | Only `not_applied`, and only where no request that changes state was sent or the refusal may not recur, such as a rate limit. It is not used with `unknown`, `partial`, `accepted` or `applied`. After `applied`, even a repeat that would leave the same state can undo another writer's change made in between (MWS-RES-2, Guidance). |
| `same_key` | Send the call again only with the idempotency key that this call carried. | `unknown`, `partial`, `accepted` and `applied`. After `applied` or `accepted`, a repeat with that key is answered with this outcome and is not applied again (MWS-RETRY-2). On a call that carried no key it means `yes`. |
| `same_version` | Send the call again only with the version that this call carried. | `unknown` and `applied`, where a repeat that finds the write already applied is refused, or is answered with a success without being applied again (NF-24). On a call that carried no version it means `yes`. |
| `read_first` | Read first, with `read_with` or as the text says, and build the write again from what the read shows. | `unknown` and `partial`, and every conflict. After a conflict, `conflict.current_state` may take the place of the read where it lists nothing in `omitted`. |

Under MWS-RES-2, an error may tell the caller to repeat a write whose outcome is open only after a read that it names, or with the key or version that the call carried. In the lost-answer trial of MWS-RES-2, `unknown` with `repeat: "yes"`, as given or as read under "How a tester uses it", tells the caller to repeat it without either, whatever `read_with` or `object` names. That is the kind `retry-invited`.

*Codes with a fixed meaning.* Where the Outcome column names one value, a result with that code has that outcome.

| `code` | Meaning | Outcome |
|---|---|---|
| `conflict` | Refused because the object changed since the state that the call carried (MWS-CONC-2, MWS-CONC-4). An answer that another call with the same idempotency key is still being processed is not a conflict in this sense, even where the backend gives it HTTP status 409; its code is `in_progress`. | `not_applied` |
| `locked` | Refused because of a lock or another concurrency control that is not a version, such as a non-forced apply refused because another field manager owns a field (MWS-CONC-1). Where the backend has more than one such control, `conflict.held_by` or `message` says which. | `not_applied` |
| `version_required` | Refused because the call did not carry a version that the tool requires (NF-3). This code is used in place of `invalid_argument` also where the refusal comes from checking the input against a schema that requires the version. | `not_applied` |
| `invalid_argument` | Refused because an argument is not valid. `argument` names it (MWS-IN-4). | `not_applied` |
| `not_found` | Refused because the object that the call names does not exist. A delete or close of an absent object named by its identifier may instead answer `applied` with `changed: []` (NF-5). | `not_applied` |
| `idempotency_key_reused` | Refused because the idempotency key was used before with different arguments (MWS-RETRY-2). | `not_applied` |
| `in_progress` | An earlier call with the same idempotency key is still being processed, so the outcome of the write that the key identifies is open. This call applied nothing; `replayed: true` may say so, and the text may say that this call wrote nothing beside the outcome. The usual `repeat` is `same_key`. | `unknown` |
| `key_not_known` | The call carried an idempotency key of which the server has no record and for which it cannot vouch, for example after a restart, and it applied nothing (Annex B, B-5). The usual `repeat` is `read_first`. | `unknown` |
| `unavailable` | Refused for a reason that says nothing about the write itself, such as a rate limit, where the refusal is settled or nothing was sent. A later repeat may be accepted. | `not_applied` |
| `not_permitted` | Refused because the server or the backend does not permit this write: writes are disabled or the server is in a read-only mode (MWS-CFG-3), the tool is switched off, or the caller may not make it. Like `unavailable`, it says nothing about the write's own arguments or about an earlier call with the same idempotency key (MWS-RETRY-2). Unlike `unavailable`, a repeat meets the same refusal until the setting or the permission changes, so the usual `repeat` is `no`. | `not_applied` |
| `not_sent` | The call failed before any request that changes state was sent. | `not_applied` |
| `no_answer` | A request that changes state was sent, or may have been sent, and no answer from the backend was received. Where the server cannot tell whether a request left before the connection failed, it uses this code and not `not_sent`. | `unknown` |
| `backend_error` | The backend answered with an error of its own that does not say whether the request was carried out, such as an HTTP server-error status. | `unknown` |
| `internal_error` | A fault in the server itself, after a request that changes state was sent or may have been sent. Before any such request, `not_sent` is used. | `unknown` |

A server's own codes follow the same form. A later version may reserve further codes, and a result of version 0.1 gives each code the meaning of version 0.1.

*A repeat with a key.* On a call that carries an idempotency key, the members describe the write that the key identifies:

- `outcome` and `code` say what that write did, so far as the server knows. This holds even where this call applied nothing, as on a replay, on `in_progress` and on `key_not_known`.
- `object` and `changed` are those of the write, as the first answer gave them. Where the server does not have the first answer's `changed`, for example because the backend answers a repeated conditional write without it, `changed` is left out. A missing `changed` says nothing (see *Members*), and a reader does not take it for `changed: []`, which would say that the write changed nothing.
- `replayed: true` says that this call itself applied nothing.

So a replay of an applied create answers `applied`, with the first call's `object` and `changed`, `replayed: true` and `repeat: "same_key"`. A repeat whose first call lost its answer, where the server cannot establish the outcome, answers `unknown` with the first call's code, for example `no_answer`, and `replayed: true`. A repeat that says `not_applied` says that the earlier call did not apply the write, and MWS-RES-2 judges that statement as it would the same words in text (MWS-RETRY-2, step (e); MWS-RES-2, the same-key trial).

*Changed fields.* A pointer in `changed` names the field it points to:

- A change to a field below that field counts as a change to it, so `"/details"` covers a change to `/details/component`.
- A pointer to a field below counts as naming every field above it, so `"/details/component"` also names a change to `/details`.
- The pointer `""` names the whole object. It is used for a create, where it names every field the call set, and for a delete. For an update, the fields are named one by one.
- For a create, `changed` may instead list the fields that the call set. Server-managed fields and fields that took the backend's default are left out, and so is the scope argument.
- For a delete, `changed` may be left out.
- On a call that sent a request again after the answer to it was lost, `changed` lists what the call as a whole changed. `changed: []` there says that nothing was changed, and where the first request was applied, MWS-RES-2 reads that as a failure reported without `isError` (kind `no-error-flag`).

A tester that names fields in another form, such as `details.component`, converts them to pointers before it compares.

*Items.* `items` has one entry for each item of the call, or for each step.

- An item of a list that the call gave has `index`, its position in that list from 0, and has `id` where the object exists after the call.
- A step has `step`, a name for it.
- An object that a selector matched has `id`.
- `not_attempted` says that the server knows it sent no request that changes state for the item. This covers both a call that stopped early and a call that the server refused as a whole before sending anything.
- An entry may carry `conflict`, in the form below, for its own object. A write refused because of several objects puts each object's conflict in its entry, and has no top-level `conflict`.

Where a write of several items or steps has the `outcome` `partial` or `unknown`, `items` lists every item and step. For a write by selector, `items` lists at least every matched object to which the write was not applied, with its `id`, and `applied_count` counts the rest.

An item that `items` does not list therefore takes the top-level outcome where that is `applied` or `not_applied`, and is applied where `applied_count` covers it. Otherwise the result does not state its outcome.

A tester compares `applied_count` with what it read back only where it can count every object that the selector matched, as in a container that it created.

*Conflict.* The member `conflict` has the members below, each optional.

- `current_version`: the object's version when the write was refused. A backend that has no version gives none, and the member is then left out; it is never `null` or a placeholder.
- `checked_by`: `backend` where the backend's own check refused the write (B-2), `server` where the server made the comparison (B-3). A comparison by the server is a best-effort check (MWS-CONC-5).
- `current_state`: the object as it was when the write was refused, as a JSON object in the form that the server's read tool returns.
- `omitted`: JSON Pointers to the fields left out of `current_state`.
- `held_by`: for a lock, who or what holds it, where the caller may be told.

Rules for `current_state`:

- It holds only fields that the caller may read through the server's own read tool, and never a secret value. A field that holds one is listed in `omitted`.
- A server may leave out other fields to keep the result small, and lists them in `omitted` too, because a caller that builds a whole-object write from part of an object removes the rest.
- A server may leave `current_state` out entirely.

A result whose `code` is `conflict` has `repeat: "read_first"`, and names the read in `read_with` or in its text. A caller that resends its old write with the new version passes the check and removes the other writer's change (MWS-CONC-6, Guidance).

The state and the version describe the object when the write was refused, and may already be out of date. A write built from them and carrying `current_version` is refused again if the object has changed since.

The shape gives the current state as a JSON object, which can be read only one way, and the version as a value of its own, which a caller and a tester can find without parsing text. That is the form the Guidance to MWS-CONC-6 recommends. In the exploratory test cited there, the form of the state decided the loss: a state written as unquoted prose led the caller to overwrite the other writer's change, and the same state quoted or given as JSON did not. The version given on its own made no measured difference to loss; it is there for determinism.

*Text.* Some clients pass only the `content` of a result to the model, especially for an error. A result that carries the shape therefore says in text what the shape says, in two blocks.

- **The first text block** states the outcome in plain words, for example "Applied", "Not applied: the object changed since version 7", "Partly applied", "Outcome unknown" or "Accepted". It names the read to make where `read_with` is given. It does not restate `current_state` in prose. A server that returns some results without the shape, for example while it adopts it, words their first text block the same way and carries the state in a JSON text block, so that one sentence serves both (MWS-CONC-6, Guidance).
- **A further text block** carries the serialized JSON of `structuredContent`, as the MCP Tools page recommends for any structured result. It is the whole of `structuredContent`: a block that carries only `mws`, or adds or leaves out a member, is read as any other text. Where the state is large, this block repeats it; Annex A, item A-3, measures the size of the whole result, and `omitted` is the way to keep it small.

The text and the shape agree. Where they disagree, each is read on its own (section 7.3, rule 11): a text that invites a repeat gives the kind `retry-invited` whatever `repeat` says, and a `repeat` of `yes`, as given or as read, gives it whatever the text says. Likewise, a text that says the write failed is the kind `stated-failure` beside a shape that says `unknown`, and a shape that says `not_applied` is that kind beside a text that says the outcome is not known. A tester reads these statements in the text by the declaration's patterns ([Annex E](#annex-e-informative-the-declaration)): an invitation to repeat the call by its pattern for such an invitation, and a statement that the write failed by its pattern for that statement, which may be a pattern kept for an error whose outcome is open, apart from the one it reads in a success. For a write of several items or steps, a text that says the whole write took effect beside a shape whose `outcome` is `partial`, `not_applied` or `unknown`, or whose `items` list one that was not applied, is read by the pattern for that statement, and MWS-ATOM-1 judges it by the read-back (MWS-ATOM-1, Test method).

*Output schema.* Where a tool declares an `outputSchema`, the MCP specification requires the tool's structured results to conform to it, so the schema declares the member `mws`.

- **Include the shape's schema.** It is best placed in the tool's schema, for example under `$defs`, and not left for a client to fetch.
- **Allow later members.** `additionalProperties` is not set to `false` on `mws` or on its members, so that a later MINOR version stays valid against a schema a client has kept.
- **Error results.** The MCP specification does not say whether a result with `isError: true` must also conform ([MCP issue 569][mcp-issue-569]). A schema that requires `mws`, and requires the tool's own output members only where `outcome` is `applied` (in JSON Schema 2020-12, with `if` and `then`), is valid under either reading. A validator that does not support `if` treats those members as optional, and the result still conforms.
- **Generated schemas.** A schema generated from a type in the tool's code makes that type's members required on errors too, unless the type marks them optional.
- **Non-object output.** A tool whose structured output is not a JSON object cannot carry the shape without changing its output.

Client libraries often validate `structuredContent` against the `outputSchema` and reject the whole result on any mismatch, error results included. For such a client, a malformed member makes the whole result unusable, not just the member: the rule that a malformed member decides nothing (section 7.3, rule 11) is a rule for testers, and does not protect the caller. A server that uses the shape therefore checks each result against the shape's schema before it returns it.

*Where the shape is missing.* A result that the server's framework produces before the tool's own code runs often carries no shape. A refusal by the framework's validation of the input against the input schema is an example. Such a result is read as text, as any result without the shape is. A server that wants every refusal of input to carry `invalid_argument` and `argument` checks the arguments in its own code. A result of a tool for which a declaration adopted the shape, but that carries none, is not by itself a verdict.

*Examples.* A conflict:

```json
{
  "resultType": "complete",
  "isError": true,
  "content": [
    { "type": "text", "text": "Not applied: item 42 changed since version 7. Nothing was changed.\nIts current state and version are in the JSON below.\nBefore writing again, read it with \"get_item\" and the arguments {\"id\":\"42\"} and build the write from what the read shows." },
    { "type": "text", "text": "{\"mws\":{\"shape\":\"write-result/0.1\",\"outcome\":\"not_applied\",\"repeat\":\"read_first\",\"code\":\"conflict\",\"object\":{\"type\":\"item\",\"id\":\"42\"},\"conflict\":{\"current_version\":8,\"checked_by\":\"backend\",\"current_state\":{\"title\":\"Quarterly report\",\"labels\":[\"finance\",\"review\"]},\"omitted\":[\"/body\"]},\"read_with\":{\"tool\":\"get_item\",\"arguments\":{\"id\":\"42\"}},\"version_argument\":\"expected_version\"}}" }
  ],
  "structuredContent": {
    "mws": {
      "shape": "write-result/0.1",
      "outcome": "not_applied",
      "repeat": "read_first",
      "code": "conflict",
      "object": { "type": "item", "id": "42" },
      "conflict": {
        "current_version": 8,
        "checked_by": "backend",
        "current_state": { "title": "Quarterly report", "labels": ["finance", "review"] },
        "omitted": ["/body"]
      },
      "read_with": { "tool": "get_item", "arguments": { "id": "42" } },
      "version_argument": "expected_version"
    }
  }
}
```

Here the tool's `expected_version` argument takes an integer, so `current_version` is the integer 8.

An update whose answer was lost:

```json
{
  "resultType": "complete",
  "isError": true,
  "content": [
    { "type": "text", "text": "Outcome unknown: the update to item 42 was sent and the connection closed before an answer arrived. The change may have been applied. Read item 42 with get_item before repeating the call." },
    { "type": "text", "text": "{\"mws\":{\"shape\":\"write-result/0.1\",\"outcome\":\"unknown\",\"repeat\":\"read_first\",\"code\":\"no_answer\",\"object\":{\"type\":\"item\",\"id\":\"42\"},\"read_with\":{\"tool\":\"get_item\",\"arguments\":{\"id\":\"42\"}}}}" }
  ],
  "structuredContent": {
    "mws": {
      "shape": "write-result/0.1",
      "outcome": "unknown",
      "repeat": "read_first",
      "code": "no_answer",
      "object": { "type": "item", "id": "42" },
      "read_with": { "tool": "get_item", "arguments": { "id": "42" } }
    }
  }
}
```

*How a tester uses it.* This item is a published result shape in the sense of [section 7.3](#7-test-methods), rule 11, and its name and version are `write-result/0.1`. A declaration may adopt it by that name and version for the tools whose results carry it ([Annex E](#annex-e-informative-the-declaration)). Its members are then patterns for what they define. For example:

- `outcome: "unknown"` says that it is not known whether the write was applied, and `outcome: "not_applied"` that it was not applied;
- `repeat: "yes"` tells the caller to repeat the call;
- `read_with` names a read, which is a read to make first only where `repeat` is `read_first`;
- `code: "locked"` says that a concurrency control that is not a version refused the write;
- `replayed: true` marks a replay;
- `changed: []` says that nothing was changed;
- `conflict.current_version` states the current version where, compared as a string, it equals the declared version field as read back after the conflict;
- `conflict.current_state` states the current state for the fields it holds, and not for those listed in `omitted` (MWS-CONC-6).

Readings of `locked` and `repeat`:

- `code: "locked"` names the control under test (MWS-CONC-1) only where the declaration names one such control for the operation. Otherwise `conflict.held_by`, `message` or the text has to name it.
- `repeat: "same_key"` names the idempotency key, and `repeat: "same_version"` the version, only where the call carried one.
- `repeat: "read_first"` names a read to make first where `read_with.tool` is a read tool that the server lists, where `object` gives the object's `id`, or where the text names a read tool or the object to read.
- Otherwise each of these `repeat` values is read as `repeat: "yes"`. `repeat: "yes"`, as given or as read, tells the caller to repeat the call without a read first and without a key or a version, whatever `read_with` or `object` names.
- Where `repeat` is `same_version` and the call carried a version, it names that version. The follow-through that MWS-RES-2 describes for an error that names the version then applies, as it does to the same words in text.

On a call that carried an idempotency key, `outcome` and `code` are read as statements about the write the key identifies, as *A repeat with a key* says. Under rule 11 the record then quotes the member relied on, and gives the shape and its version as the source that decided it.

What decides nothing as part of the shape:

- As rule 11 provides, a member whose value does not have the form this item gives it decides nothing as part of the shape, and the record quotes it as an observation. The other members of the same shape are still read, also where `outcome` is missing or malformed.
- A result of another MAJOR version, or, before version 1.0, of another MINOR version, decides nothing as a pattern of this item.
- Nor does a `read_with.tool` that the server does not list, or one that the tester cannot check because it does not have the server's tool list.

Free words and the serialized block:

- A string of free words, such as `message`, an item's `message`, an entry's `message` in `argument_errors`, or `conflict.held_by`, is not a pattern of this item. Nor is a member that the version does not define, a code that the version does not reserve, or the tool's own output beside `mws`. They are content of the result like any other ([section 4](#4-terms)): a declared text pattern may match them, and a person may read them.
- A text block whose whole text parses as JSON equal to `structuredContent` says what `structuredContent` says, and nothing more. Equal means equal as JSON values: the order of members, white space and the escaping of strings do not count. A member's name, and a value that this item takes from a fixed list, are not sentences of the text, so a text pattern does not match them: a pattern for "applied" does not match `"outcome":"applied"`. The free words and members just named are read in that block as in `structuredContent`. Declared text patterns are applied to the other text blocks, and to those free words.
- Where a result carries no `structuredContent`, and a text block's whole text parses as a JSON object whose member `mws` has the form of this item, that block is read as the shape.

Limits on what the shape decides:

- A shape that is not adopted decides nothing by itself. Its members, like its text, may still match a declared pattern or be read by a person.
- Where a member and the text disagree, each is read on its own, as rule 11 provides.
- The shape never answers a clause that an entry marks review-only (section 8.2, rule 11). A person answers it, and may cite the shape.
- As rule 11 also provides, the shape never decides a clause that the requirement's test decides from the state read back, such as whether a write is in effect. A result that says `applied` while the state is not in effect is `violated` under MWS-RES-1, as the same claim in text would be.

Whether a result shape should become a requirement in version 1.0 is open for comment. Such a requirement would be a SHOULD in area RES: a write tool states the outcome of each call in a published shape as well as in its text. Comment is asked in particular on:

- the values of `outcome` and `repeat`, and the codes;
- whether such a requirement should name one shape, or accept any shape that a declaration adopts by name and version;
- how it would apply to a tool whose structured output is not a JSON object;
- whether the shape should be offered to the MCP project instead ([section 11.7](#117-relationship-to-other-work)).

## Annex C (informative): Requirement index

| ID | Level | Short form | Methods | `platform` available |
|---|---|---|---|---|
| MWS-UPD-1 | MUST | A field patch changes only the named fields | black-box | yes |
| MWS-UPD-2 | MUST | A list edit, move or removal lands on the element the caller read at that address, or is refused | black-box | yes |
| MWS-CONC-1 | MUST | Do not bypass the backend's concurrency control by default | black-box or proxy-assisted, with control arm | no |
| MWS-CONC-2 | MUST | Refuse a stale write where the backend can detect it | black-box | yes |
| MWS-CONC-3 | MUST | Concurrent writes to different parts do not both succeed with one lost | black-box, proxy-assisted | yes |
| MWS-CONC-4 | MUST | A conflict is an error, is not applied and says so | black-box, review-only | no |
| MWS-CONC-5 | SHOULD | The description discloses stale writes the backend cannot detect | review-only | no |
| MWS-CONC-6 | SHOULD | A conflict tells the caller to read again before retrying, or carries the current state | black-box, review-only | no |
| MWS-TGT-1 | MUST | Honor or reject a scope argument | black-box | yes |
| MWS-TGT-2 | MUST | An empty or match-all selector does not mean everything | black-box | no |
| MWS-TGT-3 | MUST | A create does not overwrite | black-box | yes |
| MWS-RES-1 | MUST | Success only when the state asked for is in effect | black-box | yes |
| MWS-RES-2 | MUST | A failed write is not a success, says what remains applied, and is a tool execution error where the backend or a rule refused it | black-box, proxy-assisted | no |
| MWS-RES-3 | MUST | A create returns its identifier, even on later failure | black-box, proxy-assisted | no |
| MWS-RES-4 | SHOULD | A write returns a receipt | black-box | no |
| MWS-ATOM-1 | MUST | A partial outcome is not success, and names what was applied | black-box, proxy-assisted | no |
| MWS-ATOM-2 | SHOULD | Multi-object writes are all-or-nothing | black-box, proxy-assisted | no |
| MWS-RETRY-1 | SHOULD | A non-idempotent create accepts an idempotency key | black-box | no |
| MWS-RETRY-2 | MUST | An idempotency key is honored: applied at most once and answered with the first outcome where the server can establish it, new key new write, changed arguments refused | black-box, black-box (launch), proxy-assisted, proxy-assisted (launch) | no |
| MWS-RETRY-3 | MUST | The write asked for is not in effect before an `input_required` result | black-box, proxy-assisted | no |
| MWS-IN-1 | MUST | No coercion that changes the meaning of a value | black-box | no |
| MWS-IN-2 | MUST | Unknown arguments are never dropped silently | black-box | no |
| MWS-IN-3 | MUST | A call that breaks a declared constraint is rejected | black-box | no |
| MWS-IN-4 | MUST | A validation failure is an error naming the argument and reason | black-box, review-only | no |
| MWS-IN-5 | SHOULD | The schema declares the fixed single-argument constraints that are enforced | black-box | no |
| MWS-IN-6 | SHOULD | Wrong types are rejected, not converted or dropped | black-box | no |
| MWS-IN-7 | SHOULD | Unknown arguments are rejected | black-box | no |
| MWS-CFG-1 | MUST | An unrecognized safety setting never leaves writes enabled | black-box (launch) | no |
| MWS-CFG-2 | MUST | An unknown tool name in a deny-list stops the server or the request, or disables writes | black-box (launch) | no |
| MWS-CFG-3 | MUST | Read-only mode refuses every write tool | black-box (launch) | no |
| MWS-CFG-4 | SHOULD | An unknown tool name in an allow-list stops the server or the request | black-box (launch) | no |
| MWS-ANN-1 | MUST | `readOnlyHint: true` means no state change | black-box | no |
| MWS-ANN-2 | MUST | `destructiveHint: false` means no deletion, and no removal or replacement of data the caller did not name | black-box | no |
| MWS-ANN-3 | MUST | `idempotentHint: true` means no further effect on repeat | black-box | no |
| MWS-ANN-4 | SHOULD | `readOnlyHint` and `destructiveHint` are declared explicitly | black-box | no |
| MWS-ANN-5 | SHOULD | `destructiveHint: false` means additive only (at risk) | black-box | no |
| MWS-SEC-1 | MUST | No credentials in tool results, other than one the tool exists to issue | black-box | no |

The short forms are an index only. The requirement is the sentence in section 9. The last column says whether the requirement's entry lists the verdict `platform` (section 8.2, rule 2).

## Annex D (informative): Credential patterns

MWS-SEC-1 decides `violated` only from exact values: the credentials the server was started with, canary values the declaration names, and URLs whose query carries a parameter the declaration names as a token or a signature. A test tool can also search results for the general patterns below. A match on one of them is a candidate for a person to examine. It is never a verdict by itself.

| Pattern | What is matched |
|---|---|
| JSON Web Token shape | Three base64url segments separated by dots, where the first decodes to a JSON header. |
| PEM private-key header | A line of the form `-----BEGIN ... PRIVATE KEY-----`. |
| `Authorization` header value | The schemes `Bearer` and `Basic` followed by a value, where a result echoes request or response headers. |
| Provider key prefixes | The fixed prefixes that well-known hosting, source-control, payment and messaging services put at the start of the keys they issue. A test tool publishes the list it uses. |
| Query parameters that carry a token or a signature | Names such as `token`, `access_token`, `sig`, `signature`, `X-Amz-Signature` and `X-Goog-Signature` in the query of a URL. |

The patterns are data, not standards text. A test tool publishes and versions the list it uses, and a result states the list and the version that were used. Examples and tests of the patterns use values that are plainly not real, so that this repository holds no secret.

## Annex E (informative): The declaration

The declaration is the tester's written description of the write paths under test ([section 4](#4-terms)). It is published with the conformance statement (section 5.3). The table lists its fields and what each is used for. A field that is not given leaves the tests that need it as `not tested`.

| Field | Used by |
|---|---|
| For each resource: the tools that read, create, update and delete it | Every requirement; the read tool is used for every read-back (section 7.1). |
| Each update tool's mode, with the schema evidence for it | Whether MWS-UPD-1 applies; NF-6. |
| For a tool that takes the whole object as one argument: the platform operation it calls (replace, merge patch or apply) | Whether MWS-UPD-1 applies (section 4). |
| The fields of each object that the update tool can set | MWS-UPD-1, MWS-RES-1, MWS-TGT-2. |
| A statement by the operator of the arguments of each tool that updates one object named by its identifier that the tester may send with a value other than the base call's and then put back: for each, that its change affects only the object under test and can be undone through that tool, or through a tool named for the purpose (optional; where an argument is not listed, a counterpart control of MWS-IN-4 that would send it with a value other than the base call's, or leave it out of a tool that replaces or applies the whole object, is not sent, and the probe is not judged; where an argument is listed and the object cannot be put back, the probe is not judged and the tool is not probed further, as MWS-IN-4 says) | MWS-IN-1, MWS-IN-4, MWS-IN-6. |
| Two fields of one object that are independent of each other | MWS-CONC-2, MWS-CONC-3 (section 7.3). |
| For a tool that edits, moves or removes one element of a list: the list, and how the tool and the platform API address an element | MWS-UPD-2. |
| For a tool that accepts a scope argument: two scopes the tester created, and the server's default scope | MWS-TGT-1; section 7.3. |
| The platform API operation used as the control arm | Every record with a control arm (section 7.2); required for MWS-CONC-1. |
| The concurrency controls the backend offers, and how each is engaged | MWS-CONC-1, MWS-CONC-4. |
| The name of the version field of each resource | MWS-CONC-2, MWS-CONC-6, MWS-RES-2, MWS-RES-4, MWS-RETRY-2. |
| Operations for which the backend has no version check | MWS-CONC-2 (row 4), MWS-CONC-5. |
| The settle interval | Every read-back (section 7.3); MWS-RES-1; NF-11. |
| Server-managed fields to ignore in comparisons | MWS-UPD-1, MWS-ANN-3 (section 7.3); Annex A, item A-3. |
| Normalized fields | NF-20, under MWS-RES-1 and MWS-UPD-1. |
| Operations that the backend completes asynchronously | MWS-RES-1, MWS-RES-2; NF-19. |
| The forms of a match-all selector | MWS-TGT-2. |
| The tools that exist to delete containers | MWS-TGT-2; NF-18. |
| For a tool that brings a new object into being under a name the caller chooses: whether it was put among the creates or among the upserts and applies, with the words of its name or description relied on | MWS-TGT-3; NF-8. |
| A statement by the operator that every object the server's identity can change in the backend is disposable, and that nothing else writes there during the test (optional; where it is not given, the forms of MWS-TGT-2 and the calls that section 7.3, rule 1, puts under the same rule are not sent) | MWS-TGT-2, MWS-TGT-1, MWS-IN-1, MWS-IN-2, MWS-IN-3; section 7.3. |
| Kinds of object that the backend itself removes or changes, such as expiring events or objects a controller replaces (optional) | The inventory of MWS-TGT-2; section 7.3. |
| Extra cases in which the server may be unable to do what was asked | MWS-RES-1. |
| Means of provoking a failure: an invalid item, a step the backend will refuse, a credential that lacks a permission | MWS-RES-2, MWS-RES-3, MWS-ATOM-1, MWS-ATOM-2. |
| Server-error statuses by which this backend refuses a request, and, for a backend that does not answer in HTTP, the answers that report success or a refusal (optional) | MWS-RES-2 (settled outcome, section 4). |
| Where an idempotency key goes: a tool argument or a `_meta` field | MWS-RETRY-1, MWS-RETRY-2. |
| How to make a write tool answer with an `input_required` result, the answers to give on the retry, and the state that tool can write | MWS-RETRY-3. |
| A replay indicator, where the server has one (optional) | Guidance to MWS-RETRY-2. |
| Whether the backend offers an idempotency key that answers a repeat with the result of the first request, or a lookup of a write by its idempotency key, that a write tool could use (optional; where it is not given, a `held` record with the note "outcome not established" says that the declaration is silent) | MWS-RETRY-2. |
| Whether the backend changes a resource's version on every write it applies, even one that leaves the values as they were, and on nothing else, in steps that can be counted; and whether a write tool makes no backend write to the object except one for each application of the write | MWS-RETRY-2. |
| Checks that a write tool makes whatever the idempotency key, of a version, a name or duplicate content (optional) | MWS-RETRY-2. |
| A way to stop and start the server, and whether the stop is graceful or a kill (optional; where it is not given, step (e) and its crash form give `not tested`) | MWS-RETRY-2. |
| Whether a write tool's key record survives a restart of the server, after a graceful stop and after a kill (optional; where it is not given, a `held` record with the note "key record not kept" says that the declaration is silent) | MWS-RETRY-2. |
| Nested levels of arguments to probe | MWS-IN-2, MWS-IN-3, MWS-IN-7. |
| Further argument values that the backend is known to refuse (optional) | MWS-IN-5. |
| Refusals that rest on a fixed constraint: for each, the tool, the argument, a pattern for the refusal's text, and the reason the constraint is fixed (optional; a person's reading recorded with the result is the alternative) | MWS-IN-5. |
| The valid values of each write-restricting setting, whether each value restricts or permits writes, whether the setting is applied at start or with a request, and whether the server distinguishes an empty value from an unset one | MWS-CFG-1, MWS-CFG-3. |
| Settings that allow or deny tools by name or by group, and whether each is applied at start or with a request | MWS-CFG-2, MWS-CFG-4. |
| Tools that the server defines and that are switched off in the tested configuration (optional) | MWS-CFG-2. |
| For a tool with more than one operation or mode: the operations to call | MWS-ANN-2. |
| The write tools | MWS-CFG-1, MWS-CFG-2, MWS-CFG-3, MWS-ANN-1. |
| Objects whose state a read-only tool must leave untouched, and the state to count for a repeated call | MWS-ANN-1, MWS-ANN-3, MWS-RETRY-2. |
| Canary values, and the query parameters that carry a token or a signature | MWS-SEC-1. |
| The tools that exist to issue a credential | MWS-SEC-1; NF-16. |
| Patterns by which the tester recognizes what a result says: not applied, not used, outcome unknown, an invitation to repeat the call and a read named to make first or a key or a version named to repeat it with, still in progress, a replay, accepted or pending, refused because of a named concurrency control, and, for a write of several items or steps, that the whole write took effect, with every item or step applied (optional; where this last pattern is not given or cannot be applied as written, MWS-ATOM-1 does not ask what the content says about the whole write, and a `held` record says that it was not read for that statement; a person's reading is the alternative; a structured field may be named, and a published library of patterns may be adopted by name and version) | MWS-CONC-1, MWS-CONC-2, MWS-CONC-4, MWS-RES-1, MWS-RES-2, MWS-ATOM-1, MWS-RETRY-2, MWS-IN-2; NF-19; section 7.3. |
| A published result shape that the server's write tools return, such as [Annex B](#annex-b-informative-mitigation-patterns), B-9, adopted by name and version as a library of patterns (the row above), and the tools whose results carry it (optional; where it is not given, the shape decides nothing by itself) | MWS-CONC-1, MWS-CONC-2, MWS-CONC-4, MWS-CONC-6, MWS-RES-1, MWS-RES-2, MWS-RES-3, MWS-RES-4, MWS-TGT-1, MWS-ATOM-1, MWS-RETRY-2, MWS-IN-4; NF-19; section 7.3, rule 11; [Annex B](#annex-b-informative-mitigation-patterns), B-9. |
| The jobs whose round trips are counted | Annex A, item A-1. |

## References

### Normative

- [RFC 2119][rfc2119]: Bradner, S., "Key words for use in RFCs to Indicate Requirement Levels", BCP 14, RFC 2119, March 1997.
- [RFC 8174][rfc8174]: Leiba, B., "Ambiguity of Uppercase vs Lowercase in RFC 2119 Key Words", BCP 14, RFC 8174, May 2017.
- Model Context Protocol specification, revisions [2025-11-25][mcp-spec-2025] and [2026-07-28][mcp-spec-2026], for the definitions of tool, `tools/call`, tool result, `isError`, `resultType`, the `input_required` result (revision `2026-07-28`), tool annotations and `tools/list`.
- JSON Schema, draft 2020-12: [JSON Schema Core][json-schema-core] ("JSON Schema: A Media Type for Describing JSON Documents") and [JSON Schema Validation][json-schema-validation] ("JSON Schema Validation: A Vocabulary for Structural Validation of JSON"), for the keywords named in area IN.

### Informative: MCP

- Tools, [revision 2025-11-25][mcp-tools-2025] and [revision 2026-07-28][mcp-tools-2026].
- Schema, [revision 2025-11-25][mcp-schema-2025] and [revision 2026-07-28][mcp-schema-2026] (`ToolAnnotations`, `CallToolResult`).
- [Key Changes, revision 2026-07-28][mcp-changelog-2026].
- [Multi Round-Trip Requests, revision 2026-07-28][mcp-mrtr].
- [stdio transport, revision 2026-07-28][mcp-stdio-2026].
- [SEP-2575, Make MCP Stateless][sep-2575].
- [Tasks extension, overview][mcp-tasks].
- [Feature lifecycle and deprecation policy][mcp-lifecycle].
- [MCP conformance test framework][mcp-conformance].
- [Tool Annotations interest group][mcp-ann-group], and its [issue 10][mcp-ann-ig] on annotation results.
- ["Tool Annotations as Risk Vocabulary: What Hints Can and Can't Do"][mcp-ann-blog], MCP blog, 16 March 2026.
- [SEP-1303, input validation errors as tool execution errors][sep-1303].
- [SEP-2484, conformance tests required for final SEPs][sep-2484].
- [Issue 3394 in the MCP specification repository][mcp-issue-3394], on a retry after a lost response.
- [SEP-3182, Request Idempotency][sep-3182], a proposal closed in August 2026 with the comment that it was AI-generated with no disclosure or context, and without a maintainer's review of its substance.
- [Issue 4721 in the MCP reference servers repository][mcp-servers-4721], on inaccurate annotations, reported by others.
- [Issue 569 in the MCP specification repository][mcp-issue-569], on error results of a tool with an output schema.
- [Issue 3003 in the MCP specification repository][mcp-issue-3003], on structured content for tool execution errors.
- [SEP-2145, Standardize `tools/call` failure reporting][sep-2145], a draft proposal.

### Informative: other

- [RFC 9110][rfc9110]: Fielding, R., Nottingham, M., Reschke, J. (eds.), "HTTP Semantics", STD 97, RFC 9110, June 2022.
- [RFC 6902][rfc6902]: Bryan, P., Nottingham, M. (eds.), "JavaScript Object Notation (JSON) Patch", RFC 6902, April 2013.
- [RFC 7396][rfc7396]: Hoffman, P., Snell, J., "JSON Merge Patch", RFC 7396, October 2014.
- ["HTTP Profile for Conditional Updates to Shared Resource State (Agentic State Transfer)"][ast-draft], Jurkovikj, A., Internet-Draft `draft-jurkovikj-httpapi-agentic-state-02`, 27 July 2026 (an individual draft; work in progress).
- ["Where Does Exactly-Once Live? Model, Harness, and Tool-Contract Effects on Duplicate Side Effects in LLM Agents"][arxiv-2609-29095], Li, J., arXiv 2609.29095, September 2026.
- ["Verified Tool Calls Improve LLM Agent Reliability Under Non-Atomic Failures"][arxiv-2608-02645], Mansoor, I. K., Phadke, A., Rana, P., arXiv 2608.02645, July 2026.
- ["Design Considerations and Profile for HTTP APIs Consumed by AI Agents"][gaikwad-draft], Gaikwad, M., Internet-Draft, revision 01, 30 June 2026 (an individual draft; work in progress).
- [Agentic Commerce Protocol, "Agentic Checkout"][acp-checkout], status Draft, main branch as read on 15 November 2026.
- Test tools: [`mcp-rig`][mcp-rig], [`mcp-test-harness`][mcp-test-harness], [`mcp-wallfacer`][mcp-wallfacer], [MCProbe][mcprobe]; and a [scan of declared schemas][agentsafe-scan] of 24 servers, 9 October 2026.
- [RFC 6585][rfc6585]: Nottingham, M., Fielding, R., "Additional HTTP Status Codes", RFC 6585, April 2012.
- [RFC 9413][rfc9413]: Thomson, M., Schinazi, D., "Maintaining Robust Protocols", RFC 9413, June 2023.
- Google API Improvement Proposals [AIP-134][aip-134] ("Standard methods: Update"), [AIP-154][aip-154] ("Resource freshness validation"), [AIP-155][aip-155] ("Request identification") and [AIP-193][aip-193] ("Errors").
- [RFC 9457][rfc9457]: Nottingham, M., Wilde, E., Dalal, S., "Problem Details for HTTP APIs", RFC 9457, July 2023.
- [RFC 6901][rfc6901]: Bryan, P. (ed.), Zyp, K., Nottingham, M. (ed.), "JavaScript Object Notation (JSON) Pointer", RFC 6901, April 2013.
- [JSON:API, version 1.1, "Errors"][jsonapi-errors].
- [Repeatable Requests Version 1.0][oasis-rr], OASIS Committee Specification 01, 7 July 2020.
- [Jepsen analyses][jepsen]; Kingsbury, K., Alvaro, P., ["Elle: Inferring Isolation Anomalies from Experimental Observations"][elle], Proceedings of the VLDB Endowment 14(3), 2020.
- [The Idempotency-Key HTTP Header Field][idem-draft], Internet-Draft `draft-ietf-httpapi-idempotency-key-header-09`, 21 November 2026, IETF HTTPAPI working group (work in progress).
- Stripe API reference, ["Idempotent requests"][stripe-idem].
- ["When Tool Calls Succeed but Workflows Fail: Anomalies at the Agent-Tool Boundary"][arxiv-2609-15397], Trofimov, A., Novikov, B., arXiv 2609.15397, September 2026.
- ["Tool Design for Secure Agentic Systems"][cosai-tool-design], practical guide, Coalition for Secure AI (CoSAI), an OASIS Open Project.
- [OWASP MCP Top 10][owasp-mcp-top10].
- [OWASP MCP Security Cheat Sheet][owasp-mcp-cheatsheet].
- [Developer Certificate of Origin 1.1][dco].
- [Creative Commons Attribution 4.0 International, legal code][cc-by-legal].

### Published findings cited in rationales

The findings cited in this document are listed in [`spec/evidence/FINDINGS.md`][reg], one table for each server. Each article also has a findings register; finding IDs refer to both. Versions are those the articles tested.

| Article | Server and version tested | Published |
|---|---|---|
| [GitHub MCP server audit][github] | github/github-mcp-server v2.1.0 | 9 November 2026 |
| [Grafana MCP server audit][grafana] | grafana/mcp-grafana v2.2.0 | 10 November 2026 |
| [PostHog MCP server audit][posthog] | PostHog/posthog `services/mcp` and the hosted server, November 2026 | 10 November 2026 |
| [Kubernetes MCP server audit][kubernetes] | containers/kubernetes-mcp-server v0.1.2 | 12 November 2026 |
| [Payload MCP plugin audit][payload] | @payloadcms/plugin-mcp 3.93.0 | 14 November 2026 |

Upstream statuses change. The articles carry the status of each issue and pull request and are updated; this document does not track them.

[cc-by]: https://creativecommons.org/licenses/by/4.0/
[cc-by-legal]: https://creativecommons.org/licenses/by/4.0/legalcode
[dco]: https://developercertificate.org/
[rfc2119]: https://www.rfc-editor.org/rfc/rfc2119
[rfc8174]: https://www.rfc-editor.org/rfc/rfc8174
[rfc9110]: https://www.rfc-editor.org/rfc/rfc9110
[rfc6902]: https://www.rfc-editor.org/rfc/rfc6902
[rfc7396]: https://www.rfc-editor.org/rfc/rfc7396
[rfc6585]: https://www.rfc-editor.org/rfc/rfc6585
[rfc9413]: https://www.rfc-editor.org/rfc/rfc9413
[aip-134]: https://google.aip.dev/134
[aip-154]: https://google.aip.dev/154
[aip-155]: https://google.aip.dev/155
[rfc9457]: https://www.rfc-editor.org/rfc/rfc9457
[rfc6901]: https://www.rfc-editor.org/rfc/rfc6901
[aip-193]: https://google.aip.dev/193
[jsonapi-errors]: https://jsonapi.org/format/#errors
[mcp-issue-569]: https://github.com/modelcontextprotocol/modelcontextprotocol/issues/569
[mcp-issue-3003]: https://github.com/modelcontextprotocol/modelcontextprotocol/issues/3003
[sep-2145]: https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2145
[sep-2848]: https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2848
[oasis-rr]: https://docs.oasis-open.org/odata/repeatable-requests/v1.0/repeatable-requests-v1.0.html
[jepsen]: https://jepsen.io/analyses
[elle]: https://www.vldb.org/pvldb/vol14/p268-alvaro.pdf
[json-schema-core]: https://json-schema.org/draft/2020-12/json-schema-core
[json-schema-validation]: https://json-schema.org/draft/2020-12/json-schema-validation
[arxiv-2609-15397]: https://arxiv.org/abs/2609.15397
[arxiv-2609-29095]: https://arxiv.org/abs/2609.29095
[arxiv-2608-02645]: https://arxiv.org/abs/2608.02645
[ast-draft]: https://datatracker.ietf.org/doc/draft-jurkovikj-httpapi-agentic-state/
[gaikwad-draft]: https://datatracker.ietf.org/doc/draft-gaikwad-agent-friendly-http-api-profile/
[acp-checkout]: https://github.com/agentic-commerce-protocol/agentic-commerce-protocol/blob/main/rfcs/rfc.agentic_checkout.md
[mcp-rig]: https://github.com/gorkemgul/mcp-rig
[mcp-test-harness]: https://github.com/vaquarkhan/mcp-test-harness
[mcp-wallfacer]: https://github.com/lacausecrypto/mcp-wallfacer
[mcprobe]: https://github.com/alitiknazoglu/mcprobe
[agentsafe-scan]: https://ashutosh2308bhardwaj.github.io/agentsafe/mcp-retry-scan.html
[cosai-tool-design]: https://github.com/cosai-oasis/ws4-secure-design-agentic-systems/blob/main/practical-guides/mcp-secure-tool-design.md
[owasp-mcp-top10]: https://owasp.org/www-project-mcp-top-10/
[owasp-mcp-cheatsheet]: https://cheatsheetseries.owasp.org/cheatsheets/MCP_Security_Cheat_Sheet.html
[idem-draft]: https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/
[stripe-idem]: https://docs.stripe.com/api/idempotent_requests
[mcp-spec-2025]: https://modelcontextprotocol.io/specification/2025-11-25
[mcp-spec-2026]: https://modelcontextprotocol.io/specification/2026-07-28
[mcp-tools-2025]: https://modelcontextprotocol.io/specification/2025-11-25/server/tools
[mcp-tools-2026]: https://modelcontextprotocol.io/specification/2026-07-28/server/tools
[mcp-schema-2025]: https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2025-11-25/schema.ts
[mcp-schema-2026]: https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2026-07-28/schema.ts
[mcp-changelog-2026]: https://modelcontextprotocol.io/specification/2026-07-28/changelog
[mcp-lifecycle]: https://modelcontextprotocol.io/community/feature-lifecycle
[mcp-conformance]: https://github.com/modelcontextprotocol/conformance
[mcp-ann-ig]: https://github.com/modelcontextprotocol/experimental-ext-tool-annotations/issues/10
[mcp-ann-group]: https://modelcontextprotocol.io/community/interest-groups/tool-annotations
[sep-1303]: https://modelcontextprotocol.io/seps/1303-input-validation-errors-as-tool-execution-errors
[sep-2484]: https://modelcontextprotocol.io/seps/2484-conformance-tests-required-for-final-seps
[mcp-issue-3394]: https://github.com/modelcontextprotocol/modelcontextprotocol/issues/3394
[sep-3182]: https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3182
[mcp-servers-4721]: https://github.com/modelcontextprotocol/servers/issues/4721
[mcp-mrtr]: https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr
[mcp-stdio-2026]: https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio
[sep-2575]: https://modelcontextprotocol.io/seps/2575-stateless-mcp
[mcp-tasks]: https://modelcontextprotocol.io/extensions/tasks/overview
[mcp-ann-blog]: https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/
[reg]: evidence/FINDINGS.md
[reg-github]: evidence/FINDINGS.md#github-mcp-server
[reg-grafana]: evidence/FINDINGS.md#grafana-mcp-server
[reg-posthog]: evidence/FINDINGS.md#posthog-mcp-server
[reg-kubernetes]: evidence/FINDINGS.md#kubernetes-mcp-server
[reg-payload]: evidence/FINDINGS.md#payload-mcp-plugin
[github]: https://isokron.ai/research/github-mcp-server-audit?utm_source=mws-spec&utm_medium=spec#findings-register
[github-other]: https://isokron.ai/research/github-mcp-server-audit?utm_source=mws-spec&utm_medium=spec#other-observations
[github-held]: https://isokron.ai/research/github-mcp-server-audit?utm_source=mws-spec&utm_medium=spec#what-held-up
[github-benchmark]: https://isokron.ai/research/github-mcp-server-audit?utm_source=mws-spec&utm_medium=spec#benchmark-what-fixing-the-friction-changes
[github-catalog]: https://isokron.ai/research/github-mcp-server-audit?utm_source=mws-spec&utm_medium=spec#catalog-size
[grafana]: https://isokron.ai/research/grafana-mcp-server-audit?utm_source=mws-spec&utm_medium=spec#findings-register
[grafana-held]: https://isokron.ai/research/grafana-mcp-server-audit?utm_source=mws-spec&utm_medium=spec#what-held-up
[posthog]: https://isokron.ai/research/posthog-mcp-server-audit?utm_source=mws-spec&utm_medium=spec#findings-register
[posthog-held]: https://isokron.ai/research/posthog-mcp-server-audit?utm_source=mws-spec&utm_medium=spec#what-held-up
[kubernetes]: https://isokron.ai/research/kubernetes-mcp-server-audit?utm_source=mws-spec&utm_medium=spec#findings-register
[kubernetes-held]: https://isokron.ai/research/kubernetes-mcp-server-audit?utm_source=mws-spec&utm_medium=spec#what-held-up
[kubernetes-addendum]: https://isokron.ai/research/kubernetes-mcp-server-audit?utm_source=mws-spec&utm_medium=spec#addendum-conflict-recovery
[kubernetes-forced]: https://isokron.ai/research/kubernetes-mcp-server-audit?utm_source=mws-spec&utm_medium=spec#forced-apply-and-lost-updates-upstreams-choice-measured-not-filed
[payload]: https://isokron.ai/research/payload-mcp-server-audit?utm_source=mws-spec&utm_medium=spec#payload-findings
[payload-held]: https://isokron.ai/research/payload-mcp-server-audit?utm_source=mws-spec&utm_medium=spec#what-held-up
[payload-conflict]: https://isokron.ai/research/payload-mcp-server-audit?utm_source=mws-spec&utm_medium=spec#conflict-recovery
[gh-3473]: https://github.com/github/github-mcp-server/issues/3473
[gh-3473-comment]: https://github.com/github/github-mcp-server/issues/3473#issuecomment-6733642840
[gh-3747]: https://github.com/github/github-mcp-server/issues/3747
[gh-3748]: https://github.com/github/github-mcp-server/issues/3748
[gh-3751]: https://github.com/github/github-mcp-server/issues/3751
[gh-3755]: https://github.com/github/github-mcp-server/issues/3755
[gh-3756]: https://github.com/github/github-mcp-server/issues/3756
[gh-3757]: https://github.com/github/github-mcp-server/issues/3757
[gh-3759]: https://github.com/github/github-mcp-server/issues/3759
[gh-3760]: https://github.com/github/github-mcp-server/issues/3760
[gh-3761]: https://github.com/github/github-mcp-server/issues/3761
[gh-3762]: https://github.com/github/github-mcp-server/issues/3762
[gh-pr-3781]: https://github.com/github/github-mcp-server/pull/3781
[gf-pr-1518]: https://github.com/grafana/mcp-grafana/pull/1518
[gf-pr-1519]: https://github.com/grafana/mcp-grafana/pull/1519
[gf-pr-1520]: https://github.com/grafana/mcp-grafana/pull/1520
[gf-pr-1521]: https://github.com/grafana/mcp-grafana/pull/1521
[ph-pr-131514]: https://github.com/PostHog/posthog/pull/131514
[ph-pr-131620]: https://github.com/PostHog/posthog/pull/131620
[k8s-1584]: https://github.com/containers/kubernetes-mcp-server/issues/1584
[k8s-1658]: https://github.com/containers/kubernetes-mcp-server/issues/1658
[k8s-1659]: https://github.com/containers/kubernetes-mcp-server/issues/1659
[k8s-1660]: https://github.com/containers/kubernetes-mcp-server/issues/1660
[k8s-1662]: https://github.com/containers/kubernetes-mcp-server/issues/1662
[k8s-1663]: https://github.com/containers/kubernetes-mcp-server/issues/1663
[k8s-1665]: https://github.com/containers/kubernetes-mcp-server/issues/1665
[k8s-1666]: https://github.com/containers/kubernetes-mcp-server/issues/1666
[k8s-1668]: https://github.com/containers/kubernetes-mcp-server/issues/1668
[k8s-1669]: https://github.com/containers/kubernetes-mcp-server/issues/1669
[k8s-1670]: https://github.com/containers/kubernetes-mcp-server/issues/1670
[pay-19435]: https://github.com/payloadcms/payload/issues/19435
[pay-19591]: https://github.com/payloadcms/payload/issues/19591
[pay-pr-19592]: https://github.com/payloadcms/payload/pull/19592
