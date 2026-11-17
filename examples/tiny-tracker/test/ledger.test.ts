// Stream B (0.2.0, fixture side): the execution ledger as an independent
// effect counter (R6), its read routes in the evidence namespace (G3, X2),
// fault arming and the mcp/after-backend-reply/drop fault (R7, B7, G9), the
// run-scoped reset over Store.dropRun, and the X5 caps.
//
// The ledger is an oracle and has no defects (owner decision 5). It is checked
// against /export by a recount written here a second time, independently of
// src/fixture/ledger.ts, and the recount is shown to catch a ledger that lies.
//
// Ports: in-process stacks use port 0; command-line runs use 4624-4631
// (stream B's slice; 4620-4623 are the surface test's).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startBackend, startServer, type RunningBackend } from "../src/start.js";
import { createFixtureLayer, type FixtureLayer } from "../src/fixture/index.js";
import { Ledger, MAX_LEDGER_ENTRIES } from "../src/fixture/ledger.js";
import { FAULT_ACTIONS, FAULT_CAPS, parseArming, FaultError } from "../src/fixture/faults.js";
import { CONTROL_MAX_CONNECTIONS, type AttachedBackend } from "../src/fixture/control.js";
import type { CommitSink, CommittedTransaction, ReplayedTransaction } from "../src/backend/commit.js";
import { BUILT_FAULT_POINTS } from "../src/fault-points.js";
import { FIXTURE_API_VERSION } from "../src/fixture/descriptor.js";
import { parsePrincipals, type Principal } from "../src/principals.js";
import type { EvidenceSource } from "../src/backend/seams.js";
import { checkCompat, type Combination } from "../src/compat.js";
import { featureInfo } from "../src/profile.js";
import { fingerprintHash } from "../src/digest.js";
import { META_KEYS } from "../src/fixture-properties.js";
import { RECORD_FIELDS, type ExecutionRecord, type LedgerEntry, type OperationRecord } from "../src/records.js";
import { wallClock } from "../src/clock.js";
import { connectClient, Rest, type Mcp } from "./support/stack.js";
import { runCli } from "./support/cli-run.js";

const BACKEND = "backend-token-ledger-test-0000000";
const EVIDENCE = "evidence-token-ledger-test-000000";
const CONTROL = "control-token-ledger-test-0000000";
const ALL = ["evidence", "strict-input", "ledger", "faults"];
const DROP = "mcp/after-backend-reply/drop";
const BOOT = "0123456789abcdef";

const CHECK = fileURLToPath(new URL("../../verify/python/check_schemas.py", import.meta.url));
const jsonschema = spawnSync("python3", ["-I", "-c", "import jsonschema, referencing"], { encoding: "utf8" }).status === 0;
const needJsonschema = jsonschema || process.env.TT_GATE === "1" ? false : "the Python jsonschema package is not installed";

async function call(method: string, url: string, token: string | undefined, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any;
  try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }
  return { status: res.status, text, body: parsed, headers: res.headers };
}

interface Stack {
  layer: FixtureLayer;
  backend: RunningBackend;
  control: string;
  mcp: Mcp;
  api: Rest;
  ledger(query?: string): Promise<LedgerEntry[]>;
  arm(point: string, selector?: Record<string, unknown>): Promise<{ status: number; body: any; text: string }>;
  close(): Promise<void>;
}

/** One `tiny-tracker all` stack in this process, wired as the command line wires it (stream B block in src/cli.ts). */
async function stack(options: { features?: string[]; records?: EvidenceSource; principals?: Principal[]; attach?: (b: RunningBackend) => AttachedBackend } = {}): Promise<Stack> {
  const features = options.features ?? ALL;
  const layer = createFixtureLayer({
    layout: "all", profile: "default", features, mcpDefects: [], backendDefects: [], variants: [], control: true,
    env: { TRACKER_EVIDENCE_TOKEN: EVIDENCE, TRACKER_CONTROL_TOKEN: CONTROL }, argv: [], backendToken: BACKEND, principals: options.principals,
  });
  // As src/cli.ts starts it: the descriptor's boot id, the run registry, the ledger sink and the backend fault hooks.
  const backend = await startBackend({ token: BACKEND, port: 0, features, extension: layer.backendExtension, principals: options.principals,
    bootId: layer.descriptor.bootId, runOwner: layer.runOwner, ...layer.backendOptions });
  layer.attachBackend(options.attach ? options.attach(backend) : { store: backend.store, dropRun: backend.dropRun, evidence: options.records });
  const server = await startServer({ env: { TRACKER_BACKEND_URL: backend.url, TRACKER_BACKEND_TOKEN: BACKEND }, port: 0, features, extras: layer.serverExtras });
  const control = await layer.startControl(0);
  const mcp = await connectClient(server.url, "2026-07-28");
  return {
    layer, backend, control: control.url, mcp, api: new Rest(backend.url, BACKEND),
    async ledger(query = "") {
      const r = await call("GET", `${backend.url}/ledger${query}`, EVIDENCE);
      assert.equal(r.status, 200, r.text);
      return r.body.entries;
    },
    arm: (point, selector) => call("POST", `${control.url}/_fixture/faults`, CONTROL, selector === undefined ? { point } : { point, selector }),
    async close() {
      layer.close();
      await mcp.close();
      await server.close();
      await control.close();
      await backend.close();
    },
  };
}

const tagged = (run: string, operation: string) => ({ [META_KEYS.run]: run, [META_KEYS.operation]: operation });

// ---- the independent recount (not src/fixture/ledger.ts) ----

