// T2: seeded random histories, and T3: testing the oracles (review T2, T3).
//
// T2 interleaves keyed creates, identical repeats, repeats with changed
// arguments, unkeyed updates, crashes at random journal points with a restart,
// clean restarts and clock advances, from a seed. After every step: at most one
// applied effect per (principal, key), every success the history saw is a commit
// line of the journal, and every repeat inside the retention is the first answer
// byte for byte (after the retention: the tombstone's applied answer, naming the
// first execution). The seed is printed on failure.
//
// T3 derives the state three ways and recounts it twice: the ledger (a fake one
// here: the 0.2.0 ledger is stream B's, so an observer sink stands in for it), a
// journal replay into a fresh process, and the live export; a recount written a
// second time in this file with plain JSON parsing; and an external recount in
// Python from the journal file. Test-only sabotage (never reachable from the
// command line) makes each oracle lie in turn, and the recount must catch it.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { durableBackend, movableClock, prng, tempDir } from "./support/durable.js";
import { JOURNAL_FILE, JournalCorruptError, readJournal, lineChecksum } from "../src/backend/journal.js";
import { DAY_MS } from "../src/backend/expiry.js";
import type { CommitSink, CommittedTransaction, JournalCommitLine } from "../src/backend/commit.js";
import { Ledger } from "../src/fixture/ledger.js";

const POINTS = [
  { point: "before-append", line: "pending" }, { point: "after-fsync", line: "pending" },
  { point: "before-append", line: "commit" }, { point: "torn-write", line: "commit" },
  { point: "after-write", line: "commit" }, { point: "after-fsync", line: "commit" },
] as const;

interface KeyModel { args: { project: string; title: string }; first?: unknown; seq?: number; committedAt?: number; uncertain?: boolean }

/** A stand-in for stream B's ledger: one entry per commit, replay and refusal, kept across restarts. */
class FakeLedger {
  entries: Array<{ kind: "execution" | "replay" | "refusal"; seq?: number; key: string | null; principal: string; objects?: string[] }> = [];
  /** Sabotage (tests only): "drop" loses the next execution entry, "duplicate" writes it twice. */
  sabotage: "drop" | "duplicate" | undefined;
  sink(): CommitSink {
    return {
      name: "fake-ledger", role: "ledger",
      onCommit: (tx: CommittedTransaction) => {
        if (tx.kind !== "write") return;
        const e = { kind: "execution" as const, seq: tx.seq, key: tx.request?.key ?? null, principal: tx.principal, objects: tx.objects.map((o) => `${o.type}:${o.id}`) };
        if (this.sabotage === "drop") { this.sabotage = undefined; return; }
        this.entries.push(e);
        if (this.sabotage === "duplicate") { this.sabotage = undefined; this.entries.push({ ...e }); }
      },
      onReplay: (tx) => void this.entries.push({ kind: "replay", seq: tx.originalSeq, key: tx.request?.key ?? null, principal: tx.principal }),
      onRefusal: (tx) => void this.entries.push({ kind: "refusal", key: tx.request?.key ?? null, principal: tx.principal }),
    };
  }
}

function commitLines(dataDir: string): JournalCommitLine[] {
  return readJournal(join(dataDir, JOURNAL_FILE)).lines.filter((l): l is JournalCommitLine => l.line === "commit");
}

