#!/usr/bin/env node
// Selects the builds of the 0.4.0 known-answer matrix (expected/builds-0.4.0.json): a pairwise covering set over four
// factors, chosen deterministically from the built tree, never by hand.
//
//   features      four feature levels, every one with the evidence namespace (the generator reads GET /build):
//                   L2   the 0.2.0 evidence set (evidence, strict-input, execution-records, lookup, principals,
//                        ledger, faults)
//                   L3   L2 with the 0.3.0 in-memory features (inflight, retention, clock)
//                   L3d  L2 with inflight, retention, clock and durable, on a data dir of the row's own ({DATA_DIR});
//                        the journal keeps the fixture clock's offset (0.4.0, clock lines), so FX-KEY-1 runs there
//                   Lv   evidence, strict-input, ledger, faults, clock: lookup and the other core features only from
//                        the default profile, so the key-store variants that turn lookup off can run (CMP-5, CMP-53);
//                        the fixture clock so FX-KEY-1 is checked there (coordinator note 26 item 7)
//   mcp defect    none, or one of the MCP-layer defects (src/defects)
//   backend       none, or one of the backend defects (src/backend/defects)
//   variant       none, or one of the variants (src/variants)
//
// Every pair of values from two factors that some legal build can hold appears in at least one row. Legal: the
// compatibility table (src/compat.ts) refuses nothing, each defect's `requires` is met by the effective features, a
// backend defect's refusals are empty, and the matrix-only needs (MATRIX_NEEDS) are met. The rows are picked greedily (the candidate that covers the most uncovered
// pairs; ties go to the first in a fixed order), after the seed rows: the 0.2.0 build list (which the contract driver
// runs) and one correct build per level. Nothing depends on the time, the machine or a random number, so --check
// selects again and compares with the committed list byte for byte.
//
//   node expected/select-0.4.0.mjs [--out expected/builds-0.4.0.json] [--check]
//
// Needs a build (npm run build).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = (p) => import(pathToFileURL(join(ROOT, "dist", "src", p)).href);

const EVIDENCE_02 = ["evidence", "strict-input", "execution-records", "lookup", "principals", "ledger", "faults"];
export const LEVELS = [
  { id: "L2", features: EVIDENCE_02, dataDir: false },
  { id: "L3", features: [...EVIDENCE_02, "inflight", "retention", "clock"], dataDir: false },
  // 0.4.0 (note 19 item 7): the journal keeps the clock's offset, so durable runs with the fixture clock (CMP-65 retired).
  { id: "L3d", features: [...EVIDENCE_02, "inflight", "retention", "clock", "durable"], dataDir: true },
  // Note 26 item 7: the fixture clock, so key-expires-early (MATRIX_NEEDS) is checked by FX-KEY-1 on Lv rows too.
  { id: "Lv", features: ["evidence", "strict-input", "ledger", "faults", "clock"], dataDir: false },
];

/** Variants that keep a journal of used keys (TRACKER_KEY_JOURNAL, src/variants). */
const KEY_JOURNAL_VARIANTS = ["key-store-honest", "key-store-durable"];

/**
 * Matrix-only placement needs, on top of a defect's own `requires` (coordinator note 26 item 7): FX-KEY-1 needs the
 * fixture clock, so key-expires-early is placed only where it can be checked. The CLI still allows the defect without
 * the clock.
 */
const MATRIX_NEEDS = { "key-expires-early": ["clock"] };

