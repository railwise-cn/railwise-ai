import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, join, relative, sep } from 'node:path'

/**
 * Read-only compatibility import for pre-V2 installations.
 *
 * This module is the only filesystem migration boundary allowed to know legacy
 * product paths. It never renames or deletes a source and never creates a
 * symlink/junction. New data is copied into WorkWise-owned paths once.
 */

export type MigrationLogger = (message: string, detail?: unknown) => void

export const LEGACY_USER_DATA_DIR_NAMES = ['WorkWise', 'workwise', 'RailWise AI', 'RailWise-AI', 'Railwise AI', 'railwise-ai', 'WorkGPT', 'workgpt', 'WORKGPT', 'Kun', 'DeepSeek GUI', 'deepseek-gui'] as const
export const COMPATIBLE_SETTINGS_FILE_NAMES = ['workwise-settings.json', 'workgpt-settings.json', 'kun-settings.json', 'deepseek-gui-settings.json'] as const
export const LEGACY_HOME_DATA_ROOT = '.deepseekgui'
export const NEW_HOME_DATA_ROOT = '.workwise'

export type HomeDataMigrationMapping = {
  legacySegments: readonly string[]
  nextSegments: readonly string[]
}

export const HOME_DATA_MIGRATION_MAPPINGS: readonly HomeDataMigrationMapping[] = [
  { legacySegments: ['.kun', 'data'], nextSegments: [NEW_HOME_DATA_ROOT, 'runtime'] },
  { legacySegments: [LEGACY_HOME_DATA_ROOT, 'kun'], nextSegments: [NEW_HOME_DATA_ROOT, 'runtime'] },
  { legacySegments: ['.kun', 'default_workspace'], nextSegments: [NEW_HOME_DATA_ROOT, 'default_workspace'] },
  { legacySegments: [LEGACY_HOME_DATA_ROOT, 'default_workspace'], nextSegments: [NEW_HOME_DATA_ROOT, 'default_workspace'] },
  { legacySegments: ['.kun', 'claw'], nextSegments: [NEW_HOME_DATA_ROOT, 'claw'] },
  { legacySegments: [LEGACY_HOME_DATA_ROOT, 'claw'], nextSegments: [NEW_HOME_DATA_ROOT, 'claw'] },
  { legacySegments: ['.kun', 'write_workspace'], nextSegments: [NEW_HOME_DATA_ROOT, 'write_workspace'] },
  { legacySegments: [LEGACY_HOME_DATA_ROOT, 'write_workspace'], nextSegments: [NEW_HOME_DATA_ROOT, 'write_workspace'] }
] as const

export type HomeMappingOutcome = 'imported' | 'target-exists' | 'skipped-missing' | 'failed'

export type HomeDataMigrationResult = {
  mapping: HomeDataMigrationMapping
  legacyPath: string
  nextPath: string
  outcome: HomeMappingOutcome
  rewriteSafe: false
}

export type UserDataMigrationResult = {
  userDataPath: string
  migrated: boolean
  usedLegacyFallback: false
  sourcePath?: string
  outcome?: 'imported' | 'target-exists' | 'skipped-missing' | 'conflict' | 'failed'
  conflictPaths?: string[]
  files?: ImportedFileEntry[]
}

export type ImportedFileEntry = { path: string; type: 'file' | 'symlink'; size: number; sha256: string }

export type LegacyDataMigrationResult = {
  userData: UserDataMigrationResult
  home: HomeDataMigrationResult[]
  settingsRewritten: false
}

export const USER_DATA_MIGRATION_MARKER = '.workwise-migration-v2.json'

function noopLog(): void {}

function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory()
  } catch {
    return false
  }
}

function isEmptyDirectory(path: string): boolean {
  try {
    return isDirectory(path) && readdirSync(path).length === 0
  } catch {
    return false
  }
}

/** A Chromium cache directory alone is not an application profile. */
export function isRecognizedSettingsText(raw: string): boolean {
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const record = value as Record<string, unknown>
    return record.version === 1 || (record.schema === 'workwise.settings' && record.version === 2) ||
      ['provider', 'agents', 'deepseek', 'workspaceRoot', 'agentProvider', 'write', 'claw'].some(key => key in record)
  } catch { return false }
}

