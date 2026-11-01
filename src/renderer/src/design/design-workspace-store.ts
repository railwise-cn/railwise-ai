import { create } from 'zustand'
import {
  collectDesignDescendantIds,
  createDesignDocument,
  createDesignElement,
  createDesignPage,
  designGroupBounds,
  duplicateDesignPage,
  generateDesignElementId,
  nextZIndex,
  normalizeDesignDocument,
  normalizeDesignElement,
  validateDesignDocumentStructure,
  type DesignAsset,
  type DesignDocumentV1,
  type DesignElement,
  type DesignElementType,
  type DesignPage
} from '@shared/design-document'
import type {
  DesignCanvasCommandAckV1,
  DesignCanvasCommandV1,
  DesignCanvasElementPatch,
  DesignCanvasOperation
} from '@shared/design-workspace'
import {
  beginTransientChange,
  canRedo,
  canUndo,
  commitHistorySnapshot,
  createDesignHistoryState,
  endTransientChange,
  redoHistory,
  undoHistory,
  type DesignHistoryState
} from './design-history'

export type DesignTool = 'select' | DesignElementType
export type DesignSaveState = 'idle' | 'saving' | 'saved' | 'error'

export type DesignWorkspaceState = {
  document: DesignDocumentV1 | null
  activePageId: string | null
  selectedElementIds: string[]
  activeTool: DesignTool
  history: DesignHistoryState
  persistedRevision: number | null
  saveState: DesignSaveState
  saveError: string | null
  assetDataUrls: Record<string, string>
  appliedCommandIds: string[]

  createNewDocument: (options?: {
    name?: string
    format?: DesignDocumentV1['format']
    customSize?: { width: number; height: number }
  }) => void
  closeDocument: () => void
  loadDocument: (
    doc: unknown,
    options?: { activePageId?: string; persistedRevision?: number | null }
  ) => void
  markSaving: () => void
  markSaved: (doc: DesignDocumentV1) => void
  markSaveError: (message: string) => void
  setAssetDataUrl: (assetId: string, dataUrl: string) => void
  addImageAsset: (asset: DesignAsset, dataUrl: string) => void

  setActivePage: (pageId: string) => void
  getActivePage: () => DesignPage | null
  addPage: (options?: {
    format?: DesignDocumentV1['format']
    customSize?: { width: number; height: number }
  }) => void
  removePage: (pageId: string) => void
  renamePage: (pageId: string, name: string) => void
  duplicatePage: (pageId: string) => void
  movePage: (fromIndex: number, toIndex: number) => void
  setPageDisplayMode: (pageId: string, mode: 'editable' | 'fidelity') => void

  addElement: (element: DesignElement) => void
  addDefaultElement: (type: DesignElementType) => void
  updateElement: (elementId: string, patch: Partial<DesignElement>) => void
  updateSelectedElements: (patch: Partial<DesignElement>) => void
  removeElement: (elementId: string) => void
  removeSelectedElements: () => void
  groupSelectedElements: () => void
  ungroupSelectedElements: () => void
  duplicateSelectedElements: () => void
  applyCanvasCommand: (
    command: DesignCanvasCommandV1,
    workspaceRoot: string
  ) => DesignCanvasCommandAckV1

  selectElement: (elementId: string) => void
  addToSelection: (elementId: string) => void
  removeFromSelection: (elementId: string) => void
  clearSelection: () => void
  selectAll: () => void
  setActiveTool: (tool: DesignTool) => void

  undo: () => void
  redo: () => void
  canUndo: () => boolean
  canRedo: () => boolean
  beginTransientChange: () => void
  endTransientChange: () => void
}

function touchDocument(
  document: DesignDocumentV1,
  pages = document.pages,
  assets = document.assets
): DesignDocumentV1 {
  return {
    ...document,
    revision: document.revision + 1,
    pages,
    assets,
    updatedAt: Date.now()
  }
}

