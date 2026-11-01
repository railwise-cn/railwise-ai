import { useMemo, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { formatSvgColor, type DesignElement } from '@shared/design-document'
import { useDesignWorkspaceStore } from '../../design/design-workspace-store'

/**
 * 属性面板：编辑选中元素的属性。
 *
 * 显示在画布右侧。无选中时显示提示。
 * 单选时显示完整属性编辑；多选时只显示可批量编辑的属性（位置/颜色/不透明度）。
 *
 * 属性编辑直接调 store.updateSelectedElements，实时反映到画布。
 */
export function DesignPropertiesPanel(): ReactElement {
  const { t } = useTranslation('common')
  const selectedElementIds = useDesignWorkspaceStore((s) => s.selectedElementIds)
  const activePage = useDesignWorkspaceStore((s) => s.getActivePage())
  const updateSelectedElements = useDesignWorkspaceStore((s) => s.updateSelectedElements)
  const selectedElements = useMemo(
    () =>
      selectedElementIds
        .map((id) => activePage?.elements.find((element) => element.id === id))
        .filter((element): element is DesignElement => Boolean(element)),
    [activePage, selectedElementIds]
  )

  if (selectedElements.length === 0) {
    return (
      <div className="flex h-full min-w-0 flex-col">
        <PanelHeader title={t('designProperties')} />
        <div className="flex flex-1 items-center justify-center p-4 text-center text-[12px] text-ds-faint">
          {t('designPropertiesEmpty')}
        </div>
      </div>
    )
  }

  const isSingle = selectedElements.length === 1
  const first = selectedElements[0]
  const hasLockedSelection = selectedElements.some((element) => element.locked)

  // 多选时取首个元素的值作为显示（混合值时不显示具体数字）
  const sharedX = allSame(selectedElements, 'x') ? first.x : null
  const sharedY = allSame(selectedElements, 'y') ? first.y : null
  const sharedW = allSame(selectedElements, 'w') ? first.w : null
  const sharedH = allSame(selectedElements, 'h') ? first.h : null
  const sharedFill = allSame(selectedElements, 'fill') ? first.fill : null
  const sharedOpacity = allSame(selectedElements, 'opacity') ? first.opacity : null

  return (
    <div className="flex h-full min-w-0 flex-col">
      <PanelHeader title={t('designProperties')} />
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {/* 选中数量提示 */}
        {!isSingle ? (
          <div className="mb-3 rounded-lg bg-accent/8 px-3 py-2 text-[11.5px] text-accent">
            {t('designSelectedCount', { count: selectedElements.length })}
          </div>
        ) : null}
        {hasLockedSelection ? (
          <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11.5px] text-amber-800">
            {t('designLockedSelectionNotice')}
          </div>
        ) : null}

        {/* 位置和尺寸 */}
        <Section title={t('designGeometry')}>
          <div className="grid grid-cols-2 gap-2">
            <NumberField
              label="X"
              value={sharedX}
              disabled={hasLockedSelection}
              onChange={(v) => updateSelectedElements({ x: v })}
            />
            <NumberField
              label="Y"
              value={sharedY}
              disabled={hasLockedSelection}
              onChange={(v) => updateSelectedElements({ y: v })}
            />
            <NumberField
              label={t('designWidth')}
              value={sharedW}
              disabled={hasLockedSelection}
              onChange={(v) => updateSelectedElements({ w: Math.max(1, v) })}
            />
            <NumberField
              label={t('designHeight')}
              value={sharedH}
              disabled={hasLockedSelection}
              onChange={(v) => updateSelectedElements({ h: Math.max(1, v) })}
            />
          </div>
        </Section>

        {/* 填充色 */}
        <Section title={t('designFill')}>
          <ColorField
            value={sharedFill ?? undefined}
            disabled={hasLockedSelection}
            onChange={(v) => updateSelectedElements({ fill: v })}
          />
        </Section>

        {/* 不透明度 */}
        <Section title={t('designOpacity')}>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={sharedOpacity ?? 1}
            disabled={hasLockedSelection}
            onChange={(e) => updateSelectedElements({ opacity: Number(e.target.value) })}
            className="w-full"
          />
          <div className="mt-1 text-[11px] text-ds-faint">
            {Math.round((sharedOpacity ?? 1) * 100)}%
          </div>
        </Section>

        {/* 单选时的类型特有属性 */}
        {isSingle && first ? <TypeSpecificProps element={first} onUpdate={updateSelectedElements} disabled={first.locked === true} /> : null}
      </div>
    </div>
  )
}

