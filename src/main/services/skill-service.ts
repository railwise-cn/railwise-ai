import { existsSync, readdirSync } from 'node:fs'
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import type { AppSettingsV1 } from '../../shared/app-settings'
import type { InstalledPackageV1 } from '../../shared/marketplace'
import type {
  BundledSkillInstallResult,
  BundledSkillSource,
  GithubSkillInstallResult,
  GithubSkillSource,
  GithubSkillSyncResult,
  SkillListItem
} from '../../shared/workwise-api'
import { systemFetch } from './system-network'
import { expandHomePath, normalizeSkillFolderName } from './workspace-service'
import { LEGACY_SKILL_SOURCE_METADATA_FILE } from '../compat/legacy-metadata'
import { resolveContainedPath } from './canonical-containment'
import { inspectPackageDirectory, PackageInstallationService } from './package-installation-service'
import {
  BUNDLED_SKILL_LIMITS,
  SKILL_PACKAGE_LIMITS,
  TRUSTED_SKILL_DISCOVERY_LIMITS,
  validateSkillPackage
} from './skill-package-security'

export type GuiSkillScope = 'project' | 'global'
export type GuiSkillSource = NonNullable<SkillListItem['source']>

export type GuiSkillSummary = {
  id: string
  name: string
  description?: string
  version?: string
  updateSource?: string
  root: string
  entryPath: string
  scope: GuiSkillScope
  legacy: boolean
  source?: GuiSkillSource
}

export type GuiSkillListResult =
  | { ok: true; skills: GuiSkillSummary[]; validationErrors: Array<{ root: string; message: string }> }
  | { ok: false; message: string }

export type GuiSkillRoot = {
  path: string
  scope: GuiSkillScope
  validation: 'strict' | 'trusted-plugin'
}

type GithubSkillSourceMetadata = Extract<GuiSkillSource, { type: 'github' }> & {
  installedAt?: string
}

type BundledSkillSourceMetadata = Extract<GuiSkillSource, { type: 'bundled' }> & {
  installedAt?: string
}

type SkillSourceMetadata = GithubSkillSourceMetadata | BundledSkillSourceMetadata

type GithubContentEntry = {
  name?: string
  path?: string
  type?: string
  size?: number
}

type GithubCommitResponse = {
  sha?: string
}

const SKILL_SOURCE_METADATA_FILE = '.workwise-skill-source.json'
const DEFAULT_GITHUB_REF = 'main'
const MAX_GITHUB_SKILL_FILES = 512
const MAX_GITHUB_SKILL_BYTES = 8 * 1024 * 1024

export async function guiSkillRootsForRuntime(
  settings: AppSettingsV1 | undefined,
  workspaceRootOverride?: string
): Promise<GuiSkillRoot[]> {
  if (!settings && !workspaceRootOverride) return []
  const workspaceRoots = uniqueStrings([
    workspaceRootOverride,
    settings?.workspaceRoot,
    settings?.claw.im.workspaceRoot,
    settings?.schedule.defaultWorkspaceRoot,
    ...(settings?.claw.channels.map((channel) => channel.workspaceRoot) ?? []),
    ...(settings?.claw.tasks.map((task) => task.workspaceRoot) ?? []),
    ...(settings?.schedule.tasks.map((task) => task.workspaceRoot) ?? [])
  ].map(normalizeSkillRootPath).filter(Boolean))
  const projectRoots = workspaceRoots.flatMap((workspaceRoot) => [
    join(workspaceRoot, '.codex', 'skills'),
    join(workspaceRoot, '.agents', 'skills'),
    join(workspaceRoot, 'skills')
  ])
  const globalRoots = [
    join(
      process.env.WORKWISE_TOOLS_ROOT?.trim() || join(homedir(), '.workwise', 'tools'),
      'skills'
    ),
    process.env.CODEX_HOME ? join(normalizeSkillRootPath(process.env.CODEX_HOME), 'skills') : '',
    join(homedir(), '.codex', 'skills'),
    join(homedir(), '.agents', 'skills'),
    join(homedir(), '.workwise', 'skills'),
    join(homedir(), '.kun', 'skills'),
    ...bundledSkillRootCandidates()
  ]
  // The Codex home skill folder is an already-installed local source. Its
  // entry files remain strict, while optional reference links/assets can be
  // skipped during discovery without being followed or read.
  const trustedGlobalRoots = new Set([
    normalizeSkillRootPath(process.env.CODEX_HOME ? join(process.env.CODEX_HOME, 'skills') : ''),
    normalizeSkillRootPath(join(homedir(), '.codex', 'skills'))
  ].filter(Boolean))
  const codexPluginRoots = await discoverCodexPluginSkillRoots()
  const workwisePluginRoots = await discoverInstalledPluginSkillRoots()
  const configuredExtraRoots = [
    ...(settings?.claw.skills.extraDirs ?? []),
    ...(settings?.schedule.skills.extraDirs ?? [])
  ].map(normalizeSkillRootPath)

  return uniqueSkillRoots([
    ...projectRoots
      .filter((root) => existsSync(root))
      .map((path) => ({ path, scope: 'project' as const, validation: 'strict' as const })),
    ...globalRoots
      .filter((root) => existsSync(root))
      .map((path) => ({
        path,
        scope: 'global' as const,
        validation: trustedGlobalRoots.has(normalizeSkillRootPath(path))
          ? 'trusted-plugin' as const
          : 'strict' as const
      })),
    ...codexPluginRoots
      .filter((root) => existsSync(root))
      .map((path) => ({ path, scope: 'global' as const, validation: 'trusted-plugin' as const })),
    ...workwisePluginRoots
      .filter((root) => existsSync(root))
      .map((path) => ({ path, scope: 'global' as const, validation: 'trusted-plugin' as const })),
    ...configuredExtraRoots
      .filter(Boolean)
      .map((path) => ({
        path,
        scope: scopeForConfiguredRoot(path, workspaceRoots),
        validation: 'strict' as const
      }))
  ])
}

