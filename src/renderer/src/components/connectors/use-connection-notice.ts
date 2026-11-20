import { useCallback, useState } from 'react'
import i18n from '../../i18n'
import { describeRuntimeError, type RuntimeErrorView } from '../../lib/format-runtime-error'

export function useConnectionNotice() {
  const [notice, setNotice] = useState<RuntimeErrorView>({ summary: '' })
  const setMessage = useCallback((summary: string) => setNotice({ summary }), [])
  const reportError = useCallback((error: unknown, fallback?: string) => {
    setNotice(describeRuntimeError(error, fallback ?? i18n.t('common:runtimeConnectionActionFailed')))
  }, [])
  return { message: notice.summary, detail: notice.detail, setMessage, reportError }
}
