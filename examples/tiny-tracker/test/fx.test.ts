// The 0.2.0 evidence core (stream A): execution records (FX-DIG), lookup by
// idempotency key (FX-LOOK), principals in every record and two-token scoping
// (rule 7), attribution outside the handlers reaching the records (rule 3),
// the run-scoped reset (Store.dropRun), the read side (EvidenceSource), and
// the FX defect harness: each fixture defect trips its own FX- property and
// only the overlaps BUILT_FIXTURE_DEFECTS lists (the FX counterpart of the
// self-test's ALSO_TRIPS).
//
// Ports: port 0 (assigned by the OS) everywhere, the command-line runs included.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalize, digestOf, DOMAINS, fingerprintHash, verifyServed } from "../src/digest.js";
import { META_KEYS } from "../src/fixture-properties.js";
import { startBackend, startServer, type RunningBackend } from "../src/start.js";
import { BUILT_FIXTURE_DEFECTS, placementMap } from "../src/defect-placement.js";
import { BACKEND_DEFECTS } from "../src/backend/defects/index.js";
import { DEFECTS, resolveDefects } from "../src/defects/index.js";
import { checkCompat, type Combination } from "../src/compat.js";
import { parsePrincipals } from "../src/principals.js";
import { RECORD_FIELDS, type ExecutionRecord, type OperationRecord } from "../src/records.js";
import { EXECUTION_HEADER } from "../src/backend/execution.js";
import { NO_RECORD } from "../src/backend/lookup.js";
import { createBuild } from "../src/mcp/build.js";
import { connectClient, Rest } from "./support/stack.js";
import { runCli } from "./support/cli-run.js";

const ALICE = "alice-token-fx-000000000000";
const BOB = "bob-token-fx-0000000000000000";
const PRINCIPALS = parsePrincipals(JSON.stringify({ principals: [{ id: "p-alice", token: ALICE }, { id: "p-bob", token: BOB }] }));
const FEATURES = ["execution-records", "lookup", "principals"] as const;
const XH = EXECUTION_HEADER.toLowerCase();

const CHECK = new URL("../../verify/python/check_schemas.py", import.meta.url).pathname;
const jsonschema = spawnSync("python3", ["-I", "-c", "import jsonschema, referencing"], { encoding: "utf8" }).status === 0;
/** TT_GATE=1: a missing jsonschema fails the schema test instead of skipping it (as in test/schemas.test.ts). */
const needJsonschema = jsonschema || process.env.TT_GATE === "1" ? false : "the Python jsonschema package is not installed";

async function backendWith(opts: { defects?: string[]; features?: readonly string[] } = {}): Promise<RunningBackend> {
  return startBackend({ token: ALICE, port: 0, principals: PRINCIPALS, features: opts.features ?? FEATURES, defects: opts.defects, bootId: "0123456789abcdef" });
}

const keyed = (key: string, extra: Record<string, string> = {}) => ({ "idempotency-key": key, ...extra });