export function hasRecognizedUserData(path: string): boolean {
  return COMPATIBLE_SETTINGS_FILE_NAMES.some(name => {
    try {
      const file = join(path, name)
      return lstatSync(file).isFile() && isRecognizedSettingsText(readFileSync(file, 'utf8'))
    } catch { return false }
  })
}

function fileInventory(root: string, ignoreMarker = false): ImportedFileEntry[] {
  const output: ImportedFileEntry[] = []
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = join(directory, name)
      const path = relative(root, absolute).split(sep).join('/')
      if (ignoreMarker && path === USER_DATA_MIGRATION_MARKER) continue
      const info = lstatSync(absolute)
      if (info.isDirectory()) { visit(absolute); continue }
      if (!info.isFile() && !info.isSymbolicLink()) throw new Error(`Unsupported profile entry: ${path}`)
      const bytes = info.isSymbolicLink() ? Buffer.from(readlinkSync(absolute)) : readFileSync(absolute)
      output.push({ path, type: info.isSymbolicLink() ? 'symlink' : 'file', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
    }
  }
  visit(root)
  return output
}

export function verifyImportedUserData(userDataPath: string): boolean {
  try {
    const marker = JSON.parse(readFileSync(join(userDataPath, USER_DATA_MIGRATION_MARKER), 'utf8')) as { files?: ImportedFileEntry[] }
    return Array.isArray(marker.files) && JSON.stringify(marker.files) === JSON.stringify(fileInventory(userDataPath, true))
  } catch { return false }
}

function copyDirectoryOnce(sourcePath: string, targetPath: string): boolean {
  if (!isDirectory(sourcePath)) return false
  if (existsSync(targetPath) && !isEmptyDirectory(targetPath)) return false
  mkdirSync(dirname(targetPath), { recursive: true })
  cpSync(sourcePath, targetPath, {
    recursive: true,
    force: false,
    errorOnExist: true,
    preserveTimestamps: true,
    verbatimSymlinks: true
  })
  return true
}

export function migrateLegacyUserDataDir(input: {
  userDataPath: string
  legacyDirNames?: readonly string[]
  log?: MigrationLogger
}): UserDataMigrationResult {
  const log = input.log ?? noopLog
  const targetPath = input.userDataPath
  if (existsSync(targetPath) && !isEmptyDirectory(targetPath)) {
    return { userDataPath: targetPath, migrated: false, usedLegacyFallback: false, outcome: 'target-exists' }
  }

  const appDataDir = dirname(targetPath)
  const targetName = basename(targetPath)
  const legacyNames = (input.legacyDirNames ?? LEGACY_USER_DATA_DIR_NAMES)
    .filter((name) => name !== targetName)
  // On case-insensitive filesystems multiple historical spellings may resolve
  // to the same profile; count real directories rather than spelling variants.
  const sources = new Map<string, string>()
  for (const legacyName of legacyNames) {
    const path = join(appDataDir, legacyName)
    if (isDirectory(path) && hasRecognizedUserData(path)) {
      const info = lstatSync(path)
      const identity = `${info.dev}:${info.ino}`
      if (!sources.has(identity)) sources.set(identity, path)
    }
  }
  const sourcePaths = [...sources.values()]
  if (sourcePaths.length > 1) {
    log('legacy-import: multiple valid profiles require explicit selection; no profile was copied', { targetPath, sourcePaths })
    return { userDataPath: targetPath, migrated: false, usedLegacyFallback: false, outcome: 'conflict', conflictPaths: sourcePaths }
  }
  const sourcePath = sourcePaths[0]
  if (sourcePath) {
    let stagingPath: string | undefined
    let stagingRoot: string | undefined
    try {
      mkdirSync(appDataDir, { recursive: true })
      const files = fileInventory(sourcePath, true)
      stagingRoot = mkdtempSync(join(appDataDir, '.railwise-profile-import-'))
      stagingPath = join(stagingRoot, 'profile')
      cpSync(sourcePath, stagingPath, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true, verbatimSymlinks: true })
      if (JSON.stringify(files) !== JSON.stringify(fileInventory(stagingPath, true)) || JSON.stringify(files) !== JSON.stringify(fileInventory(sourcePath, true))) throw new Error('Profile changed during import or copied bytes differ')
      const previousMarker = existsSync(join(stagingPath, USER_DATA_MIGRATION_MARKER)) ? readFileSync(join(stagingPath, USER_DATA_MIGRATION_MARKER), 'utf8') : undefined
      writeFileSync(
        join(stagingPath, USER_DATA_MIGRATION_MARKER),
        `${JSON.stringify({ schema: 'workwise.migration', version: 2, sourcePath, importedAt: new Date().toISOString(), files, previousMarker }, null, 2)}\n`,
        'utf8'
      )
      if (existsSync(targetPath)) rmdirSync(targetPath) // Fails if another writer made it nonempty.
      renameSync(stagingPath, targetPath)
      stagingPath = undefined
      log('legacy-import: verified user data copied into RailWise AI; source preserved', { sourcePath, targetPath, fileCount: files.length })
      return { userDataPath: targetPath, migrated: true, usedLegacyFallback: false, sourcePath, files, outcome: 'imported' }
    } catch (error) {
      log('legacy-import: user data copy failed; source remains untouched', {
        sourcePath,
        targetPath,
        message: error instanceof Error ? error.message : String(error)
      })
      return { userDataPath: targetPath, migrated: false, usedLegacyFallback: false, outcome: 'failed' }
    } finally {
      if (stagingRoot) rmSync(stagingRoot, { recursive: true, force: true })
    }
  }
  return { userDataPath: targetPath, migrated: false, usedLegacyFallback: false, outcome: 'skipped-missing' }
}

