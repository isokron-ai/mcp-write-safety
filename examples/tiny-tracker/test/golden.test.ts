// The first sentence is worded by the MCP Write-Safety kits' rules: test/golden/first-sentence.json is the kits' shared
// golden file, byte for byte, and tiny-tracker's renderer (src/mcp/text.ts) must give each of its sentences. A conflict
// gives the same sentence with and without the shape, and never restates the state (B-9, "Text"; MWS-CONC-6).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderText, type TextOptions } from "../src/mcp/text.js";
import { conflict, type WriteResult } from "../src/mcp/results.js";

const cases = JSON.parse(readFileSync(new URL("../../test/golden/first-sentence.json", import.meta.url), "utf8")) as Array<{ name: string; shape: WriteResult; options: TextOptions; text: string }>;

for (const c of cases) {
  test(`golden first sentence (shared with the kits): ${c.name}`, () => {
    assert.equal(renderText(c.shape, c.options), c.text);
  });
}

test("a conflict: one sentence with and without the shape; the state is in the JSON block only", () => {
  const current = { version: 3, title: "Quarterly report", assignee: "ann", comments: [{ id: "C-1" }] };
  const w = { operation: "update", type: "ticket", id: "T-1", guard: "version" as const, read: { tool: "get_ticket", arguments: { id: "T-1" } }, versionArgument: "expected_version" };
  const shaped = conflict("ticket T-1", current, w);
  const bare = conflict("ticket T-1", current);
  const text = (r: typeof shaped, i: number) => (r.content[i] as { text: string }).text;
  assert.equal(text(shaped, 0), "Not applied: ticket T-1 changed since the version you read. Nothing was changed.\nIts current state and version are in the JSON below.\nBefore writing again, read it with \"get_ticket\" and the arguments {\"id\":\"T-1\"} and build the write from what the read shows.");
  assert.equal(text(bare, 0), "Not applied: ticket T-1 changed since the version you read. Nothing was changed.\nIts current state and version are in the JSON below.\nBefore writing again, read the object and build the write from what the read shows.");
  for (const r of [shaped, bare]) {
    assert.doesNotMatch(text(r, 0), /ann|Quarterly/, "the sentence does not restate the state");
    assert.deepEqual(JSON.parse(text(r, 1)), JSON.parse(JSON.stringify(r.structuredContent)), "the JSON block is the serialized structuredContent");
    assert.equal((r.structuredContent as { current_version: number }).current_version, 3);
  }
  assert.equal(shaped.content.length, 2);
});
