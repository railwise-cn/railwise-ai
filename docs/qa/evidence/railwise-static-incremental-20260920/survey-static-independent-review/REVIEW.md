# Static independent-observation append: independent numerical review

Reviewed 2026-09-20 by an independent AI code/numerical reviewer against the frozen source hashes in `source-hashes.json`. No production source was modified. No unresolved blocking finding was found within the supported pure-kernel scope.

## Result

- 53 independently generated models; 230 exact oracle prefix fits including base fits.
- 177 appended prefixes; 531 comparisons of base, incrementally updated and separate Householder fits; 15,806 scalar comparisons passed.
- Maximum operation-scaled binary64 error: 2.0039013286388986e-15 (asserted tolerance 1e-8).
- Fraction versus independent 120-decimal mpmath solve maximum normalized discrepancy: 4.849421647507798e-120.
- 28 contract, fingerprint, conditioning, range and size boundary cases passed.
- Independently reconstructed all 177 appended-row Givens updates, including rotation coefficients, rotated residual, accumulated residual norm and state hash. Every multirow step hash also equals a standalone run ending at that prefix.
- Independently reran the author's 152 tests: all passed, Vitest 4.1.8, 2026-09-20 08:27 local.

## Independent oracle and coverage

`oracle.py` builds exact rational normal equations from the *actual supplied binary64 inputs* using Python Fraction, then exact Gauss-Jordan inversion. `audit.py` separately solves and propagates the same observations with mpmath at 120 decimal digits. These normal equations are an independent oracle, not the production implementation: production uses row-wise Givens QR with fixed base column scaling and a distinct from-scratch Householder check.

Seed 99170923 produces 24 rational full-rank models with one to five parameters and heteroscedastic variances. Additional models reverse append order, reverse base order, convert m to mm with matching variance conversion, or multiply common variances by 16. Dedicated cases exercise zero-information new rows, exact zero SSE, one- and two-parameter high leverage and high posterior residual energy.

The known-prior example has old values 0 and 2, a new value 10, coefficient 1 and all prior variances 1. The result is x=4, SSE=56, df=2, posterior factor=28, while prior parameter covariance remains 1/3. The posterior estimate is correctly diagnostic only, without scaling the known prior covariance.

Parameter error scales by max(1, absolute parameter, sqrt(prior diagonal covariance * weighted observation energy)); covariance error by the geometric mean of diagonal prior variances; residual/adjusted observation error by observation magnitude. SSE error uses max(exact SSE, binary64 epsilon * observation count * weighted observation energy), so an exact-zero SSE does not create meaningless relative error. These checks are numerical evidence, not a certified forward-error bound.

## Boundary and integrity coverage

Old base row value, variance, coefficient, ID, source anchor, source hash, network identity, parameter identity, revision and unit mutations reject the unchanged old fingerprint. Arbitrary fingerprints also reject. Duplicate old/new and new/new IDs, revision jumps, added parameters, relative cofactor masquerading as known absolute variance, missing/wrong error model, undeclared correlation and zero variance reject.

Variance ratio beyond the supported limit refuses calculation. A singular base is refused even if a later row could repair rank. Dominating additions that invalidate conditioning under the fixed base scaling refuse. Unresolved base column scales and subnormal inputs refuse. Unavailable cases expose no accepted updated fit/state. Extreme common variances 1e-100 and 1e100 remain valid with correctly scaled prior covariance. The supported maximum of 256 total rows, 16 parameters and 128 appended rows was exercised with the exact expected covariance diagonal 1/16.

Fingerprints bind the schema-parsed base and the revisioned final model. They do not authenticate a real source instrument, a previously persisted Runtime state, or cross-request idempotency. Result flags correctly make those limits explicit.

## Reproduction

Build the target repository's `kun/dist` first. Use Node with ESM support and Python with mpmath 1.3.0 available:

```sh
REVIEW_PYTHON=/path/to/python-with-mpmath ./replay.sh /path/to/repository
```

The portable wrapper copies its scripts to a fresh temporary directory and regenerates all cases, outputs and reports without modifying the source evidence or implementation. `source-hashes.json` pins the reviewed contract, implementation, author tests and compiled JavaScript. `summary.json` contains compact counts, with detailed inputs/results alongside it.

## Scope limits

This is independent AI numerical and code review of a declared fixed-datum, full-column-rank linear model with independent, zero-mean errors and known absolute prior variances. It is not qualified-human approval, verification of real field data/weights/model assumptions, Runtime persistence or renderer testing, packaged UI acceptance, or release authorization. Correlated errors, parameter-set changes, datum changes, old-observation edits and true sequential stochastic/dynamic estimation are outside this implementation's declared scope.