export async function listGuiSkills(
  settings: AppSettingsV1,
  workspaceRootOverride?: string
): Promise<GuiSkillListResult> {
  try {
    const roots = await guiSkillRootsForRuntime(settings, workspaceRootOverride)
    const skills: GuiSkillSummary[] = []
    const validationErrors: Array<{ root: string; message: string }> = []
    for (const root of roots) {
      const candidates = await packageCandidates(root.path).catch((error) => {
        validationErrors.push({ root: root.path, message: errorMessage(error) })
        return []
      })
      for (const candidate of candidates) {
        const loaded = await loadSkillSummary(candidate, root.scope, root.validation).catch((error) => {
          validationErrors.push({ root: candidate, message: errorMessage(error) })
          return null
        })
        if (loaded) skills.push(loaded)
      }
    }
    return {
      ok: true,
      skills: dedupeSkills(skills),
      validationErrors
    }
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }
}

export function normalizeSkillRootPath(path: string | undefined): string {
  const trimmed = path?.trim() ?? ''
  if (!trimmed) return ''
  return resolve(expandHomePath(trimmed))
}

export async function installGithubSkill(
  rootPath: string,
  source: GithubSkillSource
): Promise<GithubSkillInstallResult> {
  try {
    const root = normalizeSkillRootPath(rootPath)
    if (!root) return { ok: false, message: 'Skill directory is required.' }
    const skillName = normalizeSkillFolderName(
      source.skillName || basename(normalizeGithubPath(source.path)) || source.repo
    )
    const ref = normalizeGithubRef(source.ref)
    const targetDir = join(root, skillName)
    const requestedSource: GithubSkillSourceMetadata = {
      type: 'github',
      owner: source.owner.trim(),
      repo: source.repo.trim(),
      path: normalizeGithubPath(source.path),
      ref,
      autoUpdate: false,
      ...(normalizeGithubIncludePaths(source.includePaths).length
        ? { includePaths: normalizeGithubIncludePaths(source.includePaths) }
        : {}),
      ...(normalizeBundledSkillOverlayId(source.overlaySkillId)
        ? { overlaySkillId: normalizeBundledSkillOverlayId(source.overlaySkillId) }
        : {})
    }

    await assertCanInstallIntoTarget(targetDir, requestedSource)

    const latestSha = await fetchGithubCommitSha(requestedSource)
    const existingSource = await readSkillSourceMetadata(targetDir).catch(() => undefined)
    const entryPath = join(targetDir, 'SKILL.md')
    if (
      existingSource?.type === 'github' &&
      existingSource.installedSha === latestSha &&
      skillSourceMatches(existingSource, requestedSource) &&
      existsSync(entryPath)
    ) {
      return { ok: true, path: entryPath, sha: latestSha, updated: false }
    }

    await mkdir(root, { recursive: true })
    const tempDir = await mkdtemp(join(root, `.workwise-install-${skillName}-`))
    try {
      await downloadGithubSkillDirectory({ ...requestedSource, ref: latestSha }, tempDir)
      await writeSkillSourceMetadata(tempDir, {
        ...requestedSource,
        installedSha: latestSha,
        installedAt: new Date().toISOString()
      })
      await validateSkillPackage(tempDir)
      await replaceSkillDirectory(targetDir, tempDir)
    } catch (error) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }

    return { ok: true, path: join(targetDir, 'SKILL.md'), sha: latestSha, updated: true }
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }
}

