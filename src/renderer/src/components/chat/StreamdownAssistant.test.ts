import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { useChatStore } from '../../store/chat-store'
import { createFileReferenceHref } from '../../lib/file-references'
import { clearFileReferenceValidationCache } from '../../lib/file-reference-validation'
import { shouldAnimateStreamingText } from './StreamdownAssistant'
import { StreamdownAssistant } from './StreamdownAssistant'
import i18n from '../../i18n'

describe('shouldAnimateStreamingText', () => {
  it.each(['zh', 'en'])('renders table control titles in %s using the library translation API', async language => {
    const previousLanguage = i18n.language
    try {
      await i18n.changeLanguage(language)
      const html = renderToStaticMarkup(createElement(StreamdownAssistant, { text: '| Point | Height |\n| --- | --- |\n| BM1 | 10.00 |', streaming: false }))
      for (const key of ['markdownCopyTable', 'markdownDownloadTable', 'markdownViewFullscreen']) {
        expect(html).toContain(`title="${i18n.t(`common:${key}`)}"`)
      }
      if (language === 'zh') {
        expect(html).not.toContain('title="Copy table"')
        expect(html).not.toContain('title="Download table"')
        expect(html).not.toContain('title="View fullscreen"')
      }
    } finally { await i18n.changeLanguage(previousLanguage) }
  })
  it('keeps the lightweight reveal for short single-line text', () => {
    expect(shouldAnimateStreamingText('正在检查配置。')).toBe(true)
    expect(shouldAnimateStreamingText('Checking the CSS variables.')).toBe(true)
  })

  it('lets multiline streaming render from the actual SSE sequence', () => {
    expect(shouldAnimateStreamingText('First line\nSecond line')).toBe(false)
    expect(shouldAnimateStreamingText('First paragraph\n\nSecond paragraph')).toBe(false)
  })

  it('does not animate structured markdown while it is still streaming', () => {
    expect(shouldAnimateStreamingText('- one\n- two')).toBe(false)
    expect(shouldAnimateStreamingText('Use `npm test` next.')).toBe(false)
  })

  it('keeps the validated WorkWise file protocol available to the link component', () => {
    clearFileReferenceValidationCache()
    useChatStore.setState({ workspaceRoot: '/tmp/workspace' })
    const href = createFileReferenceHref({ path: 'qa-documents/report.pdf' })
    const html = renderToStaticMarkup(
      createElement(StreamdownAssistant, {
        text: '成果：qa-documents/report.pdf',
        streaming: false
      })
    )

    expect(html).not.toContain('[blocked]')
    expect(html).not.toContain('Blocked URL')
    // Server rendering has no preload bridge, so validation intentionally
    // degrades to plain text after the protocol has passed hardening.
    expect(href).toContain('deepseek-file://open?')
    expect(html).toContain('qa-documents/report.pdf')
  })

  it('converts Markdown workspace links before URL hardening', () => {
    clearFileReferenceValidationCache()
    useChatStore.setState({ workspaceRoot: '/tmp/workspace' })
    const html = renderToStaticMarkup(
      createElement(StreamdownAssistant, {
        text: '[打开演示文稿](qa-documents/产品介绍.pptx)',
        streaming: false
      })
    )

    expect(html).not.toContain('[blocked]')
    expect(html).not.toContain('Blocked URL')
    expect(html).toContain('打开演示文稿')
  })

  it('continues to block dangerous Markdown protocols', () => {
    const html = renderToStaticMarkup(
      createElement(StreamdownAssistant, {
        text: '[不要执行](javascript:alert(1))',
        streaming: false
      })
    )

    expect(html).not.toContain('href="javascript:')
  })
})
