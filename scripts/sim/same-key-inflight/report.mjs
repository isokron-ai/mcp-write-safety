#!/usr/bin/env node
// Merge the simulator (sim.json), the live harness (live-<variant>-<outcome>.json) and writecheck (wc-<variant>.json) into
// one JSON document and a Markdown summary (the job summary). Exits 1, after writing both, when a live cell was not valid
// (its hold did not fire, or its reset failed), a live cell disagrees with its simulated cell, a writecheck run failed, or
// an input is missing.
// Usage: node scripts/sim/same-key-inflight/report.mjs <in-dir> <out.json> <summary.md>
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OUTCOMES, POLICY_NAMES, POLICY_TEXT, VARIANT_TEXT, VARIANTS } from './model.mjs';

const [inDir, outJson, outMd] = process.argv.slice(2);
if (!inDir || !outJson || !outMd) { process.stderr.write('usage: report.mjs <in-dir> <out.json> <summary.md>\n'); process.exit(2); }
const problems = [];
const load = (name) => {
  const p = join(inDir, name);
  if (!existsSync(p)) { problems.push(`missing ${name}`); return null; }
  return JSON.parse(readFileSync(p, 'utf8'));
};
const sim = load('sim.json');
const live = Object.fromEntries(VARIANTS.flatMap((v) => OUTCOMES.map((o) => [`${v}-${o}`, load(`live-${v}-${o}.json`)])));
const wc = Object.fromEntries(VARIANTS.map((v) => [v, load(`wc-${v}.json`)]));

const pct = (x) => `${(100 * x).toFixed(1)}%`;
const HARMS = ['duplicate', 'lost', 'wrong'];
const harmful = (c) => HARMS.some((k) => c[k]);
/** Counts over cells: "dup d · lost l · wrong w · unres u / n". */
function tally(cells) {
  const n = cells.length;
  const k = (f) => cells.filter((c) => c[f]).length;
  return { n, duplicate: k('duplicate'), lost: k('lost'), wrong: k('wrong'), unresolved: k('unresolved'), harmful: cells.filter(harmful).length, extra: cells.reduce((s, c) => s + c.extra, 0) };
}
const cellText = (t) => (t.n ? `${t.harmful}/${t.n}${t.harmful ? ` (${[t.duplicate && `dup ${t.duplicate}`, t.lost && `lost ${t.lost}`, t.wrong && `wrong ${t.wrong}`].filter(Boolean).join(', ')})` : ''}` : 'n/a');

const md = [];
md.push('# Same key while the first write is in flight', '');
md.push('Evidence only: no judge behaviour is changed. Model and policies: `scripts/sim/same-key-inflight/model.mjs`.', '');
if (sim) {
  const k = sim.constants;
  md.push(`Client timeout ${k.timeout_ms} ms on every call (the first call times out and its library retries once with the same key, which meets the first write in flight); backoff ${k.backoff_ms} ms; ${k.retries} further tries; the first write lands or fails after d ∈ {${k.grid_delays_ms.join(', ')}} ms (on failure the key is closed ${k.fence_lead_ms} ms before the hold ends).`, '');
}
md.push('Variants:', ...VARIANTS.map((v) => `- **${v}**: ${VARIANT_TEXT[v]}`), '');
md.push('Policies:', ...POLICY_NAMES.map((p) => `- **${p}**: ${POLICY_TEXT[p]}`), '');

if (sim) {
  const g = sim.grid;
  md.push('## 1. Harm matrix (simulator, grid)', '');
  md.push(`Harmful cells (a duplicate, a lost write or a wrong final report) out of ${OUTCOMES.length * sim.constants.grid_delays_ms.length} per variant and policy (both first-write outcomes, every d).`, '');
  md.push(`| policy | ${VARIANTS.join(' | ')} |`, `|---|${VARIANTS.map(() => '---').join('|')}|`);
  for (const p of POLICY_NAMES) md.push(`| ${p} | ${VARIANTS.map((v) => cellText(tally(g.filter((c) => c.variant === v && c.policy === p)))).join(' | ')} |`);
  md.push('');
  md.push('Where the harm falls (first-write outcome, d in ms):', '');
  for (const v of VARIANTS) {
    const bad = g.filter((c) => c.variant === v && harmful(c));
    md.push(`- **${v}**: ${bad.length ? bad.map((c) => `${c.policy} ${c.outcome} ${c.d} (${HARMS.filter((h) => c[h]).join('+')}; reported ${c.report}, ${c.objects} object(s))`).join('; ') : 'none'}`);
  }
  md.push('');
  const pop = sim.population;
  md.push(`## 2. Summary per variant (simulator, seeded population: ${pop.runs} runs per variant and policy, seed ${pop.seed}, d log-uniform ${pop.dMin}-${pop.dMax} ms, first write fails in ${pct(pop.pFail)})`, '');
  md.push('| variant | policy | duplicate | lost write | wrong report | unresolved | extra calls (mean) |', '|---|---|---|---|---|---|---|');
  for (const r of pop.rows) md.push(`| ${r.variant} | ${r.policy} | ${pct(r.duplicate)} | ${pct(r.lost)} | ${pct(r.wrong)} | ${pct(r.unresolved)} | ${r.extra_mean.toFixed(2)} |`);
  md.push('');
  md.push('| variant | worst harm (any policy) | policies harmed (duplicate, lost or wrong > 0) |', '|---|---|---|');
  for (const v of VARIANTS) {
    const rows = pop.rows.filter((r) => r.variant === v);
    const worst = Math.max(...rows.map((r) => Math.max(r.duplicate, r.lost, r.wrong)));
    md.push(`| ${v} | ${pct(worst)} | ${rows.filter((r) => r.duplicate || r.lost || r.wrong).map((r) => `${r.policy} (${[r.duplicate && `dup ${pct(r.duplicate)}`, r.lost && `lost ${pct(r.lost)}`, r.wrong && `wrong ${pct(r.wrong)}`].filter(Boolean).join(', ')})`).join('; ') || 'none'} |`);
  }
  md.push('');
}