async function history(seed: number, steps: number) {
  const rnd = prng(seed);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)];
  const t = tempDir("t2");
  const clock = movableClock();
  const ledger = new FakeLedger();
  const open = () => durableBackend({ dataDir: t.dataDir, clock, sinks: [ledger.sink()] });
  let b = await open();
  const keys = new Map<string, KeyModel>();
  const successes: unknown[] = [];
  const log: string[] = [];
  let n = 0;
  try {
    for (let step = 0; step < steps; step++) {
      const r = rnd();
      const known = [...keys.keys()];
      if (r < 0.3 || known.length === 0) {
        const k = `h${seed}-key-${String(++n).padStart(5, "0")}`;
        const m: KeyModel = { args: { project: "inbox", title: `t-${k}` } };
        keys.set(k, m);
        const res = await b.api.send("POST", "/tickets", m.args, { "idempotency-key": k });
        log.push(`create ${k} -> ${res.status}`);
        assert.equal(res.status, 201);
        m.first = res.body; m.seq = Number(String(res.body.ticket.id).slice(2)); m.committedAt = clock.offset;
        successes.push(res.body);
      } else if (r < 0.5) {
        const k = pick(known);
        const m = keys.get(k)!;
        const res = await b.api.send("POST", "/tickets", m.args, { "idempotency-key": k });
        log.push(`repeat ${k} -> ${res.status} ${res.body?.error ?? ""}`);
        if (m.first === undefined) {
          // The first call's outcome was lost in a crash: now it either replays what the journal kept or applies once.
          assert.equal(res.status, 201);
          m.first = res.body; m.committedAt = clock.offset;
          if (res.headers.get("idempotent-replayed") !== "true") successes.push(res.body);
        } else if (clock.offset - m.committedAt! >= 7 * DAY_MS) {
          // Seams v2.1 (B10): 410 key_expired, a replay of the tombstone's commit.
          assert.equal(res.status, 410);
          assert.equal(res.body.error, "key_expired");
          assert.equal(res.headers.get("idempotent-replayed"), "true");
        } else {
          assert.equal(res.headers.get("idempotent-replayed"), "true");
          assert.deepEqual(res.body, m.first, "a repeat is the first answer, byte for byte");
        }
      } else if (r < 0.6) {
        const k = pick(known);
        const m = keys.get(k)!;
        const res = await b.api.send("POST", "/tickets", { ...m.args, title: `${m.args.title}-changed` }, { "idempotency-key": k });
        log.push(`changed ${k} -> ${res.status}`);
        if (m.first !== undefined) assert.equal(res.status, 422);
        else if (res.status === 201) { m.args = { ...m.args, title: `${m.args.title}-changed` }; m.first = res.body; m.committedAt = clock.offset; successes.push(res.body); }
      } else if (r < 0.7) {
        const tickets = (await b.api.export()).tickets;
        if (tickets.length) {
          const tk = pick(tickets);
          const res = await b.api.send("PATCH", `/tickets/${tk.id}`, { priority: 1 + Math.floor(rnd() * 5) });
          log.push(`patch ${tk.id} -> ${res.status}`);
          if (res.status === 200 && res.body.changed.length) successes.push(res.body);
        }
      } else if (r < 0.82) {
        const k = `h${seed}-key-${String(++n).padStart(5, "0")}`;
        const m: KeyModel = { args: { project: "inbox", title: `t-${k}` }, uncertain: true };
        keys.set(k, m);
        const p = pick(POINTS);
        b.arm({ ...p, key: k });
        log.push(`crash ${k} at ${p.line}:${p.point}`);
        await b.api.send("POST", "/tickets", m.args, { "idempotency-key": k }).catch(() => undefined);
        await b.crash();
        b = await open();
      } else if (r < 0.9) {
        log.push("restart");
        await b.close();
        b = await open();
      } else {
        const ms = Math.floor(rnd() * 3 * DAY_MS);
        clock.advance(ms);
        log.push(`advance ${ms}`);
      }
      // Invariants after every step.
      const lines = commitLines(t.dataDir);
      const perKey = new Map<string, number>();
      for (const l of lines) if (l.tx.request?.key) perKey.set(l.tx.request.key, (perKey.get(l.tx.request.key) ?? 0) + 1);
      for (const [k, c] of perKey) assert.ok(c <= 1, `key ${k} applied ${c} times`);
      const titles = (await b.api.export()).tickets.map((x) => x.title.replace(/-changed$/, ""));
      assert.equal(new Set(titles).size, titles.length, "at most one ticket per key");
      const bodies = lines.map((l) => JSON.stringify(l.tx.body));
      for (const s of successes) assert.ok(bodies.includes(JSON.stringify(s)), "every success is a commit line of the journal");
    }
    const live = await b.api.export();
    await b.close();
    const again = await open();
    assert.deepEqual(await again.api.export(), live, "a journal replay gives the live state");
    await again.close();
  } catch (e) {
    (e as Error).message = `seed ${seed}: ${(e as Error).message}\n${log.slice(-12).join("\n")}`;
    await b.close().catch(() => {});
    throw e;
  } finally {
    t.cleanup();
  }
}

describe("T2: seeded random histories", () => {
  const seeds = process.env.TT_SEEDS ? process.env.TT_SEEDS.split(",").map(Number) : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  for (const seed of seeds) {
    it(`seed ${seed}: one effect per key, every success journalled, repeats are the first answer`, async () => {
      await history(seed, 45);
    });
  }
});