export async function installBundledSkill(
  rootPath: string,
  source: BundledSkillSource
): Promise<BundledSkillInstallResult> {
  try {
    const root = rootPath === 'railwise:global-skills'
      ? join(process.env.WORKWISE_TOOLS_ROOT?.trim() || join(homedir(), '.workwise', 'tools'), 'skills')
      : normalizeSkillRootPath(rootPath)
    if (!root) return { ok: false, message: 'Skill directory is required.' }
    const bundleId = normalizeSkillFolderName(source.id)
    const skillName = normalizeSkillFolderName(source.skillName || bundleId)
    const sourceDir = resolveBundledSkillDirectory(bundleId)
    if (!sourceDir) {
      return { ok: false, message: `Bundled Skill is not available: ${bundleId}` }
    }

    const targetDir = join(root, skillName)
    const requestedSource: SkillSourceMetadata = await readSkillSourceMetadata(sourceDir).then((metadata) =>
      metadata?.type === 'github' ? metadata : undefined
    ).catch(() => undefined) ?? {
      type: 'bundled',
      id: bundleId,
      autoUpdate: false
    }
    await assertCanInstallIntoTarget(targetDir, requestedSource)
    await validateSkillPackage(sourceDir, BUNDLED_SKILL_LIMITS)

    await mkdir(root, { recursive: true })
    const tempDir = await mkdtemp(join(root, `.workwise-install-${skillName}-`))
    try {
      await cp(sourceDir, tempDir, {
        recursive: true,
        force: true,
        filter: (sourcePath) => {
          const normalized = sourcePath.replaceAll('\\', '/')
          return !normalized.split('/').includes('__pycache__') &&
            !/\.(?:pyc|pyo)$/i.test(normalized)
        }
      })
      await writeSkillSourceMetadata(tempDir, {
        ...requestedSource,
        installedAt: new Date().toISOString()
      })
      await validateSkillPackage(tempDir, BUNDLED_SKILL_LIMITS)
      await replaceSkillDirectory(targetDir, tempDir)
    } catch (error) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }

    return { ok: true, path: join(targetDir, 'SKILL.md'), updated: true }
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }
}

export async function syncGithubManagedSkills(
  settings: AppSettingsV1,
  workspaceRootOverride?: string
): Promise<GithubSkillSyncResult> {
  try {
    const roots = await guiSkillRootsForRuntime(settings, workspaceRootOverride)
    const seen = new Set<string>()
    let checked = 0
    let updated = 0
    const errors: Array<{ path: string; message: string }> = []

    for (const root of roots) {
      const candidates = await packageCandidates(root.path).catch((error) => {
        errors.push({ path: root.path, message: errorMessage(error) })
        return []
      })
      for (const candidate of candidates) {
        const candidateKey = comparablePath(candidate)
        if (seen.has(candidateKey)) continue
        seen.add(candidateKey)
        const source = await readSkillSourceMetadata(candidate).catch((error) => {
          errors.push({ path: candidate, message: errorMessage(error) })
          return undefined
        })
        if (source?.type !== 'github' || source.autoUpdate === false) continue
        checked += 1
        const result = await installGithubSkill(dirname(candidate), {
          owner: source.owner,
          repo: source.repo,
          path: source.path,
          ref: source.ref,
          skillName: basename(candidate),
          autoUpdate: source.autoUpdate,
          ...(source.includePaths?.length ? { includePaths: source.includePaths } : {}),
          ...(source.overlaySkillId ? { overlaySkillId: source.overlaySkillId } : {})
        })
        if (result.ok) {
          if (result.updated) updated += 1
        } else {
          errors.push({ path: candidate, message: result.message })
        }
      }
    }

    return { ok: true, checked, updated, errors }
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }
}

async function discoverCodexPluginSkillRoots(): Promise<string[]> {
  const roots: string[] = []
  const codexHome = normalizeSkillRootPath(process.env.CODEX_HOME || join(homedir(), '.codex'))
  await collectSkillRoots(join(codexHome, 'plugins', 'cache'), roots, 0, 5)
  return roots
}

async function readOptionalJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink() || !info.isFile() || info.size > 1024 * 1024) return null
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

async function installedPackageContainsSkills(root: string): Promise<boolean> {
  const catalog = await readOptionalJson(join(root, 'workwise.catalog.json'))
  const nativeManifest = catalog ?? await readOptionalJson(join(root, 'workwise.plugin.json'))
  if (nativeManifest && Array.isArray(nativeManifest.components)) {
    return nativeManifest.components.some((component) =>
      component && typeof component === 'object' && !Array.isArray(component) &&
      (component as Record<string, unknown>).type === 'skill'
    )
  }
  const codex = await readOptionalJson(join(root, '.codex-plugin', 'plugin.json'))
  return typeof codex?.skills === 'string' && codex.skills.trim().length > 0
}

export async function discoverInstalledPluginSkillRoots(
  records?: InstalledPackageV1[]
): Promise<string[]> {
  const installed = records ?? await new PackageInstallationService().list().catch(() => [])
  const roots: string[] = []
  for (const record of installed) {
    if (!await installedPackageContainsSkills(record.artifact.location)) continue
    const inspection = await inspectPackageDirectory(record.artifact.location).catch(() => null)
    if (!inspection || inspection.sha256 !== record.artifact.sha256) continue
    await collectInstalledSkillRoots(record.artifact.location, roots, 0, 6)
  }
  return uniqueStrings(roots)
}

async function collectInstalledSkillRoots(
  root: string,
  roots: string[],
  depth: number,
  maxDepth: number
): Promise<void> {
  if (depth > maxDepth || !existsSync(root)) return
  if (skillRootHasPackages(root)) {
    roots.push(root)
    return
  }
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  await Promise.all(entries
    .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules')
    .map((entry) => collectInstalledSkillRoots(join(root, entry.name), roots, depth + 1, maxDepth)))
}

