# Comments on MWS 0.9: disposition log

This file records every comment received on version 0.9 of the MCP Write-Safety Requirements (MWS) and what was decided about it. Section 1 of the specification says that every comment gets a recorded disposition, and one of the criteria for publishing 1.0 is that every comment received has a published disposition. This log is where they are published.

## The comment window

Comments are open from 16 November 2026 to 16 December 2026 (section 1 of [`mws.md`](mws.md)). A comment made after 16 December is still read and still gets a disposition here; it may be considered for a version after 1.0.

## How to comment

- **As an issue in this repository.** The form "Comment on MWS 0.9" asks for the requirement, the kind of comment, the comment itself, and optionally proposed text and a link to evidence. The form is a convenience: a comment needs no particular form, and an ordinary issue is equally welcome.
- **By email**, to comments@isokron.ai, for anyone without a GitHub account. We copy each emailed comment into a public issue, with your permission, and record its disposition. If you do not give permission, we record the disposition here under a reference number (`E-1`, `E-2`, ...), without your name and without the text of your comment.
- **As a proposal**, for anyone who wants to write the change: a pull request under `spec/proposals/`, as [`CONTRIBUTING.md`](../CONTRIBUTING.md) describes. You need not do this. Where a comment leads to a change, the steward prepares it (section 1 of the specification).

Do not report a vulnerability as a comment. See the Security section of [`CONTRIBUTING.md`](../CONTRIBUTING.md#security).

## Dispositions

Each comment gets one of these:

| Disposition | Meaning |
|---|---|
| Accepted | The text changes as the comment asks. |
| Accepted with changes | The text changes in answer to the comment, but not in the way it proposed. The reasons say how and why. |
| Declined | The text does not change. The reasons say why. |
| Deferred to 1.0 | The point stays open after the window and is decided while 1.0 is prepared. The reasons say what is needed to decide it. |
| Duplicate | The same point was made in an earlier comment. The record links that comment, and its disposition applies. |
| Answered, no change | A question that has been answered, or a point the text already covers. The reply says where. |

A disposition records:

- the issue (or the email reference);
- the requirement the comment is about, or "General";
- the disposition;
- the reasons, in a sentence or two, with a link to the reply on the issue;
- the resulting commit, where the text changed;
- the date of the disposition.

A change to the text that a comment leads to goes through the change process of section 14 of the specification. It has its own comment period (at least 14 days for a new requirement or a change of level, at least 7 days for a clarification), which can run past 16 December, and the decision and its reasons are recorded in [`DECISIONS.md`](DECISIONS.md). Requirement IDs are never renumbered or reused. A comment stays open in this log until its disposition is recorded.

## Triage

The steward, IsoKron, reads and labels new comments every day in the first week of the window (16 to 22 November 2026) and twice a week after that until the window closes. Each new comment gets a reply on its issue, with a label for its area of the specification (`area:conc`, `area:res` and so on) and, once it is decided, a `disposition:` label. A comment waiting for a reply carries the label `triage:needs-reply`.

Every week of the window we add a short summary below: comments received, dispositions recorded and comments still open.

## Log

| # | Issue | Requirement | Disposition | Reasons | Resulting commit | Date |
|---|---|---|---|---|---|---|

## Weekly summaries

None yet.
