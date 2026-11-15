import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { evidenceDisplayText, evidenceLiteralText, WebArtifactEvidenceInputSchema } from './web-artifact-evidence.js'

const title = '工程测量监测服务采购项目公开招标公告'
const source = { url: 'https://a.example.test/notice/1', resultHash: 'a'.repeat(64) }
const discovery = { url: 'https://a.example.test/list', resultHash: 'b'.repeat(64) }
function input() {
  return { path: 'report.html', coverage: [source], items: [{ sectionId: 'notice-1', title, source, discovery,
    classification: 'opportunity', fields: [{ field: 'title', value: title, quote: title },
      { field: 'deadline', value: '2026年12月1日14时00分', quote: '投标文件递交的截止时间为2026年12月1日14时00分。' }],
    unverifiedFields: ['publication_date', 'budget', 'status', 'qualification'] }], noMatches: [] }
}

describe('web evidence literal field contract', () => {
  it('decodes display entities once while retaining human-readable whitespace', () => {
    expect(evidenceDisplayText('A&nbsp;&amp; B')).toBe('A & B')
    expect(evidenceLiteralText('A&nbsp;&amp; B')).toBe('A&B')
  })

  it('accepts literal source text and explicit unknown fields without inventing values', () => {
    expect(WebArtifactEvidenceInputSchema.parse(input()).items[0]!.unverifiedFields).toEqual(['publication_date', 'budget', 'status', 'qualification'])
  })

  it.each([
    ['date', '2026-11-18 14:00', '投标文件递交的截止时间为2026年11月18日14时00分。'],
    ['budget', '808870 元（含税，最高投标限价）', '2.4本项目招标控制价（最高投标限价）：808870元（含税）。'],
    ['status', '招标进行中', '招标文件报名时间至2026年11月16日23:59时止。'],
    ['qualification', '岩土工程乙级及以上', '本次招标要求具有工程勘察专业类（岩土工程）乙级及以上资质。']
  ])('rejects reformatted or paraphrased %s before publishing', (_label, value, quote) => {
    const proof = input()
    proof.items[0]!.fields[1] = { field: 'deadline', value, quote }
    expect(WebArtifactEvidenceInputSchema.safeParse(proof).success).toBe(false)
  })

  it('retains the existing HTML/entity/whitespace literal normalization', () => {
    const proof = input()
    proof.items[0]!.fields[1] = { field: 'deadline', value: '808 870 元（含税）', quote: '2.4最高投标限价：808870&nbsp;元（含税）。' }
    expect(WebArtifactEvidenceInputSchema.safeParse(proof).success).toBe(true)
  })

  it('rejects a value with no literal text after markup removal', () => {
    const proof = input()
    proof.items[0]!.fields[1] = { field: 'deadline', value: '<script>discard()</script>', quote: '投标文件递交的截止时间尚未在页面中披露。' }
    expect(WebArtifactEvidenceInputSchema.safeParse(proof).success).toBe(false)
  })

  it('rejects duplicate item identifiers', () => {
    const proof = input(); proof.items.push(structuredClone(proof.items[0]!))
    expect(WebArtifactEvidenceInputSchema.safeParse(proof).success).toBe(false)
  })

  it('rejects duplicate verified fields', () => {
    const proof = input(); proof.items[0]!.fields.push(structuredClone(proof.items[0]!.fields[0]!))
    expect(WebArtifactEvidenceInputSchema.safeParse(proof).success).toBe(false)
  })

  it('rejects declaring the same field verified and unverified', () => {
    const proof = input(); proof.items[0]!.unverifiedFields.push('deadline')
    expect(WebArtifactEvidenceInputSchema.safeParse(proof).success).toBe(false)
  })

  it('rejects duplicate unknown-field declarations', () => {
    const proof = input(); proof.items[0]!.unverifiedFields.push('budget')
    expect(WebArtifactEvidenceInputSchema.safeParse(proof).success).toBe(false)
  })

  it('advertises that value is literal evidence rather than formatted display text', () => {
    const schema = JSON.stringify(z.toJSONSchema(WebArtifactEvidenceInputSchema))
    expect(schema).toMatch(/literal|原文/)
    expect(schema).toMatch(/unverified|待核验/)
  })
})
