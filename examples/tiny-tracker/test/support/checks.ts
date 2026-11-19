// One scripted check per requirement. Each check drives tiny-tracker only
// through an MCP client (the way a tester would), uses the backend's REST API
// directly only to set up state and to read the truth afterwards, and returns
// a verdict. These checks are the first draft of the suite's self-test matrix.
//
// Verdict words follow the suite design: `held`, `violated`, `not tested`.

import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { RequirementId } from "../../src/requirements.js";
import { ConfigError } from "../../src/start.js";
import { MUTATING } from "./gate.js";
import { startStack, type Mcp, type Outcome, type Stack, type StackOptions } from "./stack.js";

export type VerdictWord = "held" | "violated" | "not tested";
export interface Verdict {
  verdict: VerdictWord;
  detail: string;
}

export interface CheckContext {
  stack: Stack;
  mcp: Mcp;
  /** Starts a separate stack with the same build plus extra settings, or reports that it refused to start. */
  launch(env: Record<string, string>): Promise<{ stack?: Stack; refused?: string }>;
}

export interface Check {
  requirement: RequirementId;
  scenario: string;
  run(ctx: CheckContext): Promise<Verdict>;
}

const held = (detail: string): Verdict => ({ verdict: "held", detail });
const violated = (detail: string): Verdict => ({ verdict: "violated", detail });
const notTested = (detail: string): Verdict => ({ verdict: "not tested", detail });

const GHOST = "T-999999";
const key = () => `k-${randomBytes(8).toString("hex")}`;
const says = (o: Outcome, re: RegExp) => re.test(o.text);
const replayed = (o: Outcome) => o.structured?.replayed === true || says(o, /replay|already (created|applied|added|set)/i);

async function project(stack: Stack, tag: string): Promise<string> {
  const p = stack.prefix(`${tag}-${randomBytes(4).toString("hex")}`);
  await stack.rest.createProject(p);
  return p;
}

async function ticket(stack: Stack, projectKey: string, fields: Record<string, unknown> = {}) {
  return stack.rest.createTicket({ project: projectKey, title: `${projectKey} ticket`, ...fields });
}

async function schemaOf(mcp: Mcp, tool: string) {
  return (await mcp.tools()).find((t) => t.name === tool)?.inputSchema as { properties?: Record<string, unknown> } | undefined;
}

// ---------------------------------------------------------------- UPD

const upd1: Check = {
  requirement: "MWS-UPD-1",
  scenario: "update one field, then one nested sub-field; every other field and sub-field keeps its value",
  async run({ stack, mcp }) {
    const p = await project(stack, "upd1");
    const t = await ticket(stack, p, { status: "in_progress", assignee: "ana", priority: 2, description: "seeded", details: { component: "core", severity: "high" } });
    const r = await mcp.call("update_ticket", { force: true, id: t.id, title: "after" });
    if (r.isError) return notTested(`update refused: ${r.text}`);
    const a = await stack.rest.ticket(t.id);
    const moved = ["status", "assignee", "priority", "description"].filter((k) => a[k] !== t[k]);
    if (JSON.stringify(a.details) !== JSON.stringify(t.details)) moved.push("details");
    if (moved.length) return violated(`fields not named were changed: ${moved.map((k) => `${k} ${JSON.stringify(t[k])} -> ${JSON.stringify(a[k])}`).join(", ")}`);
    // The nested probe: one sub-field named, the other sub-field and every other field kept.
    const n = await mcp.call("update_ticket", { force: true, id: t.id, details: { component: "ui" } });
    if (n.isError) return notTested(`nested update refused: ${n.text}`);
    const b = await stack.rest.ticket(t.id);
    if (b.details.severity !== "high") moved.push(`details.severity (${b.details.severity})`);
    if (b.details.component !== "ui") return notTested(`the nested update did not take effect: ${JSON.stringify(b.details)}`);
    return moved.length ? violated(`a sub-field not named was changed: ${moved.join(", ")}`) : held("only the named field or sub-field changed");
  },
};

const upd2: Check = {
  requirement: "MWS-UPD-2",
  scenario: "remove label b after another writer removed label a; label c must survive",
  async run({ stack, mcp }) {
    const p = await project(stack, "upd2");
    const t = await ticket(stack, p, { labels: ["a", "b", "c"] });
    const read = await stack.rest.ticket(t.id);
    const b = read.labels.find((l: any) => l.name === "b");
    const position = read.labels.indexOf(b);
    await stack.rest.send("DELETE", `/tickets/${t.id}/labels/${read.labels[0].id}`); // the other writer
    const props = (await schemaOf(mcp, "remove_label"))?.properties ?? {};
    const args = "label_id" in props ? { id: t.id, label_id: b.id } : "position" in props ? { id: t.id, position } : undefined;
    if (!args) return notTested("remove_label takes neither a label id nor a position");
    const r = await mcp.call("remove_label", args);
    if (r.isError) return notTested(`remove refused: ${r.text}`);
    const names = (await stack.rest.ticket(t.id)).labels.map((l: any) => l.name);
    return names.includes("c") && !names.includes("b") ? held(`labels now ${names.join(",")}`)
      : violated(`asked to remove "b" as read; labels now ${names.join(",") || "(none)"}`);
  },
};

// ---------------------------------------------------------------- CONC

const conc1: Check = {
  requirement: "MWS-CONC-1",
  scenario: "replace from a stale read without force; the backend's version check must apply",
  async run({ stack, mcp }) {
    const p = await project(stack, "conc1");
    const t = await ticket(stack, p, { title: "v1" });
    await stack.rest.patch(t.id, { title: "other writer" });
    const r = await mcp.call("replace_ticket", {
      id: t.id, expected_version: t.version, title: "from stale read", status: "open", assignee: null, priority: 3,
    });
    const a = await stack.rest.ticket(t.id);
    if (a.title === "from stale read") return violated(`stale replace overwrote the newer ticket (isError ${r.isError})`);
    return r.isError ? held("stale replace refused") : notTested(`replace reported success but did not write: ${r.text}`);
  },
};

