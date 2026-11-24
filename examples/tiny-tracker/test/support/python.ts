// Runs python3 -I without blocking the event loop (a test double serving from the same process must keep answering).

import { spawn, spawnSync } from "node:child_process";

/**
 * Whether python3 runs `args`. Always false on Windows: the Python checks (digest vectors, JSON Schemas, the recount, the
 * contract adapter, the OpenAPI file) run on Linux and macOS, and FIXTURE.md says so. GitHub's Windows runners do have a
 * python3 command, and its text I/O is not UTF-8 by default, so what happens to run there is not a promise.
 */
export function pythonRuns(args: string[]): boolean {
  return process.platform !== "win32" && spawnSync("python3", args, { encoding: "utf8" }).status === 0;
}

/** The reason a Python-backed test is skipped: the platform's, on Windows; else `why`. */
export function noPython(why: string): string {
  return process.platform === "win32" ? "the Python checks run on Linux and macOS only (FIXTURE.md, Windows)" : why;
}

export function py(args: string[], env: Record<string, string> = {}, input?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("python3", ["-I", ...args], { env: { PATH: process.env.PATH ?? "", ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}
