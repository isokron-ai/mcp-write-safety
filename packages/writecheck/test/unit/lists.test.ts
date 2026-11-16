/**
 * Reading a list to the end (gate-2 re-run on 378f32f, note 19 R5 and R6; review of note 19, 8 to 10): pages followed by the
 * declared list.next, items de-duplicated by id, a repeated cursor or a page shown but not readable reported as partial.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { listAll } from '../../src/core/lists.js';
import type { ListSpec } from '../../src/core/manifest.js';
import type { Session } from '../../src/core/session.js';

const ok = (data: unknown) => ({ ok: true, data, text: JSON.stringify(data), timed_out: false, transport_error: null, rpc_error: null });
const session = (pages: (args: Record<string, unknown>) => unknown): Session => ({ call: async (_l: string, _t: string, args: Record<string, unknown>) => ok(pages(args)) } as unknown as Session);
const L = (next: ListSpec['next']): ListSpec => ({ tool: 'list', args: {}, items: 'items', id: 'id', name: 'name', ignore: [], next });

test('every page is read with list.next, and an object seen on two pages counts once', async () => {
  const pages: Record<number, unknown> = { 1: { items: [{ id: 1 }, { id: 2 }], next_page: 2 }, 2: { items: [{ id: 2 }, { id: 3 }], next_page: null } };
  const r = await listAll(session((a) => pages[(a['page'] as number) ?? 1]), 'L', L({ path: 'next_page', arg: 'page' }), {}, 's');
  assert.deepEqual(r.items.map((x) => (x as { id: number }).id), [1, 2, 3]);
  assert.equal(r.partial, null);
});

test('without list.next an answer that shows more is partial; a repeated cursor is partial; an empty page with a cursor goes on', async () => {
  const one = await listAll(session(() => ({ items: [{ id: 1 }], next_page: 2 })), 'L', L(null), {}, 's');
  assert.match(one.partial!, /one page of more/);
  const loop = await listAll(session(() => ({ items: [{ id: 1 }], next_page: 2 })), 'L', L({ path: 'next_page', arg: 'page' }), {}, 's');
  assert.match(loop.partial!, /same next value twice/);
  const pages: Record<number, unknown> = { 1: { items: [], next_page: 2 }, 2: { items: [{ id: 9 }] } };
  const gap = await listAll(session((a) => pages[(a['page'] as number) ?? 1]), 'L', L({ path: 'next_page', arg: 'page' }), {}, 's');
  assert.deepEqual(gap.items, [{ id: 9 }]);
  const wrongPath = await listAll(session(() => ({ items: [{ id: 1 }], cursor_next: 'abc', hasMore: true })), 'L', L({ path: 'next_page', arg: 'page' }), {}, 's');
  assert.match(wrongPath.partial!, /nothing at list.next.path/);
});
