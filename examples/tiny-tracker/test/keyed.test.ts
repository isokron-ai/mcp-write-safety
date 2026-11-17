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
    assert.match(checkCompat({ ...base, variants: ["settle-by-lookup"] }).join(), /needs the inflight feature/);
    assert.deepEqual(checkCompat({ ...base, variants: ["settle-by-lookup"], features: ["inflight"] }), []);
    assert.match(checkCompat({ ...base, variants: ["key-store-durable", "key-store-honest"] }).join(), /name one/);
    assert.match(checkCompat({ ...base, variants: ["settle-by-client-reference"], features: ["inflight"] }).join(), /no idempotency key/);
    // The default profile's lookup is turned off by these variants (as with key-store-honest), not refused.
    for (const v of ["key-store-durable", "settle-by-client-reference"]) {
      assert.deepEqual(checkCompat({ ...base, variants: [v] }), [], v);
      assert.match(checkCompat({ ...base, variants: [v], features: ["lookup"] }).join(), /no idempotency key/, `${v} with a named lookup`);
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
      const flag = await runCli(["backend", "--key-expiry", "forget", "--port", "0"], env);
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
