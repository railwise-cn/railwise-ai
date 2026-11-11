import { useCallback, useEffect, useRef } from 'react'
import type { AppSettingsV1 } from '@shared/app-settings'
import type { GuiUpdateChannel } from '@shared/gui-update'
import { guiUpdateFailureMessage } from './settings-utils'
import {
  checkGuiUpdate as checkUpdate,
  downloadGuiUpdate as downloadUpdate,
  installGuiUpdate,
  resetGuiUpdateState,
  useGuiUpdate
} from '../store/gui-update-store'

export function useSettingsGuiUpdate({ category, channel, form, t }: {
  category: 'general' | 'providers' | 'write' | 'imageGeneration' | 'agents' | 'shortcuts' | 'claw' | 'help'
  channel: GuiUpdateChannel | undefined
  form: AppSettingsV1 | null
  t: (key: string, values?: Record<string, unknown>) => string
}) {
  const { state, activity, error } = useGuiUpdate()
  const checkedGuiUpdateChannel = useRef<GuiUpdateChannel | null>(null)
  const checkGuiUpdate = useCallback(() => checkUpdate(channel), [channel])
  const info = state.info ?? null
  const guiUpdateError = info && !info.ok && state.status === 'error'
    ? info.code === 'not_configured' ? null : guiUpdateFailureMessage(info, t)
    : error

  useEffect(() => {
    if (!form || category !== 'general' || typeof window.workwise?.checkGuiUpdate !== 'function') return
    if (checkedGuiUpdateChannel.current === (channel ?? null)) return
    checkedGuiUpdateChannel.current = channel ?? null
    void checkGuiUpdate()
  }, [category, checkGuiUpdate, channel, form])

  return {
    checkingGuiUpdate: state.status === 'checking' || activity === 'checking',
    checkGuiUpdate,
    downloadingGuiUpdate: state.status === 'downloading' || activity === 'downloading',
    downloadGuiUpdate: () => downloadUpdate(form?.guiUpdate?.channel),
    guiUpdateDownloaded: state.status === 'downloaded' || Boolean(info?.ok && info.downloaded),
    guiUpdateError,
    guiUpdateInfo: info,
    guiUpdateProgress: state.status === 'downloading' ? state.progress : null,
    installingGuiUpdate: state.status === 'installing' || activity === 'installing' || (activity === 'applying' && Boolean(info?.ok && info.downloaded)),
    installGuiUpdate,
    resetGuiUpdateState
  }
}
