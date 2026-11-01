import {
  resolveWriteMarkdownResource,
  resolveWriteMarkdownResourcePath
} from '@shared/write-markdown-resource'

export type WriteMarkdownImageResolution = {
  rawSrc: string
  fallbackSrc?: string
  localPath?: string
}

export type WriteMarkdownImageLoadResult =
  | {
      ok: true
      src: string
      localPath?: string
    }
  | {
      ok: false
      fallbackSrc?: string
      localPath?: string
      message: string
    }

function imageIpcAvailable(): boolean {
  return typeof window !== 'undefined' &&
    typeof window.workwise?.readWorkspaceImage === 'function'
}

export function resolveWriteMarkdownImage(
  src: string | undefined,
  filePath?: string | null
): WriteMarkdownImageResolution {
  const rawSrc = src?.trim() ?? ''
  const localPath = resolveWriteMarkdownResourcePath(rawSrc, filePath)
  // Local files are loaded through the workspace bridge. Network images never
  // load just because a document was opened; raster data URIs are self-contained.
  const fallbackSrc = /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z\d+/=\s]+$/i.test(rawSrc)
    ? resolveWriteMarkdownResource(rawSrc, filePath)
    : undefined
  return {
    rawSrc,
    ...(fallbackSrc ? { fallbackSrc } : {}),
    ...(localPath ? { localPath } : {})
  }
}

export function initialWriteMarkdownImageSrc(
  src: string | undefined,
  filePath?: string | null
): string | undefined {
  const resolved = resolveWriteMarkdownImage(src, filePath)
  if (resolved.localPath && imageIpcAvailable()) return undefined
  return resolved.fallbackSrc
}

export async function loadWriteMarkdownImage(
  src: string | undefined,
  filePath?: string | null,
  workspaceRoot?: string
): Promise<WriteMarkdownImageLoadResult> {
  const resolved = resolveWriteMarkdownImage(src, filePath)
  if (!resolved.localPath) {
    if (resolved.fallbackSrc) return { ok: true, src: resolved.fallbackSrc }
    return {
      ok: false,
      fallbackSrc: resolved.fallbackSrc,
      message: resolved.rawSrc ? 'Image source is not allowed.' : 'Image source is empty.'
    }
  }

  if (!imageIpcAvailable()) {
    if (resolved.fallbackSrc) {
      return { ok: true, src: resolved.fallbackSrc, localPath: resolved.localPath }
    }
    return {
      ok: false,
      localPath: resolved.localPath,
      message: 'Workspace image bridge is unavailable.'
    }
  }

  try {
    const result = await window.workwise.readWorkspaceImage({ path: resolved.localPath, ...(workspaceRoot ? { workspaceRoot } : {}) })
    if (result.ok) {
      return {
        ok: true,
        src: result.dataUrl,
        localPath: resolved.localPath
      }
    }
    return {
      ok: false,
      fallbackSrc: resolved.fallbackSrc,
      localPath: resolved.localPath,
      message: result.message
    }
  } catch (error) {
    return {
      ok: false,
      fallbackSrc: resolved.fallbackSrc,
      localPath: resolved.localPath,
      message: error instanceof Error ? error.message : String(error)
    }
  }
}
