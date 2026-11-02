/** When upstream `GET /v1/models` fails, offer the current DeepSeek V4.1 Flash id in the composer. */
export const DEFAULT_COMPOSER_MODEL_IDS = [
  'auto',
  'deepseek-flash'
] as const

/**
 * Legacy DeepSeek ids remain accepted by the Runtime as configuration aliases,
 * but they are compatibility identifiers and must not appear in user pickers.
 */
export const RETIRED_COMPOSER_MODEL_IDS = new Set(['deepseek-chat', 'deepseek-reasoner'])

export function isVisibleComposerModelId(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase()
  return !RETIRED_COMPOSER_MODEL_IDS.has(normalized) && !normalized.startsWith('deepseek-v4-')
}
