# Independent Synthetic Plane-Control Oracle

This directory contains an independent calculation for the synthetic `golden-plane-control-e2e.in2` fixture, SHA-256 `4281cc7a10673570756867e8c8665f22f82611839bd34c396a5eba9dbb89d9f0`. It is not professional sign-off, real field-data validation, a production benchmark or release approval.

## Independent Inputs and Method

`build_oracle.py` reads only the original fixture. Its format assumptions come from the fixture README and manifest: the header is direction prior sigma in arcseconds, distance constant sigma in millimetres, and ppm; three-field coordinate records are fixed controls; `L` is a direction and `S` a distance. `X` is north and `Y` east. The first zero direction is treated as an observed backsight reading with one unknown station orientation. Compact `D.MMSS` is decoded using Decimal arithmetic, not treated as decimal degrees. This parser is deliberately limited to the exact one-station, three-control, five-observation synthetic fixture and does not claim general COSA interoperability.

The oracle has unknowns `(X_S1, Y_S1, orientation)`. Direction predictions are `atan2(Y_target-Y_S1, X_target-X_S1) - orientation`, with differences wrapped to `[-pi, pi]`. Distance predictions are Euclidean lengths. The initial coordinates come from intersecting the two distance circles, selecting the branch by direction consistency. Analytical derivatives feed NumPy `linalg.lstsq` (LAPACK); no product parser, adjustment kernel or product expected values are imported.

All three controls are fixed exactly as printed. Their six-decimal rounding explains the small nonzero residuals. Five observations minus Jacobian rank three gives two degrees of freedom. The orientation is approximately pi/2.

The header description does not prescribe combining constant and ppm errors. Both alternatives are declared before looking at the product result:

- RSS: direction sigma is 1 arcsecond; distance sigma is `sqrt((0.001 m)^2 + (1e-6 * 100 m)^2)` = approximately `0.001004987562 m`.
- Additive: the same angle model, distance sigma `0.001 m + 1e-6 * 100 m` = `0.0011 m`.

These are separate diagonal weight models. No correlated direction-difference covariance is assumed. Their covariances and posterior scales are reported separately and are explicitly excluded from product acceptance comparisons unless the same weight semantics are independently established.

## Self-Checks and Historical Comparison

`independent-oracle.json` was generated before `fbb-selected-result.json` was read. Self-checks cover Decimal DMS and four invalid tokens, analytical versus central-difference Jacobian (maximum difference approximately `3.79e-11`), an ideal unrounded geometry recovering `(50,50)`, and four different starting points (coordinate spread below `1.2e-13 m`). The product was not used to fit priors, initial coordinates, tolerance values or output predictions.

The historical fbb record is read by explicit adjustment ID using an isolated DB/WAL copy. Original bytes are compared before and after. `fbb-independent-comparison.json` reports the actual comparison: RSS station coordinate differences are below `1e-13 m`; additive-model differences are below `5.8e-9 m`. Both satisfy the previously declared `2e-6 m` coordinate and linear-residual tolerances and `2e-8 rad` angular-residual tolerance. Counts and degrees of freedom match exactly. This does not turn different weight models into equal precision models.

The comparator additionally reconstructs every residual from the returned coordinates/orientation and the original observations, with floating-point consistency tolerances of `1e-10 m` or `1e-13 rad`. These are algebraic self-consistency tolerances, not claimed survey accuracy. This detects zeroed or reversed tiny residuals that the broader independent-model tolerances may not detect in this near-exact fixture.

`test_oracle.py` checks the historical result and rejects coordinate, degree-of-freedom, unit, tiny-residual and missing-observation mutations. All six checks pass. The oracle and comparison use no external network or credentials.

## Final Candidate Use

Set the main candidate audit's `referenceResultPath` to `/private/tmp/railwise-independent-plane-oracle.w8rWDa/reference-result.json` and `numericTolerance` to `0.000002`. This partial reference is generated from the oracle alone and covers counts, rank, units, fixed controls and station coordinates. Its point order is the source control order followed by S1; the audit deliberately fails if the returned order differs.

For the fuller residual check, extract only the actual final candidate adjustment ID:

```sh
python3 extract_selected_result.py CANDIDATE_RUNTIME/engineering/survey.sqlite3 ACTUAL_ADJUSTMENT_ID ACTUAL_RESULT.json
python3 compare_result.py independent-oracle.json ACTUAL_RESULT.json ACTUAL_COMPARISON.json
```

Use absolute paths for these parameters, keep output under `/private/tmp`, and run only after the candidate's adjustment has actually completed. The selected record must be tied to the fixture source hash and exact project/network by the main audit. Neither the extractor nor comparator searches other projects. All current comparison files refer only to historical fbb, not the untested final candidate.