md.push('## 3. Live confirmation (tiny-tracker, the MCP layer, scripted clients P1-P5)', '');
md.push('| variant | outcome | cells | valid | match the simulator | harmful (live) | harmful (sim) |', '|---|---|---|---|---|---|---|');
const mismatches = [];
for (const v of VARIANTS) {
  for (const o of OUTCOMES) {
    const l = live[`${v}-${o}`];
    if (!l) { md.push(`| ${v} | ${o} | missing | | | | |`); continue; }
    if (l.error) problems.push(`live ${v} ${o}: ${l.error.split('\n')[0]}`);
    const inv = l.cells.filter((c) => !c.valid);
    if (inv.length) problems.push(`live ${v} ${o}: ${inv.length} cell(s) not valid (hold not fired or reset failed)`);
    for (const c of l.cells.filter((x) => !x.match)) mismatches.push(c);
    const simHarm = sim ? sim.grid.filter((c) => c.variant === v && c.outcome === o && harmful(c)).length * (l.repeats ?? 1) : 'n/a';
    md.push(`| ${v} | ${o} | ${l.total} | ${l.valid} | ${l.matched}/${l.total} | ${l.cells.filter(harmful).length} | ${simHarm} |`);
  }
}
md.push('');
if (mismatches.length) {
  problems.push(`${mismatches.length} live cell(s) disagree with the simulator`);
  md.push('Cells where live and simulator disagree:', '');
  for (const c of mismatches.slice(0, 40)) md.push(`- ${c.variant} ${c.outcome} ${c.policy} d=${c.d} rep ${c.rep}: live ${c.report}, ${c.objects} object(s), ${c.calls} call(s) [${c.classes}]; sim ${c.sim.report}, ${c.sim.objects}, ${c.sim.calls} [${c.sim.classes}]`);
  md.push('');
}
const liveCells = Object.values(live).filter(Boolean).flatMap((l) => l.cells);
if (liveCells.length) {
  md.push('Live harm matrix (harmful cells out of all live cells per variant and policy):', '');
  md.push(`| policy | ${VARIANTS.join(' | ')} |`, `|---|${VARIANTS.map(() => '---').join('|')}|`);
  for (const p of POLICY_NAMES) md.push(`| ${p} | ${VARIANTS.map((v) => cellText(tally(liveCells.filter((c) => c.variant === v && c.policy === p)))).join(' | ')} |`);
  md.push('');
  md.push('What the live server answered to the same-key retry (first trace line after the timeout), per variant:', '');
  for (const v of VARIANTS) {
    const c = liveCells.find((x) => x.variant === v && x.outcome === 'lands' && x.d === 3000);
    const second = c?.trace?.[1];
    md.push(`- **${v}**: ${second ? `${second.cls}${second.code ? ` (${second.code})` : ''}${second.text ? `: ${JSON.stringify(second.text)}` : ''}` : 'n/a'}`);
  }
  md.push('');
}

md.push('## 4. writecheck verdict (inflight.same-key, MWS-RES-2) under both readings', '');
md.push('Strict: what writecheck reports today (B-9: the repeat\'s outcome describes the keyed write). Lenient: the repeat\'s outcome describes only the call that carried it (computed from writecheck\'s own record; see writecheck.mjs).', '');
md.push('| variant | create_ticket strict | create_ticket lenient | differ | create_project (control, unchanged build) | violated in the whole run |', '|---|---|---|---|---|---|');
const differ = [];
for (const v of VARIANTS) {
  const w = wc[v];
  if (!w) { md.push(`| ${v} | missing | | | | |`); continue; }
  if (!w.ok) { problems.push(`writecheck ${v}: ${w.error}`); md.push(`| ${v} | error | | | | ${w.error.slice(0, 80)} |`); continue; }
  const t = w.records.find((r) => r.tool === 'create_ticket');
  const p = w.records.find((r) => r.tool === 'create_project');
  if (!t) problems.push(`writecheck ${v}: no inflight.same-key record for create_ticket`);
  const d = t && t.strict !== t.lenient.verdict;
  if (d) differ.push(v);
  md.push(`| ${v} | ${t?.strict ?? 'none'} | ${t?.lenient.verdict ?? 'none'} | ${d ? '**yes**' : 'no'} | ${p?.strict ?? 'none'} | ${w.observed.join(', ') || 'none'} |`);
}
md.push('');
md.push(differ.length ? `The readings differ for: ${differ.join(', ')}.` : 'The readings give the same verdict for every variant.', '');
md.push('Strict reasons (create_ticket):', '');
for (const v of VARIANTS) {
  const t = wc[v]?.records?.find((r) => r.tool === 'create_ticket');
  if (t) md.push(`- **${v}** ${t.strict}: ${t.reason.slice(0, 400)}${t.reason.length > 400 ? '…' : ''}`);
}
md.push('');
if (problems.length) md.push('## Problems', '', ...problems.map((p) => `- ${p}`), '');

writeFileSync(outMd, `${md.join('\n')}\n`, { flag: 'a' });
writeFileSync(outJson, `${JSON.stringify({ kind: 'same-key-inflight/report', sim, live, writecheck: wc, differ, problems }, null, 1)}\n`);
process.stdout.write(`${md.join('\n')}\n`);
process.exit(problems.length ? 1 : 0);
