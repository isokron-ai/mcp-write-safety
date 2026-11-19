/**
 * report.md, for people. The first line is the scope sentence. Then every violation (MUST, then SHOULD); then, per area, a table of
 * requirement, write path, verdict, numbers and reason; then what held, what was not tested and
 * why, what is not built, the Annex A measurements, leftovers, and how to verify the evidence.
 * No summary line, no counts, no colours: a reader goes row by row.
 */

import { previewSentence, requirement, requirementLink } from '../requirements.js';
import type { ResultsDoc } from './results.js';
import { mcpLine } from './protocol.js';
import { writePathKey, type Result } from './verdicts.js';

const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

function numbers(r: Result): string {
  const e = Object.entries(r.numbers).filter(([, v]) => v !== null && v !== undefined);
  return e.length ? e.map(([k, v]) => `${k}=${typeof v === 'number' ? v : JSON.stringify(v)}`).join(', ') : '';
}

export function renderMarkdown(d: ResultsDoc): string {
  const L: string[] = [];
  L.push(d.scope);
  L.push('');
  L.push(previewSentence());
  L.push('');
  L.push(`# mcp-writecheck results: ${d.target.confirm}`);
  L.push('');
  if (d.target.guard?.basis === 'operator' && d.target.guard.note) {
    L.push(`Tenant guard: ${d.target.guard.note}`);
    L.push('');
  }
  // why: review B2: every call of the guard's tool is counted in the report (and each is in the ledger).
  if (d.target.guard?.calls) {
    L.push(`Tenant guard calls: ${d.target.guard.tool} was called ${d.target.guard.calls} time(s)${d.target.guard.counted_as_writes ? `; ${d.target.guard.counted_as_writes} of them counted as writes against the write budget, as the call rests on the operator's declaration` : ''}.`);
    L.push('');
  }
  // why: problem 14 in the GitHub Action's NOTES.md: an incomplete run says so, and why, before anything else.
  if (d.run.status === 'stopped') {
    const why = (d.run.stopped_reason ?? 'it stopped').replace(/[*_`[\]<>\\]/g, (c) => `\\${c}`).replace(/\n/g, ' ');
    L.push(`**This run is incomplete (exit ${/^interrupted by /.test(d.run.stopped_reason ?? '') ? 130 : 4}): ${why}.** Records it did not reach are \`not tested\`; see "Leftovers" for objects that may remain.`);
    L.push('');
  }
  L.push(`Run ${d.run.id} (prefix \`${d.run.prefix}\`), ${d.run.started} to ${d.run.ended}, ${d.run.status}${d.run.stopped_reason ? `: ${d.run.stopped_reason}` : ''}. ${d.suite.name} ${d.suite.version} against MWS ${d.spec.version}. Plan ${d.plan.hash}; manifest sha256 ${d.manifest.sha256}.`);
  L.push('');
  // Objects the tester did not create that a call lost come before everything else (the bystander inventory).
  const lost = d.results.filter((r) => Array.isArray(r.numbers['bystanders_lost']) && (r.numbers['bystanders_lost'] as unknown[]).length);
  if (lost.length) {
    L.push('## Objects the tester did not create were changed or deleted');
    L.push('');
    L.push('The tester lists every object it can list outside its own before and after each targeting call. These were gone, changed, or missing from every listing afterwards (scope/id). Check them, and restore what was lost from your backup; the records below say which call. A change is not attributed to the call: other activity on the backend can change an object.');
    L.push('');
    for (const r of lost) L.push(`- **${r.requirement}** on \`${writePathKey(r.write_path)}\` (${r.verdict}): ${(r.numbers['bystanders_lost'] as string[]).map((x) => `\`${esc(x)}\``).join(', ')}`);
    L.push('');
  }
  // What each targeting record's bystander inventory listed (gate-2 re-run on 6b028ec, note 14): the inventory is only as
  // complete as the server's lists, so the report says what it covered.
  const inv = d.results.filter((r) => r.numbers['bystander_inventory'] && typeof r.numbers['bystander_inventory'] === 'object');
  if (inv.length) {
    L.push('## What the bystander inventory covered');
    L.push('');
    L.push('Objects outside the tester\'s own that the server\'s lists do not show (another scope, a further page, a filtered list) are not covered: "not seen to be lost" is the most a record says.');
    L.push('');
    for (const r of inv) {
      const b = r.numbers['bystander_inventory'] as { unavailable?: string; scopes?: unknown[]; objects?: number; lists?: string[]; read_back_by_id?: boolean; partial?: string[] };
      L.push(`- **${r.requirement}** on \`${writePathKey(r.write_path)}\` (${r.verdict}): ${b.unavailable ? `no inventory (${esc(b.unavailable)})` : `${(b.scopes ?? []).length} scope(s) (${(b.scopes ?? []).map((x) => `\`${esc(String(x))}\``).join(', ') || 'none'}), ${b.objects ?? 0} object(s) through ${(b.lists ?? []).map((x) => `\`${esc(x)}\``).join(', ') || 'no list'}${b.read_back_by_id ? ', each read back by id' : ''}${(b.partial ?? []).length ? `; partial: ${(b.partial ?? []).map(esc).join('; ')}` : ''}`}`);
    }
    L.push('');
  }
  // Warnings about the declaration (i8): an ignored field the tool under test can set.
  if ((d.safety as { warnings?: string[] }).warnings?.length) {
    L.push('## Warnings about the declaration');
    L.push('');
    for (const w of (d.safety as { warnings?: string[] }).warnings!) L.push(`- ${esc(w)}`);
    L.push('');
  }
  // Violations first: every violated MUST, then every violated SHOULD, with the link to its text and the trace.
  const vio = [...d.results.filter((r) => r.verdict === 'violated' && r.level === 'MUST'), ...d.results.filter((r) => r.verdict === 'violated' && r.level === 'SHOULD')];
  L.push('## Violations');
  L.push('');
  if (!vio.length) L.push('No requirement was violated in this run. That is not a statement that the server is safe: see what was not tested, below.');
  for (const r of vio) L.push(`- **${r.requirement}** (${r.level}) on \`${writePathKey(r.write_path)}\`: ${r.reason}${r.attribution ? ` Attribution: ${r.attribution}.` : ''} Requirement: ${requirementLink(r.requirement)} (in the MWS repository).${r.steps.length ? ` Trace: ${r.steps.slice(0, 4).map((x) => `\`${x}\``).join(', ')}${r.steps.length > 4 ? ', …' : ''}.` : ''}`);
  if (vio.some((r) => r.steps.length)) {
    L.push('');
    L.push('Each trace id is the `step` of lines in `capture/capture.jsonl` (the request and the answer, redacted): `grep \'"step":"<id>"\' capture/capture.jsonl`.');
  }
  L.push('');
  L.push('Verdicts: `violated` (reproduced; if a control ran, the platform API did not do the same), `platform` (the platform API does the same), `held` (the situation was forced and the server did the right thing), `not observed` (attempted, not forced, nothing seen; not evidence of safety), `not tested` (with the reason), `not applicable`, `self-attested`. There is no total and no score.');
  const areas = [...new Set(d.results.map((r) => requirement(r.requirement).area))];
  for (const area of areas) {
    L.push('');
    L.push(`## ${area}`);
    L.push('');
    L.push('| Requirement | Level | Write path | Verdict | Numbers | Why |');
    L.push('|---|---|---|---|---|---|');
    for (const r of d.results.filter((x) => requirement(x.requirement).area === area)) L.push(`| ${r.requirement} | ${r.level} | ${esc(writePathKey(r.write_path))} | ${r.verdict} | ${esc(numbers(r))} | ${esc(r.reason)}${r.notes.length ? ` _${esc(r.notes.join(' '))}_` : ''}${r.steps.length ? ` (trace: ${esc(r.steps.slice(0, 4).join(', '))}${r.steps.length > 4 ? ', …' : ''})` : ''} |`);
  }
  L.push('');
  L.push('## What held');
  L.push('');
  const held = d.results.filter((r) => r.verdict === 'held');
  if (!held.length) L.push('Nothing was forced and found correct in this run.');
  for (const r of held) L.push(`- ${r.requirement} on ${writePathKey(r.write_path)}: ${r.reason}`);
  L.push('');
  L.push('## Not tested, and why');
  L.push('');
  for (const r of d.results.filter((x) => x.verdict === 'not tested')) L.push(`- ${r.requirement} on ${writePathKey(r.write_path)}: ${r.reason}`);
  const attested = d.results.filter((x) => x.verdict === 'self-attested');
  if (attested.length) {
    L.push('');
    L.push('## Self-attested (review-only clauses)');
    L.push('');
    L.push('Each answer is the statement of the person named, recorded as given; the tool did not judge it.');
    L.push('');
    for (const r of attested) L.push(`- ${r.requirement} on ${writePathKey(r.write_path)}: ${r.reason}`);
  }
  if (d.not_built.length) {
    L.push('');
    L.push('## Not built in this release');
    L.push('');
    for (const n of d.not_built) L.push(`- ${n.requirement}: ${n.reason}`);
  }
  L.push('');
  L.push('## Seat belts');
  L.push('');
  const sf = d.safety;
  L.push(`- Backend traffic: ${sf.gate ? `${sf.gate.description} (route ${sf.gate.route})` : 'not interposed on (no backend.gate): forced interleavings and injected faults were not run'}.`);
  L.push(`- Protocol: ${d.target.mcp ? mcpLine(d.target.mcp) : sf.protocol ?? 'not recorded'}`);
  if (d.target.mcp?.input_requests.length) L.push(`- Requests for input from the server (spec 7.3, rule 10): ${d.target.mcp.input_requests.slice(0, 10).map((q) => `${q.step} (${q.tool}): ${q.method}; the tester answered ${q.answer}`).join('; ')}${d.target.mcp.input_requests.length > 10 ? '; …' : ''}.`);
  if (d.target.mcp) L.push(`- What a result says was decided by these patterns (spec 7.3, rule 11): ${Object.entries(d.target.mcp.patterns).map(([k, v]) => `${k} (${v.from})`).join(', ')}; the expressions are in results.json.`);
  const rs = d.target.mcp?.result_shapes;
  if (rs && (rs.shape || Object.keys(rs.tools).length)) L.push(`- Result shape adopted (spec 7.3, rule 11): ${rs.shape ?? 'none'} at the top level${Object.keys(rs.tools).length ? `; per tool: ${Object.entries(rs.tools).map(([t, s]) => `${t} ${s ?? 'none'}`).join(', ')}` : ''}. Where a result carries it well formed, it decides what that result says, before the patterns; the read-back still decides what happened.`);
  if (sf.rerun_of) L.push(`- This run repeats run ${sf.rerun_of}.`);
  L.push(`- Untouched-state canaries: ${sf.canaries.length ? sf.canaries.map((c) => `${c.name} (${c.tool}) ${c.unchanged === true ? 'unchanged' : c.unchanged === false ? `CHANGED${c.note ? `: ${c.note}` : ''}` : `not compared${c.note ? `: ${c.note}` : ''}`}`).join('; ') : 'none declared'}.`);
  if (sf.fixtures_restored.length) L.push(`- Fixtures put back to their original values: ${sf.fixtures_restored.map((f) => `${f.resource} ${f.restored ? 'restored' : `NOT restored${f.note ? ` (${f.note})` : ''}`}`).join('; ')}.`);
  if (d.measurements) {
    L.push('');
    L.push('## Annex A: measured, not judged');
    L.push('');
    const m = d.measurements;
    L.push(`- A-1 round trips: ${m['A-1'].jobs.length ? m['A-1'].jobs.map((j) => `${j.resource}/${j.name}: ${j.calls} call(s)${j.ok ? '' : ` (stopped at call ${j.failed_at})`}`).join('; ') : m['A-1'].note}.`);
    L.push(`- A-2 catalog size: ${m['A-2'].tools} tools, ${m['A-2'].bytes_total} bytes (descriptions ${m['A-2'].bytes_descriptions}, input schemas ${m['A-2'].bytes_input_schemas}, output schemas ${m['A-2'].bytes_output_schemas}, annotations ${m['A-2'].bytes_annotations}, icons ${m['A-2'].bytes_icons}, other ${m['A-2'].bytes_other}).`);
    L.push(`- A-3 largest result seen: ${m['A-3'].largest_result_bytes ?? 'n/a'} bytes${m['A-3'].at_step ? ` (step ${m['A-3'].at_step})` : ''}.`);
    L.push(`- A-4 tools/list order stable across two lists: ${m['A-4'].order_stable_across_two_lists ?? 'not measured'}; descriptions naming tools not in the catalog: ${m['A-4'].unknown_tool_references.length ? m['A-4'].unknown_tool_references.map((u) => `${u.tool} → ${u.names.join(', ')}`).join('; ') : 'none'}.`);
  }
  L.push('');
  L.push('## Leftovers');
  L.push('');
  if (!d.leftovers.length) L.push(`None. Every object this run created is accounted for in the ledger.`);
  else {
    L.push(`Search for the prefix \`${d.run.prefix}\` to find them.`);
    L.push('');
    L.push('| Resource | Id | Name | How | Why it is left |');
    L.push('|---|---|---|---|---|');
    for (const l of d.leftovers) L.push(`| ${esc(l.resource)} | ${esc(JSON.stringify(l.id))} | ${esc(l.name ?? '')} | ${esc(l.how)} | ${esc(l.reason)} |`);
  }
  L.push('');
  L.push('## Evidence');
  L.push('');
  L.push('`SHA256SUMS` lists every file in this folder. Check it with `shasum -a 256 -c SHA256SUMS` (or `sha256sum -c`).');
  // why: F8: evidence.signature is the ssh signature file of SHA256SUMS (a string), or a results signature naming it in `sums`.
  const sig = d.evidence.signature;
  const sums = typeof sig === 'string' ? sig : sig?.sums ?? null;
  if (sums) L.push(`It is signed with the runner's own SSH key (\`${sums}\`): \`ssh-keygen -Y verify -f allowed_signers -I <signer> -n mcp-writecheck -s SHA256SUMS.sig < SHA256SUMS\`. A signature shows the files were not changed afterwards; it does not show there were no other runs, and it is the runner's own statement about its own server.`);
  if (sig && typeof sig === 'object') L.push(`results.json is signed with the Ed25519 key \`${sig.key_id}\` (content digest \`${sig.digest}\`): \`mcp-writecheck verify-results results.json --pubkey <the signer's public key>\`. Check it against a key obtained from the signer, not the one embedded in the file.`);
  else if (!sig) L.push('results.json is not signed.');
  if (d.identity) {
    const i = d.identity;
    const srv = [i.server.repo, i.server.tag, i.server.commit ? `@ ${i.server.commit}` : null, i.server.image].filter(Boolean).join(' ');
    L.push(`Run identity (\`results.identity\`): ${i.tester.name} ${i.tester.version} @ ${i.tester.commit ?? 'unstamped build'}${i.tester.dirty ? ' (uncommitted changes)' : ''}; MWS ${i.spec.version}; server build ${srv || 'not stated'}${i.backend.length ? `; backend ${i.backend.map((b) => `${b.name} ${b.image ?? '(no image)'}`).join(', ')}` : ''}. Each record carries a \`test_hash\`; \`mcp-writecheck compare\` joins two runs on it.`);
    if (i.gaps.length) L.push(`Not stated or not pinned: ${i.gaps.map((g) => esc(g)).join('; ')}.`);
  }
  L.push('`mcp-writecheck recheck <this folder>` re-applies the current rules to the recorded observations without contacting the server.');
  L.push('');
  L.push('Every `violated` from simultaneous or stale calls was produced deliberately; it says nothing about how often it happens in normal use.');
  return L.join('\n') + '\n';
}
