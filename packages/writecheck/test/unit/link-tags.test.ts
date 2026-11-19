/**
 * Every link to isokron.ai that this repository shows to a person carries the channel tag of the place it appears in:
 * `utm_source` and `utm_medium`, one fixed pair per surface. The table of all surfaces across the IsoKron repositories is
 * docs/LINK-TAGS.md in the site's repository; the rows for this repository are repeated in SURFACES, and this test fails when
 * a link is untagged, carries another surface's tag or an unknown source, or when a file gains a link without a surface.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../../', import.meta.url));

/** Path prefix (first match wins) -> the tag its links carry. */
const SURFACES: Array<[string, string, string]> = [
  ['README.md', 'mws-readme', 'readme'],
  ['CONTRIBUTING.md', 'mws-readme', 'readme'],
  ['spec/', 'mws-spec', 'spec'],
  ['.github/ISSUE_TEMPLATE/', 'mws-issue-template', 'github-template'],
  ['integrations/skills/', 'mws-skill', 'skill'],
  ['packages/writecheck/package.json', 'writecheck-npm', 'npm'],
  ['packages/writecheck/', 'writecheck-readme', 'readme'],
  ['examples/tiny-tracker/package.json', 'tiny-tracker-npm', 'npm'],
  ['examples/tiny-tracker/src/', 'tiny-tracker-source', 'source'],
  ['examples/tiny-tracker/', 'tiny-tracker-readme', 'readme'],
];
/** Files that hold isokron.ai text which is not a link a person is shown: tests, generated schemas' ids, vendored lockfiles. */
const NOT_SCANNED = [/^corpus\//, /(^|\/)test\//, /package-lock\.json$/, /^packages\/writecheck\/(src|scripts|dist)\//, /^scripts\//, /\.(png|svg|jpg|gz|zip)$/];

const URL_RE = /https:\/\/isokron\.ai(?![\w.-])([^\s)\]}>"'`#?]*)(\?[^\s)\]}>"'`#]*)?(#[^\s)\]}>"'`]*)?/g;

/** A match that is not a link: a JSON Schema id, the author field's origin, a prefix or pattern inside a code span. */
function exempt(line: string, m: RegExpMatchArray): boolean {
  if (/"\$id"|"author"/.test(line)) return true;
  const after = line[(m.index ?? 0) + m[0].length];
  if (/<[a-z]+>/.test(m[1] ?? '')) return true;
  return (m[1] ?? '').endsWith('/') && after === '`' && !m[2] && !m[3];
}

function tracked(): string[] {
  const r = spawnSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split('\n').filter(Boolean) : [];
}

const files = tracked();

test('link tags: every isokron.ai link in the repository carries its surface tag', { skip: files.length === 0 && 'not a git checkout' }, () => {
  let links = 0;
  const seen = new Set<string>();
  for (const f of files) {
    if (NOT_SCANNED.some((re) => re.test(f))) continue;
    let text: string;
    try {
      text = readFileSync(root + f, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      for (const m of line.matchAll(URL_RE)) {
        if (exempt(line, m)) continue;
        const surface = SURFACES.find(([p]) => f === p || (p.endsWith('/') && f.startsWith(p)));
        assert.ok(surface, `${f}:${i + 1} has a link to isokron.ai, and no surface covers this file: ${m[0]}`);
        const q = new URLSearchParams((m[2] ?? '').replace(/^\?/, ''));
        assert.equal(q.get('utm_source'), surface[1], `${f}:${i + 1}: ${m[0]}`);
        assert.equal(q.get('utm_medium'), surface[2], `${f}:${i + 1}: ${m[0]}`);
        assert.deepEqual([...q.keys()].sort(), ['utm_medium', 'utm_source'], `${f}:${i + 1}: only the source and the medium`);
        assert.ok(!m[0].includes('#') || m[0].indexOf('?') < m[0].indexOf('#'), 'the query comes before the fragment');
        links++;
        seen.add(surface[1]);
      }
    });
  }
  assert.ok(links > 50, `found ${links} links`);
  for (const s of ['mws-readme', 'mws-spec', 'mws-issue-template', 'mws-skill', 'writecheck-readme', 'writecheck-npm', 'tiny-tracker-readme', 'tiny-tracker-npm', 'tiny-tracker-source']) assert.ok(seen.has(s), `no link carries ${s}`);
});

test('link tags: programmatic URLs stay untagged', () => {
  const schema = readFileSync(root + 'packages/writecheck/schema/mws-compare-1.schema.json', 'utf8');
  assert.match(schema, /"\$id": "https:\/\/isokron\.ai\/mws\/schema\/mws-compare-1\.schema\.json"/);
  const pkg = JSON.parse(readFileSync(root + 'packages/writecheck/package.json', 'utf8')) as { homepage: string; author: string };
  assert.match(pkg.homepage, /\?utm_source=writecheck-npm&utm_medium=npm$/);
  assert.match(pkg.author, /\(https:\/\/isokron\.ai\)$/);
});