export function migrateLegacyHomeDataDirs(input: {
  homeDir: string
  mappings?: readonly HomeDataMigrationMapping[]
  log?: MigrationLogger
}): HomeDataMigrationResult[] {
  const log = input.log ?? noopLog
  const results: HomeDataMigrationResult[] = []
  for (const mapping of input.mappings ?? HOME_DATA_MIGRATION_MAPPINGS) {
    const legacyPath = join(input.homeDir, ...mapping.legacySegments)
    const nextPath = join(input.homeDir, ...mapping.nextSegments)
    const base = { mapping, legacyPath, nextPath, rewriteSafe: false as const }
    if (!isDirectory(legacyPath)) {
      results.push({ ...base, outcome: 'skipped-missing' })
      continue
    }
    // Home targets are WorkWise-owned directories. Once one exists—even if it
    // is intentionally empty—it is authoritative and must not be re-imported.
    if (existsSync(nextPath)) {
      results.push({ ...base, outcome: 'target-exists' })
      continue
    }
    try {
      const imported = copyDirectoryOnce(legacyPath, nextPath)
      results.push({ ...base, outcome: imported ? 'imported' : 'target-exists' })
      if (imported) log('legacy-import: copied home data into WorkWise', { legacyPath, nextPath })
    } catch (error) {
      log('legacy-import: home data copy failed; source remains untouched', {
        legacyPath,
        nextPath,
        message: error instanceof Error ? error.message : String(error)
      })
      results.push({ ...base, outcome: 'failed' })
    }
  }
  return results
}

/** Legacy settings are imported by JsonSettingsStore and are never rewritten. */
export function rewriteLegacyPathsInSettingsFile(): false {
  return false
}

export function runLegacyDataImport(input: {
  userDataPath: string
  homeDir: string
  log?: MigrationLogger
}): LegacyDataMigrationResult {
  const log = input.log ?? noopLog
  let userData: UserDataMigrationResult = {
    userDataPath: input.userDataPath,
    migrated: false,
    usedLegacyFallback: false
  }
  try {
    userData = migrateLegacyUserDataDir({ userDataPath: input.userDataPath, log })
  } catch (error) {
    log('legacy-import: unexpected user data failure', error)
  }

  let home: HomeDataMigrationResult[] = []
  try {
    home = migrateLegacyHomeDataDirs({ homeDir: input.homeDir, log })
  } catch (error) {
    log('legacy-import: unexpected home data failure', error)
  }

  return { userData, home, settingsRewritten: false }
}
