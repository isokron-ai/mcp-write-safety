#!/usr/bin/env node
// fx-check: checks a running fixture's FX- properties through its evidence
// API (FIXTURE.md), from outside, the way another harness would. It works
// against any server that declares the endpoints, not only this one.
//
//   fx-check --backend URL [--mcp URL] [--control URL] [--token-dir DIR] [--probe] [--json]
//
// Tokens come from the environment or a file, never from the command line:
//   TRACKER_EVIDENCE_TOKEN (or _FILE, or DIR/evidence.token)   needed
//   TRACKER_BACKEND_TOKEN  (or _FILE)                           for the probes that write
//   TRACKER_CONTROL_TOKEN  (or _FILE, or DIR/control.token)     for run allocation and the fault probe
//   FX_CHECK_SECOND_TOKEN  (or _FILE)                           a second principal's backend token, for FX-LOOK-3
//
// With more than one principal configured, every evidence read names one
// (?principal=<id>, docs/INTERFACES.md §1.4). fx-check reads as --principal
// (or FX_CHECK_PRINCIPAL) when given; otherwise as the principal its probe run
// was allocated for (the control listener's answer); otherwise as the first
// principal the evidence namespace lists.
//
// Each property gets one answer: held, violated, not checked (with the
// reason: an endpoint not built, a token not given) or not applicable (the
// build does not run the feature it needs). By default fx-check is read-only:
// it writes nothing and checks only what is already recorded, so the
// properties that need a write are "not checked". With --probe it writes a
// few tickets (title "fx-check probe ...") under their own keys and operation
// tags, in a run of their own when the control listener is given; that run is
// reset at the end where the build can reset runs.
//
// Exit 0: nothing violated. Exit 1: at least one property violated. Exit 2:
// the command line, a token, or the build descriptor could not be used.

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { canonicalize, domainDigest, DOMAINS, verifyServed, type ServedDigest } from "./digest.js";
import { FIXTURE_PROPERTIES, HEADERS, META_KEYS, type FixturePropertyId } from "./fixture-properties.js";

export const FX_CHECK_FORMAT = "fx-check/1";

export type Verdict = "held" | "violated" | "not checked" | "not applicable";

export interface Finding {
  id: FixturePropertyId;
  verdict: Verdict;
  reason: string;
  evidence?: Record<string, unknown>;
}

export interface FxCheckOptions {
  backend: string;
  mcp?: string;
  control?: string;
  tokens: { evidence: string; backend?: string; control?: string; second?: string };
  /** Write probe tickets (in a run of their own, reset afterwards). Off by default: fx-check is read-only. */
  probe?: boolean;
  /** How long the fault probe waits for an answer that should never come. */
  dropWaitMs?: number;
  /** The principal evidence reads name (?principal=), when more than one is configured. */
  principal?: string;
}

export interface FxCheckReport {
  fx_check: typeof FX_CHECK_FORMAT;
  target: { backend: string; mcp: string | null; control: string | null };
  build: { build_hash: string; descriptor_hash: string; features: string[]; defects: unknown } | null;
  probes: { run: string | null; principal: string | null; keys: string[]; reset: string | null };
  findings: Finding[];
}

/** The feature each property needs; a build without it gets "not applicable". */
const NEEDS: Record<FixturePropertyId, string[]> = {
  "FX-BLD-1": ["evidence"],
  "FX-DIG-1": ["execution-records"],
  "FX-DIG-2": ["execution-records"],
  "FX-DIG-3": ["execution-records"],
  "FX-LOOK-1": ["lookup"],
  "FX-LOOK-2": ["lookup"],
  "FX-LOOK-3": ["lookup", "principals"],
  "FX-LOOK-4": ["lookup"],
  "FX-FLT-1": ["faults", "ledger"],
  "FX-DUR-1": ["durable"],
  "FX-DUR-2": ["durable"],
  "FX-DUR-3": ["durable"],
  "FX-KEY-1": ["retention"],
  "FX-KEY-2": ["retention"],
  "FX-KEY-3": ["inflight"],
};

/** Properties this version of fx-check probes; the others are reported, never guessed. */
const CHECKED = new Set<FixturePropertyId>(["FX-BLD-1", "FX-DIG-1", "FX-DIG-2", "FX-DIG-3", "FX-LOOK-1", "FX-LOOK-2", "FX-LOOK-3", "FX-FLT-1"]);

interface Reply { status: number; body: any; headers: Headers; error?: string }

class Unusable extends Error {}

