// Runs the built command line as a child process: the state line, stdout,
// stderr and the exit code, as an operator sees them.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const CLI = fileURLToPath(new URL("../../src/cli.js", import.meta.url));

export interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
  stateLine?: any;
}

/**
 * The exit code of a child this test stopped with SIGTERM. On POSIX the command's handler runs and it exits 0. Windows
 * cannot deliver SIGTERM to a handler: Node ends the process outright and reports no code and the signal, so a child
 * that was stopped that way (and did not exit by itself first) counts as a clean stop there. A crash still shows as its
 * own number. The graceful stop (lock released, exit 0) is checked only where it is promised: see the SIGTERM tests that
 * skip on win32.
 */
export function stoppedCode(code: number | null, signal: NodeJS.Signals | null, stoppedByTest: boolean): number | null {
  return process.platform === "win32" && stoppedByTest && code === null && signal === "SIGTERM" ? 0 : code;
}

/** Starts the CLI; if it prints its state line, runs `whileUp` with it, then stops it with SIGTERM. */
export function runCli(args: string[], env: Record<string, string> = {}, whileUp?: (state: any) => Promise<void>): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH ?? "", ...env } });
    let stdout = "";
    let stderr = "";
    let stateLine: any;
    let stopped = false;
    child.stderr.on("data", (d) => { stderr += d; });
    child.stdout.on("data", (d) => {
      stdout += d;
      if (stateLine === undefined && stdout.includes("\n")) {
        stateLine = JSON.parse(stdout.split("\n")[0]);
        (whileUp ? whileUp(stateLine) : Promise.resolve()).then(() => { stopped = true; child.kill("SIGTERM"); }, (e) => { child.kill("SIGKILL"); reject(e); });
      }
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
    child.on("exit", (code, signal) => { clearTimeout(timer); resolve({ code: stoppedCode(code, signal, stopped), stdout, stderr, stateLine }); });
  });
}
