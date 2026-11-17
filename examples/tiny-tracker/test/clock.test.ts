// The fixture clock (0.3.0, feature `clock`; PLAN R4, review G7): named clock
// domains, the offset on every event and in the build descriptor, moved only
// on the control listener, and the scored-run posture (wall clock, offset 0,
// control off). Every listener binds port 0.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBackend } from "../src/start.js";
import { FixtureClock, folderOffset, memoryOffset, clockRoute, MAX_STEP_MS, MAX_OFFSET_MS } from "../src/fixture/clock.js";
import { BuildDescriptor } from "../src/fixture/index.js";
import { wallClock } from "../src/clock.js";
import type { CommitSink, CommittedTransaction } from "../src/backend/commit.js";
import { META_KEYS } from "../src/fixture-properties.js";
import { connectClient, Rest } from "./support/stack.js";
import { runCli } from "./support/cli-run.js";

const BACKEND = "backend-token-clock-test-00000000";
const EVIDENCE = "evidence-token-clock-test-0000000";
const CONTROL = "control-token-clock-test-00000000";
const TOKENS = { TRACKER_BACKEND_TOKEN: BACKEND, TRACKER_EVIDENCE_TOKEN: EVIDENCE, TRACKER_CONTROL_TOKEN: CONTROL };
const DAY = 86_400_000;

async function call(method: "GET" | "POST", url: string, token: string | undefined, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, text };
}