const conc2: Check = {
  requirement: "MWS-CONC-2",
  scenario: "delete, update and set_labels from a stale version are refused, and update and set_labels with the version left out; the tools take a version",
  async run({ stack, mcp }) {
    const p = await project(stack, "conc2");
    const problems: string[] = [];
    const t1 = await ticket(stack, p);
    await stack.rest.patch(t1.id, { title: "changed" });
    const d = await mcp.call("delete_ticket", { id: t1.id, expected_version: t1.version });
    if (!(await stack.rest.ticket(t1.id))) problems.push(`delete_ticket with stale version deleted it (isError ${d.isError})`);
    const t2 = await ticket(stack, p, { priority: 3 });
    await stack.rest.patch(t2.id, { title: "changed" });
    const u = await mcp.call("update_ticket", { id: t2.id, expected_version: t2.version, priority: 5 });
    if ((await stack.rest.ticket(t2.id)).priority === 5) problems.push(`update_ticket with stale version wrote (isError ${u.isError})`);
    const t3 = await ticket(stack, p, { labels: ["keep"] });
    await stack.rest.patch(t3.id, { title: "changed" });
    await mcp.call("set_labels", { id: t3.id, labels: ["x"], expected_version: t3.version });
    if ((await stack.rest.ticket(t3.id)).labels.map((l: any) => l.name).includes("x")) problems.push("set_labels with stale version wrote");
    // The second run of MWS-CONC-2 (516c4ed): the optional version left out, and no override sent.
    for (const tool of ["update_ticket", "set_labels", "delete_ticket"]) {
      const t = await ticket(stack, p, { priority: 3, labels: ["keep"] });
      await stack.rest.patch(t.id, { title: "changed" });
      const r = await mcp.call(tool, tool === "update_ticket" ? { id: t.id, priority: 5 } : tool === "set_labels" ? { id: t.id, labels: ["x"] } : { id: t.id });
      const now = await stack.rest.ticket(t.id);
      if (!r.isError || !now || now.priority === 5 || now.labels.map((l: any) => l.name).includes("x")) problems.push(`${tool} with the version left out wrote (isError ${r.isError})`);
    }
    for (const tool of ["replace_ticket", "delete_ticket", "set_labels", "update_ticket"]) {
      const props = (await schemaOf(mcp, tool))?.properties ?? {};
      if (!Object.keys(props).some((k) => /version/.test(k))) problems.push(`${tool} takes no version`);
    }
    return problems.length ? violated(problems.join("; ")) : held("all stale writes refused");
  },
};

const conc3: Check = {
  requirement: "MWS-CONC-3",
  scenario: "gate holds writer A's last backend write until writer B (other field) finishes",
  async run({ stack, mcp }) {
    const p = await project(stack, "conc3");
    const t = await ticket(stack, p, { title: "t0" });
    const mine = new RegExp(`^/tickets/${t.id}(\\?|/|$)`);
    const hold = stack.gate.holdNext((r) => MUTATING.has(r.method) && mine.test(r.path));
    const a = mcp.call("update_ticket", { force: true, id: t.id, title: "A" });
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"timeout">((r) => { timer = setTimeout(() => r("timeout"), 3000); });
    const arrived = await Promise.race([hold.held, timeout]);
    clearTimeout(timer);
    if (arrived === "timeout") {
      hold.release();
      await a;
      return notTested("writer A sent no write to the backend");
    }
    const b = await mcp.call("update_ticket", { force: true, id: t.id, assignee: "bea" });
    hold.release();
    const ra = await a;
    const after = await stack.rest.ticket(t.id);
    const lost = [after.title !== "A" && "A's title", after.assignee !== "bea" && "B's assignee"].filter(Boolean);
    if (lost.length && !ra.isError && !b.isError) return violated(`both calls reported success; lost ${lost.join(" and ")}`);
    return held(lost.length ? `a conflict was reported (A error ${ra.isError}, B error ${b.isError})` : "both changes kept");
  },
};

const conc4: Check = {
  requirement: "MWS-CONC-4",
  scenario: "a stale update_ticket is refused as a tool error and not applied",
  async run({ stack, mcp }) {
    const p = await project(stack, "conc4");
    const t = await ticket(stack, p, { priority: 3 });
    await stack.rest.patch(t.id, { title: "changed" });
    const r = await mcp.call("update_ticket", { id: t.id, expected_version: t.version, priority: 5 });
    if (r.protocolError) return violated(`conflict surfaced as a protocol error: ${r.protocolError}`);
    const applied = (await stack.rest.ticket(t.id)).priority === 5;
    if (applied) return violated("the refused write was applied");
    return r.isError ? held(r.text) : violated(`the conflict came back without isError: "${r.text}"`);
  },
};

const conc5: Check = {
  requirement: "MWS-CONC-5",
  scenario: "delete_project (no backend version check) says that stale deletes are not detected",
  async run({ mcp }) {
    const t = (await mcp.tools()).find((x) => x.name === "delete_project");
    if (!t) return notTested("delete_project is not offered");
    return /stale|not detected/i.test(t.description ?? "") ? held(t.description ?? "") : violated(`the description does not say it: "${t.description}"`);
  },
};

const conc6: Check = {
  requirement: "MWS-CONC-6",
  scenario: "a stale set_labels' conflict carries the current state or says to read again",
  async run({ stack, mcp }) {
    const p = await project(stack, "conc6");
    const t = await ticket(stack, p, { labels: ["a"] });
    const now = await stack.rest.patch(t.id, { title: "changed" });
    const r = await mcp.call("set_labels", { id: t.id, labels: ["b"], expected_version: t.version });
    // A refused stale write is a conflict here whatever its form (the form is MWS-CONC-4).
    if ((await stack.rest.ticket(t.id)).labels.some((l: any) => l.name === "b")) return notTested(`the stale write was applied: ${r.text}`);
    const state = r.structured?.current_version === now.version || says(r, new RegExp(`version ${now.version}\\b`));
    const reread = r.structured?.reread_required === true || says(r, /re-?read|read .* again/i);
    return state || reread ? held(r.text) : violated(`the conflict carries no current state and no re-read hint: "${r.text}"`);
  },
};

// ---------------------------------------------------------------- TGT

const tgt1: Check = {
  requirement: "MWS-TGT-1",
  scenario: "create a ticket in a named project that is not the default",
  async run({ stack, mcp }) {
    const p = await project(stack, "tgt1");
    const title = `${p} scoped`;
    const r = await mcp.call("create_ticket", { project: p, title });
    const made = await stack.rest.tickets({ title_prefix: title });
    if (made.length === 0) return r.isError ? held("refused") : notTested(`nothing created: ${r.text}`);
    const wrong = made.filter((t) => t.project !== p);
    return wrong.length ? violated(`asked for project ${p}; ticket landed in ${wrong.map((t) => t.project).join(", ")}`)
      : held(`created in ${p}`);
  },
};