async function collectSkillRoots(root: string, roots: string[], depth: number, maxDepth: number): Promise<void> {
  if (depth > maxDepth || !existsSync(root)) return
  if (basename(root) === 'skills' && skillRootHasPackages(root)) {
    roots.push(root)
    return
  }
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => collectSkillRoots(join(root, entry.name), roots, depth + 1, maxDepth)))
}

function skillRootHasPackages(root: string): boolean {
  if (existsSync(join(root, 'SKILL.md')) || existsSync(join(root, 'skill.json'))) return true
  try {
    return readdirSync(root, { withFileTypes: true }).some((entry) =>
      entry.isDirectory() &&
      (existsSync(join(root, entry.name, 'SKILL.md')) || existsSync(join(root, entry.name, 'skill.json')))
    )
  } catch {
    return false
  }
}

async function packageCandidates(root: string): Promise<string[]> {
  const candidates = new Set<string>()
  if (existsSync(join(root, 'skill.json')) || existsSync(join(root, 'SKILL.md'))) {
    candidates.add(root)
  }
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(root, entry.name)
    if (existsSync(join(dir, 'skill.json')) || existsSync(join(dir, 'SKILL.md'))) {
      candidates.add(dir)
    }
  }
  return [...candidates]
}

async function loadSkillSummary(
  root: string,
  scope: GuiSkillScope,
  validation: GuiSkillRoot['validation']
): Promise<GuiSkillSummary | null> {
  const storedSource = await readSkillSourceMetadata(root).catch(() => undefined)
  const usesAuditedBundleLimits = validation === 'strict' &&
    await matchesAuditedBundledSource(storedSource)
  await validateSkillPackage(
    root,
    validation === 'trusted-plugin'
      ? TRUSTED_SKILL_DISCOVERY_LIMITS
      : usesAuditedBundleLimits
        ? BUNDLED_SKILL_LIMITS
        : SKILL_PACKAGE_LIMITS,
    validation === 'trusted-plugin'
      ? {
          skipUnsafeNonEntryFiles: true,
          allowTrustedEntryLinks: true,
          trustedEntryLinkRoots: [
            root,
            join(homedir(), '.gstack', 'repos')
          ]
        }
      : undefined
  )
  const source = sourceForList(storedSource, root)
  const manifestPath = join(root, 'skill.json')
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
    const name = stringValue(manifest.name) || titleFromSlug(basename(root))
    const entry = stringValue(manifest.entry) || 'SKILL.md'
    const entryPath = await resolveContainedPath({
      root,
      target: entry,
      mustExist: true,
      expect: 'file'
    })
    return {
      id: slug(stringValue(manifest.id) || name || basename(root)),
      name,
      ...(stringValue(manifest.description) ? { description: stringValue(manifest.description) } : {}),
      ...(stringValue(manifest.version) ? { version: stringValue(manifest.version) } : {}),
      ...(source?.type === 'github'
        ? { updateSource: `https://github.com/${source.owner}/${source.repo}` }
        : source?.type === 'bundled'
          ? { updateSource: 'RailWise AI bundled assets' }
          : { updateSource: 'Local folder' }),
      root,
      entryPath,
      scope,
      legacy: false,
      ...(source ? { source } : {})
    }
  }
  const entryPath = join(root, 'SKILL.md')
  if (!existsSync(entryPath)) return null
  const content = await readFile(entryPath, 'utf8')
  const frontmatter = readFrontmatter(content)
  const name = displaySkillName(frontmatter.name, basename(root))
  return {
    id: slug(frontmatter.id || basename(root)),
    name,
    ...(frontmatter.description ? { description: frontmatter.description } : {}),
    ...(frontmatter.version ? { version: frontmatter.version } : {}),
    ...(source?.type === 'github'
      ? { updateSource: `https://github.com/${source.owner}/${source.repo}` }
      : source?.type === 'bundled'
        ? { updateSource: 'RailWise AI bundled assets' }
        : { updateSource: 'Local folder' }),
    root,
    entryPath,
    scope,
    legacy: true,
    ...(source ? { source } : {})
  }
}

async function matchesAuditedBundledSource(
  source: SkillSourceMetadata | undefined
): Promise<boolean> {
  if (!source) return false
  const bundleId = source.type === 'bundled' ? source.id : source.overlaySkillId
  if (!bundleId || source.autoUpdate !== false) return false
  const bundleRoot = resolveBundledSkillDirectory(bundleId)
  if (!bundleRoot) return false
  const auditedSource = await readSkillSourceMetadata(bundleRoot).catch(() => undefined)
  if (!auditedSource || !skillSourceMatches(source, auditedSource)) return false
  if (source.type === 'github' && auditedSource.type === 'github') {
    return Boolean(
      source.installedSha &&
      auditedSource.installedSha &&
      source.installedSha === auditedSource.installedSha
    )
  }
  return source.type === 'bundled' && auditedSource.type === 'bundled'
}

