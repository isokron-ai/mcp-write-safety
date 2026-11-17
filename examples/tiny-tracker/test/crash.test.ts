// T1: every write operation, crashed at every point of the durable commit path,
// then started again from its data dir (review T1; decision 0003).
//
// Points, in the order a keyed write meets them (COMMIT_STEPS: pending,
// validate, journal, apply, ledger, reply):
//   pending line   before-append, torn-write, after-fsync (keyed writes under inflight)
//   commit line    before-append, torn-write, after-write (process crash: the line stays),
//                  after-write + power cut (the unflushed line is lost), after-fsync
//   after-commit   the backend/after-commit hook: applied, journalled, unanswered
//
// For each (operation, point): run the same history without a crash for the
// expected state; crash; start again; check that the state is exactly the state
// before or after the operation (atomic), which one the point implies, that the
// journal's commit_seq is contiguous and no pending line is left open, that a
// keyed repeat gives one effect and the first answer's bytes, and that a second
// start reads the same state (replay is stable). The in-process crash leaves the
// journal as a killed process would; a subprocess test kills a real process with
// SIGKILL at the same points and takes over its lock.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, statSync, truncateSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { durableBackend, movableClock, tempDir, TOKEN, type Arm } from "./support/durable.js";
import { JOURNAL_FILE, LOCK_FILE, readJournal } from "../src/backend/journal.js";
import type { Rest } from "./support/stack.js";
import { Rest as RestClient } from "./support/stack.js";
import type { JournalCommitLine } from "../src/backend/commit.js";

type Api = Rest;
interface Op {
  name: string;
  key?: string;
  /** The write under test. */
  run(api: Api, b: { backend: { dropRun: (s: { principal: string }, run: string) => unknown } }): Promise<{ status: number; body?: unknown }>;
}

/** The history every case starts from: a project, two tickets (one in a run), labels and a comment. */
async function setup(api: Api) {
  await api.send("POST", "/projects", { key: "p1", name: "P1" }, { "idempotency-key": "setup-key-0001" });
  await api.send("POST", "/tickets", { project: "p1", title: "one", labels: ["a", "b"], comment: "c" }, { "tiny-tracker-run": "run-x-1" });
  await api.send("POST", "/tickets", { project: "inbox", title: "two" });
}

const OPS: Op[] = [
  { name: "create project (keyed)", key: "op-key-proj-1", run: (api) => api.send("POST", "/projects", { key: "p2", name: "P2" }, { "idempotency-key": "op-key-proj-1" }) },
  { name: "create ticket (keyed, labels, comment)", key: "op-key-tick-1", run: (api) => api.send("POST", "/tickets", { project: "p1", title: "new", labels: ["x"], comment: "hi" }, { "idempotency-key": "op-key-tick-1" }) },
  { name: "create ticket (no key)", run: (api) => api.send("POST", "/tickets", { project: "inbox", title: "plain" }) },
  { name: "PATCH with If-Match", run: (api) => api.send("PATCH", "/tickets/T-1", { title: "renamed", details: { severity: "high" } }, { "if-match": '"1"' }) },
  { name: "PUT with If-Match", run: (api) => api.send("PUT", "/tickets/T-1", { title: "put", status: "closed", assignee: "ana", priority: 2 }, { "if-match": '"1"' }) },
  { name: "DELETE ticket", run: (api) => api.send("DELETE", "/tickets/T-2") },
  { name: "add comment (keyed)", key: "op-key-comm-1", run: (api) => api.send("POST", "/tickets/T-1/comments", { body: "more" }, { "idempotency-key": "op-key-comm-1" }) },
  { name: "add label", run: (api) => api.send("POST", "/tickets/T-1/labels", { name: "z" }) },
  { name: "remove label", run: (api) => api.send("DELETE", "/tickets/T-1/labels/L-1") },
  { name: "batch (patch and delete)", run: (api) => api.send("POST", "/batch", { ops: [{ op: "patch", id: "T-1", set: { labels: ["n1", "n2"] } }, { op: "delete", id: "T-2" }] }) },
  { name: "project upsert (PUT)", run: (api) => api.send("PUT", "/projects/inbox", { name: "Inbox" }) },
  {
    name: "run reset", run: async (_api, b) => {
      try {
        b.backend.dropRun({ principal: "p-default" }, "run-x-1");
        return { status: 200 };
      } catch {
        return { status: 503 };
      }
    },
  },
];

