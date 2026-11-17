// 0.3.0 (stream D) at the MCP layer: the keyed-state answers (rule 4, decision
// 0004), the stated retention (FX-KEY-2), the variants key-store-durable,
// settle-by-lookup (with the key fence, B9) and settle-by-client-reference (G6),
// the compatibility rules CMP-50 to CMP-54, the command line, and the self-test
// on the correct build with inflight and retention on.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { startBackend, startServer, type RunningBackend, type StartedServer } from "../src/start.js";
import { connectClient, Rest, type Mcp } from "./support/stack.js";
import { startGate, type Gate } from "./support/gate.js";
import { movableClock, tempDir } from "./support/durable.js";
import { runCli } from "./support/cli-run.js";
import { checkCompat, type Combination } from "../src/compat.js";
import { effectiveFeatures, featuresTurnedOff } from "../src/profile.js";
import { DAY_MS } from "../src/backend/expiry.js";
import { refLabel } from "../src/variants/settle-by-client-reference.js";
import { runChecks } from "./support/checks.js";
import { REQUIREMENT_IDS } from "../src/requirements.js";
import type { BackendFaultHooks } from "../src/backend/http.js";

const TOKEN = "backend-token-keyed-000000000000";

interface Rig { backend: RunningBackend; gate: Gate; server: StartedServer; mcp: Mcp; rest: Rest; env: Record<string, string>; features: string[]; restart(): Promise<void>; close(): Promise<void> }

async function rig(o: { features?: string[]; env?: Record<string, string>; defects?: string[]; faults?: BackendFaultHooks; clock?: ReturnType<typeof movableClock> } = {}): Promise<Rig> {
  const features = o.features ?? ["inflight", "retention"];
  const backend = await startBackend({ token: TOKEN, port: 0, features, clock: o.clock, faults: o.faults });
  const gate = await startGate(backend.url);
  const env = { TRACKER_BACKEND_URL: gate.url, TRACKER_BACKEND_TOKEN: TOKEN, ...o.env };
  const r: Rig = {
    backend, gate, env, features, rest: new Rest(backend.url, TOKEN),
    server: await startServer({ env, features, defects: o.defects, port: 0 }),
    mcp: undefined as unknown as Mcp,
    async restart() {
      await r.mcp.close();
      await r.server.close();
      r.server = await startServer({ env, features, defects: o.defects, port: 0 });
      r.mcp = await connectClient(r.server.url, "2026-07-28");
    },
    async close() {
      await r.mcp.close().catch(() => {});
      await r.server.close();
      await gate.close();
      await backend.close();
    },
  };
  r.mcp = await connectClient(r.server.url, "2026-07-28");
  return r;
}

