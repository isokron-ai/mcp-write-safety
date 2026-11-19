#!/usr/bin/env node
/**
 * mcp-writecheck: tests your own MCP server, in a test environment, against the MCP Write-Safety
 * Requirements. No model, no account, no telemetry; the tool connects to your server, to the hosts
 * your manifest names for the control, and to nothing else. Apache-2.0, no warranty: it makes real
 * writes, so point it only at a test environment you are allowed to change.
 */

import { parsePairBudget } from '../core/manifest.js';
import { createInterface } from 'node:readline';
import { stdin } from 'node:process';

function askLine(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((r) => rl.question(q, (x) => (rl.close(), r(x))));
}

import { REQUIREMENTS, SPEC_VERSION, previewSentence, requirementLink } from '../requirements.js';
import { short, WritecheckError } from '../core/util.js';
import { writePathKey } from '../report/verdicts.js';
import { SUITE_NAME, SUITE_VERSION } from '../version.js';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { catalogCommand, cleanupCommand, planCommand, recheckCommand, rerunCommand, reviewCommand } from './commands.js';
import { loadSigningKey } from '../report/sign.js';
import { compareCommand, finishRecheck, IDENTITY_FLAGS, IDENTITY_USAGE, identityOptions, verifyResultsCommand } from './compare.js';
import { demoCommand } from './demo.js';
import { initCommand } from './init.js';
import { runCommand, type RunOutcome } from './run.js';

const HEAD = `${SUITE_NAME} ${SUITE_VERSION} (MWS ${SPEC_VERSION})

It makes real writes. Point it only at a test environment you are allowed to change.
Apache-2.0, provided without warranty. No model, no account, no telemetry.`;

interface CommandSpec {
  usage: string;
  /** Flags that take a value. */
  flags: string[];
  /** Flags that take none. */
  bools?: string[];
}

