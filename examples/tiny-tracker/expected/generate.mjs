#!/usr/bin/env node
// Generates a known-answer file, expected/<release>.json (schemas/expected-1), and its table, by running: never by
// hand (R9). For each build in a build list it starts `tiny-tracker all` with that build's arguments, reads GET /build
// for the build_hash the answers are keyed by, and records:
//
//   fixture    the FX- answers of fx-check (dist/src/fx-check.js) against the running build;
//   contract   with --contract-dir: the lost-response contract driver's own verdict strings for A1 to A5, from the
//              driver at the pinned commit (harness/contract.json) run with harness/adapters/tiny_tracker.py; A3 is
//              listed as self-attested until the driver compares recovered digests (driver ask (b));
//   writecheck with --writecheck CLI: mcp-writecheck demo's verdicts per requirement, for builds that ask for them.
//              The demo starts its own build (the release default, backend and server as separate processes, no
//              fixture features), so these rows are not keyed by a build_hash: they sit in the top-level `writecheck`
//              list, labelled by the demo's own command. Each set lists the per-record verdicts the demo gave for that
//              requirement (one record per write path), merged over the runs: it is not one answer per requirement.
//
// Answers are sets: with --repeat N every build runs N times and each answer is the union of what the runs gave, so a
// step that can only be observed or not observed lists both. A build whose build_hash differs between runs stops the
// generator. Nothing in the output depends on the time or the machine, so --check regenerates and compares with the
// committed file byte for byte (review T5).
//
//   node expected/generate.mjs --builds expected/builds-0.2.0.json --out expected/0.2.0.json --table expected/0.2.0.md
//        [--contract-dir DIR] [--writecheck PATH/TO/mcp-writecheck/cli.js] [--repeat N] [--only LABEL]... [--check] [--progress] [--jobs N]
//
// 0.4.0: a build may carry `env` (e.g. TRACKER_VARIANTS) and `{DATA_DIR}` in its arguments; with the durable feature
// the generator restarts the build on the same data dir for FX-DUR-1 (fx-check --durability-plant / -verify) and gives
// fx-check the data dir for FX-DUR-2. The 0.4.0 build list is selected by expected/select-0.4.0.mjs.
//
// Needs a build (npm run build). Starts every process on 127.0.0.1 with port 0; tokens are generated for each start
// and never written to any output.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "dist", "src", "cli.js");
const PIN = JSON.parse(readFileSync(join(ROOT, "harness", "contract.json"), "utf8"));
const PACKAGE = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

const { effectiveFeatures, parseFeatures, parseProfile } = await import(pathToFileURL(join(ROOT, "dist", "src", "profile.js")).href);

const token = (name) => `${name}-${randomBytes(20).toString("hex")}`;

/**
 * Whether a build runs with the principals feature: named with --features, or from the profile (not --profile 0.1),
 * and not turned off by a variant. The CLI's own rule (src/profile.ts effectiveFeatures) decides, from the build.
 */
export function principalsInEffect(args, env = {}) {
  const value = (flag) => {
    let v;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === flag) v = args[i + 1];
      else if (args[i].startsWith(`${flag}=`)) v = args[i].slice(flag.length + 1);
    }
    return v;
  };
  const variants = (env.TRACKER_VARIANTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const profile = parseProfile(value("--profile") ?? env.TRACKER_PROFILE);
  const { features } = effectiveFeatures(profile, parseFeatures(value("--features") ?? env.TRACKER_FEATURES), variants);
  return features.includes("principals");
}

/**
 * Starts one build; resolves with its state line, its tokens, and a stop function. `{DATA_DIR}` in the arguments is a
 * data dir in the build's own temporary folder (the row keeps the placeholder, so nothing machine-specific is written).
 * `reuse` (a run from before) starts the same build again on the same folder and tokens: a restart.
 */
