// Captures the 0.1 surface transcript from a tiny-tracker package (not a test).
//
//   node dist/test/capture-surface.js <package dir> <out.json> <tarball sha256> <npm integrity>
//
// The package dir is an unpacked, installed copy of the published tarball,
// e.g. after `npm pack @mcp-write-safety/tiny-tracker@0.1.0` into a fresh
// directory, `tar -xzf`, and `npm install --omit=dev --ignore-scripts` there.
// It records twice and writes nothing unless both records are identical.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { recordSurface } from "./support/surface.js";

async function main(): Promise<void> {
  const [pkgDir, outPath, sha256, integrity] = process.argv.slice(2);
  if (!pkgDir || !outPath || !sha256 || !integrity) {
    process.stderr.write("usage: capture-surface <package dir> <out.json> <tarball sha256> <npm integrity>\n");
    process.exit(2);
  }
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as { name: string; version: string };
  const cli = join(pkgDir, "dist/src/cli.js");
  const first = await recordSurface({ cli, portBase: 4610 });
  const second = await recordSurface({ cli, portBase: 4612 });
  if (!isDeepStrictEqual(first, second)) {
    process.stderr.write("the two records differ: the scenario set is not deterministic against this package; nothing written\n");
    process.exit(1);
  }
  const doc = {
    source: { package: pkg.name, version: pkg.version, tarball_sha256: sha256, npm_integrity: integrity, node: process.version },
    ...first,
  };
  writeFileSync(outPath, `${JSON.stringify(doc, null, 2)}\n`);
  process.stdout.write(`wrote ${outPath}: ${first.configs.length} configurations, ${first.configs.reduce((n, c) => n + c.calls.length, 0)} calls\n`);
}

main().catch((e) => {
  process.stderr.write(`${(e as Error).stack}\n`);
  process.exit(1);
});
