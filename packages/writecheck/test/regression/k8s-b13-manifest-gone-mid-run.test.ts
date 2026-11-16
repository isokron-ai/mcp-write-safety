/**
 * kubernetes/CLI-BUGS.md B13: a run whose manifest file disappeared while it ran went through every
 * check and then wrote no results.
 *
 * Validation row (kubernetes, e94270a against v0.1.3; not tried on 66e40e2). The run's folder was
 * removed and restored by another process while the run was going:
 *   server: launch-settings…
 *   server: credential-scan…
 *   error: ENOENT: no such file or directory, open 'writecheck.yaml'
 * Exit status 4; `capture/` and `history.jsonl` exist, `results.json` and `report.md` do not.
 *
 * Deciding text. Not a verdict question. Spec 5.3: a conformance statement "includes the declaration
 * used. A statement whose declaration is not shown cannot be checked." The tool's README: "Each run writes
 * `report.md` (first line: the scope), `results.json` […]", and results.json names the manifest by path
 * and sha256. The manifest was loaded and hashed when the run started, so the copy written beside the
 * results can be made from that text, and a file that is gone at the end must not cost the run its
 * results.
 *
 * On 7562919 the copy is still read from the path at the end of the run (src/cli/run.ts:
 * `writeFileSync(join(outDir, doc.manifest.path), red.text(readFileSync(o.manifest, 'utf8')))`).
 *
 * Status: fails on 7562919; passes on d3b536f, fixed by the owners in 9d7234d. Kept, skipped, as the regression test for that fix.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { fixed, head, runFixture, startFixture, TRACKER_GUARD } from './harness.js';
import { ASSIGNEE_STATUS, PATCH_UPDATE, ticket } from './tracker-fixture.js';

const MANIFEST = `${head({ guard: TRACKER_GUARD })}
resources:
${ticket({ update: PATCH_UPDATE, fields: ASSIGNEE_STATUS })}`;

test('kubernetes/CLI-BUGS B13: a manifest file that disappears during the run does not cost the run its results', { skip: fixed('9d7234d', 'kubernetes/CLI-BUGS.md B13') }, async () => {
  const f = await startFixture({ profile: 'tracker', manifest: MANIFEST });
  try {
    let removed = false;
    // The manifest is removed once the run is under way (after the tenant guard, before the first check).
    const r = await runFixture(f, {
      log: (s) => {
        if (!removed && /tenant guard matched/.test(s)) {
          rmSync(f.manifest);
          removed = true;
        }
      },
    });
    assert.ok(removed, 'the manifest was removed while the run was going');
    assert.equal(r.doc.run.status, 'complete');
    for (const file of ['results.json', 'report.md', 'SHA256SUMS']) assert.ok(existsSync(join(r.outDir, file)), `${file} is written`);
    // The declaration the run used is kept with the results (redacted like every other file, so its bytes may differ).
    const copy = join(r.outDir, r.doc.manifest.path);
    assert.ok(existsSync(copy) && readFileSync(copy, 'utf8').includes('ticket_update'), 'the manifest the run used is kept with the results');
    assert.equal(f.backend.all('tickets').length, 0, 'nothing of the run is left behind');
  } finally {
    await f.close();
  }
});
