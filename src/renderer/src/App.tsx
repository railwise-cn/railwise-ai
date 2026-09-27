import { lazy, Suspense } from 'react'
import { AppErrorBoundary } from './components/AppErrorBoundary'

const AppShell = lazy(() => import('./AppShell'))

export function startupShellLabel(locale: 'en' | 'zh'): string {
  return locale === 'zh' ? '正在打开 RailWise AI 工作台…' : 'Opening RailWise AI workbench…'
}

function StartupShell(): React.ReactElement {
  return (
    <div className="flex h-full min-h-0 items-center justify-center bg-ds-main text-ds-muted">
      <div className="flex items-center gap-2 rounded-full border border-ds-border-muted bg-ds-card px-4 py-2 text-[13px] shadow-sm">
        <span className="h-2 w-2 animate-pulse rounded-full bg-accent" aria-hidden />
        <span>{startupShellLabel(window.workwise.initialLocale)}</span>
      </div>
    </div>
  )
}

export default function App(): React.ReactElement {
  return (
    <AppErrorBoundary>
      <Suspense fallback={<StartupShell />}>
        <AppShell />
      </Suspense>
    </AppErrorBoundary>
  )
}
