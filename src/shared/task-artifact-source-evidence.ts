import type { TaskArtifactV1, TaskRunV1 } from './agent-workbench'

/** File validation and source verification are separate, including old HTML. */
export function taskArtifactSourceEvidenceState(task: Pick<TaskRunV1, 'acceptance'>, artifact: TaskArtifactV1): 'draft' | 'verified' | null {
  if (!/\.html?$/i.test(artifact.relativePath) ||
    (!task.acceptance?.requiresWebEvidence && artifact.sourceEvidenceStatus === undefined)) return null
  return artifact.validation === 'valid' && artifact.sourceEvidenceStatus === 'verified' && artifact.sourceEvidenceReceiptId?.trim()
    ? 'verified' : 'draft'
}

export function taskArtifactValidationLabelKey(task: Pick<TaskRunV1, 'acceptance'>, artifact: TaskArtifactV1): string {
  const source = taskArtifactSourceEvidenceState(task, artifact)
  return artifact.validation === 'valid' && source
    ? source === 'verified' ? 'taskArtifactSourceEvidenceVerified' : 'taskArtifactSourceEvidenceDraft'
    : `taskArtifactValidation_${artifact.validation}`
}