type Point = { name: string; arm?: Arm; powerCut?: boolean; afterCommit?: boolean; keyedOnly?: boolean; applied: boolean };

const POINTS: Point[] = [
  { name: "pending line: before-append", arm: { point: "before-append", line: "pending" }, keyedOnly: true, applied: false },
  { name: "pending line: torn", arm: { point: "torn-write", line: "pending" }, keyedOnly: true, applied: false },
  { name: "pending line: after-fsync", arm: { point: "after-fsync", line: "pending" }, keyedOnly: true, applied: false },
  { name: "commit line: before-append", arm: { point: "before-append", line: "commit" }, applied: false },
  { name: "commit line: torn", arm: { point: "torn-write", line: "commit" }, applied: false },
  { name: "commit line: after-write (process crash)", arm: { point: "after-write", line: "commit" }, applied: true },
  { name: "commit line: after-write (power cut)", arm: { point: "after-write", line: "commit" }, powerCut: true, applied: false },
  { name: "commit line: after-fsync", arm: { point: "after-fsync", line: "commit" }, applied: true },
  { name: "after-commit, before the reply", afterCommit: true, applied: true },
];

async function reference(op: Op) {
  const t = tempDir("ref");
  try {
    const b = await durableBackend({ dataDir: t.dataDir, clock: movableClock() });
    await setup(b.api);
    const before = await b.api.export();
    const reply = await op.run(b.api, b);
    const after = await b.api.export();
    await b.close();
    return { before, after, reply };
  } finally {
    t.cleanup();
  }
}

function checkJournal(dataDir: string) {
  const { lines, tornLast } = readJournal(join(dataDir, JOURNAL_FILE));
  assert.equal(tornLast, false, "a start leaves no torn line");
  const commits = lines.filter((l): l is JournalCommitLine => l.line === "commit").map((l) => l.commit_seq);
  assert.deepEqual(commits, commits.map((_, i) => i + 1), "commit_seq is contiguous from 1");
  const open = new Set<number>();
  for (const l of lines) {
    if (l.line === "pending") open.add(l.jseq);
    if (l.line === "aborted" || l.line === "fence") open.delete(l.pending_jseq);
    if (l.line === "commit" && l.pending_jseq !== null) open.delete(l.pending_jseq);
  }
  assert.deepEqual([...open], [], "no pending line is left open");
}

