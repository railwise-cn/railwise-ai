export type WriteMermaidPreviewRequest = { source: string }

export type WriteMermaidPreviewResult =
  | { ok: true; svg: string; width: number; height: number }
  | { ok: false; message: string }
