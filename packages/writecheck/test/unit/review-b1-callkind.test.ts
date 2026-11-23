/**
 * Review of e613620, B1: "same collection" was decided from the unrendered read
 * (and list) arguments with every string holding {{id}} dropped. Two resources that differ only in a `vars` value, or only in
 * the text around the id (`posts/{{id}}`, `pages/{{id}}`), were one collection:
 *
 *   clean-up     a page left by a timed-out create was taken as known (post 6 has that id) and left behind; the run said
 *                0 left, complete (probe n1vars.mjs)
 *   bystanders   a bystander page whose id is one of the run's posts was left out of the inventory, so its loss was unseen
 *                (probe byvars.mjs); a bystander scope whose id matches a run-created scope of another collection was not
 *                listed at all
 *   fail closed  a read call that cannot be rendered with the vars: clean-up sweeps (its ids hide nothing), the inventory is
 *                partial
 *
 * Each scenario runs in the vars form and the id-in-string form. Also review S4 (no vars case for knownIds and kindOf).
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { compare, inventory } from '../../src/checks/bystanders.js';
import type { RunContext } from '../../src/checks/types.js';
import { cleanupLedger, knownIds } from '../../src/core/cleanup.js';
import { callKind } from '../../src/core/driver.js';
import { Ledger } from '../../src/core/ledger.js';
import { parseManifestText, type Manifest } from '../../src/core/manifest.js';

const HEAD = `mws: "0.9"
server: { stdio: [node, s.js] }
target: { environment: test, confirm: t, guard: { tool: who, args: {}, pattern: "^t" } }
resources:
`;
const ok = (data: unknown) => ({ ok: true, isError: false, data, text: JSON.stringify(data), timed_out: false, transport_error: null, rpc_error: null });
const err = (t: string) => ({ ok: false, isError: true, data: null, text: t, timed_out: false, transport_error: null, rpc_error: null });

/** posts and pages through one generic tool set: the collection is a resource var (a CMS-style shape). */
const VARS = parseManifestText(VARS_TEXT(), 'm.yaml');

/** posts and pages through one generic tool set: the collection is the text around the id. */
const PATH = parseManifestText(
  `${HEAD}${['post:posts', 'page:pages']
    .map((s) => s.split(':'))
    .map(
      ([n, c]) => `  - name: ${n}
    create: { tool: create_entry, args: { path: ${c}, title: "{{marker}}" }, id: id, name_path: title }
    read: { tool: get_entry, args: { path: "${c}/{{id}}" } }
    list: { tool: list_entries, args: { path: ${c} }, items: docs, id: id, name: title }
    delete: { tool: delete_entry, args: { path: "${c}/{{id}}" } }
    cleanup: delete
`,
    )
    .join('')}`,
  'm.yaml',
);

type Db = Record<string, Map<number, string>>;
/** A backend for both manifests: the collection and id come from `collection`/`id`, or from `path` ("pages/6" or "pages"). */
function backend(db: Db) {
  const where = (a: Record<string, unknown>): [Map<number, string>, number] => {
    if (typeof a['path'] === 'string') {
      const [c, id] = a['path'].split('/');
      return [db[c!]!, Number(id)];
    }
    return [db[String(a['collection'])]!, Number(a['id'])];
  };
  return {
    stepId: (s: string) => s,
    listTools: async () => [],
    async call(_l: string, tool: string, a: Record<string, unknown>) {
      const [c, id] = where(a);
      if (tool === 'list_entries') return ok({ docs: [...c].map(([i, t]) => ({ id: i, title: t })) });
      if (tool === 'get_entry') return c.has(id) ? ok({ id, title: c.get(id) }) : err('not found');
      if (tool === 'delete_entry') return c.delete(id) ? ok({ deleted: id }) : err('not found');
      return err(`unexpected ${tool}`);
    },
  };
}

