#!/usr/bin/env bash
set -euo pipefail
review_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd -- "${1:?Usage: replay.sh CHECKOUT_ROOT}" && pwd)"
shift
export REVIEW_REPO="$repo_dir"
node "$repo_dir/node_modules/vitest/vitest.mjs" run --config "$review_dir/vitest.config.mjs" --reporter=verbose "$@"

node "$review_dir/compiled-probe.mjs" "$repo_dir"