async function request(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Reply> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 15000) });
    const text = await res.text();
    let body: any;
    try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
    return { status: res.status, body, headers: res.headers };
  } catch (e) {
    return { status: 0, body: undefined, headers: new Headers(), error: (e as Error).name === "TimeoutError" ? "timeout" : (e as Error).message };
  }
}

/** The first object whose `record` member is kind, depth-first (envelopes differ: a record, {operation: record}, ...). */
export function findRecord(value: unknown, kind: string, depth = 0): any {
  if (depth > 6 || value === null || typeof value !== "object") return undefined;
  if (!Array.isArray(value) && (value as any).record === kind) return value;
  for (const v of Array.isArray(value) ? value : Object.values(value)) {
    const hit = findRecord(v, kind, depth + 1);
    if (hit) return hit;
  }
  return undefined;
}

function listOf(body: any, ...members: string[]): any[] | undefined {
  if (Array.isArray(body)) return body;
  for (const m of members) if (body && Array.isArray(body[m])) return body[m];
  return undefined;
}

/**
 * Whether served canonical bytes hold the same JSON value as `value`. FX-DIG-1 and FX-DIG-2 compare values: whether
 * the bytes are in RFC 8785 form is FX-DIG-3's property, so a build that serves the right value in another form
 * violates FX-DIG-3 only.
 */
export function sameValue(servedCanonical: unknown, value: unknown): boolean {
  if (typeof servedCanonical !== "string") return false;
  try {
    return canonicalize(JSON.parse(servedCanonical)) === canonicalize(value ?? null);
  } catch {
    return false;
  }
}

/** build_hash and descriptor_hash recomputed from a served descriptor (schemas/build-descriptor-1, decision 0005). */
export function recomputeDescriptorHashes(d: any): { build_hash: string; descriptor_hash: string } {
  const configuration = {
    descriptor: d.descriptor, package: d.package, fixture_api: d.fixture_api, profile: d.profile, features: d.features,
    defects: d.defects, variants: d.variants, control: d.control, config: d.config, durability: d.durability, contract: d.contract,
    layout: d.process?.layout,
  };
  const { descriptor_hash: _omit, ...body } = d;
  void _omit;
  return { build_hash: domainDigest(DOMAINS.build, canonicalize(configuration)), descriptor_hash: domainDigest(DOMAINS.buildDescriptor, canonicalize(body)) };
}

/** A minimal MCP client over Streamable HTTP (JSON or event-stream answers). */
class Mcp {
  private session: string | undefined;
  private version = "2025-11-25";
  constructor(readonly url: string) {}

  async rpc(method: string, params: unknown, timeoutMs = 15000): Promise<{ status: number; message: any; error?: string }> {
    const id = randomBytes(6).toString("hex");
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": this.version };
    if (this.session) headers["mcp-session-id"] = this.session;
    try {
      const res = await fetch(this.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), signal: AbortSignal.timeout(timeoutMs) });
      const text = await res.text();
      this.session = res.headers.get("mcp-session-id") ?? this.session;
      let message: any;
      if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
        for (const block of text.split(/\n\n/)) {
          const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
          if (!data) continue;
          try { const m = JSON.parse(data); if (m.id === id) message = m; } catch { /* not ours */ }
        }
      } else if (text) {
        try { message = JSON.parse(text); } catch { message = undefined; }
      }
      return { status: res.status, message };
    } catch (e) {
      return { status: 0, message: undefined, error: (e as Error).name === "TimeoutError" ? "timeout" : (e as Error).message };
    }
  }

  async initialize(): Promise<any> {
    const r = await this.rpc("initialize", { protocolVersion: this.version, capabilities: {}, clientInfo: { name: "fx-check", version: "1" } });
    this.version = r.message?.result?.protocolVersion ?? this.version;
    await fetch(this.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(this.session ? { "mcp-session-id": this.session } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) }).then((r) => r.text()).catch(() => undefined);
    return r.message?.result;
  }

  async tools(): Promise<string[]> {
    const r = await this.rpc("tools/list", {});
    return (r.message?.result?.tools ?? []).map((t: any) => t.name);
  }

  call(name: string, args: unknown, meta?: Record<string, string>, timeoutMs?: number) {
    return this.rpc("tools/call", { name, arguments: args, ...(meta ? { _meta: meta } : {}) }, timeoutMs);
  }
}

