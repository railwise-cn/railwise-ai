#!/usr/bin/env bash
set -euo pipefail
review_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd -- "${1:?Usage: REVIEW_PYTHON=python-with-mpmath replay.sh CHECKOUT_ROOT}" && pwd)"
review_python="${REVIEW_PYTHON:-python3}"
review_output="$(mktemp -d "${TMPDIR:-/tmp}/railwise-reference-independent.XXXXXX")"
cp "$review_dir/oracle.py" "$review_dir/audit.py" "$review_dir/boundaries.py" "$review_dir/probe.mjs" "$review_dir/boundary-probe.mjs" "$review_output/"
"$review_python" "$review_output/oracle.py"
node "$review_output/probe.mjs" "$repo_dir"
"$review_python" "$review_output/audit.py"
"$review_python" "$review_output/boundaries.py"
node "$review_output/boundary-probe.mjs" "$repo_dir"
printf '%s\n' "Evidence: $review_output"
