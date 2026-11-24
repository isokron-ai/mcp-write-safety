// R-DM-01: the defect matrix compares against the known answers of the package's own version.
// Runs in ci.yml's spec job (node --test scripts/ci/*.test.mjs).
//
// defect-matrix.yml's "Known-answer check" read expected/0.3.0.json and 0.3.0's labels whatever the package's
// version, so after the 0.4.0 bump every build_hash differed and every run failed. It now takes the version
// from examples/tiny-tracker/package.json and picks labels in either release's shape. Here the step's script
// is taken from the YAML and run with bash, as GitHub runs it, in a copy of examples/tiny-tracker's expected/
// folder whose generate.mjs is a stub: it answers with the committed row (or a wrong one) without building.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const tt = join(root, 'examples', 'tiny-tracker');
const yaml = readFileSync(join(root, '.github', 'workflows', 'defect-matrix.yml'), 'utf8');
const temps = [];
after(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** The `run: |` block of the step with this name, dedented. */
function stepScript(name) {
  const lines = yaml.split('\n');
  const at = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  assert.ok(at >= 0, name);
  let i = at + 1;
  while (i < lines.length && !/^\s*run: \|\s*$/.test(lines[i])) i++;
  const runIndent = lines[i].search(/\S/);
  const body = [];
  for (i++; i < lines.length; i++) {
    if (lines[i].trim() !== '' && lines[i].search(/\S/) <= runIndent) break;
    body.push(lines[i]);
  }
  const indent = Math.min(...body.filter((l) => l.trim()).map((l) => l.search(/\S/)));
  return body.map((l) => l.slice(indent)).join('\n');
}

const STUB = `import { appendFileSync, readFileSync } from "node:fs";
export async function generate({ builds, only }) {
  appendFileSync("calls.ndjson", JSON.stringify({ builds, only }) + "\\n");
  const v = /builds-(.+)\\.json$/.exec(builds)[1];
  const row = JSON.parse(readFileSync(\`expected/\${v}.json\`, "utf8")).builds.find((b) => b.label === only[0]);
  if (process.env.STUB_WRONG_HASH) return { builds: [{ ...row, build_hash: "0".repeat(64) }] };
  return { builds: [row] };
}
`;

/** A working directory like examples/tiny-tracker at `version`, with that version's known answers. */
function tree(version) {
  const dir = mkdtempSync(join(tmpdir(), 'defect-matrix-'));
  temps.push(dir);
  mkdirSync(join(dir, 'expected'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'tiny-tracker', version }));
  for (const f of [`${version}.json`, `builds-${version}.json`]) copyFileSync(join(tt, 'expected', f), join(dir, 'expected', f));
  writeFileSync(join(dir, 'expected', 'generate.mjs'), STUB);
  return dir;
}

const script = stepScript('Known-answer check');

function check(dir, env) {
  const r = spawnSync('bash', ['-e', '-c', script], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, KIND: '', LABEL: '', DEFECT: '', ...env } });
  let calls = [];
  try { calls = readFileSync(join(dir, 'calls.ndjson'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { /* none */ }
  writeFileSync(join(dir, 'calls.ndjson'), '');
  return { status: r.status, text: `${r.stdout}${r.stderr}`, calls };
}

test('R-DM-01: the known-answer check uses the package version\'s files and labels, never a fixed release', () => {
  assert.doesNotMatch(script, /expected\/(builds-)?\d+\.\d+\.\d+\.json/, 'no known-answer file of a fixed release');
  const version = JSON.parse(readFileSync(join(tt, 'package.json'), 'utf8')).version;
  assert.notEqual(version, '0.3.0', 'this branch is past 0.3.0');
  const dir = tree(version);
  const cases = [
    [{ KIND: 'known-good', LABEL: 'correct build' }, 'L2 correct build'],
    [{ KIND: 'known-bad', LABEL: 'backend defect digest-of-current-state' }, 'L2, backend digest-of-current-state'],
    [{ KIND: 'defect', DEFECT: 'lookup-reexecutes' }, 'L2, defect lookup-reexecutes'],
    [{ KIND: 'defect', DEFECT: 'digest-of-current-state' }, 'L2, backend digest-of-current-state'],
  ];
  for (const [env, label] of cases) {
    const r = check(dir, env);
    assert.equal(r.status, 0, `${JSON.stringify(env)}\n${r.text}`);
    assert.deepEqual(r.calls, [{ builds: `expected/builds-${version}.json`, only: [label] }]);
    assert.match(r.text, new RegExp(`matches expected/${version.replaceAll('.', '\\.')}\\.json`));
  }
});

test('R-DM-01: an unknown defect is refused, and a build that answers differently fails', () => {
  const version = JSON.parse(readFileSync(join(tt, 'package.json'), 'utf8')).version;
  const dir = tree(version);
  const unknown = check(dir, { KIND: 'defect', DEFECT: 'no-such-defect' });
  assert.equal(unknown.status, 1);
  assert.match(unknown.text, /no single-defect build in expected\/builds-/);
  assert.deepEqual(unknown.calls, []);
  const wrong = check(dir, { KIND: 'known-good', STUB_WRONG_HASH: '1' });
  assert.equal(wrong.status, 1);
  assert.match(wrong.text, /build_hash differs from the committed row/);
});

test('R-DM-01: the same check still reads a 0.3.0 tree in 0.3.0\'s label shape', () => {
  const dir = tree('0.3.0');
  for (const [env, label] of [
    [{ KIND: 'known-good' }, 'correct build'],
    [{ KIND: 'known-bad' }, 'backend defect digest-of-current-state'],
    [{ KIND: 'defect', DEFECT: 'lookup-reexecutes' }, 'defect lookup-reexecutes'],
  ]) {
    const r = check(dir, env);
    assert.equal(r.status, 0, `${JSON.stringify(env)}\n${r.text}`);
    assert.deepEqual(r.calls, [{ builds: 'expected/builds-0.3.0.json', only: [label] }]);
  }
});
