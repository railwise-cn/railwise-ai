import { describe, expect, it } from 'vitest'
import { isProfessionalSurveyThread } from './side-conversation-professional'

describe('isProfessionalSurveyThread', () => {
  it('recognizes legacy project-bound survey threads without current domain or title metadata', () => {
    expect(isProfessionalSurveyThread({ projectId: 'survey-project-1', title: 'Conversation' })).toBe(true)
  })

  it('leaves unrelated conversations in the normal chat presentation', () => {
    expect(isProfessionalSurveyThread({ domain: 'code', title: 'Fix parser' })).toBe(false)
    expect(isProfessionalSurveyThread({ domain: 'engineering', title: 'Conversation' })).toBe(true)
    expect(isProfessionalSurveyThread({ title: '测量复核' })).toBe(true)
    expect(isProfessionalSurveyThread(null)).toBe(false)
  })
})
