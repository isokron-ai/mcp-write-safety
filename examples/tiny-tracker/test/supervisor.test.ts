// `tiny-tracker all --supervise` and the crash fault points (0.3.0, review B7,
// G9): two children, crash points named by process × position × action,
// arming that survives a restart, boot_id and restart_count in the build
// descriptor. Every listener binds port 0; the supervisor keeps the port a
// child first bound, so a restarted child comes back on the same URL.
//
// Arming at run time is the fault controller's (POST /_fixture/faults, stream
// B). Until it lands these tests arm through the supervisor's arming store,
// which is the store that controller writes to.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childArgs, startSupervisor, type Supervisor } from "../src/supervisor.js";
import { ArmingError, childContext, folderArming, memoryArming, CHILD_ENV, childEnvValue } from "../src/supervision.js";
import { backendCrashHooks, mcpCrashOnResult, CRASH_POINTS } from "../src/fixture/process.js";
import { checkCompat, type Combination } from "../src/compat.js";
import type { CommittedTransaction } from "../src/backend/commit.js";
import { META_KEYS } from "../src/fixture-properties.js";
import { connectClient, Rest } from "./support/stack.js";
import { CLI, runCli } from "./support/cli-run.js";

const BACKEND = "backend-token-supervise-test-0000";
const EVIDENCE = "evidence-token-supervise-test-000";
const CONTROL = "control-token-supervise-test-0000";
const TOKENS = { TRACKER_BACKEND_TOKEN: BACKEND, TRACKER_EVIDENCE_TOKEN: EVIDENCE, TRACKER_CONTROL_TOKEN: CONTROL };
const ENV = { PATH: process.env.PATH ?? "", ...TOKENS };
const PORTS = ["--port", "0", "--backend-port", "0", "--control-port", "0"];

async function get(url: string, token: string) {
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, body: await res.json() as any };
}

/** A write whose answer never comes: the process stopped. */
async function lost(p: Promise<unknown>): Promise<void> {
  await assert.rejects(p, (e: Error) => e instanceof TypeError && /fetch failed/.test(e.message), "the connection ends without an answer");
}

const quiet = () => {};

