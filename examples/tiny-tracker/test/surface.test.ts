// The 0.1 surface (design rule 1): --profile 0.1 on this tree reproduces the
// transcript captured from the published 0.1.0 tarball, call for call. From
// 0.2.0 the default profile turns on execution-records, lookup and principals,
// and from 0.3.0 inflight and retention (owner decision 1); its surface is the
// 0.1 surface plus exactly what they add, and that difference is spelled out
// below.
// See test/support/surface.ts for what the surface covers and what is masked.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { recordSurface, SURFACE_CONFIGS, type Transcript } from "./support/surface.js";
import { runCli } from "./support/cli-run.js";
import { DEFAULT_RETENTION_MS, retentionSentence } from "../src/backend/expiry.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const golden = JSON.parse(readFileSync(new URL("../../test/golden/surface-0.1.0.json", import.meta.url), "utf8")) as Transcript & { source: Record<string, string> };

/** The JSON path of the first difference, for a readable failure. */
function firstDifference(a: unknown, b: unknown, path = "$"): string | undefined {
  if (JSON.stringify(a) === JSON.stringify(b)) return undefined;
  if (a && b && typeof a === "object" && typeof b === "object") {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    for (const k of keys) {
      const d = firstDifference((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
      if (d) return d;
    }
  }
  return `${path}: expected ${JSON.stringify(b)?.slice(0, 300)}, got ${JSON.stringify(a)?.slice(0, 300)}`;
}

test("the golden transcript comes from the published 0.1.0 tarball", () => {
  assert.equal(golden.source.package, "@mcp-write-safety/tiny-tracker");
  assert.equal(golden.source.version, "0.1.0");
  assert.match(golden.source.tarball_sha256, /^[0-9a-f]{64}$/);
  assert.ok(golden.configs.length >= 10);
  const calls = golden.configs.reduce((n, c) => n + c.calls.length, 0);
  assert.ok(calls >= 200, `${calls} calls`);
  // Every one of the 16 tools is called at least once in the recorded set.
  const called = new Set(golden.configs.flatMap((c) => c.calls.map((x) => x.tool)));
  const listed = new Set(golden.configs.flatMap((c) => (c.tools as Array<{ name: string }>).map((t) => t.name)));
  assert.equal(listed.size, 16);
  for (const tool of listed) assert.ok(called.has(tool), `${tool} is called`);
});

test("--profile 0.1 reproduces the published 0.1.0 surface", { timeout: 120_000 }, async () => {
  const now = await recordSurface({ cli: CLI, extraArgs: ["--profile", "0.1"], portBase: 4620 });
  const { source, ...expected } = golden;
  void source;
  for (let i = 0; i < expected.configs.length; i++) {
    const diff = firstDifference(now.configs[i], expected.configs[i]);
    assert.equal(diff, undefined, `configuration "${expected.configs[i].name}": ${diff}`);
  }
  assert.deepEqual(now, expected);
});

/** The MCP-layer defects the default's features add to `--defect all` (and to a requirement's defect list). */
const DEFAULT_DEFECTS = ["lookup-reexecutes", "in-progress-reported-not-applied", "settle-miss-reported-not-applied"];
/** 0.3.0, retention: the sentence every key-accepting tool's description gains (the default retention, 7 days). */
const RETENTION = ` ${retentionSentence(DEFAULT_RETENTION_MS)}`;

/**
 * What the default adds to the 0.1 surface, taken back out. 0.2.0: the two read-only lookup tools in tools/list, and the
 * one MCP-layer defect that needs lookup (`lookup-reexecutes`) where `--defect all` or MWS-ANN-1 names every defect.
 * 0.3.0: the retention sentence in each key-accepting tool's description, and the two MCP-layer defects that need
 * inflight. Nothing else may differ: no text, no structured result, no state-line member.
 */
function withoutDefaultAdditions(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .filter((v) => !(v && typeof v === "object" && ["get_operation", "get_execution"].includes((v as { name?: string }).name ?? "")))
      .filter((v) => !DEFAULT_DEFECTS.includes(v as string))
      .map(withoutDefaultAdditions);
  }
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withoutDefaultAdditions(v)]));
  return typeof value === "string" ? DEFAULT_DEFECTS.reduce((t, d) => t.replaceAll(`, ${d}`, ""), value).replaceAll(RETENTION, "") : value;
}

test("the default build (0.3.0) is the 0.1.0 surface plus the lookup tools, the retention sentence and the default's defects, and nothing else", { timeout: 120_000 }, async () => {
  // The key-store-honest variant keeps keys in the MCP server, where a backend lookup cannot see them. Owner decision
  // (16 Nov 2026, CMP-5 option b): with the variant the default's lookup is turned off for that build and the state
  // line says so (features_off); that is its one difference from 0.1.0. A lookup named with the variant is refused.
  const now = await recordSurface({ cli: CLI, extraArgs: [], portBase: 4622 });
  const expected = golden.configs;
  assert.equal(now.configs.length, expected.length);
  for (let i = 0; i < expected.length; i++) {
    const tools = (now.configs[i].tools as Array<{ name: string }>).map((t) => t.name);
    const honest = Boolean(SURFACE_CONFIGS[i].env?.TRACKER_VARIANTS);
    const listsLookup = !honest && !now.configs[i].args.includes("--tools");
    if (listsLookup) assert.ok(tools.includes("get_operation") && tools.includes("get_execution"), now.configs[i].name);
    // retention (0.3.0): every tool that takes an idempotency_key states how long a key is remembered.
    const keyed = (now.configs[i].tools as Array<{ name: string; description?: string; inputSchema?: { properties?: Record<string, unknown> } }>)
      .filter((t) => t.inputSchema?.properties?.idempotency_key !== undefined);
    for (const t of keyed) assert.ok(t.description?.includes(RETENTION), `${now.configs[i].name}: ${t.name} states the retention`);
    if (honest) {
      assert.ok(!tools.includes("get_operation") && !tools.includes("get_execution"), "lookup is off with key-store-honest");
      const start = now.configs[i].start as { stateLine: Record<string, unknown> };
      assert.deepEqual(start.stateLine.features_off, ["lookup off: key-store-honest keeps keys in the MCP server"]);
      delete start.stateLine.features_off;
    }
    const diff = firstDifference(withoutDefaultAdditions(now.configs[i]), expected[i]);
    assert.equal(diff, undefined, `configuration "${expected[i].name}": ${diff}`);
  }
  const named = await runCli(["all", "--features", "lookup", "--port", "0", "--backend-port", "0"], { TRACKER_VARIANTS: "key-store-honest" });
  assert.equal(named.code, 2);
  assert.match(named.stderr, /key-store-honest variant keeps keys in the MCP server/);
});
