import { create } from 'zustand'
import type { AttachmentReference } from '../../agent/types'
import type { ComposerReasoningEffort } from '../chat/FloatingComposerModelPicker'
import type { SurveyEvidenceReferenceV1 } from '@shared/survey-evidence-reference'

export type EngineeringEvidenceReference = {
  typedEvidence?: SurveyEvidenceReferenceV1
  projectId?: string
  projectRevision?: number
  section: string
  networkId?: string
  networkRevision?: number
  sourceSha256?: string
  parserId?: string
  parserVersion?: string
  parserSourceHash?: string
  adjustmentId?: string
  algorithmVersion?: string
  observationId?: string
  sourceRecordId?: string
  sourceRecord?: number
  byteOffset?: number
  diagnosticCode?: string
  diagnosticIndex?: number
  pointId?: string
  metric?: string
  manifestId?: string
  runId?: string
  reviewStatus?: string
  outputSha256?: string
  outputPath?: string
}

export type EngineeringConversationDraft = {
  input: string
  attachments: AttachmentReference[]
  uploading: boolean
  error: string | null
  reasoningEffort?: ComposerReasoningEffort
  viewContext?: EngineeringEvidenceReference
  /** Explicitly selected evidence survives navigation until the question is sent. */
  evidenceContext?: EngineeringEvidenceReference
}
export const EMPTY_ENGINEERING_DRAFT: EngineeringConversationDraft = { input: '', attachments: [], uploading: false, error: null }

// Session-local drafts survive panel unmounts without writing attachment data
// to localStorage or mixing it with the Code/Write composer.
export const useEngineeringConversationDrafts = create<{
  drafts: Record<string, EngineeringConversationDraft>
  update: (scope: string, update: (draft: EngineeringConversationDraft) => EngineeringConversationDraft) => void
}>((set) => ({
  drafts: {},
  update: (scope, update) => set((state) => ({ drafts: { ...state.drafts, [scope]: update(state.drafts[scope] ?? EMPTY_ENGINEERING_DRAFT) } }))
}))

export function prepareEngineeringQuestion(workspace: string, projectId: string, question: string, evidence: EngineeringEvidenceReference): void {
  useEngineeringConversationDrafts.getState().update(JSON.stringify([workspace, projectId]), (draft) => ({
    ...draft,
    input: draft.input.trim() ? draft.input : question,
    viewContext: evidence,
    evidenceContext: evidence
  }))
}
