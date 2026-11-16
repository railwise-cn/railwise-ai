import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactElement
} from 'react'
import { Brain, Check, ChevronDown, ChevronRight, Gauge } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ModelProviderModelGroup } from '@shared/workwise-api'
import { AnchoredMenu } from '../ui/AnchoredMenu'
import {
  isVisibleComposerModelId,
  isVisibleComposerModelIdForProvider,
  normalizeComposerModelForProvider
} from '@shared/default-composer-models'

export type ComposerReasoningEffort = 'low' | 'medium' | 'high' | 'max'

type Props = {
  compact: boolean
  mode: 'select' | 'combobox'
  composerModel: string
  composerProviderId?: string
  composerPickList: string[]
  composerModelGroups?: ModelProviderModelGroup[]
  canChangeModel: boolean
  stretch?: boolean
  composerReasoningEffort?: string
  onComposerModelChange: (modelId: string, providerId?: string) => void
  onComposerReasoningEffortChange?: (effort: ComposerReasoningEffort) => void
}

const REASONING_OPTIONS: Array<{ id: ComposerReasoningEffort; labelKey: string }> = [
  { id: 'low', labelKey: 'composerReasoningLow' },
  { id: 'medium', labelKey: 'composerReasoningMedium' },
  { id: 'high', labelKey: 'composerReasoningHigh' },
  { id: 'max', labelKey: 'composerReasoningMax' }
]

type ComposerModelMenuGroup = {
  providerId: string
  label: string
  modelIds: string[]
}

const UNGROUPED_MODEL_PROVIDER_ID = '__composer_models__'

function isVisibleForProviderGroups(
  modelId: string,
  groups: readonly ModelProviderModelGroup[]
): boolean {
  return groups.some((group) => group.modelIds.includes(modelId) && isVisibleComposerModelIdForProvider(modelId, group.providerId)) ||
    isVisibleComposerModelId(modelId)
}

