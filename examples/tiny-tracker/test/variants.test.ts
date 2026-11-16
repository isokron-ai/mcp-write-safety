// The honest key store (TRACKER_VARIANTS=key-store-honest): keys kept by the server itself, with a journal of used
// keys that survives a restart. Correct, not a defect: a create is never applied twice, and after a restart a repeat
// is refused with an error that says the earlier result was not kept and nothing was written.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, startServer } from "../src/start.js";
import { startStack, type Stack } from "./support/stack.js";

describe("variant key-store-honest", () => {
  let dir: string;
  let stack: Stack;
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "tt-journal-"));
    stack = await startStack({ env: { TRACKER_VARIANTS: "key-store-honest", TRACKER_KEY_JOURNAL: join(dir, "keys") } });
    await stack.rest.createProject(stack.prefix("honest"));
  });
  after(async () => {
    await stack.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("answers a repeat in the same process from its record, and refuses a reused key with other arguments", async () => {
    const p = stack.prefix("honest");
    const mcp = await stack.connect();
    const a = await mcp.call("create_ticket", { project: p, title: `${p} one`, idempotency_key: "k-honest-1" });
    const b = await mcp.call("create_ticket", { project: p, title: `${p} one`, idempotency_key: "k-honest-1" });
    assert.equal(a.isError, false);
    assert.equal(b.structured.replayed, true);
    assert.equal(b.structured.id, a.structured.id);
    assert.equal((await stack.rest.tickets({ title_prefix: `${p} one` })).length, 1);
    const c = await mcp.call("create_ticket", { project: p, title: `${p} other`, idempotency_key: "k-honest-1" });
    assert.equal(c.isError, true);
  });

  it("after a restart, a journalled key is refused: the result was not kept and nothing is written", async () => {
    const p = stack.prefix("honest");
    const mcp = await stack.connect();
    await mcp.call("create_ticket", { project: p, title: `${p} two`, idempotency_key: "k-honest-2" });
    const again = await stack.restart();
    const r = await again.call("create_ticket", { project: p, title: `${p} two`, idempotency_key: "k-honest-2" });
    assert.equal(r.isError, true);
    assert.match(r.text, /not kept/);
    assert.match(r.text, /nothing was written/);
    assert.doesNotMatch(r.text, /\b(earlier|previous) call[^.]*\b(failed|was not applied)/);
    assert.equal((await stack.rest.tickets({ title_prefix: `${p} two` })).length, 1);
    // A new key is a new write.
    const n = await again.call("create_ticket", { project: p, title: `${p} two`, idempotency_key: "k-honest-3" });
    assert.equal(n.isError, false);
    assert.equal((await stack.rest.tickets({ title_prefix: `${p} two` })).length, 2);
  });

  it("after a lost backend answer, the repeat says the outcome is not known and writes nothing", async () => {
    const p = stack.prefix("honest");
    const mcp = await stack.connect();
    const cut = stack.gate.cutNext((r) => r.method === "POST" && r.path === "/tickets");
    await mcp.call("create_ticket", { project: p, title: `${p} lost`, idempotency_key: "k-honest-4" });
    await cut;
    const r = await mcp.call("create_ticket", { project: p, title: `${p} lost`, idempotency_key: "k-honest-4" });
    assert.equal(r.isError, true);
    assert.match(r.text, /not known/);
    assert.equal((await stack.rest.tickets({ title_prefix: `${p} lost` })).length, 1);
  });

  it("fails closed: an unknown variant, or the variant without its journal, does not start", async () => {
    await assert.rejects(startServer({ env: { TRACKER_BACKEND_URL: "http://127.0.0.1:9", TRACKER_BACKEND_TOKEN: "x", TRACKER_VARIANTS: "nope" } }), ConfigError);
    await assert.rejects(startServer({ env: { TRACKER_BACKEND_URL: "http://127.0.0.1:9", TRACKER_BACKEND_TOKEN: "x", TRACKER_VARIANTS: "key-store-honest" } }), ConfigError);
  });
});
