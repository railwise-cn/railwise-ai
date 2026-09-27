#!/usr/bin/env bash
set -euo pipefail
review_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
review_checkout="$(cd -- "${1:?Pass the checkout root to audit}" && pwd)"
review_python="${REVIEW_PYTHON:-python3}"
"$review_python" -c 'import mpmath; assert mpmath.__version__ == "1.3.0"'
review_output="$(mktemp -d "${TMPDIR:-/tmp}/railwise-huber-review.XXXXXX")"
cp "$review_dir"/huber_fraction_oracle.py "$review_dir"/huber_random_oracle.py "$review_dir"/huber_probe.ts "$review_dir"/huber_transform_probe.ts "$review_dir"/huber_audit.py "$review_output/"
"$review_python" "$review_output/huber_fraction_oracle.py" > "$review_output/fraction-console.json"
"$review_python" "$review_output/huber_random_oracle.py"
bun "$review_output/huber_probe.ts" "$review_checkout" > "$review_output/huber-console.json"
bun "$review_output/huber_transform_probe.ts" "$review_checkout" > "$review_output/huber-transform-console.json"
"$review_python" "$review_output/huber_audit.py"
printf 'Review output: %s\n' "$review_output"