describe("execution records (rule 5, G2; FX-DIG)", () => {
  it("one record per applied write, X-<seq>, with principal, tags, fingerprint hash and the committed result's bytes; refusals and replays take none", async () => {
    const backend = await backendWith();
    try {
      const alice = new Rest(backend.url, ALICE);
      const tags = { "tiny-tracker-run": "run-x-1", "tiny-tracker-operation": "op-x-1" };
      const body = { project: "inbox", title: "first", labels: ["a"] };
      const created = await alice.send("POST", "/tickets", body, keyed("exec-key-0001", tags));
      assert.equal(created.status, 201);
      assert.equal(created.headers.get(XH), "X-1");
      const replay = await alice.send("POST", "/tickets", body, keyed("exec-key-0001"));
      assert.equal(replay.headers.get("idempotent-replayed"), "true");
      assert.equal(replay.headers.get(XH), "X-1", "a replay names the record of the write it answers for");
      const refused = await alice.send("POST", "/tickets", { title: "no project" });
      assert.equal(refused.status, 422);
      assert.equal(refused.headers.get(XH), null);
      const patched = await alice.send("PATCH", `/tickets/${created.body.ticket.id}`, { title: "second" });
      assert.equal(patched.headers.get(XH), "X-2", "the commit sequence counts applied writes only");
      const deleted = await alice.send("DELETE", `/tickets/${created.body.ticket.id}`);
      assert.equal(deleted.status, 204);
      assert.equal(deleted.headers.get(XH), "X-3");

      const r1 = (await alice.send("GET", "/executions/X-1")).body as ExecutionRecord;
      assert.deepEqual(Object.keys(r1), [...RECORD_FIELDS["execution-record"]]);
      assert.equal(r1.record, "execution-record/1");
      assert.equal(r1.id, "X-1");
      assert.equal(r1.seq, 1);
      assert.equal(r1.principal, "p-alice");
      assert.equal(r1.run, "run-x-1");
      assert.equal(r1.operation_tag, "op-x-1");
      assert.equal(r1.boot_id, "0123456789abcdef");
      assert.deepEqual(r1.request, { method: "POST", path: "/tickets", key: "exec-key-0001", fingerprint_hash: fingerprintHash("p-alice", "POST", "/tickets", body) });
      assert.deepEqual(r1.objects, [{ type: "ticket", id: "T-1" }]);
      assert.deepEqual(verifyServed(r1.result), []);
      assert.equal(r1.result.domain, DOMAINS.executionResult);
      assert.equal(r1.result.canonical, canonicalize(created.body), "the bytes of the answer the first call got");
      assert.equal(r1.committed_at, created.body.ticket.created_at, "the commit's one clock read (seams v2)");
      assert.equal(r1.clock_offset_ms, 0);

      const r3 = (await alice.send("GET", "/executions/X-3")).body as ExecutionRecord;
      assert.deepEqual(r3.request, { method: "DELETE", path: "/tickets/T-1", key: null, fingerprint_hash: fingerprintHash("p-alice", "DELETE", "/tickets/T-1", null) });
      assert.equal(r3.result.canonical, "null", "a 204 commits no body");
      assert.equal((await alice.send("GET", "/executions/X-4")).status, 404);
      assert.equal((await alice.send("GET", "/executions/T-1")).status, 404);

      // The read side (EvidenceSource) gives the same records, in commit order.
      assert.deepEqual([...backend.evidence!.executions()].map((x) => x.id), ["X-1", "X-2", "X-3"]);
      assert.deepEqual(backend.store.evidence!.execution("X-1"), r1);
    } finally {
      await backend.close();
    }
  });

  it("an execution record is shown to its own principal only", async () => {
    const backend = await backendWith();
    try {
      await new Rest(backend.url, ALICE).createTicket({ project: "inbox", title: "alice's" });
      const bob = new Rest(backend.url, BOB);
      const r = await bob.send("GET", "/executions/X-1");
      assert.equal(r.status, 404);
      assert.equal(r.body.error, "not_found");
      assert.ok(backend.evidence!.execution("X-1"), "the evidence namespace (evidence token) sees every principal's");
    } finally {
      await backend.close();
    }
  });

  it("with execution records a string that is not well-formed is refused (it could not be hashed); without the feature the 0.1.0 backend is unchanged", async () => {
    const on = await backendWith();
    const off = await startBackend({ token: ALICE, port: 0 });
    try {
      const bad = '{"project":"inbox","title":"bad \\ud800"}';
      const send = (url: string) => fetch(`${url}/tickets`, { method: "POST", headers: { authorization: `Bearer ${ALICE}`, "content-type": "application/json" }, body: bad });
      assert.equal((await send(on.url)).status, 400);
      assert.equal((await send(off.url)).status, 201);
      const plain = new Rest(off.url, ALICE);
      const t = await plain.send("POST", "/tickets", { project: "inbox", title: "x" }, keyed("off-key-00001"));
      assert.equal(t.headers.get(XH), null, "no execution header without the feature");
      assert.equal((await plain.send("GET", "/executions/X-1")).body.error, "no_route");
      assert.equal((await plain.send("GET", "/operations/off-key-00001")).body.error, "no_route");
      assert.equal(off.evidence, undefined);
    } finally {
      await on.close();
      await off.close();
    }
  });

  it("execution records validate against execution-record-1 and operation records against operation-record-1 (python3 jsonschema)", { skip: needJsonschema }, async () => {
    assert.ok(jsonschema, "TT_GATE=1 needs python3 with jsonschema and referencing");
    const backend = await backendWith();
    try {
      const alice = new Rest(backend.url, ALICE);
      await alice.send("POST", "/tickets", { project: "inbox", title: "schema", comment: "c" }, keyed("schema-key-0001", { "tiny-tracker-run": "run-s-1" }));
      await alice.send("POST", "/projects", { key: "schema-p", name: "S" });
      for (const [name, path] of [["execution-record", "/executions/X-1"], ["execution-record", "/executions/X-2"], ["operation-record", "/operations/schema-key-0001"]] as const) {
        const body = (await alice.send("GET", path)).body;
        const r = spawnSync("python3", ["-I", CHECK, "--instance", name], { input: JSON.stringify(body), encoding: "utf8" });
        assert.equal(r.status, 0, `${path}: ${r.stdout}${r.stderr}`);
      }
    } finally {
      await backend.close();
    }
  });
});

