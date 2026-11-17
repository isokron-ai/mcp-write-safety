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
//
// Answers are sets: with --repeat N every build runs N times and each answer is the union of what the runs gave, so a
// step that can only be observed or not observed lists both. A build whose build_hash differs between runs stops the
// generator. Nothing in the output depends on the time or the machine, so --check regenerates and compares with the
// committed file byte for byte (review T5).
//
//   node expected/generate.mjs --builds expected/builds-0.2.0.json --out expected/0.2.0.json --table expected/0.2.0.md
//        [--contract-dir DIR] [--writecheck PATH/TO/mcp-writecheck/cli.js] [--repeat N] [--only LABEL]... [--check]
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

const token = (name) => `${name}-${randomBytes(20).toString("hex")}`;

/** Starts one build; resolves with its state line, its tokens, and a stop function. */
export function startBuild(args, extraEnv = {}) {
  const tokens = { backend: token("gen-backend"), evidence: token("gen-evidence"), control: token("gen-control"), second: token("gen-second") };
  const work = mkdtempSync(join(tmpdir(), "tt-expected-"));
  const env = { PATH: process.env.PATH ?? "", TRACKER_BACKEND_TOKEN: tokens.backend, TRACKER_EVIDENCE_TOKEN: tokens.evidence, TRACKER_CONTROL_TOKEN: tokens.control, ...extraEnv };
  if (args.flatMap((a) => a.split(",")).includes("principals")) {
    // Two principals: the default one (the MCP server's backend token) and a second for FX-LOOK-3.
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
        resolveStart({ state, tokens, env, stop: () => new Promise((r) => { child.once("exit", () => { rmSync(work, { recursive: true, force: true }); r(); }); child.kill("SIGTERM"); }) });
      }
    });
    child.on("exit", (code) => { clearTimeout(timer); if (!out.includes("\n")) reject(new Error(`tiny-tracker all ${args.join(" ")} exited ${code}: ${err.trim()}`)); });
  });
}

async function buildHash(state, tokens) {
  const res = await fetch(`${state.backend}/build`, { headers: { authorization: `Bearer ${tokens.evidence}` } });
  if (res.status !== 200) throw new Error(`GET /build answered ${res.status}`);
  return (await res.json()).build_hash;
}

async function fixtureAnswers(state, tokens) {
  const { fxCheck } = await import(pathToFileURL(join(ROOT, "dist", "src", "fx-check.js")).href);
  const report = await fxCheck({ backend: state.backend, mcp: state.mcp, control: state.control, tokens, probe: true });
  return Object.fromEntries(report.findings.map((f) => [f.id, f.verdict]));
}

