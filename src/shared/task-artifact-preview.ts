/** Identifies the capability URL issued by the managed HTML preview server. */
export function taskArtifactPreviewScope(value: string): string | null {
  try {
    const url = new URL(value)
    const match = /^\/task-preview\/[a-f0-9]{48}\//.exec(url.pathname)
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && match ? `${url.origin}${match[0]}` : null
  } catch { return null }
}