describe("the supervisor's command line handling (unit)", () => {
  it("passes everything but its own flags and the ports on to the children", () => {
    assert.deepEqual(
      childArgs(["--features", "evidence", "--supervise", "--fault", "backend/after-commit/crash:once", "--port=4", "--backend-port", "5", "--control-port", "6", "--defect", "all"]),
      ["--features", "evidence", "--defect", "all"],
    );
    assert.deepEqual(childArgs(["--fault=x", "--read-only", "true"]), ["--read-only", "true"]);
  });

  it("the child context comes from the environment only, and is checked", () => {
    assert.equal(childContext({}), null);
    const dir = mkdtempSync(join(tmpdir(), "tt-sup-ctx-"));
    try {
      const v = childEnvValue({ role: "mcp", stateDir: dir, restartCount: 2, supervisorBootId: "0123456789abcdef" });
      assert.deepEqual(childContext({ [CHILD_ENV]: v }), { role: "mcp", stateDir: dir, restartCount: 2, supervisorBootId: "0123456789abcdef" });
      assert.throws(() => childContext({ [CHILD_ENV]: "{" }), /not valid JSON/);
      assert.throws(() => childContext({ [CHILD_ENV]: JSON.stringify({ role: "both", state_dir: dir, restart_count: 0, supervisor_boot_id: "0123456789abcdef" }) }), /malformed/);
      assert.throws(() => childContext({ [CHILD_ENV]: JSON.stringify({ role: "mcp", state_dir: join(dir, "nope"), restart_count: 0, supervisor_boot_id: "0123456789abcdef" }) }), /does not exist/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the compatibility table: --supervise with `all` only, not under profile 0.1; crash points need --supervise", () => {
    const base: Combination = { layout: "all", profile: "default", features: [], defects: [], backendDefects: [], variants: [], faults: [], fixtureControl: false };
    assert.deepEqual(checkCompat({ ...base, supervise: true }), []);
    assert.match(checkCompat({ ...base, layout: "backend", supervise: true }).join(), /--supervise runs with `tiny-tracker all` only/);
    assert.match(checkCompat({ ...base, profile: "0.1", supervise: true }).join(), /profile 0.1 takes no --supervise/);
    assert.match(checkCompat({ ...base, faults: ["backend/after-commit/crash"] }).join(), /need tiny-tracker all --supervise/);
    assert.deepEqual(checkCompat({ ...base, faults: ["backend/after-commit/crash"], supervise: true }).filter((m) => /need tiny-tracker all --supervise/.test(m)), []);
    assert.match(checkCompat({ ...base, features: ["clock"] }).join(), /clock feature needs --fixture-control/);
  });

  it("the command line refuses the illegal combinations with exit 2", async () => {
    for (const [args, message] of [
      [["backend", "--supervise"], /--supervise runs with `tiny-tracker all` only/],
      [["all", "--profile", "0.1", "--supervise"], /profile 0.1 takes no --supervise/],
      [["all", "--fault", "backend/after-commit/crash:once"], /need tiny-tracker all --supervise/],
      // 0.3.0: the crash points are built; arming at start needs the faults feature (CMP-7), and under --supervise
      // --fault names crash points only (CMP-64).
      [["all", "--supervise", "--fault", "backend/after-commit/crash:once"], /a fault armed at start needs the faults feature/],
      [["all", "--supervise", "--features", "evidence,strict-input,ledger,faults", "--fixture-control", "--fault", "mcp/after-backend-reply/drop"], /--fault names crash points only/],
    ] as const) {
      const r = await runCli([...args], TOKENS);
      assert.equal(r.code, 2, args.join(" "));
      assert.match(r.stderr, message, args.join(" "));
      assert.equal(r.stdout, "");
    }
  });
});

describe("arming stores (unit)", () => {
  it("in memory (one process) a crash point cannot be armed", () => {
    const a = memoryArming();
    assert.throws(() => a.arm({ point: CRASH_POINTS.backendAfterCommit, once: true }), (e: unknown) => e instanceof ArmingError && e.code === "needs_supervise");
    a.arm({ point: "mcp/after-backend-reply/drop", once: true });
    assert.ok(a.take("mcp/after-backend-reply/drop", { at: "t", boot_id: null, seq: null }));
    assert.equal(a.take("mcp/after-backend-reply/drop", { at: "t", boot_id: null, seq: null }), undefined, "once");
  });

  it("in the state folder: shared by two stores (two processes); a once fault fires exactly once, and the firing is kept", () => {
    const dir = mkdtempSync(join(tmpdir(), "tt-sup-arm-"));
    try {
      const sup = folderArming(dir);
      const childA = folderArming(dir);
      const childB = folderArming(dir);
      sup.arm({ point: CRASH_POINTS.backendAfterCommit, once: true });
      sup.arm({ point: CRASH_POINTS.mcpAfterBackendReply, once: false });
      assert.deepEqual(childA.list().map((f) => f.point).sort(), [CRASH_POINTS.backendAfterCommit, CRASH_POINTS.mcpAfterBackendReply].sort());
      const first = childA.take(CRASH_POINTS.backendAfterCommit, { at: "t1", boot_id: "aaaaaaaaaaaaaaaa", seq: 3 });
      const second = childB.take(CRASH_POINTS.backendAfterCommit, { at: "t2", boot_id: "bbbbbbbbbbbbbbbb", seq: 4 });
      assert.ok(first);
      assert.equal(second, undefined);
      assert.ok(childB.take(CRASH_POINTS.mcpAfterBackendReply, { at: "t3", boot_id: null, seq: null }), "not once: stays armed");
      assert.ok(childA.take(CRASH_POINTS.mcpAfterBackendReply, { at: "t4", boot_id: null, seq: null }));
      assert.deepEqual(folderArming(dir).list().map((f) => f.point), [CRASH_POINTS.mcpAfterBackendReply], "a new store (a restarted child) sees the same state");
      assert.deepEqual(sup.firings().map((f) => [f.point, f.seq]), [[CRASH_POINTS.backendAfterCommit, 3], [CRASH_POINTS.mcpAfterBackendReply, null], [CRASH_POINTS.mcpAfterBackendReply, null]]);
      assert.equal(sup.disarm(CRASH_POINTS.mcpAfterBackendReply), true);
      assert.equal(sup.disarm(CRASH_POINTS.mcpAfterBackendReply), false);
      assert.deepEqual(childA.list(), []);
      assert.throws(() => sup.arm({ point: "../../etc", once: true }), /process\/position\/action/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("in the state folder: firings in the same millisecond from two stores are all kept (none replaces another)", (t) => {
    // CI once ran the test above inside one millisecond: two stores each counted their firings from 1, so the second
    // store's first firing got the name of the first store's, and replaced it. The clock is pinned here so the
    // collision is not left to timing.
    const now = Date.now();
    t.mock.method(Date, "now", () => now);
    const dir = mkdtempSync(join(tmpdir(), "tt-sup-arm-ms-"));
    try {
      const sup = folderArming(dir);
      const childA = folderArming(dir);
      const childB = folderArming(dir);
      sup.arm({ point: CRASH_POINTS.backendAfterCommit, once: true });
      sup.arm({ point: CRASH_POINTS.mcpAfterBackendReply, once: false });
      assert.ok(childA.take(CRASH_POINTS.backendAfterCommit, { at: "t1", boot_id: "aaaaaaaaaaaaaaaa", seq: 3 }));
      assert.equal(childB.take(CRASH_POINTS.backendAfterCommit, { at: "t2", boot_id: "bbbbbbbbbbbbbbbb", seq: 4 }), undefined);
      assert.ok(childB.take(CRASH_POINTS.mcpAfterBackendReply, { at: "t3", boot_id: null, seq: null }));
      assert.ok(childA.take(CRASH_POINTS.mcpAfterBackendReply, { at: "t4", boot_id: null, seq: null }));
      assert.deepEqual(sup.firings().map((f) => f.at), ["t1", "t3", "t4"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("crash points through the fault hooks (unit, with a stand-in for exit)", () => {
  class Stopped extends Error {}
  const tx = { seq: 7 } as CommittedTransaction;

  it("the backend hooks: before-commit fires with no commit sequence, after-commit names tx.seq; the firing is reported first; other hooks run after", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tt-sup-crash-"));
    try {
      const arming = folderArming(dir);
      const order: string[] = [];
      const options = {
        arming, bootId: "0123456789abcdef", wallNow: () => new Date(0),
        onFire: (f: { point: string; seq: number | null }) => void order.push(`fired ${f.point} @${f.seq}`),
        stop: (): never => { order.push("stopped"); throw new Stopped(); },
      };
      const hooks = backendCrashHooks(options, {
        beforeCommit: async () => void order.push("next before"),
        afterCommit: async () => { order.push("next after"); return "drop" as const; },
      });
      const meta = {} as never;
      await hooks.beforeCommit!({ meta });
      assert.equal(await hooks.afterCommit!({ meta, tx }), "drop", "nothing armed: the controller's hooks decide");
      assert.deepEqual(order, ["next before", "next after"]);
      order.length = 0;
      arming.arm({ point: CRASH_POINTS.backendBeforeCommit, once: true });
      await assert.rejects(hooks.beforeCommit!({ meta }), Stopped);
      assert.deepEqual(order, [`fired ${CRASH_POINTS.backendBeforeCommit} @null`, "stopped"], "the controller's hook is not reached");
      order.length = 0;
      await hooks.beforeCommit!({ meta });
      assert.deepEqual(order, ["next before"], "consumed: the next write goes through");
      order.length = 0;
      arming.arm({ point: CRASH_POINTS.backendAfterCommit, once: true });
      await assert.rejects(hooks.afterCommit!({ meta, tx }), Stopped);
      assert.deepEqual(order, [`fired ${CRASH_POINTS.backendAfterCommit} @7`, "stopped"]);
      assert.equal(await backendCrashHooks(options).afterCommit!({ meta, tx }), undefined, "with no controller: send the reply");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the MCP point runs in front of the fault controller's onResult", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tt-sup-mcp-"));
    try {
      const arming = folderArming(dir);
      let stopped = 0;
      const onResult = mcpCrashOnResult({ arming, bootId: null, wallNow: () => new Date(0), stop: (): never => { stopped++; throw new Stopped(); } },
        async (_tool, r) => ({ wrapped: r }));
      assert.deepEqual(await onResult("create_ticket", 1, {}), { wrapped: 1 });
      arming.arm({ point: CRASH_POINTS.mcpAfterBackendReply, once: true });
      await assert.rejects(onResult("create_ticket", 2, {}), Stopped);
      assert.equal(stopped, 1);
      assert.deepEqual(await onResult("create_ticket", 3, {}), { wrapped: 3 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("tiny-tracker all --supervise", () => {
  const ARGS = ["--features", "evidence", "--fixture-control", ...PORTS];

  async function supervised(args: string[], fn: (sup: Supervisor, lines: Record<string, unknown>[], errors: string[]) => Promise<void>, extra: Partial<Parameters<typeof startSupervisor>[0]> = {}) {
    const lines: Record<string, unknown>[] = [];
    const errors: string[] = [];
    const sup = await startSupervisor({ cli: CLI, args, env: ENV, onLine: (l) => void lines.push(l), onStderr: (t) => void errors.push(t), ...extra });
    try {
      await fn(sup, lines, errors);
    } finally {
      await sup.close();
    }
    assert.equal(existsSync(sup.stateDir), false, "the state folder is removed");
    const all = JSON.stringify(lines) + errors.join("");
    assert.ok(![BACKEND, EVIDENCE, CONTROL].some((t) => all.includes(t)), "no token printed");
  }

  it("two children; /build is the readiness endpoint, with both boot ids and restart counts; the build hash is the one `all` has", async () => {
    let plainHash = "";
    await runCli(["all", ...ARGS], TOKENS, async (state) => {
      plainHash = (await get(`${state.backend}/build`, EVIDENCE)).body.build_hash;
    });
    await supervised(ARGS, async (sup, lines) => {
      assert.equal(lines.length, 1);
      const line = lines[0] as any;
      assert.match(line.backend, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.match(line.mcp, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
      assert.match(line.control, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.equal(line.evidence, `${line.backend}/build`);
      assert.deepEqual(line.supervise.restarts, { backend: 0, mcp: 0 });
      assert.equal(line.supervise.boot_id, sup.bootId);
      assert.notEqual(sup.pids.backend, sup.pids.mcp);
      assert.ok(sup.pids.backend && sup.pids.mcp && sup.pids.backend !== process.pid);
      const d = (await get(`${line.backend}/build`, EVIDENCE)).body;
      assert.equal(d.build_hash, plainHash, "supervision does not change the configuration");
      assert.equal(d.process.layout, "all");
      assert.equal(d.process.restart_count, 0);
      assert.equal(d.process.boot_id, line.supervise.boot_ids.backend);
      assert.notEqual(d.config, null, "the backend child serves the MCP child's settings");
      assert.deepEqual(d.supervision, {
        supervisor_boot_id: sup.bootId, role: "backend",
        children: { backend: { boot_id: line.supervise.boot_ids.backend, restart_count: 0 }, mcp: { boot_id: line.supervise.boot_ids.mcp, restart_count: 0 } },
      });
      const mcp = await connectClient(line.mcp, "2026-07-28");
      try {
        const res = await mcp.client.callTool({ name: "list_projects", arguments: {} }) as { _meta?: Record<string, any> };
        assert.equal(res._meta?.[META_KEYS.build]?.build_hash, plainHash);
        assert.equal(res._meta?.[META_KEYS.build]?.boot_id, line.supervise.boot_ids.mcp);
      } finally {
        await mcp.close();
      }
    });
  });

  it("backend crash points: the backend restarts on the same port, the MCP child stays; a once fault does not re-arm", async () => {
    await supervised(ARGS, async (sup, lines, errors) => {
      const first = lines[0] as any;
      const api = new Rest(first.backend, BACKEND);
      const mcpPid = sup.pids.mcp;

      // after-commit: written, then the process stops before the answer.
      sup.arming.arm({ point: CRASH_POINTS.backendAfterCommit, once: true });
      let d = (await get(`${first.backend}/build`, EVIDENCE)).body;
      assert.deepEqual(d.faults.armed, [`S-1 ${CRASH_POINTS.backendAfterCommit} {"once":true}`], "/build shows the arming (id point selector)");
      await lost(api.send("POST", "/tickets", { project: "inbox", title: "a" }));
      const second = await sup.restarted("backend", 1) as any;
      assert.equal(second.restarted, "backend");
      assert.equal(second.backend, first.backend, "same URL");
      assert.deepEqual(second.supervise.restarts, { backend: 1, mcp: 0 });
      assert.notEqual(second.supervise.boot_ids.backend, first.supervise.boot_ids.backend);
      assert.equal(second.supervise.boot_ids.mcp, first.supervise.boot_ids.mcp);
      assert.equal(sup.pids.mcp, mcpPid, "the MCP child was not restarted");
      d = (await get(`${first.backend}/build`, EVIDENCE)).body;
      assert.equal(d.process.restart_count, 1);
      assert.equal(d.process.boot_id, second.supervise.boot_ids.backend);
      assert.deepEqual(d.faults.armed, [], "consumed before the process stopped");
      assert.equal(d.supervision.children.backend.restart_count, 1);
      assert.deepEqual(sup.arming.firings().map((f) => [f.point, f.seq, f.boot_id]), [[CRASH_POINTS.backendAfterCommit, 1, first.supervise.boot_ids.backend]],
        "the firing names the commit and the process generation it stopped");
      assert.ok(errors.join("").includes(`fault ${CRASH_POINTS.backendAfterCommit} fired at commit 1`));
      assert.equal((await api.send("POST", "/tickets", { project: "inbox", title: "b" })).status, 201, "no crash loop");

      // before-commit: nothing is written.
      sup.arming.arm({ point: CRASH_POINTS.backendBeforeCommit, once: true });
      await lost(api.send("POST", "/tickets", { project: "inbox", title: "c" }));
      await sup.restarted("backend", 2);
      assert.equal((await api.send("POST", "/tickets", { project: "inbox", title: "d" })).status, 201);
      // Memory mode: the restarted backend starts empty (the persistence gap; the durable feature keeps it).
      assert.deepEqual((await api.export()).tickets.map((t) => t.title), ["d"]);
      assert.equal(lines.length, 3);
    });
  });

  it("the MCP crash point: the backend committed and stays up; the MCP child restarts; the client never hears (the lost response)", async () => {
    await supervised(ARGS, async (sup, lines) => {
      const first = lines[0] as any;
      const backendPid = sup.pids.backend;
      sup.arming.arm({ point: CRASH_POINTS.mcpAfterBackendReply, once: true });
      const mcp = await connectClient(first.mcp, "2026-07-28");
      try {
        const r = await mcp.call("create_ticket", { title: "lost answer", idempotency_key: "sup-mcp-crash-0001" });
        assert.equal(r.isError, true, "no answer reached the client");
        assert.ok(r.protocolError, "a transport failure, not a tool result");
      } finally {
        await mcp.close().catch(() => {});
      }
      const second = await sup.restarted("mcp", 1) as any;
      assert.equal(second.restarted, "mcp");
      assert.equal(second.mcp, first.mcp);
      assert.equal(sup.pids.backend, backendPid, "the backend was not restarted");
      const tickets = (await new Rest(first.backend, BACKEND).export()).tickets;
      assert.deepEqual(tickets.map((t) => t.title), ["lost answer"], "the write was applied");
      const again = await connectClient(first.mcp, "2026-07-28");
      try {
        const retry = await again.call("create_ticket", { title: "lost answer", idempotency_key: "sup-mcp-crash-0001" });
        assert.equal(retry.isError, false, retry.text);
        const res = retry.raw as { _meta?: Record<string, any> };
        assert.equal(res._meta?.[META_KEYS.build]?.boot_id, second.supervise.boot_ids.mcp);
      } finally {
        await again.close();
      }
      assert.equal((await new Rest(first.backend, BACKEND).export()).tickets.length, 1, "the keyed retry is answered from the key record");
      const d = (await get(`${first.backend}/build`, EVIDENCE)).body;
      assert.equal(d.process.restart_count, 0);
      assert.equal(d.supervision.children.mcp.restart_count, 1);
      assert.equal(d.supervision.children.mcp.boot_id, second.supervise.boot_ids.mcp);
    });
  });

  it("faults given at start are armed once by the supervisor, not passed on; the fixture clock offset survives a restart", async () => {
    const args = ["--features", "evidence,clock", "--fixture-control", ...PORTS];
    await supervised(args, async (sup, lines) => {
      const first = lines[0] as any;
      const moved = await fetch(`${first.control}/_fixture/clock`, {
        method: "POST", headers: { authorization: `Bearer ${CONTROL}`, "content-type": "application/json" }, body: JSON.stringify({ advance_ms: 3_600_000 }),
      });
      assert.equal(moved.status, 200);
      await lost(new Rest(first.backend, BACKEND).send("POST", "/tickets", { project: "inbox", title: "a" }));
      await sup.restarted("backend", 1);
      const d = (await get(`${first.backend}/build`, EVIDENCE)).body;
      assert.deepEqual(d.clock, { domain: "fixture", offset_ms: 3_600_000 });
      assert.deepEqual(d.faults.armed, []);
      const mcp = await connectClient(first.mcp, "2026-07-28");
      try {
        assert.match(mcp.client.getInstructions()!, /"clock_offset_ms":3600000/, "the MCP child reads the same offset");
      } finally {
        await mcp.close();
      }
    }, { faults: [{ point: CRASH_POINTS.backendAfterCommit, once: true }] });
  });

  it("a child that keeps stopping stops the supervisor (X5 cap)", async () => {
    let fatal = "";
    const lines: Record<string, unknown>[] = [];
    const sup = await startSupervisor({
      cli: CLI, args: ARGS, env: ENV, maxRestarts: 2, onLine: (l) => void lines.push(l), onStderr: quiet, onFatal: (m) => { fatal = m; },
      faults: [{ point: CRASH_POINTS.backendAfterCommit, once: false }],
    });
    try {
      const api = new Rest((lines[0] as any).backend, BACKEND);
      for (let i = 0; i < 3; i++) {
        await lost(api.send("POST", "/tickets", { project: "inbox", title: `x${i}` }));
        if (i < 2) await sup.restarted("backend", i + 1);
      }
      for (let i = 0; i < 100 && !fatal; i++) await new Promise((r) => setTimeout(r, 50));
      assert.match(fatal, /backend child stopped 3 times; at most 2 restarts/);
      assert.equal(existsSync(sup.stateDir), false);
    } finally {
      await sup.close();
    }
  });

  it("the command: state lines on stdout, a child that cannot start stops the start with its exit code, SIGTERM stops both", async () => {
    const bad = await runCli(["all", "--supervise", ...PORTS], { ...TOKENS, TRACKER_VARIANTS: "no-such-variant" });
    assert.equal(bad.code, 2, bad.stderr);
    assert.match(bad.stderr, /unknown variant/);
    assert.match(bad.stderr, /mcp child stopped before it was ready/);

    const child = spawn(process.execPath, [CLI, "--supervise", "all", "--features", "evidence", ...PORTS], { env: ENV });
    let out = "";
    let err = "";
    child.stderr.on("data", (d) => { err += d; });
    const line = await new Promise<any>((resolve) => child.stdout.on("data", (d) => {
      out += d;
      if (out.includes("\n")) resolve(JSON.parse(out.split("\n")[0]));
    }));
    assert.deepEqual(line.supervise.restarts, { backend: 0, mcp: 0 });
    assert.ok(line.features.includes("evidence"), "the 0.2.0 default features come first");
    const d = (await get(`${line.backend}/build`, EVIDENCE)).body;
    assert.equal(d.supervision.supervisor_boot_id, line.supervise.boot_id);
    const code = await new Promise<number | null>((resolve) => { child.on("exit", resolve); child.kill("SIGTERM"); });
    assert.equal(code, 0, err);
    await assert.rejects(fetch(`${line.backend}/build`), "the backend child is gone");
    await assert.rejects(fetch(line.mcp), "the MCP child is gone");
    assert.ok(![BACKEND, EVIDENCE, CONTROL].some((t) => out.includes(t) || err.includes(t)));
  });
});
