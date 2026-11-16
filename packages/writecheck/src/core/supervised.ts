/**
 * Starting a server under the supervisor (supervisor.ts): the supervisor is a normal (not detached)
 * child of the tester, the server runs in a process group of its own under it, and the supervisor's
 * lifeline (fd 3) closes when the tester exits for any reason, which kills the server's group. A
 * SIGKILL of the tester therefore cannot orphan a server, even one that ignores stdin EOF and
 * SIGTERM. On Windows the server is started directly (no process groups; best effort).
 */

import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process';
import type { Socket } from 'node:net';
import { fileURLToPath } from 'node:url';

export const SUPERVISOR_JS = fileURLToPath(new URL('./supervisor.js', import.meta.url));

export interface Supervised {
  /** The supervisor process (or the server itself on Windows); its stdio is the server's. */
  proc: ChildProcess;
  /** The server's own pid (its process group id), once the supervisor has reported it. */
  serverPid: Promise<number | null>;
  /** Set when the server could not be started (command not found and the like). */
  startError: Promise<string | null>;
  /** SIGTERM the server's group, SIGKILL after a grace period. */
  term(): void;
  /** SIGKILL the server's group now. */
  kill(): void;
  /** The pid known so far (null before the supervisor reports it). */
  pidNow(): number | null;
}

export function spawnSupervised(command: string, args: string[], o: { env: Record<string, string>; cwd: string | null; stdin: 'pipe' | 'ignore' }): Supervised {
  if (process.platform === 'win32') {
    const proc = spawn(command, args, { env: o.env, ...(o.cwd ? { cwd: o.cwd } : {}), stdio: [o.stdin, 'pipe', 'pipe'] });
    const startError = new Promise<string | null>((r) => {
      proc.once('error', (e) => r(e.message));
      proc.once('spawn', () => r(null));
    });
    return { proc, serverPid: Promise.resolve(proc.pid ?? null), startError, term: () => proc.kill('SIGTERM'), kill: () => proc.kill('SIGKILL'), pidNow: () => proc.pid ?? null };
  }
  const stdio: StdioOptions = [o.stdin, 'pipe', 'pipe', 'pipe'];
  // why: the supervisor's own environment is minimal; the server's is passed as data, exactly.
  const proc = spawn(process.execPath, [SUPERVISOR_JS, command, ...args], {
    env: { MWSC_SUPERVISOR_ENV: JSON.stringify(o.env), ...(o.cwd ? { MWSC_SUPERVISOR_CWD: o.cwd } : {}), ...(o.env['PATH'] ? { PATH: o.env['PATH'] } : {}) },
    stdio,
  });
  const life = proc.stdio[3] as Socket | null;
  let pid: number | null = null;
  let resolvePid!: (p: number | null) => void;
  let resolveErr!: (e: string | null) => void;
  const serverPid = new Promise<number | null>((r) => (resolvePid = r));
  const startError = new Promise<string | null>((r) => (resolveErr = r));
  let buf = '';
  life?.on('data', (d: Buffer) => {
    buf += d.toString('utf8');
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        const m = JSON.parse(line) as { pid?: number; error?: string };
        if (typeof m.pid === 'number') {
          pid = m.pid;
          resolvePid(m.pid);
          resolveErr(null);
        } else if (typeof m.error === 'string') {
          resolvePid(null);
          resolveErr(m.error);
        }
      } catch {
        /* not ours */
      }
    }
  });
  life?.on('error', () => {});
  proc.once('error', (e) => (resolvePid(null), resolveErr(e.message)));
  proc.once('exit', () => (resolvePid(pid), resolveErr(null)));
  const send = (cmd: string) => {
    try {
      if (life && !life.destroyed) life.write(cmd + '\n');
    } catch {
      /* the supervisor is gone */
    }
  };
  return {
    proc,
    serverPid,
    startError,
    term: () => send('term'),
    kill: () => {
      // why: the crash path may exit right after this; signal the group directly as well as asking.
      if (pid !== null) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          /* gone */
        }
      }
      send('kill');
    },
    pidNow: () => pid,
  };
}