const tgt2: Check = {
  requirement: "MWS-TGT-2",
  scenario: "bulk delete with no filter and no opt-in, inside a project the test created",
  async run({ stack, mcp }) {
    const p = await project(stack, "tgt2");
    for (const status of ["open", "open", "closed"]) await ticket(stack, p, { status });
    const r = await mcp.call("delete_tickets", { project: p });
    const left = (await stack.rest.tickets({ project: p })).length;
    return left < 3 ? violated(`empty filter deleted ${3 - left} of 3 tickets (isError ${r.isError})`) : held("refused; 3 of 3 kept");
  },
};

const tgt3: Check = {
  requirement: "MWS-TGT-3",
  scenario: "create a project whose key already exists",
  async run({ stack, mcp }) {
    const k = stack.prefix(`tgt3-${randomBytes(4).toString("hex")}`);
    const first = await mcp.call("create_project", { key: k, name: "first" });
    if (first.isError) return notTested(`first create refused: ${first.text}`);
    const second = await mcp.call("create_project", { key: k, name: "second" });
    const now = await stack.rest.project(k);
    if (now.name !== "first") return violated(`existing project overwritten (name now "${now.name}"; isError ${second.isError})`);
    if (!second.isError) return violated(`second create reported success: ${second.text}`);
    return held("second create refused; project unchanged");
  },
};

// ---------------------------------------------------------------- RES

const res1: Check = {
  requirement: "MWS-RES-1",
  scenario: "rename and unassign (assignee: null) in one call",
  async run({ stack, mcp }) {
    const p = await project(stack, "res1");
    const t = await ticket(stack, p, { assignee: "ana" });
    const r = await mcp.call("update_ticket", { force: true, id: t.id, title: "renamed", assignee: null });
    const a = await stack.rest.ticket(t.id);
    // (Saying that a no-op changed nothing is guidance in the current text, not part of MWS-RES-1.)
    if (!r.isError && a.assignee !== null) return violated(`reported success ("${r.text}") but assignee is still ${a.assignee}`);
    if (!r.isError && a.title !== "renamed") return violated(`reported success (${JSON.stringify(r.structured.mws ?? r.text)}) but the title is still ${a.title}`);
    // A delete reported as done, or as accepted (a report of success: the backend deletes synchronously), must be in effect.
    const d = await ticket(stack, p);
    const del = await mcp.call("delete_ticket", { force: true, id: d.id });
    const gone = (await stack.rest.tickets({ project: p })).every((x: any) => x.id !== d.id);
    if (!del.isError && !gone) return violated(`delete_ticket reported ${JSON.stringify(del.structured.mws?.outcome ?? "success")} but ${d.id} still exists`);
    // ---- stream D: a keyed create whose request is held on its way while the server hears nothing (inflight) ----
    if (stack.features.includes("inflight")) {
      const lp = await project(stack, "res1k");
      const h = stack.gate.dropAndHoldNext((q) => q.method === "POST" && q.path === "/tickets");
      const lost = await mcp.call("create_ticket", { project: lp, title: `${lp} late`, idempotency_key: key() });
      h.release();
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([h.landed, new Promise((r) => { timer = setTimeout(r, 2000); })]);
      clearTimeout(timer);
      const made = await stack.rest.tickets({ project: lp });
      if (made.length > 0 && lost.structured?.mws?.outcome === "not_applied") {
        return violated(`a create whose answer was lost was reported not applied ("${lost.text}"), and the held request then created ${made[0].id}`);
      }
    }
    // ---- end stream D ----
    return held("unassign, rename and delete applied");
  },
};

const res2: Check = {
  requirement: "MWS-RES-2",
  scenario: "comment on a ticket that does not exist; an update whose answer is cut after the backend applied it",
  async run({ stack, mcp }) {
    const r = await mcp.call("add_comment", { id: GHOST, body: "hello" });
    if (r.protocolError) return violated(`failure surfaced as a protocol error, not a tool result: ${r.protocolError}`);
    if (!r.isError) return violated(`failure returned without isError: "${r.text}"`);
    // The lost answer: the backend applies the PATCH and the connection closes before the server hears back. The result
    // must not report a write that is in effect as not applied (in words or in the write-result shape).
    const p = await project(stack, "res2");
    const t = await ticket(stack, p, { assignee: "ana" });
    const cut = stack.gate.cutNext((q) => MUTATING.has(q.method) && q.path.startsWith(`/tickets/${t.id}`));
    const u = await mcp.call("update_ticket", { force: true, id: t.id, assignee: "bob" });
    let timer: NodeJS.Timeout | undefined;
    const hit = await Promise.race([cut.then(() => true), new Promise<false>((r) => { timer = setTimeout(() => r(false), 2000); })]);
    clearTimeout(timer);
    if (!hit) return notTested("the update sent no request to the ticket that could be cut");
    const now = await stack.rest.ticket(t.id);
    if (now.assignee !== "bob") return notTested(`the cut write was not applied (${now.assignee})`);
    if (!u.isError) return violated(`the lost answer was reported as a success: "${u.text}"`);
    const m = u.structured?.mws;
    if (m && m.outcome !== "unknown" && m.outcome !== "applied") return violated(`the write is in effect, and the shape says ${JSON.stringify({ outcome: m.outcome, repeat: m.repeat })}`);
    if (!/not known whether/.test(u.text)) return violated(`the lost answer does not say the outcome is unknown: "${u.text}"`);
    // Nor may its text invite a repeat without a read first or the call's guard (B-9, "Text"; rule 11): a correct shape does not repair it.
    if (/\bplease (retry|try again)\b|\bsend (it|the call) again\b/i.test(u.text)) return violated(`the lost answer invites a blind repeat: "${u.text}"`);
    // ---- stream D: a same-key call while the first is still being applied (inflight, decision 0004) ----
    if (stack.features.includes("inflight")) {
      const kp = await project(stack, "res2k");
      const k = key();
      let release!: () => void;
      let reached!: () => void;
      const arrived = new Promise<void>((r) => { reached = r; });
      const gate = new Promise<void>((r) => { release = r; });
      stack.beforeCommit = async (path) => {
        if (path !== "/tickets") return;
        stack.beforeCommit = undefined;
        reached();
        await gate;
      };
      const first = mcp.call("create_ticket", { project: kp, title: `${kp} once`, idempotency_key: k });
      let timer: NodeJS.Timeout | undefined;
      const hit = await Promise.race([arrived.then(() => true), new Promise<false>((r) => { timer = setTimeout(() => r(false), 2000); })]);
      clearTimeout(timer);
      if (!hit) {
        stack.beforeCommit = undefined;
        release();
        await first;
      } else {
        const second = await mcp.call("create_ticket", { project: kp, title: `${kp} once`, idempotency_key: k });
        release();
        await first;
        const n = (await stack.rest.tickets({ project: kp })).length;
        const m = second.structured?.mws;
        if (n === 1 && m?.outcome === "not_applied") return violated(`a same-key call during the pending first was reported not applied ("${second.text}"); the keyed write applied`);
        if (n === 1 && !second.isError && !replayed(second)) return violated(`a same-key call during the pending first reported a new success: "${second.text}"`);
      }
    }
    // ---- end stream D ----
    return held(`${r.text} | ${u.text}`);
  },
};

