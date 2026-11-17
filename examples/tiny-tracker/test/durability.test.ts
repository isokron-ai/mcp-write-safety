// 0.3.0 durability (stream D): the journal (decision 0003), the data-dir lock
// (G13), in-flight keys (rule 4), retention and tombstones (decision 0004), the
// key fence (B9), the run reset in the journal, and the backend defects that
// show the persistence gap.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { durableBackend, movableClock, tempDir, TOKEN } from "./support/durable.js";
import { readJournal, decodeLine, encodeLine, DataDirError, JournalCorruptError, JOURNAL_FILE, LOCK_FILE, prepareDataDir, lineChecksum, lockHooks } from "../src/backend/journal.js";
import { startBackend } from "../src/start.js";
import { digestOf, DOMAINS, fingerprintHash } from "../src/digest.js";
import { DAY_MS, describeRetention, parseExpiryPolicy, parseRetention, retentionSentence } from "../src/backend/expiry.js";
import type { JournalCommitLine } from "../src/backend/commit.js";

const keyed = (k: string) => ({ "idempotency-key": k });

describe("the journal (decision 0003, INTERFACES 1.9)", () => {
  it("header with the seed, jseq on every line, commit_seq only on commit lines, checksums over RFC 8785 bytes", async () => {
    const t = tempDir("fmt");
    try {
      const b = await durableBackend({ dataDir: t.dataDir, clock: movableClock() });
      await b.api.send("POST", "/tickets", { project: "inbox", title: "a" }, keyed("fmt-key-00001"));
      await b.api.send("PATCH", "/tickets/T-1", { title: "b" });
      await b.close();
      const { lines, tornLast } = readJournal(join(t.dataDir, JOURNAL_FILE));
      assert.equal(tornLast, false);
      assert.deepEqual(lines.map((l) => [l.jseq, l.line]), [[0, "header"], [1, "pending"], [2, "commit"], [3, "commit"]]);
      const h = lines[0] as any;
      assert.equal(h.journal, "journal-format/1");
      assert.equal(h.seed.projects[0].key, "inbox");
      const c1 = lines[2] as JournalCommitLine;
      assert.equal(c1.commit_seq, 1);
      assert.equal(c1.pending_jseq, 1, "the commit names the pending line it completes");
      assert.equal((lines[3] as JournalCommitLine).pending_jseq, null);
      assert.ok(!("commit_seq" in lines[1]), "a pending line has no commit_seq");
      for (const l of lines) assert.equal(lineChecksum(l as any), l.checksum);
      assert.equal(decodeLine(encodeLine({ jseq: 5, line: "aborted", pending_jseq: 1, reason: "refused" } as any))!.jseq, 5);
    } finally {
      t.cleanup();
    }
  });

  it("a restart rebuilds the store, the key records and the seed's created_at with no clock call; digests are unchanged", async () => {
    const t = tempDir("restart");
    try {
      const clock = movableClock();
      const b = await durableBackend({ dataDir: t.dataDir, clock });
      const seed = (await b.api.send("GET", "/projects/inbox")).body.project;
      const first = await b.api.send("POST", "/tickets", { project: "inbox", title: "a", labels: ["x"], comment: "c" }, keyed("restart-key-01"));
      await b.api.send("POST", "/projects", { key: "p2", name: "P2" }, keyed("restart-key-02"));
      await b.api.send("POST", "/batch", { ops: [{ op: "patch", id: "T-1", set: { labels: ["x", "y"] } }] });
      const before = await b.api.export();
      await b.close();
      clock.advance(3_600_000); // a restart an hour later: nothing stored may move
      const b2 = await durableBackend({ dataDir: t.dataDir, clock });
      try {
        assert.deepEqual(await b2.api.export(), before);
        assert.equal((await b2.api.send("GET", "/projects/inbox")).body.project.created_at, seed.created_at, "the seed keeps its created_at");
        const again = await b2.api.send("POST", "/tickets", { project: "inbox", title: "a", labels: ["x"], comment: "c" }, keyed("restart-key-01"));
        assert.equal(again.status, 201);
        assert.equal(again.headers.get("idempotent-replayed"), "true");
        assert.equal(digestOf(DOMAINS.executionResult, again.body).digest, digestOf(DOMAINS.executionResult, first.body).digest, "the replayed answer's digest is the first answer's");
        assert.equal(again.headers.get("etag"), first.headers.get("etag"));
        const next = await b2.api.send("POST", "/tickets", { project: "inbox", title: "n" });
        assert.equal(next.body.ticket.id, "T-2", "id counters survive");
        assert.equal(b2.backend.store.lastSeq, 4);
      } finally {
        await b2.close();
      }
    } finally {
      t.cleanup();
    }
  });

  it("a journal append that fails aborts the write: nothing applied, 503, an aborted line for its pending record, the store carries on", async () => {
    const t = tempDir("fail");
    try {
      let fail = false;
      const b = await durableBackend({ dataDir: t.dataDir, clock: movableClock() });
      // A plain I/O error at before-append (not a simulated crash): the journal cuts the file back and throws.
      const j = b.backend.durability!.journal! as any;
      const orig = j.options.crash;
      j.options.crash = (p: string, at: any) => { if (fail && p === "before-append" && at.line === "commit") { fail = false; throw new Error("disk full"); } return orig?.(p, at); };
      fail = true;
      const r = await b.api.send("POST", "/tickets", { project: "inbox", title: "a" }, keyed("fail-key-0001"));
      assert.equal(r.status, 503);
      assert.equal(r.body.error, "journal_unavailable");
      assert.deepEqual((await b.api.export()).tickets, []);
      const ok = await b.api.send("POST", "/tickets", { project: "inbox", title: "a" }, keyed("fail-key-0001"));
      assert.equal(ok.status, 201, "the key was not held");
      assert.equal(ok.body.ticket.id, "T-1");
      await b.close();
      const lines = readJournal(join(t.dataDir, JOURNAL_FILE)).lines.map((l: any) => [l.line, l.reason ?? l.commit_seq ?? null]);
      assert.deepEqual(lines, [["header", null], ["pending", null], ["aborted", "journal_unavailable"], ["pending", null], ["commit", 1]]);
    } finally {
      t.cleanup();
    }
  });

  it("G2 fold-in 8: a pending line that cannot be written answers 503 journal_unavailable (not 500 internal), recorded as such; nothing begins", async () => {
    const t = tempDir("beginfail");
    try {
      const refusals: Array<[number, string]> = [];
      const b = await durableBackend({ dataDir: t.dataDir, clock: movableClock(), sinks: [{ name: "spy", role: "observer", onCommit() {}, onRefusal: (tx) => void refusals.push([tx.status, tx.code]) }] });
      try {
        const j = b.backend.durability!.journal! as any;
        let fail = true;
        const orig = j.options.crash;
        j.options.crash = (p: string, at: any) => { if (fail && p === "before-append" && at.line === "pending") { fail = false; throw new Error("disk full"); } return orig?.(p, at); };
        const r = await b.api.send("POST", "/tickets", { project: "inbox", title: "a" }, keyed("beginfail-key-1"));
        assert.deepEqual([r.status, r.body.error], [503, "journal_unavailable"]);
        assert.deepEqual(refusals, [[503, "journal_unavailable"]], "one refusal, as the answer says");
        assert.equal(b.backend.durability!.keys.get({ principal: "p-default" }, "beginfail-key-1"), undefined, "no pending record");
        const ok = await b.api.send("POST", "/tickets", { project: "inbox", title: "a" }, keyed("beginfail-key-1"));
        assert.equal(ok.status, 201, "the key was not held");
      } finally {
        await b.close();
      }
      assert.deepEqual(readJournal(join(t.dataDir, JOURNAL_FILE)).lines.map((l) => l.line), ["header", "pending", "commit"], "the failed line was cut back");
    } finally {
      t.cleanup();
    }
  });

  it("only a torn last line is tolerated: it is dropped and cut; a bad line in the middle stops the start", async () => {
    const t = tempDir("torn");
    try {
      const b = await durableBackend({ dataDir: t.dataDir, clock: movableClock() });
      await b.api.send("POST", "/tickets", { project: "inbox", title: "a" });
      await b.api.send("POST", "/tickets", { project: "inbox", title: "b" });
      await b.close();
      const file = join(t.dataDir, JOURNAL_FILE);
      const good = readFileSync(file, "utf8");
      appendFileSync(file, '{"jseq":3,"line":"commit","commit_s');
      const b2 = await durableBackend({ dataDir: t.dataDir, clock: movableClock() });
      assert.equal(b2.backend.durability!.journal!.report!.droppedTornLine, true);
      assert.equal((await b2.api.export()).tickets.length, 2);
      await b2.close();
      assert.equal(readFileSync(file, "utf8"), good, "the torn bytes are cut from the file");
      const lines = good.split("\n");
      lines[1] = lines[1].replace('"title":"a"', '"title":"z"');
      writeFileSync(file, lines.join("\n"));
      await assert.rejects(durableBackend({ dataDir: t.dataDir, clock: movableClock() }), JournalCorruptError);
      assert.ok(!existsSync(join(t.dataDir, LOCK_FILE)), "a refused start releases the lock");
    } finally {
      t.cleanup();
    }
  });

  it("G2 fold-in 3: a valid-looking last line with any problem is refused and the journal is untouched; only an unterminated undecodable line is dropped", async () => {
    const t = tempDir("lastline");
    try {
      const b = await durableBackend({ dataDir: t.dataDir, clock: movableClock() });
      await b.api.send("POST", "/tickets", { project: "inbox", title: "a" });
      await b.api.send("POST", "/tickets", { project: "inbox", title: "b" });
      await b.close();
      const file = join(t.dataDir, JOURNAL_FILE);
      const good = readFileSync(file, "utf8");
      const lines = readJournal(file).lines as any[];
      const last = lines[lines.length - 1];
      // Each case, checksummed (so it decodes), with and without its newline; and an undecodable line with its newline.
      const unknownKind = encodeLine({ jseq: 3, line: "future-kind", principal: "p-default" } as any);
      const forged = encodeLine({ ...last, jseq: 3, commit_seq: last.commit_seq + 5, tx: { ...last.tx, seq: last.commit_seq + 5 }, checksum: undefined } as any);
      const cases: Array<[string, string]> = [
        ["a checksummed unknown-kind line, terminated", `${unknownKind}\n`],
        ["a checksummed unknown-kind line, unterminated", unknownKind],
        ["a forged commit_seq+5 line, terminated", `${forged}\n`],
        ["a forged commit_seq+5 line, unterminated", forged],
        ["a line with a bad checksum, terminated", `${unknownKind.replace("future-kind", "future-kinx")}\n`],
      ];
      for (const [what, tail] of cases) {
        writeFileSync(file, good + tail);
        await assert.rejects(durableBackend({ dataDir: t.dataDir, clock: movableClock() }), JournalCorruptError, what);
        assert.equal(readFileSync(file, "utf8"), good + tail, `${what}: the journal is not touched`);
        assert.ok(!existsSync(join(t.dataDir, LOCK_FILE)), `${what}: the lock is released`);
        assert.throws(() => readJournal(file), JournalCorruptError, `${what}: the reader refuses it too`);
      }
      // The torn write: unterminated and not decodable. Dropped, cut, logged.
      writeFileSync(file, good + unknownKind.slice(0, 20));
      assert.equal(readJournal(file).tornLast, true);
      const b2 = await durableBackend({ dataDir: t.dataDir, clock: movableClock() });
      assert.equal(b2.backend.durability!.journal!.report!.droppedTornLine, true);
      await b2.close();
      assert.equal(readFileSync(file, "utf8"), good);
    } finally {
      t.cleanup();
    }
  });

  it("an orphan pending line becomes aborted (orphan_at_start) before the backend serves; the key is free", async () => {
    const t = tempDir("orphan");
    try {
      const clock = movableClock();
      const b = await durableBackend({ dataDir: t.dataDir, clock });
      b.arm({ point: "after-fsync", line: "pending" });
      const r = await b.api.send("POST", "/tickets", { project: "inbox", title: "a" }, keyed("orphan-key-001")).catch(() => undefined);
      assert.notEqual(r?.status, 201);
      await b.crash();
      const b2 = await durableBackend({ dataDir: t.dataDir, clock });
      assert.equal(b2.backend.durability!.journal!.report!.abortedOrphans, 1);
      const again = await b2.api.send("POST", "/tickets", { project: "inbox", title: "a" }, keyed("orphan-key-001"));
      assert.equal(again.status, 201);
      assert.equal(again.headers.get("idempotent-replayed"), null);
      await b2.close();
      const ls = readJournal(join(t.dataDir, JOURNAL_FILE)).lines as any[];
      assert.deepEqual(ls.map((l) => l.line), ["header", "pending", "aborted", "pending", "commit"]);
      assert.deepEqual([ls[2].pending_jseq, ls[2].reason], [1, "orphan_at_start"]);
    } finally {
      t.cleanup();
    }
  });

  it("the run reset is a journalled commit: a restart does not bring the run back", async () => {
    const t = tempDir("reset");
    try {
      const b = await durableBackend({ dataDir: t.dataDir, clock: movableClock() });
      const run = { "tiny-tracker-run": "run-r-1" };
      await b.api.send("POST", "/tickets", { project: "inbox", title: "a" }, { ...keyed("reset-key-0001"), ...run });
      await b.api.send("POST", "/tickets", { project: "inbox", title: "keep" });
      const r = b.backend.dropRun({ principal: "p-default" }, "run-r-1");
      assert.deepEqual([r.objects, r.keys], [1, 1]);
      await b.close();
      const b2 = await durableBackend({ dataDir: t.dataDir, clock: movableClock() });
      try {
        assert.deepEqual((await b2.api.export()).tickets.map((x) => x.title), ["keep"]);
        assert.equal(b2.backend.durability!.keys.get({ principal: "p-default" }, "reset-key-0001"), undefined);
        assert.equal(b2.backend.store.lastSeq, 3);
      } finally {
        await b2.close();
      }
    } finally {
      t.cleanup();
    }
  });
});

