#!/usr/bin/env bash
# sync-spec-to-vault.sh
#
# One-way sync: repo docs/SPEC.md -> ~/Obsidian/mem/projects/specialists-web.md
#
# The repo is the source of truth for the specialists-web spec. The vault
# gets a one-way mirror so Obsidian's graph still has a node for it and
# so we can read the spec offline / from another machine.
#
# Run after merging a change to docs/SPEC.md on main:
#   ./tools/sync-spec-to-vault.sh
#
# It is safe to run repeatedly. It will refuse to overwrite a vault file
# that has been hand-edited (detected by a leading sentinel comment);
# run with FORCE=1 to overwrite anyway.
#
# Idempotent. No external deps. No network. Safe in CI.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$REPO_ROOT/docs/SPEC.md"
DST="${SPEC_VAULT_PATH:-$HOME/Obsidian/mem/projects/specialists-web.md}"

if [[ ! -f "$SRC" ]]; then
  echo "error: source not found: $SRC" >&2
  echo "  (this script expects docs/SPEC.md to be the canonical spec)" >&2
  exit 2
fi

if [[ -e "$DST" && -z "${FORCE:-}" ]]; then
  # Detect hand-edits: if the vault file lacks the sync sentinel, refuse.
  if ! head -20 "$DST" | grep -q "<!-- specialists-web: vault mirror — do not edit -->"; then
    echo "error: $DST appears to be hand-edited (no sync sentinel)." >&2
  echo "  This script only writes the auto-generated mirror." >&2
  echo "  To force overwrite, run: FORCE=1 $0" >&2
  exit 3
  fi
fi

mkdir -p "$(dirname "$DST")"

# Build the mirror with a sentinel + frontmatter so Obsidian keeps the
# tags and links happy, and a one-line edit marker at the top.
TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
COMMIT="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"

{
  echo "---"
  echo "project: specialists-web"
  echo "title: Specialists Web — Living Spec (vault mirror)"
  echo "status: mirror"
  echo "canonical_source: file://$REPO_ROOT/docs/SPEC.md"
  echo "synced_at: $TIMESTAMP"
  echo "synced_from_commit: $COMMIT"
  echo "vault_path: $DST"
  echo "edit_here: NO — edit \$canonical_source in the repo, then re-run tools/sync-spec-to-vault.sh"
  echo "---"
  echo ""
  echo "<!-- specialists-web: vault mirror — do not edit -->"
  echo ""
  cat "$SRC"
} > "$DST"

echo "synced: $SRC -> $DST"
echo "  commit: $COMMIT"
echo "  at:     $TIMESTAMP"