const res3: Check = {
  requirement: "MWS-RES-3",
  scenario: "create a ticket and a comment; each answer carries the new id",
  async run({ stack, mcp }) {
    const p = await project(stack, "res3");
    const problems: string[] = [];
    const c = await mcp.call("create_ticket", { project: p, title: `${p} new` });
    const made = (await stack.rest.tickets({ title_prefix: `${p} new` }))[0];
    if (!made || c.isError) return notTested(`create_ticket failed: ${c.text}`);
    if (!JSON.stringify([c.text, c.structured]).includes(`"${made.id}"`) && !c.text.includes(made.id)) problems.push("create_ticket: no ticket id");
    const r = await mcp.call("add_comment", { id: made.id, body: "first" });
    const comment = (await stack.rest.ticket(made.id)).comments.at(-1);
    if (!comment || r.isError) return notTested(`add_comment failed: ${r.text}`);
    if (!new RegExp(`\\b${comment.id}\\b`).test(JSON.stringify([r.text, r.structured]))) problems.push(`add_comment: no comment id (${comment.id})`);
    return problems.length ? violated(problems.join("; ")) : held("ids returned");
  },
};

function receiptProblems(s: any, id: string, version: number, field: string): string[] {
  const m = s.mws;
  return [
    s.id !== id && "no id",
    s.version !== version && "no new version",
    !(Array.isArray(s.changed) && s.changed.includes(field)) && "no list of changed fields",
    // Where the write-result shape is given, it is the structured receipt: it must agree with the backend too.
    m && m.object?.id !== id && "no mws.object.id",
    m && String(m.object?.version) !== String(version) && `mws.object.version ${JSON.stringify(m?.object?.version)} is not ${version}`,
    m && !(m.changed ?? []).includes(`/${field}`) && "no mws.changed",
  ].filter(Boolean) as string[];
}

const res4: Check = {
  requirement: "MWS-RES-4",
  scenario: "update_ticket and add_label on a ticket with history; each receipt is id, version, changed fields",
  async run({ stack, mcp }) {
    const p = await project(stack, "res4");
    const t = await ticket(stack, p, { comment: "history ".repeat(40) });
    const problems: string[] = [];
    const u = await mcp.call("update_ticket", { force: true, id: t.id, title: "new title" });
    if (u.isError) return notTested(`update refused: ${u.text}`);
    problems.push(...receiptProblems(u.structured, t.id, (await stack.rest.ticket(t.id)).version, "title").map((x) => `update_ticket: ${x}`));
    const l = await mcp.call("add_label", { id: t.id, name: "fresh" });
    if (l.isError) return notTested(`add_label refused: ${l.text}`);
    problems.push(...receiptProblems(l.structured, t.id, (await stack.rest.ticket(t.id)).version, "labels").map((x) => `add_label: ${x}`));
    return problems.length ? violated(`receipt: ${problems.join(", ")}`) : held(JSON.stringify(u.structured));
  },
};

// ---------------------------------------------------------------- ATOM

async function bulkScenario(stack: Stack, mcp: Mcp, tag: string) {
  const p = await project(stack, tag);
  const t1 = await ticket(stack, p);
  const t2 = await ticket(stack, p);
  const r = await mcp.call("bulk_update_tickets", { project: p, ids: [t1.id, t2.id, GHOST], status: "closed" });
  const applied: string[] = [];
  for (const t of [t1, t2]) if ((await stack.rest.ticket(t.id)).status === "closed") applied.push(t.id);
  return { r, ids: [t1.id, t2.id, GHOST], applied };
}

const atom1: Check = {
  requirement: "MWS-ATOM-1",
  scenario: "bulk update of three tickets, one missing; the report must match what happened",
  async run({ stack, mcp }) {
    const { r, ids, applied } = await bulkScenario(stack, mcp, "atom1");
    if (!r.isError) return violated(`not all items applied (${applied.length} of 3) but reported success: "${r.text}"`);
    // Spec R15-3: a sentence that says the whole write took effect reports success, whatever the shape beside it says.
    if (/\ball \d+ tickets? (were )?saved\b/i.test(r.text)) return violated(`not all items applied (${applied.length} of 3) but the text says the whole write took effect: "${r.text}"`);
    // The write-result shape: each item's outcome (its entry in items, or the whole write's outcome) must be what happened.
    const m = r.structured?.mws;
    if (m) {
      const said = (id: string) => (m.items ?? []).find((it: any) => it.id === id)?.outcome ?? (m.outcome === "applied" || m.outcome === "not_applied" ? m.outcome : "unknown");
      const wrong = ids.filter((id) => (said(id) === "applied") !== applied.includes(id));
      if (wrong.length) return violated(`the shape gives ${wrong.map((id) => `${id} as ${said(id)}`).join(", ")}; actually applied [${applied.join(", ")}]`);
    }
    const reported = Array.isArray(r.structured.applied) ? r.structured.applied.map((a: any) => a.id).sort() : undefined;
    if (!reported) return violated("the result does not say what was applied");
    if (!isDeepStrictEqual(reported, [...applied].sort())) {
      return violated(`reported applied [${reported.join(", ")}], actually applied [${applied.join(", ")}]`);
    }
    const unnamed = ids.filter((id) => !r.text.includes(id));
    return unnamed.length ? violated(`result does not name ${unnamed.join(", ")}`) : held(`applied [${applied.join(", ")}]; ${r.text}`);
  },
};