async function timedOutPage(m: Manifest) {
  const dir = mkdtempSync(join(tmpdir(), 'mwsc-b1-'));
  try {
    const l = new Ledger(dir, 'r1');
    l.append({ kind: 'created', intent: l.intent('post', 'create_entry', 'p'), resource: 'post', id: 6, name: 'mwsc-r1-p', via: 'result' });
    l.append({ kind: 'create_unknown', intent: l.intent('page', 'create_entry', 't'), resource: 'page', reason: 'timed out' });
    const known = [...knownIds(l, m, m.resources[1]!, m.resources[1]!.list!)];
    // A page create timed out but made page 6; post 6 is the run's own post.
    const db: Db = { posts: new Map([[6, 'mwsc-r1-p']]), pages: new Map([[6, 'mwsc-r1-t']]) };
    const rep = await cleanupLedger(l, m, backend(db) as never, {}, 'mwsc-r1-');
    return { known, db, rep };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const [form, m] of [['vars', VARS], ['id in a longer string', PATH]] as const) {
  test(`B1 clean-up (${form}): a page left by a timed-out create is swept although post 6 has its id`, async () => {
    const { known, db, rep } = await timedOutPage(m);
    assert.deepEqual(known, [], 'post 6 is not a known id of the pages list');
    assert.equal(db['pages']!.size, 0, 'page 6 found by the sweep and deleted');
    assert.equal(db['posts']!.size, 0);
    assert.ok(rep.deleted.some((d) => d.resource === 'page' && String(d.id) === '6'), JSON.stringify(rep.deleted));
  });

  test(`B1 bystanders (${form}): a page whose id is one of the run's posts is in the inventory, and its loss is seen`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mwsc-b1-'));
    try {
      const l = new Ledger(dir, 'r1');
      l.append({ kind: 'created', intent: l.intent('post', 'create_entry', 'p'), resource: 'post', id: 6, name: 'mwsc-r1-p', via: 'result' });
      const db: Db = { posts: new Map([[6, 'mwsc-r1-p']]), pages: new Map([[6, "Someone else's page"], [7, 'Another page']]) };
      const ctx = { manifest: m, ledger: l, session: backend(db), prefix: 'mwsc-r1-' } as unknown as RunContext;
      const page = m.resources[1]!;
      const before = await inventory(ctx, page, 'X');
      assert.deepEqual([...before.items.keys()].sort(), ['/6', '/7']);
      assert.deepEqual(before.partial, []);
      db['pages']!.delete(6);
      db['pages']!.delete(7);
      const loss = await compare(ctx, page, 'X', before, await inventory(ctx, page, 'X'), { fixtures: true });
      assert.deepEqual([...loss.gone].sort(), ['/6', '/7']);
      // The run's own post 6 is still the tester's own in the posts inventory.
      assert.deepEqual([...(await inventory(ctx, m.resources[0]!, 'X')).items.keys()], []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('B1 bystanders: a bystander scope whose id matches a run-created scope of another collection is listed', async () => {
  const m = parseManifestText(
    `${HEAD}${['board:boards', 'folder:folders']
      .map((s) => s.split(':'))
      .map(
        ([n, c]) => `  - name: ${n}
    vars: { col: ${c} }
    create: { tool: create_entry, args: { collection: "{{col}}", title: "{{key}}" }, id: id, name_path: title }
    key: { arg: title, vary: { arg: label, path: label } }
    read: { tool: get_entry, args: { collection: "{{col}}", id: "{{id}}" } }
    list: { tool: list_entries, args: { collection: "{{col}}" }, items: docs, id: id, name: title }
    delete: { tool: delete_entry, args: { collection: "{{col}}", id: "{{id}}" } }
    cleanup: delete
`,
      )
      .join('')}  - name: doc
    scope: { resource: folder, arg: folder, default: null, list: { tool: list_docs, args: { folder: "{{scope}}" }, items: docs, id: id, name: title } }
    create: { tool: create_doc, args: { folder: "{{scope}}", title: "{{marker}}" }, id: id }
    read: { tool: get_doc, args: { id: "{{id}}" } }
    delete: { tool: delete_doc, args: { id: "{{id}}" } }
    cleanup: delete
`,
    'm.yaml',
  );
  const dir = mkdtempSync(join(tmpdir(), 'mwsc-b1-'));
  try {
    const l = new Ledger(dir, 'r1');
    // The run created board 3; folder 3 is someone else's, with a doc in it.
    l.append({ kind: 'created', intent: l.intent('board', 'create_entry', 'b'), resource: 'board', id: 3, name: 'mwsc-r1-b', via: 'result' });
    const db: Db = { boards: new Map([[3, 'mwsc-r1-b']]), folders: new Map([[3, "Someone else's folder"]]) };
    const docs = new Map<number, { id: number; title: string }[]>([[3, [{ id: 31, title: 'Their doc' }]]]);
    const base = backend(db);
    const session = {
      ...base,
      async call(lb: string, tool: string, a: Record<string, unknown>) {
        if (tool === 'list_docs') return docs.has(Number(a['folder'])) ? ok({ docs: docs.get(Number(a['folder'])) }) : err('no such folder');
        return base.call(lb, tool, a);
      },
    };
    const ctx = { manifest: m, ledger: l, session, prefix: 'mwsc-r1-' } as unknown as RunContext;
    const inv = await inventory(ctx, m.resources[2]!, 'X');
    assert.equal(inv.unavailable, null);
    assert.deepEqual([...inv.items.keys()].sort(), ['3/31', 'scope:3']);
    assert.deepEqual(inv.covered.scopes, [3]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('B1 fail closed: a read that cannot be rendered with the vars hides no id from the sweep and makes the inventory partial', async () => {
  const m = parseManifestText(VARS_TEXT(), 'm.yaml');
  // References no manifest check would let through today; no kind can be built from them. Post has no list of its own, so
  // only the read could make the two one collection: two reads that cannot be told apart are two kinds, not one.
  for (const r of m.resources) (r.read as { args: unknown }).args = { collection: '{{col}}', id: '{{id}}', v: '{{read.obj.version}}' };
  (m.resources[0] as { list: unknown }).list = null;
  assert.equal(callKind(m.resources[1]!, m.resources[1]!.read), null);
  const { known, rep } = await timedOutPage(m);
  assert.deepEqual(known, [], 'post 6 hides nothing from the sweep of pages');
  // The sweep finds page 6 as the run's. (Its delete cannot be verified here, since the read itself cannot be rendered, so the
  // report says it failed; before the fix it was abandoned and the report said nothing.)
  assert.ok(rep.failed.some((f) => f.resource === 'page' && String(f.id) === '6'), JSON.stringify(rep));
  // Inventory: partial, so a selector record on it is never held.
  const dir = mkdtempSync(join(tmpdir(), 'mwsc-b1-'));
  try {
    const l = new Ledger(dir, 'r1');
    const ctx = { manifest: m, ledger: l, session: backend({ posts: new Map(), pages: new Map([[7, 'x']]) }), prefix: 'mwsc-r1-' } as unknown as RunContext;
    const inv = await inventory(ctx, m.resources[1]!, 'X');
    assert.equal(inv.unavailable, null);
    assert.equal(inv.partial.length, 1);
    assert.match(inv.partial[0]!, /could not be rendered/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('B1 / S4: callKind fills in vars and replaces only the id token, in every spelling', () => {
  const [post, page] = VARS.resources as [Manifest['resources'][number], Manifest['resources'][number]];
  assert.notEqual(callKind(post, post.read), callKind(page, page.read));
  assert.notEqual(callKind(post, post.list!), callKind(page, page.list!));
  assert.match(callKind(post, post.read)!, /"collection":"posts"/);
  assert.notEqual(callKind(PATH.resources[0]!, PATH.resources[0]!.read), callKind(PATH.resources[1]!, PATH.resources[1]!.read));
  // The same collection under two resources is one kind, whatever the id is called in the template.
  for (const id of ['{{id}}', '{{ id }}', 'posts/{{id}}', '{{json:id}}']) {
    const a = { ...post, read: { ...post.read, args: { collection: '{{col}}', id } } };
    const b = { ...post, name: 'post-replace', read: { ...post.read, args: { collection: 'posts', id } } };
    assert.equal(callKind(a, a.read), callKind(b, b.read), id);
  }
  // Two resources with no vars over the same read are one kind (tiny-tracker: ticket and ticket-replace).
  const t = parseManifestText(`${HEAD}  - name: ticket
    create: { tool: c, args: { t: "{{marker}}" }, id: id }
    read: { tool: get_ticket, args: { id: "{{id}}" } }
  - name: ticket-replace
    create: { tool: c, args: { t: "{{marker}}" }, id: id }
    read: { tool: get_ticket, args: { id: "{{id}}" } }
`, 'm.yaml');
  assert.equal(callKind(t.resources[0]!, t.resources[0]!.read), callKind(t.resources[1]!, t.resources[1]!.read));
});

function VARS_TEXT(): string {
  return `${HEAD}${['post:posts', 'page:pages']
    .map((s) => s.split(':'))
    .map(
      ([n, c]) => `  - name: ${n}
    vars: { col: ${c} }
    create: { tool: create_entry, args: { collection: "{{col}}", title: "{{marker}}" }, id: id, name_path: title }
    read: { tool: get_entry, args: { collection: "{{col}}", id: "{{id}}" } }
    list: { tool: list_entries, args: { collection: "{{col}}" }, items: docs, id: id, name: title }
    delete: { tool: delete_entry, args: { collection: "{{col}}", id: "{{id}}" } }
    cleanup: delete
`,
    )
    .join('')}`;
}