function recalculateGroupBounds(elements: DesignElement[]): DesignElement[] {
  let result = elements
  for (let pass = 0; pass < elements.length; pass += 1) {
    let changed = false
    result = result.map((element) => {
      if (element.type !== 'group') return element
      const bounds = designGroupBounds(result, element.childIds ?? [])
      if (
        !bounds ||
        (bounds.x === element.x &&
          bounds.y === element.y &&
          bounds.w === element.w &&
          bounds.h === element.h)
      ) {
        return element
      }
      changed = true
      return { ...element, ...bounds }
    })
    if (!changed) break
  }
  return result
}

function updateElementInPage(
  page: DesignPage,
  elementId: string,
  patch: Partial<DesignElement>
): DesignPage {
  const target = page.elements.find((element) => element.id === elementId)
  if (!target) return page
  let elements = page.elements
  if (target.type === 'group') {
    const descendants = new Set(
      collectDesignDescendantIds(elements, target.childIds ?? []).filter((id) => id !== target.id)
    )
    const nextBounds = {
      x: typeof patch.x === 'number' ? patch.x : target.x,
      y: typeof patch.y === 'number' ? patch.y : target.y,
      w: typeof patch.w === 'number' && patch.w > 0 ? patch.w : target.w,
      h: typeof patch.h === 'number' && patch.h > 0 ? patch.h : target.h
    }
    const scaleX = target.w > 0 ? nextBounds.w / target.w : 1
    const scaleY = target.h > 0 ? nextBounds.h / target.h : 1
    const rotationDelta =
      typeof patch.rotation === 'number' ? patch.rotation - target.rotation : 0
    const rotationRadians = rotationDelta * Math.PI / 180
    const oldCenterX = target.x + target.w / 2
    const oldCenterY = target.y + target.h / 2
    const nextCenterX = nextBounds.x + nextBounds.w / 2
    const nextCenterY = nextBounds.y + nextBounds.h / 2
    elements = elements.map((element) => {
      if (element.id === target.id) return { ...element, ...patch, ...nextBounds }
      if (!descendants.has(element.id) || element.type === 'group') return element
      const scaledCenterX = (element.x + element.w / 2 - oldCenterX) * scaleX
      const scaledCenterY = (element.y + element.h / 2 - oldCenterY) * scaleY
      const rotatedCenterX =
        scaledCenterX * Math.cos(rotationRadians) -
        scaledCenterY * Math.sin(rotationRadians)
      const rotatedCenterY =
        scaledCenterX * Math.sin(rotationRadians) +
        scaledCenterY * Math.cos(rotationRadians)
      const nextWidth = Math.max(1, element.w * scaleX)
      const nextHeight = Math.max(1, element.h * scaleY)
      return {
        ...element,
        x: nextCenterX + rotatedCenterX - nextWidth / 2,
        y: nextCenterY + rotatedCenterY - nextHeight / 2,
        w: nextWidth,
        h: nextHeight,
        rotation: element.rotation + rotationDelta
      }
    })
  } else {
    elements = elements.map((element) =>
      element.id === elementId ? { ...element, ...patch } : element
    )
  }
  return { ...page, elements: recalculateGroupBounds(elements) }
}

function canUpdateElement(page: DesignPage, elementId: string, patch: Partial<DesignElement> | DesignCanvasElementPatch): boolean {
  const target = page.elements.find((element) => element.id === elementId)
  if (!target) return false
  if (!target.locked) return true
  return patch.locked === false && Object.keys(patch).every((key) => key === 'locked')
}

function hasLockedDescendant(page: DesignPage, element: DesignElement): boolean {
  if (element.type !== 'group') return false
  return collectDesignDescendantIds(page.elements, element.childIds ?? [])
    .some((id) => page.elements.find((item) => item.id === id)?.locked)
}