const atom2: Check = {
  requirement: "MWS-ATOM-2",
  scenario: "gate holds a bulk delete of three tickets while another writer changes the third",
  async run({ stack, mcp }) {
    const p = await project(stack, "atom2");
    const prefix = `${p} del`;
    const ts = [await ticket(stack, p, { title: `${prefix} 1` }), await ticket(stack, p, { title: `${prefix} 2` }),
      await ticket(stack, p, { title: `${prefix} 3` })];
    const hold = stack.gate.holdNext((r) => MUTATING.has(r.method) && (r.path === "/batch" || r.path.startsWith("/tickets/")));
    const call = mcp.call("delete_tickets", { project: p, title_prefix: prefix });
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"timeout">((r) => { timer = setTimeout(() => r("timeout"), 3000); });
    const arrived = await Promise.race([hold.held, timeout]);
    clearTimeout(timer);
    if (arrived === "timeout") {
      hold.release();
      await call;
      return notTested("the delete sent no write to the backend");
    }
    await stack.rest.patch(ts[2].id, { status: "closed" }); // the other writer, straight to the backend
    hold.release();
    const r = await call;
    const left = (await stack.rest.tickets({ project: p })).length;
    if (left > 0 && left < 3) return violated(`partial write left behind: ${3 - left} of 3 deleted (isError ${r.isError})`);
    return held(left === 3 ? "nothing deleted" : "all deleted");
  },
};

// ---------------------------------------------------------------- RETRY

/** The create tools a manifest would declare as not naturally idempotent. */
const CREATES = ["create_ticket", "add_comment"];

const retry1: Check = {
  requirement: "MWS-RETRY-1",
  scenario: "catalog: each create that is not naturally idempotent offers an idempotency key",
  async run({ mcp }) {
    const tools = await mcp.tools();
    const without = CREATES.filter((n) => !Object.keys((tools.find((t) => t.name === n)?.inputSchema as any)?.properties ?? {})
      .some((k) => /idempot/i.test(k)));
    return without.length ? violated(`no idempotency key on ${without.join(", ")}`) : held("keys offered");
  },
};

const retry2: Check = {
  requirement: "MWS-RETRY-2",
  scenario: "same key twice, a new key, the same key with other arguments, a version token re-sent, a lost backend answer, a restart",
  async run({ stack, mcp, launch }) {
    const props = (await schemaOf(mcp, "create_ticket"))?.properties ?? {};
    if (!("idempotency_key" in props)) return notTested("create_ticket takes no idempotency key");
    const p = await project(stack, "retry2");
    const problems: string[] = [];
    const k1 = key();
    const title = `${p} keyed`;
    const r1 = await mcp.call("create_ticket", { project: p, title, idempotency_key: k1 });
    const r2 = await mcp.call("create_ticket", { project: p, title, idempotency_key: k1 }); // a re-issue, new JSON-RPC id
    const count = (await stack.rest.tickets({ title_prefix: title })).length;
    if (count !== 1) problems.push(`same key twice made ${count} tickets`);
    if (!replayed(r2)) problems.push(`second answer does not say replay: "${r2.text}"`);
    if (r1.structured.id !== r2.structured.id) problems.push("second answer names a different ticket");
    const r3 = await mcp.call("create_ticket", { project: p, title, idempotency_key: key() });
    if (replayed(r3) || (await stack.rest.tickets({ title_prefix: title })).length !== count + 1) problems.push("a new key was treated as a replay");
    const r4 = await mcp.call("create_ticket", { project: p, title: `${p} other`, idempotency_key: k1 });
    if (!r4.isError) problems.push(`same key with different arguments was not refused: "${r4.text}"`);
    const t = await ticket(stack, p, { priority: 3 });
    await mcp.call("update_ticket", { id: t.id, expected_version: t.version, priority: 5 });
    const u2 = await mcp.call("update_ticket", { id: t.id, expected_version: t.version, priority: 5 });
    if (u2.isError || !replayed(u2)) problems.push(`re-sent versioned update not answered as a replay: "${u2.text}"`);
    if ((await stack.rest.ticket(t.id)).version !== t.version + 1) problems.push("re-sent versioned update applied twice");
    if ("idempotency_key" in ((await schemaOf(mcp, "add_comment"))?.properties ?? {})) {
      const k2 = key();
      await mcp.call("add_comment", { id: t.id, body: "once", idempotency_key: k2 });
      await mcp.call("add_comment", { id: t.id, body: "once", idempotency_key: k2 });
      const comments = (await stack.rest.ticket(t.id)).comments.length;
      if (comments !== 1) problems.push(`keyed comment sent twice made ${comments}`);
    }
    // The backend applies the create but its answer is lost; the caller repeats with the same key.
    const lostTitle = `${p} lost answer`;
    const k3 = key();
    const cut = stack.gate.cutNext((r) => r.method === "POST" && r.path === "/tickets");
    await mcp.call("create_ticket", { project: p, title: lostTitle, idempotency_key: k3 });
    await cut;
    await mcp.call("create_ticket", { project: p, title: lostTitle, idempotency_key: k3 });
    const lost = (await stack.rest.tickets({ title_prefix: lostTitle })).length;
    if (lost !== 1) problems.push(`after a lost backend answer, one key made ${lost} tickets`);
    // The server restarts between a keyed create and its repeat (a stack of its own, so the shared one keeps running).
    const own = await launch({});
    if (own.stack) {
      try {
        const s2 = own.stack;
        const p2 = await project(s2, "retry2r");
        const k4 = key();
        const c1 = await s2.connect();
        await c1.call("create_ticket", { project: p2, title: `${p2} restart`, idempotency_key: k4 });
        const c2 = await s2.restart();
        await c2.call("create_ticket", { project: p2, title: `${p2} restart`, idempotency_key: k4 });
        const n = (await s2.rest.tickets({ title_prefix: `${p2} restart` })).length;
        if (n !== 1) problems.push(`after a restart of the server, one key made ${n} tickets`);
      } finally {
        await own.stack.close();
      }
    }
    return problems.length ? violated(problems.join("; ")) : held("applied once; replays said so; misuse refused; once after a lost answer and after a restart");
  },
};

/** One tools/call over revision 2026-07-28, raw, so an input_required result can be inspected before the retry. */
async function rawCall(url: string, name: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<any> {
  const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {} } }, "io.modelcontextprotocol/clientInfo": { name: "tiny-tracker-selftest", version: "0.1.0" } };
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": name },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { ...extra, name, arguments: args, _meta: meta } }),
  });
  const text = await res.text();
  const line = text.startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data:"))?.slice(5) ?? "{}";
  return JSON.parse(line).result;
}