export async function select() {
  const { DEFECTS } = await dist("defects/index.js");
  const { BACKEND_DEFECTS, backendDefectRefusals } = await dist("backend/defects/index.js");
  const { VARIANTS } = await dist("variants/index.js");
  const { checkCompat } = await dist("compat.js");
  const { effectiveFeatures } = await dist("profile.js");
  const NONE = "-";
  const factors = {
    level: LEVELS.map((l) => l.id),
    mcp: [NONE, ...DEFECTS.map((d) => d.name)],
    backend: [NONE, ...BACKEND_DEFECTS.map((d) => d.name)],
    variant: [NONE, ...VARIANTS],
  };
  const names = Object.keys(factors);

  const legal = (row) => {
    const level = LEVELS.find((l) => l.id === row.level);
    const variants = row.variant === NONE ? [] : [row.variant];
    const mcp = row.mcp === NONE ? [] : [row.mcp];
    const backend = row.backend === NONE ? [] : [row.backend];
    const { features } = effectiveFeatures("default", level.features, variants);
    const refusals = checkCompat({ layout: "all", profile: "default", features: level.features, defects: mcp, backendDefects: backend, variants,
      faults: [], fixtureControl: true, ...(level.dataDir ? { dataDir: "{DATA_DIR}" } : {}), transport: "http" });
    if (refusals.length) return false;
    for (const name of mcp) if (!(DEFECTS.find((d) => d.name === name).requires ?? []).every((f) => features.includes(f))) return false;
    if (backendDefectRefusals(backend, { features }).length) return false;
    for (const name of [...mcp, ...backend]) if (!(MATRIX_NEEDS[name] ?? []).every((f) => features.includes(f))) return false;
    return true;
  };

  // Every candidate row, in a fixed order, and the pairs each covers.
  const candidates = [];
  for (const level of factors.level) for (const variant of factors.variant) for (const backend of factors.backend) for (const mcp of factors.mcp) {
    const row = { level, mcp, backend, variant };
    if (legal(row)) candidates.push(row);
  }
  const pairsOf = (row) => {
    const out = [];
    for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) out.push(`${names[i]}=${row[names[i]]}|${names[j]}=${row[names[j]]}`);
    return out;
  };
  const uncovered = new Set(candidates.flatMap(pairsOf));
  const coverable = uncovered.size;
  const chosen = [];
  const take = (row, why) => {
    for (const p of pairsOf(row)) uncovered.delete(p);
    chosen.push({ ...row, why });
  };

  // Seeds: one correct build per level, and the 0.2.0 list's builds (the contract driver runs those).
  for (const level of factors.level) {
    const row = { level, mcp: NONE, backend: NONE, variant: NONE };
    if (legal(row)) take(row, "seed");
  }
  const old = JSON.parse(readFileSync(join(ROOT, "expected", "builds-0.2.0.json"), "utf8"));
  const contractRows = new Set();
  for (const b of old.builds) {
    const at = (flag) => { const i = b.args.indexOf(flag); return i >= 0 ? b.args[i + 1] : undefined; };
    const row = { level: "L2", mcp: at("--defect") ?? NONE, backend: at("--backend-defect") ?? NONE, variant: NONE };
    if (!legal(row)) throw new Error(`the 0.2.0 build ${b.label} is not legal at level L2`);
    if (b.contract) contractRows.add(`${row.level}/${row.mcp}/${row.backend}/${row.variant}`);
    if (!chosen.some((c) => c.level === row.level && c.mcp === row.mcp && c.backend === row.backend && c.variant === row.variant)) take(row, "seed 0.2.0");
  }
  // Greedy: the candidate covering the most uncovered pairs; ties to the first in the fixed order.
  while (uncovered.size) {
    let best;
    let bestCount = 0;
    for (const row of candidates) {
      let n = 0;
      for (const p of pairsOf(row)) if (uncovered.has(p)) n++;
      if (n > bestCount) { best = row; bestCount = n; }
    }
    take(best, "pairwise");
  }

  const builds = chosen.map((r) => {
    const level = LEVELS.find((l) => l.id === r.level);
    const args = ["--features", level.features.join(",")];
    if (level.dataDir) args.push("--data-dir", "{DATA_DIR}");
    if (r.mcp !== NONE) args.push("--defect", r.mcp);
    if (r.backend !== NONE) args.push("--backend-defect", r.backend);
    const label = [r.level, r.mcp === NONE ? null : `defect ${r.mcp}`, r.backend === NONE ? null : `backend ${r.backend}`,
      r.variant === NONE ? null : `variant ${r.variant}`].filter(Boolean).join(", ") + (r.mcp === NONE && r.backend === NONE && r.variant === NONE ? " correct build" : "");
    return {
      // The key-store variants keep their journal of used keys in a file of the row's own ({WORK}).
      label, args, ...(r.variant !== NONE ? { env: { TRACKER_VARIANTS: r.variant, ...(KEY_JOURNAL_VARIANTS.includes(r.variant) ? { TRACKER_KEY_JOURNAL: "{WORK}/keys.journal" } : {}) } } : {}),
      factors: { level: r.level, mcp: r.mcp, backend: r.backend, variant: r.variant },
      contract: contractRows.has(`${r.level}/${r.mcp}/${r.backend}/${r.variant}`), fixture: true,
    };
  });
  return {
    release: "0.4.0",
    note: "Selected by expected/select-0.4.0.mjs (pairwise over feature level, MCP-layer defect, backend defect and variant; legal per src/compat.ts, each defect's requires and the selector's matrix-only needs). Do not edit by hand.",
    coverage: { factors: Object.fromEntries(names.map((n) => [n, factors[n].length])), legal_candidates: candidates.length, pairs: coverable, builds: builds.length },
    levels: Object.fromEntries(LEVELS.map((l) => [l.id, l.features.join(",") + (l.dataDir ? " --data-dir {DATA_DIR}" : "")])),
    builds,
  };
}

async function main() {
  const { values } = parseArgs({ options: { out: { type: "string" }, check: { type: "boolean" } } });
  if (!existsSync(join(ROOT, "dist", "src", "compat.js"))) { process.stderr.write("select-0.4.0.mjs: build first (npm run build)\n"); return 2; }
  const out = values.out ?? join(ROOT, "expected", "builds-0.4.0.json");
  const text = `${JSON.stringify(await select(), null, 2)}\n`;
  if (values.check) {
    const same = existsSync(out) && readFileSync(out, "utf8") === text;
    process.stdout.write(same ? `${out}: selected again, byte for byte\n` : `${out}: differs from a fresh selection\n`);
    return same ? 0 : 1;
  }
  writeFileSync(out, text);
  const doc = JSON.parse(text);
  process.stdout.write(`${out}: ${doc.builds.length} builds cover ${doc.coverage.pairs} pairs (${doc.coverage.legal_candidates} legal candidates)\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code), (e) => { process.stderr.write(`select-0.4.0.mjs: ${e.stack ?? e}\n`); process.exit(2); });
}
