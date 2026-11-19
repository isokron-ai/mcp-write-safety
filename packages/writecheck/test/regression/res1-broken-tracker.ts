/**
 * A broken build of tiny-tracker for the MWS-RES-1 effect trials (B-GAP F3), made from its correct build without changing it:
 * run with the working folder at a built examples/tiny-tracker, it prints {"mcp": url} as `tiny-tracker server` does.
 *
 *   noop               add_label, remove_label, set_labels, add_comment, close_ticket, delete_project, bulk_update_tickets
 *                      and delete_tickets answer "Done" and send nothing to the backend; create_ticket drops priority, and
 *                      create_project stores another name than the one it was given.
 *   batch-drops-last   delete_tickets answers that it deleted every match, and its batch leaves the last one out.
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Handler = (args: any, deps: any, ctx: any) => Promise<unknown>;

async function main(): Promise<void> {
  const dist = (p: string) => pathToFileURL(resolve(process.cwd(), 'dist', 'src', p)).href;
  const { createBuild } = (await import(dist('mcp/build.js'))) as any;
  const { loadConfig } = (await import(dist('mcp/config.js'))) as any;
  const { startMcpServer } = (await import(dist('mcp/server.js'))) as any;
  const { applyVariants } = (await import(dist('variants/index.js'))) as any;
  const { ok } = (await import(dist('mcp/results.js'))) as any;
  const { effectiveFeatures, parseFeatures, parseProfile } = (await import(dist('profile.js'))) as any;
  // why: the shipped manifest declares calls for the lookup tools (get_operation), which the default profile lists; built with no
  // features they are missing from tools/list and every cell of theirs is `not tested`. Same features as `tiny-tracker server`.
  const variants = (process.env['TRACKER_VARIANTS'] ?? '').split(',').map((x: string) => x.trim()).filter(Boolean);
  const { features } = effectiveFeatures(parseProfile(process.env['TRACKER_PROFILE']), parseFeatures(process.env['TRACKER_FEATURES']), variants);
  const build = createBuild([], features);
  const patch = (name: string, wrap: (inner: Handler) => Handler) => {
    const t = build.tools.get(name);
    build.tools.set(name, { ...t, handler: wrap(t.handler) });
  };
  if (process.argv[2] === 'batch-drops-last') {
    patch('delete_tickets', (inner) => (args, deps, ctx) =>
      inner(args, { ...deps, api: { ...deps.api, request: (m: string, p: string, o: any) => deps.api.request(m, p, m === 'POST' && p === '/batch' && o?.body?.ops?.length > 1 ? { ...o, body: { ...o.body, ops: o.body.ops.slice(0, -1) } } : o) } }, ctx));
  } else {
    for (const name of ['add_label', 'remove_label', 'set_labels', 'add_comment', 'close_ticket', 'delete_project', 'bulk_update_tickets', 'delete_tickets'])
      patch(name, () => async (args) => ok(`Done: ${name} applied${args.id ? ` to ${args.id}` : ''}.`, { done: true }));
    patch('create_ticket', (inner) => (args, deps, ctx) => {
      const { priority: _p, ...rest } = args;
      return inner(rest, deps, ctx);
    });
    patch('create_project', (inner) => (args, deps, ctx) => inner({ ...args, name: `${args.key}-draft` }, deps, ctx));
  }
  applyVariants(build, process.env);
  const config = loadConfig(process.env, build.configRules, [...build.tools.keys()]);
  const running = await startMcpServer(build, config, 0);
  process.stdout.write(`${JSON.stringify({ mcp: running.url })}\n`);
  const stop = async () => {
    await running.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop());
  process.on('SIGINT', () => void stop());
}

void main();
