#!/usr/bin/env bash
set -euo pipefail
review_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd -- "${1:?Usage: replay.sh BUILT_CHECKOUT_ROOT}" && pwd)"
review_python="${REVIEW_PYTHON:-python3}"
review_output="$(mktemp -d "${TMPDIR:-/tmp}/railwise-quality-independent.XXXXXX")"
cp "$review_dir/profile_oracle.py" "$review_dir/profile-probe.mjs" "$review_dir/public-boundary-probe.mjs" "$review_dir/rules-probe.mjs" "$review_dir/request-fixtures.mjs" "$review_dir/original-boundaries.json" "$review_output/"
"$review_python" "$review_output/profile_oracle.py"
export REVIEW_COMPILED=1
node "$review_output/rules-probe.mjs" "$repo_dir"
node "$review_output/profile-probe.mjs" "$repo_dir"
node "$review_output/public-boundary-probe.mjs" "$repo_dir"
printf '%s\n' "Evidence: $review_output"
