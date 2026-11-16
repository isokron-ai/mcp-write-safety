// The backend is the "platform" here and must be correct on its own: these
// tests call its REST API directly.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { startBackend, type RunningBackend } from "../src/start.js";
import { Rest } from "./support/stack.js";

describe("backend REST API", () => {
  let backend: RunningBackend;
  let api: Rest;
  before(async () => {
    backend = await startBackend({ token: "mwscanary-backend-test" });
    api = new Rest(backend.url, "mwscanary-backend-test");
    await api.createProject("p1");
  });
  after(() => backend.close());

  it("refuses a request without the bearer token", async () => {
    assert.equal((await new Rest(backend.url, "wrong").send("GET", "/projects")).status, 401);
  });

  it("serves the version as ETag and refuses a stale If-Match with the current ticket", async () => {
    const t = await api.createTicket({ project: "p1", title: "a" });
    const read = await api.send("GET", `/tickets/${t.id}`);
    assert.equal(read.headers.get("etag"), '"1"');
    await api.patch(t.id, { title: "b" });
    const stale = await api.send("PATCH", `/tickets/${t.id}`, { priority: 5 }, { "if-match": '"1"' });
    assert.equal(stale.status, 412);
    assert.equal(stale.body.current.version, 2);
  });

  it("PATCH changes only the fields sent and does not bump the version for a no-op", async () => {
    const t = await api.createTicket({ project: "p1", title: "a", assignee: "ana", priority: 2 });
    const r = await api.send("PATCH", `/tickets/${t.id}`, { title: "b" });
    assert.deepEqual(r.body.changed, ["title"]);
    assert.equal(r.body.ticket.assignee, "ana");
    const noop = await api.send("PATCH", `/tickets/${t.id}`, { title: "b" });
    assert.equal(noop.body.ticket.version, r.body.ticket.version);
  });

  it("answers a re-sent conditional write as a replay", async () => {
    const t = await api.createTicket({ project: "p1", title: "a" });
    await api.send("PATCH", `/tickets/${t.id}`, { priority: 4 }, { "if-match": '"1"' });
    const again = await api.send("PATCH", `/tickets/${t.id}`, { priority: 4 }, { "if-match": '"1"' });
    assert.equal(again.status, 200);
    assert.equal(again.headers.get("idempotent-replayed"), "true");
    assert.equal(again.body.ticket.version, 2);
  });

  it("needs If-Match (or force=true) for a full replace", async () => {
    const t = await api.createTicket({ project: "p1", title: "a" });
    const body = { title: "x", status: "open", assignee: null, priority: 3 };
    assert.equal((await api.send("PUT", `/tickets/${t.id}`, body)).status, 428);
    assert.equal((await api.send("PUT", `/tickets/${t.id}?force=true`, body)).status, 200);
  });

  it("applies a keyed POST once and refuses the key for a different request", async () => {
    const h = { "idempotency-key": "key-backend-1" };
    const a = await api.send("POST", "/tickets", { project: "p1", title: "keyed" }, h);
    const b = await api.send("POST", "/tickets", { project: "p1", title: "keyed" }, h);
    assert.equal(b.headers.get("idempotent-replayed"), "true");
    assert.equal(b.body.ticket.id, a.body.ticket.id);
    const c = await api.send("POST", "/tickets", { project: "p1", title: "other" }, h);
    assert.equal(c.status, 422);
    assert.equal(c.body.error, "idempotency_key_reused");
  });

  it("applies a batch all-or-nothing", async () => {
    const t = await api.createTicket({ project: "p1", title: "batch" });
    const r = await api.send("POST", "/batch", { ops: [
      { op: "patch", id: t.id, set: { status: "closed" } },
      { op: "patch", id: "T-999999", set: { status: "closed" } },
    ] });
    assert.equal(r.status, 404);
    assert.equal(r.body.index, 1);
    assert.equal((await api.ticket(t.id)).status, "open");
  });

  it("refuses to create a project whose key exists, and to delete a project with tickets", async () => {
    assert.equal((await api.send("POST", "/projects", { key: "p1", name: "again" })).status, 409);
    assert.equal((await api.send("DELETE", "/projects/p1")).status, 409);
  });
});
