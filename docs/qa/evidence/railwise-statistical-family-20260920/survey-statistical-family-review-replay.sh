#!/usr/bin/env bash
set -euo pipefail
review_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
review_checkout="$(cd -- "${1:?Pass the checkout root to audit}" && pwd)"
review_python="${REVIEW_PYTHON:-python3}"
"$review_python" -c 'import mpmath; assert mpmath.__version__ == "1.3.0"'
review_output="$(mktemp -d "${TMPDIR:-/tmp}/railwise-statistical-review.XXXXXX")"
cp "$review_dir"/survey-statistical-family-review-oracle.py "$review_dir"/survey-statistical-family-review-random-oracle.py "$review_dir"/survey-statistical-family-review-critical-oracle.py "$review_dir"/survey-statistical-family-review-probe.ts "$review_dir"/survey-statistical-family-review-audit.py "$review_output/"
"$review_python" "$review_output/survey-statistical-family-review-oracle.py"
"$review_python" "$review_output/survey-statistical-family-review-random-oracle.py"
"$review_python" "$review_output/survey-statistical-family-review-critical-oracle.py"
bun "$review_output/survey-statistical-family-review-probe.ts" "$review_checkout" > "$review_output/statistical-console.json"
"$review_python" "$review_output/survey-statistical-family-review-audit.py"
printf 'Review output: %s\n' "$review_output"