async function assertCanInstallIntoTarget(targetDir: string, source: SkillSourceMetadata): Promise<void> {
  if (!existsSync(targetDir)) return
  const info = await lstat(targetDir)
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`Skill target is not a safe directory: ${basename(targetDir)}.`)
  }
  const existing = await readSkillSourceMetadata(targetDir).catch(() => undefined)
  if (skillSourceCanReplace(existing, source)) return
  throw new Error(`Skill "${basename(targetDir)}" already exists and is not managed by this source.`)
}

async function replaceSkillDirectory(targetDir: string, tempDir: string): Promise<void> {
  const backupDir = `${targetDir}.workwise-backup-${randomUUID()}`
  const hadTarget = existsSync(targetDir)
  if (hadTarget) await rename(targetDir, backupDir)
  try {
    await rename(tempDir, targetDir)
    await rm(backupDir, { recursive: true, force: true })
  } catch (error) {
    if (hadTarget && !existsSync(targetDir) && existsSync(backupDir)) {
      await rename(backupDir, targetDir).catch(() => undefined)
    }
    throw error
  }
}

async function writeSkillSourceMetadata(root: string, source: SkillSourceMetadata): Promise<void> {
  await writeFile(
    join(root, SKILL_SOURCE_METADATA_FILE),
    `${JSON.stringify(source, null, 2)}\n`,
    'utf8'
  )
}

async function readSkillSourceMetadata(root: string): Promise<SkillSourceMetadata | undefined> {
  const path = [SKILL_SOURCE_METADATA_FILE, LEGACY_SKILL_SOURCE_METADATA_FILE]
    .map((name) => join(root, name))
    .find((candidate) => existsSync(candidate))
  if (!path) return undefined
  const raw = JSON.parse(await readFile(path, 'utf8')) as unknown
  const record = objectValue(raw)
  if (!record) return undefined
  if (record.type === 'github') {
    const owner = stringValue(record.owner)
    const repo = stringValue(record.repo)
    if (!owner || !repo) return undefined
    return {
      type: 'github',
      owner,
      repo,
      path: normalizeGithubPath(stringValue(record.path)),
      ref: normalizeGithubRef(stringValue(record.ref)),
      ...(stringValue(record.installedSha) ? { installedSha: stringValue(record.installedSha) } : {}),
      autoUpdate: false,
      ...(normalizeGithubIncludePaths(arrayStringValue(record.includePaths)).length
        ? { includePaths: normalizeGithubIncludePaths(arrayStringValue(record.includePaths)) }
        : {}),
      ...(normalizeBundledSkillOverlayId(stringValue(record.overlaySkillId))
        ? { overlaySkillId: normalizeBundledSkillOverlayId(stringValue(record.overlaySkillId)) }
        : {}),
      ...(stringValue(record.installedAt) ? { installedAt: stringValue(record.installedAt) } : {})
    }
  }
  if (record.type === 'bundled') {
    const id = stringValue(record.id)
    if (!id) return undefined
    return {
      type: 'bundled',
      id,
      autoUpdate: false,
      ...(stringValue(record.installedAt) ? { installedAt: stringValue(record.installedAt) } : {})
    }
  }
  return undefined
}

function sourceForList(source: SkillSourceMetadata | undefined, root?: string): GuiSkillSource | undefined {
  if (!source) {
    const bundledRoot = root && bundledSkillRootCandidates().find((candidate) =>
      root === candidate || root.startsWith(candidate + sep))
    return bundledRoot
      ? { type: 'bundled', id: basename(root), autoUpdate: false }
      : undefined
  }
  if (source.type === 'github') {
    return {
      type: 'github',
      owner: source.owner,
      repo: source.repo,
      path: source.path,
      ref: source.ref,
      ...(source.installedSha ? { installedSha: source.installedSha } : {}),
      autoUpdate: source.autoUpdate,
      ...(source.includePaths?.length ? { includePaths: source.includePaths } : {}),
      ...(source.overlaySkillId ? { overlaySkillId: source.overlaySkillId } : {})
    }
  }
  return {
    type: 'bundled',
    id: source.id,
    autoUpdate: false
  }
}

function skillSourceMatches(left: SkillSourceMetadata | undefined, right: SkillSourceMetadata): boolean {
  if (!left || left.type !== right.type) return false
  if (left.type === 'bundled' && right.type === 'bundled') {
    return left.id === right.id
  }
  if (left.type === 'github' && right.type === 'github') {
    return githubSkillSourceBaseMatches(left, right) &&
      normalizedStringArraysEqual(left.includePaths ?? [], right.includePaths ?? []) &&
      (left.overlaySkillId ?? '') === (right.overlaySkillId ?? '')
  }
  return false
}

function skillSourceCanReplace(left: SkillSourceMetadata | undefined, right: SkillSourceMetadata): boolean {
  if (!left || left.type !== right.type) return false
  if (left.type === 'bundled' && right.type === 'bundled') return left.id === right.id
  if (left.type === 'github' && right.type === 'github') return githubSkillSourceBaseMatches(left, right)
  return false
}

