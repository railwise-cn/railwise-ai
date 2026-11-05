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

/** The built-in provider id used for the official DeepSeek connection. */
export const OFFICIAL_DEEPSEEK_PROVIDER_ID = 'deepseek'

export function isVisibleComposerModelId(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase()
  return !RETIRED_COMPOSER_MODEL_IDS.has(normalized) && !normalized.startsWith('deepseek-v4-')
}

/**
 * Apply the product picker policy without breaking compatible custom providers.
 * A custom provider may intentionally expose a model whose id resembles a
 * retired DeepSeek id, while the built-in DeepSeek connection must only show
 * the current V4.1 model.
 */
export function isVisibleComposerModelIdForProvider(modelId: string, providerId?: string): boolean {
  if (providerId && providerId !== OFFICIAL_DEEPSEEK_PROVIDER_ID) return true
  return isVisibleComposerModelId(modelId)
}

/** Migrate a persisted official DeepSeek V4 selection to the current model. */
export function normalizeComposerModelForProvider(modelId: string, providerId?: string): string {
  const normalized = modelId.trim()
  if (
    normalized &&
    (!providerId || providerId === OFFICIAL_DEEPSEEK_PROVIDER_ID) &&
    (normalized.toLowerCase().startsWith('deepseek-v4-') || RETIRED_COMPOSER_MODEL_IDS.has(normalized.toLowerCase()))
  ) {
    return 'deepseek-flash'
  }
  return normalized
}
