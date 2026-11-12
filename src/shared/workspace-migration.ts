/** Local-only migration reports contain paths/fingerprints, never document content or credentials. */
export type WorkspaceNamespace = '.workgpt' | '.workwise' | '.kun' | '.deepseekgui'
export type WorkspaceMigrationEntry = {
  id: string
  namespace: WorkspaceNamespace
  kind: 'default' | 'write' | 'claw'
  path: string
  canonicalRoot?: string
  status: 'missing' | 'empty' | 'populated' | 'blocked'
  fileCount: number
  bytes: number
  fingerprint?: string
  aliasOf?: string
  identicalTo?: string
  conflictWith: string[]
  reason?: string
}
export type WorkspaceMigrationReport = {
  schema: 'railwise.workspace-migration'
  version: 1
  checkedAt: string
  entries: WorkspaceMigrationEntry[]
  aliases: Array<{ path: string; canonicalRoot: string }>
}
export type WorkspaceImportRequest = {
  sourceId: string
  expectedFingerprint: string
  confirmed: boolean
  idempotencyKey: string
}
export type WorkspaceImportResult = {
  operationId: string
  status: 'completed' | 'outcome_unknown' | 'failed'
  sourcePath: string
  sourceFingerprint: string
  snapshotPath: string
  logPath: string
  fileCount: number
  bytes: number
  error?: string
}