function githubSkillSourceBaseMatches(left: GithubSkillSourceMetadata, right: GithubSkillSourceMetadata): boolean {
  return left.owner.toLowerCase() === right.owner.toLowerCase() &&
    left.repo.toLowerCase() === right.repo.toLowerCase() &&
    normalizeGithubPath(left.path) === normalizeGithubPath(right.path) &&
    normalizeGithubRef(left.ref) === normalizeGithubRef(right.ref)
}

async function fetchGithubCommitSha(source: GithubSkillSourceMetadata): Promise<string> {
  const url = `https://api.github.com/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/commits/${encodeURIComponent(source.ref)}`
  const commit = await fetchGithubJson<GithubCommitResponse>(url)
  const sha = stringValue(commit.sha)
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(sha)) {
    throw new Error(`GitHub commit SHA is invalid for ${source.owner}/${source.repo}@${source.ref}.`)
  }
  return sha
}

async function downloadGithubSkillDirectory(
  source: GithubSkillSourceMetadata,
  destination: string
): Promise<void> {
  const state = { files: 0, bytes: 0 }
  if (source.includePaths?.length) {
    await mkdir(destination, { recursive: true })
    for (const includePath of source.includePaths) {
      const relativePath = normalizeGithubPath(includePath)
      const githubPath = normalizeGithubPath([source.path, relativePath].filter(Boolean).join('/'))
      const localPath = relativePath ? join(destination, ...relativePath.split('/')) : destination
      await downloadGithubEntry(source, githubPath, localPath, state)
    }
  } else {
    await downloadGithubDirectory(source, source.path, destination, state)
  }
  await applyBundledSkillOverlay(source, destination)
  if (!existsSync(join(destination, 'SKILL.md')) && !existsSync(join(destination, 'skill.json'))) {
    throw new Error('GitHub Skill directory must contain SKILL.md or skill.json.')
  }
  await validateSkillPackage(destination)
}

async function downloadGithubEntry(
  source: GithubSkillSourceMetadata,
  githubPath: string,
  destination: string,
  state: { files: number; bytes: number }
): Promise<void> {
  const entry = await fetchGithubJson<GithubContentEntry[] | GithubContentEntry>(
    githubContentsUrl(source, githubPath)
  )
  if (Array.isArray(entry)) {
    await downloadGithubDirectory(source, githubPath, destination, state)
    return
  }
  if (entry.type !== 'file') {
    throw new Error(`GitHub path is not a file or directory: ${githubPath || '/'}`)
  }
  await downloadGithubFile(source, entry, destination, state)
}

async function downloadGithubDirectory(
  source: GithubSkillSourceMetadata,
  githubPath: string,
  destination: string,
  state: { files: number; bytes: number },
  depth = 0
): Promise<void> {
  if (depth > SKILL_PACKAGE_LIMITS.maxDepth) {
    throw new Error(`GitHub Skill directory depth exceeds ${SKILL_PACKAGE_LIMITS.maxDepth}.`)
  }
  const entries = await fetchGithubJson<GithubContentEntry[] | GithubContentEntry>(
    githubContentsUrl(source, githubPath)
  )
  if (!Array.isArray(entries)) {
    throw new Error(`GitHub path is not a directory: ${githubPath || '/'}`)
  }
  await mkdir(destination, { recursive: true })
  for (const entry of entries) {
    const entryName = normalizeGithubEntryName(entry.name)
    const entryPath = normalizeGithubPath(stringValue(entry.path))
    if (entry.type === 'dir') {
      await downloadGithubDirectory(source, entryPath, join(destination, entryName), state, depth + 1)
      continue
    }
    if (entry.type !== 'file') {
      throw new Error(`GitHub Skill contains an unsupported entry type: ${entryPath}.`)
    }
    await downloadGithubFile(source, entry, join(destination, entryName), state)
  }
}

async function downloadGithubFile(
  source: GithubSkillSourceMetadata,
  entry: GithubContentEntry,
  destination: string,
  state: { files: number; bytes: number }
): Promise<void> {
  const entryPath = normalizeGithubPath(stringValue(entry.path))
  const token = githubToken()
  const downloadUrl = token
    ? githubContentsUrl(source, entryPath)
    : githubRawFileUrl(source, entryPath)
  state.files += 1
  if (state.files > MAX_GITHUB_SKILL_FILES) {
    throw new Error(`GitHub Skill has too many files; limit is ${MAX_GITHUB_SKILL_FILES}.`)
  }
  const size = typeof entry.size === 'number' && Number.isFinite(entry.size) ? entry.size : 0
  if (size > SKILL_PACKAGE_LIMITS.maxFileBytes) {
    throw new Error(`GitHub Skill file exceeds 1 MiB: ${entryPath}.`)
  }
  state.bytes += Math.max(0, size)
  if (state.bytes > MAX_GITHUB_SKILL_BYTES) {
    throw new Error(`GitHub Skill is too large; limit is ${Math.round(MAX_GITHUB_SKILL_BYTES / 1024 / 1024)}MB.`)
  }
  const bytes = await fetchGithubBytes(downloadUrl, token
    ? { ...githubHeaders(), Accept: 'application/vnd.github.raw+json' }
    : { 'User-Agent': 'RailWise AI' })
  if (bytes.length > SKILL_PACKAGE_LIMITS.maxFileBytes) {
    throw new Error(`GitHub Skill file exceeds 1 MiB: ${entryPath}.`)
  }
  state.bytes += Math.max(0, bytes.length - size)
  if (state.bytes > MAX_GITHUB_SKILL_BYTES) {
    throw new Error(`GitHub Skill is too large; limit is ${Math.round(MAX_GITHUB_SKILL_BYTES / 1024 / 1024)}MB.`)
  }
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, bytes)
}

