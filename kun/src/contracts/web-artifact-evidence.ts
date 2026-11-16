import { z } from 'zod'

/** Plain display text under the existing evidence markup/entity rules; retain whitespace. */
export function evidenceDisplayText(value: string): string {
  const plain = value.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '').replace(/<[^>]*>/g, ' ')
  return plain.replace(/&#(?:x([a-f0-9]+)|(\d+));/gi, (_, hex: string | undefined, decimal: string | undefined) => {
    const code = parseInt(hex ?? decimal!, hex ? 16 : 10)
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
  }).replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, key: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[key as 'amp']!)
}

/** The evidence contract permits markup/entity/whitespace normalization, never semantic rewriting. */
export function evidenceLiteralText(value: string): string {
  return evidenceDisplayText(value).replace(/\s+/g, '')
}

const publicUrl = z.string().max(4096).refine(value => {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password } catch { return false }
}, 'An exact observed HTTP(S) URL is required')
export const WebSourceReferenceSchema = z.object({ url: publicUrl, resultHash: z.string().regex(/^[a-f0-9]{64}$/i) }).strict()
export const WebArtifactEvidenceInputSchema = z.object({
  path: z.string().min(1).max(240),
  coverage: z.array(WebSourceReferenceSchema).min(1).max(32),
  items: z.array(z.object({
    sectionId: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,79}$/).describe('Unique report item id; the HTML id and data-evidence-item must use this exact value.'),
    title: z.string().trim().min(4).max(500),
    source: WebSourceReferenceSchema,
    discovery: WebSourceReferenceSchema,
    recordUrl: publicUrl.optional().describe('Observed-feed only: exact actual href of this record in the read list, not a claimed read of the destination. Source/discovery must both reference that list.'),
    classification: z.enum(['opportunity', 'intent', 'historical', 'source']),
    fields: z.array(z.object({ field: z.enum(['title', 'publication_date', 'budget', 'deadline', 'status', 'qualification', 'other']),
      value: z.string().trim().min(1).max(2000).describe('Literal continuous source text copied from quote, not a formatted display value or inferred status. Preserve original date, currency and qualification wording. The HTML data-evidence-field text must equal this value after markup/entity/whitespace normalization.'),
      quote: z.string().trim().min(12).max(6000).describe('Verbatim source excerpt containing the complete literal value. Source receipt verification still checks that this quote occurs in the actually read source document or same feed record selected by the server task basis; a matching quote/value pair alone is not source verification.') }).strict()).min(1).max(20),
    unverifiedFields: z.array(z.enum(['publication_date', 'budget', 'deadline', 'status', 'qualification'])).max(5).default([]).describe('Unknown fields only: omit them from fields and render the matching data-evidence-field with data-evidence-unverified and visible 待核验. No guessed value. This cannot replace title, discovery or the source-record/document and origin evidence required by the server task basis.')
  }).strict()).max(100).default([]),
  noMatches: z.array(z.object({ source: WebSourceReferenceSchema, query: z.string().trim().min(2).max(120), quote: z.string().min(2).max(1000) }).strict()).max(32).default([])
}).strict().superRefine((input, context) => {
  const ids = new Set<string>()
  for (const [itemIndex, item] of input.items.entries()) {
    if (ids.has(item.sectionId)) context.addIssue({ code: 'custom', path: ['items', itemIndex, 'sectionId'], message: 'Report sectionId must be unique; repair the same item instead of appending a duplicate.' })
    ids.add(item.sectionId)
    const verified = new Set<string>()
    for (const [fieldIndex, field] of item.fields.entries()) {
      if (verified.has(field.field)) context.addIssue({ code: 'custom', path: ['items', itemIndex, 'fields', fieldIndex, 'field'], message: 'Each verified field may be declared only once per item.' })
      verified.add(field.field)
      const value = evidenceLiteralText(field.value), quote = evidenceLiteralText(field.quote)
      if (!value || !quote.includes(value)) context.addIssue({ code: 'custom', path: ['items', itemIndex, 'fields', fieldIndex, 'value'], message: 'value must be nonempty literal text contained continuously in quote; do not reformat dates or money, paraphrase qualifications, or infer status. Use the raw source value or explicitly mark the field unverified.' })
    }
    const unknown = new Set<string>()
    for (const [fieldIndex, field] of item.unverifiedFields.entries()) {
      if (unknown.has(field)) context.addIssue({ code: 'custom', path: ['items', itemIndex, 'unverifiedFields', fieldIndex], message: 'Each unverified field may be declared only once per item.' })
      if (verified.has(field)) context.addIssue({ code: 'custom', path: ['items', itemIndex, 'unverifiedFields', fieldIndex], message: 'A field cannot be both verified and unverified; remove its guessed value from fields.' })
      unknown.add(field)
    }
  }
})
export type WebArtifactEvidenceInput = z.infer<typeof WebArtifactEvidenceInputSchema>
export type WebSourceReference = z.infer<typeof WebSourceReferenceSchema>

/** Exact public URLs stay in the task-owned sealed manifest, outside general URL projection. */
export const WebArtifactVerificationRequestSchema = z.union([
  WebArtifactEvidenceInputSchema,
  z.object({ path: WebArtifactEvidenceInputSchema.shape.path, manifestRef: z.string().regex(/^web-manifest:[a-f0-9]{64}$/) }).strict()
])
export type WebArtifactVerificationRequest = z.infer<typeof WebArtifactVerificationRequestSchema>