export function FloatingComposerModelPicker({
  compact,
  mode,
  composerModel,
  composerProviderId,
  composerPickList,
  composerModelGroups = [],
  canChangeModel,
  stretch = false,
  composerReasoningEffort = 'max',
  onComposerModelChange,
  onComposerReasoningEffortChange
}: Props): ReactElement {
  const { t } = useTranslation('common')
  const pickerRef = useRef<HTMLButtonElement>(null)
  const menuId = useId()
  const [menuOpen, setMenuOpen] = useState(false)
  const [activeProviderId, setActiveProviderId] = useState<string | null>(null)
  const currentProviderId = composerProviderId
  const currentModel = normalizeComposerModelForProvider(composerModel, currentProviderId)
  const modelOptions = useMemo(() => {
    const ordered = new Set<string>()
    for (const id of composerPickList) {
      const normalized = id.trim()
      if (normalized && isVisibleForProviderGroups(normalized, composerModelGroups)) ordered.add(normalized)
    }
    if (currentModel) ordered.add(currentModel)
    return [...ordered]
  }, [composerModelGroups, composerPickList, currentModel])
  const providerMenuGroups = useMemo<ComposerModelMenuGroup[]>(() => {
    const seen = new Set<string>()
    // Provider groups have already been filtered by the main process using
    // each provider's URL. Never apply official DeepSeek rules to custom groups.
    const sourceGroups = composerModelGroups.map((group) => ({
      ...group,
      modelIds: group.modelIds.filter((id) => isVisibleComposerModelIdForProvider(id, group.providerId))
    }))
    if (currentProviderId && currentModel && currentModel !== 'auto') {
      const group = sourceGroups.find((item) => item.providerId === currentProviderId)
      if (group) group.modelIds.push(currentModel)
      else sourceGroups.push({ providerId: currentProviderId, label: currentProviderId, modelIds: [currentModel] })
    }
    const groups = sourceGroups
      .map((group) => {
        const groupSeen = new Set<string>()
        const ids = group.modelIds
          .map((id) => id.trim())
          .filter((id) => {
            if (!id || groupSeen.has(id)) return false
            groupSeen.add(id)
            seen.add(id)
            return true
          })
        return {
          ...group,
          label: group.label.trim() || group.providerId,
          modelIds: ids
        }
      })
      .filter((group) => group.modelIds.length > 0)
    const ungrouped = modelOptions.filter((id) => id !== 'auto' && !seen.has(id))
    if (ungrouped.length > 0) {
      groups.push({
        providerId: UNGROUPED_MODEL_PROVIDER_ID,
        label: t('composerModel'),
        modelIds: ungrouped
      })
    }
    return groups
  }, [composerModelGroups, currentModel, currentProviderId, modelOptions, t])
  const reasoningEnabled = Boolean(onComposerReasoningEffortChange)
  const currentReasoning = normalizeComposerReasoningEffort(composerReasoningEffort)
  const currentReasoningLabel = t(reasoningLabelKey(currentReasoning))
  const visibleCurrentModel = currentModel
  const providerLabel = composerProviderId ? composerModelGroups.find(group => group.providerId === composerProviderId)?.label || composerProviderId : ''
  const modelLabel = [providerLabel, fullModelLabel(visibleCurrentModel, t('autoLabel'))].filter(Boolean).join(' / ')
  const controlsTitle = reasoningEnabled
    ? `${modelLabel} / ${currentReasoningLabel}`
    : modelLabel
  const selectedProviderId = currentProviderId ?? null
  const comboboxWidthClass = stretch
    ? 'min-w-0 flex-1 max-w-[284px]'
    : compact
      ? 'w-[184px] max-w-[184px] shrink-0'
      : 'w-[248px] max-w-[260px] shrink-0'

  useEffect(() => {
    if (!canChangeModel) setMenuOpen(false)
    if (!menuOpen) setActiveProviderId(null)
  }, [canChangeModel, menuOpen])

  const closeMenu = (): void => {
    setMenuOpen(false)
    pickerRef.current?.focus({ preventScroll: true })
  }
  const renderMenu = (): ReactElement => (
    <AnchoredMenu id={menuId} open={menuOpen && canChangeModel} onOpenChange={setMenuOpen}
      anchorRef={pickerRef} label={t('composerModelControls')} width={300} maxHeight={440} align="end">
      {reasoningEnabled ? (
        <>
          <MenuSectionTitle icon={<Brain className="h-3.5 w-3.5" strokeWidth={1.9} />}>
            {t('composerReasoning')}
          </MenuSectionTitle>
          <div className="grid grid-cols-2 gap-1">
            {REASONING_OPTIONS.map(option => (
              <PickerRow key={option.id} selected={currentReasoning === option.id} title={t(option.labelKey)}
                onClick={() => { onComposerReasoningEffortChange?.(option.id); closeMenu() }} />
            ))}
          </div>
          <MenuSeparator />
        </>
      ) : null}
      <MenuSectionTitle icon={<Gauge className="h-3.5 w-3.5" strokeWidth={1.9} />}>
        {t('composerModel')}
      </MenuSectionTitle>
      <PickerRow selected={!composerModel.trim() || composerModel.trim() === 'auto'} title={t('autoLabel')}
        onClick={() => { onComposerModelChange('auto'); closeMenu() }} />
      {providerMenuGroups.map((group, index) => (
        <div key={group.providerId}>
          <ProviderRow active={activeProviderId === group.providerId} selected={selectedProviderId === group.providerId}
            title={group.label} subtitle={selectedProviderId === group.providerId ? currentModel : ''} controls={`${menuId}-provider-${index}`}
            onClick={() => setActiveProviderId(previous => previous === group.providerId ? null : group.providerId)} />
          {activeProviderId === group.providerId ? (
            <div id={`${menuId}-provider-${index}`} role="group" aria-label={group.label} className="mb-1 ml-2 border-l border-ds-border-muted pl-1.5">
              {group.modelIds.map(model => (
                <PickerRow key={model} selected={currentModel === model && selectedProviderId === group.providerId}
                  title={model} onClick={() => {
                    onComposerModelChange(model, group.providerId === UNGROUPED_MODEL_PROVIDER_ID ? undefined : group.providerId)
                    closeMenu()
                  }} />
              ))}
            </div>
          ) : null}
        </div>
      ))}
    </AnchoredMenu>
  )

  if (mode === 'combobox') {
    return (
      <div
        className={`ds-composer-model-picker ds-no-drag relative flex h-9 items-center rounded-lg transition ${comboboxWidthClass} ${
          canChangeModel ? 'text-ds-muted hover:bg-ds-hover hover:text-ds-ink' : 'text-ds-faint'
        }`}
        title={controlsTitle}
      >
        <span className="sr-only">{t('composerModel')}</span>
        <button
          ref={pickerRef}
          type="button"
          disabled={!canChangeModel}
          onClick={() => setMenuOpen((open) => !open)}
          title={controlsTitle}
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          aria-controls={menuOpen ? menuId : undefined}
          onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setMenuOpen(true) } }}
          aria-label={t('composerModelControls')}
          className={`flex h-9 min-w-0 flex-1 items-center justify-end gap-1 rounded-lg border border-ds-border-muted bg-ds-card py-2 pl-2.5 pr-1 text-[12.5px] font-medium outline-none transition ${
            canChangeModel
              ? 'text-current focus-visible:ring-2 focus-visible:ring-accent/25'
              : 'cursor-not-allowed text-ds-faint'
          }`}
        >
          <span className="min-w-0 truncate text-right">
            {modelLabel}
          </span>
          {reasoningEnabled ? (
            <span className="shrink-0 text-[12px] font-semibold text-ds-faint">
              {currentReasoningLabel}
            </span>
          ) : null}
          <span className="mr-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-ds-faint">
            <ChevronDown className="h-3.5 w-3.5" strokeWidth={1.8} />
          </span>
        </button>
        {renderMenu()}
      </div>
    )
  }

  return (
    <div
      className={`ds-composer-model-picker ds-no-drag relative h-9 min-w-0 max-w-full shrink items-center rounded-lg transition ${
        canChangeModel ? 'text-ds-muted hover:bg-ds-hover hover:text-ds-ink' : 'text-ds-faint'
      } ${
        compact ? 'max-w-[220px]' : 'max-w-[260px]'
      }`}
    >
      <button
        ref={pickerRef}
        type="button"
        disabled={!canChangeModel}
        onClick={() => setMenuOpen((open) => !open)}
        className={`flex h-9 min-w-0 max-w-full items-center gap-1.5 rounded-lg border border-ds-border-muted bg-ds-card px-2.5 text-[12.5px] font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed ${
          canChangeModel ? 'hover:bg-ds-hover' : ''
        }`}
        aria-expanded={menuOpen}
        aria-haspopup="menu"
        aria-controls={menuOpen ? menuId : undefined}
        onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setMenuOpen(true) } }}
        aria-label={t('composerModelControls')}
        title={t('composerModelControls')}
      >
        <span className="min-w-0 truncate">{modelLabel}</span>
        {reasoningEnabled ? (
          <span className="shrink-0 text-ds-faint">
            {t(reasoningLabelKey(currentReasoning))}
          </span>
        ) : null}
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-ds-faint" strokeWidth={1.8} />
      </button>

      {renderMenu()}
    </div>
  )
}