/**
 * Recounts the ledger against the export: the problems found, empty when they agree. Written separately from the
 * ledger so that a ledger that lies is caught (the oracle is tested, T3 in small).
 */
function recount(entries: readonly LedgerEntry[], exported: { tickets: Array<{ id: string }> }): string[] {
  const problems: string[] = [];
  entries.forEach((e, i) => { if (e.seq !== i + 1) problems.push(`entry ${i} has seq ${e.seq}`); });
  if (entries[0]?.kind !== "start") problems.push("the first entry is not the start entry");
  const executions = entries.filter((e) => e.kind === "execution");
  executions.forEach((e, i) => { if (e.execution_id !== `X-${i + 1}`) problems.push(`execution ${i + 1} is ${e.execution_id}`); });
  const byId = new Map(executions.map((e) => [e.execution_id, e]));
  const created = new Map<string, number>();
  for (const e of executions) {
    if (e.request?.method === "POST" && e.request.path === "/tickets") {
      for (const o of e.objects) if (o.type === "ticket") created.set(o.id, (created.get(o.id) ?? 0) + 1);
    }
  }
  for (const t of exported.tickets) {
    const n = created.get(t.id) ?? 0;
    if (n !== 1) problems.push(`ticket ${t.id} was created by ${n} ledger executions`);
  }
  for (const id of created.keys()) if (!exported.tickets.some((t) => t.id === id)) problems.push(`the ledger created ${id}, the export has no such ticket`);
  const perKey = new Map<string, number>();
  for (const e of executions) if (e.request?.key) perKey.set(`${e.principal} ${e.request.key}`, (perKey.get(`${e.principal} ${e.request.key}`) ?? 0) + 1);
  for (const [k, n] of perKey) if (n > 1) problems.push(`key ${k} has ${n} executions`);
  for (const r of entries.filter((e) => e.kind === "replay")) {
    const original = byId.get(r.execution_id);
    if (!original) problems.push(`replay ${r.seq} names ${r.execution_id}, which is no execution`);
    else if (original.request?.key !== r.request?.key || original.principal !== r.principal || original.request?.fingerprint_hash !== r.request?.fingerprint_hash) {
      problems.push(`replay ${r.seq} does not match the request of ${r.execution_id}`);
    }
  }
  return problems;
}

/** A scenario of direct backend calls: keyed and unkeyed creates, an identical retry, a changed retry, a patch, a refusal. */
async function scenario(api: Rest) {
  const h = (key: string, run = "run-scn-1", op = "op-1") => ({ "idempotency-key": key, "tiny-tracker-run": run, "tiny-tracker-operation": op });
  const a = await api.send("POST", "/tickets", { project: "inbox", title: "a" }, h("scn-key-00000001"));
  await api.send("POST", "/tickets", { project: "inbox", title: "a" }, h("scn-key-00000001", "run-scn-1", "op-2"));
  await api.send("POST", "/tickets", { project: "inbox", title: "changed" }, h("scn-key-00000001", "run-scn-1", "op-3"));
  await api.send("POST", "/tickets", { project: "inbox", title: "b", labels: ["x"] });
  await api.send("POST", "/tickets", { project: "inbox", title: "c" }, h("scn-key-00000002", "run-scn-2", "op-4"));
  await api.send("PATCH", `/tickets/${a.body.ticket.id}`, { title: "a2" });
  await api.send("DELETE", "/tickets/T-404");
  return a.body.ticket.id as string;
}

