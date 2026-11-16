/**
 * Server supervision: a server that ignores stdin EOF and SIGTERM, and starts a child of its own,
 * is still killed, with its child, when the tester stops it, and when the tester itself is
 * SIGKILLed (the supervisor's lifeline closes).
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { StdioClient } from '../../src/core/client.js';
import { NO_CAPTURE } from '../../src/core/capture.js';

const here = dirname(fileURLToPath(import.meta.url));
const CLIENT_JS = pathToFileURL(resolve(here, '..', '..', 'src', 'core', 'client.js')).href;
const CAPTURE_JS = pathToFileURL(resolve(here, '..', '..', 'src', 'core', 'capture.js')).href;

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function goneWithin(pids: number[], ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (pids.every((p) => !alive(p))) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return pids.every((p) => !alive(p));
}

/** A server that will not go: SIGTERM ignored, stdin EOF ignored, and a child process of its own. */
function stubborn(dir: string): string {
  const f = join(dir, 'stubborn.mjs');
  writeFileSync(
    f,
    `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
process.on('SIGTERM', () => {});
process.stdin.resume();
process.stdin.on('end', () => {});
const kid = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' });
writeFileSync(${JSON.stringify(join(dir, 'pids.json'))}, JSON.stringify({ server: process.pid, child: kid.pid }));
setInterval(() => {}, 1000);
`,
  );
  return f;
}

async function pids(dir: string): Promise<{ server: number; child: number }> {
  const f = join(dir, 'pids.json');
  for (let i = 0; i < 100 && !existsSync(f); i++) await new Promise((r) => setTimeout(r, 50));
  return JSON.parse(readFileSync(f, 'utf8')) as { server: number; child: number };
}

test('StdioClient.stop kills a server that ignores stdin EOF and SIGTERM, and its own child', { skip: process.platform === 'win32' ? 'process groups' : false }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mwsc-sup-'));
  try {
    const c = new StdioClient('S', { command: process.execPath, args: [stubborn(dir)], cwd: null, env: { PATH: process.env['PATH'] ?? '' } }, NO_CAPTURE, { timeout_ms: 200, stop_timeout_ms: 300 });
    const r = await c.request('s1', 'ping', {});
    assert.equal(r.timed_out, true);
    const p = await pids(dir);
    assert.ok(alive(p.server) && alive(p.child));
    const info = await c.stop();
    // why: gate-2 re-run on 378f32f (note 19, R3): a server that ignored the graceful stop was killed, and the record must say
    // so (step (e) judges key_record_survives.graceful or .kill on it); the tester, not the supervisor's grace, escalates.
    assert.equal(info['terminated_by'], 'SIGKILL');
    assert.ok(await goneWithin([p.server, p.child], 3_000), 'the server and its child are gone');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a SIGKILL of the tester does not orphan the server (the lifeline closes)', { skip: process.platform === 'win32' ? 'process groups' : false }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mwsc-sup-'));
  try {
    const tester = join(dir, 'tester.mjs');
    writeFileSync(
      tester,
      `import { StdioClient } from ${JSON.stringify(CLIENT_JS)};
import { NO_CAPTURE } from ${JSON.stringify(CAPTURE_JS)};
const c = new StdioClient('S', { command: process.execPath, args: [${JSON.stringify(stubborn(dir))}], cwd: null, env: { PATH: process.env.PATH ?? '' } }, NO_CAPTURE, { timeout_ms: 100, stop_timeout_ms: 100 });
await c.request('s1', 'ping', {});
console.log('ready');
setInterval(() => {}, 1000);
`,
    );
    const t = spawn(process.execPath, [tester], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((r, j) => {
      createInterface({ input: t.stdout! }).on('line', (l) => l === 'ready' && r());
      t.once('exit', (c) => j(new Error(`tester exited ${c}`)));
    });
    const p = await pids(dir);
    assert.ok(alive(p.server) && alive(p.child));
    t.kill('SIGKILL');
    assert.ok(await goneWithin([p.server, p.child], 3_000), 'the server and its child die with the tester');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
