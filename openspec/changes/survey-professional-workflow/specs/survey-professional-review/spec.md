## ADDED Requirements

### Requirement: Source-bound professional review
The system SHALL provide an additive professional review tied to the selected run, frozen result, original source and network revision, without rewriting historical results.

#### Scenario: Changed or missing source
- **WHEN** the selected result's source cannot pass current integrity and admission checks
- **THEN** the review exposes the unavailable reason and SHALL NOT assert that the result is eligible for new calculations or signed delivery

### Requirement: Explicit mathematical meaning
The system SHALL distinguish observed route closures, fitted residual norms, coordinate corrections, deformation and prior/posterior precision, and SHALL identify checks whose required inputs or limits are absent.

#### Scenario: Plane residual norm
- **WHEN** a legacy plane-control result contains horizontal or angular residual norms in its closure container
- **THEN** the professional review labels these as residual norms and does not present them as independent route closure checks

### Requirement: Professional primary workflow and evidence questions
The system SHALL expose reference controls, topology, observations, closure checks and task-specific results in normal Survey workflow, with precise read-only AI questions linked to source evidence.

#### Scenario: Explain a closure
- **WHEN** an engineer asks about a displayed closure or residual
- **THEN** the evidence tool returns its mathematical meaning, units, source members and evaluation boundary for that exact result
