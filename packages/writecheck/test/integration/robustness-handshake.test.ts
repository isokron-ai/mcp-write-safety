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

/*
 * Corpus run 3 (t05): a server on an older MCP Python SDK crashes on the CLI's server/discover (a pydantic validation error,
 * exit 1); initialize alone works. The CLI does not send server/discover to a server that negotiated an older revision, and
 * where a server errors or exits on it, the session goes on with initialize only (the server started again once if it died),
 * recorded as a note in the results and the capture, not a violation.
 */

test('t05: a server that crashes on server/discover is started again once and tested to the end with initialize only; a note says so', async () => {
  const f = await startFake({ defects: ['discover-crash'] });
  try {
    const r = await runFake(f);
    assert.equal(r.doc.run.status, 'complete', JSON.stringify(r.doc.run));
    assert.ok(r.doc.results.length > 0);
    assert.equal(r.doc.target.mcp?.revision, '2025-11-25');
    const notes = r.doc.target.mcp?.notes ?? [];
    assert.equal(notes.filter((n) => /failed on server\/discover/.test(n)).length, 1, JSON.stringify(notes));
    assert.match(notes.join(' '), /exit code 1/);
    assert.match(notes.join(' '), /ValidationError/);
    assert.ok(!r.doc.results.some((x) => x.verdict === 'violated' && /discover/.test(x.reason)), 'the crash is a note, not a violation');
  } finally {
    await f.close();
  }
});

test('t05: a server that negotiates an older revision is never sent server/discover (it would crash on it)', async () => {
  const f = await startFake({ defects: ['discover-crash', 'old-revision'] });
  try {
    const r = await runFake(f);
    assert.equal(r.doc.run.status, 'complete', JSON.stringify(r.doc.run));
    assert.equal(r.doc.target.mcp?.revision, '2024-11-05');
    const notes = r.doc.target.mcp?.notes ?? [];
    assert.ok(notes.some((n) => /server\/discover was not sent: the server negotiated protocol revision 2024-11-05/.test(n)), JSON.stringify(notes));
    assert.ok(!notes.some((n) => /failed on server\/discover/.test(n)), 'server/discover went out to an older-revision server');
  } finally {
    await f.close();
  }
});
