/**
 * The capture's `exit` event says whether the tester had sent the server SIGTERM or SIGKILL
 * (`stop_sent`). A server ended by SIGKILL with `stop_sent: false` was killed by something else,
 * most often the kernel's out-of-memory killer; the action shows that under "Needs attention".
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CaptureEvent, CaptureSink } from '../../src/core/capture.js';
import { StdioClient } from '../../src/core/client.js';

const sink = (): CaptureSink & { events: CaptureEvent[] } => {
  const events: CaptureEvent[] = [];
  return { events, write: (e) => void events.push(e) };
};
const exitEvent = (s: { events: CaptureEvent[] }) => s.events.find((e) => e['event'] === 'exit');
const opts = { timeout_ms: 3_000, stop_timeout_ms: 300 };

test('a server that SIGKILLs itself: exit 137 (through the supervisor), stop_sent false', { skip: process.platform === 'win32' }, async () => {
  const s = sink();
  const c = new StdioClient('SERVER', { command: process.execPath, args: ['-e', "process.kill(process.pid, 'SIGKILL')"], cwd: null, env: { PATH: process.env['PATH'] ?? '' } }, s, opts);
  await c.request('init', 'initialize', {});
  await c.whenClosed();
  const e = exitEvent(s);
  assert.ok(e, 'an exit event');
  assert.equal(e['exit_code'], 137);
  assert.equal(e['stop_sent'], false);
});

test('a server the tester stops with SIGTERM and SIGKILL: stop_sent true', { skip: process.platform === 'win32' }, async () => {
  const s = sink();
  // ignores stdin EOF and SIGTERM, so stop() escalates to SIGKILL
  const c = new StdioClient('SERVER', { command: process.execPath, args: ['-e', "process.on('SIGTERM', () => {}); process.stdin.resume(); process.stdin.on('end', () => {}); setInterval(() => {}, 1000)"], cwd: null, env: { PATH: process.env['PATH'] ?? '' } }, s, opts);
  void c.request('init', 'initialize', {}, { timeout_ms: 200 });
  await new Promise((r) => setTimeout(r, 300));
  const rec = await c.stop();
  assert.equal(rec['terminated_by'], 'SIGKILL');
  const e = exitEvent(s);
  assert.ok(e, 'an exit event');
  assert.equal(e['exit_code'], 137);
  assert.equal(e['stop_sent'], true);
});

test('a server that exits by itself: stop_sent false, its own status', { skip: process.platform === 'win32' }, async () => {
  const s = sink();
  const c = new StdioClient('SERVER', { command: process.execPath, args: ['-e', 'process.exit(3)'], cwd: null, env: { PATH: process.env['PATH'] ?? '' } }, s, opts);
  await c.request('init', 'initialize', {});
  await c.whenClosed();
  assert.equal(exitEvent(s)?.['exit_code'], 3);
  assert.equal(exitEvent(s)?.['stop_sent'], false);
});
