#!/usr/bin/env bash
set -euo pipefail
if [[ ! -f kun/src/engineering/survey-generalized-w.ts ]]; then
  echo 'Run this script from the repository root containing kun/src/engineering/survey-generalized-w.ts.' >&2
  exit 1
fi
bundle_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
review_output_dir="${1:-$(mktemp -d "${TMPDIR:-/tmp}/railwise-w-review.XXXXXX")}"
mkdir -p -- "$review_output_dir"
python3 "$bundle_dir/random_fraction_cases.py" --output-dir "$review_output_dir"
bun "$bundle_dir/check.mjs" --input-dir "$review_output_dir"
echo "Generated inputs, exact expectations and summary: $review_output_dir"
