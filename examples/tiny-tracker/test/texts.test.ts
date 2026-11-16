// P-8 (conflict-wording study, re-pilot 3, arm tt_p8_quoted; spec R12-1): the conflict and read texts give state values
// unambiguously: label names quoted as a JSON list, and the version on its own, under the name the write tools accept.

import assert from "node:assert/strict";
import { test } from "node:test";

import { conflict } from "../src/mcp/results.js";
import { listLine, showTicket } from "../src/mcp/tools/tickets.js";

const textOf = (r: { content: unknown }) => (r.content as Array<{ text: string }>)[0]!.text;

test("P-8 and D-7: a conflict never restates the state; the state, with label names as JSON strings, and the version on its own are in the JSON block", () => {
  const r = conflict("ticket T-3", { version: 3, title: "Docs", status: "open", assignee: null, priority: 3, labels: [{ name: "content" }, { name: "v3" }] } as never);
  assert.equal(textOf(r), "Not applied: ticket T-3 changed since the version you read. Nothing was changed.\nIts current state and version are in the JSON below.\nBefore writing again, read the object and build the write from what the read shows.");
  const block = JSON.parse((r.content as Array<{ text: string }>)[1]!.text) as { current_version: number; current: { labels: Array<{ name: string }> } };
  assert.deepEqual(block, r.structuredContent, "the second block mirrors structuredContent");
  assert.equal(block.current_version, 3);
  assert.deepEqual(block.current.labels.map((l) => l.name), ["content", "v3"]);
  assert.equal(r.isError, true);
});

test("P-8: get_ticket quotes the labels with their ids and gives the version on its own line", () => {
  const t = { id: "T-4", project: "docs", version: 4, title: "Docs", status: "open", priority: 2, assignee: "ann", labels: [{ name: "urgent", id: "L-1" }, { name: "v4", id: "L-2" }], comments: [] };
  const text = textOf(showTicket(t));
  assert.equal(text, 'T-4 in docs: "Docs" (status open, priority 2, assignee "ann", 0 comment(s))\nlabels: [{"name": "urgent", "id": "L-1"}, {"name": "v4", "id": "L-2"}]\ncurrent expected_version: 4');
  assert.ok(!/v4=L-2|urgent=L-1/.test(text));
  assert.match(textOf(showTicket({ ...t, labels: [] })), /\nlabels: \[\]\n/);
});

test("P-8: list_tickets quotes the title and gives the version on its own", () => {
  assert.equal(listLine({ id: "T-3", project: "docs", status: "open", title: "v4: release notes", version: 3 }), 'T-3 [docs] open "v4: release notes"; current expected_version: 3');
});

test("P-8: a label name with JSON-like characters stays quoted exactly; an assignee is quoted", () => {
  const t = { id: "T-5", project: "docs", version: 2, title: "x", status: "open", priority: 1, assignee: "none", labels: [{ name: "a},{b", id: "L-9" }], comments: [] };
  const text = textOf(showTicket(t));
  assert.match(text, /labels: \[\{"name": "a\},\{b", "id": "L-9"\}\]/);
  assert.match(text, /assignee "none"/, 'a user named none is not read as no assignee');
});
