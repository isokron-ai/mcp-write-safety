// Runs python3 -I without blocking the event loop (a test double serving from the same process must keep answering).

import { spawn } from "node:child_process";

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
