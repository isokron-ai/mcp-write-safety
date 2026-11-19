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
import { memoryKeyRecords, type AbortReason, type InflightKeyRecordSeam, type KeyRecordSeam, type KeyTombstone, type StoredReply } from "../src/backend/seams.js";
import { storedReplyOf, type AppliedWrite, type ObjectOwner, type SeedState } from "../src/backend/commit.js";
import { Store, type Project, type Ticket } from "../src/backend/store.js";
import { ApiError } from "../src/backend/store.js";
import { BACKEND_DEFECTS, type BackendDefect } from "../src/backend/defects/index.js";
import { digestOf, DOMAINS, fingerprintHash } from "../src/digest.js";
import { executionId } from "../src/records.js";
import { RunRegistry } from "../src/fixture/control.js";
import { readdirSync } from "node:fs";
import { createFixtureLayer } from "../src/fixture/index.js";
import { checkArgv, TokenError } from "../src/tokens.js";
import { loadToken } from "../src/fixture/tokens.js";
import { checkCompat } from "../src/compat.js";
import { effectiveFeatures, featureOffText, featuresTurnedOff, PROFILE_FEATURES } from "../src/profile.js";
import { COMMIT_STEPS, SECTION_STEPS } from "../src/fault-points.js";
import { mkdirSync, symlinkSync } from "node:fs";
import { request as httpRequest } from "node:http";
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
    const backend = await startBackend({ token: TOKEN, port: 0, sinks: [rec] });
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
      assert.equal(first.request!.key, "iface-key-0001");
      assert.match(first.request!.fingerprint!, /^POST \/tickets \{/);
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
    const backend = await startBackend({ token: TOKEN, port: 0, sinks: [rec], defects: ["lost-update"] });
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
    const backend = await startBackend({ token: TOKEN, port: 0, sinks: [flaky] });
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
    const backend = await startBackend({ token: TOKEN, port: 0, sinks: [ledger, journal] });
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
    const backend = await startBackend({ token: TOKEN, port: 0, clock, sinks: [rec] });
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
    const backend = await startBackend({ token: "unused-token-000000000000", port: 0, principals, sinks: [rec] });
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
    assert.equal(k.get({ principal: "p-b" }, "key-00000001")?.state, "completed");
    assert.equal(k.get({ principal: "p-a" }, "key-00000001"), undefined);
    assert.deepEqual(k.get({ principal: "p-a" }, "key-00000002"), { state: "completed", reply: reply("run-2") });
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
    // digest and lookup are wired by 0.2.0 (stream A); journal and keyExpiry by 0.3.0 (stream D).
    for (const s of ["digest", "lookup", "journal", "keyExpiry"] as const) assert.equal(BACKEND_SEAMS[s].wired, true, s);
  });
});

