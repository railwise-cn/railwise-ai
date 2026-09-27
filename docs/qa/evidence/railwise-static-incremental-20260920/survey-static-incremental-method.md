# Fixed linear static observation append — trial-only

This kernel evaluates a caller-declared fixed linear model `y = A x + e`. The existing base must be full column rank with positive redundancy. The caller explicitly declares zero-mean independent errors and known, absolute prior variances. Normality is not needed for these WLS estimates and second moments and is not asserted. Coefficients are dimensionless; every parameter shares the observation unit (`m` or `mm`). Source anchors, source SHA values, independence, variances and the fixed datum are declarations, not authenticated observations or professional acceptance.

Each invocation replays its supplied base into QR, then appends independent observations using Givens rotations. The old observations and model are immutable values. No formal result is changed. The output includes base/updated fits and QR states, each added row's rotations and state fingerprint, original/appended IDs, and a full from-scratch Householder QR comparison. Householder and Givens use different factorizations but share final triangular solve/fit helpers; this is not an entirely independent implementation. External exact rational and 120-digit reference calculations provide independent software evidence.

The parameter covariance is the known-prior covariance `R^-1 R^-T`, transformed back through the fixed original column scales. The posterior variance factor `SSE/(n-p)` is diagnostic only and never multiplies covariance or changes weights. No hypothesis test, engineering stability conclusion or certified error bound is returned.

## Fingerprints and replay

The fingerprint is SHA-256 of the parsed schema's canonical semantic JSON. It binds supplied observation values, variances, coefficients, IDs, parameter order, network/revision and source declarations. It does not authenticate original source bytes, prior application/database state, provenance or a cross-request cache. The final snapshot retains the base source anchor and declared SHA as an inherited basis declaration, not a new file digest. The append has its own source anchor. Repeating the same pure request is deterministic; persistence and cross-request idempotency are not implemented here. A successive request replays the combined base and may choose new base column scales. No realtime, speedup or durable incremental-state claim is made.

## Supported domain and refusal

- At most 256 total observations, 16 fixed parameters and 128 appended observations; at least one appended observation. The existing model has more observations than parameters.
- Magnitudes: observations ≤ 1e9, dimensionless coefficients ≤ 1e6; positive prior variances in [1e-100, 1e100], with overall variance ratio ≤ 1e12.
- Base whitened column norms in [1e-100, 1e100], relative rank tolerance 1e-12, triangular infinity condition ≤ 1e8 at base and every append.
- Strict schemas reject correlation, posterior/cofactor covariance, model changes, deletion, duplicate IDs, revision gaps and unsupported operations. Stale fingerprints refuse. Singular/ill-conditioned base models cannot be repaired by appended rows.
- Nonfinite and relevant subnormal/underflow operations refuse; incremental/batch disagreement above the declared scale-aware 1e-8 policy refuses. These policies are numerical screens, not formal interval bounds.
- No free network, changing parameter list, nonlinearity, dynamic/process model, concurrent state merge, field device connection or production signoff.

## Reproduction

Use a checkout with `npm --prefix kun run build`, then run:

```sh
python3 -m venv /tmp/static-append-oracle
/tmp/static-append-oracle/bin/pip install -r docs/qa/evidence/railwise-static-incremental-20260920/survey-static-incremental-requirements.txt
/tmp/static-append-oracle/bin/python docs/qa/evidence/railwise-static-incremental-20260920/survey-static-incremental-oracle.py
node docs/qa/evidence/railwise-static-incremental-20260920/survey-static-incremental-node-probe.mjs .
/tmp/static-append-oracle/bin/python docs/qa/evidence/railwise-static-incremental-20260920/survey-static-incremental-audit.py
npm --prefix kun run test -- src/engineering/survey-static-incremental.test.ts
```

The original seed 202609202 yields 29 models / 133 prefix fits. Exact Fraction arithmetic solves rational normal equations without floating normal equations; mpmath 1.3.0 at 120 decimal digits independently uses skinny QR and triangular solve. The Node archive is actual compiled ESM output. Covariance differences are scaled by expected standard deviations; residual comparisons allow subtraction-scale rounding. A residual of about 3e-13 from an observation near 3e6 cannot carry precision finer than binary64 subtraction of the fitted value. This validation does not expand the supported operating domain or constitute licensed professional review.
