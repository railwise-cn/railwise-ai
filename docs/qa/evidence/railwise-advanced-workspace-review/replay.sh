#!/usr/bin/env bash
set -euo pipefail
review_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd -- "$review_dir/../../../.." && pwd)"
cd "$repo_dir"
node node_modules/vitest/vitest.mjs run --config "$review_dir/vitest.config.mjs" --reporter=verbose "$@"
