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

/** Starts the CLI; if it prints its state line, runs `whileUp` with it, then stops it with SIGTERM. */
export function runCli(args: string[], env: Record<string, string> = {}, whileUp?: (state: any) => Promise<void>): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH ?? "", ...env } });
    let stdout = "";
    let stderr = "";
    let stateLine: any;
    child.stderr.on("data", (d) => { stderr += d; });
    child.stdout.on("data", (d) => {
      stdout += d;
      if (stateLine === undefined && stdout.includes("\n")) {
        stateLine = JSON.parse(stdout.split("\n")[0]);
        (whileUp ? whileUp(stateLine) : Promise.resolve()).then(() => child.kill("SIGTERM"), (e) => { child.kill("SIGKILL"); reject(e); });
      }
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
    child.on("exit", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, stateLine }); });
  });
}