describe("the fixture clock (unit)", () => {
  it("is wall time plus an offset that only moves forward, within the caps; wallNow stays wall time", () => {
    let wall = Date.parse("2030-01-01T00:00:00.000Z");
    const clock = new FixtureClock(memoryOffset(), () => wall);
    const moves: unknown[] = [];
    clock.onMove((m) => moves.push(m));
    assert.equal(clock.domain, "fixture");
    assert.equal(clock.offsetMs(), 0);
    assert.equal(clock.now().toISOString(), "2030-01-01T00:00:00.000Z");
    assert.deepEqual(clock.advance(DAY), { from_ms: 0, to_ms: DAY, at: "2030-01-01T00:00:00.000Z" });
    assert.equal(clock.now().toISOString(), "2030-01-02T00:00:00.000Z");
    assert.equal(clock.wallNow().toISOString(), "2030-01-01T00:00:00.000Z", "wall time is not moved");
    wall += 1000;
    assert.equal(clock.now().toISOString(), "2030-01-02T00:00:01.000Z", "the offset clock still runs with wall time");
    for (const bad of [0, -1, 1.5, Number.NaN, MAX_STEP_MS + 1, "1000", undefined]) {
      assert.throws(() => clock.advance(bad as number), /advance_ms must be an integer/, String(bad));
    }
    assert.equal(clock.offsetMs(), DAY, "a refused move changes nothing");
    const capped = new FixtureClock(memoryOffset(MAX_OFFSET_MS - 10), () => wall);
    assert.throws(() => capped.advance(11), /may not pass/);
    assert.equal(capped.advance(10).to_ms, MAX_OFFSET_MS);
    assert.equal(moves.length, 1, "listeners hear each move once");
  });

  it("the folder offset is shared by two clocks (two processes) and survives a new instance (a restart)", () => {
    const dir = mkdtempSync(join(tmpdir(), "tt-clock-"));
    try {
      const writer = new FixtureClock(folderOffset(dir));
      const reader = new FixtureClock(folderOffset(dir));
      assert.equal(reader.offsetMs(), 0, "no file yet: offset 0");
      writer.advance(5 * DAY);
      assert.equal(reader.offsetMs(), 5 * DAY);
      assert.equal(new FixtureClock(folderOffset(dir)).offsetMs(), 5 * DAY);
      assert.equal(statSync(join(dir, "clock.json")).mode & 0o777, 0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the control route: GET and POST with a fixture clock; no answer (fall through) on the wall clock", async () => {
    const clock = new FixtureClock();
    const body = (v: unknown) => async () => v;
    assert.equal(await clockRoute(wallClock, "POST", body({ advance_ms: 1 })), undefined);
    assert.equal((await clockRoute(clock, "GET", body(undefined)))!.status, 200);
    const moved = await clockRoute(clock, "POST", body({ advance_ms: 60_000 }));
    assert.equal(moved!.status, 200);
    assert.equal((moved!.body as any).offset_ms, 60_000);
    assert.equal((moved!.body as any).domain, "fixture");
    assert.equal((await clockRoute(clock, "POST", body({ advance_ms: 1, set_ms: 0 })))!.status, 400, "unknown members are refused");
    assert.equal((await clockRoute(clock, "POST", body([1])))!.status, 400);
    assert.equal((await clockRoute(clock, "POST", body({ advance_ms: -5 })))!.status, 400, "never backwards");
    assert.equal((await clockRoute(clock, "DELETE", body({})))!.status, 405);
    assert.equal(clock.offsetMs(), 60_000);
  });
});

describe("clock domains in the evidence (G7)", () => {
  it("every committed event carries the offset at its commit; record times are in the clock's domain, `at` in wall time", async () => {
    const clock = new FixtureClock();
    const seen: CommittedTransaction[] = [];
    const rec: CommitSink = { name: "rec", role: "observer", onCommit: (tx) => void seen.push(tx) };
    const backend = await startBackend({ token: BACKEND, port: 0, clock, sinks: [rec], bootId: "0123456789abcdef" });
    try {
      const api = new Rest(backend.url, BACKEND);
      const a = await api.createTicket({ project: "inbox", title: "a" });
      clock.advance(7 * DAY);
      const b = await api.createTicket({ project: "inbox", title: "b" });
      assert.deepEqual(seen.map((t) => t.clockOffsetMs), [0, 7 * DAY]);
      assert.deepEqual(seen.map((t) => t.bootId), ["0123456789abcdef", "0123456789abcdef"]);
      const shift = Date.parse(b.created_at) - Date.parse(a.created_at);
      assert.ok(shift >= 7 * DAY && shift < 7 * DAY + 60_000, `created_at moved by the offset (${shift})`);
      assert.deepEqual(seen.map((t) => t.committedAt), [a.created_at, b.created_at], "committedAt is the one record-clock read the write stored");
      assert.equal(b.updated_at, b.created_at);
      const wallShift = Date.parse(seen[1].at) - Date.parse(seen[0].at);
      assert.ok(wallShift >= 0 && wallShift < 60_000, "`at` is wall time");
    } finally {
      await backend.close();
    }
  });

  it("the descriptor names the clock's domain and offset; the offset is not in build_hash", () => {
    const input = { layout: "all" as const, profile: "default" as const, features: ["evidence", "clock"], mcpDefects: [], backendDefects: [], variants: [], control: true };
    const clock = new FixtureClock();
    const d = new BuildDescriptor(input, clock);
    assert.deepEqual(d.toJSON().clock, { domain: "fixture", offset_ms: 0 }, "a fixture clock says so even at offset 0");
    const before = d.toJSON();
    clock.advance(1000);
    const after = d.toJSON();
    assert.deepEqual(after.clock, { domain: "fixture", offset_ms: 1000 });
    assert.equal(after.build_hash, before.build_hash, "known-answer files are keyed by build_hash");
    assert.notEqual(after.descriptor_hash, before.descriptor_hash);
    assert.equal(d.clockOffsetMs, 1000);
    assert.match(d.instructions(), /"clock_offset_ms":1000/);
    const wall = new BuildDescriptor({ ...input, features: ["evidence"], control: false });
    assert.deepEqual(wall.toJSON().clock, { domain: "wall", offset_ms: 0 });
  });
});

describe("the clock feature on the command line", () => {
  it("needs --fixture-control (CMP-60); a build without it runs on wall time with control off: the posture of a scored run", async () => {
    const refused = await runCli(["all", "--features", "evidence,clock"], TOKENS);
    assert.equal(refused.code, 2);
    assert.match(refused.stderr, /the clock feature needs --fixture-control/);
    const scored = await runCli(["all", "--features", "evidence", "--port", "0", "--backend-port", "0"], TOKENS, async (state) => {
      const d = (await call("GET", `${state.backend}/build`, EVIDENCE)).body;
      assert.deepEqual(d.clock, { domain: "wall", offset_ms: 0 });
      assert.equal(d.control.enabled, false);
      assert.ok(!d.features.includes("clock"));
    });
    assert.equal(scored.code, 0, scored.stderr);
  });

  it("moves only on the control listener, with the control token; records, /build and the MCP mirror follow", async () => {
    const r = await runCli(["all", "--features", "evidence,clock", "--fixture-control", "--port", "0", "--backend-port", "0", "--control-port", "0"], TOKENS, async (state) => {
      const c = `${state.control}/_fixture/clock`;
      const start = (await call("GET", c, CONTROL)).body;
      assert.equal(start.domain, "fixture");
      assert.equal(start.offset_ms, 0);
      assert.equal((await call("POST", c, undefined, { advance_ms: DAY })).status, 401);
      assert.equal((await call("POST", c, EVIDENCE, { advance_ms: DAY })).status, 401, "the evidence token cannot move it");
      assert.equal((await call("POST", `${state.backend}/_fixture/clock`, BACKEND, { advance_ms: DAY })).status, 404, "not on the backend listener");
      assert.equal((await call("POST", `${state.backend}/_fixture/clock`, EVIDENCE, { advance_ms: DAY })).status, 401);
      const moved = await call("POST", c, CONTROL, { advance_ms: 3 * DAY });
      assert.equal(moved.status, 200, moved.text);
      assert.equal(moved.body.offset_ms, 3 * DAY);
      assert.equal(Date.parse(moved.body.now) - Date.parse(moved.body.wall_now), 3 * DAY);
      const d = (await call("GET", `${state.backend}/build`, EVIDENCE)).body;
      assert.deepEqual(d.clock, { domain: "fixture", offset_ms: 3 * DAY });
      assert.equal(d.control.enabled, true);
      const t = await new Rest(state.backend, BACKEND).createTicket({ project: "inbox", title: "later" });
      const ahead = Date.parse(t.created_at) - Date.now();
      assert.ok(ahead > 3 * DAY - 60_000 && ahead <= 3 * DAY + 1000, `created_at is in the fixture domain (${ahead})`);
      const mcp = await connectClient(state.mcp, "2026-07-28");
      try {
        assert.match(mcp.client.getInstructions()!, new RegExp(`"clock_offset_ms":${3 * DAY}`));
        const res = await mcp.client.callTool({ name: "list_projects", arguments: {} }) as { _meta?: Record<string, any> };
        assert.equal(res._meta?.[META_KEYS.build]?.build_hash, d.build_hash);
      } finally {
        await mcp.close();
      }
    });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(![BACKEND, EVIDENCE, CONTROL].some((t) => r.stdout.includes(t) || r.stderr.includes(t)));
  });
});
