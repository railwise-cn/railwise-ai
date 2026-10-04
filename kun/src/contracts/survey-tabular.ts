import { z } from 'zod'

export const SURVEY_TABULAR_MAPPING_MAX_BYTES = 1024 * 1024

export const SurveyTabularBindingV1 = z.object({
  field: z.enum(['id', 'from', 'to', 'value', 'routeLength', 'sigma', 'stationCount']),
  columnIndex: z.number().int().min(0).max(63)
}).strict()
const TabularPointV1 = z.object({ id: z.string().trim().min(1).max(200), x: z.number().finite().optional(), y: z.number().finite().optional(), height: z.number().finite().optional() }).strict()
export const SurveyTabularMappingV1 = z.object({
  schemaVersion: z.literal('survey-tabular-mapping/v1'),
  mappingId: z.string().trim().min(1).max(128),
  revision: z.number().int().nonnegative(),
  sourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
  tableId: z.string().min(1).max(256),
  headerRow: z.literal(1),
  delimiter: z.enum([',', '\t', ';']).optional(),
  networkType: z.enum(['leveling', 'plane-control']),
  observationType: z.enum(['height-difference', 'distance', 'direction']),
  bindings: z.array(SurveyTabularBindingV1).min(3).max(7),
  linearUnit: z.enum(['m', 'mm', 'cm', 'km']),
  angularUnit: z.enum(['rad', 'degree-decimal', 'gon']),
  routeLengthUnit: z.enum(['m', 'km']),
  coordinateSystem: z.string().trim().min(1).max(200),
  verticalDatum: z.string().trim().min(1).max(200),
  projection: z.string().trim().min(1).max(200).optional(),
  ellipsoid: z.string().trim().min(1).max(200).optional(),
  knownPoints: z.array(TabularPointV1).min(1).max(10_000),
  unknownPoints: z.array(TabularPointV1).max(10_000).optional(),
  confirmed: z.literal(true)
}).strict().superRefine((mapping, context) => {
  if (new TextEncoder().encode(JSON.stringify(mapping)).byteLength > SURVEY_TABULAR_MAPPING_MAX_BYTES) context.addIssue({ code: 'custom', message: `Confirmed tabular mapping exceeds ${SURVEY_TABULAR_MAPPING_MAX_BYTES} bytes; split the controls or source` })
  const fields = mapping.bindings.map((binding) => binding.field)
  if (new Set(fields).size !== fields.length || new Set(mapping.bindings.map((binding) => binding.columnIndex)).size !== fields.length) context.addIssue({ code: 'custom', path: ['bindings'], message: 'Fields and column bindings must be unique' })
  if (!['from', 'to', 'value'].every((field) => fields.includes(field as typeof fields[number]))) context.addIssue({ code: 'custom', path: ['bindings'], message: 'from, to and value require explicit mappings' })
  if ((mapping.networkType === 'leveling') !== (mapping.observationType === 'height-difference')) context.addIssue({ code: 'custom', path: ['observationType'], message: 'The observation role must match the supported network' })
  for (const field of ['coordinateSystem', 'verticalDatum'] as const) if (/^(待确认|未确认|unknown|unverified|pending)$/i.test(mapping[field])) context.addIssue({ code: 'custom', path: [field], message: 'Reference metadata must be explicitly declared' })
  const pointIds = [...mapping.knownPoints, ...(mapping.unknownPoints ?? [])].map((point) => point.id)
  if (new Set(pointIds).size !== pointIds.length) context.addIssue({ code: 'custom', path: ['knownPoints'], message: 'Control and approximate point identifiers must be unique' })
  if (mapping.knownPoints.some((point) => mapping.networkType === 'leveling' ? point.height === undefined : point.x === undefined || point.y === undefined)) context.addIssue({ code: 'custom', path: ['knownPoints'], message: 'Controls require declared canonical-metre heights or X/Y coordinates' })
})
export type SurveyTabularMappingV1 = z.infer<typeof SurveyTabularMappingV1>

export const SurveyTabularProbeRequestV1 = z.object({ name: z.string().min(1).max(1_024), dataBase64: z.string().min(1).max(90 * 1024 * 1024), delimiter: z.enum([',', '\t', ';']).optional() }).strict()
export type SurveyTabularProbeRequestV1 = z.infer<typeof SurveyTabularProbeRequestV1>
export const SurveyTabularVisibilityV1 = z.enum(['visible', 'hidden', 'veryHidden'])
export type SurveyTabularVisibilityV1 = z.infer<typeof SurveyTabularVisibilityV1>
export const SurveyTabularProbeV1 = z.object({
  formatId: z.enum(['delimited-text', 'xlsx']),
  sourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
  delimiter: z.enum([',', '\t', ';']).optional(),
  tables: z.array(z.object({ id: z.string(), name: z.string(), visibility: SurveyTabularVisibilityV1, importable: z.boolean(), columns: z.array(z.string()).max(64), previewRows: z.array(z.array(z.string())).max(5), rowCount: z.number().int().nonnegative(), headerRow: z.literal(1) }).strict()).min(1).max(32),
  requiresMapping: z.literal(true)
}).strict()
export type SurveyTabularProbeV1 = z.infer<typeof SurveyTabularProbeV1>
