# Independent fixed-scale Huber kernel review

The reviewed change is a pure, caller-declared fixed-scale independent-observation linear Huber trial. No production weight, observation, Runtime route, stored project, GUI or release is modified by these probes. The reviewer did not provide a human professional signature.

No unresolved numerical blocker remained after the score-boundary repair. The reviewer found that checking score ≤ tolerance and score error ≤ 0.1 tolerance independently still admitted a numerical interval crossing the tolerance. The implementer changed both execution and output-schema gates to require score + error ≤ tolerance, while retaining the error ≤ 0.1 tolerance condition. Derived IRLS weights are not presented as Gaussian precision estimates.

## Independent reference and results

`huber_fraction_oracle.py` enumerates quadratic-inlier and signed-linear-tail partitions using Python `Fraction`, solves their exact linear KKT equations, and verifies partition inequalities and zero exact score. It does not use IRLS or the implementation's QR. It supplies twelve analytical/constructed cases. `huber_random_oracle.py` adds 48 deterministic small general linear examples.

All 60 reached the declared stationary state with tolerance 1e-10. Maximum scaled objective discrepancy from the exact minima was 2.259676544820107e-16; maximum scaled parameter discrepancy for cases with a single enumerated candidate was 4.43540137951004e-10. A single enumerated candidate is not claimed as a complete standalone uniqueness theorem. Distinct equal-objective exact candidates prove nonuniqueness; the implementation did not falsely assert its strict-inlier sufficient condition for those cases.

`huber_audit.py` then independently evaluates actual returned parameters with mpmath 1.3.0 at 180-digit precision, using the binary floating inputs as supplied. Across the 60 cases, maximum true normalized KKT score was 4.7684816685091396e-11 and maximum score discrepancy from the reported floating score was 2.2226045125193818e-15. Every score discrepancy and objective discrepancy lay within the corresponding reported software roundoff estimate. This empirical coverage does not turn that estimate into a certified bound for the whole domain.

Further probes include:

- 56 row-order, extreme positive/negative column rescaling, parameter-origin shift, unit conversion and scale-endpoint variants: 46 stationary, 4 iteration-limit and 6 numerical-boundary results. Accepted transformed parameters had maximum relative discrepancy 5.820777193576987e-11. Nine nonaccepted variants used huge parameter origins; one high-leverage case shifted by 10 was conservatively refused because its score-resolution budget exceeded the required 0.1 tolerance. They expose no accepted parameters.
- Five explicit exceptional examples: nonzero quadratic energy below normal floating range and overflowing products are refused; a 1e16 origin is refused; an enormous parameter-independent loss constant does not bypass the score criterion; an initial point inside a flat minimizer interval is stationary but uniqueness remains not-established.
- Exact position examples: [0,0,0,10] has x=1/3 and F=28/3; [0,0,10,10] has every x in [1,9] minimizing F=18; relative sigmas [1,1,2,1] in the first example give x=4/9 and F=167/18.
- High-leverage observations can still determine the fit. The method does not claim leverage robustness, redescending loss, scale estimation, Gaussian WLS precision or engineering acceptance.

## Replay and files

Use `huber-replay.sh CHECKOUT_ROOT`. It copies source scripts to a new temporary output directory, generates synthetic exact fixtures, invokes Bun against the requested checkout, and runs the high-precision audit. It prints the output directory and leaves the review evidence there. Python 3 with mpmath==1.3.0, Bun and the checkout's normal dependencies are required. An isolated Python environment can be selected with `REVIEW_PYTHON`; no old temporary worktree is hardcoded in the scripts.

Files: `huber_fraction_oracle.py`, `huber_random_oracle.py`, `huber_probe.ts`, `huber_transform_probe.ts`, `huber_audit.py`; generated `huber-exact-cases.json`, `huber-random-exact-cases.json`, `huber-probe-results.json`, `huber-transform-results.json`, `huber-oracle-audit-summary.json`. `review-source-hashes.json` identifies the actually reviewed source. Files may be renamed during repository archival if imports and fixture references are updated and replayed, without changing data.

These are pure-kernel numerical tests, not packaged GUI, Runtime persistence, native file-dialog, updater, instrument/field validation, standards compliance or human engineering signoff.

Archival adjustment: the two Bun probes additionally throw on suspect/unexpected numerical outcomes, preserving the documented conservative-stop cases. Numerical calculations are unchanged.