describe("the execution ledger (R6): an effect counter below every MCP-layer defect", () => {
  it("records every commit, replay and refusal at step 4 of the commit path, with its own sequence linked by execution_id", async () => {
    const ledger = new Ledger(BOOT, wallClock);
    const backend = await startBackend({ token: BACKEND, port: 0, features: ["strict-input"], sinks: [ledger], bootId: BOOT });
    try {
      const api = new Rest(backend.url, BACKEND);
      const first = await scenario(api);
      const entries = ledger.list();
      assert.deepEqual(entries.map((e) => e.kind), ["start", "execution", "replay", "refusal", "execution", "execution", "execution", "refusal"]);
      assert.deepEqual(entries.map((e) => e.execution_id), [null, "X-1", "X-1", null, "X-2", "X-3", "X-4", null]);
      for (const e of entries) assert.deepEqual(Object.keys(e), [...RECORD_FIELDS["ledger-entry"]], "members in schema order");
      const [, exec, replay, refusal] = entries;
      assert.equal(exec.principal, "p-default");
      assert.equal(exec.run, "run-scn-1");
      assert.equal(exec.operation_tag, "op-1");
      assert.deepEqual(exec.objects, [{ type: "ticket", id: first }]);
      assert.equal(exec.status, 201);
      assert.equal(exec.boot_id, BOOT);
      assert.equal(exec.clock_offset_ms, 0);
      assert.equal(exec.request!.fingerprint_hash, fingerprintHash("p-default", "POST", "/tickets", { project: "inbox", title: "a" }),
        "fingerprint_hash is the frozen fingerprintHash over the request as sent");
      assert.equal(replay.operation_tag, "op-2", "a replay carries the retry's own tags");
      assert.deepEqual(replay.objects, exec.objects);
      assert.equal(refusal.status, 422);
      assert.notEqual(refusal.request!.fingerprint_hash, exec.request!.fingerprint_hash);
      assert.equal(entries[7].status, 404);
      assert.throws(() => { (entries[1] as any).status = 500; }, TypeError, "entries are frozen");
      assert.equal(ledger.list()[1].status, 201);
      assert.deepEqual(recount(entries, await api.export()), []);
    } finally {
      await backend.close();
    }
  });

  it("fingerprint_hash is TxRequest.fingerprintHash for every write, keyed or not; a journal failure is a journal-unavailable entry", async () => {
    const ledger = new Ledger(BOOT, wallClock);
    let failNext = false;
    const journal: CommitSink = { name: "journal", role: "journal", onCommit() { if (failNext) { failNext = false; throw new Error("disk full"); } } };
    const backend = await startBackend({ token: BACKEND, port: 0, features: ["strict-input"], sinks: [ledger, journal], bootId: BOOT });
    try {
      const api = new Rest(backend.url, BACKEND);
      const t = await api.createTicket({ project: "inbox", title: "a" });
      await api.send("PATCH", `/tickets/${t.id}`, { title: "b", priority: 2 });
      failNext = true;
      const failed = await api.send("POST", "/tickets", { project: "inbox", title: "c" }, { "idempotency-key": "jfail-key-0000001" });
      assert.equal(failed.status, 503);
      const entries = ledger.list();
      assert.equal(entries[2].request!.fingerprint_hash, fingerprintHash("p-default", "PATCH", `/tickets/${t.id}`, { title: "b", priority: 2 }));
      const j = entries[3];
      assert.deepEqual([j.kind, j.status, j.execution_id, j.request!.key], ["journal-unavailable", 503, null, "jfail-key-0000001"]);
      assert.equal(entries.filter((e) => e.kind === "execution").length, 2, "nothing applied, nothing counted");
    } finally {
      await backend.close();
    }
  });

  it("an event from another boot is refused (a ledger wired to the wrong backend stops it)", async () => {
    const ledger = new Ledger(BOOT, wallClock);
    const backend = await startBackend({ token: BACKEND, port: 0, sinks: [ledger] });
    try {
      const r = await new Rest(backend.url, BACKEND).send("POST", "/tickets", { project: "inbox", title: "a" });
      assert.equal(r.status, 503);
      assert.match(r.body.message, /reached the ledger of boot 0123456789abcdef/);
    } finally {
      await backend.close();
    }
  });

  it("the recount catches a ledger that lies: a missing, a doubled and a mislinked entry (T3, in small)", async () => {
    class Skips extends Ledger { override onCommit(tx: CommittedTransaction) { if (tx.seq !== 2) super.onCommit(tx); } }
    class Doubles extends Ledger { override onCommit(tx: CommittedTransaction) { super.onCommit(tx); if (tx.seq === 1) super.onCommit(tx); } }
    class Mislinks extends Ledger { override onReplay(tx: ReplayedTransaction) { super.onReplay({ ...tx, originalSeq: tx.originalSeq + 1 }); } }
    const caught: Record<string, string[]> = {};
    for (const [name, sabotaged] of [["skips", new Skips(BOOT, wallClock)], ["doubles", new Doubles(BOOT, wallClock)], ["mislinks", new Mislinks(BOOT, wallClock)]] as const) {
      const backend = await startBackend({ token: BACKEND, port: 0, features: ["strict-input"], sinks: [sabotaged], bootId: BOOT });
      try {
        const api = new Rest(backend.url, BACKEND);
        await scenario(api);
        caught[name] = recount(sabotaged.list(), await api.export());
      } finally {
        await backend.close();
      }
    }
    assert.ok(caught.skips.some((p) => /created by 0 ledger executions/.test(p)), caught.skips.join("; "));
    assert.ok(caught.doubles.some((p) => /has 2 executions|created by 2/.test(p)), caught.doubles.join("; "));
    assert.ok(caught.mislinks.some((p) => /does not match the request of X-2/.test(p)), caught.mislinks.join("; "));
  });

  it("fail-stop: a ledger that cannot append stops the store (X5 cap on entries)", async () => {
    assert.equal(MAX_LEDGER_ENTRIES, 100_000);
    const ledger = new Ledger(BOOT, wallClock, 3);
    const backend = await startBackend({ token: BACKEND, port: 0, features: ["strict-input"], sinks: [ledger], bootId: BOOT });
    try {
      const api = new Rest(backend.url, BACKEND);
      assert.equal((await api.send("POST", "/tickets", { project: "inbox", title: "a" })).status, 201);
      assert.equal((await api.send("POST", "/tickets", { project: "inbox", title: "b" })).status, 201);
      const full = await api.send("POST", "/tickets", { project: "inbox", title: "c" });
      assert.equal(full.status, 503);
      assert.match(full.body.message, /commit sink ledger failed: the ledger is full \(3 entries per process\)/);
      assert.equal((await api.send("GET", "/tickets")).status, 503, "nothing more is answered");
      assert.throws(() => ledger.runAllocated("p-default", "run-x"), /the ledger is full/);
      assert.equal(ledger.size, 3);
    } finally {
      await backend.close();
    }
  });

  it("every entry validates against ledger-entry-1 (python3 jsonschema)", { skip: needJsonschema }, async () => {
    assert.ok(jsonschema, "TT_GATE=1 needs python3 with jsonschema and referencing");
    const s = await stack();
    try {
      await scenario(s.api);
      await s.arm(DROP, { tool: "list_projects", hold_ms: 1 });
      await s.mcp.client.callTool({ name: "list_projects", arguments: {} });
      await call("POST", `${s.control}/_fixture/runs`, CONTROL, {});
      const entries = await s.ledger();
      assert.deepEqual(new Set(entries.map((e) => e.kind)), new Set(["start", "execution", "replay", "refusal", "fault-armed", "fault-fired", "run-allocated"]));
      for (const e of entries) {
        const check = spawnSync("python3", ["-I", CHECK, "--instance", "ledger-entry"], { input: JSON.stringify(e), encoding: "utf8" });
        assert.equal(check.status, 0, `${JSON.stringify(e)}: ${check.stdout}${check.stderr}`);
      }
    } finally {
      await s.close();
    }
  });
});

