import { z } from 'zod'
import type { EngineeringContextSnapshotV1 } from '../../contracts/engineering-ai.js'

export const SurveyContextReadRequestSchema = z.object({
  projectId: z.string().min(1).max(200),
  expectedProjectRevision: z.number().int().positive().optional(),
  expectedContextHash: z.string().min(1).max(100).optional()
}).strict()

export type SurveyContextReadDependencies = {
  /** Bound by the host to an authenticated client; never sourced from tool arguments. */
  canReadProject: (projectId: string) => boolean
  snapshot: (projectId: string) => EngineeringContextSnapshotV1
}

const SummarySchema = z.object({
  schemaVersion: z.literal(1),
  access: z.literal('read-only-summary'),
  verification: z.literal('context-metadata-only'),
  untrusted: z.literal(true),
  projectId: z.string().min(1), projectRevision: z.number().int().positive(),
  contextHash: z.string().min(1), generatedAt: z.string().min(1),
  networks: z.array(z.object({
    id: z.string(), revision: z.number().int().positive(), networkType: z.string(),
    pointCount: z.number().int().nonnegative(), observationCount: z.number().int().nonnegative(),
    qualityStatus: z.string()
  }).strict()).max(20),
  adjustments: z.array(z.object({
    id: z.string(), networkId: z.string(), revision: z.number().int().positive(),
    status: z.string(), algorithmVersion: z.string(), inputHash: z.string(),
    sourceAdmission: z.object({
      status: z.enum(['current-admissible', 'historical-non-admissible']),
      rawSourceIntegrity: z.enum(['verified', 'legacy-unverified', 'failed']),
      sourceEligible: z.boolean()
    }).strict()
  }).strict()).max(20),
  coverage: z.literal('bounded-snapshot-not-project-inventory'),
  limitPerCollection: z.literal(20)
}).strict()

/** Transport-neutral boundary only. This does not start or register an MCP server. */
export function createSurveyContextReader(deps: SurveyContextReadDependencies) {
  const checkAccess = (projectId: string) => {
    let allowed: boolean
    try { allowed = deps.canReadProject(projectId) === true }
    catch { throw new Error('survey_context_unavailable') }
    if (!allowed) throw new Error('survey_context_access_denied')
  }
  return (input: unknown) => {
    const parsed = SurveyContextReadRequestSchema.safeParse(input)
    if (!parsed.success) throw new Error('survey_context_invalid_request')
    const request = parsed.data
    checkAccess(request.projectId)
    let snapshot: EngineeringContextSnapshotV1
    try { snapshot = deps.snapshot(request.projectId) }
    catch { throw new Error('survey_context_unavailable') }
    // Recheck scope after the read: a host can revoke access while resolving it.
    checkAccess(request.projectId)
    if (snapshot.projectId !== request.projectId) throw new Error('survey_context_project_mismatch')
    if ((request.expectedProjectRevision !== undefined && request.expectedProjectRevision !== snapshot.projectRevision)
      || (request.expectedContextHash !== undefined && request.expectedContextHash !== snapshot.contextHash)) {
      throw new Error('survey_context_stale')
    }
    const result = {
      schemaVersion: 1 as const,
      access: 'read-only-summary' as const,
      verification: 'context-metadata-only' as const,
      untrusted: true as const,
      projectId: snapshot.projectId,
      projectRevision: snapshot.projectRevision,
      contextHash: snapshot.contextHash,
      generatedAt: snapshot.generatedAt,
      // Explicit projection prevents future internal fields from becoming public.
      // Raw observations, coordinates, paths, project text and findings are excluded.
      networks: snapshot.surveyNetworks.slice(0, 20).map(network => ({
        id: network.id, revision: network.revision, networkType: network.networkType,
        pointCount: network.pointCount, observationCount: network.observationCount,
        qualityStatus: network.qualityStatus
      })),
      adjustments: snapshot.surveyAdjustments.slice(0, 20).map(adjustment => ({
        id: adjustment.id, networkId: adjustment.networkId, revision: adjustment.revision,
        status: adjustment.status, algorithmVersion: adjustment.algorithmVersion,
        inputHash: adjustment.inputHash,
        sourceAdmission: {
          // Recompute admission from the current evidence, not a historical result label.
          status: adjustment.sourceAdmission.rawSourceIntegrity.status === 'verified'
            && adjustment.sourceAdmission.sourceEligibility.eligible
            ? 'current-admissible' as const : 'historical-non-admissible' as const,
          rawSourceIntegrity: adjustment.sourceAdmission.rawSourceIntegrity.status,
          sourceEligible: adjustment.sourceAdmission.sourceEligibility.eligible
        }
      })),
      coverage: 'bounded-snapshot-not-project-inventory' as const,
      limitPerCollection: 20
    }
    // Runtime storage/host data can violate TypeScript contracts. Validate before
    // JSON serialization so object-valued metadata cannot smuggle private fields.
    const checked = SummarySchema.safeParse(result)
    if (!checked.success) throw new Error('survey_context_unavailable')
    if (Buffer.byteLength(JSON.stringify(checked.data), 'utf8') > 64 * 1024) throw new Error('survey_context_response_too_large')
    return checked.data
  }
}