describe("the data dir and its lock (G13, X5)", () => {
  it("is created 0700; an existing dir others can reach, a symlink, or a foreign non-empty dir is refused", () => {
    const t = tempDir("dir");
    try {
      prepareDataDir(t.dataDir);
      assert.ok(existsSync(join(t.dataDir, "tiny-tracker.data")));
      if (process.platform !== "win32") {
        const open = join(t.dir, "open");
        mkdirSync(open, { mode: 0o755 });
        chmodSync(open, 0o755);
        assert.throws(() => prepareDataDir(open), /group or others \(chmod 700\)/); // stream F's private-dir message
        symlinkSync(t.dataDir, join(t.dir, "link"));
        assert.throws(() => prepareDataDir(join(t.dir, "link")), /symbolic link/);
      }
      const foreign = join(t.dir, "foreign");
      mkdirSync(foreign, { mode: 0o700 });
      writeFileSync(join(foreign, "notes.txt"), "x");
      assert.throws(() => prepareDataDir(foreign), DataDirError);
    } finally {
      t.cleanup();
    }
  });

  it("one writer: a second open in this process, or a lock held by a live process, is refused; a dead holder's lock is taken over", async () => {
    const t = tempDir("lock");
    try {
      const b = await durableBackend({ dataDir: t.dataDir, clock: movableClock() });
      await assert.rejects(durableBackend({ dataDir: t.dataDir, clock: movableClock() }), /already open in this process/);
      await b.close();
      assert.ok(!existsSync(join(t.dataDir, LOCK_FILE)), "a clean close removes the lock");
      writeFileSync(join(t.dataDir, LOCK_FILE), JSON.stringify({ pid: process.ppid, started_at: "x" }));
      await assert.rejects(durableBackend({ dataDir: t.dataDir, clock: movableClock() }), new RegExp(`locked by process ${process.ppid}`));
      writeFileSync(join(t.dataDir, LOCK_FILE), JSON.stringify({ pid: 2 ** 22 + 12345, started_at: "x" }));
      const b2 = await durableBackend({ dataDir: t.dataDir, clock: movableClock() });
      assert.equal(JSON.parse(readFileSync(join(t.dataDir, LOCK_FILE), "utf8")).pid, process.pid);
      await b2.close();
    } finally {
      t.cleanup();
    }
  });
});