describe("the evidence routes (G3): /ledger, /export, /executions, /operations", () => {
  it("/ledger serves the evidence token only, filters and pages, and has a JSONL form; /export carries the ledger", async () => {
    const s = await stack();
    try {
      await scenario(s.api);
      const all = await s.ledger();
      assert.equal(all[0].kind, "start");
      assert.equal(all[0].boot_id, s.layer.descriptor.bootId);
      assert.deepEqual((await s.ledger("?key=scn-key-00000001")).map((e) => e.kind), ["execution", "replay", "refusal"]);
      assert.deepEqual((await s.ledger("?run=run-scn-2")).map((e) => e.request?.key), ["scn-key-00000002"]);
      assert.deepEqual((await s.ledger("?kind=refusal")).map((e) => e.status), [422, 404]);
      assert.deepEqual((await s.ledger("?principal=p-default&operation=op-2")).map((e) => e.kind), ["replay"]);
      const page = await call("GET", `${s.backend.url}/ledger?limit=3`, EVIDENCE);
      assert.deepEqual(page.body.entries.map((e: LedgerEntry) => e.seq), [1, 2, 3]);
      assert.equal(page.body.next_after, 3);
      const rest = await call("GET", `${s.backend.url}/ledger?after=3&limit=100`, EVIDENCE);
      assert.equal(rest.body.entries[0].seq, 4);
      assert.equal(rest.body.next_after, null);
      const jsonl = await call("GET", `${s.backend.url}/ledger?format=jsonl`, EVIDENCE);
      assert.equal(jsonl.headers.get("content-type"), "application/x-ndjson");
      assert.deepEqual(jsonl.text.trimEnd().split("\n").map((l) => JSON.parse(l)), all);
      for (const bad of ["?limit=0", "?limit=10001", "?after=-1", "?kind=nope", "?format=xml", "?session=s"]) {
        assert.equal((await call("GET", `${s.backend.url}/ledger${bad}`, EVIDENCE)).status, 400, bad);
      }
      assert.equal((await call("POST", `${s.backend.url}/ledger`, EVIDENCE, {})).status, 405, "read-only");
      assert.equal((await call("GET", `${s.backend.url}/ledger`, BACKEND)).status, 404, "the backend token does not open the ledger");
      assert.equal((await call("GET", `${s.backend.url}/ledger`, CONTROL)).status, 401, "nor does the control token");
      const exp = await call("GET", `${s.backend.url}/export`, EVIDENCE);
      assert.deepEqual(exp.body.ledger, all);
      assert.deepEqual(recount(exp.body.ledger, exp.body), [], "the export recounts on its own");
      assert.equal((await s.api.send("GET", "/export")).body.ledger, undefined, "GET /export with the backend token is the 0.1.0 export");
      for (const t of [BACKEND, EVIDENCE, CONTROL]) assert.ok(!exp.text.includes(t), "no token in the evidence");
      for (const path of ["/executions", "/executions/X-1", "/operations/scn-key-00000001"]) {
        const r = await call("GET", `${s.backend.url}${path}`, EVIDENCE);
        assert.equal(r.status, 501, path);
        assert.equal(r.body.error, "not_enabled");
        assert.equal(r.body.feature, path.startsWith("/operations") ? "lookup" : "execution-records");
      }
    } finally {
      await s.close();
    }
  });

  it("serves execution and operation records from the attached EvidenceSource, the operation in the principal's scope", async () => {
    const exec = { record: "execution-record/1", id: "X-1", principal: "p-default" } as unknown as ExecutionRecord;
    const op = { record: "operation-record/1", key: "rec-key-00000001", principal: "p-default" } as unknown as OperationRecord;
    const asked: string[] = [];
    const records: EvidenceSource = {
      execution: (id) => (id === "X-1" ? exec : undefined),
      operation: (scope, key) => { asked.push(`${scope.principal} ${key}`); return scope.principal === "p-default" && key === op.key ? op : undefined; },
      executions: () => [exec],
    };
    const s = await stack({ records });
    try {
      const get = (path: string) => call("GET", `${s.backend.url}${path}`, EVIDENCE);
      assert.deepEqual((await get("/executions")).body, { principal: "p-default", executions: [exec] });
      assert.deepEqual((await get("/executions/X-1")).body, exec);
      assert.equal((await get("/executions/X-9")).status, 404);
      assert.deepEqual((await get("/operations/rec-key-00000001")).body, op);
      const miss = await get("/operations/rec-key-00000002");
      assert.deepEqual([miss.status, miss.body.message, miss.body.principal], [404, "no record of this key now", "p-default"]);
      assert.equal((await get("/operations/rec-key-00000001?principal=p-bob")).body.error, "unknown_principal", "only configured principals");
      assert.equal((await get("/operations/rec-key-00000001?principal=Bob")).status, 400);
      assert.deepEqual(asked, ["p-default rec-key-00000001", "p-default rec-key-00000002"]);
      assert.deepEqual((await get("/export")).body.executions, [exec]);
    } finally {
      await s.close();
    }
  });

  it("without the ledger feature, /ledger answers 501 and names the feature", async () => {
    const s = await stack({ features: ["evidence", "strict-input"] });
    try {
      const r = await call("GET", `${s.backend.url}/ledger`, EVIDENCE);
      assert.equal(r.status, 501);
      assert.deepEqual([r.body.error, r.body.feature, r.body.available_from], ["not_enabled", "ledger", "0.2.0"]);
      assert.equal((await call("GET", `${s.backend.url}/export`, EVIDENCE)).body.ledger, undefined);
    } finally {
      await s.close();
    }
  });
});