export function startBuild(args, extraEnv = {}, reuse = undefined) {
  const tokens = reuse?.tokens ?? { backend: token("gen-backend"), evidence: token("gen-evidence"), control: token("gen-control"), second: token("gen-second") };
  const work = reuse?.work ?? mkdtempSync(join(tmpdir(), "tt-expected-"));
  const dataDir = join(work, "data");
  args = args.map((a) => a.replaceAll("{DATA_DIR}", dataDir));
  extraEnv = Object.fromEntries(Object.entries(extraEnv).map(([k, v]) => [k, String(v).replaceAll("{WORK}", work)]));
  const env = { PATH: process.env.PATH ?? "", TRACKER_BACKEND_TOKEN: tokens.backend, TRACKER_EVIDENCE_TOKEN: tokens.evidence, TRACKER_CONTROL_TOKEN: tokens.control, ...extraEnv };
  if (principalsInEffect(args, env)) {
    // Two principals: the default one (the MCP server's backend token) and a second for FX-LOOK-3, whenever the build
    // runs with principals, named or from the profile (0.4.0, note 19 item 6: the Lv rows took it from the profile).
    const file = join(work, "principals.json");
    writeFileSync(file, JSON.stringify({ principals: [{ id: "p-default", token: tokens.backend }, { id: "p-second", token: tokens.second }] }), { mode: 0o600 });
    env.TRACKER_BACKEND_TOKENS_FILE = file;
  }
  return new Promise((resolveStart, reject) => {
    const child = spawn(process.execPath, [CLI, "all", ...args, "--fixture-control"], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`no state line within 15 s: ${err}`)); }, 15000);
    child.stderr.on("data", (d) => { err += d; });
    child.stdout.on("data", (d) => {
      out += d;
      if (out.includes("\n")) {
        clearTimeout(timer);
        const state = JSON.parse(out.split("\n")[0]);
        resolveStart({ state, tokens, env, work, dataDir,
          // keep: leave the folder (data dir, principals file) for a restart with `reuse`.
          stop: (keep = false) => new Promise((r) => { child.once("exit", () => { if (!keep) rmSync(work, { recursive: true, force: true }); r(); }); child.kill("SIGTERM"); }) });
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (out.includes("\n")) return;
      // A start that never printed its state line leaves nothing to keep: its folder goes too (unless it is a restart's).
      if (!reuse) rmSync(work, { recursive: true, force: true });
      reject(new Error(`tiny-tracker all ${args.join(" ")} exited ${code}: ${err.trim()}`));
    });
  });
}

async function buildHash(state, tokens) {
  const res = await fetch(`${state.backend}/build`, { headers: { authorization: `Bearer ${tokens.evidence}` } });
  if (res.status !== 200) throw new Error(`GET /build answered ${res.status}`);
  return (await res.json()).build_hash;
}

async function fixtureAnswers(state, tokens, extra = {}) {
  const { fxCheck } = await import(pathToFileURL(join(ROOT, "dist", "src", "fx-check.js")).href);
  // The drop probe (FX-FLT-1) waits 1 s for an answer that is held until the hold ends: enough on loopback.
  const report = await fxCheck({ backend: state.backend, mcp: state.mcp, control: state.control, tokens, probe: true, dropWaitMs: 1000, ...extra });
  return { answers: Object.fromEntries(report.findings.map((f) => [f.id, f.verdict])), plant: report.plant };
}

/**
 * The fixture answers of one start. With the durable feature (a `{DATA_DIR}` build) it is two starts on the same data
 * dir: fx-check with the data dir (FX-DUR-2) and a durability plant, a restart, then fx-check --durability-verify for
 * FX-DUR-1 (its answer replaces the plant's "not checked").
 */
