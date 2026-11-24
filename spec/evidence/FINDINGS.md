# Findings register

This file lists the published findings that `spec/mws.md` cites, one table for each server. It is part of the MCP Write-Safety Requirements and is licensed under CC BY 4.0 (see `LICENSE-spec`).

Every finding in this file was found and reproduced by the steward, IsoKron, which sells audits and builds of MCP servers and so has a commercial interest in the subject (section 15.1 of `spec/mws.md`). This file does not record whether a project's maintainers have confirmed or answered a report; the linked issues and the articles carry that. "The current stable release" in a row means the release that was current when version 0.9 of the specification was written.

Each row gives the finding ID, a one-line statement, the trial counts where the article states them, the upstream issue or pull request where one exists, and where `spec/mws.md` cites the finding. The register holds what the published article states for each finding that `spec/mws.md` cites. The linked article has the method and the full detail. Observations that an article makes without a finding ID are cited in `spec/mws.md` by a link to the article and are not listed here.

A finding is cited as evidence that a failure occurs in practice, not as a statement about the cited project's current release. Upstream statuses change; the articles carry the status of each issue and pull request, and this file does not track them. Where a row says "not yet reported upstream", that is the steward's statement as of 14 November 2026.

A maintainer of a cited project may ask, by an issue in this repository, for a dated note beside any row of this register that states the project's position, for example "intended", "disputed" or "fixed in version x". The steward adds the note in the project's words, as an erratum (section 14.6 of `spec/mws.md`).

## GitHub MCP server

