import { lstat, readdir, realpath, stat } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'

export const SKILL_PACKAGE_LIMITS = Object.freeze({
  maxFiles: 512,
  maxTotalBytes: 8 * 1024 * 1024,
  maxFileBytes: 1024 * 1024,
  maxDepth: 16
})

// WorkWise only reads metadata from already-installed Codex plugin Skills. Some
// trusted template plugins intentionally include reference documents larger than
// the network-install limit, so discovery gets a separate bounded profile. The
// stricter SKILL_PACKAGE_LIMITS remain mandatory for every install/update path.
export const TRUSTED_SKILL_DISCOVERY_LIMITS = Object.freeze({
  maxFiles: 2_048,
  maxTotalBytes: 64 * 1024 * 1024,
  maxFileBytes: 16 * 1024 * 1024,
  maxDepth: 16
})

// Bundled skills ship inside the WorkWise app and are audited by maintainers
// before release. They may legitimately exceed the network-install limits
// (e.g. PPT Master carries ~250 Python scripts plus SVG templates). This
// profile applies only to installBundledSkill, never to GitHub/remote installs.
export const BUNDLED_SKILL_LIMITS = Object.freeze({
  maxFiles: 1_024,
  maxTotalBytes: 16 * 1024 * 1024,
  maxFileBytes: 4 * 1024 * 1024,
  maxDepth: 16
})

export type SkillPackageLimits = {
  maxFiles: number
  maxTotalBytes: number
  maxFileBytes: number
  maxDepth: number
}

export type SkillPackageValidation = {
  files: number
  totalBytes: number
}

export type SkillPackageValidationOptions = {
  /**
   * Discovery-only mode for already-installed trusted plugin folders. Reference
   * assets may contain links or exceed the install limit; skip those entries
   * without following them. The skill entry itself is always validated.
   */
  skipUnsafeNonEntryFiles?: boolean
  /** Allow a trusted local package to point its entry file at an existing file. */
  allowTrustedEntryLinks?: boolean
  /** Real path roots that an allowed entry link may target. */
  trustedEntryLinkRoots?: string[]
}

function unsafe(message: string): never {
  throw new Error(`Unsafe Skill package: ${message}`)
}

export async function validateSkillPackage(
  root: string,
  limits: SkillPackageLimits = SKILL_PACKAGE_LIMITS,
  options: SkillPackageValidationOptions = {}
): Promise<SkillPackageValidation> {
  const rootPath = resolve(root)
  const rootInfo = await lstat(rootPath)
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) unsafe('root must be a real directory.')
  // Compare canonical paths on both sides, including macOS /var -> /private/var.
  const trustedRoots = options.allowTrustedEntryLinks
    ? (await Promise.all((options.trustedEntryLinkRoots ?? []).map((root) => realpath(resolve(root)).catch(() => undefined)))).filter((root): root is string => Boolean(root))
    : []

  let files = 0
  let totalBytes = 0
  const collisionKeys = new Set<string>()
  const stack: Array<{ path: string; depth: number }> = [{ path: rootPath, depth: 0 }]

  while (stack.length > 0) {
    const current = stack.pop()!
    if (current.depth > limits.maxDepth) {
      unsafe(`directory depth exceeds ${limits.maxDepth}.`)
    }
    const entries = await readdir(current.path, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name === '.git') unsafe('Git repositories and submodules are not allowed.')
      const absolute = resolve(current.path, entry.name)
      const rel = relative(rootPath, absolute)
      if (!rel || rel.startsWith('..') || rel.split(sep).includes('..')) unsafe('path escapes package root.')
      const collisionKey = rel.replaceAll('\\', '/').normalize('NFC').toLowerCase()
      if (collisionKeys.has(collisionKey)) unsafe(`path collision at ${rel}.`)
      collisionKeys.add(collisionKey)

      const info = await lstat(absolute)
      const isEntryFile = rel === 'SKILL.md' || rel === 'skill.json'
      if (info.isSymbolicLink()) {
        if (options.allowTrustedEntryLinks && isEntryFile) {
          const targetPath = await realpath(absolute).catch(() => undefined)
          const targetIsTrusted = Boolean(targetPath) && trustedRoots.some((trustedRoot) => {
            const targetRelative = relative(trustedRoot, targetPath!)
            return targetRelative === '' || (!targetRelative.startsWith('..') && !targetRelative.split(sep).includes('..'))
          })
          if (!targetIsTrusted) unsafe(`entry link target escapes trusted roots: ${rel}.`)
          const target = await stat(absolute).catch(() => undefined)
          if (!target?.isFile()) unsafe(`entry link target is not a regular file: ${rel}.`)
          files += 1
          totalBytes += target.size
          if (files > limits.maxFiles) unsafe(`file count exceeds ${limits.maxFiles}.`)
          if (target.size > limits.maxFileBytes) unsafe(`file exceeds ${formatBytes(limits.maxFileBytes)}: ${rel}.`)
          if (totalBytes > limits.maxTotalBytes) unsafe(`package exceeds ${formatBytes(limits.maxTotalBytes)}.`)
          continue
        }
        if (options.skipUnsafeNonEntryFiles && !isEntryFile) continue
        unsafe(`links and junctions are not allowed: ${rel}.`)
      }
      if (info.isDirectory()) {
        stack.push({ path: absolute, depth: current.depth + 1 })
        continue
      }
      if (!info.isFile()) unsafe(`special file is not allowed: ${rel}.`)
      if (options.skipUnsafeNonEntryFiles && !isEntryFile && info.size > limits.maxFileBytes) {
        continue
      }
      files += 1
      totalBytes += info.size
      if (files > limits.maxFiles) unsafe(`file count exceeds ${limits.maxFiles}.`)
      if (info.size > limits.maxFileBytes) unsafe(`file exceeds ${formatBytes(limits.maxFileBytes)}: ${rel}.`)
      if (totalBytes > limits.maxTotalBytes) unsafe(`package exceeds ${formatBytes(limits.maxTotalBytes)}.`)
    }
  }

  if (files === 0) unsafe('package is empty.')
  return { files, totalBytes }
}

function formatBytes(bytes: number): string {
  if (bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)} MiB`
  if (bytes % 1024 === 0) return `${bytes / 1024} KiB`
  return `${bytes} bytes`
}
