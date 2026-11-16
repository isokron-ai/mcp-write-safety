#!/usr/bin/env bash
# Creates or updates the issue labels for the MWS 0.9 comment window from .github/labels.json.
# Run once, from the repository root, after the repository is public:
#   scripts/create-labels.sh            create or update every label (gh label create --force)
#   scripts/create-labels.sh --dry-run  print the commands only
# Needs gh (authenticated, with write access to the repository) and node.
set -euo pipefail

REPO="isokron-ai/mcp-write-safety"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABELS="$ROOT/.github/labels.json"
DRY=0
[[ "${1:-}" == "--dry-run" ]] && DRY=1

[[ -f "$LABELS" ]] || { echo "create-labels: $LABELS not found" >&2; exit 1; }

node -e '
  const labels = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  for (const l of labels) {
    if (!l.name || !/^[0-9a-f]{6}$/i.test(l.color) || /\t|\n/.test(l.name + l.description)) {
      console.error("create-labels: bad entry " + JSON.stringify(l)); process.exit(1);
    }
    console.log([l.name, l.color, l.description].join("\t"));
  }
' "$LABELS" | while IFS=$'\t' read -r name color desc; do
  if (( DRY )); then
    printf 'gh label create %q --color %q --description %q --force -R %q\n' "$name" "$color" "$desc" "$REPO"
  else
    gh label create "$name" --color "$color" --description "$desc" --force -R "$REPO"
  fi
done
