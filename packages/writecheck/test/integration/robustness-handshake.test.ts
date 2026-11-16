/**
 * Corpus verification against third-party servers (robustness items 1 and 2):
 *   1  server/discover was sent before initialize, and servers on the MCP Python SDK 1.6 exit on any message before initialize.
 *      In `auto`, nothing goes out before initialize; the discover probe comes after the handshake.
 *   2  plan and the catalog stopped where resources/templates/list (or prompts/list) answered -32601 Method not found; an optional
 *      list a server does not implement is read as none.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runFake, startFake } from '../fake/harness.js';

test('robustness 1: a server that exits on a message before initialize is tested to the end', async () => {
  const f = await startFake({ defects: ['exit-before-initialize'] });
  try {
    const r = await runFake(f);
    assert.equal(r.doc.run.status, 'complete', JSON.stringify(r.doc.run));
    assert.ok(r.doc.results.length > 0);
  } finally {
    await f.close();
  }
});

test('robustness 2: resources/templates/list and prompts/list answered -32601 read as none; the run goes on', async () => {
  const f = await startFake({ defects: ['templates-not-found'] });
  try {
    const r = await runFake(f);
    assert.equal(r.doc.run.status, 'complete', JSON.stringify(r.doc.run));
  } finally {
    await f.close();
  }
});