const COMMANDS: Record<string, CommandSpec> = {
  demo: {
    usage: `mcp-writecheck demo [--defect NAME]... [--tiny-tracker DIR] [--out DIR] [--verbose]
    Try the suite on tiny-tracker, the MWS sample server, on this machine (about two minutes):
    starts its backend on 127.0.0.1, runs the shipped manifest against the correct build (or with
    --defect NAME, a broken one; --defect all for every defect), prints one line per requirement,
    and stops everything it started. Finds tiny-tracker with --tiny-tracker, TINY_TRACKER_DIR, a
    tiny-tracker command on PATH (the @mcp-write-safety/tiny-tracker package), or examples/tiny-tracker in a checkout. The demo confirms the
    target itself because it started it; run never does.`,
    flags: ['--defect', '--tiny-tracker', '--out', '-o', '--manifest', '-m', '--pair-budget'],
    bools: ['--verbose', '-v'],
  },
  init: {
    usage: `mcp-writecheck init [--out manifest.yaml] [--env NAME]... -- <server command...>
mcp-writecheck init [--out manifest.yaml] --url <http://host/mcp>
    Draft a manifest from tools/list (the only call it makes). Every guess is marked "# guessed";
    a manifest with a marker left will not load.`,
    flags: ['--out', '-o', '--env', '--url'],
  },
  plan: {
    usage: `mcp-writecheck plan -m manifest.yaml [--catalog tools.json] [--pair-budget 2x1500]
    Print every call a run would make, the most writes and creates, what will not be tested and why,
    and the plan hash run must be given. Makes no tool call (tools/list only, or --catalog: a
    tools/list answer, a list of tools, or a catalog snapshot). --pair-budget RxP: run the MWS-CONC-3
    barrier pairs as R repeats of P pairs (as limits.pair_budget; it enters the plan hash, so give run
    the same flag). Opt-in: 2x1500 is about 12,000 writes per resource; the plan prints the estimate.`,
    flags: ['-m', '--manifest', '--catalog', '--pair-budget'],
  },
  catalog: {
    usage: `mcp-writecheck catalog (-m manifest.yaml | --catalog tools.json) [--out mwsc-results]
    Catalog-only mode: the verdicts that need only tools/list (MWS-ANN-4 for each tool), from the
    server the manifest starts or from a saved tools/list answer. Calls no tool, needs no account or
    test environment; every other requirement is reported not tested. Writes the usual results
    folder. Exit 1 only for a violated MUST.`,
    flags: ['-m', '--manifest', '--catalog', '--out', '-o'],
  },
  run: {
    usage: `mcp-writecheck run -m manifest.yaml [--confirm-target T --plan-hash H] [--out mwsc-results]
                   [--state .mwsc] [--baseline baseline.yaml] [--review answers.yaml] [--sign ~/.ssh/key]
    Run the checks. Asks for the target and the plan hash (or takes them as flags in CI; there is no
    --yes). Writes report.md, results.json, junit.xml, the capture and SHA256SUMS to --out/<run id>.`,
    flags: ['-m', '--manifest', '--confirm-target', '--plan-hash', '--out', '-o', '--state', '--baseline', '--sign', '--review', '--pair-budget'],
  },
  rerun: {
    usage: `mcp-writecheck rerun <results folder> -m manifest.yaml [--confirm-target T --plan-hash H] [same options as run]
    Run again what a recorded run ran. The manifest must be the one that run used (its sha256 is
    recorded); if today's plan differs (catalog, suite, hosts), that is printed and the new hash is
    the one to confirm. The new results say which run they repeat.`,
    flags: ['-m', '--manifest', '--confirm-target', '--plan-hash', '--out', '-o', '--state', '--baseline', '--sign', '--review', '--pair-budget'],
  },
  cleanup: {
    usage: `mcp-writecheck cleanup -m manifest.yaml [--confirm-target T] [--state .mwsc] [--run ID] [--abandon]
    Clean up what earlier runs left in their ledgers, with the same target checks as run. --abandon
    records the objects as left behind and touches nothing.`,
    flags: ['-m', '--manifest', '--confirm-target', '--state', '--run'],
    bools: ['--abandon'],
  },
  recheck: {
    usage: `mcp-writecheck recheck <results folder> [--review answers.yaml]
    Re-apply this release's rules (and the review answers) to a recorded run, offline. Writes
    <folder>/recheck/; the original evidence is not changed.`,
    flags: ['--review'],
  },
  review: {
    usage: `mcp-writecheck review <results folder>
    List the review-only questions of a recorded run (the clauses a person answers, such as whether
    a conflict says the write was not applied), with the captured evidence and the id to answer each
    under in the manifest's review block. Answers are recorded as self-attested.`,
    flags: [],
  },
  compare: {
    usage: `mcp-writecheck compare <before results.json|folder> <after results.json|folder> [--out DIR] [--pubkey KEY]
    Before/after per cell (requirement @ tool), joined only where the test hashes are equal; verdicts rolled up by MWS 8.2
    rule 13. Labels each cell fixed, regressed, unchanged, changed (no claim) or not comparable, with the reason. Writes
    compare.json and compare.md to --out (default .). Refuses different MWS versions. --pubkey: both files must be signed
    by that key. Exit 1 when a cell regressed, or a slot regressed inside a cell (--fail-on-slot-regression false: warn only).`,
    flags: ['--out', '-o', '--pubkey', '--fail-on-slot-regression'],
  },
  'verify-results': {
    usage: `mcp-writecheck verify-results <results.json|folder> [--pubkey KEY]
    Check the results signature (--sign-key) against a pinned Ed25519 key (PEM, or an ssh-ed25519 line or .pub file).
    Exit 0 signed by that key and unchanged; 1 unsigned, or not pinned (no --pubkey); 3 changed or signed by another key.`,
    flags: ['--pubkey'],
  },
  requirements: { usage: `mcp-writecheck requirements\n    List the requirement IDs this release knows, with their level.`, flags: [] },
  version: { usage: `mcp-writecheck version\n    Print the suite and requirements versions.`, flags: [] },
};

// why: F8: the run identity flags are added here, apart from the run and rerun entries, so other changes to those lines merge cleanly.
for (const c of ['run', 'rerun'] as const) {
  COMMANDS[c]!.flags.push(...IDENTITY_FLAGS);
  COMMANDS[c]!.usage += `\n${IDENTITY_USAGE}`;
}
COMMANDS['recheck']!.flags.push('--sign-key');
COMMANDS['recheck']!.usage += '\n    The rechecked copy is unsigned (the original signature does not cover new verdicts), or signed with --sign-key FILE.';

