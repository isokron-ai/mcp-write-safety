// The frozen interfaces (docs/INTERFACES.md): the commit point, the injected
// clock, the backend seams, principals and key-record scoping, and the record
// field names. Six streams build against these without talking to each other;
// a change here is a change to the contract.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBackend, startServer } from "../src/start.js";
import { attributionHeaders } from "../src/attribution.js";
import { META_KEYS } from "../src/fixture-properties.js";
import { connectClient } from "./support/stack.js";
import type { Clock } from "../src/clock.js";
import type { CommitSink, CommittedTransaction, RefusedTransaction, ReplayedTransaction } from "../src/backend/commit.js";
import { memoryKeyRecords } from "../src/backend/seams.js";
import { loadPrincipalsFile, parsePrincipals, PrincipalError } from "../src/principals.js";
import { RECORD_FIELDS } from "../src/records.js";
import { BACKEND_SEAMS } from "../src/backend/defects/index.js";
import { Rest } from "./support/stack.js";

const TOKEN = "backend-token-interfaces-0000000";

class Recorder implements CommitSink {
  readonly name = "recorder";
  readonly role = "observer" as const;
  readonly events: Array<{ kind: string; tx: CommittedTransaction | ReplayedTransaction | RefusedTransaction }> = [];
  onCommit(tx: CommittedTransaction) { this.events.push({ kind: "commit", tx }); }
  onReplay(tx: ReplayedTransaction) { this.events.push({ kind: "replay", tx }); }
  onRefusal(tx: RefusedTransaction) { this.events.push({ kind: "refusal", tx }); }
}

