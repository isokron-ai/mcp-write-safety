# Regression ledger

One row per thing that went wrong, or could, in this repository: what it was, the tests that pin it, and the commit
that fixed it. Each test named here starts with its row's ID. IsoKron's cross-repo ledger (`docs/LEDGER.md` in
isokron-ai/tool-qa) reads this table, so keep its four columns.

- `R-DM-*`: the tiny-tracker defect matrix (`defect-matrix.yml`).

| ID | What it was | Pinned by | Fix |
|---|---|---|---|
| R-DM-01 | HIGH. The defect matrix compared every build with `expected/0.3.0.json` and 0.3.0's labels whatever the package's version, so after the 0.4.0 bump every `build_hash` differed and every run failed. It now takes the version from `package.json` and picks labels in either release's shape (0.4.0's "L2 correct build", "L2, defect X", "L2, backend X"). | `scripts/ci/defect-matrix.test.mjs` › `R-DM-01: the known-answer check uses the package version's files and labels, never a fixed release`<br>`scripts/ci/defect-matrix.test.mjs` › `R-DM-01: an unknown defect is refused, and a build that answers differently fails`<br>`scripts/ci/defect-matrix.test.mjs` › `R-DM-01: the same check still reads a 0.3.0 tree in 0.3.0's label shape` | 677aa65 |