const retry3: Check = {
  requirement: "MWS-RETRY-3",
  scenario: "close_ticket asks for confirmation (input_required) before it writes anything",
  async run({ stack }) {
    const p = await project(stack, "retry3");
    const t = await ticket(stack, p, { status: "open" });
    const first = await rawCall(stack.server.url, "close_ticket", { id: t.id });
    if (first?.resultType !== "input_required") return notTested(`close_ticket did not answer input_required: ${JSON.stringify(first).slice(0, 160)}`);
    const before = (await stack.rest.ticket(t.id)).status;
    const second = await rawCall(stack.server.url, "close_ticket", { id: t.id }, { inputResponses: { confirm: { action: "accept", content: { confirm: true } } }, ...(first.requestState ? { requestState: first.requestState } : {}) });
    const after = (await stack.rest.ticket(t.id)).status;
    if (before === "closed") return violated("the ticket was closed before the confirmation was given");
    return after === "closed" && !second?.isError ? held("closed only after the confirmed retry") : notTested(`the confirmed retry did not close the ticket: ${JSON.stringify(second).slice(0, 160)}`);
  },
};

// ---------------------------------------------------------------- IN

const in1: Check = {
  requirement: "MWS-IN-1",
  scenario: 'all: "false" to delete_tickets, assignee: {"a": 1} to update_ticket (conversions that change the meaning)',
  async run({ stack, mcp }) {
    const p = await project(stack, "in1");
    await ticket(stack, p);
    const t = await ticket(stack, p, { assignee: "ana" });
    const problems: string[] = [];
    await mcp.call("update_ticket", { force: true, id: t.id, assignee: { a: 1 } });
    const a = (await stack.rest.ticket(t.id)).assignee;
    if (a !== "ana") problems.push(`assignee {"a": 1} was flattened to ${JSON.stringify(a)}`);
    const d = await mcp.call("delete_tickets", { project: p, all: "false" });
    const left = (await stack.rest.tickets({ project: p })).length;
    if (left < 2) problems.push(`all: "false" was used as true; ${2 - left} of 2 tickets deleted (isError ${d.isError})`);
    return problems.length ? violated(problems.join("; ")) : held("no conversion changed a meaning");
  },
};

const in2: Check = {
  requirement: "MWS-IN-2",
  scenario: "update_ticket with a misspelled argument (asignee): refused, or the answer says it was not used",
  async run({ stack, mcp }) {
    const p = await project(stack, "in2");
    const t = await ticket(stack, p);
    const r = await mcp.call("update_ticket", { force: true, id: t.id, title: "renamed", asignee: "bob" });
    if (r.isError) return held(r.text);
    if (/asignee/.test(r.text) && /not used|ignored/i.test(r.text)) return held(`accepted, and the answer says so: ${r.text}`);
    return violated(`unknown argument dropped silently: ${r.text}`);
  },
};

const in7: Check = {
  requirement: "MWS-IN-7",
  scenario: "update_ticket with a misspelled argument (asignee) is refused",
  async run({ stack, mcp }) {
    const p = await project(stack, "in7");
    const t = await ticket(stack, p);
    const r = await mcp.call("update_ticket", { force: true, id: t.id, title: "renamed", asignee: "bob" });
    const a = await stack.rest.ticket(t.id);
    return !r.isError || a.title === "renamed" ? violated(`the unknown argument was not refused; title ${a.title}`) : held(r.text);
  },
};

const in3: Check = {
  requirement: "MWS-IN-3",
  scenario: 'status "archived" (outside the advertised enum) and a 201-character title',
  async run({ stack, mcp }) {
    const p = await project(stack, "in3");
    const t = await ticket(stack, p);
    const problems: string[] = [];
    const s = await mcp.call("update_ticket", { force: true, id: t.id, status: "archived" });
    if (!s.isError || (await stack.rest.ticket(t.id)).status === "archived") problems.push("status outside the enum accepted");
    const l = await mcp.call("update_ticket", { force: true, id: t.id, title: "x".repeat(201) });
    if (!l.isError) problems.push("title over maxLength accepted");
    return problems.length ? violated(problems.join("; ")) : held("enum and bounds enforced");
  },
};

const in4: Check = {
  requirement: "MWS-IN-4",
  scenario: "update_ticket without its required id; the error must name the argument and give the reason",
  async run({ mcp }) {
    // A missing required argument is refused by every build, so this probe still shows the form of the refusal
    // when other defects let wrong types and bounds through.
    const r = await mcp.call("update_ticket", { force: true, title: "no id given" });
    if (r.protocolError) return violated(`validation failure is a protocol error: ${r.protocolError}`);
    if (!r.isError) return notTested("value accepted");
    const problems = [
      !/\bid\b/.test(r.text) && "does not name the argument",
      !/required|missing|must/i.test(r.text) && "gives no reason",
      /\n\s+at |node_modules|\.[jt]s:\d+|TypeError|SyntaxError/.test(r.text) && "exposes runtime internals",
    ].filter(Boolean);
    return problems.length ? violated(`${problems.join(", ")}: "${r.text}"`) : held(r.text);
  },
};

const in5: Check = {
  requirement: "MWS-IN-5",
  scenario: "a 150-character title (valid by the schema's maxLength 200) is accepted",
  async run({ stack, mcp }) {
    const p = await project(stack, "in5");
    const t = await ticket(stack, p);
    const r = await mcp.call("update_ticket", { force: true, id: t.id, title: "t".repeat(150) });
    return r.isError ? violated(`a value valid by the schema was refused: "${r.text}"`) : held("accepted");
  },
};

const in6: Check = {
  requirement: "MWS-IN-6",
  scenario: 'priority: "5" (a numeric string for an integer) is rejected, not converted',
  async run({ stack, mcp }) {
    const p = await project(stack, "in6");
    const t = await ticket(stack, p, { priority: 3 });
    const r = await mcp.call("update_ticket", { force: true, id: t.id, priority: "5" });
    const now = (await stack.rest.ticket(t.id)).priority;
    return !r.isError || now === 5 ? violated(`a wrong type was converted (priority now ${now})`) : held("refused");
  },
};

// ---------------------------------------------------------------- CFG (launch)

/** Whether an ordinary destructive write (update_ticket) goes through. */
async function writeLands(stack: Stack): Promise<boolean> {
  const p = await project(stack, "cfgw");
  const t = await ticket(stack, p);
  const mcp = await stack.connect();
  await mcp.call("update_ticket", { force: true, id: t.id, title: "written" });
  return (await stack.rest.ticket(t.id)).title === "written";
}

const cfg1: Check = {
  requirement: "MWS-CFG-1",
  scenario: "launch with TRACKER_READ_ONLY=yes and =enabled",
  async run({ launch }) {
    const problems: string[] = [];
    for (const value of ["yes", "enabled"]) {
      const { stack, refused } = await launch({ TRACKER_READ_ONLY: value });
      if (refused) continue;
      try {
        if (await writeLands(stack!)) problems.push(`TRACKER_READ_ONLY=${value}: started with writes on`);
      } finally {
        await stack!.close();
      }
    }
    return problems.length ? violated(problems.join("; ")) : held("read-only on, or refused to start");
  },
};

