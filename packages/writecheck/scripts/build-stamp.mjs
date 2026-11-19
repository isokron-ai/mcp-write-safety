#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Writes dist/src/build-info.json: the git commit this build was made from, and whether the package's working tree had
// uncommitted changes. results.identity.tester.commit comes only from this file (src/core/identity.ts). Run by `npm run build`.
// Outside a git checkout the commit is null, with a note, and the run's identity lists it as a gap.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => execFileSync('git', args, { cwd: pkg, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

let info;
try {
  const commit = git('rev-parse', 'HEAD');
  // why: only the package's own files decide whether this build is the commit (an untracked source is compiled in, so it counts); dist/ and node_modules are ignored.
  const dirty = git('status', '--porcelain', '--', '.').length > 0;
  info = { commit, dirty };
} catch {
  info = { commit: null, dirty: null, note: 'built outside a git checkout' };
}
const out = join(pkg, 'dist', 'src', 'build-info.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(info) + '\n');