async function fixtureRun(b) {
  const durable = b.args.some((a) => a.includes("{DATA_DIR}"));
  const run = await startBuild(b.args, b.env ?? {});
  let hash;
  let answers;
  let kept = false;
  try {
    hash = await buildHash(run.state, run.tokens);
    if (b.fixture === false) return { hash, answers: {} };
    const first = await fixtureAnswers(run.state, run.tokens, durable ? { dataDir: run.dataDir, durability: { plant: true } } : {});
    answers = first.answers;
    if (durable && first.plant) {
      await run.stop(true);
      kept = true;
      const again = await startBuild(b.args, b.env ?? {}, run);
      try {
        if ((await buildHash(again.state, again.tokens)) !== hash) throw new Error(`${b.label}: build_hash changed across the restart`);
        const verify = await fixtureAnswers(again.state, again.tokens, { durability: { verify: first.plant } });
        answers["FX-DUR-1"] = verify.answers["FX-DUR-1"];
      } finally {
        await again.stop();
      }
    }
  } finally {
    if (!kept) await run.stop();
  }
  return { hash, answers };
}

/** spawnSync's shape, without blocking the event loop (other builds run beside this one with --jobs). */
function run(cmd, args, opts = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(cmd, args, { env: opts.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const timer = opts.timeout ? setTimeout(() => child.kill("SIGKILL"), opts.timeout) : undefined;
    child.on("error", (error) => { clearTimeout(timer); resolveRun({ status: null, stdout, stderr, error }); });
    child.on("close", (status) => { clearTimeout(timer); resolveRun({ status, stdout, stderr }); });
    child.stdin.end(opts.input ?? "");
  });
}

