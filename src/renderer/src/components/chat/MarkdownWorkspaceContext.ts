import { createContext, useContext } from 'react'
import { useChatStore } from '../../store/chat-store'

/** An explicit result owner takes precedence over the active chat workspace. */
export const MarkdownWorkspaceContext = createContext<string | undefined>(undefined)

export function useMarkdownWorkspaceRoot(): string {
  const explicitWorkspace = useContext(MarkdownWorkspaceContext)
  const chatWorkspace = useChatStore(state => state.workspaceRoot)
  return explicitWorkspace ?? chatWorkspace
}