describe("lookup by idempotency key (R2; rule 4; D5)", () => {
  it("GET /operations/:key: the record of exactly that key, in the caller's scope, from any later run; a miss is \"no record of this key now\"", async () => {
    const backend = await backendWith({ features: [...FEATURES, "strict-input"] });
    try {
      const alice = new Rest(backend.url, ALICE);
      const bob = new Rest(backend.url, BOB);
      const body = { project: "inbox", title: "look me up" };
      const created = await alice.send("POST", "/tickets", body, keyed("lookup-key-0001", { "tiny-tracker-run": "run-l-1" }));
      // A later run (or a fresh process) holding only the key.
      const found = await alice.send("GET", "/operations/lookup-key-0001", undefined, { "tiny-tracker-run": "run-l-2" });
      assert.equal(found.status, 200);
      const op = found.body as OperationRecord;
      assert.deepEqual(Object.keys(op), [...RECORD_FIELDS["operation-record"]]);
      const x = (await alice.send("GET", `/executions/${op.execution_id}`)).body as ExecutionRecord;
      assert.deepEqual(op, {
        record: "operation-record/1", key: "lookup-key-0001", principal: "p-alice", run: "run-l-1", state: "completed",
        fingerprint_hash: fingerprintHash("p-alice", "POST", "/tickets", body), created_at: x.committed_at, completed_at: x.committed_at,
        expires_at: null, clock_offset_ms: 0, execution_id: "X-1", result_digest: x.result.digest, status: 201,
      });
      assert.equal(op.result_digest, digestOf(DOMAINS.executionResult, created.body).digest);
      // Scoped by principal: Bob cannot see Alice's key, and his own write with it is his own.
      const miss = await bob.send("GET", "/operations/lookup-key-0001");
      assert.equal(miss.status, 404);
      assert.equal(miss.body.error, "no_record");
      assert.match(miss.body.message, new RegExp(`^${NO_RECORD}; this does not mean nothing was written`));
      assert.doesNotMatch(miss.body.message, /not applied|was not written/);
      assert.equal((await bob.send("POST", "/tickets", body, keyed("lookup-key-0001"))).status, 201);
      assert.equal(((await bob.send("GET", "/operations/lookup-key-0001")).body as OperationRecord).execution_id, "X-2");
      // A malformed key in the path is refused like a malformed key header (strict-input).
      assert.equal((await alice.send("GET", "/operations/short")).body.error, "bad_idempotency_key");
      assert.equal((await alice.send("GET", "/operations/never-used-0001")).status, 404);
      // The read side gives the same record.
      assert.deepEqual(backend.evidence!.operation({ principal: "p-alice" }, "lookup-key-0001"), op);
      assert.equal(backend.evidence!.operation({ principal: "p-alice" }, "never-used-0001"), undefined);
    } finally {
      await backend.close();
    }
  });

  it("a refused first call holds no key and leaves no record (decision 0004)", async () => {
    const backend = await backendWith();
    try {
      const alice = new Rest(backend.url, ALICE);
      assert.equal((await alice.send("POST", "/tickets", { project: "nope", title: "x" }, keyed("refused-key-0001"))).status, 404);
      assert.equal((await alice.send("GET", "/operations/refused-key-0001")).status, 404);
      assert.equal([...backend.evidence!.executions()].length, 0);
    } finally {
      await backend.close();
    }
  });
});

describe("the lookup tools: get_operation and get_execution (G3)", () => {
  it("listed only with the lookup feature, read-only; a found key is reported with its record, a miss as a miss, and neither writes", async () => {
    assert.deepEqual([...createBuild([], []).tools.keys()].length, 16, "the 0.1 tool list");
    const backend = await backendWith();
    const server = await startServer({ env: { TRACKER_BACKEND_URL: backend.url, TRACKER_BACKEND_TOKEN: ALICE }, port: 0, features: FEATURES });
    const mcp = await connectClient(server.url, "2026-07-28");
    try {
      const tools = await mcp.tools();
      assert.equal(tools.length, 18);
      for (const name of ["get_operation", "get_execution"]) {
        const t = tools.find((x) => x.name === name)!;
        assert.deepEqual(t.annotations, { readOnlyHint: true, openWorldHint: false }, name);
      }
      const rest = new Rest(backend.url, ALICE);
      const created = await mcp.call("create_ticket", { title: "via mcp", idempotency_key: "mcp-key-00001" });
      assert.equal(created.isError, false);
      const before = await rest.export();
      const found = await mcp.call("get_operation", { idempotency_key: "mcp-key-00001" });
      assert.equal(found.isError, false);
      assert.equal(found.structured.found, true);
      assert.deepEqual(found.structured.operation, (await rest.send("GET", "/operations/mcp-key-00001")).body);
      assert.match(found.text, /was applied once \(state completed, status 201\), as execution X-1/);
      const x = await mcp.call("get_execution", { id: found.structured.operation.execution_id });
      assert.equal(x.isError, false);
      assert.deepEqual(verifyServed(x.structured.execution.result), []);
      assert.equal(x.structured.execution.result.digest, found.structured.operation.result_digest);
      assert.ok(x.text.includes(x.structured.execution.result.canonical), "the bytes are in the text for a client that forwards only content");
      const miss = await mcp.call("get_operation", { idempotency_key: "mcp-never-0001" });
      assert.equal(miss.isError, false);
      assert.equal(miss.structured.found, false);
      assert.match(miss.text, /^No record of this key now \(idempotency_key "mcp-never-0001"\)\. This does not mean nothing was written/);
      assert.doesNotMatch(miss.text, /not applied|Nothing was written/);
      const xmiss = await mcp.call("get_execution", { id: "X-99" });
      assert.equal(xmiss.isError, true);
      assert.deepEqual(await rest.export(), before, "the lookups wrote nothing");
    } finally {
      await mcp.close();
      await server.close();
      await backend.close();
    }
  });
});

