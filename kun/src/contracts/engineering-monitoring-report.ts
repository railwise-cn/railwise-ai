import { z } from 'zod'

const id = z.string().min(1)
const hash = z.string().regex(/^[a-f0-9]{64}$/)

/**
 * A printable monitoring-result row. It is derived from retained observations
 * and the deterministic analysis; it is not a replacement for either source.
 */
export const MonitoringProfessionalDailyRowV1 = z.object({
  schemaVersion: z.literal(1),
  projectId: id,
  datasetId: id,
  monitoringItem: id,
  point: id,
  initialTimestamp: id,
  previousTimestamp: id.optional(),
  currentTimestamp: id,
  initialValue: z.number().finite(),
  initialUnit: id.optional(),
  previousValue: z.number().finite().optional(),
  previousUnit: id.optional(),
  currentValue: z.number().finite(),
  periodChange: z.number().finite().optional(),
  cumulativeChange: z.number().finite().optional(),
  /** Which source field supports cumulativeChange; mixed fields stay unavailable. */
  cumulativeBasis: z.enum(['source-cumulative', 'observed-value', 'mixed-unavailable']).optional(),
  ratePerDay: z.number().finite().optional(),
  unit: id,
  /** Project-declared unit retained beside the source unit for review. */
  projectUnit: id.optional(),
  /** Explicit source/project unit relationship; optional for legacy rows. */
  unitAlignment: z.enum(['aligned', 'source-differs', 'not-declared']).optional(),
  threshold: z.number().finite().optional(),
  thresholdStatus: z.enum(['normal', 'warning', 'alarm', 'control', 'unresolved']),
  continuity: z.enum(['continuous', 'new-point', 'missing-prior']),
  /** A mixed-unit history is retained as a review finding; no cross-unit delta is emitted. */
  unitStatus: z.enum(['consistent', 'conflict']).optional(),
  unitConflictUnits: z.array(id).min(2).optional(),
  sourceRows: z.array(z.number().int().positive()).min(1),
  sourceFileHash: hash
}).strict()
export type MonitoringProfessionalDailyRowV1 = z.infer<typeof MonitoringProfessionalDailyRowV1>

export const MonitoringProfessionalReportV1 = z.object({
  schemaVersion: z.literal(1),
  projectId: id,
  datasetId: id,
  sourceFileHash: hash,
  algorithmVersion: id,
  rows: z.array(MonitoringProfessionalDailyRowV1),
  status: z.literal('draft'),
  generatedAt: id
}).strict()
export type MonitoringProfessionalReportV1 = z.infer<typeof MonitoringProfessionalReportV1>