describe("faults (R7, B7, G9): armed on the control listener, recorded in the ledger", () => {
  it("validates an arming: unknown, unplanned and not-yet-built points, unknown selector members", () => {
    const err = (body: unknown) => { try { parseArming(body); return "armed"; } catch (e) { return `${(e as FaultError).status} ${(e as FaultError).code}`; } };
    assert.equal(err({ point: "mcp/after-backend-reply/nope" }), "400 unknown_point");
    assert.equal(err({ point: "mcp/before-commit/error" }), "400 not_planned");
    assert.equal(err({ point: "backend/after-commit/crash" }), "501 not_built");
    assert.equal(err({ point: DROP, selector: { key: "k" } }), "400 bad_selector", "a key selector would depend on what the code under test sends");
    assert.equal(err({ point: DROP, selector: { hold_ms: FAULT_CAPS.maxHoldMs + 1 } }), "400 bad_selector");
    assert.equal(err({ point: DROP, selector: { count: 0 } }), "400 bad_selector");
    assert.equal(err({ point: DROP, selector: { once: true, count: 2 } }), "400 bad_selector");
    assert.equal(err({ point: DROP, selector: { run: "bad tag" } }), "400 bad_selector");
    assert.equal(err({ point: DROP, extra: 1 }), "400 bad_request");
    assert.deepEqual(parseArming({ point: DROP }), { point: DROP, selector: { nth: 1, count: 1, hold_ms: FAULT_CAPS.defaultHoldMs } });
    assert.deepEqual(parseArming({ point: DROP, selector: { tool: "create_ticket", run: "r-1", operation: "o-1", once: true, nth: 2, hold_ms: 5 } }).selector,
      { tool: "create_ticket", run: "r-1", operation: "o-1", nth: 2, count: 1, hold_ms: 5 });
  });

  it("the lost response, server-side: the write commits, the answer is held, the ledger links the firing to the execution; the retry replays", async () => {
    const s = await stack();
    try {
      const before = s.layer.descriptor.toJSON();
      const armed = await s.arm(DROP, { tool: "create_ticket", run: "run-drop-1", hold_ms: 5000 });
      assert.equal(armed.status, 201, armed.text);
      assert.equal(armed.body.fault.id, "F-1");
      const after = s.layer.descriptor.toJSON();
      assert.deepEqual(after.faults.armed, [`F-1 ${DROP} {"count":1,"hold_ms":5000,"nth":1,"run":"run-drop-1","tool":"create_ticket"}`]);
      assert.notEqual(after.descriptor_hash, before.descriptor_hash, "arming changes the descriptor");
      assert.equal(after.build_hash, before.build_hash, "but not the configuration");
      assert.equal((await call("GET", `${s.backend.url}/build`, EVIDENCE)).body.faults.armed.length, 1);

      const args = { project: "inbox", title: "lost answer", idempotency_key: "drop-key-00000001" };
      await assert.rejects(s.mcp.client.callTool({ name: "create_ticket", arguments: args, _meta: tagged("run-drop-1", "op-1") }, { timeout: 400 }), /timed out|timeout/i);
      const exp = await s.api.export();
      assert.equal(exp.tickets.length, 1, "the write was applied");

      const retry = await s.mcp.client.callTool({ name: "create_ticket", arguments: args, _meta: tagged("run-drop-1", "op-2") });
      assert.equal(retry.isError, undefined, JSON.stringify(retry));

      const entries = await s.ledger();
      const exec = entries.filter((e) => e.kind === "execution");
      assert.equal(exec.length, 1, "exactly one effect (LRT-A1)");
      const armedEntry = entries.find((e) => e.kind === "fault-armed")!;
      assert.equal(armedEntry.seq, armed.body.fault.ledger_seq);
      assert.deepEqual(armedEntry.fault, { point: DROP, selector: { count: 1, hold_ms: 5000, nth: 1, run: "run-drop-1", tool: "create_ticket" }, fired_on_seq: null });
      const fired = entries.find((e) => e.kind === "fault-fired")!;
      assert.equal(fired.fault!.fired_on_seq, exec[0].seq, "the firing names the execution it fired on");
      assert.equal(fired.execution_id, exec[0].execution_id);
      assert.deepEqual([fired.run, fired.operation_tag, fired.principal], ["run-drop-1", "op-1", "p-default"]);
      assert.ok(fired.seq > exec[0].seq);
      const replay = entries.find((e) => e.kind === "replay")!;
      assert.equal(replay.execution_id, exec[0].execution_id);
      assert.equal(replay.operation_tag, "op-2");
      assert.deepEqual(recount(entries, exp), []);

      const faults = (await call("GET", `${s.control}/_fixture/faults`, CONTROL)).body;
      assert.deepEqual(faults.armed, [], "once: spent after one firing");
      assert.deepEqual([faults.spent[0].id, faults.spent[0].fired, faults.spent[0].matched], ["F-1", 1, 1]);
      assert.equal(faults.held, 1, "the first answer is still held");
      assert.deepEqual(s.layer.descriptor.toJSON().faults.armed, []);
    } finally {
      await s.close();
    }
  });

  it("a hold ends with the true answer, late and unchanged; an untagged firing names no entry; nth skips the first calls", async () => {
    const s = await stack();
    try {
      const plain = await s.mcp.client.callTool({ name: "list_projects", arguments: {} });
      assert.equal((await s.arm(DROP, { tool: "list_projects", nth: 2, hold_ms: 250 })).status, 201);
      const t0 = Date.now();
      await s.mcp.client.callTool({ name: "list_projects", arguments: {} });
      assert.ok(Date.now() - t0 < 200, "the first matching call is not held (nth 2)");
      const t1 = Date.now();
      const late = await s.mcp.client.callTool({ name: "list_projects", arguments: {} });
      assert.ok(Date.now() - t1 >= 240, "held for hold_ms");
      assert.deepEqual(late.content, plain.content, "the true answer");
      const fired = (await s.ledger("?kind=fault-fired"))[0];
      assert.deepEqual([fired.fault!.fired_on_seq, fired.run, fired.execution_id, fired.request], [null, null, null, null]);
      const f = (await call("GET", `${s.control}/_fixture/faults`, CONTROL)).body.spent[0];
      assert.deepEqual([f.matched, f.fired, f.released], [2, 1, 1]);
    } finally {
      await s.close();
    }
  });

  it("X5: at most 16 answers held at once (a call past it is answered and counted), 32 armed faults; close sends every held answer", async () => {
    const s = await stack();
    try {
      assert.equal((await s.arm(DROP, { tool: "list_projects", count: 20, hold_ms: 60_000 })).status, 201);
      const calls = Array.from({ length: FAULT_CAPS.maxHeld + 1 }, () => s.mcp.client.callTool({ name: "list_projects", arguments: {} }));
      const first = await Promise.race(calls.map((p, i) => p.then(() => i)));
      assert.ok(first >= 0);
      let state = (await call("GET", `${s.control}/_fixture/faults`, CONTROL)).body;
      for (let i = 0; i < 50 && state.held < FAULT_CAPS.maxHeld; i++) {
        await new Promise((r) => setTimeout(r, 20));
        state = (await call("GET", `${s.control}/_fixture/faults`, CONTROL)).body;
      }
      assert.equal(state.held, FAULT_CAPS.maxHeld);
      assert.deepEqual([state.armed[0].fired, state.armed[0].skipped_at_cap], [FAULT_CAPS.maxHeld, 1]);
      assert.equal((await s.ledger("?kind=fault-fired")).length, FAULT_CAPS.maxHeld, "a skipped call is not a firing");
      for (let i = 1; i < FAULT_CAPS.maxArmed; i++) assert.equal((await s.arm(DROP, { tool: "get_ticket" })).status, 201);
      const over = await s.arm(DROP, { tool: "get_ticket" });
      assert.deepEqual([over.status, over.body.error], [429, "too_many_faults"]);
      s.layer.close();
      const results = await Promise.all(calls);
      assert.equal(results.length, FAULT_CAPS.maxHeld + 1, "every held answer was sent on close");
      assert.equal(CONTROL_MAX_CONNECTIONS, 32);
    } finally {
      await s.close();
    }
  });

  it("without the faults feature the control listener arms nothing (501, named feature)", async () => {
    const s = await stack({ features: ["evidence", "strict-input", "ledger"] });
    try {
      const r = await s.arm(DROP);
      assert.deepEqual([r.status, r.body.error, r.body.feature], [501, "not_enabled", "faults"]);
      assert.deepEqual((await call("GET", `${s.control}/_fixture/faults`, CONTROL)).body.armed, []);
      const bad = await s.arm("backend/after-commit/crash");
      assert.equal(bad.status, 501);
    } finally {
      await s.close();
    }
  });
});