function removeElementsFromPage(page: DesignPage, rootIds: ReadonlyArray<string>): DesignPage {
  const removeIds = new Set(collectDesignDescendantIds(page.elements, rootIds))
  let elements = page.elements
    .filter((element) => !removeIds.has(element.id))
    .map((element) =>
      element.type === 'group'
        ? {
            ...element,
            childIds: (element.childIds ?? []).filter((id) => !removeIds.has(id))
          }
        : element
    )
    .filter((element) => element.type !== 'group' || (element.childIds?.length ?? 0) > 0)
  elements = recalculateGroupBounds(elements)
  return { ...page, elements }
}

function topLevelSelection(elements: DesignElement[], selectedIds: ReadonlyArray<string>): string[] {
  const selected = new Set(selectedIds)
  const parentByChild = new Map<string, string>()
  for (const element of elements) {
    if (element.type !== 'group') continue
    for (const childId of element.childIds ?? []) parentByChild.set(childId, element.id)
  }
  return selectedIds.filter((id) => {
    let parent = parentByChild.get(id)
    while (parent) {
      if (selected.has(parent)) return false
      parent = parentByChild.get(parent)
    }
    return elements.some((element) => element.id === id)
  })
}

function groupElements(
  page: DesignPage,
  elementIds: ReadonlyArray<string>,
  name?: string
): { page: DesignPage; groupId: string | null } {
  const ids = topLevelSelection(page.elements, elementIds)
  if (ids.length < 2) return { page, groupId: null }
  const bounds = designGroupBounds(page.elements, ids)
  if (!bounds) return { page, groupId: null }
  const group = createDesignElement('group', {
    ...bounds,
    childIds: ids,
    name: name?.trim() || 'Group',
    zIndex: nextZIndex(page.elements)
  })
  return {
    page: { ...page, elements: [...page.elements, group] },
    groupId: group.id
  }
}

function ungroupElements(
  page: DesignPage,
  groupIds: ReadonlyArray<string>
): { page: DesignPage; childIds: string[] } {
  const ids = new Set(groupIds)
  const children: string[] = []
  const replacementByGroup = new Map<string, string[]>()
  for (const element of page.elements) {
    if (element.type === 'group' && ids.has(element.id)) {
      replacementByGroup.set(element.id, element.childIds ?? [])
      children.push(...(element.childIds ?? []))
    }
  }
  let elements = page.elements
    .filter((element) => !(element.type === 'group' && ids.has(element.id)))
    .map((element) => {
      if (element.type !== 'group') return element
      const nextChildren = (element.childIds ?? []).flatMap((id) => replacementByGroup.get(id) ?? [id])
      return { ...element, childIds: [...new Set(nextChildren)] }
    })
  elements = recalculateGroupBounds(elements)
  return { page: { ...page, elements }, childIds: [...new Set(children)] }
}

function duplicateSelection(
  page: DesignPage,
  selectedIds: ReadonlyArray<string>
): { page: DesignPage; selectedIds: string[] } {
  const roots = topLevelSelection(page.elements, selectedIds)
  if (roots.length === 0) return { page, selectedIds: [] }
  const sourceIds = collectDesignDescendantIds(page.elements, roots)
  const sourceIdSet = new Set(sourceIds)
  const idMap = new Map(sourceIds.map((id) => [id, generateDesignElementId()]))
  const maxZ = nextZIndex(page.elements)
  const source = page.elements.filter((element) => sourceIdSet.has(element.id))
  const duplicates = source.map((element, index) => ({
    ...structuredClone(element),
    id: idMap.get(element.id)!,
    x: element.x + 20,
    y: element.y + 20,
    zIndex: maxZ + index,
    ...(element.type === 'group'
      ? {
          childIds: (element.childIds ?? [])
            .map((id) => idMap.get(id))
            .filter((id): id is string => Boolean(id))
        }
      : {})
  }))
  const nextPage = {
    ...page,
    elements: recalculateGroupBounds([...page.elements, ...duplicates])
  }
  return {
    page: nextPage,
    selectedIds: roots.map((id) => idMap.get(id)).filter((id): id is string => Boolean(id))
  }
}

