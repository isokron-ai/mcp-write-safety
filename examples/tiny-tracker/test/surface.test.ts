// The 0.1 surface (design rule 1): --profile 0.1 on this tree reproduces the
// transcript captured from the published 0.1.0 tarball, call for call. From
// 0.2.0 the default profile turns on execution-records, lookup and principals
// (owner decision 1); its surface is the 0.1 surface plus exactly what they
// add, and that difference is spelled out below.
// See test/support/surface.ts for what the surface covers and what is masked.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { recordSurface, SURFACE_CONFIGS, type Transcript } from "./support/surface.js";
import { runCli } from "./support/cli-run.js";

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

/**
 * What the 0.2.0 default adds to the 0.1 surface, taken back out: the two read-only lookup tools in tools/list, and the
 * one MCP-layer defect that needs lookup (`lookup-reexecutes`) where `--defect all` or MWS-ANN-1 names every defect.
 * Nothing else may differ: no text, no structured result, no state-line member.
 */
function withoutDefaultAdditions(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .filter((v) => !(v && typeof v === "object" && ["get_operation", "get_execution"].includes((v as { name?: string }).name ?? "")))
      .filter((v) => v !== "lookup-reexecutes")
      .map(withoutDefaultAdditions);
  }
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withoutDefaultAdditions(v)]));
  return typeof value === "string" ? value.replaceAll(", lookup-reexecutes", "") : value;
}

test("the default build (0.2.0) is the 0.1.0 surface plus the lookup tools and the lookup defect, and nothing else", { timeout: 120_000 }, async () => {
  // The key-store-honest variant keeps keys in the MCP server, where the default's lookup cannot see them: CMP-5 refuses
  // the pair, so that configuration runs under --profile 0.1 only (checked below).
  const configs = SURFACE_CONFIGS.filter((c) => !c.env?.TRACKER_VARIANTS);
  const now = await recordSurface({ cli: CLI, extraArgs: [], portBase: 4622, configs });
  const expected = golden.configs.filter((c) => configs.some((x) => x.name === c.name));
  assert.equal(now.configs.length, expected.length);
  for (let i = 0; i < expected.length; i++) {
    const tools = (now.configs[i].tools as Array<{ name: string }>).map((t) => t.name);
    const listsLookup = !now.configs[i].args.includes("--tools");
    if (listsLookup) assert.ok(tools.includes("get_operation") && tools.includes("get_execution"), now.configs[i].name);
    const diff = firstDifference(withoutDefaultAdditions(now.configs[i]), expected[i]);
    assert.equal(diff, undefined, `configuration "${expected[i].name}": ${diff}`);
  }
  const honest = await runCli(["all", "--port", "0", "--backend-port", "0"], { TRACKER_VARIANTS: "key-store-honest" });
  assert.equal(honest.code, 2);
  assert.match(honest.stderr, /key-store-honest variant keeps keys in the MCP server/);
});
