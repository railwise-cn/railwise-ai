import { describe, expect, it } from 'vitest'
import { DEFAULT_COMPOSER_MODEL_IDS, isVisibleComposerModelId } from './default-composer-models'

describe('DeepSeek composer defaults', () => {
  it('uses the current V4.1 Flash id when the provider catalog is unavailable', () => {
    expect(DEFAULT_COMPOSER_MODEL_IDS).toEqual(['auto', 'deepseek-flash'])
  })

  it('keeps compatibility ids out of user-facing model pickers', () => {
    expect(isVisibleComposerModelId('deepseek-flash')).toBe(true)
    expect(isVisibleComposerModelId('deepseek-v4-pro')).toBe(false)
    expect(isVisibleComposerModelId('deepseek-v4-flash')).toBe(false)
    expect(isVisibleComposerModelId('deepseek-v4-flash-vision-exp')).toBe(false)
  })
})