async function applyBundledSkillOverlay(
  source: GithubSkillSourceMetadata,
  destination: string
): Promise<void> {
  const overlayId = normalizeBundledSkillOverlayId(source.overlaySkillId)
  if (!overlayId) return
  const overlayDir = resolveBundledSkillDirectory(overlayId)
  if (!overlayDir) throw new Error(`Bundled Skill overlay is not available: ${overlayId}`)
  const overlaySkill = join(overlayDir, 'SKILL.md')
  if (existsSync(overlaySkill)) {
    await cp(overlaySkill, join(destination, 'SKILL.md'), { force: true })
  }
  const overlayRequirements = join(overlayDir, 'requirements.txt')
  if (existsSync(overlayRequirements)) {
    await cp(overlayRequirements, join(destination, 'requirements.txt'), { force: true })
  }
  for (const overlayPath of ['examples', 'projects']) {
    const sourcePath = join(overlayDir, overlayPath)
    if (existsSync(sourcePath)) {
      await cp(sourcePath, join(destination, overlayPath), { recursive: true, force: true })
    }
  }
  for (const overlayPath of [
    join('scripts', 'source_to_md', 'doc_to_md.py'),
    join('scripts', 'docs', 'conversion.md'),
    join('scripts', 'update_repo.py')
  ]) {
    const sourcePath = join(overlayDir, overlayPath)
    if (existsSync(sourcePath)) {
      const targetPath = join(destination, overlayPath)
      await mkdir(dirname(targetPath), { recursive: true })
      await cp(sourcePath, targetPath, { force: true })
    }
  }
}

function githubContentsUrl(source: GithubSkillSourceMetadata, githubPath: string): string {
  const path = normalizeGithubPath(githubPath)
  const encodedPath = path ? `/${encodeGithubPath(path)}` : ''
  return `https://api.github.com/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/contents${encodedPath}?ref=${encodeURIComponent(source.ref)}`
}

function githubRawFileUrl(source: GithubSkillSourceMetadata, githubPath: string): string {
  const path = normalizeGithubPath(githubPath)
  if (!path) throw new Error('GitHub file path is required.')
  return `https://raw.githubusercontent.com/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/${encodeURIComponent(source.ref)}/${encodeGithubPath(path)}`
}

async function fetchGithubJson<T>(url: string): Promise<T> {
  const response = await systemFetch(url, { headers: githubHeaders() })
  if (!response.ok) throw await githubResponseError(response)
  return await response.json() as T
}

async function fetchGithubBytes(url: string, headers = githubHeaders()): Promise<Buffer> {
  const response = await systemFetch(url, { headers })
  if (!response.ok) throw await githubResponseError(response)
  return Buffer.from(await response.arrayBuffer())
}

function githubHeaders(): Record<string, string> {
  const token = githubToken()
  return {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'RailWise AI',
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  }
}

function githubToken(): string {
  return (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim()
}

async function githubResponseError(response: Response): Promise<Error> {
  let detail = ''
  try {
    const body = await response.text()
    if (body) detail = ` ${body.slice(0, 300)}`
  } catch {
    /* ignore body read failures */
  }
  const privateHint = response.status === 401 || response.status === 403 || response.status === 404
    ? ' If this is a private repository, set GITHUB_TOKEN or GH_TOKEN before launching RailWise AI.'
    : ''
  return new Error(`GitHub request failed (${response.status} ${response.statusText}).${privateHint}${detail}`)
}

function normalizeGithubPath(path: string | undefined): string {
  const raw = (path ?? '').trim().replace(/\\/g, '/')
  if (raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) {
    throw new Error(`Unsafe GitHub path: ${path ?? ''}`)
  }
  const normalized = raw.replace(/^\/+|\/+$/g, '')
  if (normalized.split('/').some((segment) => segment === '..' || segment === '.')) {
    throw new Error(`Unsafe GitHub path: ${path ?? ''}`)
  }
  return normalized
}

function normalizeGithubIncludePaths(paths: string[] | undefined): string[] {
  return uniqueStrings((paths ?? [])
    .map(normalizeGithubPath)
    .filter(Boolean))
}

function normalizeGithubRef(ref: string | undefined): string {
  return ref?.trim() || DEFAULT_GITHUB_REF
}

function normalizeBundledSkillOverlayId(raw: string | undefined): string {
  const value = raw?.trim() ?? ''
  return value ? normalizeSkillFolderName(value) : ''
}

function normalizeGithubEntryName(name: string | undefined): string {
  const value = name?.trim() ?? ''
  if (!value || value === '.' || value === '..' || /[\\/]/.test(value)) {
    throw new Error(`Unsafe GitHub entry name: ${name ?? ''}`)
  }
  return value
}

function encodeGithubPath(path: string): string {
  return normalizeGithubPath(path).split('/').map(encodeURIComponent).join('/')
}

function bundledSkillRootCandidates(): string[] {
  const resourcesPath = stringValue((process as NodeJS.Process & { resourcesPath?: string }).resourcesPath)
  return uniqueStrings([
    resourcesPath ? join(resourcesPath, 'app.asar.unpacked', 'src', 'asset', 'skills') : '',
    resourcesPath ? join(resourcesPath, 'src', 'asset', 'skills') : '',
    resolve(process.cwd(), 'src', 'asset', 'skills')
  ])
}

export function resolveBundledSkillDirectory(bundleId: string): string | null {
  for (const root of bundledSkillRootCandidates().flatMap(root => [root, join(dirname(root), 'optional-skills')])) {
    const candidate = join(root, bundleId)
    if (existsSync(join(candidate, 'SKILL.md')) || existsSync(join(candidate, 'skill.json'))) {
      return candidate
    }
  }
  return null
}

function readFrontmatter(content: string): { id?: string; name?: string; description?: string; version?: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)
  if (!match) return { description: firstMarkdownParagraph(content) }
  const yaml = match[1] ?? ''
  return {
    id: frontmatterString(yaml, 'id'),
    name: frontmatterString(yaml, 'name'),
    version: frontmatterString(yaml, 'version'),
    description: frontmatterString(yaml, 'description') || firstMarkdownParagraph(content.slice(match[0].length))
  }
}

