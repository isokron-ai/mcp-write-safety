#!/usr/bin/env node
// fx-check: checks a running fixture's FX- properties through its evidence
// API (FIXTURE.md), from outside, the way another harness would. It works
// against any server that declares the endpoints, not only this one.
//
//   fx-check --backend URL [--mcp URL] [--control URL] [--token-dir DIR] [--probe] [--json]
//            [--data-dir DIR] [--durability-plant FILE | --durability-verify FILE]
//
// 0.4.0 adds the durability and retention properties: FX-KEY-2 from the tool
// descriptions (--mcp); FX-KEY-1 by moving the fixture clock to just inside
// the stated retention (feature clock, --control, --probe; it moves the clock
// last, and for good); FX-DUR-1 across a restart (a plant, then a verify);
// FX-DUR-2 from the data dir's files (read only). FX-DUR-3 and FX-KEY-3 need a
// crash or a hold no fault point offers: "not checked", with the reason.
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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
  /**
   * FX-DUR-1 across a restart (0.4.0): `plant` makes one keyed create (outside any run, so the probe reset keeps it) and
   * returns it in the report; `verify` is a plant from before a restart of the same build, checked now.
   */
  durability?: { plant?: boolean; verify?: DurabilityPlant };
  /** FX-DUR-2 (0.4.0): the build's data dir, read (never written) to check the journal format's files and lines. */
  dataDir?: string;
}