describe("the lock takeover (G2 fold-in 7)", () => {
  it("a second spelling of a held dir is refused (HELD keys on the real path), and a lock naming this process is held, not stale", async () => {
    const t = tempDir("lockpath");
    try {
      const real = join(t.dir, "real");
      mkdirSync(real, { mode: 0o700 });
      symlinkSync(real, join(t.dir, "alias"));
      const b = await durableBackend({ dataDir: join(real, "data"), clock: movableClock() });
      try {
        // As /tmp and /private/tmp on macOS: one directory, two paths. Before the fix this process opened it twice.
        await assert.rejects(durableBackend({ dataDir: join(t.dir, "alias", "data"), clock: movableClock() }), /already open in this process/);
      } finally {
        await b.close();
      }
      // A lock that names this process, with no journal of this process holding the dir: still held, never stale.
      prepareDataDir(t.dataDir);
      writeFileSync(join(t.dataDir, LOCK_FILE), JSON.stringify({ pid: process.pid, started_at: "x" }));
      await assert.rejects(durableBackend({ dataDir: t.dataDir, clock: movableClock() }), /already open in this process \(its lock names this process\)/);
      assert.equal(JSON.parse(readFileSync(join(t.dataDir, LOCK_FILE), "utf8")).pid, process.pid, "the lock is left alone");
    } finally {
      t.cleanup();
    }
  });

  it("two starters on a stale lock: the one that comes second never removes the other's fresh lock", async () => {
    const t = tempDir("lockrace");
    try {
      prepareDataDir(t.dataDir);
      const path = join(t.dataDir, LOCK_FILE);
      writeFileSync(path, JSON.stringify({ pid: 2 ** 22 + 12345, started_at: "dead" }));
      // Between this starter's stale check and its takeover, another starter (a live process: our parent stands in for
      // it) takes the stale lock over. Before the fix this starter unlinked that fresh lock and created its own.
      let raced = false;
      lockHooks.beforeTakeover = (p) => {
        if (raced) return;
        raced = true;
        unlinkSync(p);
        writeFileSync(p, JSON.stringify({ pid: process.ppid, started_at: "fresh" }));
      };
      try {
        await assert.rejects(durableBackend({ dataDir: t.dataDir, clock: movableClock() }), new RegExp(`locked by process ${process.ppid}`));
      } finally {
        lockHooks.beforeTakeover = undefined;
      }
      assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { pid: process.ppid, started_at: "fresh" }, "the other starter's lock is in place");
      assert.deepEqual(readdirSync(t.dataDir).filter((f) => f.startsWith("lock.")), [], "nothing left aside");
      // Without a race the stale lock is taken over as before.
      writeFileSync(path, JSON.stringify({ pid: 2 ** 22 + 12345, started_at: "dead" }));
      const b = await durableBackend({ dataDir: t.dataDir, clock: movableClock() });
      assert.equal(JSON.parse(readFileSync(path, "utf8")).pid, process.pid);
      await b.close();
    } finally {
      t.cleanup();
    }
  });
});