const cfg2: Check = {
  requirement: "MWS-CFG-2",
  scenario: "launch with a misspelled tool in TRACKER_DENY_TOOLS",
  async run({ launch }) {
    const { stack, refused } = await launch({ TRACKER_DENY_TOOLS: "delete_ticket,update_tikcet" });
    if (refused) return held(`refused to start: ${refused}`);
    try {
      return (await writeLands(stack!)) ? violated("started with writes on although TRACKER_DENY_TOOLS names an unknown tool") : held("started with writes refused");
    } finally {
      await stack!.close();
    }
  },
};

const cfg4: Check = {
  requirement: "MWS-CFG-4",
  scenario: "launch with a misspelled tool in TRACKER_TOOLS",
  async run({ launch }) {
    const { stack, refused } = await launch({ TRACKER_TOOLS: "get_ticket,update_tikcet" });
    if (refused) return held(`refused to start: ${refused}`);
    await stack!.close();
    return violated("started although TRACKER_TOOLS names an unknown tool");
  },
};

const cfg3: Check = {
  requirement: "MWS-CFG-3",
  scenario: "read-only mode: every write tool is unavailable, whatever its annotations",
  async run({ launch }) {
    const { stack, refused } = await launch({ TRACKER_READ_ONLY: "true" });
    if (refused) return notTested(`refused to start: ${refused}`);
    try {
      const mcp = await stack!.connect();
      const p = await project(stack!, "cfg3");
      const t = await ticket(stack!, p, { labels: ["a"] });
      const probes = await probeArgs(stack!, p, t);
      const before = await stack!.rest.export();
      const landed: string[] = [];
      for (const [tool, args] of Object.entries(probes)) {
        if (!WRITE_PROBES.includes(tool)) continue;
        const r = await mcp.call(tool, args);
        if (!r.isError) landed.push(tool);
      }
      const after = await stack!.rest.export();
      if (!isDeepStrictEqual(before, after)) return violated(`state changed in read-only mode; accepted: ${landed.join(", ")}`);
      return landed.length ? violated(`write tools answered without error: ${landed.join(", ")}`) : held("every write refused");
    } finally {
      await stack!.close();
    }
  },
};

// ---------------------------------------------------------------- ANN

const WRITE_PROBES = ["create_project", "delete_project", "create_ticket", "update_ticket", "replace_ticket", "delete_ticket",
  "delete_tickets", "bulk_update_tickets", "add_comment", "add_label", "remove_label", "set_labels", "close_ticket"];

/** One plausible call per tool, against a fixture ticket `t` in project `p`. */
async function probeArgs(stack: Stack, p: string, t: any): Promise<Record<string, Record<string, unknown>>> {
  const empty = stack.prefix(`empty-${randomBytes(4).toString("hex")}`);
  await stack.rest.createProject(empty);
  return {
    list_projects: {},
    list_tickets: { project: p },
    get_ticket: { id: t.id },
    create_project: { key: stack.prefix(`new-${randomBytes(4).toString("hex")}`), name: "probe" },
    delete_project: { key: empty },
    create_ticket: { project: p, title: `${p} probe` },
    update_ticket: { id: t.id, title: "probe title", force: true },
    replace_ticket: { id: t.id, expected_version: t.version, title: "replaced", status: "open", assignee: null, priority: 4 },
    delete_ticket: { id: t.id, force: true },
    delete_tickets: { project: p, status: "in_progress" },
    bulk_update_tickets: { project: p, ids: [t.id], status: "closed" },
    add_comment: { id: t.id, body: "probe" },
    add_label: { id: t.id, name: "new" },
    remove_label: { id: t.id, label_id: t.labels[0].id },
    set_labels: { id: t.id, labels: ["z"], expected_version: t.version },
    close_ticket: { id: t.id },
    // The lookup tools (feature lookup): a key nobody used, and an execution id.
    get_operation: { idempotency_key: stack.prefix(`unused-${randomBytes(4).toString("hex")}`) },
    get_execution: { id: "X-1" },
  };
}

async function annFixture(stack: Stack, tag: string) {
  const p = await project(stack, tag);
  const t = await ticket(stack, p, { status: "in_progress", assignee: "ana", priority: 2, labels: ["a", "b"], comment: "c1" });
  return { p, t };
}

/** Calls each tool matching `select` on a fresh fixture and lets `judge` compare states. */
async function forEachTool(stack: Stack, mcp: Mcp, tag: string, select: (a: any) => boolean,
  judge: (tool: string, args: Record<string, unknown>) => Promise<string | undefined>): Promise<Verdict> {
  const tools = (await mcp.tools()).filter((t) => select(t.annotations ?? {}));
  const problems: string[] = [];
  const skipped: string[] = [];
  for (const tool of tools) {
    const { p, t } = await annFixture(stack, tag);
    const args = (await probeArgs(stack, p, t))[tool.name];
    if (!args) { skipped.push(tool.name); continue; }
    if (tool.name === "remove_label" && "position" in ((tool.inputSchema as any).properties ?? {})) {
      delete args.label_id;
      args.position = 0;
    }
    const problem = await judge(tool.name, args);
    if (problem) problems.push(`${tool.name}: ${problem}`);
  }
  if (problems.length) return violated(problems.join("; "));
  return held(`checked ${tools.map((t) => t.name).join(", ") || "no tools"}${skipped.length ? `; no probe for ${skipped.join(", ")}` : ""}`);
}

function onlyAdds(before: { projects: any[]; tickets: any[] }, after: { projects: any[]; tickets: any[] }): string | undefined {
  for (const p of before.projects) {
    const q = after.projects.find((x) => x.key === p.key);
    if (!q) return `deleted project ${p.key}`;
    if (q.name !== p.name) return `changed project ${p.key}`;
  }
  for (const t of before.tickets) {
    const u = after.tickets.find((x) => x.id === t.id);
    if (!u) return `deleted ${t.id}`;
    for (const k of ["project", "title", "status", "assignee", "priority"]) if (u[k] !== t[k]) return `changed ${t.id}.${k}`;
    for (const l of t.labels) if (!u.labels.some((m: any) => m.id === l.id && m.name === l.name)) return `removed label ${l.name} from ${t.id}`;
    for (const c of t.comments) if (!u.comments.some((d: any) => d.id === c.id && d.body === c.body)) return `removed a comment from ${t.id}`;
  }
  return undefined;
}

