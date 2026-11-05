import { describe, expect, it } from 'vitest'
import {
  DEFAULT_COMPOSER_MODEL_IDS,
  isVisibleComposerModelId,
  isVisibleComposerModelIdForProvider,
  normalizeComposerModelForProvider
} from './default-composer-models'

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

  it('migrates retired official selections while preserving custom provider ids', () => {
    expect(normalizeComposerModelForProvider('deepseek-v4-pro', 'deepseek')).toBe('deepseek-flash')
    expect(normalizeComposerModelForProvider('deepseek-v4-pro')).toBe('deepseek-flash')
    expect(normalizeComposerModelForProvider('deepseek-v4-pro', 'custom-provider')).toBe('deepseek-v4-pro')
    expect(isVisibleComposerModelIdForProvider('deepseek-v4-pro', 'deepseek')).toBe(false)
    expect(isVisibleComposerModelIdForProvider('deepseek-v4-pro', 'custom-provider')).toBe(true)
  })
})