export async function fxCheck(o: FxCheckOptions): Promise<FxCheckReport> {
  const base = o.backend.replace(/\/+$/, "");
  // The principal evidence reads name (§1.4); null until known, and then only sent where more than one is configured.
  let principal: string | null = o.principal ?? null;
  const withPrincipal = (path: string) => principal === null || path === "/build" ? path : `${path}${path.includes("?") ? "&" : "?"}principal=${encodeURIComponent(principal)}`;
  const ev = (path: string) => request(`${base}${withPrincipal(path)}`, { headers: { authorization: `Bearer ${o.tokens.evidence}`, accept: "application/json" } });
  const findings = new Map<FixturePropertyId, Finding>();
  const set = (id: FixturePropertyId, verdict: Verdict, reason: string, evidence?: Record<string, unknown>) => {
    if (!findings.has(id)) findings.set(id, { id, verdict, reason, ...(evidence ? { evidence } : {}) });
  };
  const report: FxCheckReport = { fx_check: FX_CHECK_FORMAT, target: { backend: base, mcp: o.mcp ?? null, control: o.control ?? null }, build: null, probes: { run: null, principal: null, keys: [], reset: null }, findings: [] };

  // ---- the build descriptor ----
  const build = await ev("/build");
  if (build.status === 401 || build.status === 403) throw new Unusable(`GET /build answered ${build.status}: the evidence token is not accepted`);
  if (build.status !== 200 || typeof build.body !== "object") throw new Unusable(`GET /build answered ${build.status || build.error}: no build descriptor to check against`);
  const d = build.body;
  const features: string[] = Array.isArray(d.features) ? d.features : [];
  report.build = { build_hash: d.build_hash, descriptor_hash: d.descriptor_hash, features, defects: d.defects };
  for (const id of Object.keys(FIXTURE_PROPERTIES) as FixturePropertyId[]) {
    const missing = NEEDS[id].filter((f) => !features.includes(f));
    if (missing.length) set(id, "not applicable", `the build does not run ${missing.join(" and ")} (since ${FIXTURE_PROPERTIES[id].since})`);
    else if (id === "FX-LOOK-4" && !(Array.isArray(d.variants) && d.variants.includes("settle-by-lookup"))) set(id, "not applicable", "the build does not run the settle-by-lookup variant (since 0.3.0)");
    else if (!CHECKED.has(id)) set(id, "not checked", `fx-check does not probe ${id} in this version`);
  }
  const wants = (id: FixturePropertyId) => !findings.has(id);

  // FX-BLD-1 (part one): the descriptor is self-consistent and its mirrors agree.
  const bld: string[] = [];
  const bldEvidence: Record<string, unknown> = {};
  if (wants("FX-BLD-1")) {
    const again = recomputeDescriptorHashes(d);
    if (again.build_hash !== d.build_hash) bld.push(`build_hash ${d.build_hash} does not recompute (got ${again.build_hash})`);
    if (again.descriptor_hash !== d.descriptor_hash) bld.push(`descriptor_hash ${d.descriptor_hash} does not recompute (got ${again.descriptor_hash})`);
    const header = build.headers.get(HEADERS.build);
    if (header !== d.build_hash) bld.push(`header ${HEADERS.build} is ${header ?? "absent"}, not the build_hash`);
    for (const m of ["features", "defects", "variants", "faults", "contract", "process", "clock"]) if (d[m] === undefined) bld.push(`the descriptor has no ${m}`);
    bldEvidence.recomputed = again;
  }

  // ---- what the probes need ----
  const tag = randomBytes(4).toString("hex");
  let n = 0;
  const newKey = () => { const k = `fxc-${tag}-k${++n}`; report.probes.keys.push(k); return k; };
  const opTag = () => `fxc-${tag}-op${++n}`;
  let run: string | null = null;
  const control = o.control && o.tokens.control ? o.control.replace(/\/+$/, "") : undefined;
  const ctl = (method: string, path: string, body?: unknown) => request(`${control}${path}`, {
    method, headers: { authorization: `Bearer ${o.tokens.control}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const writes = o.probe === true && !!o.tokens.backend;
  if (writes && control) {
    const r = await ctl("POST", "/_fixture/runs", { label: "fx-check" });
    if (r.status === 201 && typeof r.body?.run_id === "string") run = r.body.run_id;
    // The run belongs to the principal the control listener allocated it for (the backend token's, by default).
    if (principal === null && r.status === 201 && typeof r.body?.principal === "string") principal = r.body.principal;
  }
  report.probes.run = run;
  if (principal === null) {
    // Only needed when more than one principal is configured: the namespace then answers 400 principal_required.
    const asked = await ev("/executions/X-0");
    if (asked.status === 400 && asked.body?.error === "principal_required") {
      const listed = Array.isArray(asked.body.principals) ? asked.body.principals.filter((p: unknown) => typeof p === "string") : [];
      if (listed.length) principal = listed[0];
    }
  }
  report.probes.principal = principal;
  const post = (key: string | null, body: unknown, token = o.tokens.backend!) => request(`${base}/tickets`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", [HEADERS.operation]: opTag(), ...(run ? { [HEADERS.run]: run } : {}), ...(key ? { "idempotency-key": key } : {}) },
    body: JSON.stringify(body),
  });
  const backendGet = (path: string, token = o.tokens.backend!) => request(`${base}${path}`, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } });

  const opRoute = await ev(`/operations/${encodeURIComponent(`fxc-${tag}-absent`)}`);
  const execRoute = await ev("/executions");
  const ledgerRoute = await ev("/ledger");
  const built = (r: Reply) => r.status !== 501 && r.status !== 0;
  const ledger = async () => { const r = await ev("/ledger"); return r.status === 200 ? listOf(r.body, "entries", "ledger") : undefined; };
  const execution = async (id: string) => { const r = await ev(`/executions/${encodeURIComponent(id)}`); return r.status === 200 ? findRecord(r.body, "execution-record/1") : undefined; };
  const executionCount = async (): Promise<number | undefined> => {
    const r = await ev("/executions");
    const list = r.status === 200 ? listOf(r.body, "executions") : undefined;
    if (list) return list.length;
    const l = await ledger();
    return l?.filter((e) => e.kind === "execution").length;
  };
  /** The execution record a key's first write made, found without the lookup under test where possible: the ledger, then /executions. */
  const executionForKey = async (key: string): Promise<any> => {
    const l = await ledger();
    const hit = l?.find((e) => e.kind === "execution" && e.request?.key === key);
    if (hit?.execution_id) return execution(hit.execution_id);
    const r = await ev("/executions");
    return (listOf(r.body, "executions") ?? []).find((x: any) => x?.request?.key === key && x?.request?.method === "POST");
  };

  const skipWrites = (id: FixturePropertyId) => {
    if (!wants(id)) return true;
    if (o.probe !== true) { set(id, "not checked", "read-only run: this property needs a write (--probe)"); return true; }
    if (!o.tokens.backend) { set(id, "not checked", "no backend token (TRACKER_BACKEND_TOKEN or _FILE): this property needs a write"); return true; }
    return false;
  };

  // ---- FX-DIG-1 and FX-DIG-2: one keyed create, a later change, a replay ----
  let k1: string | undefined;
  let created: Reply | undefined;
  let x1: any;
  const digNeeds = (id: FixturePropertyId) => {
    if (skipWrites(id)) return false;
    if (!built(execRoute)) { set(id, "not checked", `GET /executions answered ${execRoute.status || execRoute.error}`); return false; }
    return true;
  };
  const dig1 = digNeeds("FX-DIG-1");
  const dig2 = digNeeds("FX-DIG-2");
  if (dig1 || dig2 || (o.probe === true && o.tokens.backend && (wants("FX-LOOK-1") || wants("FX-LOOK-2") || wants("FX-LOOK-3")))) {
    k1 = newKey();
    const body = { title: `fx-check probe ${k1}`, project: "inbox" };
    created = await post(k1, body);
    x1 = created.status === 201 ? await executionForKey(k1) : undefined;
    const digIds = ([["FX-DIG-1", dig1], ["FX-DIG-2", dig2]] as const).filter(([, on]) => on).map(([id]) => id);
    if (created.status !== 201) {
      for (const id of digIds) set(id, "not checked", `the probe create answered ${created.status}`);
    } else if (!x1) {
      for (const id of digIds) set(id, "violated", `no execution record names the probe create (key ${k1}) in the ledger or in /executions`);
    } else {
      if (dig1) {
        const ticketId = created.body?.ticket?.id;
        const patch = ticketId ? await request(`${base}/tickets/${encodeURIComponent(ticketId)}`, {
          method: "PATCH", headers: { authorization: `Bearer ${o.tokens.backend}`, "content-type": "application/json", [HEADERS.operation]: opTag(), ...(run ? { [HEADERS.run]: run } : {}) },
          body: JSON.stringify({ title: `fx-check probe ${k1} changed` }),
        }) : undefined;
        const later = await execution(x1.id);
        const problems: string[] = [];
        if (!sameValue(x1.result?.canonical, created.body)) problems.push("the served canonical bytes are not the committed response body");
        if (!patch || patch.status !== 200) problems.push(`the probe change answered ${patch?.status ?? "nothing"}`);
        else if (!later) problems.push(`GET /executions/${x1.id} did not answer after the change`);
        else if (later.result?.digest !== x1.result?.digest || later.result?.canonical !== x1.result?.canonical) problems.push("the execution record's digest changed when the object changed");
        else if (!sameValue(later.result?.canonical, created.body)) problems.push("the execution record no longer serves the committed response body");
        set("FX-DIG-1", problems.length ? "violated" : "held", problems.length ? problems.join("; ") : `${x1.id} serves the committed response body, and its digest stayed the same after the ticket changed`, { execution: x1.id, key: k1 });
      }
      if (dig2) {
        const replay = await post(k1, { title: `fx-check probe ${k1}`, project: "inbox" });
        const problems: string[] = [];
        if (replay.status !== created.status) problems.push(`the replay answered ${replay.status}, the first call ${created.status}`);
        if (replay.headers.get("idempotent-replayed") !== "true") problems.push("the replay carries no Idempotent-Replayed: true");
        if (!sameValue(x1.result?.canonical, replay.body)) problems.push("the replay's body is not the execution record's result");
        const l = await ledger();
        const replayEntry = l?.filter((e) => e.kind === "replay" && e.request?.key === k1).pop();
        if (l && !replayEntry) problems.push("the ledger has no replay entry for the key");
        if (replayEntry && replayEntry.execution_id !== x1.id) problems.push(`the ledger's replay names ${replayEntry.execution_id}, not ${x1.id}`);
        const executionsAfter = (l ?? []).filter((e) => e.kind === "execution" && e.request?.key === k1).length;
        if (l && executionsAfter !== 1) problems.push(`${executionsAfter} execution entries for the key`);
        set("FX-DIG-2", problems.length ? "violated" : "held", problems.length ? problems.join("; ") : `the replay served ${x1.id}'s bytes again, and the ledger names the same record`, { execution: x1.id, key: k1 });
      }
    }
  }

  // ---- FX-DIG-3: every execution record's served digest ----
  if (wants("FX-DIG-3")) {
    if (!built(execRoute) && !built(ledgerRoute)) set("FX-DIG-3", "not checked", `GET /executions answered ${execRoute.status || execRoute.error}`);
    else {
      let records: any[] = listOf((await ev("/executions")).body, "executions") ?? [];
      if (records.length === 0) {
        const ids = ((await ledger()) ?? []).filter((e) => e.kind === "execution").map((e) => e.execution_id).slice(0, 200);
        records = (await Promise.all(ids.map(execution))).filter(Boolean);
      }
      const problems: string[] = [];
      for (const x of records) {
        const r: ServedDigest | undefined = x?.result;
        if (!r) { problems.push(`${x?.id}: no served digest`); continue; }
        if (r.domain !== DOMAINS.executionResult) problems.push(`${x.id}: domain ${r.domain}, not ${DOMAINS.executionResult}`);
        for (const p of verifyServed(r)) problems.push(`${x.id}: ${p}`);
      }
      if (records.length === 0) set("FX-DIG-3", "not checked", "no execution record is recorded yet (run with --probe to make one)");
      else set("FX-DIG-3", problems.length ? "violated" : "held", problems.length ? problems.slice(0, 5).join("; ") : `${records.length} execution record(s): each digest is SHA-256 over the domain tag and the served RFC 8785 bytes`, { records: records.length });
    }
  }

  // ---- FX-LOOK-1, -2, -3 ----
  const lookNeeds = (id: FixturePropertyId) => {
    if (skipWrites(id)) return false;
    if (!built(opRoute)) { set(id, "not checked", `GET /operations/:key answered ${opRoute.status || opRoute.error}`); return false; }
    if (!k1 || created?.status !== 201) { set(id, "not checked", `the probe create answered ${created?.status ?? "nothing"}`); return false; }
    return true;
  };
  if (lookNeeds("FX-LOOK-1")) {
    const k2 = newKey();
    const second = await post(k2, { title: `fx-check probe ${k2}`, project: "inbox" });
    const problems: string[] = [];
    const ticketOf = (r: Reply | undefined) => r?.body?.ticket?.id;
    for (const [key, made] of [[k1!, created], [k2, second]] as const) {
      for (const [route, rep] of [["evidence", await ev(`/operations/${encodeURIComponent(key)}`)], ["backend", await backendGet(`/operations/${encodeURIComponent(key)}`)]] as const) {
        const op = findRecord(rep.body, "operation-record/1");
        if (rep.status !== 200 || !op) { problems.push(`${route} lookup of ${key} answered ${rep.status}`); continue; }
        if (op.key !== key) { problems.push(`${route} lookup of ${key} answered the record of ${op.key}`); continue; }
        const x = op.execution_id ? await execution(op.execution_id) : undefined;
        const objects = (x?.objects ?? []).map((ob: any) => ob.id);
        if (!objects.includes(ticketOf(made))) problems.push(`${route} lookup of ${key} names ${op.execution_id}, which did not create ${ticketOf(made)}`);
      }
    }
    const absent = await ev(`/operations/${encodeURIComponent(`fxc-${tag}-never-used`)}`);
    if (absent.status !== 404) problems.push(`a lookup of a key never used answered ${absent.status}, not 404`);
    set("FX-LOOK-1", problems.length ? "violated" : "held", problems.length ? problems.join("; ") : "each lookup answered the record of exactly its key, on the evidence and the backend routes; an unused key answered 404", { keys: [k1, k2] });
  }
  if (lookNeeds("FX-LOOK-2")) {
    const before = { executions: await executionCount(), tickets: listOf((await ev("/export")).body, "tickets")?.length };
    const looked: string[] = [];
    // A hit (k1) and a miss (a key never used): a lookup must not write in either case.
    const miss = `fxc-${tag}-never-written`;
    for (const key of [k1!, miss]) {
      for (let i = 0; i < 2; i++) {
        await ev(`/operations/${encodeURIComponent(key)}`); looked.push("evidence");
        await backendGet(`/operations/${encodeURIComponent(key)}`); looked.push("backend");
      }
    }
    if (o.mcp) {
      const mcp = new Mcp(o.mcp);
      await mcp.initialize();
      if ((await mcp.tools()).includes("get_operation")) {
        for (const key of [k1!, miss]) for (let i = 0; i < 2; i++) { await mcp.call("get_operation", { idempotency_key: key }); looked.push("get_operation"); }
      }
    }
    const after = { executions: await executionCount(), tickets: listOf((await ev("/export")).body, "tickets")?.length };
    if (before.executions === undefined) set("FX-LOOK-2", "not checked", "neither /executions nor /ledger answers, so executions cannot be counted");
    else {
      const same = before.executions === after.executions && before.tickets === after.tickets;
      set("FX-LOOK-2", same ? "held" : "violated", same ? `${looked.length} lookups (${[...new Set(looked)].join(", ")}; of a key written and of a key never written) made no execution and no object`
        : `lookups changed the record: executions ${before.executions} to ${after.executions}, tickets ${before.tickets} to ${after.tickets}`, { before, after, lookups: looked.length });
    }
  }
  if (wants("FX-LOOK-3")) {
    if (!o.tokens.second) set("FX-LOOK-3", "not checked", "no second principal's token (FX_CHECK_SECOND_TOKEN or _FILE)");
    else if (lookNeeds("FX-LOOK-3")) {
      const other = await backendGet(`/operations/${encodeURIComponent(k1!)}`, o.tokens.second);
      const own = await backendGet(`/operations/${encodeURIComponent(k1!)}`);
      const problems: string[] = [];
      if (other.status === 401) problems.push("the second token is not accepted (401)");
      else if (other.status !== 404) problems.push(`another principal's lookup of the key answered ${other.status}${findRecord(other.body, "operation-record/1") ? " with the record" : ""}, not 404`);
      if (own.status !== 200) problems.push(`the owner's own lookup answered ${own.status}`);
      set("FX-LOOK-3", problems.length ? (other.status === 401 ? "not checked" : "violated") : "held",
        problems.length ? problems.join("; ") : "another principal's lookup of the key answered 404; the owner's answered the record", { key: k1 });
    }
  }

  // ---- FX-FLT-1: a fault fires only at its point, and the ledger records arming and firing ----
  if (!skipWrites("FX-FLT-1")) {
    if (!control || !o.mcp) set("FX-FLT-1", "not checked", "needs --control with a control token, and --mcp");
    else {
      const mcp = new Mcp(o.mcp);
      await mcp.initialize();
      const k3 = newKey();
      const k4 = newKey();
      const point = "mcp/after-backend-reply/drop";
      // The dropped call has its own operation tag, and the fault is selected by it (fixture-api/1 has no key
      // selector: where the key travels depends on the code under test). Its effect is counted by that tag too, so
      // an MCP-layer key defect is not read as a fault defect.
      const droppedTag = opTag();
      const arm = await ctl("POST", "/_fixture/faults", { point, selector: { tool: "create_ticket", operation: droppedTag, once: true, ...(run ? { run } : {}) } });
      if (arm.status === 501 || arm.status === 404) set("FX-FLT-1", "not checked", `POST /_fixture/faults answered ${arm.status}`);
      else if (arm.status !== 200 && arm.status !== 201) set("FX-FLT-1", "violated", `arming ${point} answered ${arm.status}`);
      else {
        const problems: string[] = [];
        const armedNow = await ev("/build");
        // The descriptor names each armed fault as "<id> <point> <selector>".
        if (wants("FX-BLD-1") && !(armedNow.body?.faults?.armed ?? []).some((a: unknown) => typeof a === "string" && (a === point || a.split(" ").includes(point)))) bld.push(`the descriptor does not name the armed fault ${point}`);
        const runMeta: Record<string, string> = run ? { [META_KEYS.run]: run } : {};
        const other = await mcp.call("create_ticket", { title: `fx-check probe ${k4}`, idempotency_key: k4 }, { [META_KEYS.operation]: opTag(), ...runMeta }, 10000);
        const meta: Record<string, string> = { [META_KEYS.operation]: droppedTag, ...runMeta };
        if (!other.message?.result) problems.push(`a call outside the selector got no answer (${other.error ?? other.status})`);
        const wait = o.dropWaitMs ?? 3000;
        const dropped = await mcp.call("create_ticket", { title: `fx-check probe ${k3}`, idempotency_key: k3 }, meta, wait);
        if (dropped.error !== "timeout") problems.push(`the call at the armed point was answered (${dropped.status})`);
        const execs = ((await ledger()) ?? []).filter((e) => e.kind === "execution" && e.operation_tag === droppedTag);
        const retry = await mcp.call("create_ticket", { title: `fx-check probe ${k3}`, idempotency_key: k3 }, { [META_KEYS.operation]: opTag(), ...runMeta }, 10000);
        if (!retry.message?.result) problems.push("the repeat after a once fault got no answer");
        const l = (await ledger()) ?? [];
        const armedEntry = l.find((e) => e.kind === "fault-armed" && e.fault?.point === point && e.fault?.selector?.operation === droppedTag);
        const fired = l.filter((e) => e.kind === "fault-fired" && e.fault?.point === point);
        if (!armedEntry) problems.push("the ledger has no fault-armed entry for the arming");
        const firedHere = fired.filter((e) => e.fault?.selector?.operation === droppedTag);
        if (firedHere.length !== 1) problems.push(`${firedHere.length} fault-fired entries for the armed selector, not 1`);
        else if (typeof firedHere[0].fault.fired_on_seq !== "number") problems.push("the fault-fired entry names no sequence number it fired on");
        if (execs.length !== 1) problems.push(`${execs.length} executions for the dropped call's operation tag, not 1 (the backend commits before the drop)`);
        set("FX-FLT-1", problems.length ? "violated" : "held", problems.length ? problems.join("; ") : `${point} fired once, at its selector only; the ledger records the arming and the firing`, { point, key: k3 });
      }
    }
  }

  // ---- FX-BLD-1 (part two): the MCP mirror ----
  if (wants("FX-BLD-1")) {
    if (o.mcp) {
      const mcp = new Mcp(o.mcp);
      const init = await mcp.initialize();
      const m = /(\{.*\})\s*$/.exec(String(init?.instructions ?? ""));
      let facts: any;
      try { facts = m ? JSON.parse(m[1]) : undefined; } catch { facts = undefined; }
      if (!facts) bld.push("the MCP instructions carry no build facts");
      else {
        if (facts.build_hash !== d.build_hash) bld.push(`the instructions name build_hash ${facts.build_hash}, /build ${d.build_hash}`);
        if (canonicalize(facts.features ?? null) !== canonicalize(d.features ?? null)) bld.push("the instructions name other features than /build");
        if (canonicalize(facts.defects ?? null) !== canonicalize(d.defects ?? null)) bld.push("the instructions name other defects than /build");
      }
      const tools = await mcp.tools();
      const readTool = ["list_tickets", "list_projects"].find((t) => tools.includes(t));
      if (readTool) {
        const r = await mcp.call(readTool, {});
        const meta = r.message?.result?._meta?.[META_KEYS.build];
        if (!meta) bld.push(`a ${readTool} result carries no ${META_KEYS.build} in _meta`);
        else if (meta.build_hash !== d.build_hash) bld.push(`a result's _meta names build_hash ${meta.build_hash}, /build ${d.build_hash}`);
      }
      bldEvidence.mcp_checked = true;
    }
    set("FX-BLD-1", bld.length ? "violated" : "held", bld.length ? bld.join("; ")
      : `the descriptor's hashes recompute, the header matches${o.mcp ? ", and the MCP instructions and result _meta name the same build" : ""}`, bldEvidence);
  }

  // ---- clean up the probe run ----
  if (run && control) {
    const r = await ctl("POST", `/_fixture/runs/${encodeURIComponent(run)}/reset`, {});
    report.probes.reset = r.status === 200 ? "reset" : `not reset (${r.status})`;
  }

  report.findings = (Object.keys(FIXTURE_PROPERTIES) as FixturePropertyId[]).map((id) => findings.get(id)!).filter(Boolean);
  return report;
}

