/**
 * Reading a list to the end (gate-2 re-run on 378f32f, note 19, R5 and R6; re-run on 6b028ec, note 14): a list block may
 * declare how to ask for the next page (`next: { path, arg }`: the value at `path` in an answer, sent as the argument `arg`
 * for the next page, until the answer has none). Without it, an answer that shows a further page (a cursor, a "more" flag,
 * a total above the count) is reported as partial: what the tester reads from it covers the first page only, and a verdict
 * that needs every object (the MWS-RETRY-2 trace, clean-up's proof that nothing is left) is not given from it.
 */

import type { ListSpec } from './manifest.js';
import type { CallResult, Session } from './session.js';
import { getPath, short } from './util.js';

/** Signs in a list answer that it is one page of more (a cursor, a "more" flag, a total above the count); null where none. */
export function moreSign(data: unknown, itemsPath: string, n: number): string | null {
  const segs = itemsPath.split('.');
  const holders = [data, segs.length > 1 ? getPath(data, segs.slice(0, -1).join('.')) : undefined].filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x));
  for (const h of holders) {
    for (const k of ['nextCursor', 'next_cursor', 'nextPageToken', 'next_page_token', 'next', 'nextPage', 'next_page', 'continue']) {
      const v = h[k];
      if (v !== undefined && v !== null && v !== false && v !== '' && !(typeof v === 'object' && !Object.keys(v as object).length)) return `${k}: ${short(v, 40)}`;
    }
    for (const k of ['hasMore', 'has_more', 'hasNextPage', 'has_next_page', 'more', 'truncated']) if (h[k] === true) return `${k}: true`;
    for (const k of ['totalDocs', 'total', 'totalCount', 'total_count', 'totalItems', 'total_items']) if (typeof h[k] === 'number' && (h[k] as number) > n) return `${k} ${h[k]} for ${n} listed`;
  }
  return null;
}

/** A guard against a server that never stops answering with a next page; reaching it makes the list partial. */
export const MAX_PAGES = 200;

export interface ListRead {
  ok: boolean;
  items: unknown[];
  /** Why the items are not the whole list (a further page that was not read); null when every page was read. */
  partial: string | null;
  /** The first answer, for callers that read more from it. */
  first: CallResult | null;
  /** Why there is no list (the call failed, or the answer has no list at `items`). */
  reason: string | null;
  pages: number;
}

/**
 * List every page of a list block (`args` already rendered). Items are de-duplicated by the list's id (a page boundary that
 * moves between two reads must not count one object twice); a cursor that repeats, a page cap reached, or an answer that still
 * shows a further page where the declared next path gives none, makes the list partial.
 */
export async function listAll(session: Session, label: string, l: ListSpec, args: unknown, step: string): Promise<ListRead> {
  const items: unknown[] = [];
  const seen = new Set<string>();
  let a: unknown = args === null || args === undefined ? {} : args;
  let first: CallResult | null = null;
  const cursors = new Set<string>();
  // why: validator re-run on e613620 (cost): a server that ignores the cursor and keeps answering the same items ran to MAX_PAGES on
  // every listing (nx-ok-ignore: 9,714 calls). Two pages in a row that bring items but none new end the listing as partial.
  let stale = 0;
  const add = (xs: unknown[]): number => {
    let fresh = 0;
    for (const it of xs) {
      const id = getPath(it, l.id);
      const k = id === undefined || id === null ? null : JSON.stringify(id);
      if (k !== null && seen.has(k)) continue;
      if (k !== null) seen.add(k);
      items.push(it);
      fresh++;
    }
    return fresh;
  };
  for (let page = 1; ; page++) {
    const r = await session.call(label, l.tool, a, { write: false, step: page === 1 ? step : `${step}.p${page}` });
    first ??= r;
    const xs = r.ok ? getPath(r.data, l.items) : null;
    if (!Array.isArray(xs)) return { ok: false, items, partial: null, first, reason: r.ok ? `the answer${page > 1 ? ` to page ${page}` : ''} has no list at ${l.items}` : `the list call failed (${short(r.text ?? r.rpc_error?.message ?? r.transport_error ?? (r.timed_out ? 'timed out' : 'error'), 120)})`, pages: page };
    const fresh = add(xs);
    stale = page > 1 && xs.length > 0 && fresh === 0 ? stale + 1 : 0;
    if (stale >= 2) return { ok: true, items, partial: `${l.tool} answered two pages in a row with only items already listed (the cursor seems to be ignored), so the pages after them could not be read`, first, reason: null, pages: page };
    const v = l.next ? getPath(r.data, l.next.path) : undefined;
    if (!l.next || v === undefined || v === null || v === false || v === '') {
      // why: without a declared next, or where the declared path gives none, an answer that still shows more is partial.
      const more = moreSign(r.data, l.items, items.length);
      return { ok: true, items, partial: more ? `${l.tool} answered with one page of more (${more})${l.next ? ` and nothing at list.next.path ${l.next.path}; check that path` : '; declare list.next to read every page'}` : null, first, reason: null, pages: page };
    }
    const ck = JSON.stringify(v);
    if (cursors.has(ck)) return { ok: true, items, partial: `${l.tool} gave the same next value twice (${short(v, 40)}), so the pages after it could not be read`, first, reason: null, pages: page };
    cursors.add(ck);
    if (page >= MAX_PAGES) return { ok: true, items, partial: `${l.tool} still gave a next page after ${MAX_PAGES} pages`, first, reason: null, pages: page };
    if (typeof a !== 'object' || Array.isArray(a)) return { ok: true, items, partial: `${l.tool}'s arguments are not a mapping, so list.next.arg cannot be set`, first, reason: null, pages: page };
    // why: an empty page with a cursor is not the end (a filtered scan); the cursor decides.
    a = { ...(a as Record<string, unknown>), [l.next.arg]: v };
  }
}
