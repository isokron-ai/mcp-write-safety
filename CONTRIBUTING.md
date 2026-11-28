# Contributing

This repository holds the MCP Write-Safety Requirements (MWS) under `spec/`, a preview of the test tool, and the sample server. This file says how to propose a change to the specification. The rules are also in section 14 of `spec/mws.md`; if the two differ, the specification governs.

## Status

MWS is at version 0.9, a draft. During the comment window that follows its publication, comments on any part of the text are welcome as issues. Every comment gets a recorded disposition, published in [`spec/COMMENTS-0.9.md`](spec/COMMENTS-0.9.md). A comment that asks for a change to a requirement is most useful when it follows the proposal form below.

## Proposing a change

Anyone may propose a change. A proposal is a pull request that adds one file, `spec/proposals/NNNN-short-title.md`, where `NNNN` is the next free number. The file has four parts, and a proposal without all four is not reviewed.

1. **A public, reproducible case.** A link to a published finding or an upstream issue, or a failing case on the sample server. Findings cited in the specification are listed in `spec/evidence/FINDINGS.md`; a proposal that cites a new finding adds its row there. A requirement has to answer to something that has happened. Private reports and unpublished findings are not accepted as cases.
2. **The normative sentence.** One sentence, using MUST or SHOULD, and the condition under which it applies. For a change to an existing requirement, give the old and the new sentence.
3. **The test method.** Black-box, proxy-assisted or review-only, with the procedure in prose, and the verdicts it can produce. Every record states its method and its modifiers (launch; control arm), as section 7.1 of the specification requires, so say which modifiers the test uses.
4. **A false-positive analysis.** When the test must not report `violated`: behavior that looks like the defect and is not, and behavior the platform API shows as well. If this adds an entry to the non-findings chapter, give its text.

A proposal to lower, narrow or withdraw a requirement gives, in place of part 1, a case in which the requirement gives a server a verdict that is wrong or that the server cannot avoid, and, in place of part 3, the change to the test.

Comment periods: at least 14 days for a new requirement or a change of level, at least 7 days for a clarification. A rewording or withdrawal of a requirement marked at risk, made because the MCP specification clarified, needs no comment period (section 6 of the specification). Raising its level is a change of level and needs one.

Until the project has a maintainer from outside the steward, a change is accepted by the steward after the comment period, and the decision and its reasons are recorded. From then on, acceptance needs two maintainer approvals, and one of the two approvals for any change to a MUST comes from outside the steward. How a person becomes a maintainer is not yet defined; the steward will propose a rule during the comment window, and will appoint no maintainer by another route.

A proposal from the maintainers of a server about that server's own behavior is welcome. Please say so in the proposal; it will be labeled as such.

## The four-part rule

An accepted change lands as one pull request that contains all four of:

1. **the text**: the change to `spec/mws.md`;
2. **a test**: the check in the test suite that decides the requirement;
3. **a defect**: a switchable defect in the sample server that the test detects;
4. **the fixed build passing**: the corrected sample server, on which the test reports no violation.

A requirement does not leave `draft` until it has been shown failing on the sample server and no longer failing on the corrected one. In 0.9 every requirement is `draft`, including those the preview test tool already tests, and none leaves `draft` before the comment window has closed.

While the test suite and the sample server are being built, parts 2 to 4 cannot be supplied for every requirement. Until the first release of the suite, a change to the specification carries the text and the written test procedure, and the pull request says which of parts 2 to 4 are outstanding. From the first release of the suite onward the rule applies in full.

## Other rules

- **IDs are stable.** Do not renumber or reuse a requirement ID or a non-finding ID. When a requirement is split, the part that stays keeps its ID and each new part gets a new ID. A removed requirement is marked retired: it keeps its entry, with the status `removed`. The number of requirements is not fixed; it is the number of entries.
- **Neutral wording.** Requirement text says "a tool" and "a server". Project names appear only where a citation needs them: in rationales, in the non-findings chapter, in the limitations section, in the annexes and in the references.
- **No aggregates.** Do not add scores, levels, profiles, badges, totals or a "pass" verdict, to the text or to any output format.
- **Record the decision.** Each accepted or rejected proposal gets an entry in `spec/DECISIONS.md` with the reason.
- **Errata.** A correction that does not change what a requirement asks (a typo, a broken link, a wrong citation) is an ordinary pull request and needs one approval.

## Sign-off (DCO)

Contributions are accepted under the [Developer Certificate of Origin 1.1](https://developercertificate.org/). There is no contributor licence agreement. Every commit needs a line

```
Signed-off-by: Your Name <your.email@example.com>
```

which `git commit -s` adds. The DCO applies to the steward's own commits as well. By signing off you state that you have the right to submit the work under the licence of the file you are changing: CC BY 4.0 for the text under `spec/` (see `LICENSE-spec`), Apache-2.0 for code.

## Security

Do not open a public issue for a vulnerability in the test suite or the sample server, and do not use this repository to report a vulnerability in someone else's server. Report the former privately to the maintainers, through GitHub's private vulnerability reporting on this repository ([Security, Report a vulnerability](https://github.com/isokron-ai/mcp-write-safety/security/advisories/new)), and the latter to the project concerned.

## Conduct

Be direct and courteous. Criticize texts and tests, not people or projects.

## Checking that a test fails when its guard is removed (mutation probes)

Do not clone the repository to check this by hand: run the `mutation-probe` workflow (Actions, or
`gh workflow run mutation-probe.yml -R isokron-ai/mcp-write-safety -f ref=<branch-or-sha> -f test='cd packages/writecheck && npm run build && node --test dist/test/unit/<file>.test.js' -f mutations='[...]'`).
It calls isokron-ai/tool-qa's reusable workflow. Each mutation is `{"id", "file", "find", "replace"}`
(and optionally its own `test` and `pattern`): `find` must be exact text that occurs exactly once in `file`, for example
a guard in `packages/writecheck/src/`. Every mutation runs in a fresh checkout of `ref`: the test must pass first, then it
runs again with the edit applied. The job summary lists each mutation as `killed` (the test failed, as it must),
`survived` or `stale` (`find` is not there exactly once), and the `mutation-probe-results` artifact holds the same as
JSON. The run fails if any mutation survived or is stale. At most 20 mutations per run; read-only, no secrets.
The tests here run from the built `dist/`, so the test command must build first (as above): the default `build`
installs `packages/writecheck` and builds it once, and each mutation then needs `npm run build` before its test.
