/** Runtime-owned semantics for a typed external operation. Never read from model output. */
export type ToolEffectDefinition = {
  provider: string
  providerId?: string
  operation: string
  mutation: boolean
  targetFields: readonly string[]
  readbackToolName?: string
  requiredScopes?: readonly string[]
}

export type ToolEffectResolver = (toolName: string) => ToolEffectDefinition | undefined
