# Frozen 0.5.3 AI Display-Unit Diagnostic

This is a failed installed-package acceptance diagnostic, not release approval.
The user has authorized correction and publication of 0.5.3 in single-maintainer
mode. This evidence preserves the failure rather than marking the package passed.

## Exact Package

- Source: `33466f5a26a0e43ed5a234eed234979ea459f4b5`.
- Private freeze: `38000521987`, attempt 1, two-hour stability `7201` seconds.
- Installed: `/Applications/RailWise AI.app`, `0.5.3`,
  `com.wangjiawei508.workgpt`.
- arm64 ASAR: `b8d356ce60d6c869ca2ce6d6dad133427e2a594b6e6e904976bfcd042e8f3b54`.
- The real pinned 0.5.2-to-this-package native updater passed in run
  `38019029425`. This does not override the failed AI-answer check.

## Observed Failure

In the fresh protected local acceptance session, the synthetic `relative-m.json`
was imported through the native chooser, prechecked, and calculated through the
installed GUI. The recorded height of P is `10.9998 m`, its correction is
`-0.0002 m`, and its posterior standard error is `0.0004 m`. The GUI and native
DOCX/PDF/XLSX drafts displayed those quantities correctly, including millimetre
presentation of the correction and standard error.

The actual Survey AI question was:

> Explain P, its source evidence, and anything requiring review.

The completed answer displayed a table containing `10.9998 m`, `-0.2 mm`, and
`0.4 mm`, then stated:

> The correction is a change to the approximate starting coordinate - not a
> movement and not an epoch-to-epoch comparison. All units are metres.

The unrestricted final sentence contradicts the adjacent table's millimetre
units. The independently reviewed AI answer therefore fails its unit-explanation
check. No thousandfold solver or export error was observed. The original
answer, screenshot, and structured evidence read by the model are retained.

## Cause and Scoped Correction

The selected deterministic evidence records lengths in metres. The model
converted some of those lengths to millimetres for presentation, but its prose
still used a blanket statement about the recorded unit. The existing Survey AI
policy covered deterministic results and statistical scale units without
explicitly distinguishing stored units from the units shown in an answer.

The correction adds that distinction to the shared Survey conversation policy:
each presented quantity keeps its displayed unit, metre-to-millimetre conversion
scales the number by 1000, and a table containing different units cannot be
described as entirely in metres. It does not alter results, weights, source
records, export files, or user data. This instruction reduces the observed
failure mode; it does not guarantee a stochastic model's compliance.

The corrected source requires its own strict CI, a new private freeze, and real
acceptance of that final package. Results from this failed package are not
inherited as passes by the replacement package.

## Related Source-Unit Warning Clarification

The `relative-mm` input retains its original values (`1000 mm` and `-999 mm`),
and the numerical kernel converts them to metres for calculation. Its result
and native exports agree with the metre input. The source/network unit
difference is an appropriate nonblocking warning, but its old suggested action
asked users to unify units before import. The corresponding AI response said
not to rely on automatic conversion without explaining the recorded conversion.
This is a wording clarification, not another numerical failure or a new release
gate. Supported-unit warnings now explain conversion during calculation and
preservation of original values and units in both languages. Unsupported units
retain the existing blocking findings and are never described as convertible.

## Evidence Boundaries

The personal Login Items list, normal profile, and reused credential are private
and excluded. The original normal-profile task created before resumed isolation
is preserved. This diagnostic uses synthetic data and AI quality review; it is
not vendor/SUC interoperability, regulatory certification, professional sign-off,
or human approval.