Server and version tested: github/github-mcp-server v2.1.0. Article published 9 November 2026: [findings register in the article](https://isokron.ai/research/github-mcp-server-audit?utm_source=mws-spec&utm_medium=spec#findings-register).

| ID | Statement | Trials | Upstream | Cited under |
|---|---|---|---|---|
| GH-01 | Two calls that updated different issue fields lost one change while both reported success. The tool rewrote every issue-field value in order to change one. | 19 of 30 pairs lost a change; the platform's per-field update lost 0 of 28. | [issue 3751](https://github.com/github/github-mcp-server/issues/3751); proposed fix [pull request 3781](https://github.com/github/github-mcp-server/pull/3781) | MWS-UPD-1, MWS-CONC-3, NF-9, Annex B-1 |
| GH-02 | A file-delete tool took no version and deleted content written after the caller's read. | none stated | [issue 3757](https://github.com/github/github-mcp-server/issues/3757) | MWS-CONC-2 |
| GH-03 | A file-delete tool given a folder path deleted the whole folder and reported success. | none stated | [issue 3757](https://github.com/github/github-mcp-server/issues/3757) | MWS-TGT-2 |
| GH-04 | When a push created a new branch and then failed, the branch was left behind. | none stated | [issue 3755](https://github.com/github/github-mcp-server/issues/3755) | MWS-ATOM-1 |
| GH-05 | An edit stayed applied although the call reported an error. When a pull request was created and a later step of the same call failed, the call returned an error and the new pull request's number and URL were lost. | none stated | [issue 3756](https://github.com/github/github-mcp-server/issues/3756) | MWS-RES-2, MWS-RES-3 |
| GH-06 | An update that skipped an empty title or body returned success with nothing changed. Misspelled or unknown parameters were dropped and success was returned. | none stated | [issue 3759](https://github.com/github/github-mcp-server/issues/3759) | MWS-RES-1, MWS-IN-2, MWS-IN-7 |
| GH-07 | A feature-flagged tool that replaces an issue's labels was annotated `destructiveHint: false`. | none stated | [issue 3760](https://github.com/github/github-mcp-server/issues/3760) | MWS-ANN-5 |
| GH-08 | A read-only environment variable (and a second safety setting parsed the same way) was parsed so that values such as `yes`, `on` or a typo left the mode off, visible only in one start-up log line, while the equivalent command-line flag rejected such values. | none stated | [issue 3747](https://github.com/github/github-mcp-server/issues/3747) | MWS-CFG-1 |
| GH-09 | Directory listings put tokenized download URLs for a private repository into the model's context. The source is the platform API's response, passed on by the server. | none stated | [issue 3748](https://github.com/github/github-mcp-server/issues/3748) | MWS-SEC-1 |
| GH-10 | Configuration typos were handled inconsistently, and misspelled entries in an exclusion list were silent. | none stated | [issue 3761](https://github.com/github/github-mcp-server/issues/3761) | MWS-CFG-2 |
| GH-12 | Advertised page bounds were not enforced on four tools, and out-of-range values were forwarded to the backend. | none stated | [issue 3762](https://github.com/github/github-mcp-server/issues/3762) | MWS-IN-3 |
| GH-13 | An out-of-range value returned a raw decode error with internal type names. | none stated | [issue 3762](https://github.com/github/github-mcp-server/issues/3762) | MWS-IN-4 |
| GH-15 | A multi-file push had no head check, and a stale push reverted a change to the same path. | none stated | [issue 3473](https://github.com/github/github-mcp-server/issues/3473) was opened by others and is about tool descriptions; the audit's reproduction is [a comment on it](https://github.com/github/github-mcp-server/issues/3473#issuecomment-6733642840) | MWS-CONC-2 |

## Grafana MCP server

Server and version tested: grafana/mcp-grafana v2.2.0. Article published 10 November 2026: [findings register in the article](https://isokron.ai/research/grafana-mcp-server-audit?utm_source=mws-spec&utm_medium=spec#findings-register).

| ID | Statement | Trials | Upstream | Cited under |
|---|---|---|---|---|
| GF-01 | Dashboard patch saves forced an overwrite, so the version check in the platform's save API never ran. The article states that the control for simultaneous saves is not clean, because saves sent straight to the platform API also lost an edit. | The platform API rejected a stale save in 10 of 10 trials. 30 of 30 simultaneous pairs lost an edit through the tool. Simultaneous saves sent straight to the platform API lost an edit in 30 of 30 pairs on one platform version and 20 of 30 on another. | proposed fix [pull request 1518](https://github.com/grafana/mcp-grafana/pull/1518) | MWS-CONC-1, MWS-CONC-3 |
| GF-02 | Patch paths addressed dashboard panels by array index only. After another writer inserted a panel, the edit hit the wrong panel. | 5 of 5 trials. | proposed fix [pull request 1521](https://github.com/grafana/mcp-grafana/pull/1521) | MWS-UPD-2 |
| GF-03 | An alert-rule update rebuilt the whole rule, and omitted optional fields were reset. The tool's description called the update a full replace while its schema marked the fields optional. | 3 of 3 trials. | proposed fix [pull request 1519](https://github.com/grafana/mcp-grafana/pull/1519) | MWS-UPD-1 |
| GF-08 | A `replace` on a key that does not exist stored a stray key, and a no-op `remove` on a key that does not exist was accepted. | Both in 3 of 3 trials. | proposed fix [pull request 1521](https://github.com/grafana/mcp-grafana/pull/1521) | Guidance to MWS-RES-1 |
| GF-11 | A snapshot-creating tool declared `openWorldHint: false`. The article records that this was corrected upstream. | none stated | corrected in upstream [pull request 1511](https://github.com/grafana/mcp-grafana/pull/1511), by a maintainer | Guidance to MWS-ANN-4 |
| GF-18 | Advertised minimum bounds were not enforced (found by code reading only). | Not run. | proposed fix [pull request 1521](https://github.com/grafana/mcp-grafana/pull/1521) | MWS-IN-3 |
| GF-19 | A full-body save copied the current resource version onto the caller's body, so a body read earlier replaced an intervening edit. | 3 of 3 trials; a direct request with the stale version was refused with HTTP 409 in 3 of 3. | proposed fix [pull request 1518](https://github.com/grafana/mcp-grafana/pull/1518) | MWS-CONC-2, NF-6 |
| B1, B2 | Usability changes, not findings: returning the applied operations and the stored object saved a verify read after a write. | none stated | proposed in [pull request 1520](https://github.com/grafana/mcp-grafana/pull/1520) | MWS-RES-4 |

## PostHog MCP server

Server and version tested: PostHog/posthog `services/mcp` and the hosted server, November 2026. Article published 10 November 2026: [findings register in the article](https://isokron.ai/research/posthog-mcp-server-audit?utm_source=mws-spec&utm_medium=spec#findings-register).

| ID | Statement | Trials | Upstream | Cited under |
|---|---|---|---|---|
| C1 | One of two simultaneous changes was lost. The loss occurred in the platform API, not the MCP layer. | Insights: 7 of 11 pairs through the server and 6 of 11 straight to the platform API. | fixed by a maintainer for one resource in [pull request 131620](https://github.com/PostHog/posthog/pull/131620) | MWS-CONC-3, NF-1 |
| G1 | Generated patch tools added nested schema defaults the caller did not send. | none stated | none stated | MWS-UPD-1 |
| X1 | Generated schemas read the string `"false"` as true and `null` as 0. | none stated | [pull request 131514](https://github.com/PostHog/posthog/pull/131514) | MWS-IN-1, MWS-IN-6 |
| R6 | Read-only mode was decided by an annotation that some tools set loosely (found by code reading, not called live). The article classes this as a design gap. | Not run. | none stated | MWS-CFG-3, MWS-ANN-1 |
| J1 | A backend response with a success status and an unreadable body was returned as a successful result. The article classes this as an incomplete result. | none stated | none stated | Guidance to MWS-RES-4 |
| R2 | One tool response was very large. | About 225,000 tokens (an estimate) in one response. | covered by a maintainer's draft [pull request 129174](https://github.com/PostHog/posthog/pull/129174) | Annex A, item A-3 |
| L2 | Two descriptions named tools that were not in the catalog. | none stated | none stated | Annex A, item A-4 |

## Kubernetes MCP server

Server and version tested: containers/kubernetes-mcp-server v0.1.2. Article published 12 November 2026: [findings register in the article](https://isokron.ai/research/kubernetes-mcp-server-audit?utm_source=mws-spec&utm_medium=spec#findings-register).

| ID | Statement | Trials | Upstream | Cited under |
|---|---|---|---|---|
| K8S-01 | A multi-document apply stopped at the first refusal and did not say what had already been applied. | 3 of 3 trials, for each of four failure shapes. | [issue 1660](https://github.com/containers/kubernetes-mcp-server/issues/1660) | MWS-ATOM-1 |
| K8S-02 | A tool annotated non-destructive force-applied over an existing object with the same port, replacing parts of it. The steward's follow-up on the upstream issue leaves the annotation and the behavior on an existing object to the maintainers as a design decision. | 3 of 3 trials. | [issue 1662](https://github.com/containers/kubernetes-mcp-server/issues/1662) | MWS-ANN-2 |
| K8S-03 | A delete reported success when the deletion of its companion object was refused. | 3 of 3 trials. | [issue 1665](https://github.com/containers/kubernetes-mcp-server/issues/1665) | MWS-ATOM-1 |
| K8S-04 | A delete sent no precondition and deleted an object recreated after the caller's read. The article classes this as a design gap and notes that the platform's command-line tool sends no such precondition either. | 10 of 10 trials. | none stated | MWS-CONC-2 |
| K8S-05 | A client timeout hid the outcome of an install. The article classes this as a design gap. | 10 of 10 calls hit a 60-second client limit. | related upstream [pull request 1334](https://github.com/containers/kubernetes-mcp-server/pull/1334), by others | MWS-RETRY-1 |
| K8S-06, K8S-15 | Some document separators caused later documents to be dropped while the call reported success. | 3 of 3 trials for each separator shape. | [issue 1659](https://github.com/containers/kubernetes-mcp-server/issues/1659) | MWS-ATOM-1 |
| K8S-07 | Write results included bookkeeping metadata that the server's reads strip. | 766 of 2,194 bytes. | [issue 1669](https://github.com/containers/kubernetes-mcp-server/issues/1669) | Annex A, item A-3 |
| K8S-08 | A create tool given the name of an existing virtual machine overwrote it and answered "created successfully", where a create sent to the platform API returns HTTP 409. The steward's follow-up on the upstream issue says that the overwrite may be an intended upsert and leaves the choice to the maintainers. | 3 of 3 trials. | [issue 1663](https://github.com/containers/kubernetes-mcp-server/issues/1663) | MWS-TGT-3 |
| K8S-09 | Wrongly typed values for two arguments were dropped silently. The article notes ignored unknown arguments as a design gap. | 3 of 3 trials for each argument. | comment on [issue 1584](https://github.com/containers/kubernetes-mcp-server/issues/1584), an issue opened by others | MWS-IN-1, MWS-IN-2, MWS-IN-6 |
| K8S-10 | A delete answered "deleted successfully" while a finalizer held the object. The article classes this as a design gap. | 3 of 3 trials. | none stated | MWS-RES-1, NF-11, NF-19 |
| K8S-12 | A clone tool annotated idempotent created a new clone on every call. | 3 of 3 trials. | [issue 1670](https://github.com/containers/kubernetes-mcp-server/issues/1670) | MWS-ANN-3 |
| K8S-14 | Misspelled names in the enabled and disabled tool lists were accepted silently. | 3 server starts per case. | [issue 1668](https://github.com/containers/kubernetes-mcp-server/issues/1668) | MWS-CFG-2, MWS-CFG-4 |
| K8S-17 | An uninstall of a release that does not exist returns success. This is intended upstream and asserted by an upstream test. | none stated | none stated | NF-5 |
| K8S-17N | An uninstall whose lookup was refused for lack of permission answered "not found" as a success. The article notes that this finding has weaker validation than the others. | none stated | [issue 1666](https://github.com/containers/kubernetes-mcp-server/issues/1666) | MWS-RES-2 |
| K8S-20 | An install tool given a namespace left its release record there but sent the chart's objects to the default namespace of the server's configuration, where the install then failed for lack of permission. The platform's own command-line tool put everything in the named namespace. The case in which such an install reports success follows from the code and was not run. | 3 of 3 trials. | [issue 1658](https://github.com/containers/kubernetes-mcp-server/issues/1658) | MWS-TGT-1 |

## Payload MCP plugin

Server and version tested: @payloadcms/plugin-mcp 3.93.0. Article published 14 November 2026: [findings register in the article](https://isokron.ai/research/payload-mcp-server-audit?utm_source=mws-spec&utm_medium=spec#payload-findings).

| ID | Statement | Trials | Upstream | Cited under |
|---|---|---|---|---|
| PAY-01 | The update tool wrote through another user's document lock because its override defaulted to on. With the override switched off, the refusal came back as plain text without `isError`. | Wrote through the lock in 10 of 10 trials, while the REST API refused with HTTP 423 in 10 of 10. The refusal lacked `isError` in 3 of 3 trials. | [issue 19591](https://github.com/payloadcms/payload/issues/19591) | MWS-CONC-1, MWS-CONC-4, NF-7 |
| PAY-02 | The delete tool had no override argument and deleted a locked document. | 10 of 10 trials, while the REST API refused with HTTP 423 in 10 of 10. | [issue 19591](https://github.com/payloadcms/payload/issues/19591) | MWS-CONC-1 |
| PAY-03 | Update and delete with an empty filter matched every document. The article classes this as a design gap. | Deleted 20 of 20 documents; the REST API given no filter answered HTTP 400 in 5 of 5 trials. | none stated | MWS-TGT-2 |
| PAY-04 | Fields named like tool arguments were not stored, and the tool returned success text. (on the 3.x line, which is the current stable release; the article's re-run on the 4.0 beta line found it fixed in 5 of 5 trials) | 5 of 5 trials. | raised as a 3.x question in [issue 19591](https://github.com/payloadcms/payload/issues/19591) | MWS-RES-1 |
| PAY-05 | Bulk update and delete reported success with no `isError` when some documents failed, while the REST API answered HTTP 400 with the errors. | 5 of 5 trials. | [issue 19591](https://github.com/payloadcms/payload/issues/19591); proposed fix [pull request 19592](https://github.com/payloadcms/payload/pull/19592) (the bulk delete only) | MWS-RES-2, MWS-ATOM-1 |
| PAY-06 | Accepting row identifiers stopped an array edit in one locale from losing the row's values in other locales. | Lost in 5 of 5 trials; with row identifiers, kept in 5 of 5. | an upstream issue reported by others, [issue 19435](https://github.com/payloadcms/payload/issues/19435) | Guidance to MWS-UPD-2 |
| PAY-07 | A 21-byte update answered with 384 bytes. | none stated | none stated | Annex A, item A-3 |
| PAY-08 | No tool carried annotations on the 3.x release line, which is the current stable release (annotations are present on the 4.0 beta line). | 0 of 12 tools. | raised as a 3.x question in [issue 19591](https://github.com/payloadcms/payload/issues/19591) | MWS-ANN-4 |
| PAY-09 | Stale writes were accepted with no signal on every surface of the platform. The article classes this as a gap in the platform's core and not in the MCP layer, and says the MCP layer can mitigate it with a best-effort check. | none stated | platform behavior, not yet reported upstream | MWS-CONC-2, MWS-CONC-5, Annex B-3 |
| PAY-10 | The REST API lost one of two simultaneous partial updates. The article classes this as platform behavior, not an MCP finding. | 10 of 10 pairs. | platform behavior, not yet reported upstream | MWS-CONC-3, NF-1 |
| PAY-11 | Argument names the advertised schema forbids were stripped without a word, and an update with only a misspelled argument answered success and changed nothing. (on the 3.x line, which is the current stable release; not present on the 4.0 beta line by the article's reading of the source, not run) | 4 of 79 fuzz cases. | none stated | MWS-IN-2, MWS-IN-7 |
| PAY-12 | Schemas omitted the fields' limits, so values valid by the schema were refused. The article classes this as a design gap. | 9 of 79 fuzz cases. | none stated | MWS-IN-5, NF-13 |
| PAY-13 | A validation refusal named the field but dropped the reason the REST API gives, with no `isError`. (on the 3.x line, which is the current stable release; not present on the 4.0 beta line by the article's reading of the source, not run) | 12 fuzz cases. | none stated | MWS-IN-4 |
