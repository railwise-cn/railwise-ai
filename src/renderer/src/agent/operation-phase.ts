/** Classifies a local tool update without exposing its arguments or output. */
export function operationPhase(nameOrSummary: string, toolKind?: string) {
  const text = nameOrSummary.toLowerCase()
  if (/test|verify|validate|diagnos|lint|typecheck|build/.test(text)) return 'validating'
  if (/ppt|slide|image|generate|render|export/.test(text)) return 'generating'
  if (toolKind === 'file_change' || /write|edit|patch|save/.test(text)) return 'editing'
  if (/browser|fetch|web|search_query|mcp/.test(text)) return 'researching'
  if (/read|grep|find|list|\bls\b/.test(text)) return 'reading'
  if (toolKind === 'command_execution') return 'executing'
  return 'working'
}
