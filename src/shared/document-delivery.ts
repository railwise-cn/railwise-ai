import type { DocumentRevision, DocumentSnapshot, DocumentConflict } from './write-document'
export type CandidateSource = { path: string; location?: string; excerpt?: string; revision?: string; sha256?: string; stale?: boolean; sections?: string[] }
export type CandidateSection = { id: string; heading: string; level: number; startLine: number; endLine: number; sourcePaths: string[] }
export type DocumentCandidateReview = {
  path: string; content: string; source: 'candidate'; taskId?: string; templateId?: string
  sources: CandidateSource[]; createdAt?: string; candidateRevision: DocumentRevision
  targetPath?: string; baseline?: DocumentSnapshot | null; current?: DocumentSnapshot | null
  status: 'pending' | 'accepted' | 'rejected' | 'conflict' | 'outcome_unknown'
  sourcesStale?: boolean
  sections?: CandidateSection[]
  affectedSections?: CandidateSection[]
}
export type CandidateReviewRequest = { workspaceRoot: string; path: string; targetPath?: string }
export type CandidateDecisionRequest = CandidateReviewRequest & {
  decision: 'accept' | 'reject'; idempotencyKey: string; candidateRevision: DocumentRevision
  expectedRevision: DocumentRevision | null
}
export type CandidateDecisionResult = { ok: boolean; status: DocumentCandidateReview['status']; snapshot?: DocumentSnapshot; conflict?: DocumentConflict; message?: string; preservedPath?: string }