describe("runs: allocation and run-scoped reset through the commit path (scoped per principal)", () => {
  const ALICE = "alice-token-ledger-test-000000";
  const BOB = "bob-token-ledger-test-00000000000";
  const principals = () => parsePrincipals(JSON.stringify({ principals: [{ id: "p-alice", token: ALICE }, { id: "p-bob", token: BOB }] }));

  it("allocation is a ledger entry; the reset is one commit, recorded from its event; only configured principals get runs", async () => {
    const s = await stack({ principals: principals() });
    try {
      assert.deepEqual((await call("POST", `${s.control}/_fixture/runs`, CONTROL, {})).body.error, "unknown_principal", "p-default is not configured here");
      const alice = (await call("POST", `${s.control}/_fixture/runs`, CONTROL, { principal: "p-alice", label: "a" })).body;
      const bob = (await call("POST", `${s.control}/_fixture/runs`, CONTROL, { principal: "p-bob" })).body;
      const a = new Rest(s.backend.url, ALICE);
      const b = new Rest(s.backend.url, BOB);
      const tag = (run: string, key?: string) => ({ "tiny-tracker-run": run, ...(key ? { "idempotency-key": key } : {}) });
      const t1 = (await a.send("POST", "/tickets", { project: "inbox", title: "alice 1" }, tag(alice.run_id, "reset-key-0000001"))).body.ticket;
      const t2 = (await b.send("POST", "/tickets", { project: "inbox", title: "bob 1" }, tag(bob.run_id))).body.ticket;
      assert.equal((await b.send("POST", "/tickets", { project: "inbox", title: "x" }, tag(alice.run_id))).status, 403, "another principal's run tag");
      const reset = await call("POST", `${s.control}/_fixture/runs/${alice.run_id}/reset`, CONTROL, {});
      assert.equal(reset.status, 200, reset.text);
      assert.deepEqual(reset.body.dropped, { objects: 1, keys: 1 });
      const exp = await call("GET", `${s.backend.url}/export?principal=p-alice`, EVIDENCE);
      assert.deepEqual(exp.body.tickets.map((t: any) => t.id), [t2.id], "alice's run is gone, bob's ticket stays");
      const again = await a.send("POST", "/tickets", { project: "inbox", title: "alice 1" }, tag(alice.run_id, "reset-key-0000001"));
      assert.equal(again.headers.get("idempotent-replayed"), null, "the key record went with the run");
      const ledgerA = await s.ledger("?principal=p-alice");
      const r = ledgerA.find((e) => e.kind === "run-reset")!;
      assert.deepEqual([r.principal, r.run, r.status, r.request, r.execution_id], ["p-alice", alice.run_id, 200, null, null]);
      assert.deepEqual(r.objects, [{ type: "ticket", id: t1.id }]);
      assert.equal(reset.body.ledger_seq, r.seq);
      assert.equal(ledgerA.filter((e) => e.kind === "run-reset").length, 1, "recorded once, from the commit event");
      assert.deepEqual(ledgerA.filter((e) => e.kind === "run-allocated").map((e) => e.run), [alice.run_id]);
      const refused = ledgerA.find((e) => e.kind === "refusal" && e.status === 403);
      assert.equal(refused, undefined, "bob's refused write is bob's");
      assert.ok((await s.ledger("?principal=p-bob")).some((e) => e.kind === "refusal" && e.status === 403 && e.run === alice.run_id));
      assert.equal((await call("POST", `${s.control}/_fixture/runs/run-nope-1/reset`, CONTROL, {})).status, 404);
    } finally {
      await s.close();
    }
  });

  it("evidence reads name the principal: required with two configured, the single one otherwise", async () => {
    const s = await stack({ principals: principals() });
    try {
      for (const path of ["/ledger", "/export"]) {
        const r = await call("GET", `${s.backend.url}${path}`, EVIDENCE);
        assert.deepEqual([r.status, r.body.error], [400, "principal_required"], path);
        assert.equal((await call("GET", `${s.backend.url}${path}?principal=p-carol`, EVIDENCE)).body.error, "unknown_principal");
        assert.equal((await call("GET", `${s.backend.url}${path}?principal=Carol`, EVIDENCE)).status, 400);
        assert.equal((await call("GET", `${s.backend.url}${path}?principal=p-bob`, EVIDENCE)).body.principal, "p-bob");
      }
      await new Rest(s.backend.url, ALICE).send("POST", "/tickets", { project: "inbox", title: "a" });
      const bob = await s.ledger("?principal=p-bob");
      assert.deepEqual(bob.map((e) => e.kind), ["start"], "bob sees the fixture's own entries, not alice's");
    } finally {
      await s.close();
    }
    const one = await stack();
    try {
      assert.equal((await call("GET", `${one.backend.url}/ledger`, EVIDENCE)).body.principal, "p-default");
    } finally {
      await one.close();
    }
  });

  it("a backend without dropRun answers 501, and a stopped store answers 503", async () => {
    const s = await stack({ attach: (b) => ({ store: b.store }) });
    try {
      const run = (await call("POST", `${s.control}/_fixture/runs`, CONTROL, {})).body;
      const r = await call("POST", `${s.control}/_fixture/runs/${run.run_id}/reset`, CONTROL, {});
      assert.deepEqual([r.status, r.body.error, r.body.available_from], [501, "not_built", "0.2.0"]);
    } finally {
      await s.close();
    }
    const t = await stack({ attach: (b) => ({ store: Object.assign(Object.create(b.store), { checkRunning() { throw new Error("the store has stopped"); } }), dropRun: b.dropRun }) });
    try {
      const run = (await call("POST", `${t.control}/_fixture/runs`, CONTROL, {})).body;
      const r = await call("POST", `${t.control}/_fixture/runs/${run.run_id}/reset`, CONTROL, {});
      assert.deepEqual([r.status, r.body.error], [503, "stopped"]);
    } finally {
      await t.close();
    }
  });
});