describe("in-flight keys (rule 4, R5)", () => {
  it("a same-key call while the first is pending answers 409 in_progress, whatever its body; after the commit it is a replay", async () => {
    const t = tempDir("inflight");
    try {
      let release!: () => void;
      let reached!: () => void;
      const arrived = new Promise<void>((r) => { reached = r; });
      const gate = new Promise<void>((r) => { release = r; });
      let hold = true;
      const refusals: string[] = [];
      const b = await durableBackend({
        dataDir: t.dataDir, clock: movableClock(),
        sinks: [{ name: "spy", role: "observer", onCommit() {}, onRefusal: (tx) => void refusals.push(tx.code) }],
        faults: { beforeCommit: async () => { if (hold) { hold = false; reached(); await gate; } } },
      });
      try {
        const body = { project: "inbox", title: "a" };
        const first = b.api.send("POST", "/tickets", body, keyed("inflight-key-1"));
        await arrived;
        const second = await b.api.send("POST", "/tickets", body, keyed("inflight-key-1"));
        assert.equal(second.status, 409);
        assert.equal(second.body.error, "in_progress");
        assert.equal(typeof second.body.since, "string", "seams v2.1: the pending record's created_at");
        // Seams v2.1's frozen order: a pending record answers 409 in_progress whatever the body (the fingerprint is
        // compared once the record has completed).
        const other = await b.api.send("POST", "/tickets", { ...body, title: "b" }, keyed("inflight-key-1"));
        assert.deepEqual([other.status, other.body.error], [409, "in_progress"]);
        release();
        assert.equal((await first).status, 201);
        const third = await b.api.send("POST", "/tickets", body, keyed("inflight-key-1"));
        assert.equal(third.headers.get("idempotent-replayed"), "true");
        assert.equal((await b.api.export()).tickets.length, 1);
        assert.deepEqual(refusals, ["in_progress", "in_progress"], "both early answers are refusals in the ledger's view; the pending owner is untouched");
      } finally {
        await b.close();
      }
    } finally {
      t.cleanup();
    }
  });

  it("a refused first call frees its key: an aborted line with reason refused", async () => {
    const t = tempDir("refused");
    try {
      const b = await durableBackend({ dataDir: t.dataDir, clock: movableClock() });
      const bad = await b.api.send("POST", "/tickets", { project: "nope", title: "a" }, keyed("refused-key-01"));
      assert.equal(bad.status, 404);
      const okk = await b.api.send("POST", "/tickets", { project: "inbox", title: "a" }, keyed("refused-key-01"));
      assert.equal(okk.status, 201);
      await b.close();
      const ls = readJournal(join(t.dataDir, JOURNAL_FILE)).lines as any[];
      assert.deepEqual(ls.map((l) => l.line), ["header", "pending", "aborted", "pending", "commit"]);
      assert.equal(ls[2].reason, "refused");
    } finally {
      t.cleanup();
    }
  });
});

