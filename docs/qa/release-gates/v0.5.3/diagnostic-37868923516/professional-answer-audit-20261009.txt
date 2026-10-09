# RailWise Survey AI professional answer audit

## Scope

This is an AI review of the installed 0.5.3 package and the read-only evidence for
`thr_j9ch3z2l`. It is not vendor interoperability evidence, regulatory
certification, a professional signature, or human approval.

## Evidence reviewed

- `007-gsi-ai-no-live-response.ax.txt` and its screenshot. The filename was a
  capture label; the UI contained a complete P1 answer.
- The thread's persisted read-only evidence and context. P1 had role `unknown`,
  adjusted height `100.5998 m`, point standard error `0.0002 m`, four
  observations, three unknowns, and one degree of freedom.
- `kun/src/engineering/survey-professional-review.ts` maps an unknown source
  point to the professional role `unknown`; locale labels define this as
  `待定点` / `Unknown` (a point to be determined). `unverified` is a distinct
  role.
- `kun/src/engineering/survey-service.ts` exposes deleted-observation t
  diagnostics only for independent observations with full-model degrees of
  freedom greater than one. This record has one degree of freedom, so that
  diagnostic is unavailable for this sample.

## Findings

1. The captured answer changed the professional role to “not classified” and
   described an observation role. This was inaccurate: the record identifies a
   point role `unknown`, meaning a point to be determined. The output also showed
   repeated labels such as “Observation Observation role” and “other other
   findings” after repeated cleanup.
2. The answer correctly withheld the default sigma-like residual screen under
   relative route-length weighting, but its wording implied that relative
   weighting categorically prevents all posterior statistical diagnostics. The
   precise boundary is that the default screen lacks absolute prior precision;
   the separate deleted-observation posterior t diagnostic is only available
   when its deterministic assumptions and redundancy gate pass. With one degree
   of freedom it is unavailable here.

## Remediation

PR #53 updates the Survey AI policy, preserves `unknown`/`unverified`
semantics, and distinguishes posterior precision and the two residual screening
methods. The parent agent's independent code review blocked the original
sanitizer implementation: it inferred a point role from genuinely unclassified
or unknown observation roles. Passing CI did not resolve that defect.

The correction is HEAD `cdfd87b9c0fbb784c552f5f9a18fee40477c2db3` (based on
the parent's rebased HEAD `464c7e68`). The sanitizer no longer converts
unclassified observations or generic unknown roles into points to be determined.
Only an explicit `Point role: unknown` assignment receives the point-enum
label. Repeated label cleanup remains idempotent. Bilingual negative regressions
preserve unclassified observations and generic unknown roles; an explicit
point-role enum regression preserves the recorded height. The renderer suite
passes 81/81 tests and `git diff --check` passes. Temporary dependency symlinks
were removed and the isolated worktree is clean.

This correction is awaiting the parent's independent re-review and strict CI
for the new HEAD. No merge, replacement freeze, final-package acceptance, or
release approval is claimed by this review. Kun runtime tests were not run
locally in the isolated worktree because its dependency installation lacks
`pdfkit`; required CI must provide that validation.