/** A token from NAME, from the file NAME_FILE names, or from DIR/file. Never from argv. */
export function readToken(env: Record<string, string | undefined>, name: string, dir?: string, file?: string): string | undefined {
  if (env[name]) return env[name]!.trim();
  const path = env[`${name}_FILE`] ?? (dir && file ? join(dir, file) : undefined);
  if (path && existsSync(path)) return readFileSync(path, "utf8").trim();
  return undefined;
}

export function formatReport(r: FxCheckReport): string {
  const lines = [`fx-check against ${r.target.backend}${r.build ? ` (build_hash ${r.build.build_hash})` : ""}`];
  for (const f of r.findings) lines.push(`${f.id.padEnd(10)} ${f.verdict.padEnd(15)} ${f.reason}`);
  const count = (v: Verdict) => r.findings.filter((f) => f.verdict === v).length;
  lines.push(`fx-check: ${count("held")} held, ${count("violated")} violated, ${count("not checked")} not checked, ${count("not applicable")} not applicable`
    + (r.probes.run ? `; probe run ${r.probes.run} ${r.probes.reset ?? ""}`.trimEnd() : ""));
  return `${lines.join("\n")}\n`;
}

const USAGE = `usage: fx-check --backend URL [--mcp URL] [--control URL] [--token-dir DIR] [--principal ID] [--probe] [--json]
Read-only by default; --probe writes probe tickets in a run of its own and resets it afterwards.
Tokens from the environment or a file: TRACKER_EVIDENCE_TOKEN (needed), TRACKER_BACKEND_TOKEN, TRACKER_CONTROL_TOKEN,
FX_CHECK_SECOND_TOKEN (each also as NAME_FILE). Exit 0: nothing violated; 1: a property violated; 2: unusable setup.`;