describe("retention, tombstones and forget (decision 0004, B10)", () => {
  it("parses and states the retention", () => {
    assert.equal(parseRetention(undefined), 7 * DAY_MS);
    assert.equal(parseRetention("24h"), DAY_MS);
    assert.equal(parseRetention("90m"), 5_400_000);
    assert.throws(() => parseRetention("soon"));
    assert.equal(parseExpiryPolicy("forget"), "forget");
    assert.throws(() => parseExpiryPolicy("drop"));
    assert.equal(describeRetention(7 * DAY_MS), "7 days");
    assert.match(retentionSentence(), /remembered for 7 days/);
  });

  it("refuse: an expired key with the same request answers applied with the execution id from the tombstone; a different request is refused; it survives a restart", async () => {
    const t = tempDir("tomb");
    try {
      const clock = movableClock();
      const b = await durableBackend({ dataDir: t.dataDir, clock });
      const body = { project: "inbox", title: "a" };
      const first = await b.api.send("POST", "/tickets", body, keyed("tomb-key-00001"));
      clock.advance(7 * DAY_MS - 1);
      assert.equal((await b.api.send("POST", "/tickets", body, keyed("tomb-key-00001"))).headers.get("idempotent-replayed"), "true", "still inside the retention");
      clock.advance(1);
      await b.close();
      const b2 = await durableBackend({ dataDir: t.dataDir, clock });
      try {
        const exp = await b2.api.send("POST", "/tickets", body, keyed("tomb-key-00001"));
        // Seams v2.1 (B10): 410 key_expired, a replay of the tombstone's commit; the MCP layer answers applied.
        assert.equal(exp.status, 410);
        assert.equal(exp.body.error, "key_expired");
        assert.equal(exp.body.execution_id, "X-1");
        assert.equal(exp.body.result_digest, digestOf(DOMAINS.executionResult, first.body).digest);
        assert.deepEqual(exp.body.objects, [{ type: "ticket", id: "T-1" }]);
        assert.equal(exp.headers.get("idempotent-replayed"), "true");
        const tomb = b2.backend.durability!.keys.tombstone({ principal: "p-default" }, "tomb-key-00001")!;
        assert.equal(tomb.fingerprintHash, fingerprintHash("p-default", "POST", "/tickets", body));
        assert.equal((await b2.api.send("POST", "/tickets", { ...body, title: "b" }, keyed("tomb-key-00001"))).status, 422);
        assert.equal((await b2.api.export()).tickets.length, 1, "nothing applied again");
      } finally {
        await b2.close();
      }
    } finally {
      t.cleanup();
    }
  });

  it("forget: an expired key is new; key-expires-early keeps keys a thousandth of the stated time", async () => {
    const t = tempDir("forget");
    try {
      const clock = movableClock();
      const b = await durableBackend({ dataDir: t.dataDir, clock, policy: "forget" });
      await b.api.send("POST", "/tickets", { project: "inbox", title: "a" }, keyed("forget-key-001"));
      clock.advance(7 * DAY_MS);
      const again = await b.api.send("POST", "/tickets", { project: "inbox", title: "a" }, keyed("forget-key-001"));
      assert.equal(again.status, 201);
      assert.equal(again.body.ticket.id, "T-2");
      await b.close();
      const t2 = tempDir("early");
      try {
        const c2 = movableClock();
        const e = await durableBackend({ dataDir: t2.dataDir, clock: c2, defects: ["key-expires-early"] });
        await e.api.send("POST", "/tickets", { project: "inbox", title: "a" }, keyed("early-key-0001"));
        c2.advance(DAY_MS);
        assert.equal((await e.api.send("POST", "/tickets", { project: "inbox", title: "a" }, keyed("early-key-0001"))).body.error, "key_expired", "expired inside the stated 7 days (FX-KEY-1)");
        await e.close();
      } finally {
        t2.cleanup();
      }
    } finally {
      t.cleanup();
    }
  });
});

