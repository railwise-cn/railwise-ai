import { beforeEach, describe, expect, it } from 'vitest'
import { prepareEngineeringQuestion, useEngineeringConversationDrafts } from './engineering-conversation-drafts'

beforeEach(() => useEngineeringConversationDrafts.setState({ drafts: {} }))

describe('Survey conversation draft scope', () => {
  it('keeps the same project ID independent across workspaces when evidence is selected', () => {
    const first = JSON.stringify(['/workspace-a', 'project-a'])
    const second = JSON.stringify(['/workspace-b', 'project-a'])
    useEngineeringConversationDrafts.getState().update(first, draft => ({ ...draft, input: 'Existing question', reasoningEffort: 'low' }))
    useEngineeringConversationDrafts.getState().update(second, draft => ({ ...draft, reasoningEffort: 'high' }))

    prepareEngineeringQuestion('/workspace-a', 'project-a', 'Suggested question', { section: 'result', adjustmentId: 'adjustment-a' })
    prepareEngineeringQuestion('/workspace-b', 'project-a', 'Other workspace question', { section: 'observations', observationId: 'observation-b' })

    expect(useEngineeringConversationDrafts.getState().drafts[first]).toMatchObject({
      input: 'Existing question', reasoningEffort: 'low', evidenceContext: { adjustmentId: 'adjustment-a' }
    })
    expect(useEngineeringConversationDrafts.getState().drafts[second]).toMatchObject({
      input: 'Other workspace question', reasoningEffort: 'high', evidenceContext: { observationId: 'observation-b' }
    })
  })
})