function applyCanvasOperations(
  page: DesignPage,
  operations: ReadonlyArray<DesignCanvasOperation>
): { page: DesignPage; selectedIds: string[] } | null {
  let nextPage = structuredClone(page)
  let selectedIds: string[] = []
  for (const operation of operations) {
    if (operation.kind === 'add') {
      const parsed = normalizeDesignElement(operation.element)
      // Agent-created shapes must never be accepted as an apparently
      // successful but completely invisible result. Apply the same visible
      // defaults used by manual toolbar insertion when fill/stroke is omitted.
      const normalized = parsed ? createDesignElement(parsed.type, parsed) : null
      if (
        !normalized ||
        nextPage.elements.some((element) => element.id === normalized.id) ||
        normalized.type === 'image'
      ) {
        return null
      }
      normalized.zIndex = nextZIndex(nextPage.elements)
      nextPage = { ...nextPage, elements: [...nextPage.elements, normalized] }
      selectedIds = [normalized.id]
    } else if (operation.kind === 'update') {
      const target = nextPage.elements.find((element) => element.id === operation.elementId)
      if (!target || !canUpdateElement(nextPage, target.id, operation.patch) || (target.type === 'group' && hasLockedDescendant(nextPage, target))) return null
      const forbidden = ['id', 'type', 'childIds', 'imageAssetId'] as const
      const { fill, stroke, ...remainingPatch } = operation.patch
      const patch: Partial<DesignElement> = {
        ...remainingPatch,
        ...(fill !== undefined ? { fill: fill ?? undefined } : {}),
        ...(stroke !== undefined ? { stroke: stroke ?? undefined } : {})
      }
      for (const field of forbidden) delete patch[field]
      nextPage = updateElementInPage(nextPage, operation.elementId, patch)
      selectedIds = [operation.elementId]
    } else if (operation.kind === 'remove') {
      if (operation.elementIds.some((id) => {
        const element = nextPage.elements.find((item) => item.id === id)
        return element ? Boolean(element.locked || hasLockedDescendant(nextPage, element)) : false
      })) return null
      nextPage = removeElementsFromPage(nextPage, operation.elementIds)
      selectedIds = []
    } else if (operation.kind === 'group') {
      if (operation.elementIds.some((id) => {
        const element = nextPage.elements.find((item) => item.id === id)
        return element ? Boolean(element.locked || hasLockedDescendant(nextPage, element)) : true
      })) return null
      const result = groupElements(nextPage, operation.elementIds, operation.name)
      if (!result.groupId) return null
      nextPage = result.page
      selectedIds = [result.groupId]
    } else {
      if (operation.groupIds.some((id) => {
        const element = nextPage.elements.find((item) => item.id === id)
        return element ? Boolean(element.locked || hasLockedDescendant(nextPage, element)) : true
      })) return null
      const result = ungroupElements(nextPage, operation.groupIds)
      nextPage = result.page
      selectedIds = result.childIds
    }
  }
  return { page: nextPage, selectedIds }
}

