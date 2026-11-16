import type { PointerEvent as ReactPointerEvent } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { WorkspaceFileTarget } from '@shared/workspace-file'
import type { AppRoute } from '../store/chat-store-types'
import {
  readBrowserStorageItem,
  removeBrowserStorageItem,
  writeBrowserStorageItem
} from '../lib/browser-storage'
import { WORKSPACE_FILE_PREVIEW_EVENT, type WorkspaceFilePreviewDetail } from '../lib/workspace-file-preview'
import type { RightPanelMode } from './chat/WorkbenchTopBar'
import { clampPanelWidth, computeWorkbenchLayout, WORKBENCH_NAV_DRAWER_BELOW, WORKBENCH_NAV_MIN, WORKBENCH_NAV_MAX, WORKBENCH_INSPECTOR_MIN, WORKBENCH_INSPECTOR_MAX } from './workbench-layout-model'

const LEFT_PANEL_WIDTH_KEY = 'workwise.layout.leftSidebarWidth'
const LEFT_PANEL_COLLAPSED_KEY = 'workwise.layout.leftSidebarCollapsed'
const RIGHT_PANEL_WIDTH_KEY = 'workwise.layout.rightInspectorWidth'
const RIGHT_PANEL_MODE_KEY = 'workwise.layout.rightPanelMode'
const LEFT_PANEL_DEFAULT = 264
const RIGHT_PANEL_DEFAULT = 360
const WRITE_ASSISTANT_MIN = 320
const WRITE_ASSISTANT_MAX = 420
export const CODE_PANEL_PREFERRED = 560
function clampWidth(value: number, min: number, max: number): number {
  return clampPanelWidth(value, min, max)
}

function readStoredWidth(key: string, fallback: number): number {
  const raw = readBrowserStorageItem(key)
  if (!raw) return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return fallback
  return Math.round(parsed)
}

function persistWidth(key: string, width: number): void {
  writeBrowserStorageItem(key, String(Math.round(width)))
}

function readStoredBoolean(key: string, fallback: boolean): boolean {
  const raw = readBrowserStorageItem(key)
  if (raw === '1') return true
  if (raw === '0') return false
  return fallback
}

function persistBoolean(key: string, value: boolean): void {
  writeBrowserStorageItem(key, value ? '1' : '0')
}

function readStoredRightPanelMode(): RightPanelMode {
  const raw = readBrowserStorageItem(RIGHT_PANEL_MODE_KEY)
  return raw === 'todo' || raw === 'changes' || raw === 'browser' ? raw : null
}

function persistRightPanelMode(mode: RightPanelMode): void {
  if (mode === 'todo' || mode === 'changes' || mode === 'browser') {
    writeBrowserStorageItem(RIGHT_PANEL_MODE_KEY, mode)
  } else {
    removeBrowserStorageItem(RIGHT_PANEL_MODE_KEY)
  }
}