async function contractAnswers(state, tokens, env, contractDir) {
  const cfg = await run("python3", ["-I", join(ROOT, "harness", "adapter_config.py"), "--no-build"], { input: JSON.stringify(state), env });
  if (cfg.status !== 0) throw new Error(`adapter_config.py: ${cfg.stderr}`);
  const config = JSON.parse(cfg.stdout);
  config.adapter_config.drop_timeout_s = 2;
  const work = mkdtempSync(join(tmpdir(), "tt-expected-cfg-"));
  try {
    const path = join(work, "config.json");
    writeFileSync(path, JSON.stringify(config));
    const r = await run("python3", ["-I", join(ROOT, "harness", "selfcheck.py"), "--config", path, "--driver", contractDir], { env: { ...env, TRACKER_EVIDENCE_TOKEN: tokens.evidence, TRACKER_CONTROL_TOKEN: tokens.control, TRACKER_BACKEND_TOKEN: tokens.backend }, timeout: 600000 });
    if (r.status !== 0) throw new Error(`selfcheck.py --driver: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    if (!out.driver.commit_matches_pin) throw new Error(`the contract checkout is at ${out.driver.commit}, not the pinned ${PIN.contract.commit}`);
    return Object.fromEntries(Object.entries(out.verdicts).map(([a, v]) => [`LRT-${a}`, v]));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function writecheckAnswers(cliPath, mcpDefects) {
  const out = mkdtempSync(join(tmpdir(), "tt-expected-wc-"));
  try {
    const r = spawnSync(process.execPath, [cliPath, "demo", "--tiny-tracker", ROOT, "--out", out, ...mcpDefects.flatMap((d) => ["--defect", d])], { encoding: "utf8", timeout: 600000 });
    const found = spawnSync("find", [out, "-name", "results.json"], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean);
    if (found.length !== 1) throw new Error(`mcp-writecheck demo wrote ${found.length} results.json (exit ${r.status}): ${r.stderr.slice(-500)}`);
    const doc = JSON.parse(readFileSync(found[0], "utf8"));
    const answers = {};
    for (const res of doc.results) (answers[res.requirement] ??= new Set()).add(res.verdict);
    return { version: doc.suite.version, answers };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

const sortedSet = (s) => [...s].sort();
const sortKeys = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));

export async function generate(o) {
  const list = JSON.parse(readFileSync(o.builds, "utf8"));
  const builds = [];
  const writecheck = [];
  // --jobs N: builds run N at a time (each on its own ports, tokens and folder); the output is sorted, so it does not
  // depend on the order they finish in.
  const todo = list.builds.filter((b) => !(o.only?.length && !o.only.includes(b.label)));
  const one = async (b) => {
    let hash;
    const fixture = {};
    const contract = {};
    for (let i = 0; i < (o.repeat ?? 1); i++) {
      const r = await fixtureRun(b);
      if (hash !== undefined && r.hash !== hash) throw new Error(`${b.label}: build_hash changed between runs (${hash}, ${r.hash})`);
      hash = r.hash;
      for (const [id, v] of Object.entries(r.answers)) (fixture[id] ??= new Set()).add(v);
      o.progress?.(b.label, i);
      if (b.contract && o.contractDir) {
        const again = await startBuild(b.args, b.env ?? {});
        try {
          if ((await buildHash(again.state, again.tokens)) !== hash) throw new Error(`${b.label}: build_hash changed between runs`);
          for (const [id, v] of Object.entries(await contractAnswers(again.state, again.tokens, again.env, o.contractDir))) (contract[id] ??= new Set()).add(v);
        } finally {
          await again.stop();
        }
      }
    }
    const row = { build_hash: hash, label: b.label, start: [...Object.entries(b.env ?? {}).map(([k, v]) => `${k}=${v}`), "tiny-tracker", "all", ...b.args] }; // placeholders kept
    if (b.writecheck && o.writecheck) {
      const wc = { version: undefined, answers: {} };
      for (let i = 0; i < (o.repeat ?? 1); i++) {
        const r = writecheckAnswers(o.writecheck, b.mcpDefects ?? []);
        wc.version = r.version;
        for (const [id, s] of Object.entries(r.answers)) for (const v of s) (wc.answers[id] ??= new Set()).add(v);
      }
      const defects = b.mcpDefects ?? [];
      writecheck.push({
        label: `mcp-writecheck demo${defects.length ? ` with ${defects.join(", ")}` : " (correct build)"}`,
        start: ["mcp-writecheck", "demo", ...defects.flatMap((d) => ["--defect", d])],
        measured_on: "the build the demo starts itself: the release default profile, backend and server as separate processes, no fixture features (not any build_hash in builds)",
        version: wc.version,
        answers_are: "per requirement, the set of record verdicts the demo gave (one record per write path), merged over the runs",
        answers: sortKeys(Object.fromEntries(Object.entries(wc.answers).map(([k, s]) => [k, sortedSet(s)]))),
      });
    }
    if (Object.keys(contract).length) {
      row.contract = { repo: PIN.contract.repo, commit: PIN.contract.commit, answers: sortKeys(Object.fromEntries(Object.entries(contract).map(([k, s]) => [k, sortedSet(s)]))), self_attested: ["LRT-A3"] };
    }
    if (Object.keys(fixture).length) row.fixture = sortKeys(Object.fromEntries(Object.entries(fixture).map(([k, s]) => [k, sortedSet(s)])));
    builds.push(row);
  };
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(o.jobs ?? 1, todo.length)) }, async () => {
    while (next < todo.length) await one(todo[next++]);
  }));
  builds.sort((a, b) => a.label < b.label ? -1 : a.label > b.label ? 1 : 0);
  writecheck.sort((a, b) => a.label < b.label ? -1 : a.label > b.label ? 1 : 0);
  // expected/1 allows additional top-level members: the writecheck rows sit beside the builds, not in them.
  // `not_detected` (0.3.0 on): the build list's statement of the defects these answers cannot tell from the correct
  // build. A top-level addition, carried into the table's header.
  return {
    expected: "expected/1", package: { name: PACKAGE.name, version: list.release }, ...(list.not_detected ? { not_detected: list.not_detected } : {}),
    builds, ...(writecheck.length ? { writecheck } : {}),
  };
}

export function table(doc) {
  const lines = [`# Known answers for tiny-tracker ${doc.package.version}`, "",
    "Generated by `expected/generate.mjs` from running each build; do not edit by hand. Each cell is the set of answers a correct harness may give.",
    `Contract answers are the lost-response driver's own verdict strings at ${PIN.contract.commit.slice(0, 7)}; LRT-A3 is self-attested until the driver compares recovered digests.`,
    ...(doc.not_detected ? [doc.not_detected] : []), ""];
  for (const b of doc.builds) {
    lines.push(`## ${b.label}`, "", `- build_hash: \`${b.build_hash}\``, `- start: \`${b.start.join(" ")}\``, "", "| Property | Answers |", "|---|---|");
    for (const [section, answers] of [["contract", b.contract?.answers], ["fixture", b.fixture]]) {
      for (const [id, set] of Object.entries(answers ?? {})) lines.push(`| ${id}${section === "contract" && b.contract.self_attested?.includes(id) ? " (self-attested)" : ""} | ${set.join(", ")} |`);
    }
    lines.push("");
  }
  for (const w of doc.writecheck ?? []) {
    lines.push(`## ${w.label}`, "", `- start: \`${w.start.join(" ")}\``, `- measured on: ${w.measured_on}`, `- mcp-writecheck ${w.version}; each cell: ${w.answers_are}`, "",
      "| Requirement | Record verdicts seen |", "|---|---|");
    for (const [id, set] of Object.entries(w.answers)) lines.push(`| ${id} | ${set.join(", ")} |`);
    lines.push("");
  }
  return `${lines.join("\n")}`;
}

async function main() {
  const { values } = parseArgs({ options: {
    builds: { type: "string" }, out: { type: "string" }, table: { type: "string" }, "contract-dir": { type: "string" },
    writecheck: { type: "string" }, repeat: { type: "string" }, only: { type: "string", multiple: true }, check: { type: "boolean" }, progress: { type: "boolean" }, jobs: { type: "string" },
  } });
  if (!values.builds || !values.out) { process.stderr.write("usage: generate.mjs --builds FILE --out FILE [--table FILE] [--contract-dir DIR] [--writecheck CLI] [--repeat N] [--only LABEL]... [--check]\n"); return 2; }
  if (!existsSync(CLI)) { process.stderr.write("generate.mjs: build first (npm run build)\n"); return 2; }
  let done = 0;
  const progress = values.progress ? (label, i) => { if (i === Number(values.repeat ?? 1) - 1) process.stderr.write(`[${++done}] ${label}\n`); } : undefined;
  const doc = await generate({ builds: values.builds, contractDir: values["contract-dir"], writecheck: values.writecheck, repeat: Number(values.repeat ?? 1), only: values.only, progress, jobs: Number(values.jobs ?? 1) });
  const text = `${JSON.stringify(doc, null, 2)}\n`;
  const check = spawnSync("python3", ["-I", join(ROOT, "verify", "python", "check_schemas.py"), "--instance", "expected"], { input: text, encoding: "utf8" });
  // No python3 (Windows runners) or no jsonschema (exit 3): the schema check is skipped, as the schema tests skip.
  if (!check.error && check.status !== 0 && check.status !== 3) { process.stderr.write(`generate.mjs: the output does not validate against expected-1: ${check.stdout}${check.stderr}\n`); return 1; }
  if (values.check) {
    const same = existsSync(values.out) && readFileSync(values.out, "utf8") === text;
    process.stdout.write(same ? `${values.out}: reproduced byte for byte\n` : `${values.out}: differs from a fresh generation\n`);
    return same ? 0 : 1;
  }
  writeFileSync(values.out, text);
  if (values.table) writeFileSync(values.table, `${table(doc)}\n`);
  process.stdout.write(`${values.out}: ${doc.builds.length} build(s)\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code), (e) => { process.stderr.write(`generate.mjs: ${e.message}\n`); process.exit(2); });
}
