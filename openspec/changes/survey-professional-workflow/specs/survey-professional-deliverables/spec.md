## ADDED Requirements

### Requirement: Consistent professional report tables
The system SHALL render professional DOCX/PDF/XLSX content from one deterministic model and retain existing machine-readable evidence sheets and immutable revision behavior.

#### Scenario: Water-level report
- **WHEN** a completed eligible leveling result is selected for a report
- **THEN** outputs include reference metadata, height/precision results, observed/residual values, available route closure checks and source indexes, with explicit units and missing-data states

### Requirement: Printable review drafts
The system SHALL render headings, tables, repeated headers, page numbers and explicit pending review/signature fields; successful computation SHALL NOT imply standards conformity or professional approval.

#### Scenario: Multi-page table
- **WHEN** a result table spans pages
- **THEN** the PDF and DOCX preserve all rows and usable headers without clipping, and XLSX preserves numeric values and print/freeze settings

### Requirement: Explicit repeat-survey comparison drafts
The system SHALL include only explicitly selected segment comparisons in new drafts, verify both exact eligible results and original sources, and preserve comparison bindings through replay and archive.

#### Scenario: Selected two-period comparison
- **WHEN** an engineer generates a draft from a retained two-period leveling comparison
- **THEN** DOCX/PDF/XLSX contain separate observed and adjusted height-difference tables, current-minus-reference changes in mm, both epochs and member indexes, with conformity remaining unevaluated

#### Scenario: Stale comparison
- **WHEN** either source, run, result or comparison binding changes before publication or replay
- **THEN** the new draft or archive is rejected and existing historical files remain intact