export function useWorkbenchLayout({
  activeThreadId,
  latestAutoOpenDevPreviewKey,
  latestAutoOpenDevPreviewUrl,
  latestDevPreviewUrl,
  route,
  workspaceRoot,
  writeAssistantOpen
}: {
  activeThreadId: string | null
  latestAutoOpenDevPreviewKey?: string | null
  latestAutoOpenDevPreviewUrl: string | null
  latestDevPreviewUrl: string | null
  route: AppRoute
  workspaceRoot: string
  writeAssistantOpen: boolean
}) {
  const [rightPanelMode, setRightPanelMode] = useState<RightPanelMode>(readStoredRightPanelMode)
  const [filePreviewTarget, setFilePreviewTarget] = useState<WorkspaceFileTarget | null>(null)
  const [preferredLeftWidth, setLeftSidebarWidth] = useState(() =>
    readStoredWidth(LEFT_PANEL_WIDTH_KEY, LEFT_PANEL_DEFAULT)
  )
  const [preferredLeftCollapsed, setLeftSidebarCollapsed] = useState(() =>
    readStoredBoolean(LEFT_PANEL_COLLAPSED_KEY, false)
  )
  const [preferredRightWidth, setRightSidebarWidth] = useState(() =>
    readStoredWidth(RIGHT_PANEL_WIDTH_KEY, RIGHT_PANEL_DEFAULT)
  )
  const shellRef = useRef<HTMLDivElement | null>(null)
  const [containerWidth, setContainerWidth] = useState(() => window.innerWidth / (Number.parseFloat(getComputedStyle(document.body).zoom) || 1))
  const [compactNavigationOpen, setCompactNavigationOpen] = useState(false)
  const compactNavigation = containerWidth < WORKBENCH_NAV_DRAWER_BELOW
  const leftSidebarCollapsed = compactNavigation ? !compactNavigationOpen : preferredLeftCollapsed
  const previewThreadId = useRef<string | null>(activeThreadId)
  const autoOpenedPreviewKeyRef = useRef<string | null>(null)
  const dismissedPreviews = useRef(new Map<string | null, string>())
  const currentPreviewKey = latestAutoOpenDevPreviewKey ?? latestAutoOpenDevPreviewUrl
  const rightPanelVisible = route === 'write'
    ? writeAssistantOpen || rightPanelMode === 'sdd-ai'
    : ['chat', 'claw', 'tasks'].includes(route) && rightPanelMode !== null
  const layout = computeWorkbenchLayout(containerWidth, preferredLeftWidth, preferredRightWidth,
    { leftVisible: !leftSidebarCollapsed, rightVisible: rightPanelVisible })
  const leftSidebarWidth = layout.left
  const rightSidebarWidth = layout.right
  const leftSidebarOverlay = layout.leftOverlay
  const rightSidebarOverlay = layout.rightOverlay
  const activeOverlay = !leftSidebarCollapsed && leftSidebarOverlay ? 'navigation' : rightPanelVisible && rightSidebarOverlay ? 'inspector' : null
  const closeCompactNavigation = (): void => setCompactNavigationOpen(false)

  useEffect(() => { setCompactNavigationOpen(false) }, [compactNavigation, route, activeThreadId, workspaceRoot])

  useEffect(() => {
    if (!rightPanelVisible) return
    if (route === 'write') {
      setRightSidebarWidth((width) => clampWidth(width, WRITE_ASSISTANT_MIN, WRITE_ASSISTANT_MAX))
      return
    }
    setRightSidebarWidth((width) => Math.max(width, 480))
  }, [rightPanelVisible, route])

  useEffect(() => {
    persistWidth(LEFT_PANEL_WIDTH_KEY, preferredLeftWidth)
  }, [preferredLeftWidth])

  useEffect(() => {
    persistBoolean(LEFT_PANEL_COLLAPSED_KEY, preferredLeftCollapsed)
  }, [preferredLeftCollapsed])

  useEffect(() => {
    persistWidth(RIGHT_PANEL_WIDTH_KEY, preferredRightWidth)
  }, [preferredRightWidth])

  useEffect(() => {
    persistRightPanelMode(rightPanelMode)
  }, [rightPanelMode])

  useEffect(() => {
    const onPreview = (event: Event): void => {
      const detail = (event as CustomEvent<WorkspaceFilePreviewDetail>).detail
      if (!detail?.path) return
      setFilePreviewTarget({
        ...detail,
        workspaceRoot: detail.workspaceRoot ?? workspaceRoot
      })
      setRightSidebarWidth((width) => Math.max(width, CODE_PANEL_PREFERRED))
      setRightPanelMode('file')
    }

    window.addEventListener(WORKSPACE_FILE_PREVIEW_EVENT, onPreview)
    return () => window.removeEventListener(WORKSPACE_FILE_PREVIEW_EVENT, onPreview)
  }, [workspaceRoot])

  useEffect(() => {
    if (previewThreadId.current === activeThreadId) return
    previewThreadId.current = activeThreadId
    autoOpenedPreviewKeyRef.current = null
    if (rightPanelMode === 'browser') setRightPanelMode(null)
    if (rightPanelMode === 'file') {
      setRightPanelMode(null)
      setFilePreviewTarget(null)
    }
  }, [activeThreadId, rightPanelMode])

  useEffect(() => {
    if (!latestAutoOpenDevPreviewUrl || !currentPreviewKey || (route !== 'chat' && route !== 'tasks')) return
    if (dismissedPreviews.current.get(activeThreadId) === currentPreviewKey) return
    if (autoOpenedPreviewKeyRef.current === currentPreviewKey) return
    autoOpenedPreviewKeyRef.current = currentPreviewKey
    setRightPanelMode('browser')
  }, [activeThreadId, currentPreviewKey, latestAutoOpenDevPreviewUrl, route])

  useEffect(() => {
    if (route !== 'write') return
    if (rightPanelMode !== null) setRightPanelMode(null)
  }, [route, rightPanelMode])

  useLayoutEffect(() => {
    const shell = shellRef.current
    const sync = (): void => {
      const width = shell?.clientWidth
      if (width && width > 0) setContainerWidth(width)
    }
    sync()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(sync)
    if (shell) observer?.observe(shell)
    window.addEventListener('resize', sync)
    return () => { observer?.disconnect(); window.removeEventListener('resize', sync) }
  }, [])

  const toggleRightPanelMode = (nextMode: Exclude<RightPanelMode, null>): void => {
    if (rightPanelMode === 'browser' && currentPreviewKey) dismissedPreviews.current.set(activeThreadId, currentPreviewKey)
    if (nextMode === 'browser' && rightPanelMode !== 'browser') dismissedPreviews.current.delete(activeThreadId)
    setRightPanelMode((current) => (current === nextMode ? null : nextMode))
  }

  const toggleLeftSidebar = (): void => {
    if (compactNavigation) setCompactNavigationOpen(current => !current)
    else setLeftSidebarCollapsed(current => !current)
  }

  const openDevPreview = (): void => {
    dismissedPreviews.current.delete(activeThreadId)
    autoOpenedPreviewKeyRef.current = currentPreviewKey ?? latestDevPreviewUrl
    setRightPanelMode('browser')
  }

  const closeDevPreview = (): void => {
    if (currentPreviewKey) dismissedPreviews.current.set(activeThreadId, currentPreviewKey)
    setRightPanelMode(null)
  }

  const dragCleanup = useRef<(() => void) | null>(null)
  useEffect(() => () => dragCleanup.current?.(), [])
  const beginPanelDrag = (event: ReactPointerEvent<HTMLDivElement>, onDelta: (delta: number) => void): void => {
    event.preventDefault()
    dragCleanup.current?.()
    const startX = event.clientX
    const previousCursor = document.body.style.cursor
    const previousSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.body.dataset.workbenchResizing = 'true'
    const onMove = (move: PointerEvent): void => {
      const shell = shellRef.current
      // Pointer coordinates are visual pixels; stored widths are layout pixels.
      const measured = shell && shell.clientWidth > 0 ? shell.getBoundingClientRect().width / shell.clientWidth : 0
      const scale = measured > 0 ? measured : Number.parseFloat(getComputedStyle(document.body).zoom) || 1
      onDelta((move.clientX - startX) / scale)
    }
    const stop = (): void => {
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousSelect
      delete document.body.dataset.workbenchResizing
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      window.removeEventListener('blur', stop)
      if (dragCleanup.current === stop) dragCleanup.current = null
    }
    dragCleanup.current = stop
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    window.addEventListener('blur', stop)
  }

  const beginLeftResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (leftSidebarCollapsed || leftSidebarOverlay || event.button !== 0) return
    const startLeft = leftSidebarWidth, startRight = rightSidebarWidth
    beginPanelDrag(event, delta => {
      const next = computeWorkbenchLayout(shellRef.current?.clientWidth ?? containerWidth, startLeft + delta, startRight,
        { leftVisible: true, rightVisible: rightPanelVisible })
      setLeftSidebarWidth(next.left)
      setRightSidebarWidth(next.right)
    })
  }

  const beginRightResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || !rightPanelVisible || rightSidebarOverlay) return
    const startLeft = leftSidebarWidth, startRight = rightSidebarWidth
    beginPanelDrag(event, delta => {
      const next = computeWorkbenchLayout(shellRef.current?.clientWidth ?? containerWidth, startLeft, startRight - delta,
        { leftVisible: !leftSidebarCollapsed, rightVisible: true })
      setLeftSidebarWidth(next.left)
      setRightSidebarWidth(next.right)
    })
  }

  return {
    beginLeftResize,
    beginRightResize,
    closeDevPreview,
    closeCompactNavigation,
    activeOverlay,
    leftSidebarOverlay,
    rightSidebarOverlay,
    filePreviewTarget,
    leftSidebarCollapsed,
    leftSidebarWidth,
    openDevPreview,
    resizeLeftBy: (delta: number) => setLeftSidebarWidth(clampWidth(leftSidebarWidth + delta, WORKBENCH_NAV_MIN, WORKBENCH_NAV_MAX)),
    resizeRightBy: (delta: number) => setRightSidebarWidth(clampWidth(rightSidebarWidth + delta, WORKBENCH_INSPECTOR_MIN, WORKBENCH_INSPECTOR_MAX)),
    rightPanelMode,
    rightPanelVisible,
    rightSidebarWidth,
    setFilePreviewTarget,
    setRightPanelMode,
    setRightSidebarWidth,
    shellRef,
    toggleLeftSidebar,
    toggleRightPanelMode
  }
}
