# RailWise Survey 0.5.1 professional comparison candidate

This is a private, isolated packaged-app acceptance record for frozen source `69842e5c53766cdeaf6f3d8bdd88809fefb20bf5`.

The packaged workflow created two validated leveling periods from `period-valid-1.json` and `period-valid-2.json`, confirmed the `BM -> P` segment, and generated a comparison draft. The UI reported an observed and adjusted change of `-0.002000 m` (`-2.0000 mm`), with conformity remaining unevaluated. The draft contained separate observed/adjusted comparison tables and a row-by-row source/member table. The generated `professional-review.json`, DOCX, PDF and XLSX are copied beside this record.

The same acceptance run also recorded an initial-value event. Existing results remained unchanged, and the history was read back after the action. The packaged UI remained on the delivery page with the exact reference/current periods shown.

Package identity: version `0.5.1`; ASAR SHA-256 `a223faf6c63518fb5987e1ef84e26f6fc395b94fb85f11f319fc9bffb00153d1`; ad-hoc deep strict signature; Apple notarization and updater round-trip were not performed for this increment. This candidate is private and was not published or promoted.

The retry regression is covered by runtime tests: reusing an identical import idempotency key after deterministic validation returns the current network state, while changed measurement content, source bytes, fabricated findings or stale revisions remain rejected.
