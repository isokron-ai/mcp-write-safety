// The write-result shape (draft MWS Annex B-9, version 0.1): every write tool's result carries it in
// structuredContent.mws, on success and on error, and a further text block carries the serialized structuredContent.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { startStack, type Outcome, type Stack } from "./support/stack.js";

const OUTCOMES = ["applied", "not_applied", "partial", "unknown", "accepted"];
const REPEATS = ["no", "yes", "same_key", "same_version", "read_first"];

/** The members' forms as B-9 gives them; returns what is wrong. */
function problems(o: Outcome): string[] {
  const m = o.structured?.mws;
  if (!m) return ["no structuredContent.mws"];
  const p: string[] = [];
  if (m.shape !== "write-result/0.1") p.push(`shape ${m.shape}`);
  if (!OUTCOMES.includes(m.outcome)) p.push(`outcome ${m.outcome}`);
  if (m.repeat !== undefined && !REPEATS.includes(m.repeat)) p.push(`repeat ${m.repeat}`);
  const idv = (v: unknown) => typeof v === "string" || Number.isSafeInteger(v);
  if (m.object && (["type", "scope"].some((k) => k in m.object && typeof m.object[k] !== "string") || ["id", "version"].some((k) => k in m.object && !idv(m.object[k])))) p.push("object members");
  if (m.object?.version !== undefined && typeof m.object.version !== "number") p.push("versions are integers here, as the tools' expected_version takes them");
  if (m.changed && !m.changed.every((c: string) => c.startsWith("/"))) p.push("changed is not JSON Pointers");
  if (m.conflict && "current_version" in m.conflict && typeof m.conflict.current_version !== "number") p.push("conflict.current_version");
  if (m.conflict && "version_source" in m.conflict) p.push("version_source (v2: checked_by)");
  if (m.outcome === "applied" && m.repeat === "yes") p.push("repeat yes after applied");
  if (m.code === "conflict" && m.repeat !== "read_first") p.push("a conflict without read_first");
  if ((m.items ?? []).some((it: any) => !("index" in it) && !("step" in it) && !("id" in it))) p.push("an item with neither index, step nor id");
  if (m.read_with && (typeof m.read_with.tool !== "string" || typeof m.read_with.arguments !== "object")) p.push("read_with");
  if (m.code !== undefined && !/^[a-z0-9_]+$/.test(m.code)) p.push(`code ${m.code}`);
  // The outcome and isError go together as B-9's table says.
  const errorExpected = ["not_applied", "partial", "unknown"].includes(m.outcome);
  if (errorExpected !== o.isError) p.push(`outcome ${m.outcome} with isError ${o.isError}`);
  // The mirror: a text block with the serialized structuredContent, after the sentence.
  if (!o.mirror?.length) p.push("no text block mirrors structuredContent");
  else if (JSON.stringify(o.mirror[0]) !== JSON.stringify(o.structured)) p.push("the mirror differs from structuredContent");
  if (!o.text) p.push("no sentence before the mirror");
  return p;
}

describe("write-result/0.1 on every write tool", () => {
  let stack: Stack;
  before(async () => { stack = await startStack(); });
  after(async () => { await stack.close(); });

  it("success and refusal results carry a well-formed shape and its mirror", async () => {
    const mcp = await stack.connect();
    const p = stack.prefix("shape");
    const seen: Array<[string, Outcome]> = [];
    const c = async (name: string, args: Record<string, unknown>) => { const r = await mcp.call(name, args); seen.push([name, r]); return r; };
    await c("create_project", { key: p, name: "shape" });
    await c("create_project", { key: p, name: "again" });
    const t = await c("create_ticket", { project: p, title: `${p} one`, idempotency_key: "k-shape-0001" });
    const id = t.structured.id;
    await c("create_ticket", { project: p, title: `${p} one`, idempotency_key: "k-shape-0001" });
    await c("update_ticket", { id, assignee: "ann", expected_version: 1 });
    await c("update_ticket", { id, assignee: "bob", expected_version: 1 });
    await c("update_ticket", { id, assignee: "bob" });
    await c("replace_ticket", { id, expected_version: 2, title: "r", status: "open", assignee: null, priority: 3 });
    await c("add_comment", { id, body: "hi" });
    await c("add_comment", { id: "T-999999", body: "hi" });
    const l = await c("add_label", { id, name: "x" });
    await c("remove_label", { id, label_id: l.structured.label_id });
    await c("set_labels", { id, labels: ["y"], force: true });
    const two = await c("create_ticket", { project: p, title: `${p} two` });
    await c("bulk_update_tickets", { project: p, ids: [id, two.structured.id], status: "closed" });
    await c("bulk_update_tickets", { project: p, ids: [id, "T-999999"], status: "open" });
    await c("delete_tickets", { project: p });
    await c("delete_tickets", { project: p, title_prefix: `${p} two` });
    await c("delete_ticket", { id, force: true });
    await c("delete_project", { key: p });
    const bad = seen.map(([n, r]) => [n, problems(r)] as const).filter(([, x]) => x.length);
    assert.deepEqual(bad, []);
    const by = (i: number) => seen[i]![1].structured.mws;
    assert.equal(by(1).code, "already_exists");
    assert.equal(by(2).repeat, "same_key", "applied with a key: a repeat with the same key is answered, not applied again");
    assert.deepEqual(by(2).changed, ["/title"], "a create lists the fields the caller set, not the scope argument");
    assert.equal(by(3).replayed, true);
    assert.deepEqual(by(3).changed, ["/title"], "a replay describes the keyed write");
    assert.equal(by(4).repeat, "same_version");
    assert.deepEqual(by(5).conflict.current_state.assignee, "ann", "a conflict carries the current state");
    assert.equal(by(5).conflict.current_version, 2);
    assert.equal(by(5).conflict.checked_by, "backend");
    assert.doesNotMatch(seen[5]![1].text, /ann/, "the sentence does not restate the current state");
    assert.deepEqual(by(8).object.parent, { type: "ticket", id, version: by(8).object.parent.version });
    assert.equal(typeof by(8).object.parent.version, "number");
    assert.equal(by(8).object.scope, undefined, "scope is the scope argument only");
    assert.equal(by(5).repeat, "read_first");
    assert.equal(by(6).code, "version_required");
    assert.equal(by(14).items.length, 2);
    assert.equal(by(15).items.find((x: any) => x.id === "T-999999").outcome, "not_applied");
    assert.equal(by(15).items.find((x: any) => x.id === id).outcome, "not_attempted", "all or nothing: no request for the rest");
    assert.deepEqual([by(17).applied_count, by(17).outcome], [1, "applied"]);
  });

  it("an open outcome: unknown, with the read that settles it and the repeat the call's guard allows", async () => {
    const mcp = await stack.connect();
    const p = stack.prefix("open");
    await stack.rest.createProject(p);
    const t = await stack.rest.createTicket({ project: p, title: "x" });
    const cut = stack.gate.cutNext((q) => q.method === "PATCH");
    const r = await mcp.call("update_ticket", { id: t.id, assignee: "bob", expected_version: t.version });
    await Promise.race([cut, new Promise((r) => setTimeout(r, 2000))]);
    assert.deepEqual(problems(r), []);
    const m = r.structured.mws;
    assert.equal(m.outcome, "unknown");
    assert.equal(m.code, "no_answer");
    assert.equal(m.repeat, "same_version");
    assert.deepEqual(m.read_with, { tool: "get_ticket", arguments: { id: t.id } });
  });
});