export async function main(argv: string[], env: Record<string, string | undefined> = process.env, out: { write(s: string): unknown } = process.stdout, err: { write(s: string): unknown } = process.stderr): Promise<number> {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({ args: argv, options: {
      backend: { type: "string" }, mcp: { type: "string" }, control: { type: "string" }, "token-dir": { type: "string" }, principal: { type: "string" },
      probe: { type: "boolean" }, json: { type: "boolean" }, help: { type: "boolean" },
    } }));
  } catch (e) {
    err.write(`fx-check: ${(e as Error).message}\n${USAGE}\n`);
    return 2;
  }
  if (values.help) { out.write(`${USAGE}\n`); return 0; }
  if (typeof values.backend !== "string") { err.write(`fx-check: --backend is required\n${USAGE}\n`); return 2; }
  const dir = (values["token-dir"] as string | undefined) ?? env.TRACKER_TOKEN_DIR;
  const tokens = {
    evidence: readToken(env, "TRACKER_EVIDENCE_TOKEN", dir, "evidence.token"),
    backend: readToken(env, "TRACKER_BACKEND_TOKEN"),
    control: readToken(env, "TRACKER_CONTROL_TOKEN", dir, "control.token"),
    second: readToken(env, "FX_CHECK_SECOND_TOKEN"),
  };
  const all = Object.values(tokens).filter(Boolean) as string[];
  if (argv.some((a) => all.some((t) => t.length >= 8 && a.includes(t)))) { err.write("fx-check: a token is on the command line; give tokens by environment or file only\n"); return 2; }
  if (!tokens.evidence) { err.write("fx-check: no evidence token (TRACKER_EVIDENCE_TOKEN, TRACKER_EVIDENCE_TOKEN_FILE or --token-dir)\n"); return 2; }
  try {
    const report = await fxCheck({ backend: values.backend, mcp: values.mcp as string | undefined, control: values.control as string | undefined,
      tokens: { ...tokens, evidence: tokens.evidence }, probe: values.probe === true,
      ...((values.principal ?? env.FX_CHECK_PRINCIPAL) ? { principal: (values.principal ?? env.FX_CHECK_PRINCIPAL) as string } : {}) });
    out.write(values.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report));
    return report.findings.some((f) => f.verdict === "violated") ? 1 : 0;
  } catch (e) {
    if (e instanceof Unusable) { err.write(`fx-check: ${e.message}\n`); return 2; }
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { process.stderr.write(`fx-check: ${(e as Error).stack ?? e}\n`); process.exit(2); });
}
