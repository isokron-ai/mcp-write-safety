// A stand-in for a 0.2.0 tiny-tracker (stream C's test double). It serves what
// streams A and B build, shaped by the frozen schemas: the backend API with
// keyed creates, the evidence namespace (/build, /export, /ledger,
// /executions, /operations), the control listener (runs, fault arming) and a
// small JSON-RPC MCP endpoint with create_ticket, get_operation,
// get_execution and list_tickets.
//
// The record shapes come from src/records.ts and the schemas, and the digests
// and hashes from src/digest.ts and the real BuildDescriptor, so the harness,
// fx-check and the Python recount are tested against the same bytes the real
// build serves. The members the frozen interface does not fix (response
// envelopes, tool argument names, the fault-arming body) are this file's
// assumptions; docs/streams/C.md lists each one for the merge.
//
// Defect switches model the planned FX defects, so the checks can be seen to
// catch each one.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { canonicalize, digestOf, domainDigest, DOMAINS, fingerprintHash, type ServedDigest } from "../../src/digest.js";
import { BuildDescriptor } from "../../src/fixture/descriptor.js";
import { executionId, type ExecutionRecord, type LedgerEntry, type OperationRecord } from "../../src/records.js";
import { META_KEYS } from "../../src/fixture-properties.js";

export interface FakeDefects {
  /** MCP layer: create_ticket never forwards the key (idempotency-key-dropped). */
  keyDropped: boolean;
  /** MCP layer: create_ticket answers a seen key from a cache keyed by the key alone (idempotency-key-ignores-args). */
  ignoresArgs: boolean;
  /** FX-DIG-1: the execution record is hashed from the object's current state when served. */
  digestOfCurrentState: boolean;
  /** FX-DIG-2: a replay answers with a fresh serialization (a new updated_at), not the committed bytes. */
  replayDigestMismatch: boolean;
  /** FX-DIG-3: the served canonical bytes are not RFC 8785 (insertion order). */
  digestNotCanonical: boolean;
  /** FX-DIG-3 / D2: the digest leaves out the domain tag. */
  digestWithoutDomain: boolean;
  /** FX-LOOK-1: a lookup answers the most recent key record, whatever the key. */
  lookupWrongRecord: boolean;
  /** FX-LOOK-2: get_operation and GET /operations/:key run the write again. */
  lookupExecutes: boolean;
  /** FX-LOOK-3: lookups search every principal's records. */
  lookupUnscoped: boolean;
  /** FX-BLD-1: the served descriptor_hash is not the hash of the descriptor. */
  descriptorHashWrong: boolean;
}

export interface FakeOptions {
  defects?: Partial<FakeDefects>;
  /** Tools to leave out of tools/list (and refuse), e.g. ["get_operation"] for a 0.1-like surface. */
  withoutTools?: string[];
  /** Evidence paths that answer 501 not_built, e.g. ["/ledger"]. */
  notBuilt?: string[];
  features?: string[];
}

export interface FakeFixture {
  mcp: string;
  backend: string;
  control: string;
  tokens: { backend: string; second: string; evidence: string; control: string };
  descriptor: BuildDescriptor;
  /** The state line a real `tiny-tracker all` would print. */
  stateLine: Record<string, unknown>;
  /** Number of execution records (the commit sequence). */
  executions(): number;
  close(): Promise<void>;
}

interface Ticket { id: string; project: string; title: string; description: string; priority: number; status: string; version: number; created_at: string; updated_at: string; run: string | null }

interface KeyRecord { fingerprint: string; fingerprintHash: string; status: number; body: unknown; execution: string; run: string | null; createdAt: string; principal: string; key: string }

const TAG = /^[A-Za-z0-9._:-]{1,128}$/;
const tag = (v: unknown) => (typeof v === "string" && TAG.test(v) ? v : null);

const FEATURES_020 = ["evidence", "execution-records", "lookup", "principals", "ledger", "faults"];