describe("backend fault hooks (BackendOptions.faults): the controller fires backend points through them", () => {
  it("an after-commit action fires after the ledger has the execution, and the firing names that execution exactly", async () => {
    const point = "backend/after-commit/error";
    (BUILT_FAULT_POINTS as string[]).push(point);
    FAULT_ACTIONS[point] = { position: "after-commit", fire: async () => ({ status: 500, body: { error: "injected" } }) };
    const s = await stack();
    try {
      assert.equal((await s.arm(point, { tool: "x" })).status, 400, "tool applies to mcp points only");
      assert.equal((await s.arm(point, { run: "run-be-1" })).status, 201);
      const untagged = await s.api.send("POST", "/tickets", { project: "inbox", title: "plain" });
      assert.equal(untagged.status, 201, "the selector picks the run");
      const r = await s.api.send("POST", "/tickets", { project: "inbox", title: "hit" }, { "tiny-tracker-run": "run-be-1" });
      assert.deepEqual([r.status, r.body], [500, { error: "injected" }]);
      assert.equal((await s.api.export()).tickets.length, 2, "the write was applied");
      const entries = await s.ledger();
      const exec = entries.filter((e) => e.kind === "execution");
      const fired = entries.find((e) => e.kind === "fault-fired")!;
      assert.equal(fired.fault!.fired_on_seq, exec[1].seq);
      assert.equal(fired.execution_id, "X-2");
    } finally {
      await s.close();
      (BUILT_FAULT_POINTS as string[]).pop();
      delete FAULT_ACTIONS[point];
    }
  });

  it("a before-commit action runs before anything is written; its firing names no entry", async () => {
    const point = "backend/before-commit/delay";
    (BUILT_FAULT_POINTS as string[]).push(point);
    FAULT_ACTIONS[point] = { position: "before-commit", fire: async (_ctx, _arm, kit) => { await kit.hold(undefined); } };
    const s = await stack();
    try {
      assert.equal((await s.arm(point, { hold_ms: 150 })).status, 201);
      const t0 = Date.now();
      assert.equal((await s.api.send("POST", "/tickets", { project: "inbox", title: "late" })).status, 201);
      assert.ok(Date.now() - t0 >= 140);
      const entries = await s.ledger();
      const fired = entries.findIndex((e) => e.kind === "fault-fired");
      const exec = entries.findIndex((e) => e.kind === "execution");
      assert.ok(fired < exec, "fired before the write was recorded");
      assert.equal(entries[fired].fault!.fired_on_seq, null);
    } finally {
      await s.close();
      (BUILT_FAULT_POINTS as string[]).pop();
      delete FAULT_ACTIONS[point];
    }
  });

  it("every built point has an action, and the descriptor names fixture-api/1", () => {
    for (const p of BUILT_FAULT_POINTS) assert.ok(FAULT_ACTIONS[p], p);
    assert.equal(FIXTURE_API_VERSION, "fixture-api/1");
  });
});

