/** The same bytes with different units/roles are a different import, not an idempotent replay. */
export async function surveyImportKey(projectId: string, input: {
  name: string
  dataBase64: string
  networkType: string
  transformType?: string
  cosaIn1Mapping?: unknown
  knownPoints?: unknown
}): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(input)))
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `survey-file-import-${projectId}-${hash}`
}
