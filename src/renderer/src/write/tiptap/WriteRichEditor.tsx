import { useEffect, useRef, useState, type MutableRefObject, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { resolveWriteMarkdownResourcePath } from '@shared/write-markdown-resource'
import type { WriteRecentEdit } from '../recent-edits'
import type { WriteEditorSelectionState } from '../../components/write/WriteMarkdownEditor'
import { WriteMarkdownPreview } from '../../components/write/WriteMarkdownPreview'
import { useWriteDialogFocus } from '../../components/write/use-write-dialog-focus'
import { hydrateWriteAdvancedDiagrams } from '../write-advanced-rendering'
import {
  rebaseWriteRichProjection,
  renderWriteRichMarkdown,
  richSelectionSourceRange,
  serializeWriteRichHtml
} from './write-rich-projection'

export { renderWriteRichMarkdown, serializeWriteRichHtml } from './write-rich-projection'

export type WriteRichEditorHandle = {
  getProjectionText: () => string
  applyProjectedReplacement: (
    range: { from: number; to: number },
    expected: string,
    replacement: string,
    label?: string
  ) => boolean
}

type Props = {
  value: string
  onChange: (value: string) => void
  onDocumentEdit?: (edits: WriteRecentEdit[]) => void
  onSelectionChange?: (selection: WriteEditorSelectionState) => void
  onSaveShortcut?: () => void
  readOnly?: boolean
  filePath?: string | null
  workspaceRoot?: string
  handleRef?: MutableRefObject<WriteRichEditorHandle | null>
  fallback?: ReactElement
  [key: string]: unknown
}

function lineColumn(source: string, offset: number): { line: number; column: number } {
  const before = source.slice(0, offset)
  return { line: before.split('\n').length, column: offset - (before.lastIndexOf('\n') + 1) + 1 }
}

function emitSelection(root: HTMLElement, source: string, callback?: Props['onSelectionChange']): void {
  if (!callback) return
  const selection = window.getSelection()
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null
  const mapped = range && !range.collapsed ? richSelectionSourceRange(root, range) : null
  if (!mapped || mapped.to <= mapped.from) {
    callback({ text: '', ranges: [], charCount: 0 })
    return
  }
  // Selection ranges use source coordinates. No text search, including when the
  // same words occur multiple times or markup changes the visible text length.
  const text = source.slice(mapped.from, mapped.to)
  const start = lineColumn(source, mapped.from)
  const end = lineColumn(source, Math.max(mapped.from, mapped.to - 1))
  callback({
    text,
    charCount: text.length,
    ranges: [{ ...mapped, startLine: start.line, startColumn: start.column, endLine: end.line, endColumn: end.column, text, charCount: text.length }]
  })
}

function makeEdit(previous: string, next: string, filePath?: string | null): WriteRecentEdit | null {
  if (!filePath || previous === next) return null
  let from = 0
  while (from < previous.length && from < next.length && previous[from] === next[from]) from += 1
  let oldEnd = previous.length
  let newEnd = next.length
  while (oldEnd > from && newEnd > from && previous[oldEnd - 1] === next[newEnd - 1]) { oldEnd -= 1; newEnd -= 1 }
  return {
    id: `rich-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    source: 'user', timestamp: Date.now(), filePath, from, to: oldEnd,
    deletedText: previous.slice(from, oldEnd), insertedText: next.slice(from, newEnd),
    beforeContext: previous.slice(Math.max(0, from - 160), from),
    afterContext: next.slice(newEnd, Math.min(next.length, newEnd + 160))
  }
}

function editableSelectionBlock(root: HTMLElement): HTMLElement | null {
  const selection = window.getSelection()
  if (!selection?.rangeCount) return null
  const range = selection.getRangeAt(0)
  const blockFor = (node: Node): HTMLElement | null => (node.nodeType === Node.ELEMENT_NODE ? node as HTMLElement : node.parentElement)?.closest('[data-write-rich-block]') as HTMLElement | null
  const start = blockFor(range.startContainer)
  const end = blockFor(range.endContainer)
  return start && start === end && root.contains(start) && start.dataset.writeReadonly !== 'true' ? start : null
}

/** Resources enter the DOM only as workspace-authorized raster data, never URLs. */
export async function hydrateWriteRichImages(root: HTMLElement, filePath?: string | null, workspaceRoot?: string): Promise<void> {
  if (!workspaceRoot || typeof window.workwise?.readWorkspaceImage !== 'function') return
  await Promise.all(Array.from(root.querySelectorAll<HTMLElement>('[data-write-image]')).map(async (placeholder) => {
    let raw: string
    try { raw = decodeURIComponent(placeholder.dataset.writeImage ?? '') } catch { return }
    if (/^(?:[a-zA-Z][a-zA-Z0-9+.-]*:|[/\\]{2})/.test(raw.trim())) return
    const localPath = resolveWriteMarkdownResourcePath(raw, filePath)
    if (!localPath) return
    const normalizedRoot = workspaceRoot.replaceAll('\\', '/').replace(/\/$/, '')
    if (localPath !== normalizedRoot && !localPath.startsWith(`${normalizedRoot}/`)) return
    try {
      const result = await window.workwise.readWorkspaceImage({ path: localPath, workspaceRoot })
      if (!result.ok || !/^data:image\/(?:png|jpeg|gif|webp|bmp|avif);base64,[a-zA-Z0-9+/=\s]+$/.test(result.dataUrl) || !root.contains(placeholder)) return
      const image = document.createElement('img')
      image.dataset.writeLocalImage = 'true'
      try { image.alt = decodeURIComponent(placeholder.dataset.writeAlt ?? '') } catch { image.alt = '' }
      image.src = result.dataUrl
      placeholder.append(image)
    } catch { /* The inert alt placeholder remains available when an image cannot load. */ }
  }))
}

function installProjection(root: HTMLElement, source: string, readOnly: boolean, filePath?: string | null, workspaceRoot?: string, chinese = true): void {
  root.innerHTML = renderWriteRichMarkdown(source)
  if (readOnly) for (const block of root.querySelectorAll<HTMLElement>('[data-write-rich-block]')) { block.contentEditable = 'false'; block.removeAttribute('tabindex') }
  void hydrateWriteRichImages(root, filePath, workspaceRoot)
  void hydrateWriteAdvancedDiagrams(root)
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-write-edit-advanced]')) {
    button.disabled = readOnly
    button.textContent = chinese ? '编辑源码' : 'Edit source'
    button.setAttribute('aria-label', chinese ? '编辑公式、脚注或图表源码' : 'Edit formula, footnote or diagram source')
  }
}

function insertPlainText(root: HTMLElement, text: string): boolean {
  if (!editableSelectionBlock(root)) return false
  // insertText preserves the browser undo stack without accepting pasted HTML.
  if (typeof document.execCommand === 'function' && document.execCommand('insertText', false, text)) return true
  const selection = window.getSelection()
  if (!selection?.rangeCount) return false
  const range = selection.getRangeAt(0)
  range.deleteContents()
  const node = document.createTextNode(text)
  range.insertNode(node)
  range.setStartAfter(node)
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)
  return true
}

export function WriteRichEditor({ value, onChange, onDocumentEdit, onSelectionChange, onSaveShortcut, readOnly = false, filePath, workspaceRoot, handleRef }: Props): ReactElement {
  const { i18n } = useTranslation()
  const chinese = i18n.resolvedLanguage?.startsWith('zh') ?? true
  const rootRef = useRef<HTMLDivElement | null>(null)
  const valueRef = useRef(value)
  const onChangeRef = useRef(onChange)
  const editRef = useRef(onDocumentEdit)
  const selectionRef = useRef(onSelectionChange)
  const saveRef = useRef(onSaveShortcut)
  const inputRef = useRef<() => void>(() => undefined)
  const [advancedEdit, setAdvancedEdit] = useState<{ from: number; expected: string; value: string; baseline: string; path?: string | null } | null>(null)
  const [advancedError, setAdvancedError] = useState('')
  useWriteDialogFocus(Boolean(advancedEdit), 'write-advanced-syntax-title', () => setAdvancedEdit(null))
  onChangeRef.current = onChange
  editRef.current = onDocumentEdit
  selectionRef.current = onSelectionChange
  saveRef.current = onSaveShortcut

  useEffect(() => {
    const root = rootRef.current
    valueRef.current = value
    if (!root || serializeWriteRichHtml(root) === value) return
    installProjection(root, value, readOnly, filePath, workspaceRoot, chinese)
  }, [value, readOnly, filePath, workspaceRoot, chinese])

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    installProjection(root, valueRef.current, readOnly, filePath, workspaceRoot, chinese)
    const onInput = (): void => {
      if (readOnly) return
      const previous = valueRef.current
      const next = serializeWriteRichHtml(root)
      rebaseWriteRichProjection(root)
      valueRef.current = next
      if (previous !== next) {
        onChangeRef.current(next)
        const edit = makeEdit(previous, next, filePath)
        if (edit) editRef.current?.([edit])
      }
      emitSelection(root, next, selectionRef.current)
    }
    inputRef.current = onInput
    const onSelect = (): void => emitSelection(root, valueRef.current, selectionRef.current)
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); saveRef.current?.() }
    }
    const onBeforeInput = (event: InputEvent): void => {
      if (readOnly || !editableSelectionBlock(root) || event.inputType === 'insertFromDrop') event.preventDefault()
    }
    const onPaste = (event: ClipboardEvent): void => {
      event.preventDefault()
      if (readOnly) return
      const plain = event.clipboardData?.getData('text/plain') ?? ''
      if (plain && insertPlainText(root, plain)) onInput()
    }
    const onDrop = (event: DragEvent): void => event.preventDefault()
    const onClick = (event: MouseEvent): void => {
      const target = event.target as HTMLElement | null
      const edit = target?.closest<HTMLButtonElement>('[data-write-edit-advanced]')
      if (edit && !readOnly) {
        event.preventDefault()
        const block = edit.closest<HTMLElement>('[data-write-rich-block]')
        if (!block) return
        try {
          const expected = decodeURIComponent(block.dataset.writeSource ?? '')
          const from = Number(block.dataset.writeOffset)
          if (!Number.isSafeInteger(from) || valueRef.current.slice(from, from + expected.length) !== expected) return
          setAdvancedError('')
          setAdvancedEdit({ from, expected, value: expected, baseline: valueRef.current, path: filePath })
        } catch { /* Invalid projection metadata cannot become a document write. */ }
        return
      }
      const link = target?.closest<HTMLAnchorElement>('a')
      if (link) {
        event.preventDefault()
        const href = link.getAttribute('href') ?? ''
        if (href.startsWith('#')) { try { root.querySelector(`[id="${CSS.escape(decodeURIComponent(href.slice(1)))}"]`)?.scrollIntoView() } catch { /* Invalid fragments do not navigate. */ } }
      }
      if (target?.matches('input[data-write-task]')) {
        if (readOnly) event.preventDefault()
        else onInput()
      }
    }
    root.addEventListener('input', onInput)
    root.addEventListener('beforeinput', onBeforeInput)
    root.addEventListener('mouseup', onSelect)
    root.addEventListener('keyup', onSelect)
    root.addEventListener('keydown', onKeyDown)
    root.addEventListener('paste', onPaste)
    root.addEventListener('drop', onDrop)
    root.addEventListener('click', onClick)
    document.addEventListener('selectionchange', onSelect)
    return () => {
      root.removeEventListener('input', onInput)
      root.removeEventListener('beforeinput', onBeforeInput)
      root.removeEventListener('mouseup', onSelect)
      root.removeEventListener('keyup', onSelect)
      root.removeEventListener('keydown', onKeyDown)
      root.removeEventListener('paste', onPaste)
      root.removeEventListener('drop', onDrop)
      root.removeEventListener('click', onClick)
      document.removeEventListener('selectionchange', onSelect)
    }
  }, [filePath, readOnly, workspaceRoot, chinese])

  useEffect(() => {
    if (!handleRef) return
    handleRef.current = {
      getProjectionText: () => valueRef.current,
      applyProjectedReplacement: (range, expected, replacement) => {
        if (readOnly || !Number.isSafeInteger(range.from) || !Number.isSafeInteger(range.to)) return false
        const source = valueRef.current
        if (range.from < 0 || range.to < range.from || range.to > source.length || source.slice(range.from, range.to) !== expected) return false
        const next = `${source.slice(0, range.from)}${replacement}${source.slice(range.to)}`
        valueRef.current = next
        onChangeRef.current(next)
        const edit = makeEdit(source, next, filePath)
        if (edit) editRef.current?.([edit])
        if (rootRef.current) installProjection(rootRef.current, next, readOnly, filePath, workspaceRoot, chinese)
        return true
      }
    }
    return () => { handleRef.current = null }
  }, [filePath, handleRef, readOnly, workspaceRoot, chinese])

  const buttons: Array<[string, string, string, string?]> = [
    ['bold', 'B', chinese ? '粗体' : 'Bold'], ['italic', 'I', chinese ? '斜体' : 'Italic'], ['formatBlock', 'H', chinese ? '标题' : 'Heading', 'h2'],
    ['insertUnorderedList', '•', chinese ? '无序列表' : 'Bulleted list'], ['insertOrderedList', '1.', chinese ? '有序列表' : 'Numbered list'], ['formatBlock', '❝', chinese ? '引用' : 'Quote', 'blockquote']
  ]
  return (
    <div className="write-rich-editor flex h-full min-h-0 flex-col">
      <div className="write-rich-editor-toolbar flex shrink-0 items-center gap-1 border-b border-ds-border-muted px-3 py-2" role="toolbar" aria-label={chinese ? 'Markdown 格式' : 'Markdown formatting'}>
        {buttons.map(([name, label, title, valueArg]) => (
          <button key={`${name}-${title}`} type="button" disabled={readOnly} className="rounded-md px-2 py-1 text-xs text-ds-muted hover:bg-ds-hover hover:text-ds-ink disabled:opacity-40" title={title} aria-label={title} onMouseDown={(event) => event.preventDefault()} onClick={() => {
            const root = rootRef.current
            if (!readOnly && root && editableSelectionBlock(root) && typeof document.execCommand === 'function') {
              document.execCommand(name, false, valueArg)
              inputRef.current()
            }
          }}>{label}</button>
        ))}
      </div>
      <div ref={rootRef} className="write-rich-editor-surface ds-markdown min-h-0 flex-1 overflow-auto px-6 py-10 text-[16px] leading-7 outline-none" contentEditable={false} suppressContentEditableWarning role="textbox" aria-label={chinese ? 'Markdown 可视化编辑器' : 'Markdown visual editor'} aria-multiline="true" aria-readonly={readOnly} data-write-editor-mode="rich" spellCheck={!readOnly} />
      {advancedEdit ? createPortal(<div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) setAdvancedEdit(null) }}>
        <section role="dialog" aria-modal="true" aria-labelledby="write-advanced-syntax-title" className="flex max-h-[90vh] w-full max-w-5xl flex-col rounded-2xl border border-ds-border bg-ds-card p-5 text-ds-ink shadow-2xl">
          <h2 id="write-advanced-syntax-title" className="mb-3 text-lg font-semibold">{chinese ? '编辑公式、脚注与图表' : 'Edit formulas, footnotes and diagrams'}</h2>
          <div className="grid min-h-0 flex-1 gap-4 overflow-auto md:grid-cols-2">
            <label className="flex min-h-0 flex-col gap-2 text-sm">{chinese ? 'Markdown 源码' : 'Markdown source'}<textarea aria-label={chinese ? '公式、脚注或图表源码' : 'Formula, footnote or diagram source'} className="min-h-64 w-full flex-1 resize-y rounded-lg border border-ds-border bg-ds-panel p-3 font-mono text-sm outline-none focus:border-accent" value={advancedEdit.value} onChange={(event) => setAdvancedEdit({ ...advancedEdit, value: event.target.value })} /></label>
            <div className="min-h-64 overflow-auto rounded-lg border border-ds-border bg-ds-panel p-3" aria-label={chinese ? '实时预览' : 'Live preview'}><WriteMarkdownPreview content={advancedEdit.baseline.slice(0, advancedEdit.from) + advancedEdit.value + advancedEdit.baseline.slice(advancedEdit.from + advancedEdit.expected.length)} isMarkdown filePath={advancedEdit.path} workspaceRoot={workspaceRoot} /></div>
          </div>
          {advancedError ? <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-300">{advancedError}</p> : null}
          <div className="mt-4 flex justify-end gap-2"><button type="button" className="rounded-lg border border-ds-border px-4 py-2 text-sm" onClick={() => setAdvancedEdit(null)}>{chinese ? '取消' : 'Cancel'}</button><button type="button" className="rounded-lg bg-accent px-4 py-2 text-sm text-white" disabled={readOnly} onClick={() => {
            const source = valueRef.current
            if (filePath !== advancedEdit.path || source !== advancedEdit.baseline || source.slice(advancedEdit.from, advancedEdit.from + advancedEdit.expected.length) !== advancedEdit.expected) { setAdvancedError(chinese ? '原文或活动文档已变化，请关闭后重新打开。' : 'The source or active document changed. Close and reopen this editor.'); return }
            const next = source.slice(0, advancedEdit.from) + advancedEdit.value + source.slice(advancedEdit.from + advancedEdit.expected.length)
            valueRef.current = next
            onChangeRef.current(next)
            const edit = makeEdit(source, next, filePath)
            if (edit) editRef.current?.([edit])
            if (rootRef.current) installProjection(rootRef.current, next, readOnly, filePath, workspaceRoot, chinese)
            setAdvancedEdit(null)
          }}>{chinese ? '应用修改' : 'Apply changes'}</button></div>
        </section>
      </div>, document.body) : null}
    </div>
  )
}
