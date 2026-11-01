import { useState, type ReactElement } from 'react'
import { Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export function WriteDocumentAiActions({ disabled, busy, hasSelection, onEdit, onAskSources }: {
  disabled: boolean; busy: boolean; hasSelection: boolean
  onEdit: (prompt: string, documentAction?: 'append' | 'replace') => void
  onAskSources: (query: string) => void
}): ReactElement {
  const { i18n } = useTranslation('common')
  const label = (cn: string, en: string): string => i18n.language.startsWith('zh') ? cn : en
  const [open, setOpen] = useState(false)
  const [sourceQuery, setSourceQuery] = useState('')
  const actions = hasSelection ? [
    label('改写选区，保持原意并提高准确性。', 'Rewrite the selection, preserving meaning and improving accuracy.'),
    label('压缩选区，保留关键事实和结论。', 'Shorten the selection while keeping key facts and conclusions.'),
    label('扩写选区，补充清晰解释，不编造数据。', 'Expand the selection with clear explanations, without inventing facts.'),
    label('将选区调整为正式工程报告风格。', 'Rewrite the selection in a formal technical report style.'),
    label('统一选区术语，参考上下文中的现有用词，不改变专业含义。', 'Standardize terminology using the surrounding document without changing technical meaning.')
  ] : []
  return (
    <div className="relative">
      <button type="button" disabled={disabled || busy} aria-expanded={open} className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-[12px] text-ds-muted hover:bg-ds-hover disabled:opacity-40" onClick={() => setOpen((value) => !value)}><Sparkles className="h-3.5 w-3.5" />{busy ? label('生成中…', 'Generating…') : label('AI 写作', 'AI writing')}</button>
      {open ? <div className="absolute right-0 top-full z-40 mt-1 w-64 rounded-xl border border-ds-border bg-ds-card p-1.5 shadow-xl">
        {actions.map((prompt, index) => <button key={prompt} type="button" className="block w-full rounded-lg px-3 py-2 text-left text-[12px] text-ds-ink hover:bg-ds-hover" onClick={() => { onEdit(prompt); setOpen(false) }}>{[label('改写选区', 'Rewrite selection'), label('压缩', 'Shorten'), label('扩写', 'Expand'), label('正式报告风格', 'Formal report style'), label('统一术语', 'Standardize terms')][index]}</button>)}
        {[
          [label('生成提纲', 'Generate outline'), label('根据当前文档在末尾追加一个结构清晰的提纲，只返回要追加的 Markdown，不重写现有正文。', 'Append a structured outline based on the current document. Return only the Markdown to append.')],
          [label('续写章节', 'Continue a section'), label('根据当前文档继续撰写下一个章节，不编造数据。只返回要追加的 Markdown。', 'Continue the next section based on the current document, without inventing facts. Return only Markdown to append.')],
          [label('生成摘要', 'Generate summary'), label('根据当前文档在末尾追加摘要，只返回摘要 Markdown，不重写现有正文。', 'Append a summary of the current document. Return only the summary Markdown.')]
        ].map(([name, prompt]) => <button key={name} type="button" className="block w-full rounded-lg px-3 py-2 text-left text-[12px] text-ds-ink hover:bg-ds-hover" onClick={() => { onEdit(prompt, 'append'); setOpen(false) }}>{name}</button>)}
        <div className="mt-1 border-t border-ds-border-muted px-2 pt-2">
          <input value={sourceQuery} onChange={(event) => setSourceQuery(event.target.value)} aria-label={label('资料关键词', 'Source keywords')} placeholder={label('输入资料关键词', 'Search source keywords')} className="w-full rounded-lg border border-ds-border bg-ds-panel px-2 py-1.5 text-[12px] text-ds-ink outline-none focus:border-accent" />
          <button type="button" disabled={!sourceQuery.trim()} className="mt-1 block w-full rounded-lg px-1 py-2 text-left text-[12px] text-accent hover:bg-ds-hover disabled:opacity-40" onClick={() => { onAskSources(sourceQuery); setOpen(false) }}>{label('根据工作区资料撰写（附来源）', 'Write from workspace sources')}</button>
        </div>
      </div> : null}
    </div>
  )
}