// ---------------------------------------------------------------- T3

/** A physical journal line as plain JSON: the line itself, or the whole line that joined a torn fragment (undefined: a torn last line). */
function parseJoined(text: string): any {
  for (let i = 0; i >= 0; i = text.indexOf('{"jseq":', i + 1)) {
    try {
      return JSON.parse(text.slice(i));
    } catch {
      // not a whole line from here
    }
  }
  return undefined;
}

/** The recount written a second time: plain JSON over the journal file, no code from src/. */
function recount(file: string) {
  const tickets = new Map<string, { version: number; title: string }>();
  const effects = new Map<string, number>();
  let commits = 0;
  for (const text of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
    // 0.4.0 (G3a): a torn write is never cut, so the next line may join it; the whole line is the suffix that parses.
    const l = parseJoined(text);
    if (l === undefined) continue;
    if (l.line !== "commit") continue;
    commits++;
    for (const tk of l.tx.post.upserts.tickets) tickets.set(tk.id, { version: tk.version, title: tk.title });
    for (const id of l.tx.post.deletes.tickets) tickets.delete(id);
    if (l.tx.kind === "write" && l.tx.request.key !== null && l.tx.request.fingerprint !== null) {
      const k = `${l.tx.principal} ${l.tx.request.key}`;
      effects.set(k, (effects.get(k) ?? 0) + 1);
    }
  }
  return { tickets, effects, commits };
}

/** Every disagreement between the ledger, the journal (replayed and recounted twice) and the export. */
async function disagreements(dataDir: string, ledger: FakeLedger, live: { tickets: Array<{ id: string; version: number; title: string }> }) {
  const out: string[] = [];
  const file = join(dataDir, JOURNAL_FILE);
  const mine = recount(file);
  const executions = ledger.entries.filter((e) => e.kind === "execution");
  if (executions.length !== mine.commits) out.push(`ledger executions ${executions.length} != journal commits ${mine.commits}`);
  const ledgerSeqs = executions.map((e) => e.seq);
  if (new Set(ledgerSeqs).size !== ledgerSeqs.length) out.push("the ledger names one execution twice");
  const liveMap = new Map(live.tickets.map((t) => [t.id, { version: t.version, title: t.title }]));
  if (JSON.stringify([...mine.tickets].sort()) !== JSON.stringify([...liveMap].sort())) out.push("the journal recount and the export disagree");
  let replayed: unknown;
  try {
    const b = await durableBackend({ dataDir, clock: movableClock() });
    replayed = await b.api.export();
    await b.close();
    if (JSON.stringify((replayed as any).tickets) !== JSON.stringify(live.tickets)) out.push("a journal replay and the export disagree");
  } catch (e) {
    out.push(`the journal does not replay: ${(e as Error).message}`);
  }
  for (const [k, c] of mine.effects) if (c > 1) out.push(`key ${k} has ${c} effects`);
  return out;
}

async function recorded(t: { dataDir: string }, ledger: FakeLedger, sabotage?: () => void) {
  const b = await durableBackend({ dataDir: t.dataDir, clock: movableClock(), sinks: [ledger.sink()] });
  await b.api.send("POST", "/tickets", { project: "inbox", title: "a" }, { "idempotency-key": "t3-key-000001" });
  await b.api.send("POST", "/tickets", { project: "inbox", title: "a" }, { "idempotency-key": "t3-key-000001" });
  sabotage?.();
  await b.api.send("POST", "/tickets", { project: "inbox", title: "b" }, { "idempotency-key": "t3-key-000002" });
  await b.api.send("PATCH", "/tickets/T-1", { title: "a2" });
  await b.api.send("POST", "/batch", { ops: [{ op: "delete", id: "T-2" }] });
  const live = await b.api.export();
  await b.close();
  return live;
}