/** 单选时显示的类型特有属性（text 的文字内容/字号、path 的路径数据等） */
function TypeSpecificProps({
  element,
  onUpdate,
  disabled = false
}: {
  element: DesignElement
  onUpdate: (patch: Partial<DesignElement>) => void
  disabled?: boolean
}): ReactElement | null {
  const { t } = useTranslation('common')

  if (element.type === 'text') {
    return (
      <Section title={t('designText')}>
        <textarea
          value={element.text ?? ''}
          onChange={(e) => onUpdate({ text: e.target.value })}
          className="w-full resize-none rounded-lg border border-ds-border bg-ds-card px-2.5 py-1.5 text-[12.5px] text-ds-ink outline-none focus:border-accent"
          rows={3}
          placeholder={t('designTextContent')}
          readOnly={disabled}
        />
        <div className="mt-2 grid grid-cols-2 gap-2">
          <NumberField
            label={t('designFontSize')}
            value={element.fontSize ?? 24}
            disabled={disabled}
            onChange={(v) => onUpdate({ fontSize: Math.max(1, v) })}
          />
          <SelectField
            label={t('designTextAlign')}
            value={element.textAlign ?? 'left'}
            disabled={disabled}
            onChange={(v) => onUpdate({ textAlign: v as DesignElement['textAlign'] })}
            options={[
              { value: 'left', label: t('designAlignLeft') },
              { value: 'center', label: t('designAlignCenter') },
              { value: 'right', label: t('designAlignRight') }
            ]}
          />
        </div>
      </Section>
    )
  }

  if (element.type === 'path') {
    return (
      <Section title={t('designPathData')}>
        <textarea
          value={element.pathData ?? ''}
          onChange={(e) => onUpdate({ pathData: e.target.value })}
          className="w-full resize-none rounded-lg border border-ds-border bg-ds-card px-2.5 py-1.5 font-mono text-[11px] text-ds-ink outline-none focus:border-accent"
          rows={3}
          readOnly={disabled}
        />
      </Section>
    )
  }

  if (element.type === 'rect' || element.type === 'ellipse' || element.type === 'line') {
    return (
      <Section title={t('designStroke')}>
        <div className="grid grid-cols-2 gap-2">
          <ColorField
            label={t('designStrokeColor')}
            value={element.stroke}
            disabled={disabled}
            onChange={(v) => onUpdate({ stroke: v })}
          />
          <NumberField
            label={t('designStrokeWidth')}
            value={element.strokeWidth ?? 0}
            disabled={disabled}
            onChange={(v) => onUpdate({ strokeWidth: Math.max(0, v) })}
          />
        </div>
      </Section>
    )
  }

  return null
}

// --- 内部 UI 组件 ---

function PanelHeader({ title }: { title: string }): ReactElement {
  return (
    <div className="shrink-0 border-b border-ds-border-muted px-3 py-2.5 text-[12.5px] font-semibold text-ds-ink">
      {title}
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactElement | ReactElement[] }): ReactElement {
  return (
    <div className="mb-4">
      <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-ds-faint">{title}</div>
      {children}
    </div>
  )
}

function NumberField({
  label,
  value,
  onChange,
  disabled
}: {
  label: string
  value: number | null
  onChange: (v: number) => void
  disabled?: boolean
}): ReactElement {
  return (
    <div>
      <label className="mb-0.5 block text-[10.5px] text-ds-faint">{label}</label>
      <input
        type="number"
        value={value ?? ''}
        disabled={disabled}
        onChange={(e) => {
          const v = Number(e.target.value)
          if (Number.isFinite(v)) onChange(Math.round(v))
        }}
        className="w-full rounded-lg border border-ds-border bg-ds-card px-2 py-1 text-[12px] text-ds-ink outline-none focus:border-accent"
      />
    </div>
  )
}

function ColorField({
  label,
  value,
  onChange,
  disabled
}: {
  label?: string
  value: string | undefined
  onChange: (v: string) => void
  disabled?: boolean
}): ReactElement {
  return (
    <div>
      {label ? <label className="mb-0.5 block text-[10.5px] text-ds-faint">{label}</label> : null}
      <div className="flex items-center gap-1.5">
        <input
          type="color"
          value={formatSvgColor(value) ?? '#000000'}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value.replace('#', '').toUpperCase())}
          className="h-8 w-8 shrink-0 cursor-pointer rounded border border-ds-border bg-transparent"
        />
        <input
          type="text"
          value={value ?? ''}
          disabled={disabled}
          onChange={(e) => {
            const val = e.target.value.replace(/[^0-9A-Fa-f]/g, '').toUpperCase().slice(0, 6)
            onChange(val)
          }}
          className="min-w-0 flex-1 rounded-lg border border-ds-border bg-ds-card px-2 py-1 font-mono text-[11px] text-ds-ink outline-none focus:border-accent"
          placeholder="000000"
        />
      </div>
    </div>
  )
}

function SelectField({
  label,
  value,
  onChange,
  options,
  disabled
}: {
  label: string
  value: string
  onChange: (v: string) => void
  options: Array<{ value: string; label: string }>
  disabled?: boolean
}): ReactElement {
  return (
    <div>
      <label className="mb-0.5 block text-[10.5px] text-ds-faint">{label}</label>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-ds-border bg-ds-card px-2 py-1 text-[12px] text-ds-ink outline-none focus:border-accent"
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
    </div>
  )
}

/** 检查所有选中元素的某字段是否相同（用于多选时决定显示具体值还是空） */
function allSame<K extends keyof DesignElement>(
  elements: DesignElement[],
  key: K
): boolean {
  if (elements.length === 0) return false
  const first = elements[0][key]
  return elements.every((e) => e[key] === first)
}