describe("the key fence (settle-by-lookup, B9)", () => {
  it("a lookup with no record closes the key: a late original is refused; a completed key returns its record; peek never fences", async () => {
    const t = tempDir("fence");
    try {
      const b = await durableBackend({ dataDir: t.dataDir, clock: movableClock() });
      try {
        const peek = await b.api.send("POST", "/operations/fence-key-0001/fence", { fence: false });
        assert.equal(peek.status, 404);
        assert.equal(peek.body.message, "no record of this key now");
        const f = await b.api.send("POST", "/operations/fence-key-0001/fence", {});
        assert.deepEqual([f.status, f.body.state], [200, "fenced"]);
        const late = await b.api.send("POST", "/tickets", { project: "inbox", title: "late" }, keyed("fence-key-0001"));
        assert.deepEqual([late.status, late.body.error], [409, "key_fenced"]);
        assert.equal((await b.api.export()).tickets.length, 0);
        const made = await b.api.send("POST", "/tickets", { project: "inbox", title: "x" }, keyed("fence-key-0002"));
        const found = await b.api.send("POST", "/operations/fence-key-0002/fence", {});
        assert.deepEqual([found.status, found.body.state, found.body.execution_id, found.body.body.ticket.id], [200, "completed", "X-1", made.body.ticket.id]);
        assert.equal((await b.api.send("POST", "/operations/bad/fence", {})).status, 400);
      } finally {
        await b.close();
      }
    } finally {
      t.cleanup();
    }
  });

  it("without inflight there is no fence route; a non-durable backend with inflight and retention needs no data dir", async () => {
    const plain = await startBackend({ token: TOKEN, port: 0 });
    try {
      assert.equal((await fetch(`${plain.url}/operations/xxxxxxxx/fence`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } })).status, 404);
    } finally {
      await plain.close();
    }
    const mem = await startBackend({ token: TOKEN, port: 0, features: ["inflight", "retention"] });
    try {
      assert.equal(mem.durability?.journal, undefined);
      assert.equal((await fetch(`${mem.url}/operations/xxxxxxxx/fence`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } })).status, 200);
    } finally {
      await mem.close();
    }
  });
});

