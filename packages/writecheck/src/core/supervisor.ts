/**
 * The server supervisor: a tiny Node process the tester starts (not detached) for every server it
 * runs. It starts the real server in a process group of its own, so the server and anything it
 * starts (npx, a shell, a child runtime) can be stopped together, and it kills that whole group
 * when any of these happens:
 *
 *   - its lifeline (fd 3, a socket from the tester) closes: the tester has exited, for any reason,
 *     SIGKILL included; the kernel closes the tester's end, the supervisor sees EOF
 *   - the tester writes `term` (SIGTERM to the group, SIGKILL after a grace period) or `kill`
 *   - the supervisor itself gets SIGTERM, SIGINT or SIGHUP
 *   - the server exits (its own children are killed with it)
 *
 * stdin, stdout and stderr are inherited, so for a stdio server they are the MCP channel itself:
 * nothing is copied or buffered on the way. The server's environment comes from
 * MWSC_SUPERVISOR_ENV (JSON), so the supervisor's own environment never reaches the server and the
 * server's never configures the supervisor.
 *
 *   node supervisor.js <command> [args…]       (fd 3: the lifeline)
 *
 * On start it writes one JSON line on the lifeline: {"pid": <server pid>} or {"error": "…"}.
 */

import { spawn } from 'node:child_process';
import { Socket } from 'node:net';
import { constants } from 'node:os';

// why: gate-2 re-run on 378f32f (note 19, R3): the tester itself decides when a graceful stop becomes a kill (the client waits
// 2.5 s, a launched server 3 s, then sends `kill` and records it). This grace applies to `term` and to a signal sent to the
// supervisor (a tester that is gone is a lifeline EOF, a kill at once); it must be longer than the tester's own waits, or a
// kill made here is recorded as a graceful exit.
const GRACE_MS = 6_000;

function main(): void {
  const [command, ...args] = process.argv.slice(2);
  let life: Socket | null = null;
  try {
    life = new Socket({ fd: 3, readable: true, writable: true });
  } catch {
    life = null;
  }
  const say = (o: Record<string, unknown>) => {
    try {
      life?.write(JSON.stringify(o) + '\n');
    } catch {
      /* the tester is gone */
    }
  };
  if (!command) {
    say({ error: 'no command given' });
    process.exit(2);
  }
  let env: Record<string, string> = {};
  try {
    env = JSON.parse(process.env['MWSC_SUPERVISOR_ENV'] ?? '{}') as Record<string, string>;
  } catch {
    say({ error: 'MWSC_SUPERVISOR_ENV is not JSON' });
    process.exit(2);
  }
  const cwd = process.env['MWSC_SUPERVISOR_CWD'] || undefined;
  const child = spawn(command, args, { env, ...(cwd ? { cwd } : {}), stdio: ['inherit', 'inherit', 'inherit'], detached: true });
  let exited = false;
  const group = (sig: NodeJS.Signals) => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, sig);
    } catch {
      /* the group is gone */
    }
  };
  let stopping = false;
  const stop = (hard: boolean) => {
    if (hard) {
      group('SIGKILL');
      return;
    }
    if (stopping) return;
    stopping = true;
    group('SIGTERM');
    setTimeout(() => group('SIGKILL'), GRACE_MS).unref();
  };
  child.once('error', (e) => {
    say({ error: e.message });
    process.exit(127);
  });
  child.once('spawn', () => say({ pid: child.pid }));
  child.once('exit', (code, signal) => {
    exited = true;
    // why: whatever the server started outlives it unless its group goes too.
    group('SIGKILL');
    process.exitCode = code ?? (signal ? 128 + (signalNumber(signal) ?? 15) : 1);
    life?.destroy();
    // why: inherited stdio keeps nothing open here; exit promptly.
    setImmediate(() => process.exit());
  });
  if (life) {
    let buf = '';
    life.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const cmd = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (cmd === 'kill') stop(true);
        else if (cmd === 'term') stop(false);
      }
    });
    // why: EOF on the lifeline is the tester's death (SIGKILL included): nothing else may outlive it.
    const gone = () => {
      if (!exited) stop(true);
    };
    life.on('end', gone);
    life.on('close', gone);
    life.on('error', gone);
  }
  for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(s, () => stop(false));
}

function signalNumber(s: string): number | null {
  return (constants.signals as Record<string, number>)[s] ?? null;
}

main();