function frontmatterString(yaml: string, key: string): string | undefined {
  const match = new RegExp(`^${key}:\\s*(.*?)\\s*$`, 'm').exec(yaml)
  if (!match) return undefined
  const scalar = (match[1] ?? '').trim()
  if (scalar !== '>' && scalar !== '|') {
    return stripQuotes(scalar).trim() || undefined
  }

  const start = (match.index ?? 0) + match[0].length
  const lines = yaml.slice(start).replace(/^\r?\n/, '').split(/\r?\n/)
  const block: string[] = []
  for (const line of lines) {
    if (!line.trim()) {
      if (block.length > 0) block.push('')
      continue
    }
    if (!/^\s+/.test(line)) break
    block.push(line.trim())
  }
  const value = scalar === '|'
    ? block.join('\n').trim()
    : block.join(' ').replace(/\s+/g, ' ').trim()
  return value || undefined
}

function firstMarkdownParagraph(markdown: string): string | undefined {
  return markdown
    .split(/\n{2,}/)
    .map((block) => block.replace(/^#+\s*/, '').trim())
    .find(Boolean)
}

function stripQuotes(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function arrayStringValue(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function normalizedStringArraysEqual(left: string[], right: string[]): boolean {
  const normalizedLeft = normalizeGithubIncludePaths(left)
  const normalizedRight = normalizeGithubIncludePaths(right)
  return normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, index) => value === normalizedRight[index])
}

function titleFromSlug(value: string): string {
  return value
    .trim()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

function displaySkillName(frontmatterName: string | undefined, folderName: string): string {
  const value = frontmatterName?.trim() ?? ''
  if ((value || folderName).toLowerCase() === 'ppt-master') return 'PPT Master'
  if (!value) return titleFromSlug(folderName)
  return /^[a-z0-9][a-z0-9_-]*$/i.test(value) ? titleFromSlug(value) : value
}

function slug(value: string): string {
  return value
    .trim()
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '') || 'skill'
}

function dedupeSkills(skills: GuiSkillSummary[]): GuiSkillSummary[] {
  const unique = new Map<string, GuiSkillSummary>()
  for (const skill of skills.sort(compareSkillSummary)) {
    if (!unique.has(skill.id)) unique.set(skill.id, skill)
  }
  return [...unique.values()]
}

function compareSkillSummary(a: GuiSkillSummary, b: GuiSkillSummary): number {
  if (a.scope !== b.scope) return a.scope === 'project' ? -1 : 1
  return a.name.localeCompare(b.name)
}

function scopeForConfiguredRoot(path: string, workspaceRoots: string[]): GuiSkillScope {
  const comparable = comparablePath(path)
  return workspaceRoots.some((workspaceRoot) => {
    const workspace = comparablePath(workspaceRoot)
    return comparable === workspace || comparable.startsWith(`${workspace}/`)
  }) ? 'project' : 'global'
}

function uniqueSkillRoots(roots: GuiSkillRoot[]): GuiSkillRoot[] {
  const indexes = new Map<string, number>()
  const out: GuiSkillRoot[] = []
  for (const root of roots) {
    const key = comparablePath(root.path)
    if (!key) continue
    const existingIndex = indexes.get(key)
    if (existingIndex === undefined) {
      indexes.set(key, out.length)
      out.push(root)
      continue
    }
    if (out[existingIndex]?.validation === 'trusted-plugin' && root.validation === 'strict') {
      out[existingIndex] = root
    }
  }
  return out
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    if (!value || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

function comparablePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/g, '').toLowerCase()
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
