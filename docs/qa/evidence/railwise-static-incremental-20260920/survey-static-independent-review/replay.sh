#!/usr/bin/env bash
set -euo pipefail
REVIEW_SOURCE="$(cd "$(dirname "$0")" && pwd)"
REVIEW_REPO="${1:?Usage: replay.sh /path/to/repository (compiled kun/dist required)}"
REVIEW_REPO="$(cd "$REVIEW_REPO" && pwd)"
REVIEW_PYTHON="${REVIEW_PYTHON:-python3}"
REVIEW_OUTPUT="$(mktemp -d "${TMPDIR:-/tmp}/railwise-static-replay.XXXXXX")"
cp "$REVIEW_SOURCE/oracle.py" "$REVIEW_SOURCE/probe.mjs" "$REVIEW_SOURCE/audit.py" "$REVIEW_SOURCE/boundary-probe.mjs" "$REVIEW_OUTPUT/"
"$REVIEW_PYTHON" "$REVIEW_OUTPUT/oracle.py"
node "$REVIEW_OUTPUT/probe.mjs" "$REVIEW_REPO"
"$REVIEW_PYTHON" "$REVIEW_OUTPUT/audit.py"
node "$REVIEW_OUTPUT/boundary-probe.mjs" "$REVIEW_REPO"
printf 'Replay evidence: %s\n' "$REVIEW_OUTPUT"
