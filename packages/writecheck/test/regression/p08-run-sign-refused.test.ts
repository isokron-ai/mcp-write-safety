/**
 * p08 (signature canonical form), the run side: `run --sign-key` over results that RFC 8785 cannot express (a lone
 * surrogate that came back in a captured answer) signs nothing, writes the results unsigned, prints an `error:` line and exits 4,
 * so that the missing signature is not missed (MANIFEST.md, Signed results).
 */

import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { planCommand } from '../../src/cli/commands.js';
import { runCommand } from '../../src/cli/run.js';
import { verifyResults } from '../../src/report/sign.js';
import { CONFIRM, head, startFixture, TRACKER_GUARD } from './harness.js';
import { PATCH_UPDATE, PROJECT, ticket } from './tracker-fixture.js';

// a field value with a lone high surrogate: the tool is asked to set it, and the read-back carries it into results.json
const LONE = `      - { path: assignee, values: [ann, "b\\ud800ob"] }
      - { path: status, values: [blocked, closed] }`;
const MANIFEST = `${head({ guard: TRACKER_GUARD })}
resources:
${PROJECT}${ticket({ update: PATCH_UPDATE, fields: LONE })}`;

test('p08: run --sign-key over results with a lone surrogate writes them unsigned, prints an error: line and exits 4', async () => {
  const f = await startFixture({ profile: 'tracker', manifest: MANIFEST });
  try {
    const key = join(f.dir, 'sign.pem');
    writeFileSync(key, generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }) as string);
    const lines: string[] = [];
    const log = (s: string) => lines.push(s);
    const { hash } = await planCommand({ manifest: f.manifest, env: f.env, log: () => {} });
    const r = await runCommand({ manifest: f.manifest, outRoot: join(f.dir, 'out'), stateDir: join(f.dir, 'state'), confirmTarget: CONFIRM, planHash: hash, interactive: false, env: f.env, log, noSignals: true, identity: { signKey: key } });
    assert.equal(r.exit, 4, lines.join('\n'));
    assert.ok(lines.some((l) => /^error: results\.json is not signed: /.test(l)), lines.join('\n'));
    const dir = join(f.dir, 'out', readdirSync(join(f.dir, 'out'))[0]!);
    const text = readFileSync(join(dir, 'results.json'), 'utf8');
    assert.match(text, /\\ud800/i, 'the captured value is in the results as written');
    const doc = JSON.parse(text) as { evidence: { signature: unknown } };
    assert.equal(doc.evidence.signature, null, 'written unsigned');
    assert.equal(verifyResults(doc, null).status, 'unsigned');
  } finally {
    await f.close();
  }
});
