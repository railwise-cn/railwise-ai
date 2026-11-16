import type { ReactElement } from 'react'
import { lazy, Suspense } from 'react'

const LazyStreamdownAssistant = lazy(() =>
  import('./StreamdownAssistant').then((module) => ({ default: module.StreamdownAssistant }))
)

export function AssistantMarkdown({
  text,
  streaming,
  className,
  workspaceRoot,
  restricted
}: {
  text: string
  streaming: boolean
  className?: string
  workspaceRoot?: string
  restricted?: boolean
}): ReactElement {
  return (
    <Suspense
      fallback={
        <div className={className}>
          {text}
        </div>
      }
    >
      <LazyStreamdownAssistant text={text} streaming={streaming} className={className} workspaceRoot={workspaceRoot} restricted={restricted} />
    </Suspense>
  )
}
