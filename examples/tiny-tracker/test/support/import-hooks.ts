// Module hooks for test/import-graph.test.ts: log every resolved module URL
// to a file, so a test can see what a process actually loaded.

import { appendFileSync } from "node:fs";

let log = "";

export function initialize(data: { log: string }): void {
  log = data.log;
}

export async function resolve(specifier: string, context: unknown, next: (s: string, c: unknown) => Promise<{ url: string }>): Promise<{ url: string }> {
  const result = await next(specifier, context);
  appendFileSync(log, `${result.url}\n`);
  return result;
}
