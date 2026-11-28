// R-INP-01: the dispatch inputs of the T0 worker workflows are checked as whole strings.
// Runs in ci.yml's spec job (node --test scripts/ci/*.test.mjs).
//
// The guard step ("Kill switch, then validate the inputs") of defect-matrix.yml used to check each input with
// `printf '%s' "$v" | grep -Eq "$pattern"`. grep matches line by line, so a value with a newline passed when one
// of its lines did, and the value then went into $GITHUB_OUTPUT, where its second line could set another output.
// The fix matches with `[[ "$v" =~ $pattern ]]`. The guard script is taken from the YAML and run with bash.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dir = join(root, '.github', 'workflows');
const STEP = 'name: Kill switch, then validate the inputs';

/** The `run: |` block of the step named STEP, dedented. */
function guardScript(yaml) {
  const lines = yaml.split('\n');
  const at = lines.findIndex((l) => l.trim() === STEP);
  assert.ok(at >= 0, 'the guard step');
  let i = at + 1;
  while (i < lines.length && !/^\s*run: \|\s*$/.test(lines[i])) i++;
  assert.ok(i < lines.length, 'run: | in the guard step');
  const runIndent = lines[i].search(/\S/);
  const body = [];
  for (i++; i < lines.length; i++) {
    if (lines[i].trim() !== '' && lines[i].search(/\S/) <= runIndent) break;
    body.push(lines[i]);
  }
  const indent = Math.min(...body.filter((l) => l.trim()).map((l) => l.search(/\S/)));
  return body.map((l) => l.slice(indent)).join('\n');
}

const workflows = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f) && readFileSync(join(dir, f), 'utf8').includes(STEP)).sort();
const GOOD = { IN_SHARD_ID: 's-1', IN_ATTEMPT_ID: 'a.2_x', IN_FENCE: 'f:3', IN_RUN_KEY: 'k:4', IN_DEFECTS: 'digest-of-current-state,lookup-reexecutes', IN_MODE: 'min' };

function run(script, env) {
  const tmp = mkdtempSync(join(tmpdir(), 'wf-inputs-'));
  try {
    const out = join(tmp, 'out');
    writeFileSync(out, '');
    const r = spawnSync('bash', ['-e', '-c', script], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, GITHUB_OUTPUT: out, LOOP_ENABLED: 'true', ...GOOD, ...env } });
    return { status: r.status, text: `${r.stdout}${r.stderr}`, out: readFileSync(out, 'utf8') };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

test('R-INP-01: every T0 worker refuses a dispatch input with a newline in it', () => {
  assert.deepEqual(workflows, ['defect-matrix.yml']);
  for (const wf of workflows) {
    const script = guardScript(readFileSync(join(dir, wf), 'utf8'));
    assert.doesNotMatch(script, /\|\s*grep/, `${wf}: no line-by-line grep match`);

    const ok = run(script, {});
    assert.equal(ok.status, 0, `${wf}: good inputs pass\n${ok.text}`);
    assert.match(ok.out, /^go=true\nattempt_id=a\.2_x\nfence=f:3\nrun_key=k:4\ncells=\[.*"digest-of-current-state".*\]\nmode=min\n$/, wf);
    assert.match(run(script, { IN_MODE: '' }).out, /\nmode=full\n$/, `${wf}: no mode is full mode`);
    assert.equal(run(script, { IN_MODE: 'max' }).status, 1, `${wf}: a mode other than full or min is refused`);
    assert.equal(run(script, { IN_DEFECTS: '' }).status, 0, `${wf}: no defects runs the control set`);

    for (const [name, good] of Object.entries(GOOD)) {
      for (const bad of [`${good}\ngo=true`, `${good}\n`, `\n${good}`]) {
        const r = run(script, { [name]: bad });
        assert.equal(r.status, 1, `${wf}: ${name}=${JSON.stringify(bad)} is refused`);
        assert.match(r.text, /::error::input \w+ is empty or has a character outside its allowed set/, wf);
        assert.equal(r.out, '', `${wf}: nothing reaches GITHUB_OUTPUT`);
      }
    }
  }
});

test('R-INP-01: the old grep check let a newline through, so the test above can fail', () => {
  const script = guardScript(readFileSync(join(dir, 'defect-matrix.yml'), 'utf8'));
  const old = script.replace(/if ! \[\[ "\$2" =~ \$3 \]\]; then/, 'if ! printf \'%s\' "$2" | grep -Eq "$3"; then');
  assert.notEqual(old, script, 'the check line was found and swapped');
  const r = run(old, { IN_FENCE: 'f:3\nrun_key=forged' });
  assert.equal(r.status, 0);
  assert.match(r.out, /^run_key=forged$/m, 'the second line became an output of its own');
});