describe("T1: every write operation crashed at every point of the commit path", () => {
  for (const op of OPS) {
    describe(op.name, () => {
      let ref: Awaited<ReturnType<typeof reference>>;
      for (const point of POINTS) {
        if (point.keyedOnly && !op.key) continue;
        it(`${point.name}: ${point.applied ? "applied" : "not applied"} after the restart`, async () => {
          ref ??= await reference(op);
          const t = tempDir("t1");
          try {
            let crashNow: (() => void) | undefined;
            const b = await durableBackend({
              dataDir: t.dataDir, clock: movableClock(),
              faults: { afterCommit: async () => { if (crashNow) { crashNow(); return "drop"; } return undefined; } },
            });
            await setup(b.api);
            const file = join(t.dataDir, JOURNAL_FILE);
            const sizeBefore = statSync(file).size;
            if (point.arm) b.arm(point.arm);
            if (point.afterCommit) crashNow = () => b.backend.durability!.journal!.abandon();
            await op.run(b.api, b).catch(() => undefined);
            if (point.arm) assert.equal(b.crashes.length, 1, "the crash point was reached");
            await b.crash();
            if (point.powerCut) truncateSync(file, sizeBefore);
            // A process crash leaves its lock file; the next start takes it over.
            assert.ok(readFileSync(join(t.dataDir, LOCK_FILE), "utf8").includes(`"pid":${process.pid}`));
            const b2 = await durableBackend({ dataDir: t.dataDir, clock: movableClock() });
            let after: unknown;
            try {
              after = await b2.api.export();
              assert.deepEqual(after, point.applied ? ref.after : ref.before, "the operation is all or nothing, as the point says");
              if (op.key) {
                // The repeat: one effect, and the first answer's bytes whether it replays or applies now.
                const again = await op.run(b2.api, b2);
                assert.equal(again.status, ref.reply.status);
                assert.deepEqual(again.body, ref.reply.body, "the answer is the first answer, byte for byte");
                assert.deepEqual(await b2.api.export(), ref.after, "one effect");
              }
            } finally {
              await b2.close();
            }
            checkJournal(t.dataDir);
            const b3 = await durableBackend({ dataDir: t.dataDir, clock: movableClock() });
            try {
              assert.deepEqual(await b3.api.export(), op.key ? ref.after : after, "a second start reads the same state");
            } finally {
              await b3.close();
            }
          } finally {
            t.cleanup();
          }
        });
      }
    });
  }
});

describe("T1: a run reset with a pending write in its run, crashed at its fence line (G2 fold-in 5)", () => {
  // The reset's commit line is written, then its fence line for the held write. A crash between them (before-append:
  // fence) used to free the key at the next start (orphan_at_start): 409 key_fenced before the crash, 201 after it.
  for (const point of ["before-append", "torn-write", "after-fsync"] as const) {
    it(`fence line: ${point}: the key stays fenced after the restart, nothing applied, one fence line`, async () => {
      const t = tempDir("t1f");
      try {
        let release!: () => void;
        let reached!: () => void;
        const arrived = new Promise<void>((r) => { reached = r; });
        const gate = new Promise<void>((r) => { release = r; });
        const b = await durableBackend({
          dataDir: t.dataDir, clock: movableClock(),
          faults: { beforeCommit: async ({ meta }) => { if (meta.request.key === "fence-crash-001") { reached(); await gate; } } },
        });
        await setup(b.api);
        const held = b.api.send("POST", "/tickets", { project: "inbox", title: "late" }, { "idempotency-key": "fence-crash-001", "tiny-tracker-run": "run-f-9" });
        await arrived;
        b.arm({ point, line: "fence", key: "fence-crash-001" });
        b.backend.dropRun({ principal: "p-default" }, "run-f-9");
        assert.deepEqual(b.crashes, [`${point}:fence`], "the crash point was reached");
        release();
        const before = await held;
        assert.deepEqual([before.status, (before.body as any).error], [409, "key_fenced"], "fenced before the crash");
        const resetSeq = b.backend.store.lastSeq;
        await b.crash();
        const b2 = await durableBackend({ dataDir: t.dataDir, clock: movableClock() });
        try {
          const report = b2.backend.durability!.journal!.report!;
          assert.equal(report.fencedAtStart, point === "after-fsync" ? 0 : 1);
          assert.equal(report.abortedOrphans, 0, "not an orphan: the reset fenced it");
          const again = await b2.api.send("POST", "/tickets", { project: "inbox", title: "late" }, { "idempotency-key": "fence-crash-001" });
          assert.deepEqual([again.status, again.body.error], [409, "key_fenced"], "still fenced after the restart");
          assert.deepEqual((await b2.api.export()).tickets.map((x) => x.title).filter((x) => x === "late"), [], "nothing applied");
        } finally {
          await b2.close();
        }
        checkJournal(t.dataDir);
        const lines = readJournal(join(t.dataDir, JOURNAL_FILE)).lines as any[];
        const fences = lines.filter((l) => l.line === "fence");
        assert.equal(fences.length, 1, "one fence line");
        const pending = lines.find((l) => l.line === "pending" && l.key === "fence-crash-001");
        assert.deepEqual([fences[0].pending_jseq, fences[0].reset_seq, fences[0].run], [pending.jseq, resetSeq, "run-f-9"]);
        const b3 = await durableBackend({ dataDir: t.dataDir, clock: movableClock() });
        try {
          assert.equal(b3.backend.durability!.journal!.report!.fencedAtStart, 0, "a second start reads the fence line");
          assert.equal((await b3.api.send("POST", "/tickets", { project: "inbox", title: "late" }, { "idempotency-key": "fence-crash-001" })).status, 409);
        } finally {
          await b3.close();
        }
      } finally {
        t.cleanup();
      }
    });
  }
});