describe("the persistence gap (FX-DUR-1, FX-DUR-2)", () => {
  async function crashAfterEffect(defects: string[]) {
    const t = tempDir("gap");
    try {
      const clock = movableClock();
      const b = await durableBackend({ dataDir: t.dataDir, clock, defects, features: ["durable"] });
      if (defects.includes("key-record-after-effect")) {
        // The crash between the effect (its commit line, flushed) and the key record (its own line, after the apply).
        b.arm({ point: "before-append", line: "commit", key: "gap-key-00001" });
        (b.backend.durability!.journal as any).options.crash = undefined;
      } else {
        b.arm({ point: "after-fsync", line: "commit", key: "gap-key-00001" });
      }
      await b.api.send("POST", "/tickets", { project: "inbox", title: "gap" }, keyed("gap-key-00001")).catch(() => undefined);
      await b.crash();
      const b2 = await durableBackend({ dataDir: t.dataDir, clock, defects, features: ["durable"] });
      try {
        await b2.api.send("POST", "/tickets", { project: "inbox", title: "gap" }, keyed("gap-key-00001"));
        return (await b2.api.export()).tickets.length;
      } finally {
        await b2.close();
      }
    } finally {
      t.cleanup();
    }
  }

  it("correct: a crash after the commit line, before the reply; the repeat is a replay (one ticket)", async () => {
    assert.equal(await crashAfterEffect([]), 1);
  });

  it("key-record-after-effect: a crash between the effect and its key record; the repeat duplicates", async () => {
    assert.equal(await crashAfterEffect(["key-record-after-effect"]), 2);
  });

  it("key-record-not-durable: after a clean restart the key is unknown; the repeat duplicates", async () => {
    const t = tempDir("notdur");
    try {
      const b = await durableBackend({ dataDir: t.dataDir, clock: movableClock(), defects: ["key-record-not-durable"], features: ["durable"] });
      await b.api.send("POST", "/tickets", { project: "inbox", title: "a" }, keyed("nd-key-000001"));
      assert.equal((await b.api.send("POST", "/tickets", { project: "inbox", title: "a" }, keyed("nd-key-000001"))).headers.get("idempotent-replayed"), "true", "in one process it looks right");
      await b.close();
      const b2 = await durableBackend({ dataDir: t.dataDir, clock: movableClock(), defects: ["key-record-not-durable"], features: ["durable"] });
      await b2.api.send("POST", "/tickets", { project: "inbox", title: "a" }, keyed("nd-key-000001"));
      assert.equal((await b2.api.export()).tickets.length, 2);
      await b2.close();
    } finally {
      t.cleanup();
    }
  });
});