const ann1: Check = {
  requirement: "MWS-ANN-1",
  scenario: "every tool declared readOnlyHint: true leaves the state unchanged",
  async run({ stack, mcp }) {
    return forEachTool(stack, mcp, "ann1", (a) => a.readOnlyHint === true, async (tool, args) => {
      const before = await stack.rest.export();
      await mcp.call(tool, args);
      return isDeepStrictEqual(before, await stack.rest.export()) ? undefined : "changed state";
    });
  },
};

/** Data removed or replaced that the call's arguments did not name (MWS-ANN-2): a whole field passed is named. */
function removesUnnamed(args: Record<string, unknown>, before: { projects: any[]; tickets: any[] }, after: { projects: any[]; tickets: any[] }): string | undefined {
  for (const p of before.projects) {
    const q = after.projects.find((x) => x.key === p.key);
    if (!q) return `deleted project ${p.key}`;
    if (q.name !== p.name && !("name" in args)) return `replaced the name of project ${p.key}`;
  }
  for (const t of before.tickets) {
    const u = after.tickets.find((x) => x.id === t.id);
    if (!u) return `deleted ${t.id}`;
    for (const k of ["project", "title", "status", "assignee", "priority"]) if (u[k] !== t[k] && !(k in args)) return `replaced ${t.id}.${k}, which the call did not name`;
    if (!("labels" in args)) for (const l of t.labels) if (!u.labels.some((m: any) => m.id === l.id) && !Object.values(args).includes(l.id)) return `removed label ${l.name} from ${t.id}, which the call did not name`;
    for (const c of t.comments) if (!u.comments.some((d: any) => d.id === c.id)) return `removed a comment from ${t.id}`;
  }
  return undefined;
}

const ann2: Check = {
  requirement: "MWS-ANN-2",
  scenario: "every tool declared destructiveHint: false deletes nothing and removes no data its arguments did not name",
  async run({ stack, mcp }) {
    return forEachTool(stack, mcp, "ann2", (a) => a.readOnlyHint !== true && a.destructiveHint === false, async (tool, args) => {
      const before = await stack.rest.export();
      await mcp.call(tool, args);
      return removesUnnamed(args, before, await stack.rest.export());
    });
  },
};

const ann5: Check = {
  requirement: "MWS-ANN-5",
  scenario: "every tool declared destructiveHint: false only adds",
  async run({ stack, mcp }) {
    return forEachTool(stack, mcp, "ann5", (a) => a.readOnlyHint !== true && a.destructiveHint === false, async (tool, args) => {
      const before = await stack.rest.export();
      await mcp.call(tool, args);
      return onlyAdds(before, await stack.rest.export());
    });
  },
};

const ann3: Check = {
  requirement: "MWS-ANN-3",
  scenario: "every tool declared idempotentHint: true has no further effect when called again",
  async run({ stack, mcp }) {
    return forEachTool(stack, mcp, "ann3", (a) => a.readOnlyHint !== true && a.idempotentHint === true, async (tool, args) => {
      await mcp.call(tool, args);
      const once = await stack.rest.export();
      await mcp.call(tool, args);
      return isDeepStrictEqual(once, await stack.rest.export()) ? undefined : "the second call changed state again";
    });
  },
};

const ann4: Check = {
  requirement: "MWS-ANN-4",
  scenario: "catalog: readOnlyHint everywhere, destructiveHint on every state-changing tool",
  async run({ mcp }) {
    const problems = (await mcp.tools()).flatMap((t) => {
      const a = (t.annotations ?? {}) as Record<string, unknown>;
      if (typeof a.readOnlyHint !== "boolean") return [`${t.name}: no readOnlyHint`];
      if (a.readOnlyHint === false && typeof a.destructiveHint !== "boolean") return [`${t.name}: no destructiveHint`];
      return [];
    });
    return problems.length ? violated(problems.join("; ")) : held("all explicit");
  },
};

// ---------------------------------------------------------------- SEC

const sec1: Check = {
  requirement: "MWS-SEC-1",
  scenario: "scan successes and errors for the backend credential (a canary)",
  async run({ stack, mcp }) {
    const p = await project(stack, "sec1");
    const t = await ticket(stack, p);
    await stack.rest.patch(t.id, { title: "moved on" });
    const outcomes = [
      await mcp.call("list_projects", {}),
      await mcp.call("get_ticket", { id: t.id }),
      await mcp.call("get_ticket", { id: GHOST }),
      await mcp.call("update_ticket", { id: t.id, expected_version: t.version, title: "stale" }),
      await mcp.call("update_ticket", { force: true, id: t.id, priority: "high" }),
      await mcp.call("add_comment", { id: GHOST, body: "x" }),
      await mcp.call("delete_ticket", { id: GHOST, force: true }),
    ];
    const leaks = outcomes.filter((o) => {
      const s = `${o.text}\n${JSON.stringify(o.raw ?? null)}\n${JSON.stringify(o.structured ?? null)}`;
      return s.includes(stack.token) || /bearer\s+[a-z0-9._~+/-]{8,}/i.test(s);
    });
    return leaks.length ? violated(`credential in ${leaks.length} result(s): "${leaks[0].text.slice(0, 160)}…"`)
      : held(`${outcomes.length} results scanned`);
  },
};

export const CHECKS: Check[] = [
  upd1, upd2, conc1, conc2, conc3, conc4, conc5, conc6, tgt1, tgt2, tgt3, res1, res2, res3, res4, atom1, atom2,
  retry1, retry2, retry3, in1, in2, in3, in4, in5, in6, in7, cfg1, cfg2, cfg3, cfg4, ann1, ann2, ann3, ann4, ann5, sec1,
];

/** Runs every check against one build and returns the verdict per requirement. */
export async function runChecks(options: StackOptions, only?: RequirementId[]): Promise<Map<RequirementId, Verdict>> {
  const stack = await startStack(options);
  const results = new Map<RequirementId, Verdict>();
  try {
    const mcp = await stack.connect();
    const launch = async (env: Record<string, string>) => {
      try {
        return { stack: await startStack({ ...options, env: { ...options.env, ...env } }) };
      } catch (e) {
        if (e instanceof ConfigError) return { refused: e.message };
        throw e;
      }
    };
    for (const check of CHECKS) {
      if (only && !only.includes(check.requirement)) continue;
      try {
        results.set(check.requirement, await check.run({ stack, mcp, launch }));
      } catch (e) {
        results.set(check.requirement, notTested(`the check could not complete: ${(e as Error).message}`));
      }
    }
  } finally {
    await stack.close();
  }
  return results;
}