describe("the commit point (rule 9)", () => {
  it("tells every sink of each commit, replay and refusal, in order, with attribution, principal and post-state", async () => {
    const rec = new Recorder();
    const backend = await startBackend({ token: TOKEN, port: 4693, sinks: [rec] });
    try {
      const api = new Rest(backend.url, TOKEN);
      const tags = { "tiny-tracker-run": "run-abc-1", "tiny-tracker-operation": "op-1" };
      const created = await api.send("POST", "/tickets", { project: "inbox", title: "a" }, { "idempotency-key": "iface-key-0001", ...tags });
      await api.send("POST", "/tickets", { project: "inbox", title: "a" }, { "idempotency-key": "iface-key-0001", ...tags });
      await api.send("POST", "/tickets", { project: "inbox", title: "b" }, { "idempotency-key": "iface-key-0001" });
      await api.send("PATCH", `/tickets/${created.body.ticket.id}`, { title: "c" }, { "tiny-tracker-run": "bad tag!" });
      await api.send("GET", "/tickets");
      await api.send("DELETE", "/tickets/T-404");
      assert.deepEqual(rec.events.map((e) => e.kind), ["commit", "replay", "refusal", "commit", "refusal"]);
      assert.deepEqual(rec.events.map((e) => (e.tx as CommittedTransaction).seq), [1, undefined, undefined, 2, undefined], "commits only take a commit sequence");
      assert.equal((rec.events[1].tx as ReplayedTransaction).originalSeq, 1, "the replay names the commit it answers for");
      const first = rec.events[0].tx as CommittedTransaction;
      assert.equal(first.principal, "p-default");
      assert.deepEqual(first.attribution, { run: "run-abc-1", operation: "op-1" });
      assert.equal(first.request.key, "iface-key-0001");
      assert.match(first.request.fingerprint!, /^POST \/tickets \{/);
      assert.deepEqual(first.objects, [{ type: "ticket", id: "T-1" }]);
      assert.equal((first.body as any).ticket.created_at, created.body.ticket.created_at, "post-state, as committed");
      assert.equal(first.clockOffsetMs, 0);
      assert.equal((rec.events[2].tx as RefusedTransaction).code, "idempotency_key_reused");
      assert.deepEqual(rec.events[3].tx.attribution, { run: null, operation: null }, "a malformed tag is dropped");
      assert.equal((rec.events[4].tx as RefusedTransaction).status, 404);
    } finally {
      await backend.close();
    }
  });

  it("lost-update waits before the commit section and writes inside it: one commit per PATCH, the stale write still loses the other update", async () => {
    const rec = new Recorder();
    const backend = await startBackend({ token: TOKEN, port: 4694, sinks: [rec], defects: ["lost-update"] });
    try {
      const api = new Rest(backend.url, TOKEN);
      const t = await api.createTicket({ project: "inbox", title: "a" });
      const [x, y] = await Promise.all([api.send("PATCH", `/tickets/${t.id}`, { title: "b" }), api.send("PATCH", `/tickets/${t.id}`, { priority: 5 })]);
      assert.equal(x.status, 200);
      assert.equal(y.status, 200);
      const now = await api.ticket(t.id);
      assert.ok(now.title === "a" || now.priority !== 5, "one of the two concurrent updates is lost, as in 0.1.0");
      assert.deepEqual(rec.events.map((e) => [e.kind, (e.tx as CommittedTransaction).seq]), [["commit", 1], ["commit", 2], ["commit", 3]]);
    } finally {
      await backend.close();
    }
  });

  it("a sink that throws stops the store (fail-stop): 503 from then on", async () => {
    let n = 0;
    const flaky: CommitSink = { name: "flaky", role: "ledger", onCommit() { if (++n === 2) throw new Error("disk full"); } };
    const backend = await startBackend({ token: TOKEN, port: 4695, sinks: [flaky] });
    try {
      const api = new Rest(backend.url, TOKEN);
      assert.equal((await api.send("POST", "/tickets", { project: "inbox", title: "a" })).status, 201);
      const failed = await api.send("POST", "/tickets", { project: "inbox", title: "b" });
      assert.equal(failed.status, 503);
      assert.match(failed.body.message, /commit sink flaky failed: disk full/);
      assert.equal((await api.send("GET", "/tickets")).status, 503);
    } finally {
      await backend.close();
    }
  });
});

describe("the commit order: validate, journal, apply, ledger, reply", () => {
  it("the journal is told first; a journal error aborts the write with nothing applied, and the store carries on", async () => {
    const order: string[] = [];
    let failNext = false;
    const journal: CommitSink = { name: "journal", role: "journal", onCommit(tx) {
      if (failNext) { failNext = false; throw new Error("disk full"); }
      order.push(`journal ${tx.seq}`);
    } };
    const ledger: CommitSink = { name: "ledger", role: "ledger", onCommit(tx) { order.push(`ledger ${tx.seq}`); } };
    const backend = await startBackend({ token: TOKEN, port: 4692, sinks: [ledger, journal] });
    try {
      const api = new Rest(backend.url, TOKEN);
      const t = await api.createTicket({ project: "inbox", title: "a", labels: ["x"] });
      failNext = true;
      const failed = await api.send("POST", "/tickets", { project: "inbox", title: "b", labels: ["y"] }, { "idempotency-key": "journal-key-0001" });
      assert.equal(failed.status, 503);
      assert.equal(failed.body.error, "journal_unavailable");
      assert.deepEqual((await api.export()).tickets.map((x) => x.id), [t.id], "nothing applied");
      const again = await api.send("POST", "/tickets", { project: "inbox", title: "b", labels: ["y"] }, { "idempotency-key": "journal-key-0001" });
      assert.equal(again.status, 201, "the key was not held by the aborted write");
      assert.equal(again.headers.get("idempotent-replayed"), null);
      assert.equal(again.body.ticket.id, "T-2", "the id counter was put back");
      assert.equal(again.body.ticket.labels[0].id, "L-2");
      assert.deepEqual(order, ["journal 1", "ledger 1", "journal 2", "ledger 2"], "commit sequence not consumed by the aborted write");
      await assert.rejects(async () => backend.store.addSink({ name: "j2", role: "journal", onCommit() {} }));
    } finally {
      await backend.close();
    }
  });
});

describe("the injected clock (rule 8)", () => {
  it("every stored time and the transaction offset come from the clock the backend was given", async () => {
    const fixed = new Date("2030-01-02T03:04:05.000Z");
    const clock: Clock = { domain: "fixture", now: () => fixed, wallNow: () => new Date(), offsetMs: () => 86_400_000 };
    const rec = new Recorder();
    const backend = await startBackend({ token: TOKEN, port: 4696, clock, sinks: [rec] });
    try {
      const api = new Rest(backend.url, TOKEN);
      const t = await api.createTicket({ project: "inbox", title: "a", comment: "c" });
      assert.equal(t.created_at, "2030-01-02T03:04:05.000Z");
      assert.equal(t.comments[0].created_at, "2030-01-02T03:04:05.000Z");
      assert.equal(rec.events[0].tx.clockOffsetMs, 86_400_000);
      assert.notEqual(rec.events[0].tx.at.slice(0, 4), "2030", "the transaction's `at` is wall time");
    } finally {
      await backend.close();
    }
  });
});

describe("principals and key-record scoping (D5)", () => {
  it("each principal's token authenticates; key records are scoped by principal, never by run", async () => {
    const principals = parsePrincipals(JSON.stringify({ principals: [{ id: "p-alice", token: "alice-token-0000000000" }, { id: "p-bob", token: "bob-token-00000000000000" }] }));
    const rec = new Recorder();
    const backend = await startBackend({ token: "unused-token-000000000000", port: 4697, principals, sinks: [rec] });
    try {
      const alice = new Rest(backend.url, "alice-token-0000000000");
      const bob = new Rest(backend.url, "bob-token-00000000000000");
      assert.equal((await new Rest(backend.url, "unused-token-000000000000").send("GET", "/tickets")).status, 401);
      const h = { "idempotency-key": "shared-key-0001" };
      const a = await alice.send("POST", "/tickets", { project: "inbox", title: "x" }, { ...h, "tiny-tracker-run": "run-a-1" });
      const aLater = await alice.send("POST", "/tickets", { project: "inbox", title: "x" }, { ...h, "tiny-tracker-run": "run-a-2" });
      assert.equal(aLater.headers.get("idempotent-replayed"), "true", "a later run of the same principal recovers by key alone");
      assert.equal(aLater.body.ticket.id, a.body.ticket.id);
      const b = await bob.send("POST", "/tickets", { project: "inbox", title: "x" }, h);
      assert.equal(b.status, 201);
      assert.notEqual(b.body.ticket.id, a.body.ticket.id, "another principal's key is its own");
      assert.deepEqual(rec.events.map((e) => [e.kind, e.tx.principal]), [["commit", "p-alice"], ["replay", "p-alice"], ["commit", "p-bob"]]);
    } finally {
      await backend.close();
    }
  });

  it("the principals file is strict: 0600, unique ids and tokens, the id format", () => {
    const dir = mkdtempSync(join(tmpdir(), "tt-principals-"));
    try {
      const f = join(dir, "p.json");
      writeFileSync(f, JSON.stringify({ principals: [{ id: "p-a", token: "token-a-00000000000000" }] }));
      chmodSync(f, 0o644);
      assert.throws(() => loadPrincipalsFile(f), /chmod 600/);
      chmodSync(f, 0o600);
      assert.deepEqual(loadPrincipalsFile(f), [{ id: "p-a", token: "token-a-00000000000000" }]);
      assert.throws(() => parsePrincipals('{"principals":[{"id":"alice","token":"token-a-00000000000000"}]}'), PrincipalError);
      assert.throws(() => parsePrincipals('{"principals":[{"id":"p-a","token":"t-000000000000000000"},{"id":"p-b","token":"t-000000000000000000"}]}'), /shares a token/);
      assert.throws(() => parsePrincipals('{"principals":[]}'), PrincipalError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("memory key records drop one run's records for a run reset", () => {
    const k = memoryKeyRecords();
    const reply = (run: string | null) => ({ fingerprint: "f", status: 201, body: {}, headers: {}, run, seq: 1, committedAt: "", clockOffsetMs: 0 });
    k.put({ principal: "p-a" }, "key-00000001", reply("run-1"));
    k.put({ principal: "p-a" }, "key-00000002", reply("run-2"));
    k.put({ principal: "p-b" }, "key-00000001", reply("run-1"));
    assert.equal(k.dropRun({ principal: "p-a" }, "run-1"), 1, "run tags are scoped per principal");
    assert.ok(k.get({ principal: "p-b" }, "key-00000001"));
    assert.equal(k.get({ principal: "p-a" }, "key-00000001"), undefined);
    assert.ok(k.get({ principal: "p-a" }, "key-00000002"));
  });
});

describe("frozen record field names", () => {
  it("RECORD_FIELDS and the schemas' required members are the same lists, in the same order", () => {
    for (const [name, fields] of Object.entries(RECORD_FIELDS)) {
      const schema = JSON.parse(readFileSync(new URL(`../../schemas/${name}-1.schema.json`, import.meta.url), "utf8"));
      assert.deepEqual(schema.required, fields, name);
      assert.deepEqual(Object.keys(schema.properties), fields, name);
      const example = JSON.parse(readFileSync(new URL(`../../schemas/examples/${name}.json`, import.meta.url), "utf8"));
      assert.deepEqual(Object.keys(example), fields, `${name} example`);
    }
  });

  it("the seams the streams need are named; keyRecord is wired", () => {
    assert.equal(BACKEND_SEAMS.keyRecord.wired, true);
    for (const s of ["digest", "lookup", "journal", "keyExpiry"] as const) assert.equal(BACKEND_SEAMS[s].wired, false, s);
  });
});

describe("the MCP-layer fault hook (ServerExtras.onResult)", () => {
  it("sees every result with its tool name inside the call's attribution, and decides what is sent", async () => {
    const backend = await startBackend({ token: TOKEN, port: 4698 });
    const seen: Array<{ tool: string; tags: Record<string, string> }> = [];
    const server = await startServer({
      env: { TRACKER_BACKEND_URL: backend.url, TRACKER_BACKEND_TOKEN: TOKEN }, port: 4699,
      extras: {
        attribution: true,
        async onResult(tool, result) {
          seen.push({ tool, tags: attributionHeaders() });
          return tool === "list_projects" ? { content: [{ type: "text", text: "replaced by the hook" }] } : result;
        },
      },
    });
    const mcp = await connectClient(server.url, "2026-07-28");
    try {
      const r = await mcp.client.callTool({ name: "list_projects", arguments: {}, _meta: { [META_KEYS.run]: "run-h-1" } }) as { content: Array<{ text: string }> };
      assert.equal(r.content[0].text, "replaced by the hook");
      await mcp.client.callTool({ name: "get_ticket", arguments: { id: "T-9" } });
      assert.deepEqual(seen, [{ tool: "list_projects", tags: { "tiny-tracker-run": "run-h-1" } }, { tool: "get_ticket", tags: {} }]);
    } finally {
      await mcp.close();
      await server.close();
      await backend.close();
    }
  });
});
