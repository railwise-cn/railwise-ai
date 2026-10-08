import { z } from 'zod'

const identifier = z.string().min(1).max(180)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
export const SurveyDraftCreateV1 = z.object({ manifestId: identifier, expectedProjectRevision: z.number().int().positive(), idempotencyKey: z.string().min(8).max(120) }).strict()
export const SurveyDraftSealV1 = z.object({ expectedRevision: z.number().int().positive() }).strict()
export const SurveyDraftReferenceV1 = z.object({ projectId: identifier, draftId: identifier, revision: z.number().int().positive(), contentHash: hash }).strict()
export const SurveyCollaborationDraftV1 = z.object({
  schemaVersion: z.literal(1), id: identifier, projectId: identifier, projectRevision: z.number().int().positive(),
  projectName: z.string().min(1).max(200), workspace: z.string().min(1), manifestId: identifier, manifestHash: hash,
  contextHash: z.string().min(1), revision: z.number().int().positive(), contentHash: hash,
  notesPath: z.string().min(1), designPath: z.string().min(1), designDocumentId: identifier,
  notesHash: hash, designHash: hash, createdAt: z.string(), updatedAt: z.string(),
  status: z.literal('draft'), professionalSignature: z.literal('unsigned'),
  flowId: identifier.optional(), runId: identifier.optional()
}).strict()
export type SurveyCollaborationDraftV1 = z.infer<typeof SurveyCollaborationDraftV1>
export type SurveyDraftReferenceV1 = z.infer<typeof SurveyDraftReferenceV1>
export const SurveyDraftExportV1 = z.object({
  schemaVersion: z.literal(1), draftId: identifier, revision: z.number().int().positive(), contentHash: hash,
  reviewStatus: z.literal('draft'), professionalSignature: z.literal('unsigned'),
  files: z.array(z.object({ path: z.string().min(1), mediaType: z.string().min(1), sha256: hash, sizeBytes: z.number().int().nonnegative() }).strict()).max(10)
}).strict()
export type SurveyDraftExportV1 = z.infer<typeof SurveyDraftExportV1>