describe("T1 in a real process: SIGKILL at a named point, then a start that takes over the lock", () => {
  const child = fileURLToPath(new URL("./support/durable-child.js", import.meta.url));

  async function killAt(point: string, line: string) {
    const t = tempDir("kill");
    try {
      const proc = spawn(process.execPath, [child], { env: { ...process.env, DATA_DIR: t.dataDir, CRASH_POINT: point, CRASH_LINE: line, CRASH_KEY: "kill-key-00001" }, stdio: ["ignore", "pipe", "pipe"] });
      const url = await new Promise<string>((resolve, reject) => {
        let out = "";
        proc.stdout.on("data", (d) => { out += d; const m = /^(http:\S+)\n/m.exec(out); if (m) resolve(m[1]); });
        proc.on("exit", (c) => reject(new Error(`child exited ${c}`)));
      });
      const api = new RestClient(url, TOKEN);
      await api.send("POST", "/tickets", { project: "inbox", title: "before" }, { "idempotency-key": "kill-key-00000" });
      const exited = new Promise<NodeJS.Signals | null>((r) => proc.on("exit", (_c, s) => r(s)));
      const lost = await api.send("POST", "/tickets", { project: "inbox", title: "killed" }, { "idempotency-key": "kill-key-00001" }).then(() => "answered", () => "no answer");
      assert.equal(lost, "no answer");
      assert.equal(await exited, "SIGKILL");
      assert.equal(JSON.parse(readFileSync(join(t.dataDir, LOCK_FILE), "utf8")).pid, proc.pid, "the dead process's lock is still there");
      const b = await durableBackend({ dataDir: t.dataDir, clock: movableClock() });
      try {
        const titles = (await b.api.export()).tickets.map((x) => x.title);
        const report = b.backend.durability!.journal!.report!;
        const again = await b.api.send("POST", "/tickets", { project: "inbox", title: "killed" }, { "idempotency-key": "kill-key-00001" });
        const final = (await b.api.export()).tickets.map((x) => x.title);
        return { titles, report, again, final };
      } finally {
        await b.close();
        checkJournal(t.dataDir);
      }
    } finally {
      t.cleanup();
    }
  }

  it("killed after the commit line is flushed: the write is there and the repeat replays it", async () => {
    const r = await killAt("after-fsync", "commit");
    assert.deepEqual(r.titles, ["before", "killed"]);
    assert.equal(r.again.headers.get("idempotent-replayed"), "true");
    assert.deepEqual(r.final, ["before", "killed"]);
  });

  it("killed after the pending line, before the commit line: nothing applied, the orphan is aborted, the repeat applies once", async () => {
    const r = await killAt("after-fsync", "pending");
    assert.deepEqual(r.titles, ["before"]);
    assert.equal(r.report.abortedOrphans, 1);
    assert.equal(r.again.status, 201);
    assert.equal(r.again.headers.get("idempotent-replayed"), null);
    assert.deepEqual(r.final, ["before", "killed"]);
  });

  it("killed in the middle of writing the commit line: the torn line is dropped", async () => {
    const r = await killAt("torn-write", "commit");
    assert.deepEqual(r.titles, ["before"]);
    assert.equal(r.report.droppedTornLine, true);
    assert.deepEqual(r.final, ["before", "killed"]);
  });
});
