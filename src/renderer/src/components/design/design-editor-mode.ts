export type DesignEditorMode = 'canvas' | 'pptx'

export function designEditorModeForDocumentName(name: string | undefined): DesignEditorMode {
  return typeof name === 'string' && /\.pptx$/i.test(name.trim()) ? 'pptx' : 'canvas'
}
