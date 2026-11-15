import { z } from 'zod'

const publicUrl = z.string().max(4096).refine(value => {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password } catch { return false }
}, 'An exact observed HTTP(S) URL is required')
export const WebSourceReferenceSchema = z.object({ url: publicUrl, resultHash: z.string().regex(/^[a-f0-9]{64}$/i) }).strict()
export const WebArtifactEvidenceInputSchema = z.object({
  path: z.string().min(1).max(240),
  coverage: z.array(WebSourceReferenceSchema).min(1).max(32),
  items: z.array(z.object({
    sectionId: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,79}$/),
    title: z.string().trim().min(4).max(500),
    source: WebSourceReferenceSchema,
    discovery: WebSourceReferenceSchema,
    classification: z.enum(['opportunity', 'intent', 'historical', 'source']),
    fields: z.array(z.object({ field: z.enum(['title', 'publication_date', 'budget', 'deadline', 'status', 'qualification', 'other']),
      value: z.string().trim().min(1).max(2000), quote: z.string().trim().min(12).max(6000) }).strict()).min(1).max(20),
    unverifiedFields: z.array(z.enum(['publication_date', 'budget', 'deadline', 'status', 'qualification'])).max(5).default([])
  }).strict()).max(100).default([]),
  noMatches: z.array(z.object({ source: WebSourceReferenceSchema, query: z.string().trim().min(2).max(120), quote: z.string().min(2).max(1000) }).strict()).max(32).default([])
}).strict()
export type WebArtifactEvidenceInput = z.infer<typeof WebArtifactEvidenceInputSchema>
export type WebSourceReference = z.infer<typeof WebSourceReferenceSchema>
