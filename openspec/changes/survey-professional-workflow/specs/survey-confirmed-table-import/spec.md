## ADDED Requirements

### Requirement: Explicit survey table mapping
The system SHALL require explicit retained field mapping, unit and reference choices before open CSV/XLSX measurement tables become calculation inputs, and SHALL preserve the original source and mapping revision.

#### Scenario: Unconfirmed table
- **WHEN** a table is uploaded without the required confirmed mapping
- **THEN** the file remains preserved and unavailable for adjustment rather than receiving inferred measurement semantics

### Requirement: Fail closed on ambiguity
The system SHALL reject ambiguous point identities, invalid numeric or angle encoding, unsupported record roles and unverified source address spaces.

#### Scenario: Unknown unit or conflicting point
- **WHEN** a confirmed mapping has inconsistent units or conflicting point coordinates
- **THEN** the importer returns a source-located blocking issue and SHALL NOT silently drop or overwrite observations

### Requirement: Retry after precheck
The system SHALL allow an identical retained import request to resume after valid precheck lifecycle updates without creating duplicate networks, while preserving immutable source and measurement checks.

#### Scenario: Retried validated import
- **WHEN** the same import key and payload are retried after deterministic validation
- **THEN** the existing network is returned with its current validated state and changed measurements, parameters or source bytes are still rejected
