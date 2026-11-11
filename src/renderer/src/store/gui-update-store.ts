import { useEffect } from 'react'
import { create } from 'zustand'
import type { GuiUpdateChannel, GuiUpdateState } from '@shared/gui-update'
import { preflightAndInstallGuiUpdate } from '../lib/gui-update-install-preflight'

type UpdateStore = {
  state: GuiUpdateState
  pending: boolean
  activity: 'checking' | 'downloading' | 'installing' | 'applying' | null
  error: string | null
}

export const useGuiUpdateStore = create<UpdateStore>(() => ({ state: { status: 'idle' }, pending: false, activity: null, error: null }))
let subscribers = 0
let unsubscribe: (() => void) | undefined
let revision = 0
let connectionGeneration = 0
let operation: Promise<void> | undefined

function applyState(state: GuiUpdateState): void {
  revision += 1
  useGuiUpdateStore.setState({ state, error: state.status === 'error' ? state.message : null })
}

/** Sidebar and settings share one IPC subscription, including the initial snapshot. */
export function useGuiUpdate(): UpdateStore {
  const snapshot = useGuiUpdateStore()
  useEffect(() => {
    subscribers += 1
    if (subscribers === 1 && window.workwise?.onGuiUpdateState) {
      const generation = ++connectionGeneration
      unsubscribe = window.workwise.onGuiUpdateState(applyState)
      const before = revision
      void window.workwise.getGuiUpdateState?.().then(state => {
        if (generation === connectionGeneration && revision === before && subscribers > 0) applyState(state)
      }).catch(() => undefined)
    }
    return () => {
      subscribers -= 1
      if (subscribers === 0) { connectionGeneration += 1; unsubscribe?.(); unsubscribe = undefined }
    }
  }, [])
  return snapshot
}

function runOperation(activity: NonNullable<UpdateStore['activity']>, run: () => Promise<void>): Promise<void> {
  if (operation) return operation
  useGuiUpdateStore.setState({ pending: true, activity, error: null })
  operation = run().catch(error => {
    useGuiUpdateStore.setState({ error: error instanceof Error ? error.message : String(error) })
  }).finally(() => {
    operation = undefined
    useGuiUpdateStore.setState({ pending: false, activity: null })
  })
  return operation
}

export function resetGuiUpdateState(): void {
  if (!operation) applyState({ status: 'idle' })
}

export function checkGuiUpdate(channel?: GuiUpdateChannel): Promise<void> {
  return runOperation('checking', async () => {
    const info = await window.workwise.checkGuiUpdate(channel)
    applyState(info.ok
      ? { status: info.downloaded ? 'downloaded' : info.hasUpdate ? 'available' : 'not_available', info }
      : { status: 'error', info, message: info.message, code: info.code })
  })
}

async function download(channel?: GuiUpdateChannel): Promise<void> {
  const result = await window.workwise.downloadGuiUpdate(channel)
  if (!result.ok) throw new Error(result.message)
  const state = await window.workwise.getGuiUpdateState()
  applyState(state)
  if (state.status !== 'downloaded' && !(state.info?.ok && state.info.downloaded)) {
    throw new Error('更新包尚未完成校验，请重试。')
  }
}

async function install(): Promise<void> {
  const result = await preflightAndInstallGuiUpdate()
  if (!result.ok) throw new Error(result.message)
}

export function downloadGuiUpdate(channel?: GuiUpdateChannel): Promise<void> {
  return runOperation('downloading', () => download(channel))
}

export function installGuiUpdate(): Promise<void> {
  return runOperation('installing', install)
}

/** One user action downloads, saves, checks running work and hands off installation. */
export function applyGuiUpdate(): Promise<void> {
  return runOperation('applying', async () => {
    const state = useGuiUpdateStore.getState().state
    const info = state.info
    if (!info?.ok || !info.hasUpdate || info.withdrawn) return
    if (info.manualOnly) {
      await window.workwise.openExternal(info.releaseUrl)
      return
    }
    if (!info.downloaded && state.status !== 'downloaded') await download(info.channel)
    await install()
  })
}
