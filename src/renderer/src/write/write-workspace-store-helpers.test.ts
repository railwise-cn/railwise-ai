// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  WRITE_ASSISTANT_MODEL_KEY,
  WRITE_ASSISTANT_SELECTION_KEY,
  readStoredAssistantModel,
  readStoredAssistantSelection
} from './write-workspace-store-helpers'

function createMemoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key) },
    setItem: (key, value) => { values.set(key, value) }
  }
}

describe('write assistant model migration', () => {
  beforeEach(() => vi.stubGlobal('localStorage', createMemoryStorage()))
  afterEach(() => vi.unstubAllGlobals())

  it('maps a legacy official selection to DeepSeek V4.1 Flash', () => {
    window.localStorage.setItem(WRITE_ASSISTANT_SELECTION_KEY, JSON.stringify({
      version: 1,
      model: 'deepseek-v4-pro',
      providerId: 'deepseek'
    }))
    expect(readStoredAssistantSelection()).toEqual({ model: 'deepseek-flash', providerId: 'deepseek' })
    expect(readStoredAssistantModel()).toBe('deepseek-flash')
  })

  it('keeps a same-named model configured through a custom provider', () => {
    window.localStorage.setItem(WRITE_ASSISTANT_MODEL_KEY, 'deepseek-v4-pro')
    window.localStorage.setItem(WRITE_ASSISTANT_SELECTION_KEY, JSON.stringify({
      version: 1,
      model: 'deepseek-v4-pro',
      providerId: 'custom-provider'
    }))
    expect(readStoredAssistantSelection()).toEqual({ model: 'deepseek-v4-pro', providerId: 'custom-provider' })
    expect(readStoredAssistantModel()).toBe('deepseek-v4-pro')
  })
})