describe("keyed-state answers at the MCP layer (decision 0004)", () => {
  it("in_progress: a same-key call while the first is pending is unknown, code in_progress, repeat same_key; one ticket", async () => {
    let release!: () => void;
    let reached!: () => void;
    const arrived = new Promise<void>((r) => { reached = r; });
    const gate = new Promise<void>((r) => { release = r; });
    let hold = true;
    const r = await rig({ faults: { beforeCommit: async ({ meta }) => { if (hold && meta.request.path === "/tickets") { hold = false; reached(); await gate; } } } });
    try {
      const args = { project: "inbox", title: "once", idempotency_key: "mcp-inflight-001" };
      const first = r.mcp.call("create_ticket", args);
      await arrived;
      const second = await r.mcp.call("create_ticket", args);
      release();
      assert.equal((await first).isError, false);
      assert.equal(second.isError, true);
      assert.deepEqual([second.structured.mws.outcome, second.structured.mws.code, second.structured.mws.repeat], ["unknown", "in_progress", "same_key"]);
      assert.match(second.text, /still being applied/);
      assert.equal((await r.rest.tickets({ project: "inbox" })).length, 1);
    } finally {
      await r.close();
    }
  });

  it("key_expired: an expired key with the same arguments is applied, replayed, read_first, with the execution id; key_fenced is not applied", async () => {
    const clock = movableClock();
    const r = await rig({ clock });
    try {
      const args = { project: "inbox", title: "old", idempotency_key: "mcp-expired-001" };
      const first = await r.mcp.call("create_ticket", args);
      clock.advance(7 * DAY_MS);
      const direct = await r.rest.send("POST", "/tickets", { project: "inbox", title: "old" }, { "idempotency-key": "mcp-expired-001" });
      assert.deepEqual([direct.status, direct.body.error, direct.headers.get("idempotent-replayed")], [410, "key_expired", "true"], "the backend answers 410");
      const late = await r.mcp.call("create_ticket", args);
      assert.equal(late.isError, false);
      const m = late.structured.mws;
      assert.deepEqual([m.outcome, m.replayed, m.repeat, m.code, m.object.id], ["applied", true, "read_first", "key_expired", first.structured.id]);
      assert.equal(late.structured.execution_id, "X-1");
      assert.deepEqual(m.read_with, { tool: "list_tickets", arguments: { project: "inbox" } });
      await r.rest.send("POST", "/operations/mcp-fenced-0001/fence", {});
      const fenced = await r.mcp.call("create_ticket", { project: "inbox", title: "f", idempotency_key: "mcp-fenced-0001" });
      assert.equal(fenced.isError, true);
      assert.deepEqual([fenced.structured.mws.outcome, fenced.structured.mws.code], ["not_applied", "key_fenced"]);
      const comment = await r.mcp.call("add_comment", { id: "T-1", body: "x", idempotency_key: "mcp-fenced-0001" });
      assert.equal(comment.structured.mws.code, "key_fenced", "every key-accepting tool reads the states");
    } finally {
      await r.close();
    }
  });

  it("the MCP mapping of the backend's 410 key_expired (seams v2.1, B10): applied, replayed: true, read_first, the tombstone's execution id", async () => {
    const { fromBackend } = await import("../src/mcp/results.js");
    const w = { operation: "create", type: "ticket", guard: "key" as const, read: { tool: "list_tickets", arguments: { project: "inbox" } } };
    const body = { error: "key_expired", message: "this key's write was applied; its stored answer has expired: read the object", execution_id: "X-7", result_digest: "ab".repeat(32), committed_at: "2030-01-01T00:00:00.000Z" };
    for (const b of [body, { ...body, objects: [{ type: "ticket", id: "T-3" }] }]) {
      const r = fromBackend({ status: 410, body: b } as any, "the ticket", w);
      const m = (r.structuredContent as any).mws;
      assert.notEqual(r.isError, true, "an applied write is not an error");
      assert.deepEqual([m.outcome, m.replayed, m.repeat, m.code], ["applied", true, "read_first", "key_expired"]);
      assert.equal((r.structuredContent as any).execution_id, "X-7");
      assert.deepEqual(m.read_with, w.read);
      assert.doesNotMatch((r.content[0] as any).text, /backend answered 410|not known/);
      if ("objects" in b) assert.equal(m.object.id, "T-3", "the tombstone's objects name the object to read");
    }
    // Any other 410 keeps the generic answer: unknown.
    const other = fromBackend({ status: 410, body: { error: "gone" } } as any, "the ticket", w);
    assert.equal((other.structuredContent as any).mws.outcome, "unknown");
  });

  it("create_project (409 branches on error === \"exists\" since 0.2.0): 410 key_expired is applied/replayed/read_first; in_progress is unknown/same_key; key_fenced is not_applied", async () => {
    const { createProject } = await import("../src/mcp/tools/projects.js");
    const call = async (status: number, body: Record<string, unknown>) => {
      const api = { request: async () => ({ status, ok: false, replayed: status === 410, body }) };
      return (await createProject.handler({ key: "dup", name: "Dup", idempotency_key: "proj-key-0001" } as any, { api } as any, {} as any)) as any;
    };
    const expired = await call(410, { error: "key_expired", message: "expired", execution_id: "X-4", result_digest: "ab".repeat(32), committed_at: "2030-01-01T00:00:00.000Z", objects: [{ type: "project", id: "dup" }] });
    const em = expired.structuredContent.mws;
    assert.deepEqual([em.outcome, em.replayed, em.repeat, em.code], ["applied", true, "read_first", "key_expired"]);
    assert.equal(expired.structuredContent.execution_id, "X-4");
    assert.doesNotMatch(expired.content[0].text, /already exists/);
    const pending = await call(409, { error: "in_progress", message: "still running", since: "2030-01-01T00:00:00.000Z" });
    assert.deepEqual([pending.structuredContent.mws.outcome, pending.structuredContent.mws.code, pending.structuredContent.mws.repeat], ["unknown", "in_progress", "same_key"]);
    const fenced = await call(409, { error: "key_fenced", message: "run run-x was reset" });
    assert.deepEqual([fenced.structuredContent.mws.outcome, fenced.structuredContent.mws.code], ["not_applied", "key_fenced"]);
  });

  it("with retention, every key-accepting tool states it; without, the descriptions are the 0.1 ones", async () => {
    const on = await rig();
    const off = await rig({ features: [] });
    try {
      const d = (tools: Array<{ name: string; description?: string }>, n: string) => tools.find((t) => t.name === n)!.description!;
      const a = await on.mcp.tools();
      const b = await off.mcp.tools();
      for (const n of ["create_ticket", "create_project", "add_comment"]) {
        assert.match(d(a, n), /A key is remembered for 7 days; repeat the same intended write with the same key\.$/);
        assert.doesNotMatch(d(b, n), /remembered/);
      }
      assert.equal(d(a, "update_ticket"), d(b, "update_ticket"));
    } finally {
      await on.close();
      await off.close();
    }
  });
});

