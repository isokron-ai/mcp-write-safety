// 0.3.0 integration (G2): the durable store under `tiny-tracker all --supervise`.
// Stream D's journal and stream E's supervisor meet here: the backend child is
// restarted on the same --data-dir, so its lock must be taken over from the
// dead child; key records, execution records, run allocations and fences come
// back from the journal; crash points are armed on the control listener
// (stream B's controller) into the supervisor's arming store. Every listener
// binds port 0; the supervisor keeps the port a child first bound.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSupervisor, type Supervisor } from "../src/supervisor.js";
import { alive, JOURNAL_FILE, LOCK_FILE, readJournal } from "../src/backend/journal.js";
import { CRASH_POINTS } from "../src/fixture/process.js";
import { Rest } from "./support/stack.js";
import { CLI } from "./support/cli-run.js";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CHECK = fileURLToPath(new URL("../../verify/python/check_schemas.py", import.meta.url));
const jsonschema = spawnSync("python3", ["-I", "-c", "import jsonschema, referencing"], { encoding: "utf8" }).status === 0;

const BACKEND = "backend-token-durable-sup-000000";
const EVIDENCE = "evidence-token-durable-sup-00000";
const CONTROL = "control-token-durable-sup-000000";
const ENV = { PATH: process.env.PATH ?? "", TRACKER_BACKEND_TOKEN: BACKEND, TRACKER_EVIDENCE_TOKEN: EVIDENCE, TRACKER_CONTROL_TOKEN: CONTROL };
const FEATURES = "evidence,strict-input,ledger,faults,durable,inflight,retention";