describe("principals (rule 7, G8): two tokens, the principal in every record", () => {
  it("the command line reads TRACKER_BACKEND_TOKENS_FILE: two principals, records and lookups scoped; the MCP server is the first", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tt-fx-principals-"));
    try {
      const file = join(dir, "principals.json");
      writeFileSync(file, JSON.stringify({ principals: [{ id: "p-alice", token: ALICE }, { id: "p-bob", token: BOB }] }));
      chmodSync(file, 0o600);
      const env = { TRACKER_BACKEND_TOKENS_FILE: file };
      const r = await runCli(["all", "--features", FEATURES.join(","), "--port", "0", "--backend-port", "0"], env, async (state) => {
        const mcp = await connectClient(state.mcp, "2026-07-28");
        try {
          await mcp.call("create_ticket", { title: "from mcp", idempotency_key: "cli-key-000001" });
          const alice = new Rest(state.backend, ALICE);
          const bob = new Rest(state.backend, BOB);
          assert.equal(((await alice.send("GET", "/operations/cli-key-000001")).body as OperationRecord).principal, "p-alice");
          assert.equal((await bob.send("GET", "/operations/cli-key-000001")).status, 404);
          const b = await bob.send("POST", "/tickets", { project: "inbox", title: "bob" });
          assert.equal(((await bob.send("GET", `/executions/${b.headers.get(XH)}`)).body as ExecutionRecord).principal, "p-bob");
        } finally {
          await mcp.close();
        }
      });
      assert.equal(r.code, 0, r.stderr);
      assert.ok(![ALICE, BOB].some((t) => r.stdout.includes(t) || r.stderr.includes(t)), "no token is printed");

      // The 0.2.0 default has the principals feature: the file is read with no feature named.
      const byDefault = await runCli(["all", "--port", "0", "--backend-port", "0"], env, async (state) => {
        assert.equal((await new Rest(state.backend, BOB).send("GET", "/tickets")).status, 200);
      });
      assert.equal(byDefault.code, 0, byDefault.stderr);
      const stranger = await runCli(["all", "--features", "principals", "--port", "0", "--backend-port", "0"], { ...env, TRACKER_BACKEND_TOKEN: "stranger-token-000000000000" });
      assert.equal(stranger.code, 2);
      assert.match(stranger.stderr, /must be one of its principals' tokens/);
      const shared = await runCli(["all", "--features", "principals", "--port", "0", "--backend-port", "0"], { ...env, TRACKER_EVIDENCE_TOKEN: BOB });
      assert.equal(shared.code, 2);
      assert.match(shared.stderr, /token and the .* token must differ/);
      chmodSync(file, 0o644);
      const loose = await runCli(["all", "--features", "principals", "--port", "0", "--backend-port", "0"], env);
      assert.equal(loose.code, 2);
      assert.match(loose.stderr, /chmod 600/);
      // Profile 0.1 never reads the file, as 0.1.0 did not.
      const old = await runCli(["all", "--profile", "0.1", "--port", "0", "--backend-port", "0"], env);
      assert.equal(old.code, 0, old.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the compatibility rules: lookup needs execution-records (CMP-20); principals runs where the backend runs (CMP-21)", () => {
    const base: Combination = { layout: "all", profile: "default", features: [], defects: [], backendDefects: [], variants: [], faults: [], fixtureControl: false };
    // The default profile has execution-records, so the rule shows under profile 0.1 (which also refuses any feature).
    assert.match(checkCompat({ ...base, profile: "0.1", features: ["lookup"] }).join(), /lookup feature needs execution-records/);
    assert.deepEqual(checkCompat({ ...base, features: ["lookup"] }), [], "naming lookup under the default is fine");
    assert.deepEqual(checkCompat({ ...base, features: ["lookup", "execution-records", "principals"] }), []);
    assert.match(checkCompat({ ...base, layout: "server", features: ["principals"] }).join(), /principals is a backend feature/);
    assert.deepEqual(checkCompat({ ...base, layout: "server", features: ["execution-records", "lookup"] }), [], "the lookup tools belong to the MCP server");
  });
});

describe("attribution reaches the records, outside every handler (rule 3, B5)", () => {
  const map = placementMap();
  const createPath = Object.entries(map.byDefect)
    .filter(([name, places]) => !name.startsWith("backend:") && places.some((p) => /^tool:(create_ticket|create_project|add_comment)\.handler$/.test(p)))
    .map(([name]) => name);

  it(`every execution record a tagged call makes carries the principal and both tags, with each create-path defect on and with all of them (${createPath.length} defects)`, async () => {
    assert.ok(createPath.length >= 6, createPath.join(", "));
    for (const defects of [[], ...createPath.map((d) => [d]), createPath]) {
      const backend = await backendWith();
      // A defect that needs features (0.3.0: inflight) runs with them.
      const needs = defects.flatMap((d) => [...(DEFECTS.find((x) => x.name === d)?.requires ?? [])]);
      const server = await startServer({ env: { TRACKER_BACKEND_URL: backend.url, TRACKER_BACKEND_TOKEN: BOB }, defects, port: 0, features: [...new Set([...FEATURES, ...needs])], extras: { attribution: true } });
      const mcp = await connectClient(server.url, "2026-07-28");
      try {
        let n = 0;
        for (const [tool, args] of [
          ["create_project", { key: "attr", name: "Attr", idempotency_key: "attr-project-0001" }],
          ["create_ticket", { project: "attr", title: "tagged", idempotency_key: "attr-ticket-0001" }],
          ["create_ticket", { project: "attr", title: "tagged", idempotency_key: "attr-ticket-0001" }],
          ["add_comment", { id: "T-1", body: "c", idempotency_key: "attr-comment-0001" }],
        ] as const) {
          const op = `op-${++n}`;
          const before = [...backend.evidence!.executions()].length;
          await mcp.client.callTool({ name: tool, arguments: args, _meta: { [META_KEYS.run]: "run-attr-1", [META_KEYS.operation]: op } });
          for (const x of [...backend.evidence!.executions()].slice(before)) {
            assert.equal(x.principal, "p-bob", `[${defects.join(",")}] ${tool}`);
            assert.equal(x.run, "run-attr-1", `[${defects.join(",")}] ${tool}: ${x.request.method} ${x.request.path}`);
            assert.equal(x.operation_tag, op, `[${defects.join(",")}] ${tool}: ${x.request.method} ${x.request.path}`);
          }
        }
        assert.ok([...backend.evidence!.executions()].length >= 2, `[${defects.join(",")}] at least the project and one ticket were created`);
      } finally {
        await mcp.close();
        await server.close();
        await backend.close();
      }
    }
  });
});

describe("the run-scoped reset (Store.dropRun, INTERFACES §1.8)", () => {
  it("removes one principal's run: its objects and key records, nothing of another run or another principal's run of the same name", async () => {
    const backend = await backendWith();
    try {
      const alice = new Rest(backend.url, ALICE);
      const bob = new Rest(backend.url, BOB);
      const run1 = { "tiny-tracker-run": "run-1" };
      await alice.send("POST", "/projects", { key: "a-run1", name: "A" }, run1);
      await alice.send("POST", "/tickets", { project: "a-run1", title: "a1" }, keyed("drop-key-a-0001", run1));
      await alice.send("POST", "/tickets", { project: "inbox", title: "a2" }, keyed("drop-key-a-0002", run1));
      await alice.send("POST", "/tickets", { project: "inbox", title: "a3" }, keyed("drop-key-a-0003", { "tiny-tracker-run": "run-2" }));
      await bob.send("POST", "/tickets", { project: "inbox", title: "b1" }, keyed("drop-key-a-0001", run1));
      // Another run's ticket in alice's run-1 project keeps the project.
      await alice.send("POST", "/projects", { key: "a-run1-shared", name: "S" }, run1);
      await alice.send("POST", "/tickets", { project: "a-run1-shared", title: "other run" }, { "tiny-tracker-run": "run-3" });
      assert.deepEqual(backend.store.ownerOf({ type: "ticket", id: "T-1" }), { type: "ticket", id: "T-1", principal: "p-alice", run: "run-1" });
      assert.equal(backend.store.ownerOf({ type: "project", id: "inbox" }), undefined, "the seed has no owner");

      const reset = backend.dropRun({ principal: "p-alice" }, "run-1");
      assert.deepEqual([reset.objects, reset.keys, reset.tx.kind], [3, 2, "run-reset"]);
      const left = await alice.export();
      assert.deepEqual(left.tickets.map((t) => t.title).sort(), ["a3", "b1", "other run"]);
      assert.deepEqual(left.projects.map((p) => p.key).sort(), ["a-run1-shared", "inbox"]);
      assert.equal((await alice.send("GET", "/operations/drop-key-a-0001")).status, 404);
      assert.equal((await alice.send("GET", "/operations/drop-key-a-0003")).status, 200);
      assert.equal((await bob.send("GET", "/operations/drop-key-a-0001")).status, 200, "bob's run-1 is his own");
      // The key is free again for the dropped run's principal; execution records are evidence and stay.
      assert.equal((await alice.send("POST", "/tickets", { project: "inbox", title: "again" }, keyed("drop-key-a-0001"))).status, 201);
      assert.ok(backend.evidence!.execution("X-1"));
      // The reset took a commit sequence number of its own and has no execution record: execution ids skip it.
      assert.equal(backend.evidence!.execution(`X-${reset.tx.seq}`), undefined);
      const again = backend.dropRun({ principal: "p-alice" }, "run-1");
      assert.deepEqual([again.objects, again.keys], [0, 0]);
    } finally {
      await backend.close();
    }
  });
});

describe("evidence reads across principals (INTERFACES §1.4) and container mode", () => {
  it("EvidenceReader.serve: ?principal=<id> required with two principals, the single one by default; every answer names the principal", async () => {
    const two = await backendWith();
    const one = await startBackend({ token: ALICE, port: 0, features: FEATURES });
    try {
      const alice = new Rest(two.url, ALICE);
      const c = await alice.send("POST", "/tickets", { project: "inbox", title: "e" }, keyed("evid-key-00001"));
      const ev = two.evidence!;
      assert.deepEqual(ev.principals, ["p-alice", "p-bob"]);
      const q = (s: string) => new URLSearchParams(s);
      const required = ev.serve("/operations/evid-key-00001", q(""))!;
      assert.equal(required.status, 400);
      assert.equal((required.body as any).error, "principal_required");
      assert.equal((ev.serve("/operations/evid-key-00001", q("principal=p-carol")) as any).body.error, "unknown_principal");
      const op = ev.serve("/operations/evid-key-00001", q("principal=p-alice"))!;
      assert.equal(op.status, 200);
      assert.equal((op.body as OperationRecord).principal, "p-alice");
      const miss = ev.serve("/operations/evid-key-00001", q("principal=p-bob"))!;
      assert.equal(miss.status, 404);
      assert.deepEqual([(miss.body as any).error, (miss.body as any).principal], ["no_record", "p-bob"]);
      assert.match((miss.body as any).message, /^no record of this key now/);
      const x = ev.serve(`/executions/${c.headers.get(XH)}`, q("principal=p-alice"))!;
      assert.equal((x.body as ExecutionRecord).principal, "p-alice");
      // Seams v2.1: optional on an execution id; another principal's or an unconfigured id answers as an unknown id.
      const bobs = ev.serve(`/executions/${c.headers.get(XH)}`, q("principal=p-bob"))!;
      const unknown = ev.serve("/executions/X-999", q(""))!;
      assert.deepEqual([bobs.status, bobs.body], [404, { ...(unknown.body as object), message: (unknown.body as any).message.replace("X-999", c.headers.get(XH)!) }]);
      assert.equal(ev.serve(`/executions/${c.headers.get(XH)}`, q("principal=p-carol"))!.status, 404);
      assert.equal((ev.serve(`/executions/${c.headers.get(XH)}`, q(""))!.body as ExecutionRecord).principal, "p-alice", "no parameter, two principals");
      assert.equal(ev.serve("/ledger", q("")), undefined, "other paths are not the reader's");
      // One principal: the parameter may be left out.
      await new Rest(one.url, ALICE).send("POST", "/tickets", { project: "inbox", title: "e" }, keyed("evid-key-00002"));
      const single = one.evidence!.serve("/operations/evid-key-00002", q(""))!;
      assert.equal(single.status, 200);
      assert.equal((single.body as OperationRecord).principal, "p-default");
    } finally {
      await two.close();
      await one.close();
    }
  });

  it("a re-sent conditional write names the execution record of the write it repeats", async () => {
    const backend = await backendWith();
    try {
      const alice = new Rest(backend.url, ALICE);
      const t = await alice.createTicket({ project: "inbox", title: "c" });
      const first = await alice.send("PATCH", `/tickets/${t.id}`, { title: "d" }, { "if-match": `"${t.version}"` });
      const again = await alice.send("PATCH", `/tickets/${t.id}`, { title: "d" }, { "if-match": `"${t.version}"` });
      assert.equal(again.headers.get("idempotent-replayed"), "true");
      assert.equal(again.headers.get(XH), first.headers.get(XH));
    } finally {
      await backend.close();
    }
  });

  it("TRACKER_EVIDENCE_LISTEN: a second listener with the evidence routes only, behind the evidence token; refused without evidence or with defects off loopback", async () => {
    const env = { TRACKER_BACKEND_TOKEN: ALICE, TRACKER_EVIDENCE_TOKEN: "evidence-token-fx-0000000000", TRACKER_EVIDENCE_LISTEN: "127.0.0.1:0" };
    const r = await runCli(["all", "--features", `evidence,${FEATURES.join(",")}`, "--port", "0", "--backend-port", "0"], env, async (state) => {
      assert.match(state.evidence_listener, /^http:\/\/127\.0\.0\.1:\d+$/);
      const ev = state.evidence_listener as string;
      const get = (path: string, token: string) => fetch(`${ev}${path}`, { headers: { authorization: `Bearer ${token}` } });
      assert.equal((await get("/build", env.TRACKER_EVIDENCE_TOKEN)).status, 200);
      assert.equal((await get("/tickets", ALICE)).status, 404, "the API is not served there, not even with the backend token");
      assert.equal((await get("/build", ALICE)).status, 404);
      assert.equal((await get("/build", "")).status, 404);
      // A published port carries the outside Host: the evidence listener serves it on the evidence token alone (an
      // explicit listener option, the Host header is not rewritten); the loopback API listener still refuses it.
      const withHost = (base: string, host: string) => new Promise<number>((resolve, reject) => {
        const u = new URL(`${base}/build`);
        const q = httpRequest({ host: u.hostname, port: u.port, path: u.pathname, headers: { host, authorization: `Bearer ${env.TRACKER_EVIDENCE_TOKEN}` } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        q.on("error", reject);
        q.end();
      });
      assert.equal(await withHost(ev, "tracker.example:8080"), 200);
      assert.equal(await withHost(state.backend as string, "tracker.example:8080"), 403);
    });
    assert.equal(r.code, 0, r.stderr);
    const noEvidence = await runCli(["all", "--port", "0", "--backend-port", "0"], env);
    assert.equal(noEvidence.code, 2);
    assert.match(noEvidence.stderr, /TRACKER_EVIDENCE_LISTEN needs the evidence feature/);
    const defects = await runCli(["all", "--features", "evidence", "--defect", "read-merge-put", "--port", "0", "--backend-port", "0"], { ...env, TRACKER_EVIDENCE_LISTEN: "0.0.0.0:0" });
    assert.equal(defects.code, 2);
    assert.match(defects.stderr, /keeps every listener on loopback/);
    const bad = await runCli(["all", "--features", "evidence", "--port", "0", "--backend-port", "0"], { ...env, TRACKER_EVIDENCE_LISTEN: "anywhere" });
    assert.equal(bad.code, 2);
  });
});

// ---- the FX defect harness ----

type Verdict = { verdict: "held" | "violated"; detail: string };
const held = (detail = ""): Verdict => ({ verdict: "held", detail });
const violated = (detail: string): Verdict => ({ verdict: "violated", detail });

/** Runs the FX-DIG and FX-LOOK checks (and MWS-ANN-1 for the lookup tools) against one build with the 0.2.0 features on. */
async function fxChecks(opts: { backendDefects?: string[]; defects?: string[] }): Promise<Map<string, Verdict>> {
  const backend = await backendWith({ defects: opts.backendDefects });
  const server = await startServer({ env: { TRACKER_BACKEND_URL: backend.url, TRACKER_BACKEND_TOKEN: ALICE }, defects: opts.defects, port: 0, features: FEATURES });
  const mcp = await connectClient(server.url, "2026-07-28");
  const out = new Map<string, Verdict>();
  const alice = new Rest(backend.url, ALICE);
  const bob = new Rest(backend.url, BOB);
  const exec = async (id: string | null) => (await alice.send("GET", `/executions/${id}`)).body as ExecutionRecord;
  try {
    // FX-DIG-1: the digest is over the result as committed: stable after a later update.
    {
      const c = await alice.send("POST", "/tickets", { project: "inbox", title: "dig one" }, keyed("dig1aaaa-0001"));
      const first = await exec(c.headers.get(XH));
      await alice.send("PATCH", `/tickets/${c.body.ticket.id}`, { title: "dig one changed" });
      const later = await exec(c.headers.get(XH));
      out.set("FX-DIG-1", first.result.digest === later.result.digest && JSON.parse(later.result.canonical).ticket.title === "dig one"
        ? held() : violated(`digest ${first.result.digest.slice(0, 12)} became ${later.result.digest.slice(0, 12)} after an update`));
    }
    // FX-DIG-2: a replay serves the committed result: same record, same bytes, and the operation record's digest agrees.
    {
      const body = { project: "inbox", title: "dig two" };
      const c = await alice.send("POST", "/tickets", body, keyed("dig2bbbb-0001"));
      const again = await alice.send("POST", "/tickets", body, keyed("dig2bbbb-0001"));
      const x = await exec(c.headers.get(XH));
      const op = (await alice.send("GET", "/operations/dig2bbbb-0001")).body as OperationRecord;
      const problems = [
        again.headers.get(XH) !== x.id && "the replay names another record",
        canonicalize(again.body) !== canonicalize(JSON.parse(x.result.canonical)) && "the replay's answer is not the committed result",
        op.result_digest !== x.result.digest && "the operation record's result_digest differs from the execution record's",
      ].filter(Boolean);
      out.set("FX-DIG-2", problems.length ? violated(problems.join("; ")) : held());
    }
    // FX-DIG-3: the served bytes are RFC 8785 and the digest is over them.
    {
      const c = await alice.send("POST", "/tickets", { project: "inbox", title: "dig three", priority: 2, labels: ["z", "a"] });
      const problems = verifyServed((await exec(c.headers.get(XH))).result);
      out.set("FX-DIG-3", problems.length ? violated(problems.join("; ")) : held());
    }
    // FX-LOOK-1: a lookup returns the record of exactly the key asked for.
    {
      const a = await alice.send("POST", "/tickets", { project: "inbox", title: "look one a" }, keyed("look1ccc-0001"));
      await alice.send("POST", "/tickets", { project: "inbox", title: "look one b" }, keyed("look1ccc-0002"));
      const op = (await alice.send("GET", "/operations/look1ccc-0001")).body as OperationRecord;
      out.set("FX-LOOK-1", op.key === "look1ccc-0001" && op.execution_id === a.headers.get(XH)
        ? held() : violated(`asked for look1ccc-0001, got the record of ${op.key} (${op.execution_id})`));
    }
    // FX-LOOK-3: another principal's key is not found.
    {
      await alice.send("POST", "/tickets", { project: "inbox", title: "look three" }, keyed("look3ddd-0001"));
      const r = await bob.send("GET", "/operations/look3ddd-0001");
      out.set("FX-LOOK-3", r.status === 404 ? held() : violated(`bob read alice's record (${r.status}, principal ${r.body?.principal})`));
    }
    // FX-LOOK-2 and MWS-ANN-1 for the lookup tools: looking up never writes.
    {
      const changed: string[] = [];
      for (const [tool, args] of [["get_operation", { idempotency_key: "look2eee-0001" }], ["get_operation", { idempotency_key: "dig2bbbb-0001" }], ["get_execution", { id: "X-1" }], ["get_execution", { id: "X-999" }]] as const) {
        const before = await alice.export();
        await mcp.call(tool, args);
        if (canonicalize(before) !== canonicalize(await alice.export())) changed.push(`${tool} ${JSON.stringify(args)} changed state`);
      }
      out.set("FX-LOOK-2", changed.length ? violated(changed.join("; ")) : held());
      const readOnlyTools = (await mcp.tools()).filter((t) => ["get_operation", "get_execution"].includes(t.name) && t.annotations?.readOnlyHint === true);
      out.set("MWS-ANN-1", changed.length && readOnlyTools.length ? violated(`declared readOnlyHint: true: ${changed.join("; ")}`) : held());
    }
  } finally {
    await mcp.close();
    await server.close();
    await backend.close();
  }
  return out;
}

describe("the FX defect harness: each 0.2.0 fixture defect trips its own property and only the listed overlaps", () => {
  it("the correct build holds every FX-DIG and FX-LOOK property", async () => {
    const r = await fxChecks({});
    for (const [id, v] of r) assert.equal(v.verdict, "held", `${id}: ${v.detail}`);
    assert.equal(r.size, 7);
  });

  it("the built fixture defects are registered where their layer keeps them, with the features they need", async () => {
    for (const d of BUILT_FIXTURE_DEFECTS) {
      const found = d.layer === "backend" ? BACKEND_DEFECTS.find((x) => x.name === d.name) : DEFECTS.find((x) => x.name === d.name);
      assert.ok(found, d.name);
      assert.deepEqual([...(found!.requires ?? [])], [...d.requires], d.name);
      if (d.layer === "backend") {
        assert.deepEqual(d.placement, (found as (typeof BACKEND_DEFECTS)[number]).seams.map((s) => `backend:${s}`), d.name);
        assert.equal((found as (typeof BACKEND_DEFECTS)[number]).context, d.trips[0], d.name);
      } else {
        assert.equal((found as (typeof DEFECTS)[number]).requirement, d.trips.find((t) => t.startsWith("MWS-")), d.name);
        assert.ok(placementMap().byDefect[d.name].every((p) => d.placement.some((q) => p.startsWith(`${q}.`))), d.name);
      }
    }
    assert.equal(BUILT_FIXTURE_DEFECTS.length, 6);
    // --defect all takes the MCP-layer fixture defect only when its feature is on.
    assert.ok(!resolveDefects(["all"]).some((d) => d.name === "lookup-reexecutes"));
    assert.ok(resolveDefects(["all"], FEATURES).some((d) => d.name === "lookup-reexecutes"));
    await assert.rejects(startBackend({ token: ALICE, port: 0, defects: ["lookup-unscoped"], features: ["execution-records", "lookup"] }), /needs the feature\(s\) principals/);
  });

  for (const d of BUILT_FIXTURE_DEFECTS) {
    it(`${d.layer === "backend" ? "--backend-defect" : "--defect"} ${d.name}: trips ${d.trips.join(" and ")}, nothing else`, async () => {
      const r = await fxChecks(d.layer === "backend" ? { backendDefects: [d.name] } : { defects: [d.name] });
      const tripped = [...r].filter(([, v]) => v.verdict === "violated").map(([id]) => id).sort();
      assert.deepEqual(tripped, [...d.trips].sort(), [...r].map(([id, v]) => `${id} ${v.verdict} ${v.detail}`).join("\n"));
    });
  }

  it("with all of them on, every FX-DIG and FX-LOOK property is violated (no fixture defect hides another)", async () => {
    const r = await fxChecks({
      backendDefects: BUILT_FIXTURE_DEFECTS.filter((d) => d.layer === "backend").map((d) => d.name),
      defects: BUILT_FIXTURE_DEFECTS.filter((d) => d.layer === "mcp").map((d) => d.name),
    });
    const hidden = [...r].filter(([, v]) => v.verdict !== "violated").map(([id]) => id);
    assert.deepEqual(hidden, []);
  });

  it("docs/streams/A.md lists every built fixture defect with what it trips", () => {
    const doc = readFileSync(new URL("../../docs/streams/A.md", import.meta.url), "utf8");
    for (const d of BUILT_FIXTURE_DEFECTS) assert.ok(doc.includes(`| \`${d.name}\` | ${d.trips.join(", ")} |`), d.name);
  });
});

// ---- integration: the MCP answer to the seams v2.1 keyed-path refusals ----

describe("the MCP layer's answer to 409 in_progress and 409 key_fenced (seams v2.1, rule 4)", () => {
  it("in_progress is outcome unknown, repeat with the same key; key_fenced is not_applied", async () => {
    const { fromBackend } = await import("../src/mcp/results.js");
    const w = { operation: "create", type: "ticket", guard: "key" as const, read: { tool: "list_tickets", arguments: {} } };
    const pending = fromBackend({ status: 409, body: { error: "in_progress", message: "still running", since: "2030-01-01T00:00:00.000Z" } } as any, "the ticket", w);
    const pm = (pending.structuredContent as any).mws;
    assert.equal(pending.isError, true);
    assert.deepEqual([pm.outcome, pm.repeat, pm.code], ["unknown", "same_key", "in_progress"]);
    assert.doesNotMatch((pending.content[0] as any).text, /Nothing was written/);
    const fenced = fromBackend({ status: 409, body: { error: "key_fenced", message: "run reset" } } as any, "the ticket", w);
    const fm = (fenced.structuredContent as any).mws;
    assert.deepEqual([fm.outcome, fm.code], ["not_applied", "key_fenced"]);
    assert.match((fenced.content[0] as any).text, /Nothing was written/);
  });
});

describe("create_project answers only the duplicate check as 'already exists' (G1 review, fold-in 3)", () => {
  it("409 exists is already_exists; 409 in_progress, key_fenced and run_reset keep their own codes", async () => {
    const { createProject } = await import("../src/mcp/tools/projects.js");
    const call = async (body: Record<string, unknown>) => {
      const api = { request: async () => ({ status: 409, ok: false, replayed: false, body }) };
      return (await createProject.handler({ key: "dup", name: "Dup", idempotency_key: "proj-key-0001" } as any, { api } as any, {} as any)) as any;
    };
    const exists = await call({ error: "exists", message: "project dup already exists" });
    assert.deepEqual([exists.structuredContent.mws.outcome, exists.structuredContent.mws.code], ["not_applied", "already_exists"]);
    const pending = await call({ error: "in_progress", message: "still running" });
    assert.deepEqual([pending.structuredContent.mws.outcome, pending.structuredContent.mws.code], ["unknown", "in_progress"]);
    assert.doesNotMatch(pending.content[0].text, /already exists/);
    for (const code of ["key_fenced", "run_reset"]) {
      const r = await call({ error: code, message: code });
      assert.deepEqual([r.structuredContent.mws.outcome, r.structuredContent.mws.code], ["not_applied", code]);
      assert.doesNotMatch(r.content[0].text, /already exists/);
    }
  });
});