describe("variants (G6, B9)", () => {
  it("key-store-durable: a repeat after a restart replays the stored result; a lost answer stays unknown across the restart", async () => {
    const t = tempDir("ksd");
    try {
      const r = await rig({ features: [], env: { TRACKER_VARIANTS: "key-store-durable", TRACKER_KEY_JOURNAL: join(t.dir, "keys.jsonl") } });
      try {
        const args = { project: "inbox", title: "kept", idempotency_key: "ksd-key-000001" };
        const first = await r.mcp.call("create_ticket", args);
        const cut = r.gate.cutNext((q) => q.method === "POST" && q.path === "/tickets");
        const lost = await r.mcp.call("create_ticket", { project: "inbox", title: "lost", idempotency_key: "ksd-key-000002" });
        await cut;
        assert.equal(lost.structured.mws.outcome, "unknown");
        await r.restart();
        const again = await r.mcp.call("create_ticket", args);
        assert.equal(again.isError, false);
        assert.equal(again.structured.mws.replayed, true);
        assert.equal(again.structured.id, first.structured.id);
        const lostAgain = await r.mcp.call("create_ticket", { project: "inbox", title: "lost", idempotency_key: "ksd-key-000002" });
        assert.equal(lostAgain.isError, true);
        assert.equal(lostAgain.structured.mws.outcome, "unknown");
        assert.equal((await r.mcp.call("create_ticket", { ...args, title: "other" })).structured.mws.code, "idempotency_key_reused");
        assert.equal((await r.rest.tickets({ project: "inbox" })).length, 2, "one per key, never a second");
      } finally {
        await r.close();
      }
    } finally {
      t.cleanup();
    }
  });

  it("settle-by-lookup: a lost answer whose request already landed is settled applied; one still on its way is fenced (not applied) and refused when it lands", async () => {
    const r = await rig({ env: { TRACKER_VARIANTS: "settle-by-lookup" } });
    try {
      const cut = r.gate.cutNext((q) => q.method === "POST" && q.path === "/tickets");
      const landed = await r.mcp.call("create_ticket", { project: "inbox", title: "landed", idempotency_key: "sbl-key-000001" });
      await cut;
      assert.equal(landed.isError, false);
      assert.deepEqual([landed.structured.mws.outcome, landed.structured.settled_by], ["applied", "lookup"]);
      const h = r.gate.dropAndHoldNext((q) => q.method === "POST" && q.path === "/tickets");
      const held = await r.mcp.call("create_ticket", { project: "inbox", title: "held", idempotency_key: "sbl-key-000002" });
      assert.deepEqual([held.structured.mws.outcome, held.structured.mws.code], ["not_applied", "key_fenced"]);
      h.release();
      assert.equal(await h.landed, 409, "the late original meets the fence");
      assert.deepEqual((await r.rest.tickets({ project: "inbox" })).map((x) => x.title), ["landed"]);
    } finally {
      await r.close();
    }
  });

  it("settle-by-lookup compares the record's fingerprint_hash (G2 fold-in 1): another request's write under the key is not_applied, idempotency_key_reused, live and as a tombstone", async () => {
    const clock = movableClock();
    const r = await rig({ env: { TRACKER_VARIANTS: "settle-by-lookup" }, clock });
    try {
      const a = await r.mcp.call("create_ticket", { project: "inbox", title: "A", idempotency_key: "sbl-fp-key-0001" });
      assert.equal(a.isError, false);
      // The same key with title B: the backend answers 422, and the answer is lost on the way back.
      const cut = r.gate.cutNext((q) => q.method === "POST" && q.path === "/tickets");
      const b = await r.mcp.call("create_ticket", { project: "inbox", title: "B", idempotency_key: "sbl-fp-key-0001" });
      await cut;
      assert.equal(b.isError, true, "B was never applied: a lookup must not report A's write as B's");
      assert.deepEqual([b.structured.mws.outcome, b.structured.mws.code, b.structured.settled_by], ["not_applied", "idempotency_key_reused", "lookup"]);
      assert.doesNotMatch(b.text, /^Created/);
      // The same arguments as A: settled applied, as before.
      const cutA = r.gate.cutNext((q) => q.method === "POST" && q.path === "/tickets");
      const again = await r.mcp.call("create_ticket", { project: "inbox", title: "A", idempotency_key: "sbl-fp-key-0001" });
      await cutA;
      assert.deepEqual([again.structured.mws.outcome, again.structured.settled_by], ["applied", "lookup"]);
      // After the retention the record is a tombstone: it keeps the fingerprint_hash, and the same check applies.
      clock.advance(8 * DAY_MS);
      const cutB = r.gate.cutNext((q) => q.method === "POST" && q.path === "/tickets");
      const late = await r.mcp.call("create_ticket", { project: "inbox", title: "B", idempotency_key: "sbl-fp-key-0001" });
      await cutB;
      assert.deepEqual([late.structured.mws.outcome, late.structured.mws.code], ["not_applied", "idempotency_key_reused"]);
      const cutA2 = r.gate.cutNext((q) => q.method === "POST" && q.path === "/tickets");
      const lateA = await r.mcp.call("create_ticket", { project: "inbox", title: "A", idempotency_key: "sbl-fp-key-0001" });
      await cutA2;
      assert.deepEqual([lateA.structured.mws.outcome, lateA.structured.mws.repeat], ["applied", "read_first"]);
      assert.deepEqual((await r.rest.tickets({ project: "inbox" })).map((x) => x.title), ["A"]);
      // The fence answer names the principal and the fingerprint_hash.
      const fence = await r.rest.send("POST", "/operations/sbl-fp-key-0001/fence", { fence: false });
      assert.equal(typeof fence.body.fingerprint_hash, "string");
      assert.equal(fence.body.principal, "p-default");
    } finally {
      await r.close();
    }
  });

  it("settle-by-lookup's defect (settle-miss-reported-not-applied): the same miss with no fence says not applied, and the ticket appears", async () => {
    const r = await rig({ defects: ["settle-miss-reported-not-applied"] });
    try {
      const h = r.gate.dropAndHoldNext((q) => q.method === "POST" && q.path === "/tickets");
      const res = await r.mcp.call("create_ticket", { project: "inbox", title: "held", idempotency_key: "smr-key-000001" });
      assert.equal(res.structured.mws.outcome, "not_applied");
      h.release();
      assert.equal(await h.landed, 201);
      assert.equal((await r.rest.tickets({ project: "inbox" })).length, 1, "the write the server called not applied exists");
    } finally {
      await r.close();
    }
  });

  it("settle-by-client-reference: a lost answer is settled by the reference; a repeat after a restart replays; a miss stays unknown", async () => {
    const r = await rig({ features: [], env: { TRACKER_VARIANTS: "settle-by-client-reference" } });
    try {
      const cut = r.gate.cutNext((q) => q.method === "POST" && q.path === "/tickets");
      const args = { project: "inbox", title: "ref", idempotency_key: "sbc-key-000001" };
      const settled = await r.mcp.call("create_ticket", args);
      await cut;
      assert.deepEqual([settled.structured.mws.outcome, settled.structured.settled_by], ["applied", "reference"]);
      const t = (await r.rest.tickets({ project: "inbox" }))[0];
      assert.equal((await r.rest.ticket(t.id)).labels[0].name, refLabel("sbc-key-000001"));
      await r.restart();
      const again = await r.mcp.call("create_ticket", args);
      assert.deepEqual([again.structured.mws.replayed, again.structured.id], [true, t.id]);
      const h = r.gate.dropAndHoldNext((q) => q.method === "POST" && q.path === "/tickets");
      const miss = await r.mcp.call("create_ticket", { project: "inbox", title: "miss", idempotency_key: "sbc-key-000002" });
      assert.deepEqual([miss.structured.mws.outcome, miss.structured.mws.repeat], ["unknown", "read_first"]);
      h.release();
      await h.landed;
    } finally {
      await r.close();
    }
  });

  it("in-progress-reported-not-applied: the pending same-key call is reported as nothing applied", async () => {
    let release!: () => void;
    let reached!: () => void;
    const arrived = new Promise<void>((r) => { reached = r; });
    const gate = new Promise<void>((r) => { release = r; });
    let hold = true;
    const r = await rig({ defects: ["in-progress-reported-not-applied"], faults: { beforeCommit: async ({ meta }) => { if (hold && meta.request.path === "/tickets") { hold = false; reached(); await gate; } } } });
    try {
      const args = { project: "inbox", title: "once", idempotency_key: "ipr-key-000001" };
      const first = r.mcp.call("create_ticket", args);
      await arrived;
      const second = await r.mcp.call("create_ticket", args);
      release();
      await first;
      assert.deepEqual([second.structured.mws.outcome, second.structured.mws.repeat], ["not_applied", "no"]);
      assert.equal((await r.rest.tickets({ project: "inbox" })).length, 1);
    } finally {
      await r.close();
    }
  });
});