export function normalizeComposerReasoningEffort(value: string | undefined): ComposerReasoningEffort {
  switch (value?.trim().toLowerCase()) {
    case 'low':
    case 'medium':
    case 'high':
    case 'max':
      return value.trim().toLowerCase() as ComposerReasoningEffort
    default:
      return 'max'
  }
}

export function composerReasoningEffortRequestValue(
  value: ComposerReasoningEffort
): string | undefined {
  if (value === 'low') return 'off'
  return value
}

function reasoningLabelKey(value: ComposerReasoningEffort): string {
  return REASONING_OPTIONS.find((option) => option.id === value)?.labelKey ?? 'composerReasoningMax'
}

function fullModelLabel(model: string, autoLabel: string): string {
  const trimmed = model.trim()
  if (!trimmed || trimmed.toLowerCase() === 'auto') return autoLabel
  return trimmed
}

function MenuSectionTitle({
  children,
  icon
}: {
  children: string
  icon: ReactElement
}): ReactElement {
  return (
    <div className="flex h-8 items-center gap-2 px-2 text-[12px] font-bold uppercase tracking-[0.08em] text-ds-faint">
      {icon}
      <span>{children}</span>
    </div>
  )
}

function MenuSeparator(): ReactElement {
  return <div className="my-2 h-px bg-ds-border-muted" />
}

function PickerRow({
  selected,
  title,
  onClick
}: {
  selected: boolean
  title: string
  onClick: () => void
}): ReactElement {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      onClick={onClick}
      className={`flex min-h-9 w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition ${
        selected
          ? 'bg-ds-hover text-ds-ink'
          : 'text-ds-muted hover:bg-ds-hover hover:text-ds-ink'
      }`}
    >
      <span className="min-w-0 flex-1">
        <span className="block break-words text-[13px] font-semibold">{title}</span>
      </span>
      {selected ? <Check className="h-4 w-4 shrink-0 text-accent" strokeWidth={2} /> : null}
    </button>
  )
}

function ProviderRow({
  active,
  selected,
  title,
  subtitle,
  controls,
  onClick
}: {
  active: boolean
  selected: boolean
  title: string
  subtitle: string
  controls: string
  onClick: () => void
}): ReactElement {
  return (
    <button
      type="button"
      role="menuitem"
      aria-expanded={active}
      aria-controls={active ? controls : undefined}
      onClick={onClick}
      className={`flex min-h-9 w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition ${
        active
          ? 'bg-ds-hover text-ds-ink'
          : selected
            ? 'text-ds-ink hover:bg-ds-hover'
            : 'text-ds-muted hover:bg-ds-hover hover:text-ds-ink'
      }`}
    >
      <span className="min-w-0 flex-1">
        <span className="block break-words text-[13px] font-semibold">{title}</span>
        {subtitle ? (
          <span className="block break-words text-[11.5px] font-medium text-ds-faint">{subtitle}</span>
        ) : null}
      </span>
      <ChevronRight className={`h-4 w-4 shrink-0 text-ds-faint transition-transform ${active ? 'rotate-90' : ''}`} strokeWidth={1.8} />
    </button>
  )
}