describe("T3: the oracles tested against each other", () => {
  it("clean: the ledger, a journal replay, the export and both recounts agree", async () => {
    const t = tempDir("t3");
    try {
      const ledger = new FakeLedger();
      const live = await recorded(t, ledger);
      assert.deepEqual(await disagreements(t.dataDir, ledger, live), []);
      assert.equal(ledger.entries.filter((e) => e.kind === "replay").length, 1);
    } finally {
      t.cleanup();
    }
  });

  for (const s of ["drop", "duplicate"] as const) {
    it(`sabotage: a ledger that ${s === "drop" ? "loses" : "doubles"} an execution is caught`, async () => {
      const t = tempDir("t3s");
      try {
        const ledger = new FakeLedger();
        const live = await recorded(t, ledger, () => { ledger.sabotage = s; });
        const found = await disagreements(t.dataDir, ledger, live);
        assert.ok(found.some((d) => /ledger/.test(d)), found.join("; "));
      } finally {
        t.cleanup();
      }
    });
  }

  it("sabotage: a journal line rewritten with a valid checksum (the checksum cannot see it) is caught by the recount", async () => {
    const t = tempDir("t3j");
    try {
      const ledger = new FakeLedger();
      const live = await recorded(t, ledger);
      const file = join(t.dataDir, JOURNAL_FILE);
      const lines = readFileSync(file, "utf8").split("\n");
      const i = lines.findIndex((x) => x.includes('"title":"a2"'));
      const l = JSON.parse(lines[i]);
      l.tx.post.upserts.tickets[0].title = "forged";
      delete l.checksum;
      lines[i] = JSON.stringify({ ...l, checksum: lineChecksum(l) });
      writeFileSync(file, lines.join("\n"));
      const found = await disagreements(t.dataDir, ledger, live);
      assert.ok(found.some((d) => /recount and the export/.test(d)) && found.some((d) => /replay and the export/.test(d)), found.join("; "));
    } finally {
      t.cleanup();
    }
  });

  it("sabotage: a journal line changed without its checksum stops the replay", async () => {
    const t = tempDir("t3c");
    try {
      const ledger = new FakeLedger();
      const live = await recorded(t, ledger);
      const file = join(t.dataDir, JOURNAL_FILE);
      const text = readFileSync(file, "utf8");
      writeFileSync(file, text.replace('"title":"a2"', '"title":"zz"'));
      const found = await disagreements(t.dataDir, ledger, live);
      assert.ok(found.some((d) => /does not replay/.test(d)), found.join("; "));
      await assert.rejects(durableBackend({ dataDir: t.dataDir, clock: movableClock() }), JournalCorruptError);
    } finally {
      t.cleanup();
    }
  });

  const python = spawnSync("python3", ["-I", "-c", "import json"], { encoding: "utf8" }).status === 0;
  it("an external recount in Python from the journal file agrees with the export", { skip: python || process.env.TT_GATE === "1" ? false : "python3 is not installed" }, async () => {
    assert.ok(python, "TT_GATE=1 needs python3");
    const t = tempDir("t3p");
    try {
      const ledger = new FakeLedger();
      const live = await recorded(t, ledger);
      const root = fileURLToPath(new URL("../../", import.meta.url));
      const r = spawnSync("python3", ["-I", join(root, "test/support/recount_journal.py"), join(root, "verify/python"), join(t.dataDir, JOURNAL_FILE)], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      const py = JSON.parse(r.stdout);
      assert.deepEqual(py.tickets, Object.fromEntries(live.tickets.map((x) => [x.id, [x.version, x.title]])));
      assert.equal(py.commits, recount(join(t.dataDir, JOURNAL_FILE)).commits);
      assert.deepEqual(Object.values(py.keyed_effects), [1, 1]);
    } finally {
      t.cleanup();
    }
  });
});

// ---------------------------------------------------------------- T3 with the real oracles (0.3.0 integration, G2)
//
// Stream B's ledger (src/fixture/ledger.ts) replaces the fake ledger, and stream C's independent recount
// (verify/python/tt_recount.py) reads the journal as tiny-tracker writes it: four sources (ledger, export,
// execution records, journal) must agree, and each sabotage is caught by the recount.

describe("T3 with stream B's ledger and stream C's tt_recount.py (ledger, export, executions, journal)", () => {
  const python = spawnSync("python3", ["-I", "-c", "import json"], { encoding: "utf8" }).status === 0;
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const RECOUNT = join(root, "verify", "python", "tt_recount.py");
  const BOOT = "d0d0d0d0d0d0d0d0";

  async function realRun(t: { dir: string; dataDir: string }) {
    const clock = movableClock();
    const ledger = new Ledger(BOOT, clock);
    const b = await durableBackend({ dataDir: t.dataDir, clock, sinks: [ledger], bootId: BOOT, features: ["durable", "inflight", "retention", "execution-records", "strict-input"] });
    const send = (method: string, path: string, body: unknown, key?: string, op?: string) =>
      b.api.send(method, path, body, { ...(key ? { "idempotency-key": key } : {}), ...(op ? { "tiny-tracker-operation": op } : {}) });
    await send("POST", "/tickets", { project: "inbox", title: "a" }, "t3r-key-000001", "op-1");
    await send("POST", "/tickets", { project: "inbox", title: "a" }, "t3r-key-000001", "op-1");
    await send("POST", "/tickets", { project: "inbox", title: "b" }, "t3r-key-000002", "op-2");
    await send("POST", "/tickets/T-1/comments", { body: "c" }, "t3r-key-000003", "op-3");
    await send("PATCH", "/tickets/T-1", { title: "a2" }, undefined, "op-4");
    await send("DELETE", "/tickets/T-2", undefined, undefined, "op-5");
    const files = {
      export: join(t.dir, "export.json"), ledger: join(t.dir, "ledger.json"), executions: join(t.dir, "executions.json"), journal: join(t.dataDir, JOURNAL_FILE),
    };
    writeFileSync(files.export, JSON.stringify(await b.api.export()));
    writeFileSync(files.ledger, JSON.stringify({ entries: ledger.list() }));
    writeFileSync(files.executions, JSON.stringify({ executions: [...b.backend.evidence!.executions()] }));
    await b.close();
    return files;
  }

  const recountOf = (f: Record<string, string>) => {
    const r = spawnSync("python3", ["-I", RECOUNT, "--export", f.export, "--ledger", f.ledger, "--executions", f.executions, "--journal", f.journal, "--principal", "p-default", "--json"], { encoding: "utf8" });
    return { code: r.status, out: r.stdout ? JSON.parse(r.stdout) : null, err: r.stderr };
  };

  it("clean: four sources, no disagreement; the counts agree", { skip: python || process.env.TT_GATE === "1" ? false : "python3 is not installed" }, async () => {
    const t = tempDir("t3r");
    try {
      const r = recountOf(await realRun(t));
      assert.equal(r.code, 0, JSON.stringify(r.out?.problems ?? r.err));
      assert.deepEqual(r.out.sources, ["ledger", "export", "executions", "journal"]);
      assert.deepEqual(r.out.executions, { ledger: 5, executions: 5, journal: 5 });
    } finally {
      t.cleanup();
    }
  });

  it("sabotage: a ledger that loses an execution, a journal line forged with a valid checksum, a line changed without its checksum: each is caught", { skip: python || process.env.TT_GATE === "1" ? false : "python3 is not installed" }, async () => {
    const t = tempDir("t3rs");
    try {
      const f = await realRun(t);
      const cleanLedger = readFileSync(f.ledger, "utf8");
      const cleanJournal = readFileSync(f.journal, "utf8");

      const doc = JSON.parse(cleanLedger);
      const i = doc.entries.findIndex((e: any) => e.kind === "execution" && e.execution_id === "X-3");
      doc.entries.splice(i, 1);
      writeFileSync(f.ledger, JSON.stringify(doc));
      let r = recountOf(f);
      assert.equal(r.code, 1);
      assert.ok(r.out.problems.some((p: string) => /only in the ledger: none; only in executions: \['X-3'\]/.test(p)), r.out.problems.join("; "));
      writeFileSync(f.ledger, cleanLedger);

      // A forged body with a recomputed checksum: the checksum cannot see it; the digest recomputed from the body
      // no longer equals the execution record's served digest.
      const lines = cleanJournal.split("\n");
      const j = lines.findIndex((x) => x.includes('"commit_seq":2,'));
      const l = JSON.parse(lines[j]);
      l.tx.body.ticket.title = "forged";
      delete l.checksum;
      lines[j] = JSON.stringify({ ...l, checksum: lineChecksum(l) });
      writeFileSync(f.journal, lines.join("\n"));
      r = recountOf(f);
      assert.equal(r.code, 1);
      assert.ok(r.out.problems.some((p: string) => /journal X-2: the result digest recomputed from the committed body is not the served one/.test(p)), r.out.problems.join("; "));

      writeFileSync(f.journal, cleanJournal.replace('"title":"a2"', '"title":"zz"'));
      r = recountOf(f);
      assert.equal(r.code, 1);
      assert.ok(r.out.problems.some((p: string) => /journal: line jseq \d+ has a bad jseq or checksum/.test(p)), r.out.problems.join("; "));
    } finally {
      t.cleanup();
    }
  });
});
