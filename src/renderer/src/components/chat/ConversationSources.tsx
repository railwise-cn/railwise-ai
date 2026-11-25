import type { ReactElement } from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ChatBlock } from '../../agent/types'

export type ConversationSource = {
  title: string
  url: string
  domain: string
  sourceId?: string
  kind: 'search' | 'fetch' | 'other'
}

function normalizeSource(value: unknown): { source: ConversationSource; dedupeKey: string } | null {
  if (!value || typeof value !== 'object') return null
  const source = value as Record<string, unknown>
  if (typeof source.url !== 'string' || !source.url.trim()) return null

  try {
    const url = new URL(source.url.trim())
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return null
    const href = url.href
    url.hash = ''
    const sourceId = typeof source.sourceId === 'string' && source.sourceId.trim() ? source.sourceId.trim() : undefined
    const kind = sourceId?.startsWith('web_search_')
      ? 'search'
      : sourceId?.startsWith('web_fetch_')
        ? 'fetch'
        : 'other'
    const title = typeof source.title === 'string' && source.title.trim()
      ? source.title.trim()
      : url.hostname
    return {
      source: {
        title,
        url: href,
        domain: url.hostname.replace(/^www\./i, ''),
        kind,
        ...(sourceId ? { sourceId } : {})
      },
      dedupeKey: url.href
    }
  } catch {
    return null
  }
}

export function normalizeConversationSources(value: unknown): ConversationSource[] {
  if (!Array.isArray(value)) return []
  const seen = new Map<string, number>()
  const sources: ConversationSource[] = []
  for (const entry of value) {
    const normalized = normalizeSource(entry)
    if (!normalized) continue
    const { source, dedupeKey } = normalized
    const existingIndex = seen.get(dedupeKey)
    if (existingIndex !== undefined) {
      if (source.kind === 'fetch' && sources[existingIndex]?.kind !== 'fetch') {
        sources[existingIndex] = source
      }
      continue
    }
    seen.set(dedupeKey, sources.length)
    sources.push(source)
  }
  return sources
}

export function sourcesForAssistantMessages(blocks: ChatBlock[]): {
  byAssistantId: Map<string, ConversationSource[]>
  pendingSources: ConversationSource[]
} {
  const byAssistantId = new Map<string, ConversationSource[]>()
  let pending: ConversationSource[] = []

  for (const block of blocks) {
    if (block.kind === 'tool') {
      const toolName = block.meta?.toolName
      const expectedKind = toolName === 'web_search' ? 'search' : toolName === 'web_fetch' ? 'fetch' : undefined
      if (!expectedKind) continue
      const toolSources = normalizeConversationSources(block.meta?.sources)
        .filter(source => source.kind === expectedKind)
      pending = normalizeConversationSources([
        ...pending,
        ...toolSources
      ])
    } else if (block.kind === 'assistant') {
      if (pending.length > 0) byAssistantId.set(block.id, pending)
      pending = []
    }
  }

  return { byAssistantId, pendingSources: pending }
}

export function ConversationSources({ sources }: { sources: ConversationSource[] }): ReactElement | null {
  const { t } = useTranslation('common')
  const [expanded, setExpanded] = useState(false)
  if (sources.length === 0) return null

  const visibleSources = expanded ? sources : sources.slice(0, 3)

  return (
    <section
      aria-label={t('conversationSources')}
      className="mt-3 min-w-0 border-l-2 border-accent/35 pl-3"
    >
      <div className="flex items-center gap-1.5 text-[12px] font-medium text-ds-muted">
        <span>{t('conversationSources')}</span>
        <span aria-label={t('conversationSourceCount', { count: sources.length })} className="text-ds-faint">
          {sources.length}
        </span>
      </div>
      <ol className="mt-1.5 flex min-w-0 flex-col gap-1.5">
        {visibleSources.map((source, index) => (
          <li key={source.url} className="min-w-0">
            <a
              href={source.url}
              target="_blank"
              rel="noopener noreferrer"
              title={source.title}
              className="group/source flex min-w-0 items-baseline gap-1.5 text-[13px] leading-5 text-accent hover:underline focus-visible:rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <span aria-hidden="true" className="shrink-0 text-[11px] text-ds-faint">{index + 1}.</span>
              <span className="min-w-0 truncate">{source.title}</span>
            </a>
            <div className="ml-4 flex min-w-0 items-center gap-1.5 text-[11.5px] leading-4 text-ds-faint">
              <span className="min-w-0 truncate">{source.domain}</span>
              <span aria-hidden="true">·</span>
              <span className="shrink-0">
                {t(source.kind === 'fetch' ? 'conversationSourceRead' : source.kind === 'search' ? 'conversationSourceSearch' : 'conversationSourceOther')}
              </span>
            </div>
          </li>
        ))}
      </ol>
      {sources.length > 3 ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded(value => !value)}
          className="mt-1.5 rounded-sm text-[12px] font-medium text-ds-muted underline decoration-ds-border-muted underline-offset-2 hover:text-ds-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {expanded
            ? t('conversationSourcesShowFewer')
            : t('conversationSourcesShowAll', { count: sources.length })}
        </button>
      ) : null}
    </section>
  )
}