function contractAnswers(state, tokens, env, contractDir) {
  const cfg = spawnSync("python3", ["-I", join(ROOT, "harness", "adapter_config.py"), "--no-build"], { input: JSON.stringify(state), encoding: "utf8", env });
  if (cfg.status !== 0) throw new Error(`adapter_config.py: ${cfg.stderr}`);
  const config = JSON.parse(cfg.stdout);
  config.adapter_config.drop_timeout_s = 2;
  const work = mkdtempSync(join(tmpdir(), "tt-expected-cfg-"));
  try {
    const path = join(work, "config.json");
    writeFileSync(path, JSON.stringify(config));
    const r = spawnSync("python3", ["-I", join(ROOT, "harness", "selfcheck.py"), "--config", path, "--driver", contractDir], { encoding: "utf8", env: { ...env, TRACKER_EVIDENCE_TOKEN: tokens.evidence, TRACKER_CONTROL_TOKEN: tokens.control, TRACKER_BACKEND_TOKEN: tokens.backend }, timeout: 600000 });
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
  for (const b of list.builds) {
    if (o.only?.length && !o.only.includes(b.label)) continue;
    let hash;
    const fixture = {};
    const contract = {};
    for (let i = 0; i < (o.repeat ?? 1); i++) {
      const run = await startBuild(b.args);
      try {
        const h = await buildHash(run.state, run.tokens);
        if (hash !== undefined && h !== hash) throw new Error(`${b.label}: build_hash changed between runs (${hash}, ${h})`);
        hash = h;
        if (b.fixture !== false) for (const [id, v] of Object.entries(await fixtureAnswers(run.state, run.tokens))) (fixture[id] ??= new Set()).add(v);
      } finally {
        await run.stop();
      }
      if (b.contract && o.contractDir) {
        const again = await startBuild(b.args);
        try {
          if ((await buildHash(again.state, again.tokens)) !== hash) throw new Error(`${b.label}: build_hash changed between runs`);
          for (const [id, v] of Object.entries(contractAnswers(again.state, again.tokens, again.env, o.contractDir))) (contract[id] ??= new Set()).add(v);
        } finally {
          await again.stop();
        }
      }
    }
    const row = { build_hash: hash, label: b.label, start: ["tiny-tracker", "all", ...b.args] };
    if (b.writecheck && o.writecheck) {
      const wc = { version: undefined, answers: {} };
      for (let i = 0; i < (o.repeat ?? 1); i++) {
        const r = writecheckAnswers(o.writecheck, b.mcpDefects ?? []);
        wc.version = r.version;
        for (const [id, s] of Object.entries(r.answers)) for (const v of s) (wc.answers[id] ??= new Set()).add(v);
      }
      row.writecheck = { version: wc.version, answers: sortKeys(Object.fromEntries(Object.entries(wc.answers).map(([k, s]) => [k, sortedSet(s)]))) };
    }
    if (Object.keys(contract).length) {
      row.contract = { repo: PIN.contract.repo, commit: PIN.contract.commit, answers: sortKeys(Object.fromEntries(Object.entries(contract).map(([k, s]) => [k, sortedSet(s)]))), self_attested: ["LRT-A3"] };
    }
    if (Object.keys(fixture).length) row.fixture = sortKeys(Object.fromEntries(Object.entries(fixture).map(([k, s]) => [k, sortedSet(s)])));
    builds.push(row);
  }
  builds.sort((a, b) => a.label < b.label ? -1 : a.label > b.label ? 1 : 0);
  return { expected: "expected/1", package: { name: PACKAGE.name, version: list.release }, builds };
}

export function table(doc) {
  const lines = [`# Known answers for tiny-tracker ${doc.package.version}`, "",
    "Generated by `expected/generate.mjs` from running each build; do not edit by hand. Each cell is the set of answers a correct harness may give.",
    `Contract answers are the lost-response driver's own verdict strings at ${PIN.contract.commit.slice(0, 7)}; LRT-A3 is self-attested until the driver compares recovered digests.`, ""];
  for (const b of doc.builds) {
    lines.push(`## ${b.label}`, "", `- build_hash: \`${b.build_hash}\``, `- start: \`${b.start.join(" ")}\``, "", "| Property | Answers |", "|---|---|");
    for (const [section, answers] of [["contract", b.contract?.answers], ["fixture", b.fixture], ["writecheck", b.writecheck?.answers]]) {
      for (const [id, set] of Object.entries(answers ?? {})) lines.push(`| ${id}${section === "contract" && b.contract.self_attested?.includes(id) ? " (self-attested)" : ""} | ${set.join(", ")} |`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}`;
}

async function main() {
  const { values } = parseArgs({ options: {
    builds: { type: "string" }, out: { type: "string" }, table: { type: "string" }, "contract-dir": { type: "string" },
    writecheck: { type: "string" }, repeat: { type: "string" }, only: { type: "string", multiple: true }, check: { type: "boolean" },
  } });
  if (!values.builds || !values.out) { process.stderr.write("usage: generate.mjs --builds FILE --out FILE [--table FILE] [--contract-dir DIR] [--writecheck CLI] [--repeat N] [--only LABEL]... [--check]\n"); return 2; }
  if (!existsSync(CLI)) { process.stderr.write("generate.mjs: build first (npm run build)\n"); return 2; }
  const doc = await generate({ builds: values.builds, contractDir: values["contract-dir"], writecheck: values.writecheck, repeat: Number(values.repeat ?? 1), only: values.only });
  const text = `${JSON.stringify(doc, null, 2)}\n`;
  const check = spawnSync("python3", ["-I", join(ROOT, "verify", "python", "check_schemas.py"), "--instance", "expected"], { input: text, encoding: "utf8" });
  if (check.status !== 0 && check.status !== 3) { process.stderr.write(`generate.mjs: the output does not validate against expected-1: ${check.stdout}${check.stderr}\n`); return 1; }
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