const USAGE = `${HEAD}

${Object.values(COMMANDS).map((c) => c.usage).join('\n\n')}

Help for one command: mcp-writecheck <command> --help

Exit status: 0 done; 1 a violated MUST not in the baseline (or a stale baseline entry);
2 usage or manifest error; 3 refused (target, confirmation, guard, open ledger); 4 stopped or failed:
the target stopped answering, or clean-up could not finish (4 takes precedence over 1); 130 interrupted.
`;

interface Args {
  cmd: string;
  flags: Map<string, string[]>;
  rest: string[];
  help: boolean;
}

function parse(argv: string[]): Args {
  const [cmd = '', ...a] = argv;
  const spec = COMMANDS[cmd];
  const flags = new Map<string, string[]>();
  const rest: string[] = [];
  let help = false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    if (x === '--') {
      rest.push(...a.slice(i + 1));
      break;
    }
    if (x === '--help' || x === '-h') {
      help = true;
      continue;
    }
    if (x === '--yes' || x === '-y') throw new WritecheckError('there is no --yes: confirm the target and the plan hash (--confirm-target, --plan-hash; `mcp-writecheck plan` prints the hash)', 2);
    if (x.startsWith('-')) {
      const k = x.includes('=') ? x.slice(0, x.indexOf('=')) : x;
      const isBool = !!spec?.bools?.includes(k);
      if (spec && !isBool && !spec.flags.includes(k)) throw new WritecheckError(`${cmd}: unknown option ${k} (see mcp-writecheck ${cmd} --help)`, 2);
      const v = x.includes('=') ? x.slice(x.indexOf('=') + 1) : isBool ? 'true' : a[++i];
      if (v === undefined || (!isBool && v.startsWith('-') && !x.includes('='))) throw new WritecheckError(`${cmd}: ${k} needs a value (see mcp-writecheck ${cmd} --help)`, 2);
      flags.set(k, [...(flags.get(k) ?? []), v]);
    } else rest.push(x);
  }
  return { cmd, flags, rest, help };
}

const one = (a: Args, ...names: string[]): string | undefined => {
  for (const n of names) {
    const v = a.flags.get(n);
    if (v && v.length) return v[v.length - 1];
  }
  return undefined;
};