export const useDesignWorkspaceStore = create<DesignWorkspaceState>((set, get) => {
  const commitBeforeChange = (): void => {
    const { document, history } = get()
    if (!document) return
    if (history.transientInProgress && history.transientCommitted) return
    set({ history: commitHistorySnapshot(history, document) })
  }

  const updateActivePage = (
    updater: (page: DesignPage) => DesignPage,
    selectedElementIds?: string[]
  ): void => {
    const { document, activePageId } = get()
    if (!document || !activePageId) return
    if (document.pages.find((page) => page.id === activePageId)?.displayMode === 'fidelity') return
    const pages = document.pages.map((page) => page.id === activePageId ? updater(page) : page)
    set({
      document: touchDocument(document, pages),
      ...(selectedElementIds ? { selectedElementIds } : {}),
      saveState: 'idle',
      saveError: null
    })
  }

  return {
    document: null,
    activePageId: null,
    selectedElementIds: [],
    activeTool: 'select',
    history: createDesignHistoryState(),
    persistedRevision: null,
    saveState: 'idle',
    saveError: null,
    assetDataUrls: {},
    appliedCommandIds: [],

    createNewDocument: (options) => {
      const document = createDesignDocument(options)
      set({
        document,
        activePageId: document.pages[0]?.id ?? null,
        selectedElementIds: [],
        activeTool: 'select',
        history: createDesignHistoryState(),
        persistedRevision: null,
        saveState: 'idle',
        saveError: null,
        assetDataUrls: {},
        appliedCommandIds: document.appliedCommands.map((record) => record.idempotencyKey)
      })
    },

    closeDocument: () => set({
      document: null,
      activePageId: null,
      selectedElementIds: [],
      activeTool: 'select',
      history: createDesignHistoryState(),
      persistedRevision: null,
      saveState: 'idle',
      saveError: null,
      assetDataUrls: {},
      appliedCommandIds: []
    }),

    loadDocument: (input, options) => {
      const normalized = normalizeDesignDocument(input as Partial<DesignDocumentV1> | null | undefined)
      const document = normalized ?? createDesignDocument()
      const requestedPage = options?.activePageId
      set({
        document,
        activePageId: document.pages.some((page) => page.id === requestedPage)
          ? requestedPage!
          : document.pages[0]?.id ?? null,
        selectedElementIds: [],
        activeTool: 'select',
        history: createDesignHistoryState(),
        persistedRevision: options?.persistedRevision ?? null,
        saveState: options?.persistedRevision === null ? 'idle' : 'saved',
        saveError: null,
        assetDataUrls: {},
        appliedCommandIds: document.appliedCommands.map((record) => record.idempotencyKey)
      })
    },

    markSaving: () => set({ saveState: 'saving', saveError: null }),
    markSaved: (document) => {
      const current = get().document
      if (!current || current.id !== document.id) return
      const hasNewerLocalChanges = current.revision > document.revision
      set({
        document: hasNewerLocalChanges ? current : { ...current, revision: document.revision },
        persistedRevision: document.revision,
        saveState: hasNewerLocalChanges ? 'idle' : 'saved',
        saveError: null
      })
    },
    markSaveError: (message) => set({ saveState: 'error', saveError: message }),
    setAssetDataUrl: (assetId, dataUrl) => set({
      assetDataUrls: { ...get().assetDataUrls, [assetId]: dataUrl }
    }),
    addImageAsset: (asset, dataUrl) => {
      const { document, activePageId } = get()
      if (!document || !activePageId || document.assets.some((item) => item.id === asset.id)) return
      const page = document.pages.find((item) => item.id === activePageId)
      if (!page) return
      commitBeforeChange()
      const maxWidth = Math.min(page.width * 0.6, asset.width)
      const scale = Math.min(1, maxWidth / asset.width)
      const w = Math.max(1, Math.round(asset.width * scale))
      const h = Math.max(1, Math.round(asset.height * scale))
      const element = createDesignElement('image', {
        imageAssetId: asset.id,
        x: Math.round((page.width - w) / 2),
        y: Math.round((page.height - h) / 2),
        w,
        h,
        zIndex: nextZIndex(page.elements),
        name: asset.filename
      })
      const pages = document.pages.map((item) =>
        item.id === activePageId
          ? { ...item, elements: [...item.elements, element] }
          : item
      )
      set({
        document: touchDocument(document, pages, [...document.assets, asset]),
        selectedElementIds: [element.id],
        assetDataUrls: { ...get().assetDataUrls, [asset.id]: dataUrl },
        saveState: 'idle',
        saveError: null
      })
    },

    setActivePage: (pageId) => {
      const document = get().document
      if (!document || !document.pages.some((page) => page.id === pageId)) return
      set({
        document: touchDocument(document),
        activePageId: pageId,
        selectedElementIds: [],
        saveState: 'idle',
        saveError: null
      })
    },
    getActivePage: () => {
      const { document, activePageId } = get()
      return document?.pages.find((page) => page.id === activePageId) ?? null
    },
    addPage: (options) => {
      const document = get().document
      if (!document) return
      commitBeforeChange()
      const format = options?.format ?? document.format
      const page = createDesignPage({
        format,
        customSize: options?.customSize,
        name: `Page ${document.pages.length + 1}`
      })
      set({
        document: touchDocument(document, [...document.pages, page]),
        activePageId: page.id,
        selectedElementIds: [],
        saveState: 'idle',
        saveError: null
      })
    },
    removePage: (pageId) => {
      const document = get().document
      if (!document || document.pages.length <= 1) return
      const index = document.pages.findIndex((page) => page.id === pageId)
      if (index < 0) return
      commitBeforeChange()
      const pages = document.pages.filter((page) => page.id !== pageId)
      set({
        document: touchDocument(document, pages),
        activePageId: pageId === get().activePageId
          ? pages[Math.max(0, index - 1)]?.id ?? pages[0].id
          : get().activePageId,
        selectedElementIds: [],
        saveState: 'idle',
        saveError: null
      })
    },
    renamePage: (pageId, name) => {
      const document = get().document
      const trimmed = name.trim()
      if (!document || !trimmed || !document.pages.some((page) => page.id === pageId)) return
      commitBeforeChange()
      set({
        document: touchDocument(
          document,
          document.pages.map((page) => page.id === pageId ? { ...page, name: trimmed } : page)
        ),
        saveState: 'idle',
        saveError: null
      })
    },
    duplicatePage: (pageId) => {
      const document = get().document
      const source = document?.pages.find((page) => page.id === pageId)
      if (!document || !source) return
      commitBeforeChange()
      const duplicate = duplicateDesignPage(source)
      const sourceIndex = document.pages.findIndex((page) => page.id === pageId)
      const pages = [...document.pages]
      pages.splice(sourceIndex + 1, 0, duplicate)
      set({
        document: touchDocument(document, pages),
        activePageId: duplicate.id,
        selectedElementIds: [],
        saveState: 'idle',
        saveError: null
      })
    },
    setPageDisplayMode: (pageId, mode) => {
      const document = get().document
      if (!document || !document.pages.some((page) => page.id === pageId)) return
      commitBeforeChange()
      set({
        document: touchDocument(
          document,
          document.pages.map((page) => page.id === pageId ? { ...page, displayMode: mode } : page)
        ),
        selectedElementIds: [],
        saveState: 'idle',
        saveError: null
      })
    },
    movePage: (fromIndex, toIndex) => {
      const document = get().document
      if (
        !document ||
        fromIndex < 0 ||
        fromIndex >= document.pages.length ||
        toIndex < 0 ||
        toIndex >= document.pages.length ||
        fromIndex === toIndex
      ) return
      commitBeforeChange()
      const pages = [...document.pages]
      const [moved] = pages.splice(fromIndex, 1)
      pages.splice(toIndex, 0, moved)
      set({ document: touchDocument(document, pages), saveState: 'idle', saveError: null })
    },

    addElement: (element) => {
      const normalized = normalizeDesignElement(element)
      const page = get().getActivePage()
      if (!normalized || !page || page.elements.some((item) => item.id === normalized.id)) return
      commitBeforeChange()
      updateActivePage(
        (current) => ({ ...current, elements: [...current.elements, normalized] }),
        [normalized.id]
      )
    },
    addDefaultElement: (type) => {
      const page = get().getActivePage()
      if (!page || type === 'group' || type === 'image') return
      const element = createDesignElement(type, {
        x: Math.max(0, Math.round(page.width / 2 - 100)),
        y: Math.max(0, Math.round(page.height / 2 - 60)),
        zIndex: nextZIndex(page.elements)
      })
      get().addElement(element)
    },
    updateElement: (elementId, patch) => {
      const page = get().getActivePage()
      const target = page?.elements.find((element) => element.id === elementId)
      if (!page || !target || !canUpdateElement(page, elementId, patch) || (target.type === 'group' && hasLockedDescendant(page, target))) return
      commitBeforeChange()
      updateActivePage((page) => updateElementInPage(page, elementId, patch))
    },
    updateSelectedElements: (patch) => {
      const page = get().getActivePage()
      if (!page) return
      const ids = topLevelSelection(page.elements, get().selectedElementIds)
        .filter((id) => {
          const element = page.elements.find((item) => item.id === id)
          return Boolean(element && canUpdateElement(page, id, patch) && !(element.type === 'group' && hasLockedDescendant(page, element)))
        })
      if (ids.length === 0) return
      commitBeforeChange()
      updateActivePage((page) => {
        let next = page
        for (const id of ids) {
          next = updateElementInPage(next, id, patch)
        }
        return next
      })
    },
    removeElement: (elementId) => {
      const page = get().getActivePage()
      const target = page?.elements.find((element) => element.id === elementId)
      if (!page || !target || target.locked || hasLockedDescendant(page, target)) return
      commitBeforeChange()
      updateActivePage(
        (page) => removeElementsFromPage(page, [elementId]),
        get().selectedElementIds.filter((id) => id !== elementId)
      )
    },
    removeSelectedElements: () => {
      const page = get().getActivePage()
      if (!page) return
      const ids = topLevelSelection(page.elements, get().selectedElementIds).filter((id) => {
        const element = page.elements.find((item) => item.id === id)
        return Boolean(element && !element.locked && !hasLockedDescendant(page, element))
      })
      if (ids.length === 0) return
      commitBeforeChange()
      updateActivePage((page) => removeElementsFromPage(page, ids), [])
    },
    groupSelectedElements: () => {
      const page = get().getActivePage()
      if (!page) return
      const ids = topLevelSelection(page.elements, get().selectedElementIds).filter((id) => {
        const element = page.elements.find((item) => item.id === id)
        return Boolean(element && !element.locked && !hasLockedDescendant(page, element))
      })
      const result = groupElements(page, ids)
      if (!result.groupId) return
      commitBeforeChange()
      updateActivePage(() => result.page, [result.groupId])
    },
    ungroupSelectedElements: () => {
      const page = get().getActivePage()
      if (!page) return
      const groupIds = get().selectedElementIds.filter(
        (id) => {
          const element = page.elements.find((item) => item.id === id)
          return element?.type === 'group' && !element.locked && !hasLockedDescendant(page, element)
        }
      )
      if (groupIds.length === 0) return
      commitBeforeChange()
      const result = ungroupElements(page, groupIds)
      updateActivePage(() => result.page, result.childIds)
    },
    duplicateSelectedElements: () => {
      const page = get().getActivePage()
      if (!page || get().selectedElementIds.length === 0) return
      const result = duplicateSelection(page, get().selectedElementIds)
      if (result.selectedIds.length === 0) return
      commitBeforeChange()
      updateActivePage(() => result.page, result.selectedIds)
    },
    applyCanvasCommand: (command, workspaceRoot) => {
      const { document, activePageId, appliedCommandIds } = get()
      const base = {
        schema: 'workwise.design.command.ack' as const,
        version: 1 as const,
        idempotencyKey: command.idempotencyKey,
        documentId: command.documentId,
        revision: document?.revision ?? 0,
        appliedOperations: 0
      }
      if (
        !document ||
        document.id !== command.documentId ||
        command.workspaceRoot !== workspaceRoot
      ) {
        return { ...base, ok: false, code: 'document_unavailable', message: 'Active Design document changed.' }
      }
      const prior = document?.appliedCommands.find(
        (record) => record.idempotencyKey === command.idempotencyKey
      )
      if (prior || appliedCommandIds.includes(command.idempotencyKey)) {
        return {
          ...base,
          ok: true,
          revision: prior?.revision ?? document?.revision ?? 0,
          appliedOperations: prior?.appliedOperations ?? 0
        }
      }
      if (activePageId !== command.pageId) {
        return { ...base, ok: false, code: 'document_unavailable', message: 'Active Design document changed.' }
      }
      if (command.expectedRevision !== document.revision) {
        return { ...base, ok: false, code: 'stale_request', message: 'Design document revision changed.' }
      }
      const page = get().getActivePage()
      if (!page || command.operations.length === 0 || command.operations.length > 64) {
        return { ...base, ok: false, code: 'invalid_command', message: 'Design command is invalid.' }
      }
      if (page.displayMode === 'fidelity') {
        return { ...base, ok: false, code: 'operation_failed', message: 'Reference mode is read-only. Switch to editing before applying a command.' }
      }
      const applied = applyCanvasOperations(page, command.operations)
      if (!applied) {
        return { ...base, ok: false, code: 'operation_failed', message: 'A Design operation could not be applied.' }
      }
      const changedDocument = touchDocument(
        document,
        document.pages.map((item) => item.id === page.id ? applied.page : item)
      )
      const candidate = {
        ...changedDocument,
        appliedCommands: [
          ...document.appliedCommands.filter(
            (record) => record.idempotencyKey !== command.idempotencyKey
          ),
          {
            idempotencyKey: command.idempotencyKey,
            revision: changedDocument.revision,
            appliedOperations: command.operations.length
          }
        ].slice(-200)
      }
      if (!validateDesignDocumentStructure(candidate)) {
        return { ...base, ok: false, code: 'invalid_command', message: 'Design command produced an invalid document.' }
      }
      commitBeforeChange()
      set({
        document: candidate,
        selectedElementIds: applied.selectedIds,
        appliedCommandIds: [...appliedCommandIds, command.idempotencyKey].slice(-200),
        saveState: 'idle',
        saveError: null
      })
      return {
        ...base,
        ok: true,
        revision: candidate.revision,
        appliedOperations: command.operations.length
      }
    },

    selectElement: (elementId) => set({ selectedElementIds: [elementId] }),
    addToSelection: (elementId) => {
      const ids = get().selectedElementIds
      if (!ids.includes(elementId)) set({ selectedElementIds: [...ids, elementId] })
    },
    removeFromSelection: (elementId) => set({
      selectedElementIds: get().selectedElementIds.filter((id) => id !== elementId)
    }),
    clearSelection: () => {
      if (get().selectedElementIds.length > 0) set({ selectedElementIds: [] })
    },
    selectAll: () => {
      const page = get().getActivePage()
      if (!page) return
      set({
        selectedElementIds: [...page.elements]
          .sort((a, b) => a.zIndex - b.zIndex)
          .map((element) => element.id)
      })
    },
    setActiveTool: (activeTool) => set({ activeTool }),

    undo: () => {
      const { document, history } = get()
      if (!document) return
      const result = undoHistory(history, document)
      if (!result.restoredDoc) return
      set({
        document: {
          ...result.restoredDoc,
          revision: document.revision + 1,
          appliedCommands: document.appliedCommands,
          updatedAt: Date.now()
        },
        history: endTransientChange(result.history),
        selectedElementIds: [],
        saveState: 'idle',
        saveError: null
      })
    },
    redo: () => {
      const { document, history } = get()
      if (!document) return
      const result = redoHistory(history, document)
      if (!result.restoredDoc) return
      set({
        document: {
          ...result.restoredDoc,
          revision: document.revision + 1,
          appliedCommands: document.appliedCommands,
          updatedAt: Date.now()
        },
        history: endTransientChange(result.history),
        selectedElementIds: [],
        saveState: 'idle',
        saveError: null
      })
    },
    canUndo: () => canUndo(get().history),
    canRedo: () => canRedo(get().history),
    beginTransientChange: () => {
      const { document, history } = get()
      if (document) set({ history: beginTransientChange(history, document) })
    },
    endTransientChange: () => set({ history: endTransientChange(get().history) })
  }
})
