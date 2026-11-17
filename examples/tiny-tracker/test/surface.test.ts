// The 0.1 surface (design rule 1): --profile 0.1 on this tree reproduces the
// transcript captured from the published 0.1.0 tarball, call for call. Until
// 0.2.0 turns features on by default, the default build reproduces it too.
// See test/support/surface.ts for what the surface covers and what is masked.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { recordSurface, type Transcript } from "./support/surface.js";

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

for (const [label, extraArgs, portBase] of [
  ["--profile 0.1", ["--profile", "0.1"], 4620],
  ["the default build (Phase 0: no feature is default yet)", [], 4622],
] as const) {
  test(`${label} reproduces the published 0.1.0 surface`, { timeout: 120_000 }, async () => {
    const now = await recordSurface({ cli: CLI, extraArgs: [...extraArgs], portBase });
    const { source, ...expected } = golden;
    void source;
    for (let i = 0; i < expected.configs.length; i++) {
      const diff = firstDifference(now.configs[i], expected.configs[i]);
      assert.equal(diff, undefined, `configuration "${expected.configs[i].name}": ${diff}`);
    }
    assert.deepEqual(now, expected);
  });
}