export interface FxCheckReport {
  fx_check: typeof FX_CHECK_FORMAT;
  target: { backend: string; mcp: string | null; control: string | null };
  build: { build_hash: string; descriptor_hash: string; features: string[]; defects: unknown } | null;
  probes: { run: string | null; principal: string | null; keys: string[]; reset: string | null };
  findings: Finding[];
  /** With durability.plant: the plant to keep for --durability-verify after a restart. */
  plant?: DurabilityPlant;
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
const CHECKED = new Set<FixturePropertyId>(["FX-BLD-1", "FX-DIG-1", "FX-DIG-2", "FX-DIG-3", "FX-LOOK-1", "FX-LOOK-2", "FX-LOOK-3", "FX-FLT-1",
  "FX-DUR-1", "FX-DUR-2", "FX-DUR-3", "FX-KEY-1", "FX-KEY-2", "FX-KEY-3"]);

/** The files journal-format/1 keeps in a data dir (decision 0003, src/backend/journal.ts); anything else is not the format. */
export const DATA_DIR_FILES = ["tiny-tracker.data", "lock", "lock.d", "journal.jsonl"] as const;

/**
 * Name prefixes of the pid lock's and the lease's own leftovers (src/backend/journal.ts): a temp made before it is
 * linked or renamed into place (`.new-`), a lock or lease moved aside to judge or take it over (`.stale-`), a lease
 * moved aside on release (`.released-`). A crash or a lost race can leave one for a whole run; it holds no key record,
 * so FX-DUR-2 does not count it (note 26 item 2).
 */
export const DATA_DIR_LEFTOVER_PREFIXES = ["lock.new-", "lock.stale-", "lock.d.new-", "lock.d.stale-", "lock.d.released-"] as const;

/** Whether a data-dir entry is one of journal-format/1's files or a lock or lease leftover. */
export function isDataDirFile(name: string): boolean {
  return (DATA_DIR_FILES as readonly string[]).includes(name) || DATA_DIR_LEFTOVER_PREFIXES.some((p) => name.startsWith(p));
}

/**
 * What --durability-plant writes and --durability-verify reads (FX-DUR-1): one keyed create made before a restart.
 * No token is kept in it.
 */
export interface DurabilityPlant {
  fx_check_plant: "fx-check-plant/1";
  build_hash: string;
  boot_id: string;
  principal: string | null;
  key: string;
  request: { path: string; body: unknown };
  status: number;
  execution_id: string | null;
  /** The response body as committed, in RFC 8785 form. */
  canonical: string;
}

/** "A key is remembered for 7 days; ..." → milliseconds, or undefined (FX-KEY-2's sentence, src/backend/expiry.ts). */
export function statedRetentionMs(text: string): number | undefined {
  const m = /A key is remembered for (\d+) (day|hour|minute|second|ms)s?\b/.exec(text);
  if (!m) return undefined;
  const unit = { day: 86_400_000, hour: 3_600_000, minute: 60_000, second: 1000, ms: 1 }[m[2] as "day"];
  return Number(m[1]) * unit;
}

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
    return (await this.toolList()).map((t: any) => t.name);
  }

  async toolList(): Promise<any[]> {
    const r = await this.rpc("tools/list", {});
    return r.message?.result?.tools ?? [];
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
    // A hit (k1) and a miss (a key never used): a lookup must not write in either case. The miss key's first eight
    // characters differ from every probe key's (fxc-<tag>), so a lookup that matches keys by prefix (the
    // lookup-wrong-record defect) still misses on it instead of answering a probe key's record and hiding a re-execution.
    const miss = `fxm-${tag}-never-written`;
    for (const key of [k1!, miss]) {
      for (let i = 0; i < 2; i++) {
        await ev(`/operations/${encodeURIComponent(key)}`); looked.push("evidence");
        await backendGet(`/operations/${encodeURIComponent(key)}`); looked.push("backend");
      }
    }
    // The MCP lookup tool, where the build has one: the lookup feature, and get_operation not left out by its tool list.
    const cfgTools = d.config?.tools;
    const mcpLookupDeclared = features.includes("lookup") && (cfgTools === null || cfgTools === undefined || (Array.isArray(cfgTools) && cfgTools.includes("get_operation")));
    let mcpLookupProbed = false;
    if (o.mcp) {
      const mcp = new Mcp(o.mcp);
      await mcp.initialize();
      if ((await mcp.tools()).includes("get_operation")) {
        // Tagged with the probe run (and its own operation tag), so a write a defective lookup makes is attributed to
        // the probe run and removed by its reset.
        const runMeta: Record<string, string> = run ? { [META_KEYS.run]: run } : {};
        for (const key of [k1!, miss]) for (let i = 0; i < 2; i++) { await mcp.call("get_operation", { idempotency_key: key }, { [META_KEYS.operation]: opTag(), ...runMeta }); looked.push("get_operation"); }
        mcpLookupProbed = true;
      }
    }
    const after = { executions: await executionCount(), tickets: listOf((await ev("/export")).body, "tickets")?.length };
    if (before.executions === undefined) set("FX-LOOK-2", "not checked", "neither /executions nor /ledger answers, so executions cannot be counted");
    else {
      const same = before.executions === after.executions && before.tickets === after.tickets;
      if (same && mcpLookupDeclared && !mcpLookupProbed) {
        // A held answer would cover only the backend routes: the build has an MCP lookup tool that was not called.
        set("FX-LOOK-2", "not checked", `the backend lookups (${looked.length}) made no execution and no object, but the build's get_operation tool was not called: give --mcp`, { before, after, lookups: looked.length });
      } else set("FX-LOOK-2", same ? "held" : "violated", same ? `${looked.length} lookups (${[...new Set(looked)].join(", ")}; of a key written and of a key never written) made no execution and no object`
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

  // ---- FX-KEY-2: every key-accepting tool states the key retention (read-only, needs --mcp) ----
  let stated: number | undefined;
  if (wants("FX-KEY-2") || wants("FX-KEY-1")) {
    if (!o.mcp) {
      for (const id of ["FX-KEY-2", "FX-KEY-1"] as const) if (wants(id)) set(id, "not checked", "needs --mcp: the stated retention is read from the tool descriptions");
    } else {
      const mcp = new Mcp(o.mcp);
      const init = await mcp.initialize();
      const tools = await mcp.toolList();
      const keyed = tools.filter((t) => t?.inputSchema?.properties && "idempotency_key" in t.inputSchema.properties);
      const values = keyed.map((t) => ({ name: t.name as string, ms: statedRetentionMs(String(t.description ?? "")) }));
      const unstated = values.filter((v) => v.ms === undefined).map((v) => v.name);
      const distinct = [...new Set(values.map((v) => v.ms).filter((v) => v !== undefined))];
      const inInstructions = statedRetentionMs(String(init?.instructions ?? ""));
      stated = distinct.length === 1 ? distinct[0] : undefined;
      if (wants("FX-KEY-2")) {
        const problems: string[] = [];
        if (keyed.length === 0) problems.push("no tool takes an idempotency_key");
        if (unstated.length) problems.push(`${unstated.join(", ")} state${unstated.length === 1 ? "s" : ""} no key retention`);
        if (distinct.length > 1) problems.push(`the tools state ${distinct.length} different retentions`);
        if (inInstructions !== undefined && stated !== undefined && inInstructions !== stated) problems.push("the server instructions state another retention than the tools");
        set("FX-KEY-2", problems.length ? "violated" : "held", problems.length ? problems.join("; ")
          : `all ${keyed.length} key-accepting tools state the same retention (${stated} ms)${inInstructions !== undefined ? ", as do the server instructions" : ""}`,
          { tools: keyed.length, retention_ms: stated ?? null, instructions: inInstructions ?? null });
      }
    }
  }

  // ---- FX-DUR-1: a keyed create survives a whole-stack restart (plant, then verify after the restart) ----
  if (o.durability?.verify && wants("FX-DUR-1")) {
    const p = o.durability.verify;
    const bootNow = d.process?.boot_id;
    if (p.build_hash !== d.build_hash) set("FX-DUR-1", "not checked", `the plant is from build ${p.build_hash}, this is ${d.build_hash}`);
    else if (p.boot_id === bootNow) set("FX-DUR-1", "not checked", "the boot_id is the plant's: the stack was not restarted");
    else if (!o.tokens.backend) set("FX-DUR-1", "not checked", "no backend token: the repeat after the restart is a write");
    else {
      const before = await executionCount();
      const again = await request(`${base}${p.request.path}`, {
        method: "POST", headers: { authorization: `Bearer ${o.tokens.backend}`, "content-type": "application/json", [HEADERS.operation]: opTag(), "idempotency-key": p.key },
        body: JSON.stringify(p.request.body),
      });
      const after = await executionCount();
      const problems: string[] = [];
      if (again.status !== p.status) problems.push(`the repeat after the restart answered ${again.status}, the first write ${p.status}`);
      else {
        if (again.headers.get("idempotent-replayed") !== "true") problems.push("the repeat after the restart is not marked as a replay");
        // The same write, not the same bytes: whether a replay's bytes equal the first answer's is FX-DIG-2's property.
        const firstId = (JSON.parse(p.canonical) as any)?.ticket?.id;
        if (firstId !== undefined && again.body?.ticket?.id !== firstId) problems.push(`the repeat after the restart names ticket ${again.body?.ticket?.id}, the first write ${firstId}`);
        const x = again.headers.get("tiny-tracker-execution");
        if (p.execution_id && x !== null && x !== p.execution_id) problems.push(`the repeat names execution ${x}, the first write ${p.execution_id}`);
      }
      if (before !== undefined && after !== undefined && after !== before) problems.push(`the repeat made ${after - before} new execution(s)`);
      set("FX-DUR-1", problems.length ? "violated" : "held", problems.length ? problems.join("; ")
        : `after the restart (boot ${p.boot_id} → ${bootNow}) the keyed repeat was answered as a replay of ${p.execution_id ?? "the first write"}, naming the same ticket, with no new execution`,
        { key: p.key, boot_before: p.boot_id, boot_after: bootNow });
    }
  } else if (o.durability?.plant && wants("FX-DUR-1")) {
    // Planted after FX-KEY-1 below: that check moves the fixture clock by almost the whole retention, and with durable
    // the offset survives the restart, so a key planted before the move would reach the verify nearly expired.
  } else if (wants("FX-DUR-1")) set("FX-DUR-1", "not checked", "needs a restart: plant with --durability-plant FILE, restart the stack, then --durability-verify FILE");

  // ---- FX-DUR-2: the effect and its key record are one journal line (the data dir's files, read only) ----
  if (wants("FX-DUR-2")) {
    if (!o.dataDir) set("FX-DUR-2", "not checked", "needs --data-dir: the journal's files are read from it (never written)");
    else {
      const { readdirSync } = await import("node:fs");
      let names: string[] = [];
      let lines: any[] = [];
      try {
        names = readdirSync(o.dataDir);
        const text = readFileSync(join(o.dataDir, "journal.jsonl"), "utf8");
        lines = text.split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
      } catch (e) {
        set("FX-DUR-2", "not checked", `the data dir could not be read: ${(e as Error).message}`);
      }
      if (wants("FX-DUR-2")) {
        const problems: string[] = [];
        const extra = names.filter((n) => !isDataDirFile(n));
        if (extra.length) problems.push(`the data dir holds ${extra.join(", ")} beside the journal: key records kept in another file are written apart from their effect`);
        const keyed = lines.filter((l) => l?.line === "commit" && l?.tx?.request?.key);
        // A key record is rebuilt from its commit line: the request's key, the status, the committed body and headers.
        const bare = keyed.filter((l) => l.tx.body === undefined || l.tx.headers === undefined || typeof l.tx.status !== "number");
        if (bare.length) problems.push(`${bare.length} keyed commit line(s) carry no committed answer to rebuild the key record from`);
        if (keyed.length === 0 && !problems.length) set("FX-DUR-2", "not checked", "the journal holds no keyed commit yet (run with --probe first)");
        else set("FX-DUR-2", problems.length ? "violated" : "held", problems.length ? problems.join("; ")
          : `${keyed.length} keyed commit line(s), each with its key and reply in the one line; the data dir holds only the journal-format/1 files`,
          { keyed_lines: keyed.length, files: names.sort() });
      }
    }
  }

  // ---- FX-DUR-3 and FX-KEY-3: need a crash or a hold the fault points do not offer ----
  if (wants("FX-DUR-3")) set("FX-DUR-3", "not checked", "needs a crash between the journal append and the answer, which no fault point offers; the crash suite (T1) covers it");
  if (wants("FX-KEY-3")) set("FX-KEY-3", "not checked", "needs a backend request held before commit, which no built fault point offers; the inflight tests cover it");

  // ---- FX-KEY-1: a key is remembered for at least the stated retention (moves the fixture clock: last) ----
  if (!skipWrites("FX-KEY-1")) {
    if (!control) set("FX-KEY-1", "not checked", "needs --control with a control token (the fixture clock moves there)");
    else if (d.clock?.domain === undefined || !(Array.isArray(d.features) && d.features.includes("clock"))) set("FX-KEY-1", "not checked", "the build has no fixture clock (feature clock): the retention cannot be waited out");
    else if (stated === undefined) set("FX-KEY-1", "not checked", "no single stated retention to check against (FX-KEY-2)");
    else {
      const key = newKey();
      const body = { title: `fx-check retention probe ${key}`, project: "inbox" };
      const send = () => request(`${base}/tickets`, {
        method: "POST", headers: { authorization: `Bearer ${o.tokens.backend}`, "content-type": "application/json", [HEADERS.operation]: opTag(), ...(run ? { [HEADERS.run]: run } : {}), "idempotency-key": key },
        body: JSON.stringify(body),
      });
      const first = await send();
      // Just inside the stated retention: a minute short of it (half of it when it is two minutes or less).
      const advance = stated > 120_000 ? stated - 60_000 : Math.floor(stated / 2);
      // The clock route's 200 is not taken on trust (note 26 item 6): /build's clock.offset_ms must move by the advance.
      const offsetNow = async (): Promise<number | undefined> => {
        const b = await ev("/build");
        const v = b.status === 200 ? b.body?.clock?.offset_ms : undefined;
        return typeof v === "number" && Number.isFinite(v) ? v : undefined;
      };
      const offsetBefore = first.status === 201 ? await offsetNow() : undefined;
      const moved = first.status === 201 ? await ctl("POST", "/_fixture/clock", { advance_ms: advance }) : undefined;
      const offsetAfter = moved?.status === 200 ? await offsetNow() : undefined;
      if (first.status !== 201) set("FX-KEY-1", "not checked", `the probe create answered ${first.status}`);
      else if (moved?.status !== 200) set("FX-KEY-1", "not checked", `moving the fixture clock answered ${moved?.status}`);
      else if (offsetBefore === undefined || offsetAfter === undefined) set("FX-KEY-1", "not checked", "the clock move answered 200, but /build names no clock.offset_ms to confirm it");
      else if (offsetAfter - offsetBefore < advance) {
        set("FX-KEY-1", "not checked", `the clock move by ${advance} ms answered 200, but /build's clock.offset_ms went from ${offsetBefore} to ${offsetAfter}: the clock did not move, so the retention was not waited out`,
          { offset_before_ms: offsetBefore, offset_after_ms: offsetAfter, advance_ms: advance });
      } else {
        const again = await send();
        // A replay of the same write (its bytes are FX-DIG-2's property, not this one's).
        const replayed = again.status === first.status && again.headers.get("idempotent-replayed") === "true"
          && again.body?.ticket?.id !== undefined && again.body?.ticket?.id === first.body?.ticket?.id;
        set("FX-KEY-1", replayed ? "held" : "violated", replayed
          ? `${advance} ms after the write (stated retention ${stated} ms) the keyed repeat was still answered as a replay`
          : `${advance} ms after the write, inside the stated retention of ${stated} ms, the keyed repeat answered ${again.status}${again.body?.error ? ` ${again.body.error}` : ""}, not a replay`,
          { key, advance_ms: advance, retention_ms: stated });
      }
    }
  }

  // ---- FX-DUR-1, the plant: after FX-KEY-1's clock move, so the planted key is fresh at the restart (0.4.0: the
  // journal keeps the clock's offset across it) and only durability is measured ----
  if (!o.durability?.verify && o.durability?.plant && wants("FX-DUR-1")) {
    if (!o.tokens.backend || o.probe !== true) set("FX-DUR-1", "not checked", "the plant is a write: needs --probe and a backend token");
    else {
      const key = newKey();
      const body = { title: `fx-check durability plant ${key}`, project: "inbox" };
      // No run tag: the probe run is reset at the end, and a reset would remove what the restart must show.
      const r = await request(`${base}/tickets`, {
        method: "POST", headers: { authorization: `Bearer ${o.tokens.backend}`, "content-type": "application/json", [HEADERS.operation]: opTag(), "idempotency-key": key },
        body: JSON.stringify(body),
      });
      if (r.status !== 201) set("FX-DUR-1", "not checked", `the plant create answered ${r.status}`);
      else {
        report.plant = { fx_check_plant: "fx-check-plant/1", build_hash: d.build_hash, boot_id: d.process?.boot_id, principal, key,
          request: { path: "/tickets", body }, status: r.status, execution_id: r.headers.get("tiny-tracker-execution"), canonical: canonicalize(r.body ?? null) };
        set("FX-DUR-1", "not checked", `planted ${key}; restart the stack on the same data dir and run --durability-verify with the plant`, { key });
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
                [--data-dir DIR] [--durability-plant FILE | --durability-verify FILE]
Read-only by default; --probe writes probe tickets in a run of its own and resets it afterwards.
FX-DUR-1 needs a restart: --probe --durability-plant FILE writes one keyed ticket (outside the run) and keeps it in
FILE; restart the stack on the same data dir, then --durability-verify FILE checks its repeat is a replay.
--data-dir DIR is read (never written) for FX-DUR-2. FX-KEY-1 moves the fixture clock (feature clock, --probe).
Tokens from the environment or a file: TRACKER_EVIDENCE_TOKEN (needed), TRACKER_BACKEND_TOKEN, TRACKER_CONTROL_TOKEN,
FX_CHECK_SECOND_TOKEN (each also as NAME_FILE). Exit 0: nothing violated; 1: a property violated; 2: unusable setup.`;

export async function main(argv: string[], env: Record<string, string | undefined> = process.env, out: { write(s: string): unknown } = process.stdout, err: { write(s: string): unknown } = process.stderr): Promise<number> {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({ args: argv, options: {
      backend: { type: "string" }, mcp: { type: "string" }, control: { type: "string" }, "token-dir": { type: "string" }, principal: { type: "string" },
      probe: { type: "boolean" }, json: { type: "boolean" }, help: { type: "boolean" },
      "durability-plant": { type: "string" }, "durability-verify": { type: "string" }, "data-dir": { type: "string" },
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
    let verify: DurabilityPlant | undefined;
    if (typeof values["durability-verify"] === "string") {
      try {
        verify = JSON.parse(readFileSync(values["durability-verify"], "utf8"));
      } catch (e) {
        err.write(`fx-check: --durability-verify: ${(e as Error).message}\n`);
        return 2;
      }
      if (verify?.fx_check_plant !== "fx-check-plant/1") { err.write("fx-check: --durability-verify names no fx-check plant\n"); return 2; }
    }
    const report = await fxCheck({ backend: values.backend, mcp: values.mcp as string | undefined, control: values.control as string | undefined,
      tokens: { ...tokens, evidence: tokens.evidence }, probe: values.probe === true,
      ...(verify ? { durability: { verify } } : typeof values["durability-plant"] === "string" ? { durability: { plant: true } } : {}),
      ...(typeof values["data-dir"] === "string" ? { dataDir: values["data-dir"] } : {}),
      ...((values.principal ?? env.FX_CHECK_PRINCIPAL) ? { principal: (values.principal ?? env.FX_CHECK_PRINCIPAL) as string } : {}) });
    if (report.plant && typeof values["durability-plant"] === "string") writeFileSync(values["durability-plant"], `${JSON.stringify(report.plant, null, 2)}\n`, { mode: 0o600 });
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
