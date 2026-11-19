import { describe, expect, it, vi } from 'vitest'
import { clearComposerDraftAfterSuccessfulSend, emptyComposerMessage } from './composer-send-result'

describe('composer send result', () => {
  it('preserves the draft and attachments when a send is rejected', () => {
    const actions = {
      clearInput: vi.fn(),
      clearAttachments: vi.fn(),
      clearFileReferences: vi.fn(),
      clearCapabilities: vi.fn()
    }

    expect(clearComposerDraftAfterSuccessfulSend(false, actions)).toBe(false)
    expect(actions.clearInput).not.toHaveBeenCalled()
    expect(actions.clearAttachments).not.toHaveBeenCalled()
    expect(actions.clearFileReferences).not.toHaveBeenCalled()
    expect(actions.clearCapabilities).not.toHaveBeenCalled()
  })

  it('clears every part of the composer after a successful send', () => {
    const actions = {
      clearInput: vi.fn(),
      clearAttachments: vi.fn(),
      clearFileReferences: vi.fn(),
      clearCapabilities: vi.fn()
    }

    expect(clearComposerDraftAfterSuccessfulSend(true, actions)).toBe(true)
    expect(actions.clearInput).toHaveBeenCalledOnce()
    expect(actions.clearAttachments).toHaveBeenCalledOnce()
    expect(actions.clearFileReferences).toHaveBeenCalledOnce()
    expect(actions.clearCapabilities).toHaveBeenCalledOnce()
  })

  it('uses the document-only prompt for a scanned PDF attached with an empty draft', () => {
    const translate = (key: string) => key
    const pdf = { id: 'scan', name: '宣传册.pdf', state: 'degraded' as const }
    expect(emptyComposerMessage([pdf], 0, translate)).toEqual({
      prompt: 'composerDocumentsOnlyPrompt', display: 'composerDocumentsOnlyDisplay'
    })
    expect(emptyComposerMessage([pdf, { id: 'image', kind: 'image' }], 1, translate).prompt)
      .toBe('composerDocumentsAndReferencesPrompt')
    expect(emptyComposerMessage([{ id: 'image', kind: 'image' }], 0, translate).prompt)
      .toBe('composerImageOnlyPrompt')
  })
})