async function call(method: string, url: string, token: string, body?: unknown) {
  const res = await fetch(url, {
    method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

async function lost(p: Promise<unknown>): Promise<void> {
  await assert.rejects(p, (e: Error) => e instanceof TypeError && /fetch failed/.test(e.message), "the connection ends without an answer");
}

const keyed = (key: string, run?: string) => ({ "idempotency-key": key, ...(run ? { "tiny-tracker-run": run } : {}) });

describe("the data-dir lock and a dead supervised child (stream E's note)", () => {
  it("a zombie lock holder (killed, not yet reaped) is not alive; a running one is", () => {
    const root = mkdtempSync(join(tmpdir(), "tt-proc-"));
    try {
      // The test's own pid answers kill(pid, 0); the fake /proc says what state it is in.
      mkdirSync(join(root, String(process.pid)));
      writeFileSync(join(root, String(process.pid), "stat"), `${process.pid} (node (x) y) Z 1 2 3\n`);
      assert.equal(alive(process.pid, root), false, "state Z: a zombie holds nothing");
      writeFileSync(join(root, String(process.pid), "stat"), `${process.pid} (node) S 1 2 3\n`);
      assert.equal(alive(process.pid, root), true);
      assert.equal(alive(process.pid, join(root, "none")), true, "no /proc: kill(pid, 0) decides");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("tiny-tracker all --supervise with durable (G2 restart tests)", () => {
  async function supervised(fn: (sup: Supervisor, first: any, dataDir: string) => Promise<void>, extra: string[] = []) {
    const dir = mkdtempSync(join(tmpdir(), "tt-dsup-"));
    const dataDir = join(dir, "data");
    const lines: Record<string, unknown>[] = [];
    const sup = await startSupervisor({
      cli: CLI, env: ENV, onLine: (l) => void lines.push(l), onStderr: () => {},
      args: ["--features", FEATURES, "--fixture-control", "--data-dir", dataDir, "--port", "0", "--backend-port", "0", "--control-port", "0", ...extra],
    });
    try {
      await fn(sup, lines[0], dataDir);
    } finally {
      await sup.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("crash at backend/after-commit, armed on the control listener: the restarted child takes over the lock; keys, executions and runs survive; the retry replays", async () => {
    await supervised(async (sup, first, dataDir) => {
      const api = new Rest(first.backend, BACKEND);
      const run = (await call("POST", `${first.control}/_fixture/runs`, CONTROL, { label: "g2" })).body.run_id as string;
      assert.match(run, /^run-[0-9a-f]{8}-[0-9a-f]{12}$/);
      const a = await api.send("POST", "/tickets", { project: "inbox", title: "a" }, keyed("dsup-key-00001", run));
      assert.equal(a.status, 201);
      let d = (await call("GET", `${first.backend}/build`, EVIDENCE)).body;
      assert.deepEqual(d.durability, { mode: "journal", journal_format: "journal-format/1" });
      assert.match(d.journal.head, /^\d+:[0-9a-f]{16}$/, "the journal head is filled");
      const headBefore = d.journal.head;

      const armed = await call("POST", `${first.control}/_fixture/faults`, CONTROL, { point: CRASH_POINTS.backendAfterCommit, selector: { once: true } });
      assert.equal(armed.status, 201, JSON.stringify(armed.body));
      d = (await call("GET", `${first.backend}/build`, EVIDENCE)).body;
      assert.deepEqual(d.faults.armed, [`S-1 ${CRASH_POINTS.backendAfterCommit} {"once":true}`]);
      const deadPid = sup.pids.backend!;
      await lost(api.send("POST", "/tickets", { project: "inbox", title: "b" }, keyed("dsup-key-00002", run)));
      const second = await sup.restarted("backend", 1) as any;
      assert.equal(second.backend, first.backend, "same URL");
      const lock = JSON.parse(readFileSync(join(dataDir, LOCK_FILE), "utf8"));
      assert.equal(lock.pid, sup.pids.backend, "the new child holds the lock");
      assert.notEqual(lock.pid, deadPid);

      d = (await call("GET", `${first.backend}/build`, EVIDENCE)).body;
      assert.equal(d.process.restart_count, 1);
      assert.equal(d.supervision.role, "backend");
      assert.equal(d.supervision.children.backend.restart_count, 1);
      // The supervised, durable descriptor validates (the schema's `supervision` member; 0.3.0 integration).
      if (jsonschema || process.env.TT_GATE === "1") {
        const check = spawnSync("python3", ["-I", CHECK, "--instance", "build-descriptor"], { input: JSON.stringify(d), encoding: "utf8" });
        assert.equal(check.status, 0, check.stdout + check.stderr);
      }
      assert.equal(d.process.boot_id, second.supervise.boot_ids.backend);
      assert.notEqual(d.journal.head, headBefore, "the crashed write's commit line is in the journal");
      assert.deepEqual(d.faults.armed, [], "consumed before the process stopped");

      // The write that crashed after its commit was applied once; its retry replays it.
      const retry = await api.send("POST", "/tickets", { project: "inbox", title: "b" }, keyed("dsup-key-00002", run));
      assert.equal(retry.status, 201);
      assert.equal(retry.headers.get("idempotent-replayed"), "true");
      assert.equal(retry.headers.get("tiny-tracker-execution"), "X-2");
      const again = await api.send("POST", "/tickets", { project: "inbox", title: "a" }, keyed("dsup-key-00001", run));
      assert.deepEqual([again.status, again.headers.get("idempotent-replayed"), again.body], [201, "true", a.body], "a key from before the restart replays byte for byte");
      assert.deepEqual((await api.export()).tickets.map((t) => t.title), ["a", "b"]);

      // Execution records and operation records answer for commits made before the restart.
      const x1 = await call("GET", `${first.backend}/executions/X-1`, EVIDENCE);
      assert.equal(x1.status, 200);
      assert.equal(x1.body.boot_id, first.supervise.boot_ids.backend, "the record keeps the boot it was made in");
      const op = await call("GET", `${first.backend}/operations/dsup-key-00002`, EVIDENCE);
      assert.equal(op.status, 200);

      // The run allocated before the restart is still owned (run-alloc line): tagged writes and its reset work.
      const runs = (await call("GET", `${first.control}/_fixture/runs`, CONTROL)).body.runs as Array<{ run_id: string }>;
      assert.deepEqual(runs.map((r) => r.run_id), [run]);
      const tagged = await api.send("POST", "/tickets", { project: "inbox", title: "c" }, keyed("dsup-key-00003", run));
      assert.equal(tagged.status, 201, JSON.stringify(tagged.body));
      const reset = await call("POST", `${first.control}/_fixture/runs/${run}/reset`, CONTROL, {});
      assert.equal(reset.status, 200, JSON.stringify(reset.body));
      assert.deepEqual((await api.export()).tickets, []);

      const kinds = readJournal(join(dataDir, JOURNAL_FILE)).lines.map((l) => l.line);
      assert.ok(kinds.includes("run-alloc"), kinds.join(","));
    });
  });

  // G2 fold-in 11: key-record-after-effect seen from outside the process. The point fires between a keyed write's effect
  // and its key record; the correct build keeps the record in the same journal line, the defect keeps it after.
  for (const defect of [null, "key-record-after-effect"] as const) {
    it(`crash at backend/after-effect-before-key, armed on the control listener: ${defect ? "under key-record-after-effect the retry applies a second time" : "the correct build replays the retry"}`, async () => {
      await supervised(async (sup, first) => {
        const api = new Rest(first.backend, BACKEND);
        // An unkeyed write does not reach the point.
        const armed = await call("POST", `${first.control}/_fixture/faults`, CONTROL, { point: CRASH_POINTS.backendAfterEffectBeforeKey, selector: { once: true } });
        assert.equal(armed.status, 201, JSON.stringify(armed.body));
        assert.equal((await api.send("POST", "/tickets", { project: "inbox", title: "plain" })).status, 201, "an unkeyed write passes the point");
        await lost(api.send("POST", "/tickets", { project: "inbox", title: "keyed" }, keyed("dsup-aeff-0001")));
        await sup.restarted("backend", 1);
        const d = (await call("GET", `${first.backend}/build`, EVIDENCE)).body;
        assert.deepEqual(d.faults.armed, [], "consumed");
        const retry = await api.send("POST", "/tickets", { project: "inbox", title: "keyed" }, keyed("dsup-aeff-0001"));
        assert.equal(retry.status, 201);
        const titles = (await api.export()).tickets.map((t) => t.title);
        if (defect) {
          assert.equal(retry.headers.get("idempotent-replayed"), null, "the key record was lost with the process");
          assert.deepEqual(titles, ["plain", "keyed", "keyed"], "the defect, seen from outside: two tickets for one key");
        } else {
          assert.equal(retry.headers.get("idempotent-replayed"), "true");
          assert.deepEqual(titles, ["plain", "keyed"], "one effect");
        }
      }, defect ? ["--backend-defect", defect] : []);
    });
  }

  it("a real SIGKILL of the backend child: the next child takes over the lock, the store is whole; a before-commit crash leaves an orphan the next start aborts", async () => {
    await supervised(async (sup, first, dataDir) => {
      const api = new Rest(first.backend, BACKEND);
      assert.equal((await api.send("POST", "/tickets", { project: "inbox", title: "k" }, keyed("dsup-kill-0001"))).status, 201);
      process.kill(sup.pids.backend!, "SIGKILL");
      await sup.restarted("backend", 1);
      assert.equal((await api.send("POST", "/tickets", { project: "inbox", title: "k" }, keyed("dsup-kill-0001"))).headers.get("idempotent-replayed"), "true");

      // backend/before-commit/crash: after the pending line, before the section. Nothing applied; at the next start
      // the pending line is ended `aborted orphan_at_start`, so the key is free again (not in_progress, not fenced).
      assert.equal((await call("POST", `${first.control}/_fixture/faults`, CONTROL, { point: CRASH_POINTS.backendBeforeCommit })).status, 201);
      await lost(api.send("POST", "/tickets", { project: "inbox", title: "p" }, keyed("dsup-kill-0002")));
      await sup.restarted("backend", 2);
      const lines = readJournal(join(dataDir, JOURNAL_FILE)).lines as any[];
      const pending = lines.find((l) => l.line === "pending" && l.key === "dsup-kill-0002");
      assert.ok(pending);
      assert.ok(lines.some((l) => l.line === "aborted" && l.pending_jseq === pending.jseq && l.reason === "orphan_at_start"));
      const retry = await api.send("POST", "/tickets", { project: "inbox", title: "p" }, keyed("dsup-kill-0002"));
      assert.equal(retry.status, 201);
      assert.equal(retry.headers.get("idempotent-replayed"), null, "nothing was applied before: this is the first effect");
      assert.deepEqual((await api.export()).tickets.map((t) => t.title), ["k", "p"]);
    });
  });
});