describe("the compatibility rules of stream B (CMP-30 to CMP-33) and the command line", () => {
  it("ledger needs evidence and strict-input; faults need the ledger and --fixture-control", () => {
    const base: Combination = { layout: "all", profile: "default", features: [], defects: [], backendDefects: [], variants: [], faults: [], fixtureControl: true };
    assert.ok(featureInfo("ledger")!.built && featureInfo("faults")!.built);
    assert.match(checkCompat({ ...base, features: ["ledger", "strict-input"] }).join(), /ledger feature needs the evidence feature/);
    assert.match(checkCompat({ ...base, features: ["ledger", "evidence"] }).join(), /ledger feature needs strict-input/);
    assert.match(checkCompat({ ...base, features: ["faults", "evidence", "strict-input"] }).join(), /faults feature needs the ledger feature/);
    assert.match(checkCompat({ ...base, features: ALL, fixtureControl: false }).join(), /faults feature needs --fixture-control/);
    assert.deepEqual(checkCompat({ ...base, features: ALL }), []);
    // CMP-7, narrowed: a fault armed at start (stream E's --fault) needs the faults feature and a built point.
    assert.deepEqual(checkCompat({ ...base, features: ALL, faults: [DROP] }), []);
    assert.match(checkCompat({ ...base, faults: [DROP] }).join(), /a fault armed at start needs the faults feature/);
    assert.match(checkCompat({ ...base, features: ALL, faults: ["backend/after-commit/crash"] }).join(), /arrives in 0\.3\.0; this build cannot arm it/);
    assert.match(checkCompat({ ...base, features: ALL, faults: ["mcp/before-commit/error"] }).join(), /not planned/);
    assert.match(checkCompat({ ...base, features: ALL, layout: "backend" }).join(), /--fixture-control runs with `tiny-tracker all` only/);
    assert.match(checkCompat({ ...base, profile: "0.1", features: ["ledger"] }).join(), /profile 0.1/);
  });

  it("starts with every stream B feature; the ledger starts with a start entry; a held answer does not hold up shutdown", { timeout: 60_000 }, async () => {
    const env = { TRACKER_BACKEND_TOKEN: BACKEND, TRACKER_EVIDENCE_TOKEN: EVIDENCE, TRACKER_CONTROL_TOKEN: CONTROL };
    const refused = await runCli(["all", "--features", "evidence,ledger"], env);
    assert.equal(refused.code, 2);
    assert.match(refused.stderr, /ledger feature needs strict-input/);
    let held: Promise<unknown> | undefined;
    let mcp: Mcp | undefined;
    const t0 = Date.now();
    const r = await runCli(["all", "--features", ALL.join(","), "--fixture-control", "--port", "4624", "--backend-port", "4625", "--control-port", "4626"], env, async (state) => {
      assert.deepEqual(state.features, ALL);
      const entries = (await call("GET", `${state.backend}/ledger`, EVIDENCE)).body.entries;
      const build = (await call("GET", `${state.backend}/build`, EVIDENCE)).body;
      assert.deepEqual([entries[0].seq, entries[0].kind, entries[0].boot_id], [1, "start", build.process.boot_id]);
      assert.deepEqual(build.features, [...ALL].sort());
      assert.equal((await call("POST", `${state.control}/_fixture/faults`, CONTROL, { point: DROP, selector: { tool: "create_ticket", hold_ms: 600_000 } })).status, 201);
      mcp = await connectClient(state.mcp, "2026-07-28");
      held = mcp.client.callTool({ name: "create_ticket", arguments: { title: "held", idempotency_key: "cli-key-00000001" }, _meta: tagged("run-cli-1", "op-1") }).catch((e) => e);
      for (let i = 0; i < 50; i++) {
        if ((await call("GET", `${state.control}/_fixture/faults`, CONTROL)).body.held === 1) break;
        await new Promise((res) => setTimeout(res, 20));
      }
      assert.equal((await call("GET", `${state.control}/_fixture/faults`, CONTROL)).body.held, 1);
    });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(Date.now() - t0 < 12_000, "shutdown did not wait for the hold");
    await held;
    await mcp?.close().catch(() => {});
    for (const t of [BACKEND, EVIDENCE, CONTROL]) assert.ok(!r.stdout.includes(t) && !r.stderr.includes(t), "no token printed");
  });
});