describe("the MCP-layer fault hook (ServerExtras.onResult)", () => {
  it("sees every result with its tool name inside the call's attribution, and decides what is sent", async () => {
    const backend = await startBackend({ token: TOKEN, port: 0 });
    const seen: Array<{ tool: string; tags: Record<string, string> }> = [];
    const server = await startServer({
      env: { TRACKER_BACKEND_URL: backend.url, TRACKER_BACKEND_TOKEN: TOKEN }, port: 0,
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

// ---- seams v2 ----

/** A journal stand-in: records every commit it is told, in order (role "journal": told first). */
class JournalRecorder implements CommitSink {
  readonly name = "journal-recorder";
  readonly role = "journal" as const;
  readonly lines: CommittedTransaction[] = [];
  failNext = false;
  onCommit(tx: CommittedTransaction) {
    if (this.failNext) { this.failNext = false; throw new Error("disk full"); }
    this.lines.push(structuredClone(tx));
  }
}

/** A clock whose every now() is one second later: a second read inside one commit would show. */
function steppingClock(): Clock & { reads: number } {
  const c = { reads: 0, domain: "fixture" as const, wallNow: () => new Date(), offsetMs: () => 0, now: () => new Date(Date.UTC(2030, 0, 1) + 1000 * c.reads++) };
  return c;
}

/**
 * A reference replay of journalled transactions (what Store.applyPostState, stream D, must do), here only to show
 * that a CommittedTransaction carries everything: no clock, no operation re-run.
 */
function replay(seed: SeedState, txs: CommittedTransaction[]) {
  const projects = new Map<string, Project>(seed.projects.map((p) => [p.key, structuredClone(p)]));
  const tickets = new Map<string, Ticket>();
  const applied = new Map<string, AppliedWrite[]>();
  const owners = new Map<string, ObjectOwner>();
  const keys = new Map<string, StoredReply>();
  let counters = { ...seed.counters };
  let commitSeq = 0;
  for (const tx of txs) {
    for (const p of tx.post.upserts.projects) projects.set(p.key, structuredClone(p));
    for (const t of tx.post.upserts.tickets) tickets.set(t.id, structuredClone(t));
    for (const k of tx.post.deletes.projects) { projects.delete(k); owners.delete(`project:${k}`); }
    for (const k of tx.post.deletes.tickets) { tickets.delete(k); applied.delete(k); owners.delete(`ticket:${k}`); }
    for (const o of tx.post.owners) owners.set(`${o.type}:${o.id}`, { ...o });
    for (const a of tx.post.applied) applied.set(a.ticket, [...(applied.get(a.ticket) ?? []), { ...a }].slice(-20));
    counters = { ...tx.post.counters };
    commitSeq = tx.seq;
    // Key records only for a write with a backend fingerprint (a keyed POST); a run reset has no request at all.
    if (tx.kind === "write" && tx.request?.fingerprint != null) keys.set(`${tx.principal}\u0000${tx.request.key}`, storedReplyOf(tx));
    if (tx.kind === "run-reset") for (const [k, v] of keys) if (v.run === tx.reset!.run && k.startsWith(`${tx.reset!.principal}\u0000`)) keys.delete(k);
  }
  return { projects, tickets, applied, owners, seq: counters, commitSeq, keys };
}

const asObject = (entries: unknown) => Object.fromEntries(entries as Array<[string, unknown]>);

describe("seams v2: the CommittedTransaction is complete post-state", () => {
  it("one record-clock read per commit, used for every stored time, the key record and committedAt", async () => {
    const clock = steppingClock();
    const journal = new JournalRecorder();
    const backend = await startBackend({ token: TOKEN, port: 0, clock, sinks: [journal], bootId: "00112233aabbccdd" });
    try {
      const api = new Rest(backend.url, TOKEN);
      const body = { project: "inbox", title: "a", comment: "first", labels: ["x", "y"] };
      const created = await api.send("POST", "/tickets", body, { "idempotency-key": "clock-key-0001", "tiny-tracker-run": "run-c-1" });
      const tx = journal.lines[0];
      assert.equal(tx.kind, "write");
      assert.equal(tx.bootId, "00112233aabbccdd");
      assert.equal(created.body.ticket.created_at, tx.committedAt);
      assert.equal(created.body.ticket.updated_at, tx.committedAt);
      assert.equal(created.body.ticket.comments[0].created_at, tx.committedAt);
      const kr = backend.store.keyRecords!.get({ principal: "p-default" }, "clock-key-0001");
      assert.equal(kr?.state === "completed" && kr.reply.committedAt, tx.committedAt, "the key record's time is the commit's");
      assert.deepEqual(tx.request!.body, body, "the request body travels with the transaction");
      assert.equal(tx.request!.fingerprintHash, fingerprintHash("p-default", "POST", "/tickets", body), "fingerprint_hash computed once, at the commit point");
      assert.equal(tx.headers.etag, '"1"', "the reply headers, ETag included");
      assert.deepEqual(tx.post.counters, { ticket: 1, label: 2, comment: 1 });
      assert.deepEqual(tx.post.owners, [{ type: "ticket", id: "T-1", principal: "p-default", run: "run-c-1" }]);
      assert.deepEqual(tx.post.upserts.tickets.map((t) => t.labels.map((l) => l.id)), [["L-1", "L-2"]]);
      const unkeyed = await api.send("PATCH", "/tickets/T-1", { title: "b" });
      assert.equal(unkeyed.status, 200);
      assert.equal(journal.lines[1].request!.fingerprint, null, "no backend comparison string without a key");
      assert.equal(journal.lines[1].request!.fingerprintHash, fingerprintHash("p-default", "PATCH", "/tickets/T-1", { title: "b" }), "fingerprint_hash for a write without a key");
      assert.equal(unkeyed.body.ticket.updated_at, journal.lines[1].committedAt);
    } finally {
      await backend.close();
    }
  });

  it("a batch carries every ticket's state and its new label ids; deletes and applied-write entries are listed", async () => {
    const journal = new JournalRecorder();
    const backend = await startBackend({ token: TOKEN, port: 0, sinks: [journal] });
    try {
      const api = new Rest(backend.url, TOKEN);
      const a = await api.createTicket({ project: "inbox", title: "a" });
      const b = await api.createTicket({ project: "inbox", title: "b" });
      const r = await api.send("POST", "/batch", { ops: [{ op: "patch", id: a.id, set: { labels: ["n1", "n2"], priority: 5 } }, { op: "delete", id: b.id }] });
      assert.equal(r.status, 200);
      const tx = journal.lines.at(-1)!;
      assert.deepEqual(tx.post.upserts.tickets.map((t) => [t.id, t.version, t.priority, t.labels]), [[a.id, 2, 5, [{ id: "L-1", name: "n1" }, { id: "L-2", name: "n2" }]]]);
      assert.deepEqual(tx.post.deletes.tickets, [b.id]);
      assert.deepEqual(tx.post.counters, { ticket: 2, label: 2, comment: 0 });
      assert.equal(tx.post.applied.length, 1);
      assert.deepEqual({ ...tx.post.applied[0], fingerprint: undefined }, { ticket: a.id, principal: "p-default", fromVersion: 1, toVersion: 2, fingerprint: undefined, seq: tx.seq });
    } finally {
      await backend.close();
    }
  });

  it("replaying the journalled transactions onto the seed rebuilds every state field, the whole key-record map and every execution record", async () => {
    const clock = steppingClock();
    const journal = new JournalRecorder();
    const runs = new Map([["run-a-1", "p-default"], ["run-b-1", "p-default"]]);
    const live = new Map<string, StoredReply>();
    const fake: BackendDefect = {
      name: "fake-visible-keys", summary: "", context: "MWS-RETRY-2", seams: ["keyRecord"], requires: [],
      apply(ops) { ops.keyRecord = visibleKeyRecords(live); },
    };
    BACKEND_DEFECTS.push(fake);
    const backend = await startBackend({ token: TOKEN, port: 0, clock, sinks: [journal], runOwner: (r) => runs.get(r), defects: ["fake-visible-keys"] });
    try {
      const api = new Rest(backend.url, TOKEN);
      const served: unknown[] = [];
      const send = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
        const r = await api.send(method, path, body, headers);
        if (r.status < 300 && r.headers.get("idempotent-replayed") === null) served.push(r.status === 204 ? undefined : r.body);
        return r;
      };
      const run = { "tiny-tracker-run": "run-a-1" };
      await send("POST", "/projects", { key: "p1", name: "P1" }, run);
      const t1 = (await send("POST", "/tickets", { project: "p1", title: "one", labels: ["a"] }, { "idempotency-key": "replay-key-0001", ...run })).body.ticket;
      const t2 = (await send("POST", "/tickets", { project: "inbox", title: "two", comment: "c" }, { "idempotency-key": "replay-key-0002", "tiny-tracker-run": "run-b-1" })).body.ticket;
      await send("POST", "/tickets", { project: "inbox", title: "four" }, { "idempotency-key": "replay-key-0003" });
      // A PATCH that carries an Idempotency-Key: the key is ignored, so no execution record names it.
      await send("PATCH", `/tickets/${t2.id}`, { details: { severity: "high" } }, { "if-match": '"1"', "idempotency-key": "patch-key-0001" });
      await send("PUT", `/tickets/${t2.id}`, { title: "two!", status: "open", assignee: null, priority: 1 }, { "if-match": '"2"' });
      await send("POST", `/tickets/${t2.id}/labels`, { name: "z" });
      await send("POST", `/tickets/${t2.id}/comments`, { body: "again" });
      await send("PUT", "/projects/inbox", { name: "Inbox" });
      await send("POST", "/batch", { ops: [{ op: "patch", id: t1.id, set: { labels: ["a", "b"] } }] });
      const t3 = (await send("POST", "/tickets", { project: "inbox", title: "three" })).body.ticket;
      await send("DELETE", `/tickets/${t3.id}`);
      const reset = backend.dropRun({ principal: "p-default" }, "run-a-1");
      assert.deepEqual(reset.tx.reset!.objects, [{ type: "ticket", id: t1.id }, { type: "project", id: "p1" }]);
      assert.equal(reset.keys, 1);
      assert.equal(reset.tx.request, null, "a run reset carries no request");
      const patchTx = journal.lines.find((t) => t.request?.method === "PATCH")!;
      assert.equal(patchTx.request!.key, null, "a key header on a PATCH is not recorded");
      const readsBefore = clock.reads;
      const rebuilt = replay(backend.store.seed, journal.lines);
      assert.equal(clock.reads, readsBefore, "replay reads no clock");
      const state = backend.store.captureState();
      assert.deepEqual(asObject([...rebuilt.projects]), asObject(state.projects));
      assert.deepEqual(asObject([...rebuilt.tickets]), asObject(state.tickets));
      assert.deepEqual(asObject([...rebuilt.applied]), asObject(state.applied));
      assert.deepEqual(asObject([...rebuilt.owners]), asObject(state.owners));
      assert.deepEqual(rebuilt.seq, state.seq);
      assert.equal(rebuilt.commitSeq, state.commitSeq);
      assert.deepEqual(asObject([...rebuilt.keys]), asObject([...live]), "the whole key-record map");
      assert.deepEqual([...rebuilt.keys.keys()].sort(), ["p-default\u0000replay-key-0002", "p-default\u0000replay-key-0003"], "the reset dropped run-a-1's record");
      // Execution records from the journal: every key they name has a key record (or was dropped by the reset with its
      // run), and every result digest is the digest of the body the client was served.
      const writes = journal.lines.filter((t) => t.kind === "write");
      const records = writes.map((t) => ({
        id: executionId(t.seq), principal: t.principal, run: t.attribution.run, seq: t.seq,
        request: { method: t.request!.method, path: t.request!.path, key: t.request!.key, fingerprint_hash: t.request!.fingerprintHash },
        objects: t.objects, result: digestOf(DOMAINS.executionResult, t.body ?? null), committed_at: t.committedAt,
      }));
      assert.deepEqual(records.map((r) => r.id), writes.map((t) => `X-${t.seq}`));
      for (const r of records) {
        if (r.request.key === null) continue;
        const k = `${r.principal}\u0000${r.request.key}`;
        assert.ok(rebuilt.keys.has(k) || r.run === "run-a-1", `${r.id} names key ${r.request.key}, which has a key record`);
        if (rebuilt.keys.has(k)) assert.equal(rebuilt.keys.get(k)!.seq, r.seq);
      }
      assert.deepEqual(records.map((r) => r.result.digest), served.map((b) => digestOf(DOMAINS.executionResult, b ?? null).digest), "digests of the bodies as served");
      assert.deepEqual(journal.lines.map((t) => t.seq), journal.lines.map((_, i) => i + 1), "every commit, the reset included, takes the next seq");
    } finally {
      BACKEND_DEFECTS.pop();
      await backend.close();
    }
  });
});

/** Memory key records whose map the test can see (keyed `principal\0key`, like the reference replay). */
function visibleKeyRecords(map: Map<string, StoredReply>): KeyRecordSeam {
  const id = (s: { principal: string }, k: string) => `${s.principal}\u0000${k}`;
  return {
    get: (s, k) => { const r = map.get(id(s, k)); return r && { state: "completed", reply: r }; },
    put: (s, k, r) => void map.set(id(s, k), r),
    dropRun(s, run) {
      let n = 0;
      for (const [k, v] of map) if (v.run === run && k.startsWith(`${s.principal}\u0000`)) { map.delete(k); n++; }
      return n;
    },
  };
}

describe("seams v2: a re-sent conditional write is a replay, not a commit", () => {
  it("an If-Match PATCH repeated after it applied is told to sinks as a replay of its commit; no new seq", async () => {
    const rec = new Recorder();
    const backend = await startBackend({ token: TOKEN, port: 0, sinks: [rec] });
    try {
      const api = new Rest(backend.url, TOKEN);
      const t = await api.createTicket({ project: "inbox", title: "a" });
      const first = await api.send("PATCH", `/tickets/${t.id}`, { title: "b" }, { "if-match": '"1"' });
      const again = await api.send("PATCH", `/tickets/${t.id}`, { title: "b" }, { "if-match": '"1"' });
      assert.equal(first.status, 200);
      assert.equal(again.status, 200);
      assert.equal(again.headers.get("idempotent-replayed"), "true");
      const putAgain = await api.send("PUT", `/tickets/${t.id}`, { title: "c", status: "open", assignee: null, priority: 3 }, { "if-match": '"2"' });
      const putRepeat = await api.send("PUT", `/tickets/${t.id}`, { title: "c", status: "open", assignee: null, priority: 3 }, { "if-match": '"2"' });
      assert.equal(putAgain.status, 200);
      assert.equal(putRepeat.headers.get("idempotent-replayed"), "true");
      assert.deepEqual(rec.events.map((e) => [e.kind, (e.tx as CommittedTransaction).seq ?? (e.tx as ReplayedTransaction).originalSeq]),
        [["commit", 1], ["commit", 2], ["replay", 2], ["commit", 3], ["replay", 3]]);
      assert.equal(backend.store.lastSeq, 3);
    } finally {
      await backend.close();
    }
  });
});

describe("seams v2: journal failure, the snapshot, sink order", () => {
  it("a journal failure is reported to the ledger as a 503 journal_unavailable refusal, after the store was put back", async () => {
    const journal = new JournalRecorder();
    const rec = new Recorder();
    const backend = await startBackend({ token: TOKEN, port: 0, sinks: [journal, rec] });
    try {
      const api = new Rest(backend.url, TOKEN);
      await api.createTicket({ project: "inbox", title: "a", labels: ["x"] });
      const before = backend.store.captureState();
      journal.failNext = true;
      const failed = await api.send("POST", "/batch", { ops: [{ op: "patch", id: "T-1", set: { labels: ["y"], title: "b" } }] });
      assert.equal(failed.status, 503);
      assert.deepEqual(backend.store.captureState(), before, "every state field put back");
      const last = rec.events.at(-1)!;
      assert.equal(last.kind, "refusal");
      assert.equal((last.tx as RefusedTransaction).status, 503);
      assert.equal((last.tx as RefusedTransaction).code, "journal_unavailable");
    } finally {
      await backend.close();
    }
  });

  it("the snapshot covers every Store field: each one is state or wiring, never neither", () => {
    const store = new Store();
    const fields = Object.keys(store).sort();
    const listed = [...Store.STATE_FIELDS, ...Store.WIRING_FIELDS];
    assert.equal(new Set(listed).size, listed.length, "no field in both lists");
    assert.deepEqual(fields, [...listed].sort(), "a new Store field goes into STATE_FIELDS (snapshotted) or WIRING_FIELDS");
    assert.deepEqual(Object.keys(store.captureState()).sort(), [...Store.STATE_FIELDS].sort());
  });

  it("ledger sinks are told before observers, whatever the order they were added in; a defect's observers come last", async () => {
    const order: string[] = [];
    const sink = (name: string, role: "ledger" | "observer"): CommitSink => ({ name, role, onCommit() { order.push(name); } });
    const fake: BackendDefect = {
      name: "fake-watcher", summary: "", context: "MWS-RETRY-2", seams: ["keyRecord"], requires: [],
      apply(ops) { ops.observers = [sink("defect-observer", "observer")]; },
    };
    BACKEND_DEFECTS.push(fake);
    const backend = await startBackend({ token: TOKEN, port: 0, sinks: [sink("observer-1", "observer"), sink("ledger", "ledger")], defects: ["fake-watcher"] });
    try {
      await new Rest(backend.url, TOKEN).createTicket({ project: "inbox", title: "a" });
      assert.deepEqual(order, ["ledger", "observer-1", "defect-observer"]);
    } finally {
      BACKEND_DEFECTS.pop();
      await backend.close();
    }
  });
});

/** A key-record seam with the 0.3.0 pending and expired states, logging the calls the keyed path makes. */
function loggingInflight(log: string[], opts: { abortThrows?: boolean; putThrows?: boolean; beginThrows?: boolean } = {}): InflightKeyRecordSeam & { expired: Map<string, KeyTombstone> } {
  const done = new Map<string, StoredReply>();
  const pending = new Map<string, { since: string; run: string | null }>();
  const fences = new Map<string, string>();
  const expired = new Map<string, KeyTombstone>();
  const id = (s: { principal: string }, k: string) => `${s.principal}\u0000${k}`;
  return {
    expired,
    get(s, k) {
      const i = id(s, k);
      const p = pending.get(i);
      if (p) return { state: "pending", since: p.since };
      const f = fences.get(i);
      if (f) return { state: "fenced", run: f };
      const t = expired.get(i);
      if (t) return { state: "expired", tombstone: t };
      const r = done.get(i);
      return r && { state: "completed", reply: r };
    },
    put(s, k, r) {
      log.push(`put ${k}`);
      if (opts.putThrows) throw new Error("key store full");
      pending.delete(id(s, k));
      done.set(id(s, k), r);
    },
    dropRun(s, run) {
      let n = 0;
      for (const [i, r] of done) if (r.run === run && i.startsWith(`${s.principal}\u0000`)) { done.delete(i); n++; }
      for (const [i, p] of pending) if (p.run === run && i.startsWith(`${s.principal}\u0000`)) { pending.delete(i); fences.set(i, run); log.push(`fence ${i.split("\u0000")[1]}`); }
      return n;
    },
    begin(s, k, _f, run) {
      log.push(`begin ${k}`);
      if (opts.beginThrows) throw new Error("begin failed");
      pending.set(id(s, k), { since: "2030-01-01T00:00:00.000Z", run });
    },
    abort(s, k, reason: AbortReason) {
      log.push(`abort ${k} ${reason}`);
      pending.delete(id(s, k));
      if (opts.abortThrows) throw new Error("abort failed");
    },
    tombstone: (s, k) => expired.get(id(s, k)),
  };
}

describe("seams v2: the keyed path calls begin and abort (stream D's call sites)", () => {
  it("begin before the section; put on commit; abort on a refusal, a fault-hook error and a journal failure", async () => {
    const log: string[] = [];
    const fake: BackendDefect = {
      name: "fake-inflight", summary: "", context: "MWS-RETRY-2", seams: ["keyRecord"], requires: [],
      apply(ops) { ops.keyRecord = loggingInflight(log); },
    };
    BACKEND_DEFECTS.push(fake);
    const journal = new JournalRecorder();
    let refuseNext = false;
    let crashNext = false;
    const backend = await startBackend({
      token: TOKEN, port: 0, sinks: [journal], defects: ["fake-inflight"],
      faults: { async beforeCommit() {
        if (refuseNext) { refuseNext = false; throw new ApiError(500, "fault", "armed error"); }
        if (crashNext) { crashNext = false; throw new Error("hook broke"); }
      } },
    });
    try {
      const api = new Rest(backend.url, TOKEN);
      assert.equal((await api.send("POST", "/tickets", { project: "inbox", title: "a" }, { "idempotency-key": "inflight-k-0001" })).status, 201);
      assert.equal((await api.send("POST", "/tickets", { project: "nope", title: "a" }, { "idempotency-key": "inflight-k-0002" })).status, 404);
      refuseNext = true;
      assert.equal((await api.send("POST", "/tickets", { project: "inbox", title: "a" }, { "idempotency-key": "inflight-k-0003" })).status, 500);
      journal.failNext = true;
      assert.equal((await api.send("POST", "/tickets", { project: "inbox", title: "a" }, { "idempotency-key": "inflight-k-0004" })).status, 503);
      crashNext = true;
      assert.equal((await api.send("POST", "/tickets", { project: "inbox", title: "a" }, { "idempotency-key": "inflight-k-0005" })).status, 500);
      assert.deepEqual(log, [
        "begin inflight-k-0001", "put inflight-k-0001",
        "begin inflight-k-0002", "abort inflight-k-0002 refused",
        "begin inflight-k-0003", "abort inflight-k-0003 fault",
        "begin inflight-k-0004", "abort inflight-k-0004 journal_unavailable",
        "begin inflight-k-0005", "abort inflight-k-0005 fault",
      ]);
    } finally {
      BACKEND_DEFECTS.pop();
      await backend.close();
    }
  });
});

/** A request whose connection may be closed without an answer: resolves to the status, or "closed". */
function rawPost(url: string, path: string, body: unknown, headers: Record<string, string>): Promise<number | "closed"> {
  return new Promise((resolve) => {
    const req = httpRequest(`${url}${path}`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...headers } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode!));
    });
    req.on("error", () => resolve("closed"));
    req.end(JSON.stringify(body));
  });
}

describe("seams v2: the backend fault hooks (BackendOptions.faults)", () => {
  it("before-commit waits outside the section: a same-key request meanwhile is answered from the record, applied once", async () => {
    const rec = new Recorder();
    let hold = true;
    const backend = await startBackend({
      token: TOKEN, port: 0, sinks: [rec],
      faults: { async beforeCommit() { if (hold) { hold = false; await new Promise((r) => setTimeout(r, 150)); } } },
    });
    try {
      const api = new Rest(backend.url, TOKEN);
      const h = { "idempotency-key": "delay-key-0001" };
      const [x, y] = await Promise.all([api.send("POST", "/tickets", { project: "inbox", title: "a" }, h),
        new Promise((r) => setTimeout(r, 30)).then(() => api.send("POST", "/tickets", { project: "inbox", title: "a" }, h))]);
      assert.equal(x.body.ticket.id, y.body.ticket.id, "one ticket for one key");
      assert.equal((await api.export()).tickets.length, 1);
      assert.deepEqual(rec.events.map((e) => e.kind).sort(), ["commit", "replay"]);
    } finally {
      await backend.close();
    }
  });

  it("after-commit runs after the ledger, before the reply: drop closes the connection, error answers instead; the write is applied", async () => {
    const rec = new Recorder();
    let action: "drop" | "error" | undefined;
    const backend = await startBackend({
      token: TOKEN, port: 0, sinks: [rec],
      faults: {
        async afterCommit({ tx }) {
          assert.ok(rec.events.some((e) => e.kind === "commit" && (e.tx as CommittedTransaction).seq === tx.seq), "the ledger already has it");
          const a = action;
          action = undefined;
          return a === "drop" ? "drop" : a === "error" ? { status: 500, body: { error: "fault" } } : undefined;
        },
      },
    });
    try {
      action = "drop";
      assert.equal(await rawPost(backend.url, "/tickets", { project: "inbox", title: "a" }, {}), "closed");
      action = "error";
      assert.equal(await rawPost(backend.url, "/tickets", { project: "inbox", title: "b" }, {}), 500);
      assert.equal(await rawPost(backend.url, "/tickets", { project: "inbox", title: "c" }, {}), 201);
      assert.deepEqual((await new Rest(backend.url, TOKEN).export()).tickets.map((t) => t.title), ["a", "b", "c"]);
    } finally {
      await backend.close();
    }
  });

  it("the commit steps: pending, then the one synchronous section, then the reply", () => {
    assert.deepEqual(COMMIT_STEPS, ["pending", "validate", "journal", "apply", "ledger", "reply"]);
    assert.deepEqual(SECTION_STEPS, ["validate", "journal", "apply", "ledger"]);
  });
});

describe("seams v2: run ownership and configured principals", () => {
  it("the backend refuses a run tag that belongs to another principal; a reset of another principal's run is refused", async () => {
    const principals = parsePrincipals(JSON.stringify({ principals: [{ id: "p-alice", token: "alice-token-0000000000" }, { id: "p-bob", token: "bob-token-00000000000000" }] }));
    const rec = new Recorder();
    const owners = new Map([["run-a-1", "p-alice"]]);
    const backend = await startBackend({ token: "unused-token-000000000000", port: 0, principals, sinks: [rec], runOwner: (r) => owners.get(r) });
    try {
      const bob = new Rest(backend.url, "bob-token-00000000000000");
      const r = await bob.send("POST", "/tickets", { project: "inbox", title: "x" }, { "tiny-tracker-run": "run-a-1" });
      assert.equal(r.status, 403);
      assert.equal(r.body.error, "run_not_owned");
      assert.equal((rec.events.at(-1)!.tx as RefusedTransaction).code, "run_not_owned");
      const alice = new Rest(backend.url, "alice-token-0000000000");
      assert.equal((await alice.send("POST", "/tickets", { project: "inbox", title: "x" }, { "tiny-tracker-run": "run-a-1" })).status, 201);
      const unknown = await bob.send("POST", "/tickets", { project: "inbox", title: "y" }, { "tiny-tracker-run": "run-unknown-1" });
      assert.equal(unknown.status, 403, "with a run registry wired, a tag it never allocated is refused");
      assert.equal(unknown.body.error, "run_not_allocated");
      assert.equal((rec.events.at(-1)!.tx as RefusedTransaction).code, "run_not_allocated");
      assert.throws(() => backend.dropRun({ principal: "p-bob" }, "run-unknown-1"), /never allocated/);
      assert.throws(() => backend.dropRun({ principal: "p-bob" }, "run-a-1"), /belongs to another principal/);
      assert.equal((rec.events.at(-1)!.tx as RefusedTransaction).request, null, "a run reset's refusal carries request: null");
      assert.equal(backend.dropRun({ principal: "p-alice" }, "run-a-1").objects, 1);
    } finally {
      await backend.close();
    }
  });

  it("the control listener allocates runs only for configured principals, and the fixture layer reports run owners", async () => {
    const layer = createFixtureLayer({
      layout: "all", profile: "default", features: [], control: true, mcpDefects: [], backendDefects: [], variants: [],
      env: { TRACKER_CONTROL_TOKEN: "control-token-interfaces-01" }, argv: [], backendToken: TOKEN,
    });
    const control = await layer.startControl(0);
    try {
      const post = (body: unknown) => fetch(`${control.url}/_fixture/runs`, { method: "POST", headers: { authorization: "Bearer control-token-interfaces-01", "content-type": "application/json" }, body: JSON.stringify(body) });
      const bad = await post({ principal: "p-nobody" });
      assert.equal(bad.status, 400);
      assert.equal(((await bad.json()) as { error: string }).error, "unknown_principal");
      const ok = await post({});
      assert.equal(ok.status, 201);
      const run = ((await ok.json()) as { run_id: string }).run_id;
      assert.equal(layer.runOwner(run), "p-default");
      assert.equal(layer.runOwner("run-nope-1"), undefined);
    } finally {
      await control.close();
    }
  });
});

describe("seams v2: --token-dir and the argv check", () => {
  it("a symbolic link is refused; an empty token file (a concurrent start) stops with a clear message", () => {
    const base = mkdtempSync(join(tmpdir(), "tt-tokendir-"));
    try {
      const real = join(base, "real");
      mkdirSync(real, { mode: 0o700 });
      const link = join(base, "link");
      symlinkSync(real, link);
      assert.throws(() => loadToken("evidence", {}, "linux", link), /symbolic link/);
      const dir = join(base, "tokens");
      mkdirSync(dir, { mode: 0o700 });
      writeFileSync(join(dir, "evidence.token"), "", { mode: 0o600 });
      assert.throws(() => loadToken("evidence", {}, "linux", dir), /another tiny-tracker is starting/);
      symlinkSync(join(dir, "evidence.token"), join(dir, "control.token"));
      assert.throws(() => loadToken("control", {}, "linux", dir), /symbolic link/);
      const fresh = join(base, "fresh");
      const t = loadToken("evidence", {}, "linux", fresh);
      assert.equal(loadToken("evidence", {}, "linux", fresh), t, "reused on restart");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("a short token is matched exactly against each argument instead of being skipped", () => {
    assert.doesNotThrow(() => checkArgv(["--backend-url", "http://tracker.example.com"], { backend: "x" }));
    assert.throws(() => checkArgv(["x"], { backend: "x" }), TokenError);
    assert.throws(() => checkArgv(["--token=x"], { backend: "x" }), TokenError);
    assert.throws(() => checkArgv(["--url=http://h/?t=longer-token-1"], { backend: "longer-token-1" }), TokenError);
  });
});

describe("seams v2: compatibility rules see the effective feature set", () => {
  it("a feature the profile turns on counts like a named one (a simulated default flip)", () => {
    const base = { layout: "all" as const, defects: [], backendDefects: [], variants: [], faults: [], fixtureControl: false };
    const def = PROFILE_FEATURES.default as string[];
    const saved = [...def];
    try {
      def.push("durable");
      assert.ok(checkCompat({ ...base, profile: "default", features: [] }).some((m) => /durable feature needs --data-dir/.test(m)));
    } finally {
      def.splice(0, def.length, ...saved);
    }
  });

  it("CMP-5 (owner decision, 16 Nov 2026, option b): key-store-honest turns off a default-only lookup; a named lookup is refused", () => {
    const base = { layout: "all" as const, defects: [], backendDefects: [], variants: ["key-store-honest"], faults: [], fixtureControl: false };
    assert.deepEqual(checkCompat({ ...base, profile: "default", features: [] }), [], "lookup comes from the profile only: turned off, not refused");
    assert.deepEqual(featuresTurnedOff("default", [], ["key-store-honest"]).map(featureOffText), ["lookup off: key-store-honest keeps keys in the MCP server"]);
    const eff = effectiveFeatures("default", [], ["key-store-honest"]);
    assert.ok(!eff.features.includes("lookup") && eff.features.includes("execution-records"));
    assert.ok(checkCompat({ ...base, profile: "default", features: ["lookup"] }).some((m) => /key-store-honest/.test(m)), "named: refused (exit 2)");
    assert.deepEqual(featuresTurnedOff("default", ["lookup"], ["key-store-honest"]), []);
    assert.deepEqual(featuresTurnedOff("0.1", [], ["key-store-honest"]), [], "profile 0.1 turns nothing on, so nothing is turned off");
    assert.deepEqual(checkCompat({ ...base, profile: "0.1", features: [] }), []);
    assert.deepEqual(featuresTurnedOff("default", [], []), [], "without the variant the default is unchanged");
  });

});

// ---- seams v2.1 ----

/** Starts a backend whose key-record seam is a loggingInflight one (installed as a test defect). */
async function inflightBackend(log: string[], opts: Parameters<typeof loggingInflight>[1] & { sinks?: CommitSink[]; faults?: Parameters<typeof startBackend>[0]["faults"]; runOwner?: (r: string) => string | undefined; principals?: Parameters<typeof startBackend>[0]["principals"] } = {}) {
  const seam = loggingInflight(log, opts);
  const fake: BackendDefect = {
    name: "fake-inflight-21", summary: "", context: "MWS-RETRY-2", seams: ["keyRecord"], requires: [],
    apply(ops) { ops.keyRecord = seam; },
  };
  BACKEND_DEFECTS.push(fake);
  const backend = await startBackend({ token: TOKEN, port: 0, sinks: opts.sinks, defects: ["fake-inflight-21"], faults: opts.faults, runOwner: opts.runOwner });
  return { seam, backend, close: async () => { BACKEND_DEFECTS.pop(); await backend.close(); } };
}

describe("seams v2.1: the keyed path answers every key-record state, in the frozen order, inside the try", () => {
  it("pending: a same-key call while the first is held answers 409 in_progress, told to the ledger as a refusal", async () => {
    const log: string[] = [];
    const rec = new Recorder();
    let hold = true;
    const b = await inflightBackend(log, { sinks: [rec], faults: { async beforeCommit() { if (hold) { hold = false; await new Promise((r) => setTimeout(r, 150)); } } } });
    try {
      const api = new Rest(b.backend.url, TOKEN);
      const h = { "idempotency-key": "pending-key-0001" };
      const [x, y] = await Promise.all([api.send("POST", "/tickets", { project: "inbox", title: "a" }, h),
        new Promise((r) => setTimeout(r, 30)).then(() => api.send("POST", "/tickets", { project: "inbox", title: "a" }, h))]);
      assert.equal(x.status, 201);
      assert.equal(y.status, 409);
      assert.equal(y.body.error, "in_progress");
      assert.equal(y.body.since, "2030-01-01T00:00:00.000Z");
      assert.deepEqual(rec.events.map((e) => [e.kind, (e.tx as RefusedTransaction).code]), [["refusal", "in_progress"], ["commit", undefined]]);
      assert.deepEqual(log, ["begin pending-key-0001", "put pending-key-0001"], "the second call never began, so nothing is aborted for it");
      const again = await api.send("POST", "/tickets", { project: "inbox", title: "a" }, h);
      assert.equal(again.headers.get("idempotent-replayed"), "true", "completed: replayed");
    } finally {
      await b.close();
    }
  });

  it("expired: the same request gets the B10 answer (410 key_expired, a replay of the tombstone's commit); another request is refused 422", async () => {
    const log: string[] = [];
    const rec = new Recorder();
    const b = await inflightBackend(log, { sinks: [rec] });
    try {
      const api = new Rest(b.backend.url, TOKEN);
      const body = { project: "inbox", title: "old" };
      b.seam.expired.set("p-default\u0000expired-key-0001", {
        fingerprintHash: fingerprintHash("p-default", "POST", "/tickets", body), executionId: "X-7", resultDigest: "ab".repeat(32), committedAt: "2030-01-01T00:00:00.000Z",
      });
      const same = await api.send("POST", "/tickets", body, { "idempotency-key": "expired-key-0001" });
      assert.equal(same.status, 410);
      assert.equal(same.headers.get("idempotent-replayed"), "true");
      assert.deepEqual({ error: same.body.error, execution_id: same.body.execution_id, result_digest: same.body.result_digest, committed_at: same.body.committed_at },
        { error: "key_expired", execution_id: "X-7", result_digest: "ab".repeat(32), committed_at: "2030-01-01T00:00:00.000Z" });
      const other = await api.send("POST", "/tickets", { project: "inbox", title: "new" }, { "idempotency-key": "expired-key-0001" });
      assert.equal(other.status, 422);
      assert.equal(other.body.error, "idempotency_key_reused");
      assert.deepEqual(rec.events.map((e) => e.kind), ["replay", "refusal"]);
      assert.equal((rec.events[0].tx as ReplayedTransaction).originalSeq, 7);
      assert.equal((rec.events[0].tx as ReplayedTransaction).status, 410);
      assert.deepEqual(log, [], "nothing begun, nothing applied");
      assert.equal((await api.export()).tickets.length, 0);
    } finally {
      await b.close();
    }
  });

  it("the run reset fences a pending record: the write held at before-commit is refused 409 key_fenced and applies nothing; the key stays fenced", async () => {
    const log: string[] = [];
    const rec = new Recorder();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let entered!: () => void;
    const inHook = new Promise<void>((r) => { entered = r; });
    const b = await inflightBackend(log, { sinks: [rec], runOwner: (r) => (r === "run-f-1" ? "p-default" : undefined), faults: { async beforeCommit() { entered(); await held; } } });
    try {
      const api = new Rest(b.backend.url, TOKEN);
      const pendingCall = api.send("POST", "/tickets", { project: "inbox", title: "late" }, { "idempotency-key": "fence-key-0001", "tiny-tracker-run": "run-f-1" });
      await inHook;
      const reset = b.backend.dropRun({ principal: "p-default" }, "run-f-1");
      assert.equal(reset.keys, 0, "a fenced pending record is not counted as dropped");
      release();
      const r = await pendingCall;
      assert.equal(r.status, 409);
      assert.equal(r.body.error, "key_fenced");
      assert.equal((await api.export()).tickets.length, 0, "the held write never lands after the reset");
      const later = await api.send("POST", "/tickets", { project: "inbox", title: "late" }, { "idempotency-key": "fence-key-0001" });
      assert.equal(later.status, 409);
      assert.equal(later.body.error, "key_fenced", "fenced: nothing begins");
      assert.deepEqual(log, ["begin fence-key-0001", "fence fence-key-0001"], "the fence ended the record: no abort, no second begin");
      assert.deepEqual(rec.events.map((e) => [e.kind, (e.tx as RefusedTransaction).code]), [["commit", undefined], ["refusal", "key_fenced"], ["refusal", "key_fenced"]]);
    } finally {
      await b.close();
    }
  });

  it("abort never hides the answer: a seam whose abort throws still gives the 503", async () => {
    const log: string[] = [];
    const journal = new JournalRecorder();
    const b = await inflightBackend(log, { sinks: [journal], abortThrows: true });
    const errors: string[] = [];
    const saved = console.error;
    console.error = (m: string) => void errors.push(m);
    try {
      journal.failNext = true;
      const r = await new Rest(b.backend.url, TOKEN).send("POST", "/tickets", { project: "inbox", title: "a" }, { "idempotency-key": "abort-key-0001" });
      assert.equal(r.status, 503);
      assert.equal(r.body.error, "journal_unavailable");
      assert.deepEqual(log, ["begin abort-key-0001", "abort abort-key-0001 journal_unavailable"]);
      assert.match(errors.join("\n"), /abort of a pending key record failed \(journal_unavailable\): abort failed/);
    } finally {
      console.error = saved;
      await b.close();
    }
  });

  it("an exception completing the key record (afterJournal) still tells the ledger, then stops the store; nothing is aborted", async () => {
    const log: string[] = [];
    const rec = new Recorder();
    const b = await inflightBackend(log, { sinks: [rec], putThrows: true });
    try {
      const api = new Rest(b.backend.url, TOKEN);
      const r = await api.send("POST", "/tickets", { project: "inbox", title: "a" }, { "idempotency-key": "after-key-0001" });
      assert.equal(r.status, 503);
      assert.match(r.body.message, /commit sink afterJournal failed: key store full/);
      assert.deepEqual(rec.events.map((e) => [e.kind, (e.tx as CommittedTransaction).seq]), [["commit", 1]], "the ledger has the commit");
      assert.deepEqual(log, ["begin after-key-0001", "put after-key-0001"], "a committed write is never aborted");
      assert.equal((await api.send("GET", "/tickets")).status, 503, "fail-stop");
    } finally {
      await b.close();
    }
  });
});

describe("seams v2.1: a re-sent conditional write is a replay only for the same principal", () => {
  it("bob re-sending alice's If-Match PATCH (and PUT) gets the normal 412, not idempotent-replayed (regression)", async () => {
    const principals = parsePrincipals(JSON.stringify({ principals: [{ id: "p-alice", token: "alice-token-0000000000" }, { id: "p-bob", token: "bob-token-00000000000000" }] }));
    const rec = new Recorder();
    const backend = await startBackend({ token: "unused-token-000000000000", port: 0, principals, sinks: [rec] });
    try {
      const alice = new Rest(backend.url, "alice-token-0000000000");
      const bob = new Rest(backend.url, "bob-token-00000000000000");
      const t = (await alice.send("POST", "/tickets", { project: "inbox", title: "a" })).body.ticket;
      assert.equal((await alice.send("PATCH", `/tickets/${t.id}`, { title: "b" }, { "if-match": '"1"' })).status, 200);
      const bobs = await bob.send("PATCH", `/tickets/${t.id}`, { title: "b" }, { "if-match": '"1"' });
      assert.equal(bobs.status, 412);
      assert.equal(bobs.body.error, "precondition_failed");
      assert.equal(bobs.headers.get("idempotent-replayed"), null);
      const alices = await alice.send("PATCH", `/tickets/${t.id}`, { title: "b" }, { "if-match": '"1"' });
      assert.equal(alices.headers.get("idempotent-replayed"), "true", "the same principal's re-send is still a replay");
      const put = { title: "c", status: "open", assignee: null, priority: 3 };
      assert.equal((await alice.send("PUT", `/tickets/${t.id}`, put, { "if-match": '"2"' })).status, 200);
      assert.equal((await bob.send("PUT", `/tickets/${t.id}`, put, { "if-match": '"2"' })).status, 412);
      assert.deepEqual(rec.events.map((e) => [e.kind, e.tx.principal]), [
        ["commit", "p-alice"], ["commit", "p-alice"], ["refusal", "p-bob"], ["replay", "p-alice"], ["commit", "p-alice"], ["refusal", "p-bob"],
      ]);
      assert.deepEqual((rec.events[1].tx as CommittedTransaction).post.applied.map((a) => a.principal), ["p-alice"], "the applied-write entry names its principal");
    } finally {
      await backend.close();
    }
  });

  it("the applied-write log keeps the last 20 entries per ticket", () => {
    assert.equal(Store.APPLIED_CAP, 20);
  });
});

describe("seams v2.1: run ids and the token folder", () => {
  it("run ids carry a random suffix; an allocation the journal cannot record registers nothing; restore puts a run back", () => {
    const reg = new RunRegistry("0011223344556677");
    const a = reg.allocate(null);
    const b = reg.allocate(null);
    assert.match(a.run_id, /^run-00112233-[0-9a-f]{12}$/);
    assert.notEqual(a.run_id, b.run_id);
    const seen: string[] = [];
    reg.onAllocate = (r) => { seen.push(r.run_id); throw new Error("disk full"); };
    assert.throws(() => reg.allocate(null), /could not be recorded/);
    assert.equal(reg.has(seen[0]), false);
    reg.onAllocate = undefined;
    reg.restore({ run_id: "run-00112233-aaaaaaaaaaaa", principal: "p-alice", created_at: "2030-01-01T00:00:00.000Z", label: null });
    assert.equal(reg.owner("run-00112233-aaaaaaaaaaaa"), "p-alice");
  });

  it("a generated token file is linked into place whole: no temporary file is left behind", () => {
    const base = mkdtempSync(join(tmpdir(), "tt-tokenlink-"));
    try {
      const dir = join(base, "tokens");
      const t = loadToken("evidence", {}, "linux", dir);
      assert.match(t, /^[0-9a-f]{48}$/);
      assert.deepEqual(readdirSync(dir), ["evidence.token"]);
      assert.equal(loadToken("evidence", {}, "linux", dir), t);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

// ---- G1 fold-ins (coordinator note 11), in the integration ----

describe("G1 fold-ins: every answer reaches the ledger; a run reset during the awaits commits nothing; begin", () => {
  const codes = (rec: Recorder) => rec.events.map((e) => `${e.kind}${(e.tx as RefusedTransaction).code ? ` ${(e.tx as RefusedTransaction).code}` : ""} ${e.tx.status}`);

  it("a throw that is no ApiError, JournalError or CommitSinkError answers 500 and is a refusal 500 internal (keyed and unkeyed hook, begin)", async () => {
    const rec = new Recorder();
    const backend = await startBackend({ token: TOKEN, port: 0, sinks: [rec], faults: { async beforeCommit() { throw new Error("hook broke"); } } });
    try {
      const api = new Rest(backend.url, TOKEN);
      assert.equal((await api.send("POST", "/tickets", { project: "inbox", title: "a" })).status, 500);
      assert.equal((await api.send("POST", "/tickets", { project: "inbox", title: "b" }, { "idempotency-key": "internal-key-0001" })).status, 500);
      assert.deepEqual(codes(rec), ["refusal internal 500", "refusal internal 500"]);
      assert.equal((await api.export()).tickets.length, 0);
    } finally {
      await backend.close();
    }
    const log: string[] = [];
    const rec2 = new Recorder();
    const b = await inflightBackend(log, { sinks: [rec2], beginThrows: true });
    try {
      const r = await new Rest(b.backend.url, TOKEN).send("POST", "/tickets", { project: "inbox", title: "c" }, { "idempotency-key": "internal-key-0002" });
      assert.equal(r.status, 500);
      assert.deepEqual(codes(rec2), ["refusal internal 500"]);
      assert.deepEqual(log, ["begin internal-key-0002"], "a begin that threw left no pending record of its own: no abort");
    } finally {
      await b.close();
    }
  });

  for (const keyed of [false, true]) {
    it(`without a pending-record seam, a ${keyed ? "keyed" : "unkeyed"} write held at before-commit while its run is reset is refused 409 run_reset and applies nothing`, async () => {
      const rec = new Recorder();
      let release!: () => void;
      let arrived!: () => void;
      const atHook = new Promise<void>((r) => { arrived = r; });
      const backend = await startBackend({
        token: TOKEN, port: 0, sinks: [rec], runOwner: () => "p-default",
        faults: { async beforeCommit({ meta }) { if (meta.attribution.run === "run-held") { arrived(); await new Promise<void>((r) => { release = r; }); } } },
      });
      try {
        const api = new Rest(backend.url, TOKEN);
        const headers: Record<string, string> = { "tiny-tracker-run": "run-held", ...(keyed ? { "idempotency-key": "reset-key-0001" } : {}) };
        const held = api.send("POST", "/tickets", { project: "inbox", title: "held" }, headers);
        await atHook;
        backend.dropRun({ principal: "p-default" }, "run-held");
        release();
        const r = await held;
        assert.deepEqual([r.status, r.body.error], [409, "run_reset"]);
        assert.equal((await api.export()).tickets.length, 0, "nothing applied after the reset");
        assert.deepEqual(codes(rec), ["commit 200", "refusal run_reset 409"], "the reset's commit, then the refusal");
        // The next write in the same run (no reset meanwhile) commits.
        assert.equal((await api.send("POST", "/tickets", { project: "inbox", title: "after" }, { "tiny-tracker-run": "run-other" })).status, 201);
      } finally {
        await backend.close();
      }
    });
  }

  it("an untagged write to a ticket whose run is reset while it waits is refused 409 run_reset, even under lost-update (fold-in 5)", async () => {
    const rec = new Recorder();
    let release!: () => void;
    let arrived!: () => void;
    let holdNext = false;
    const atHook = new Promise<void>((r) => { arrived = r; });
    const backend = await startBackend({
      token: TOKEN, port: 0, sinks: [rec], runOwner: () => "p-default", defects: ["lost-update"],
      faults: { async beforeCommit() { if (holdNext) { holdNext = false; arrived(); await new Promise<void>((r) => { release = r; }); } } },
    });
    try {
      const api = new Rest(backend.url, TOKEN);
      const t = (await api.send("POST", "/tickets", { project: "inbox", title: "owned" }, { "tiny-tracker-run": "run-owner" })).body.ticket;
      holdNext = true;
      const held = api.send("PATCH", `/tickets/${t.id}`, { title: "written back" }, { "if-match": `"${t.version}"` });
      await atHook;
      backend.dropRun({ principal: "p-default" }, "run-owner");
      release();
      const r = await held;
      assert.deepEqual([r.status, r.body.error], [409, "run_reset"]);
      assert.equal((await api.export()).tickets.length, 0, "the reset run's ticket did not come back");
    } finally {
      await backend.close();
    }
  });
});