describe("compatibility rules CMP-50 to CMP-54 and the command line", () => {
  const base: Combination = { layout: "all", profile: "default", features: [], defects: [], backendDefects: [], variants: [], faults: [], fixtureControl: false };
  it("refuses what cannot work", () => {
    assert.match(checkCompat({ ...base, layout: "server", features: ["inflight"] }).join(), /backend features/);
    // 0.3.0 default flip: inflight and retention from the profile do not refuse `server` (CMP-54 reads the named set).
    assert.deepEqual(checkCompat({ ...base, layout: "server" }), []);
    assert.match(checkCompat({ ...base, profile: "0.1", variants: ["settle-by-lookup"] }).join(), /needs the inflight feature/);
    assert.deepEqual(checkCompat({ ...base, variants: ["settle-by-lookup"] }), [], "the default profile's inflight is enough");
    assert.deepEqual(checkCompat({ ...base, variants: ["settle-by-lookup"], features: ["inflight"] }), []);
    assert.match(checkCompat({ ...base, variants: ["key-store-durable", "key-store-honest"] }).join(), /name one/);
    assert.match(checkCompat({ ...base, variants: ["settle-by-client-reference"], features: ["inflight"] }).join(), /no idempotency key/);
    // The default profile's lookup and (0.3.0) inflight are turned off by these variants (as with key-store-honest), not
    // refused; a named one is refused.
    for (const v of ["key-store-durable", "settle-by-client-reference"]) {
      assert.deepEqual(checkCompat({ ...base, variants: [v] }), [], v);
      assert.deepEqual(featuresTurnedOff("default", [], [v]).map((o) => o.feature).sort(), ["inflight", "lookup"], v);
      assert.ok(effectiveFeatures("default", [], [v]).features.includes("retention"), `${v}: retention stays on`);
      assert.match(checkCompat({ ...base, variants: [v], features: ["lookup"] }).join(), /no idempotency key/, `${v} with a named lookup`);
      assert.match(checkCompat({ ...base, variants: [v], features: ["inflight"] }).join(), /no idempotency key/, `${v} with a named inflight`);
    }
  });

  it("CMP-55 (G2 fold-in 2): settle-by-lookup is refused with --key-expiry forget and with key-expires-early; a forget backend never fences a miss", async () => {
    const sbl = { ...base, variants: ["settle-by-lookup"], features: ["inflight", "retention"] };
    assert.deepEqual(checkCompat(sbl), []);
    assert.deepEqual(checkCompat({ ...sbl, keyExpiry: "refuse" }), []);
    assert.match(checkCompat({ ...sbl, keyExpiry: "forget" }).join(), /settle-by-lookup variant needs the refuse key-expiry policy/);
    // G2 round 2, item 4: the parser trims the value, so the rule does too.
    for (const v of [" forget", "forget ", "\tforget\n"]) assert.match(checkCompat({ ...sbl, keyExpiry: v }).join(), /needs the refuse key-expiry policy/, JSON.stringify(v));
    assert.match(checkCompat({ ...sbl, backendDefects: ["key-expires-early"] }).join(), /does not run with the key-expires-early backend defect/);
    assert.deepEqual(checkCompat({ ...base, features: ["inflight", "retention"], keyExpiry: "forget" }), [], "forget alone is fine");
    const r = await runCli(["all", "--features", "inflight,retention", "--key-expiry", "forget", "--port", "0", "--backend-port", "0"],
      { TRACKER_BACKEND_TOKEN: "cli-backend-token-0000000000", TRACKER_VARIANTS: "settle-by-lookup" });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /needs the refuse key-expiry policy/);
    assert.equal(r.stdout, "", "nothing started");
    // The backend side: under forget, an applied write whose record was forgotten is not fenced, and the answer says the
    // outcome is open (before the fix the fence answered "fenced" while GET /tickets/T-1 answered 200).
    const clock = movableClock();
    const backend = await startBackend({ token: TOKEN, port: 0, clock, features: ["inflight", "retention"], durability: { features: ["inflight", "retention"], policy: "forget" } });
    try {
      const rest = new Rest(backend.url, TOKEN);
      assert.equal((await rest.send("POST", "/tickets", { project: "inbox", title: "a" }, { "idempotency-key": "forget-fence-0001" })).status, 201);
      clock.advance(8 * DAY_MS);
      const f = await rest.send("POST", "/operations/forget-fence-0001/fence", {});
      assert.equal(f.status, 404);
      assert.deepEqual([f.body.state, f.body.fenced], ["unknown", false]);
      assert.equal((await rest.send("GET", "/tickets/T-1")).status, 200, "the write exists");
      const again = await rest.send("POST", "/operations/forget-fence-0001/fence", {});
      assert.equal(again.body.state, "unknown", "still not fenced");
      assert.equal(backend.durability!.keys.counts().fenced, 0);
    } finally {
      await backend.close();
    }
  });

  it("CMP-66 (G2 fold-in 11): the after-effect crash point needs durable; with it (and --supervise) it may be armed at start", () => {
    const f = { ...base, faults: ["backend/after-effect-before-key/crash"], fixtureControl: true, supervise: true };
    assert.match(checkCompat({ ...f, features: ["evidence", "strict-input", "ledger", "faults"] }).join(), /needs the durable feature/);
    assert.deepEqual(checkCompat({ ...f, features: ["evidence", "strict-input", "ledger", "faults", "durable"], dataDir: "/x" }), []);
    assert.match(checkCompat({ ...f, supervise: false, features: ["evidence", "strict-input", "ledger", "faults", "durable"], dataDir: "/x" }).join(), /need tiny-tracker all --supervise/);
  });

  it("CMP-65 (G2 fold-in 9): durable with the fixture clock is refused at start, supervised or not; each alone starts", async () => {
    const d = { ...base, features: ["durable", "strict-input"], dataDir: "/x", fixtureControl: true };
    assert.deepEqual(checkCompat(d), []);
    assert.deepEqual(checkCompat({ ...base, features: ["clock"], fixtureControl: true }), []);
    assert.match(checkCompat({ ...d, features: ["durable", "strict-input", "clock"] }).join(), /durable feature does not run with the fixture clock/);
    assert.match(checkCompat({ ...d, features: ["durable", "strict-input", "clock"], supervise: true }).join(), /does not run with the fixture clock/);
    const t = tempDir("cmp65");
    try {
      const r = await runCli(["all", "--features", "durable,strict-input,clock", "--fixture-control", "--data-dir", t.dataDir, "--port", "0", "--backend-port", "0", "--control-port", "0"],
        { TRACKER_BACKEND_TOKEN: "cli-backend-token-0000000000" });
      assert.equal(r.code, 2);
      assert.match(r.stderr, /journal does not keep the clock offset/);
      assert.equal(r.stdout, "", "nothing started");
    } finally {
      t.cleanup();
    }
  });

  it("CMP-50: durable needs strict-input, refused at start with a clear message (seams v2.1)", async () => {
    assert.match(checkCompat({ ...base, features: ["durable"], dataDir: "/x" }).join(), /durable feature needs strict-input/);
    assert.deepEqual(checkCompat({ ...base, features: ["durable", "strict-input"], dataDir: "/x" }), []);
    assert.deepEqual(checkCompat({ ...base, profile: "0.1", features: [] }), []);
    const t = tempDir("cmp50");
    try {
      const r = await runCli(["backend", "--features", "durable", "--data-dir", t.dataDir, "--port", "0"], { TRACKER_BACKEND_TOKEN: "cli-backend-token-0000000000" });
      assert.equal(r.code, 2);
      assert.match(r.stderr, /the durable feature needs strict-input/);
      assert.equal(r.stdout, "", "nothing started");
    } finally {
      t.cleanup();
    }
  });

  it("G2 fold-in 4: the tools state the configured retention (--key-retention 1h), and 7 days by default", async () => {
    const statement = async (args: string[]) => {
      let text = "";
      const r = await runCli(["all", "--features", "inflight,retention", ...args, "--port", "0", "--backend-port", "0"], { TRACKER_BACKEND_TOKEN: "cli-backend-token-0000000000" }, async (state) => {
        const mcp = await connectClient(state.mcp, "2026-07-28");
        try {
          const tools: any[] = await mcp.tools();
          text = tools.find((t) => t.name === "create_ticket")!.description;
          for (const t of tools) if ("idempotency_key" in (t.inputSchema?.properties ?? {})) assert.match(t.description, args.length ? /remembered for 1 hour;/ : /remembered for 7 days;/, t.name);
        } finally {
          await mcp.close();
        }
      });
      assert.equal(r.code, 0, r.stderr);
      return text;
    };
    assert.match(await statement(["--key-retention", "1h"]), /A key is remembered for 1 hour;/);
    assert.match(await statement([]), /A key is remembered for 7 days;/);
    // The same through startServer (the code path the CLI uses).
    const backend = await startBackend({ token: TOKEN, port: 0, features: ["inflight", "retention"] });
    const server = await startServer({ env: { TRACKER_BACKEND_URL: backend.url, TRACKER_BACKEND_TOKEN: TOKEN }, features: ["inflight", "retention"], retentionMs: 3_600_000, port: 0 });
    try {
      assert.match(server.build.tools.get("create_ticket")!.description, /remembered for 1 hour;/);
    } finally {
      await server.close();
      await backend.close();
    }
  });

  it("0.3.0 default flip: inflight and retention run with no feature named; `server` states the retention it is given or \"not known\"", async () => {
    const env: Record<string, string> = { TRACKER_BACKEND_TOKEN: "cli-backend-token-0000000000" };
    const statement = async (mode: "all" | "server", args: string[]) => {
      let text = "";
      const extra = mode === "all" ? ["--backend-port", "0"] : [];
      // Nothing listens on port 9 (discard): the backend states no retention (follow-up F2), and `server` lists its tools
      // without calling its backend.
      const r = await runCli([mode, ...args, "--port", "0", ...extra], mode === "server" ? { ...env, TRACKER_BACKEND_URL: "http://127.0.0.1:9" } : env, async (state) => {
        const mcp = await connectClient(state.mcp, "2026-07-28");
        try {
          text = (await mcp.tools()).find((t: any) => t.name === "create_ticket")!.description ?? "";
        } finally {
          await mcp.close();
        }
      });
      assert.equal(r.code, 0, r.stderr);
      return text;
    };
    assert.match(await statement("all", []), /A key is remembered for 7 days;/);
    // Follow-up F2: with no backend to read and no --key-retention, the tools say the retention is not known, not 7 days.
    const unknown = await statement("server", []);
    assert.match(unknown, /does not know how long its backend remembers a key/);
    assert.doesNotMatch(unknown, /remembered for \d/);
    assert.match(await statement("server", ["--key-retention", "1h"]), /A key is remembered for 1 hour;/);
    const bad = await runCli(["server", "--key-retention", "soon", "--port", "0"], { ...env, TRACKER_BACKEND_URL: "http://127.0.0.1:9" });
    assert.equal(bad.code, 2);
    const named = await runCli(["server", "--features", "retention", "--port", "0"], { ...env, TRACKER_BACKEND_URL: "http://127.0.0.1:9" });
    assert.equal(named.code, 2, "a named backend feature in `server` is still refused (CMP-54)");
    assert.match(named.stderr, /backend features/);
  });

  it("follow-up F2: `server` states the retention its backend states; a --key-retention that differs is refused", async () => {
    const env: Record<string, string> = { TRACKER_BACKEND_TOKEN: TOKEN };
    /** Starts `tiny-tracker server` against `url` and reads create_ticket's description (undefined when it exits). */
    const serverOn = async (url: string, args: string[] = [], extra: Record<string, string> = {}) => {
      let text: string | undefined;
      const r = await runCli(["server", ...args, "--port", "0"], { ...env, TRACKER_BACKEND_URL: url, ...extra }, async (state) => {
        const mcp = await connectClient(state.mcp, "2026-07-28");
        try {
          const tools: any[] = await mcp.tools();
          text = tools.find((t) => t.name === "create_ticket")!.description;
          const keyed = tools.filter((t) => "idempotency_key" in (t.inputSchema?.properties ?? {}));
          assert.ok(keyed.length > 0);
          for (const t of keyed) assert.ok(t.description.endsWith(text!.slice(text!.lastIndexOf(". ") + 2)), `${t.name} states the same`);
        } finally {
          await mcp.close();
        }
      });
      return { ...r, text };
    };

    // The coordinator's case: a backend started with --key-retention 1d, and a `server` given no flag.
    const cliBackend = await runCli(["backend", "--key-retention", "1d", "--port", "0"], env, async (state) => {
      const r = await serverOn(state.backend);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.text!, /A key is remembered for 1 day;/);
      assert.doesNotMatch(r.text!, /7 days/);
    });
    assert.equal(cliBackend.code, 0, cliBackend.stderr);

    const retention = ["inflight", "retention"];
    const at = async (o: { retentionMs?: number; features?: string[]; defects?: string[] }, check: (url: string) => Promise<void>) => {
      const features = o.features ?? retention;
      const b = await startBackend({ token: TOKEN, port: 0, features, defects: o.defects, durability: { features, ...(o.retentionMs ? { retentionMs: o.retentionMs } : {}) } });
      try {
        await check(b.url);
      } finally {
        await b.close();
      }
    };
    await at({ retentionMs: DAY_MS }, async (url) => {
      // The fence route states it on every answer; a peek writes nothing.
      const rest = new Rest(url, TOKEN);
      const peek = await rest.send("POST", "/operations/any-key-0001/fence", { fence: false });
      assert.deepEqual([peek.status, peek.body.retention_ms], [404, DAY_MS]);
      assert.equal((await rest.send("POST", "/operations/bad/fence", {})).body.retention_ms, DAY_MS);
      const same = await serverOn(url, ["--key-retention", "24h"]);
      assert.equal(same.code, 0, same.stderr);
      assert.match(same.text!, /remembered for 1 day;/, "the same retention given in other units is not a mismatch");
      for (const [args, extra] of [[["--key-retention", "7d"], {}], [[], { TRACKER_KEY_RETENTION: "2h" }]] as Array<[string[], Record<string, string>]>) {
        const r = await serverOn(url, args, extra);
        assert.equal(r.code, 2, JSON.stringify(args));
        assert.match(r.stderr, /gives (7 days|2 hours), but the backend states 1 day; drop it/);
        assert.equal(r.stdout, "", "nothing started");
      }
    });
    // A backend's default retention is stated too: the server's 7 days is then the backend's.
    await at({}, async (url) => assert.match((await serverOn(url)).text!, /remembered for 7 days;/));
    // key-expires-early keeps keys a thousandth of the retention; the stated retention stays the configured one.
    await at({ retentionMs: DAY_MS, defects: ["key-expires-early"] }, async (url) => assert.match((await serverOn(url)).text!, /remembered for 1 day;/));
    // A backend that states none (retention off, so no retention_ms; or no fence route): the given value, else "not known".
    await at({ features: ["inflight"] }, async (url) => {
      assert.equal((await new Rest(url, TOKEN).send("POST", "/operations/any-key-0001/fence", { fence: false })).body.retention_ms, undefined);
      const r = await serverOn(url);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.text!, /does not know how long its backend remembers a key/);
      assert.match((await serverOn(url, ["--key-retention", "3h"])).text!, /remembered for 3 hours;/);
    });
    await at({ features: [] }, async (url) => assert.match((await serverOn(url)).text!, /does not know how long/));
  });

  it("starts durable with --data-dir and names the journal; a second start on the same dir is refused; retention flags need retention", async () => {
    const t = tempDir("cli");
    try {
      const env = { TRACKER_BACKEND_TOKEN: "cli-backend-token-0000000000" };
      let second: Awaited<ReturnType<typeof runCli>> | undefined;
      const first = await runCli(["backend", "--features", "durable,strict-input,inflight,retention", "--data-dir", t.dataDir, "--key-retention", "2d", "--port", "0"], env, async (state) => {
        assert.equal(state.journal.data_dir, t.dataDir);
        assert.match(state.journal.head, /^0:[0-9a-f]{16}$/);
        const rest = new Rest(state.backend, env.TRACKER_BACKEND_TOKEN);
        assert.equal((await rest.send("POST", "/tickets", { project: "inbox", title: "a" }, { "idempotency-key": "cli-key-000001" })).status, 201);
        second = await runCli(["backend", "--features", "durable,strict-input", "--data-dir", t.dataDir, "--port", "0"], env);
      });
      assert.equal(first.code, 0, first.stderr);
      assert.equal(second!.code, 2);
      assert.match(second!.stderr, /locked by process/);
      const again = await runCli(["backend", "--features", "durable,strict-input,inflight,retention", "--data-dir", t.dataDir, "--port", "0"], env, async (state) => {
        assert.match(state.journal.head, /^2:/, "header, pending, commit");
      });
      assert.equal(again.code, 0, again.stderr);
      const flag = await runCli(["backend", "--profile", "0.1", "--key-expiry", "forget", "--port", "0"], env);
      assert.equal(flag.code, 2);
      assert.match(flag.stderr, /need the retention feature/);
      const bad = await runCli(["backend", "--features", "retention", "--key-retention", "soon", "--port", "0"], env);
      assert.equal(bad.code, 2);
    } finally {
      t.cleanup();
    }
  });
});

describe("the self-test on the correct build with inflight and retention", () => {
  it("every requirement held, with and without the settle-by-lookup variant", async () => {
    for (const env of [{}, { TRACKER_VARIANTS: "settle-by-lookup" }] as Array<Record<string, string>>) {
      const results = await runChecks({ features: ["inflight", "retention"], env });
      const bad = REQUIREMENT_IDS.filter((id) => results.get(id)!.verdict !== "held");
      assert.deepEqual(bad, [], bad.map((id) => `${JSON.stringify(env)} ${id}: ${results.get(id)!.verdict}: ${results.get(id)!.detail}`).join("\n"));
    }
  });
});