describe("seams v2.1 shapes, built ahead of the rebase (coordinator note 7)", () => {
  it("get answers completed, pending, fenced or expired; abort never throws and takes a reason", async () => {
    const t = tempDir("v21");
    try {
      const clock = movableClock();
      const b = await durableBackend({ dataDir: t.dataDir, clock });
      const keys = b.backend.durability!.keys;
      const s = { principal: "p-default" };
      try {
        await b.api.send("POST", "/tickets", { project: "inbox", title: "a" }, keyed("v21-key-00001"));
        assert.equal(keys.get(s, "v21-key-00001")!.state, "completed");
        keys.begin(s, "v21-key-00002", "POST /tickets {}", null);
        assert.equal(keys.get(s, "v21-key-00002")!.state, "pending");
        keys.fence(s, "v21-key-00003", null, true);
        assert.deepEqual(keys.get(s, "v21-key-00003"), { state: "fenced", run: "", by: "lookup" }, "a fenced key lets no write begin");
        (b.backend.durability!.journal as any).abandon(); // the journal is gone: the abort cannot be written
        const logged: string[] = [];
        keys.log = (m) => void logged.push(m);
        assert.doesNotThrow(() => keys.abort(s, "v21-key-00002", "fault"));
        assert.equal(keys.get(s, "v21-key-00002"), undefined);
        assert.match(logged[0], /next start/);
        clock.advance(7 * DAY_MS);
        const e = keys.get(s, "v21-key-00001");
        assert.equal(e!.state, "expired");
        assert.equal((e as any).tombstone.executionId, "X-1");
      } finally {
        await b.close();
      }
    } finally {
      t.cleanup();
    }
  });

  it("a run reset fences that run's pending key records with a fence line; the fence survives a restart", async () => {
    const t = tempDir("v21r");
    try {
      const b = await durableBackend({ dataDir: t.dataDir, clock: movableClock() });
      const s = { principal: "p-default" };
      b.backend.durability!.keys.begin(s, "v21-run-key01", "POST /tickets {}", "run-v-1");
      b.backend.durability!.keys.begin(s, "v21-run-key02", "POST /tickets {}", "run-v-2");
      const r = b.backend.dropRun(s, "run-v-1");
      assert.equal(r.keys, 0, "a fenced pending record is not counted");
      assert.deepEqual(b.backend.durability!.keys.get(s, "v21-run-key01"), { state: "fenced", run: "run-v-1", by: "reset" });
      assert.equal(b.backend.durability!.keys.get(s, "v21-run-key02")!.state, "pending");
      await b.crash();
      const lines = readJournal(join(t.dataDir, JOURNAL_FILE)).lines as any[];
      assert.deepEqual(lines.map((l) => l.line), ["header", "pending", "pending", "commit", "fence"]);
      assert.deepEqual([lines[4].pending_jseq, lines[4].reset_seq, lines[4].run, lines[4].key], [1, lines[3].commit_seq, "run-v-1", "v21-run-key01"]);
      const b2 = await durableBackend({ dataDir: t.dataDir, clock: movableClock() });
      try {
        assert.equal(b2.backend.durability!.journal!.report!.abortedOrphans, 1, "only run-v-2's pending record is an orphan");
        assert.equal(b2.backend.durability!.journal!.report!.fences, 1);
        assert.equal(b2.backend.durability!.keys.get(s, "v21-run-key01")!.state, "fenced", "the fence survives the restart");
        const late = await b2.api.send("POST", "/tickets", { project: "inbox", title: "late" }, keyed("v21-run-key01"));
        assert.deepEqual([late.status, late.body.error], [409, "key_fenced"]);
        assert.equal((await b2.api.export()).tickets.length, 0, "nothing applied under a fenced key");
      } finally {
        await b2.close();
      }
    } finally {
      t.cleanup();
    }
  });
});