export async function startFakeFixture(options: FakeOptions = {}): Promise<FakeFixture> {
  const d: FakeDefects = {
    keyDropped: false, ignoresArgs: false, digestOfCurrentState: false, replayDigestMismatch: false, digestNotCanonical: false,
    digestWithoutDomain: false, lookupWrongRecord: false, lookupExecutes: false, lookupUnscoped: false, descriptorHashWrong: false,
    ...options.defects,
  };
  const without = new Set(options.withoutTools ?? []);
  const notBuilt = new Set(options.notBuilt ?? []);
  const hex = () => randomBytes(12).toString("hex");
  const tokens = { backend: `fake-backend-${hex()}`, second: `fake-second-${hex()}`, evidence: `fake-evidence-${hex()}`, control: `fake-control-${hex()}` };
  const principals = new Map([[tokens.backend, "p-default"], [tokens.second, "p-second"]]);
  const mcpDefects = [d.keyDropped ? "idempotency-key-dropped" : "", d.ignoresArgs ? "idempotency-key-ignores-args" : "", d.lookupExecutes ? "lookup-reexecutes" : ""].filter(Boolean);
  const backendDefects = [d.digestOfCurrentState ? "digest-of-current-state" : "", d.replayDigestMismatch ? "replay-digest-mismatch" : "",
    d.digestNotCanonical || d.digestWithoutDomain ? "digest-not-canonical" : "", d.lookupWrongRecord ? "lookup-wrong-record" : "", d.lookupUnscoped ? "lookup-unscoped" : ""].filter(Boolean);
  const descriptor = new BuildDescriptor({ layout: "all", profile: "default", features: options.features ?? FEATURES_020, mcpDefects, backendDefects, variants: [], control: true });
  descriptor.serverSettings = { read_only: false, tools: null, deny_tools: null, default_project: "inbox", key_journal: false };

  const tickets = new Map<string, Ticket>();
  let nextTicket = 1;
  let commitSeq = 0;
  const executions: ExecutionRecord[] = [];
  const ledger: LedgerEntry[] = [];
  const keys = new Map<string, KeyRecord>();
  let lastKey: KeyRecord | undefined;
  const runs: Array<{ run_id: string; principal: string; label: string | null; created_at: string }> = [];
  const armed: Array<{ id: string; point: string; selector: Record<string, unknown>; once: boolean }> = [];
  let armedSeq = 0;
  const mcpCache = new Map<string, unknown>(); // ignoresArgs
  const now = () => new Date().toISOString();

  const ledgerAdd = (e: Omit<LedgerEntry, "entry" | "seq" | "at" | "clock_offset_ms" | "boot_id">) => {
    const entry: LedgerEntry = { entry: "ledger-entry/1", seq: ledger.length + 1, at: now(), clock_offset_ms: 0, boot_id: descriptor.bootId, ...e };
    ledger.push(entry);
    return entry;
  };
  ledgerAdd({ kind: "start", principal: null, run: null, operation_tag: null, request: null, status: null, execution_id: null, objects: [], fault: null });

  const served = (body: unknown): ServedDigest => {
    if (d.digestNotCanonical) {
      const text = JSON.stringify(body);
      return { alg: "sha-256", domain: DOMAINS.executionResult, canonical: text, digest: domainDigest(DOMAINS.executionResult, text) };
    }
    const s = digestOf(DOMAINS.executionResult, body);
    if (d.digestWithoutDomain) {
      return { ...s, digest: createHash("sha256").update(s.canonical, "utf8").digest("hex") };
    }
    return s;
  };

  interface Attribution { principal: string; run: string | null; operation: string | null }

  /** The backend's write path: one commit, one execution record, one ledger entry. */
  function commit(a: Attribution, method: "POST" | "PATCH", path: string, key: string | null, reqBody: unknown, status: number, body: unknown, objects: ExecutionRecord["objects"]): ExecutionRecord {
    commitSeq++;
    const request = { method, path, key, fingerprint_hash: fingerprintHash(a.principal, method, path, reqBody) };
    const rec: ExecutionRecord = {
      record: "execution-record/1", id: executionId(commitSeq), principal: a.principal, run: a.run, operation_tag: a.operation,
      boot_id: descriptor.bootId, seq: commitSeq, request, objects, result: served(body), committed_at: now(), clock_offset_ms: 0,
    };
    executions.push(rec);
    ledgerAdd({ kind: "execution", principal: a.principal, run: a.run, operation_tag: a.operation, request, status, execution_id: rec.id, objects, fault: null });
    return rec;
  }

  function createTicket(a: Attribution, key: string | null, reqBody: any): { status: number; body: any; replayed: boolean; execution?: string } {
    const path = "/tickets";
    if (key !== null) {
      const fp = `POST ${path} ${canonicalize(reqBody ?? null)}`;
      const scopeId = `${a.principal}\u0000${key}`;
      const seen = keys.get(scopeId);
      const request = { method: "POST", path, key, fingerprint_hash: fingerprintHash(a.principal, "POST", path, reqBody) };
      if (seen && seen.fingerprint !== fp) {
        ledgerAdd({ kind: "refusal", principal: a.principal, run: a.run, operation_tag: a.operation, request, status: 422, execution_id: null, objects: [], fault: null });
        return { status: 422, body: { error: "idempotency_key_reused", message: "this Idempotency-Key was already used for a different request" }, replayed: false };
      }
      if (seen) {
        ledgerAdd({ kind: "replay", principal: a.principal, run: a.run, operation_tag: a.operation, request, status: seen.status, execution_id: seen.execution, objects: [], fault: null });
        let body = seen.body as any;
        if (d.replayDigestMismatch) body = { ticket: { ...body.ticket, updated_at: new Date(Date.now() + 1).toISOString() } };
        return { status: seen.status, body, replayed: true, execution: seen.execution };
      }
    }
    if (typeof reqBody?.title !== "string" || reqBody.title.length < 1) {
      return { status: 400, body: { error: "invalid", message: "title: required" }, replayed: false };
    }
    const at = now();
    const t: Ticket = { id: `T-${nextTicket++}`, project: reqBody.project ?? "inbox", title: reqBody.title, description: reqBody.description ?? "",
      priority: reqBody.priority ?? 2, status: "open", version: 1, created_at: at, updated_at: at, run: a.run };
    tickets.set(t.id, t);
    const body = { ticket: publicTicket(t) };
    const rec = commit(a, "POST", path, key, reqBody, 201, body, [{ type: "ticket", id: t.id }]);
    if (key !== null) {
      const kr: KeyRecord = { fingerprint: `POST ${path} ${canonicalize(reqBody ?? null)}`, fingerprintHash: rec.request.fingerprint_hash, status: 201, body,
        execution: rec.id, run: a.run, createdAt: rec.committed_at, principal: a.principal, key };
      keys.set(`${a.principal}\u0000${key}`, kr);
      lastKey = kr;
    }
    return { status: 201, body, replayed: false, execution: rec.id };
  }

  const publicTicket = (t: Ticket) => ({ id: t.id, project: t.project, title: t.title, description: t.description, priority: t.priority, status: t.status, version: t.version, created_at: t.created_at, updated_at: t.updated_at });

  function executionView(rec: ExecutionRecord): ExecutionRecord {
    if (!d.digestOfCurrentState) return rec;
    const obj = rec.objects[0];
    const t = obj ? tickets.get(obj.id) : undefined;
    return t ? { ...rec, result: served({ ticket: publicTicket(t) }) } : rec;
  }

  function findKey(principal: string, key: string, a?: Attribution): KeyRecord | undefined {
    if (d.lookupExecutes && a) {
      const k = keys.get(`${principal}\u0000${key}`);
      if (k) commit({ principal, run: a.run, operation: a.operation }, "POST", "/tickets", key, null, 201, k.body, []);
    }
    if (d.lookupWrongRecord) return lastKey;
    if (d.lookupUnscoped) return [...keys.values()].find((k) => k.key === key);
    return keys.get(`${principal}\u0000${key}`);
  }

  function operationRecord(k: KeyRecord): OperationRecord {
    const exec = executions.find((e) => e.id === k.execution)!;
    return { record: "operation-record/1", key: k.key, principal: k.principal, run: k.run, state: "completed", fingerprint_hash: k.fingerprintHash,
      created_at: k.createdAt, completed_at: k.createdAt, expires_at: null, clock_offset_ms: 0, execution_id: k.execution,
      result_digest: executionView(exec).result.digest, status: k.status };
  }

  // As the real build (stream A's EvidenceReader): a miss names the key and the principal.
  const noRecord = (key: string, principal?: string) => ({ error: "no_record", message: "no record of this key now; this does not mean nothing was written: a request still on its way can land later", key, ...(principal ? { principal } : {}) });
  const PRINCIPAL_IDS = [...principals.values()];
  /** The frozen ?principal= rule (INTERFACES §1.4): required here, since the double configures two principals. */
  const principalOf = (q: URLSearchParams): string | [number, unknown] => {
    const asked = q.get("principal");
    if (asked === null) return [400, { error: "principal_required", message: "more than one principal is configured; name one with ?principal=<id>", principals: PRINCIPAL_IDS }];
    if (!PRINCIPAL_IDS.includes(asked)) return [400, { error: "unknown_principal", message: `no principal ${asked} is configured`, principal: asked }];
    return asked;
  };

  // ---- backend listener: the API (principal tokens) and the evidence namespace (evidence token) ----
  async function backendHandle(req: IncomingMessage, res: ServerResponse, url: URL, body: any): Promise<[number, unknown, Record<string, string>?]> {
    const auth = req.headers.authorization ?? "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const parts = url.pathname.split("/").filter(Boolean);
    if (bearer === tokens.evidence && req.method === "GET") {
      const p = `/${parts[0] ?? ""}`;
      if (notBuilt.has(p)) return [501, { error: "not_enabled", feature: p.slice(1), available_from: "0.2.0", message: "not built" }];
      if (p === "/build") {
        const json = descriptor.toJSON();
        if (d.descriptorHashWrong) json.descriptor_hash = "0".repeat(64);
        return [200, json, { "tiny-tracker-build": json.build_hash }];
      }
      if (p === "/executions" && parts.length === 2) {
        // Seams v2.1 (§1.4): ?principal= optional on an execution id; a mismatch answers as an unknown id.
        const asked = url.searchParams.get("principal");
        const rec = executions.find((e) => e.id === decodeURIComponent(parts[1]));
        return rec && (asked === null || rec.principal === asked) ? [200, executionView(rec)] : [404, { error: "not_found", message: `no execution record ${decodeURIComponent(parts[1])}` }];
      }
      const who = principalOf(url.searchParams);
      if (typeof who !== "string") return who as [number, unknown];
      const mine = (x: { principal: string | null }) => x.principal === who;
      if (p === "/export") return [200, { principal: who, projects: [{ key: "inbox", name: "Inbox" }], tickets: [...tickets.values()].map((t) => ({ ...publicTicket(t), run: t.run })) }];
      if (p === "/ledger") return [200, { principal: who, entries: ledger.filter((e) => e.principal === null || mine(e)), next_after: null }];
      if (p === "/executions" && parts.length === 1) return [200, { principal: who, executions: executions.filter(mine).map(executionView) }];
      if (p === "/operations" && parts.length === 2) {
        const key = decodeURIComponent(parts[1]);
        const k = findKey(who, key);
        return k ? [200, operationRecord(k)] : [404, noRecord(key, who)];
      }
    }
    const principal = principals.get(bearer);
    if (!principal) return [401, { error: "unauthorized", message: "missing or wrong bearer token" }];
    const a: Attribution = { principal, run: tag(req.headers["tiny-tracker-run"]), operation: tag(req.headers["tiny-tracker-operation"]) };
    if (parts[0] === "tickets" && parts.length === 1 && req.method === "POST") {
      const key = (req.headers["idempotency-key"] as string | undefined) ?? null;
      const r = createTicket(a, key, body);
      return [r.status, r.body, r.replayed ? { "idempotent-replayed": "true" } : {}];
    }
    if (parts[0] === "tickets" && parts.length === 1 && req.method === "GET") {
      const prefix = url.searchParams.get("title_prefix");
      return [200, { tickets: [...tickets.values()].filter((t) => prefix === null || t.title.startsWith(prefix)).map(publicTicket) }];
    }
    if (parts[0] === "tickets" && parts.length === 2) {
      const t = tickets.get(decodeURIComponent(parts[1]));
      if (!t) return [404, { error: "not_found", message: "no such ticket" }];
      if (req.method === "GET") return [200, { ticket: publicTicket(t) }];
      if (req.method === "PATCH") {
        for (const k of ["title", "description", "priority", "status"] as const) if (body?.[k] !== undefined) (t as any)[k] = body[k];
        t.version++;
        t.updated_at = now();
        const out = { ticket: publicTicket(t) };
        commit(a, "PATCH", url.pathname, null, body, 200, out, [{ type: "ticket", id: t.id }]);
        return [200, out];
      }
    }
    if (parts[0] === "operations" && parts.length === 2 && req.method === "GET") {
      const k = findKey(principal, decodeURIComponent(parts[1]), a);
      return k ? [200, operationRecord(k)] : [404, noRecord(decodeURIComponent(parts[1]))];
    }
    if (parts[0] === "export" && req.method === "GET") return [200, { projects: [{ key: "inbox", name: "Inbox" }], tickets: [...tickets.values()].map(publicTicket) }];
    return [404, { error: "no_route", message: `no route for ${req.method} ${url.pathname}` }];
  }

  // ---- control listener ----
  async function controlHandle(req: IncomingMessage, _res: ServerResponse, url: URL, body: any): Promise<[number, unknown]> {
    if (req.headers.authorization !== `Bearer ${tokens.control}`) return [401, { error: "unauthorized", message: "missing or wrong control token" }];
    if (url.pathname === "/_fixture/runs" && req.method === "POST") {
      const run = { run_id: `run-${descriptor.bootId.slice(0, 8)}-${runs.length + 1}`, principal: body?.principal ?? "p-default", label: body?.label ?? null, created_at: now() };
      runs.push(run);
      ledgerAdd({ kind: "run-allocated", principal: run.principal, run: run.run_id, operation_tag: null, request: null, status: null, execution_id: null, objects: [], fault: null });
      return [201, run];
    }
    if (url.pathname === "/_fixture/faults" && req.method === "GET") return [200, { armed: armed.map((f) => f.point) }];
    if (url.pathname === "/_fixture/faults" && req.method === "POST") {
      if (body?.point !== "mcp/after-backend-reply/drop") return [400, { error: "bad_point", message: "only mcp/after-backend-reply/drop is built" }];
      const selector = (body.selector ?? {}) as Record<string, unknown>;
      // As the real controller (fixture-api/1): selectors are tool, run, operation, nth, count, once and hold_ms; no key.
      const unknown = Object.keys(selector).filter((k) => !["tool", "run", "operation", "nth", "count", "once", "hold_ms"].includes(k));
      if (unknown.length) return [400, { error: "bad_selector", message: `unknown selector member(s): ${unknown.join(", ")}` }];
      const f = { id: `F-${++armedSeq}`, point: body.point as string, selector, once: selector.once !== false };
      armed.push(f);
      descriptor.armedFaults = armed.map((x) => `${x.id} ${x.point} ${canonicalize(x.selector)}`);
      ledgerAdd({ kind: "fault-armed", principal: null, run: null, operation_tag: null, request: null, status: null, execution_id: null, objects: [], fault: { point: f.point, selector, fired_on_seq: null } });
      return [201, { armed: { point: f.point, selector } }];
    }
    const reset = /^\/_fixture\/runs\/([^/]+)\/reset$/.exec(url.pathname);
    if (reset && req.method === "POST") {
      const run = decodeURIComponent(reset[1]);
      let objects = 0;
      let dropped = 0;
      for (const [id, t] of tickets) if (t.run === run) { tickets.delete(id); objects++; }
      for (const [k, v] of keys) if (v.run === run) { keys.delete(k); dropped++; }
      ledgerAdd({ kind: "run-reset", principal: null, run, operation_tag: null, request: null, status: null, execution_id: null, objects: [], fault: null });
      return [200, { run, objects, keys: dropped }];
    }
    return [404, { error: "no_route", message: "no control route" }];
  }

  // ---- MCP endpoint: JSON-RPC over HTTP POST, answered as application/json ----
  const TOOLS = [
    { name: "create_ticket", inputSchema: { type: "object", properties: { title: { type: "string" }, description: { type: "string" }, priority: { type: "integer" }, project: { type: "string" }, idempotency_key: { type: "string" } }, required: ["title"] }, annotations: { readOnlyHint: false, idempotentHint: false } },
    { name: "list_tickets", inputSchema: { type: "object", properties: { title_prefix: { type: "string" } } }, annotations: { readOnlyHint: true } },
    { name: "get_operation", inputSchema: { type: "object", properties: { idempotency_key: { type: "string" } }, required: ["idempotency_key"] }, annotations: { readOnlyHint: true } },
    { name: "get_execution", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }, annotations: { readOnlyHint: true } },
  ].filter((t) => !without.has(t.name));

  const toolResult = (text: string, structured: Record<string, unknown>, isError = false) => ({
    content: [{ type: "text", text }], structuredContent: structured, isError, _meta: descriptor.meta(),
  });

  async function callTool(name: string, args: any, meta: any): Promise<{ result: unknown; drop?: boolean }> {
    if (!TOOLS.some((t) => t.name === name)) return { result: toolResult(`Unknown tool ${name}.`, { error: "unknown_tool" }, true) };
    const a: Attribution = { principal: "p-default", run: tag(meta?.[META_KEYS.run]), operation: tag(meta?.[META_KEYS.operation]) };
    if (name === "create_ticket") {
      const { idempotency_key, ...fields } = args ?? {};
      const reqBody = { ...fields, project: fields.project ?? "inbox" };
      if (d.ignoresArgs && typeof idempotency_key === "string" && mcpCache.has(idempotency_key)) return { result: mcpCache.get(idempotency_key) };
      const r = createTicket(a, d.keyDropped ? null : (idempotency_key ?? null), reqBody);
      const fault = armed.find((f) => (f.selector.tool === undefined || f.selector.tool === name)
        && (f.selector.operation === undefined || f.selector.operation === a.operation) && (f.selector.run === undefined || f.selector.run === a.run));
      let result: unknown;
      if (r.status === 422) result = toolResult("This idempotency_key was already used with different arguments; nothing was written.", { error: "idempotency_key_reused", mws: { outcome: "not_applied", code: "idempotency_key_reused" } }, true);
      else if (r.status >= 300) result = toolResult(`Not applied: ${r.body?.message}`, { error: r.body?.error, mws: { outcome: "not_applied", code: r.body?.error } }, true);
      else {
        const t = r.body.ticket;
        result = toolResult(r.replayed ? `Ticket ${t.id} was already created (replay).` : `Created ticket ${t.id}.`,
          { id: t.id, version: t.version, project: t.project, ...(r.replayed ? { replayed: true } : {}), mws: { outcome: "applied" } });
      }
      if (d.ignoresArgs && typeof idempotency_key === "string") mcpCache.set(idempotency_key, result);
      if (fault && r.status < 300) {
        if (fault.once) armed.splice(armed.indexOf(fault), 1);
        descriptor.armedFaults = armed.map((x) => `${x.id} ${x.point} ${canonicalize(x.selector)}`);
        ledgerAdd({ kind: "fault-fired", principal: a.principal, run: a.run, operation_tag: a.operation, request: null, status: null, execution_id: r.execution ?? null, objects: [], fault: { point: fault.point, selector: fault.selector, fired_on_seq: commitSeq } });
        return { result, drop: true };
      }
      return { result };
    }
    if (name === "list_tickets") {
      const prefix = args?.title_prefix;
      return { result: toolResult("tickets", { tickets: [...tickets.values()].filter((t) => !prefix || t.title.startsWith(prefix)).map(publicTicket) }) };
    }
    if (name === "get_operation") {
      const k = findKey("p-default", String(args?.idempotency_key ?? ""), a);
      if (!k) return { result: toolResult("No record of this key now. This does not mean nothing was written: a held request can still arrive.", { operation: null }) };
      const op = operationRecord(k);
      return { result: toolResult(`Key ${k.key}: ${op.state}, execution ${op.execution_id}.`, { operation: op }) };
    }
    if (name === "get_execution") {
      const rec = executions.find((e) => e.id === args?.id);
      if (!rec) return { result: toolResult("No execution record with this id.", { error: "not_found" }, true) };
      return { result: toolResult(`Execution ${rec.id}.`, { execution: executionView(rec) }) };
    }
    return { result: toolResult("unreachable", {}, true) };
  }

  async function mcpHandle(req: IncomingMessage, res: ServerResponse, body: any): Promise<void> {
    const reply = (obj: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (!body || typeof body !== "object") { res.writeHead(400).end(); return; }
    if (body.id === undefined) { res.writeHead(202).end(); return; }
    if (body.method === "initialize") {
      reply({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: body.params?.protocolVersion ?? "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "tiny-tracker", version: "0.2.0-fake" }, instructions: descriptor.instructions() } });
      return;
    }
    if (body.method === "tools/list") { reply({ jsonrpc: "2.0", id: body.id, result: { tools: TOOLS } }); return; }
    if (body.method === "tools/call") {
      const out = await callTool(body.params?.name, body.params?.arguments, body.params?._meta);
      if (out.drop) {
        // The lost response, server-side: the backend committed and answered; this server never answers. The
        // connection is held until the client gives up (capped).
        const timer = setTimeout(() => req.socket.destroy(), 15000);
        req.socket.on("close", () => clearTimeout(timer));
        return;
      }
      reply({ jsonrpc: "2.0", id: body.id, result: out.result });
      return;
    }
    reply({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "method not found" } });
  }

  async function readJson(req: IncomingMessage): Promise<any> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    if (chunks.length === 0) return undefined;
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return undefined; }
  }

  const listen = async (handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<[Server, string]> => {
    const server = createServer(handler);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return [server, `http://127.0.0.1:${(server.address() as AddressInfo).port}`];
  };
  const json = (res: ServerResponse, [status, body, headers]: [number, unknown, Record<string, string>?]) => {
    res.writeHead(status, { "content-type": "application/json", ...(headers ?? {}) });
    res.end(JSON.stringify(body));
  };

  const [backendServer, backendUrl] = await listen((req, res) => void (async () => {
    const url = new URL(req.url ?? "/", "http://fake.invalid");
    json(res, await backendHandle(req, res, url, await readJson(req)));
  })().catch(() => res.writeHead(500).end()));
  const [controlServer, controlUrl] = await listen((req, res) => void (async () => {
    const url = new URL(req.url ?? "/", "http://fake.invalid");
    json(res, await controlHandle(req, res, url, await readJson(req)));
  })().catch(() => res.writeHead(500).end()));
  const [mcpServer, mcpBase] = await listen((req, res) => void (async () => {
    if (req.method !== "POST" || !(req.url ?? "").startsWith("/mcp")) { res.writeHead(404).end(); return; }
    await mcpHandle(req, res, await readJson(req));
  })().catch(() => res.writeHead(500).end()));

  const close = (s: Server) => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); });
  return {
    mcp: `${mcpBase}/mcp`, backend: backendUrl, control: controlUrl, tokens, descriptor,
    stateLine: { backend: backendUrl, mcp: `${mcpBase}/mcp`, defects: mcpDefects, read_only: false, profile: "default", features: options.features ?? FEATURES_020,
      evidence: `${backendUrl}/build`, control: controlUrl, ...(backendDefects.length ? { backend_defects: backendDefects } : {}) },
    executions: () => executions.length,
    close: async () => { await close(mcpServer); await close(controlServer); await close(backendServer); },
  };
}
