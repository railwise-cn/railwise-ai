import { createContext, useContext, type ReactElement, type ReactNode } from 'react'
import { MessageCircleQuestion } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { SurveyEvidenceReferenceV1, type SurveyEvidenceSelectorV1 } from '@shared/survey-evidence-reference'
import { prepareEngineeringQuestion } from './engineering-conversation-drafts'

type Selection<T> = T extends unknown ? Omit<T, 'schemaVersion' | 'projectId' | 'projectRevision'> : never
export type EngineeringEvidenceSelection = Selection<SurveyEvidenceReferenceV1>
type Scope = { workspace: string; projectId: string; projectRevision: number; ready: boolean; focus: () => void }
const EvidenceScope = createContext<Scope | null>(null)
const SelectedRecord = createContext<EngineeringEvidenceSelection | null>(null)

export function EngineeringEvidenceQuestions({ scope, children }: { scope: Scope | null; children: ReactNode }): ReactElement {
  return <EvidenceScope.Provider value={scope}>{children}</EvidenceScope.Provider>
}

export function EngineeringSelectedEvidence({ reference, children }: { reference: EngineeringEvidenceSelection; children: ReactNode }): ReactElement {
  return <SelectedRecord.Provider value={reference}>{children}</SelectedRecord.Provider>
}

export function EngineeringEvidenceQuestion({ label, reference, selector, disabled = false }: {
  label: string
  reference?: EngineeringEvidenceSelection | SurveyEvidenceReferenceV1
  selector?: SurveyEvidenceSelectorV1
  disabled?: boolean
}): ReactElement | null {
  const { t } = useTranslation('common')
  const scope = useContext(EvidenceScope)
  const selected = useContext(SelectedRecord)
  if (!scope) return null
  const value = reference ?? selected
  const parsed = SurveyEvidenceReferenceV1.safeParse({ schemaVersion: 1, projectId: scope.projectId, projectRevision: scope.projectRevision, ...value, ...(selector ? { selector } : {}) })
  const evidence = parsed.success && parsed.data.projectId === scope.projectId && parsed.data.projectRevision === scope.projectRevision ? parsed.data : null
  const title = t('surveyAskEvidence', { label })
  return <button type="button" aria-label={title} title={title} disabled={disabled || !scope.ready || !scope.workspace || !evidence}
    className="ml-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-accent hover:bg-accent/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40"
    onClick={event => {
      event.stopPropagation()
      if (disabled || !scope.ready || !scope.workspace || !evidence) return
      prepareEngineeringQuestion(scope.workspace, scope.projectId, t('surveyExplainEvidence', { label }), {
        projectId: scope.projectId, projectRevision: scope.projectRevision, section: evidence.kind, typedEvidence: evidence
      })
      scope.focus()
    }}><MessageCircleQuestion aria-hidden="true" className="h-3.5 w-3.5" /></button>
}
