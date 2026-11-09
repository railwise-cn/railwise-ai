import type { SddDraftImageReference } from './sdd-draft-images'

export type SddPlanImageMode = 'attachments' | 'unavailable' | 'none'

function formatDimensions(image: SddDraftImageReference): string {
  return image.width && image.height ? `${image.width}x${image.height}` : 'unknown'
}

function imageReferenceMap(images: SddDraftImageReference[], mode: SddPlanImageMode): string[] {
  if (images.length === 0) return []
  const lines = [
    'Image Reference Map:',
    'Use these references to connect each image to the exact Markdown location where the user placed it.'
  ]
  for (const image of images) {
    lines.push(
      '',
      `Image ${image.index}: ${image.markdownPath}`,
      `Alt: ${image.alt || '(none)'}`,
      `Workspace path: ${image.relativePath}`,
      `MIME: ${image.mimeType}`,
      `Dimensions: ${formatDimensions(image)}`,
      `Bytes: ${image.byteSize}`
    )
    if (mode === 'attachments') {
      lines.push(`Attachment: ${image.attachmentId ?? '(uploaded attachment)'}`)
    }
    if (mode === 'unavailable') {
      lines.push('Visual analysis: unavailable for this turn.')
    }
  }
  return lines
}

export function buildSddDraftToPlanPrompt(options: {
  draftMarkdown: string
  draftRelativePath: string
  planRelativePath: string
  assistantContext?: string
  workspaceRoot: string
  images: SddDraftImageReference[]
  imageMode: SddPlanImageMode
}): string {
  const imageInstruction =
    options.imageMode === 'attachments'
      ? 'The images are also attached to this turn. Use the Image Reference Map to match each attachment to its Markdown location.'
      : options.imageMode === 'unavailable'
        ? 'The draft references local images, but this turn cannot provide visual evidence to the model. Do not infer visual details from the images or claim they were inspected. Use only the written draft and the image metadata below; note the limitation in the plan when it affects an acceptance criterion.'
        : 'No local SDD images were referenced in the draft.'

  return [
    'RailWise AI Runtime is asking you to upgrade an SDD requirement draft into a concrete implementation plan.',
    `Workspace: ${options.workspaceRoot}`,
    `Draft file: ${options.draftRelativePath}`,
    `Reserved plan file: ${options.planRelativePath}`,
    '',
    'You MUST use the `create_plan` tool exactly once to save the final plan.',
    '- Set `operation` to `draft`.',
    '- Set `markdown` to the complete executable implementation plan.',
    '- Set `source_request` to a concise summary of the SDD draft.',
    '- Set `title` to a short feature title derived from the requirement.',
    `- Set \`plan_relative_path\` to \`${options.planRelativePath}\`.`,
    '- Do not edit project files directly during this planning turn.',
    '- Save exactly to the reserved plan file above.',
    '',
    imageInstruction,
    '',
    'Requirement draft Markdown:',
    '```markdown',
    options.draftMarkdown.trim(),
    '```',
    '',
    ...(options.assistantContext?.trim()
      ? [
          'Requirement AI conversation context:',
          'Use this as supporting context from the sidebar Requirement AI conversation. The draft remains the source of truth when there is a conflict.',
          '```text',
          options.assistantContext.trim(),
          '```',
          ''
        ]
      : []),
    '',
    ...imageReferenceMap(options.images, options.imageMode),
    '',
    'Plan expectations:',
    '- Preserve the user intent from the draft.',
    '- Turn fuzzy requirement notes into concrete implementation steps.',
    '- Include UI/data-flow/API behavior where relevant.',
    '- Include tests and acceptance criteria.',
    '- If images affect requirements, cite them by Image N in the plan.',
    '',
    'Requirement traceability (covers tags):',
    '- The draft may contain structured requirement blocks: level-3 headings like `### R-1: title {status}` followed by a description and an acceptance checklist.',
    '- When requirement blocks exist, every actionable `- [ ]` step in the plan MUST end with a covers tag linking it to the requirement ids it implements, e.g. `- [ ] Implement export API (covers: R-1)` or `(covers: R-1, R-3)`.',
    '- Together the steps must cover every requirement id present in the draft. Do not leave any R-id uncovered, and do not invent R-ids that are not in the draft.',
    '- Steps that are pure scaffolding may omit the covers tag, but prefer attaching them to the closest requirement.'
  ].join('\n')
}