export async function main(argv: string[]): Promise<number> {
  const log = (s: string) => process.stdout.write(s + '\n');
  const a = parse(argv);
  if (a.help && COMMANDS[a.cmd]) {
    log(`${HEAD}\n\n${COMMANDS[a.cmd]!.usage}`);
    return 0;
  }
  const manifest = () => {
    const m = one(a, '-m', '--manifest');
    if (!m) throw new WritecheckError(`${a.cmd}: -m <manifest.yaml> is required (see mcp-writecheck ${a.cmd} --help)`, 2);
    if (!existsSync(m)) throw new WritecheckError(`${a.cmd}: the manifest ${m} does not exist (mcp-writecheck init drafts one from tools/list)`, 2);
    return m;
  };
  const runOpts = () => {
    const confirmTarget = one(a, '--confirm-target');
    const planHash = one(a, '--plan-hash');
    const baseline = one(a, '--baseline');
    const sign = one(a, '--sign');
    const review = one(a, '--review');
    const pb = one(a, '--pair-budget');
    return { manifest: manifest(), ...(pb ? { pairBudget: parsePairBudget(pb) } : {}), outRoot: one(a, '--out', '-o') ?? 'mwsc-results', stateDir: one(a, '--state') ?? '.mwsc', ...(confirmTarget !== undefined ? { confirmTarget } : {}), ...(planHash !== undefined ? { planHash } : {}), ...(baseline ? { baseline } : {}), ...(sign ? { sign } : {}), ...(review ? { review } : {}), interactive: !!stdin.isTTY, ask: askLine, env: process.env, log };
  };
  const report = (r: RunOutcome) => {
    // why: problem 14 in the GitHub Action's NOTES.md: an incomplete run says so first.
    if (r.doc.run.status === 'stopped') log(`\nTHIS RUN IS INCOMPLETE (exit ${r.exit}): ${r.doc.run.stopped_reason ?? 'it stopped'}`);
    const lost = r.doc.results.filter((x) => Array.isArray(x.numbers['bystanders_lost']) && (x.numbers['bystanders_lost'] as unknown[]).length);
    if (lost.length) log(`\nOBJECTS THE TESTER DID NOT CREATE WERE CHANGED OR DELETED:\n${lost.map((x) => `  ${x.requirement} ${writePathKey(x.write_path)}: ${(x.numbers['bystanders_lost'] as string[]).join(', ')}`).join('\n')}`);
    const vio = [...r.doc.results.filter((x) => x.verdict === 'violated' && x.level === 'MUST'), ...r.doc.results.filter((x) => x.verdict === 'violated' && x.level === 'SHOULD')];
    // why: dogfood C8 (spec 5.2): records are listed, never totalled.
    if (vio.length) log(`\nviolated records (one line each; there is no total):\n${vio.map((x) => `  ${x.requirement} (${x.level}) ${writePathKey(x.write_path)}: ${short(x.reason, 160)}${x.attribution ? ` [attribution: ${x.attribution}]` : ''}\n    ${requirementLink(x.requirement)}${x.steps.length ? `; trace ${x.steps.slice(0, 2).join(', ')}` : ''}`).join('\n')}`);
    else log(`\nno requirement was violated in ${r.doc.run.status === 'stopped' ? 'the part of this run that ran' : 'this run'} (see report.md for what was not tested)`);
    log(`\nresults: ${r.outDir}/report.md (also results.json, junit.xml, SHA256SUMS)`);
    log(previewSentence());
    if (r.baseline.new_must.length) log(`violated MUST not in the baseline:\n  ${r.baseline.new_must.join('\n  ')}`);
    if (r.baseline.stale.length) log(`baseline entries that no longer fail (remove them):\n  ${r.baseline.stale.join('\n  ')}`);
    if (r.baseline.not_rechecked.length) log(`baseline entries not re-checked in this run (their check did not reach a verdict):\n  ${r.baseline.not_rechecked.join('\n  ')}`);
    // why: research builds (Payload no-shim): a create of unknown outcome is not known to have left an object; it is counted apart.
    const unk = r.doc.leftovers.filter((l) => l.id === null && /unknown outcome/.test(l.how)).length;
    const left = r.doc.leftovers.length - unk;
    if (left) log(`${left} object(s) left behind; search for ${r.doc.run.prefix} (listed in the report)`);
    if (unk) log(`${unk} create(s) with an unknown outcome: an object may or may not exist; search for ${r.doc.run.prefix}, or declare a list block so that clean-up can look (listed in the report)`);
    const open = r.doc.results.filter((x) => x.verdict === 'not tested' && x.reason.startsWith('review-only clause')).length;
    if (open) log(`${open} review-only question(s) are open: mcp-writecheck review ${r.outDir}`);
    return r.exit;
  };
  const folder = () => {
    const dir = a.rest[0];
    if (!dir) throw new WritecheckError(`${a.cmd} <results folder> (see mcp-writecheck ${a.cmd} --help)`, 2);
    return dir;
  };
  switch (a.cmd) {
    case 'demo': {
      const tt = one(a, '--tiny-tracker');
      const m = one(a, '--manifest', '-m');
      const pb = one(a, '--pair-budget');
      return demoCommand({ ...(tt ? { tinyTracker: tt } : {}), ...(m ? { manifest: m } : {}), ...(pb ? { pairBudget: parsePairBudget(pb) } : {}), defects: (a.flags.get('--defect') ?? []).flatMap((d) => d.split(',')).filter(Boolean), out: one(a, '--out', '-o') ?? join(tmpdir(), 'mwsc-demo-results'), env: process.env, log, verbose: a.flags.has('--verbose') || a.flags.has('-v') });
    }
    case 'init': {
      const url = one(a, '--url');
      if (!url && !a.rest.length) throw new WritecheckError('init needs -- <server command> or --url <endpoint> (see mcp-writecheck init --help)', 2);
      await initCommand({ server: url ? { url } : { stdio: a.rest }, passthrough: a.flags.get('--env') ?? [], out: one(a, '--out', '-o') ?? null, env: process.env, log });
      return 0;
    }
    case 'plan': {
      const catalog = one(a, '--catalog');
      const pb = one(a, '--pair-budget');
      await planCommand({ manifest: manifest(), ...(catalog ? { catalog } : {}), ...(pb ? { pairBudget: parsePairBudget(pb) } : {}), env: process.env, log });
      return 0;
    }
    case 'catalog': {
      const cat = one(a, '--catalog');
      const m = one(a, '-m', '--manifest');
      return (await catalogCommand({ ...(m ? { manifest: m } : {}), ...(cat ? { catalog: cat } : {}), out: one(a, '--out', '-o') ?? 'mwsc-results', env: process.env, log })).exit;
    }
    case 'run':
      return report(await runCommand({ ...runOpts(), identity: identityOptions((n) => one(a, n), (n) => a.flags.get(n) ?? []) }));
    case 'rerun':
      return report(await rerunCommand({ ...runOpts(), identity: identityOptions((n) => one(a, n), (n) => a.flags.get(n) ?? []), dir: folder() }));
    case 'compare': {
      const [before, after] = a.rest;
      if (!before || !after) throw new WritecheckError('compare <before> <after> (see mcp-writecheck compare --help)', 2);
      const pubkey = one(a, '--pubkey');
      const fosr = one(a, '--fail-on-slot-regression') ?? 'true';
      if (fosr !== 'true' && fosr !== 'false') throw new WritecheckError('--fail-on-slot-regression takes true or false', 2);
      return compareCommand({ before, after, out: one(a, '--out', '-o') ?? '.', ...(pubkey ? { pubkey } : {}), failOnSlotRegression: fosr === 'true', log }).exit;
    }
    case 'verify-results': {
      const pubkey = one(a, '--pubkey');
      return verifyResultsCommand({ file: folder(), ...(pubkey ? { pubkey } : {}), log }).exit;
    }
    case 'cleanup': {
      const run = one(a, '--run');
      const confirmTarget = one(a, '--confirm-target');
      const r = await cleanupCommand({ manifest: manifest(), stateDir: one(a, '--state') ?? '.mwsc', ...(run ? { run } : {}), ...(confirmTarget !== undefined ? { confirmTarget } : {}), abandon: a.flags.has('--abandon'), interactive: !!stdin.isTTY, ask: askLine, env: process.env, log });
      return r.exit;
    }
    case 'recheck': {
      const review = one(a, '--review');
      // why: F8 review: the rechecked copy is not covered by the original signature; it is unsigned or signed again. The key is
      // read before recheck writes anything, so a bad key leaves no half-finished copy.
      const sk = one(a, '--sign-key');
      const key = loadSigningKey(sk, sk ? {} : process.env);
      recheckCommand({ dir: folder(), ...(review ? { review } : {}), log });
      await finishRecheck(folder(), { key, log });
      return 0;
    }
    case 'review':
      reviewCommand({ dir: folder(), log });
      return 0;
    case 'requirements':
      for (const r of REQUIREMENTS) log(`${r.id}\t${r.level}\t${r.summary}`);
      return 0;
    case '--version':
    case 'version':
      log(`${SUITE_NAME} ${SUITE_VERSION} (MWS ${SPEC_VERSION})`);
      return 0;
    default:
      if (a.cmd && a.cmd !== 'help' && a.cmd !== '--help' && a.cmd !== '-h') {
        process.stderr.write(`error: unknown command ${JSON.stringify(a.cmd)}\n\n`);
        log(USAGE);
        return 2;
      }
      log(USAGE);
      return 0;
  }
}

const isMain = process.argv[1] && /main\.js$|mcp-writecheck$/.test(process.argv[1]);
if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      process.stderr.write(`error: ${(e as Error).message}\n`);
      process.exit(e instanceof WritecheckError ? e.code : 4);
    },
  );
}
