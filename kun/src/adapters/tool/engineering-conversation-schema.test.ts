import { expect, it } from 'vitest'
import { z } from 'zod'
import { SurveyEvidenceReferenceV1 } from '../../contracts/survey-evidence-reference.js'
import type { SurveyEvidenceReader } from '../../engineering/survey-evidence-reader.js'
import { DeepseekCompatModelClient } from '../model/deepseek-compat-model-client.js'
import { buildEngineeringConversationTools } from './engineering-conversation-tools.js'
import type { ModelStreamChunk } from '../../ports/model-client.js'

it('sends Survey evidence as an object tool schema while preserving every exact-reference branch', async () => {
  const provider = buildEngineeringConversationTools(
    { get: async () => null } as never,
    () => { throw new Error('no execution during schema advertisement') },
    {} as SurveyEvidenceReader
  )
  let parameters: Record<string, unknown> | undefined
  const client = new DeepseekCompatModelClient({
    baseUrl: 'https://api.deepseek.com', apiKey: 'test', model: 'deepseek-v4-pro', nonStreaming: true,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      parameters = body.tools.find((tool: { function: { name: string } }) => tool.function.name === 'survey_read_evidence').function.parameters
      // Reproduce the provider rejection seen in final candidate #156.
      if (parameters?.type !== 'object') return new Response(JSON.stringify({ error: { message: 'Invalid schema: root must be type object' } }), { status: 400 })
      return new Response(JSON.stringify({ id: 'schema-accepted', model: 'deepseek-v4-pro', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'accepted' } }] }))
    }
  })
  const chunks: ModelStreamChunk[] = []
  for await (const chunk of client.stream({ threadId: 'schema', turnId: 'schema', model: client.model, prefix: [], history: [], tools: [...provider.tools], abortSignal: new AbortController().signal })) chunks.push(chunk)
  expect(chunks.filter(chunk => chunk.kind === 'error')).toEqual([])
  expect(chunks).toContainEqual({ kind: 'assistant_text_delta', text: 'accepted' })
  const original = z.toJSONSchema(SurveyEvidenceReferenceV1)
  expect(parameters).toEqual({ ...original, type: 'object' })
  expect(original.oneOf).toHaveLength(18)
})
