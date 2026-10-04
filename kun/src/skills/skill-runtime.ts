import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, extname, join, resolve, sep } from 'node:path'
import { z } from 'zod'
import type { SkillsCapabilityConfig } from '../contracts/capabilities.js'

const DEFAULT_ACTIVE_LIMIT = 3
const DEFAULT_INSTRUCTION_BUDGET_BYTES = 24_000
const MIN_BUDGETED_SKILL_BYTES = 500
const DEFAULT_DISCOVERY_WAIT_MS = 5_000
const GENERIC_KEYWORDS = new Set([
  '帮我',
  '我要',
  '需要',
  '一个',
  '一份',
  '这个',
  '那个',
  '这些',
  '那些',
  '一下',
  '写一',
  '生成',
  '整理',
  '输出',
  '项目',
  '工作',
  '资料',
  '文档',
  '报告',
  '方案',
  '数据',
  '分析',
  '监测',
  '编制',
  '起草'
])

const SkillTriggerManifest = z.object({
  commands: z.array(z.string().min(1)).default([]),
  promptPatterns: z.array(z.string().min(1)).default([]),
  fileTypes: z.array(z.string().min(1)).default([])
}).default({ commands: [], promptPatterns: [], fileTypes: [] })

export const SkillManifest = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  version: z.string().default('0.0.0'),
  entry: z.string().min(1).default('SKILL.md'),
  triggers: SkillTriggerManifest,
  allowedTools: z.array(z.string().min(1)).default([]),
  assets: z.array(z.string().min(1)).default([]),
  priority: z.number().int().default(0)
}).strict()
export type SkillManifest = z.infer<typeof SkillManifest>

export type LoadedSkill = {
  id: string
  name: string
  description?: string
  version: string
  root: string
  entryPath: string
  entry: string
  triggers: z.infer<typeof SkillTriggerManifest>
  allowedTools: string[]
  assets: string[]
  priority: number
  legacy: boolean
}

export type SkillActivation = {
  skillId: string
  reason: string
  score: number
}

export type SkillTurnResolution = {
  activeSkillIds: string[]
  activations: SkillActivation[]
  instructions: string[]
  allowedToolNames?: string[]
  injectedBytes: number
}

export type SkillRuntimeDiagnostics = {
  enabled: boolean
  roots: string[]
  skills: Array<{
    id: string
    name: string
    description?: string
    version: string
    root: string
    legacy: boolean
    triggers: LoadedSkill['triggers']
    allowedTools: string[]
  }>
  validationErrors: Array<{ root: string; message: string }>
  lastActivations: SkillActivation[]
  lastInjection?: {
    activeSkillIds: string[]
    injectedBytes: number
    budgetBytes: number
    blockedToolNames: string[]
  }
}

export type SkillRuntimeOptions = {
  activeLimit?: number
  instructionBudgetBytes?: number
  discoveryWaitMs?: number
}

type DiscoveredSkills = {
  skills: LoadedSkill[]
  validationErrors: Array<{ root: string; message: string }>
}

type PendingDiscovery = {
  wait: Promise<void>
  workspace?: string
  queuedWorkspace?: string
}

export class SkillRuntime {
  private skills: LoadedSkill[]
  private validationErrors: Array<{ root: string; message: string }>
  private lastActivations: SkillActivation[] = []
  private lastInjection: SkillRuntimeDiagnostics['lastInjection']
  private discovery: PendingDiscovery | undefined

  private constructor(
    private readonly config: SkillsCapabilityConfig,
    private readonly options: Required<SkillRuntimeOptions>,
    loaded: DiscoveredSkills
  ) {
    this.skills = loaded.skills
    this.validationErrors = loaded.validationErrors
  }

  static async create(
    config: SkillsCapabilityConfig | undefined,
    options: SkillRuntimeOptions = {}
  ): Promise<SkillRuntime> {
    const normalized = config ?? { enabled: false, roots: [], legacySkillMd: true }
    const resolvedOptions = {
      activeLimit: options.activeLimit ?? DEFAULT_ACTIVE_LIMIT,
      instructionBudgetBytes: options.instructionBudgetBytes ?? DEFAULT_INSTRUCTION_BUDGET_BYTES,
      discoveryWaitMs: Number.isFinite(options.discoveryWaitMs) && options.discoveryWaitMs! >= 0
        ? options.discoveryWaitMs!
        : DEFAULT_DISCOVERY_WAIT_MS
    }
    const runtime = new SkillRuntime(normalized, resolvedOptions, { skills: [], validationErrors: [] })
    await runtime.refresh()
    return runtime
  }

  async refresh(workspace?: string): Promise<void> {
    if (!this.config.enabled) return
    const requestedWorkspace = workspace?.trim() ? resolve(workspace) : undefined
    if (this.discovery) {
      // Reuse the same reads even after the wait budget has elapsed. A stuck filesystem
      // call must not create a new worker-pool request on every catalog/refresh request.
      // Keep only the latest distinct workspace request. Returning to the
      // active workspace cancels a queued detour instead of applying skills
      // from an older workspace after the current scan finishes.
      if (requestedWorkspace) this.discovery.queuedWorkspace = requestedWorkspace === this.discovery.workspace ? undefined : requestedWorkspace
      return this.discovery.wait
    }
    const pending: PendingDiscovery = { wait: Promise.resolve(), workspace: requestedWorkspace }
    this.discovery = pending
    let waitTimer: ReturnType<typeof setTimeout>
    const completion = this.discover(requestedWorkspace).catch(() => {
      // Keep the usable catalog and never emit an exception payload to process logs.
      console.info('[runtime startup] skills discovery failed; retaining loaded skills')
    }).finally(() => {
      clearTimeout(waitTimer)
      if (this.discovery === pending) this.discovery = undefined
      if (pending.queuedWorkspace) void this.refresh(pending.queuedWorkspace)
    })
    pending.wait = new Promise<void>((resolveWait) => {
      waitTimer = setTimeout(() => {
        console.info(`[runtime startup] skills discovery pending after ${this.options.discoveryWaitMs}ms; continuing in background`)
        resolveWait()
      }, this.options.discoveryWaitMs)
      void completion.then(resolveWait)
    })
    return pending.wait
  }

  private async discover(workspace?: string): Promise<void> {
    const previousSkills = this.skills
    const dynamicRootCandidates = workspace?.trim()
      ? [
          join(resolve(workspace), '.agents', 'skills'),
          join(resolve(workspace), '.codex', 'skills'),
          join(resolve(workspace), 'skills')
        ]
      : []
    const dynamicRoots: string[] = []
    for (const root of dynamicRootCandidates) {
      if (await exists(root)) dynamicRoots.push(root)
    }
    const refreshedConfig = dynamicRoots.length > 0
      ? { ...this.config, roots: [...dynamicRoots, ...this.config.roots] }
      : this.config
    const loaded = await discoverSkills(refreshedConfig, previousSkills, (progress) => {
      // Publish successful reads while retaining the old catalog until this scan ends.
      this.skills = uniqueSkills([...progress.skills, ...previousSkills])
      this.validationErrors = progress.validationErrors
    })
    this.skills = loaded.skills
    this.validationErrors = loaded.validationErrors
  }

  resolveTurn(input: {
    prompt: string
    workspace: string
    filePaths?: readonly string[]
    preferredSkillIds?: readonly string[]
  }): SkillTurnResolution {
    if (!this.config.enabled) return emptyResolution()
    const matches = this.matchSkills(input)
    const active = matches.slice(0, this.options.activeLimit)
    const injection = buildInjection(active, this.options.instructionBudgetBytes)
    const blockedToolNames = blockedToolsFor(this.skills, injection.allowedToolNames)
    this.lastActivations = active.map(({ skill, reason, score }) => ({
      skillId: skill.id,
      reason,
      score
    }))
    this.lastInjection = {
      activeSkillIds: injection.activeSkillIds,
      injectedBytes: injection.injectedBytes,
      budgetBytes: this.options.instructionBudgetBytes,
      blockedToolNames
    }
    return {
      activeSkillIds: injection.activeSkillIds,
      activations: this.lastActivations,
      instructions: injection.instructions,
      ...(injection.allowedToolNames ? { allowedToolNames: injection.allowedToolNames } : {}),
      injectedBytes: injection.injectedBytes
    }
  }

  diagnostics(): SkillRuntimeDiagnostics {
    return {
      enabled: this.config.enabled,
      roots: [...this.config.roots],
      skills: this.skills.map((skill) => ({
        id: skill.id,
        name: skill.name,
        ...(skill.description ? { description: skill.description } : {}),
        version: skill.version,
        root: skill.root,
        legacy: skill.legacy,
        triggers: skill.triggers,
        allowedTools: skill.allowedTools
      })),
      validationErrors: [...this.validationErrors],
      lastActivations: [...this.lastActivations],
      ...(this.lastInjection ? { lastInjection: this.lastInjection } : {})
    }
  }

  count(): number {
    return this.skills.length
  }

  private matchSkills(input: {
    prompt: string
    workspace: string
    filePaths?: readonly string[]
    preferredSkillIds?: readonly string[]
  }): Array<SkillActivation & { skill: LoadedSkill }> {
    const prompt = input.prompt
    const lowerPrompt = prompt.toLowerCase()
    const fileTypes = fileTypesFrom(input.filePaths ?? [], prompt)
    const preferredSkillIds = new Set(input.preferredSkillIds ?? [])
    const matches: Array<SkillActivation & { skill: LoadedSkill }> = []
    for (const skill of this.skills) {
      const explicit = explicitSkillMention(skill, prompt)
      if (explicit) {
        matches.push({ skill, skillId: skill.id, reason: explicit, score: 1_000 + skill.priority })
        continue
      }
      const command = skill.triggers.commands.find((candidate) => lowerPrompt.startsWith(candidate.toLowerCase()))
      if (command) {
        matches.push({ skill, skillId: skill.id, reason: `command:${command}`, score: 900 + skill.priority })
        continue
      }
      if (preferredSkillIds.has(skill.id)) {
        matches.push({
          skill,
          skillId: skill.id,
          reason: 'continuation:previous-turn',
          score: 800 + skill.priority
        })
        continue
      }
      const pattern = skill.triggers.promptPatterns.find((candidate) => safePatternMatches(candidate, prompt))
      if (pattern) {
        matches.push({ skill, skillId: skill.id, reason: `pattern:${pattern}`, score: 500 + skill.priority })
        continue
      }
      const inferred = inferredPromptMatch(skill, prompt)
      if (inferred) {
        matches.push({
          skill,
          skillId: skill.id,
          reason: inferred.reason,
          score: 350 + inferred.score + skill.priority
        })
        continue
      }
      const fileType = skill.triggers.fileTypes.find((candidate) => fileTypes.has(normalizeFileType(candidate)))
      if (fileType) {
        matches.push({ skill, skillId: skill.id, reason: `fileType:${fileType}`, score: 300 + skill.priority })
      }
    }
    return matches.sort((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id))
  }
}

async function discoverSkills(
  config: SkillsCapabilityConfig,
  previousSkills: LoadedSkill[],
  onProgress: (loaded: DiscoveredSkills) => void
): Promise<DiscoveredSkills> {
  const skills: LoadedSkill[] = []
  const validationErrors: Array<{ root: string; message: string }> = []
  for (const rawRoot of config.roots) {
    const root = resolve(rawRoot)
    const startedAt = Date.now()
    const pendingRootTimer = setTimeout(() => {
      // Internal log only: a stalled scan must remain attributable without exposing file contents.
      console.info(`[runtime startup] skills pending-root=${JSON.stringify(root)} elapsedMs=${Date.now() - startedAt}`)
    }, 5_000)
    pendingRootTimer.unref()
    try {
      const candidates = await packageCandidates(root).catch((error) => {
        validationErrors.push({ root, message: errorMessage(error) })
        skills.push(...previousSkills.filter((skill) => skill.root === root || skill.root.startsWith(root + sep)))
        return []
      })
      for (const candidate of candidates) {
        const loaded = await loadSkillPackage(candidate, config.legacySkillMd).catch((error) => {
          validationErrors.push({ root: candidate, message: errorMessage(error) })
          skills.push(...previousSkills.filter((skill) => skill.root === candidate))
          return null
        })
        if (loaded) {
          skills.push(loaded)
          onProgress({ skills: uniqueSkills(skills), validationErrors: [...validationErrors] })
        }
      }
      onProgress({ skills: uniqueSkills(skills), validationErrors: [...validationErrors] })
    } finally {
      clearTimeout(pendingRootTimer)
    }
  }
  const unique = new Map<string, LoadedSkill>()
  for (const skill of skills) {
    if (!unique.has(skill.id)) unique.set(skill.id, skill)
    else validationErrors.push({ root: skill.root, message: `duplicate Skill id: ${skill.id}` })
  }
  return { skills: [...unique.values()].sort((a, b) => a.id.localeCompare(b.id)), validationErrors }
}

function uniqueSkills(skills: LoadedSkill[]): LoadedSkill[] {
  const unique = new Map<string, LoadedSkill>()
  for (const skill of skills) if (!unique.has(skill.id)) unique.set(skill.id, skill)
  return [...unique.values()].sort((a, b) => a.id.localeCompare(b.id))
}

async function packageCandidates(root: string): Promise<string[]> {
  const candidates = new Set<string>()
  if (await exists(join(root, 'skill.json')) || await exists(join(root, 'SKILL.md'))) {
    candidates.add(root)
  }
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const dir = join(root, entry.name)
      if (await exists(join(dir, 'skill.json')) || await exists(join(dir, 'SKILL.md'))) {
        candidates.add(dir)
      }
    }
  }
  return [...candidates]
}

async function loadSkillPackage(root: string, allowLegacy: boolean): Promise<LoadedSkill | null> {
  const manifestPath = join(root, 'skill.json')
  if (await exists(manifestPath)) {
    const manifest = SkillManifest.parse(JSON.parse(await readFile(manifestPath, 'utf8')))
    const entryPath = resolve(root, manifest.entry)
    const entry = await readFile(entryPath, 'utf8')
    return {
      id: slug(manifest.id ?? manifest.name),
      name: manifest.name,
      description: manifest.description,
      version: manifest.version,
      root,
      entryPath,
      entry,
      triggers: manifest.triggers,
      allowedTools: manifest.allowedTools,
      assets: manifest.assets.map((asset) => resolve(root, asset)),
      priority: manifest.priority,
      legacy: false
    }
  }
  if (!allowLegacy) return null
  const legacyPath = join(root, 'SKILL.md')
  if (!await exists(legacyPath)) return null
  const entry = await readFile(legacyPath, 'utf8')
  const frontmatter = readFrontmatter(entry)
  const folderName = basename(root)
  const name = frontmatter.name || folderName
  return {
    id: slug(frontmatter.id || folderName),
    name,
    description: frontmatter.description,
    version: 'legacy',
    root,
    entryPath: legacyPath,
    entry,
    triggers: { commands: [], promptPatterns: [], fileTypes: [] },
    allowedTools: [],
    assets: [],
    priority: 0,
    legacy: true
  }
}

function buildInjection(
  active: Array<SkillActivation & { skill: LoadedSkill }>,
  budgetBytes: number
): {
  activeSkillIds: string[]
  instructions: string[]
  allowedToolNames?: string[]
  injectedBytes: number
} {
  const instructions: string[] = []
  const activeSkillIds: string[] = []
  const allowed = new Set<string>()
  let injectedBytes = 0
  for (const match of active) {
    const skill = match.skill
    const remainingBudget = budgetBytes - injectedBytes
    const built = buildSkillInstruction(match, remainingBudget)
    if (!built) continue
    const { text, bytes } = built
    activeSkillIds.push(skill.id)
    instructions.push(text)
    injectedBytes += bytes
    for (const tool of skill.allowedTools) allowed.add(tool)
  }
  return {
    activeSkillIds,
    instructions,
    ...(allowed.size > 0 ? { allowedToolNames: [...allowed].sort() } : {}),
    injectedBytes
  }
}

function buildSkillInstruction(
  match: SkillActivation & { skill: LoadedSkill },
  remainingBudgetBytes: number
): { text: string; bytes: number } | null {
  if (remainingBudgetBytes < MIN_BUDGETED_SKILL_BYTES) return null
  const skill = match.skill
  const fullHeader = skillInstructionHeader(match)
  const fullText = [fullHeader, skill.entry].join('\n\n')
  const fullBytes = Buffer.byteLength(fullText, 'utf8')
  if (fullBytes <= remainingBudgetBytes) return { text: fullText, bytes: fullBytes }

  const budgetedHeader = skillInstructionHeader(match)
  const notice = [
    'Skill entry is larger than the per-turn injection budget.',
    'Use this excerpt first. If more detail is needed, read referenced files from the Skill root instead of asking the user to restate them.'
  ].join(' ')
  const prefix = [budgetedHeader, notice].join('\n\n')
  const prefixBytes = Buffer.byteLength(prefix, 'utf8')
  const suffix = '[Skill excerpt truncated]'
  const excerptOverheadBytes = Buffer.byteLength(`\n\n\n\n${suffix}`, 'utf8')
  let excerptBudget = remainingBudgetBytes - prefixBytes - excerptOverheadBytes
  if (excerptBudget < 120) return null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const excerpt = clipUtf8(skill.entry, excerptBudget)
    const text = [prefix, excerpt, suffix].join('\n\n')
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes <= remainingBudgetBytes) return { text, bytes }
    excerptBudget -= bytes - remainingBudgetBytes + 16
    if (excerptBudget < 120) return null
  }
  return null
}

function skillInstructionHeader(match: SkillActivation & { skill: LoadedSkill }): string {
  const skill = match.skill
  return [
    `Active Skill: ${skill.name} (${skill.id})`,
    `Activation: ${match.reason}`,
    skill.description ? `Description: ${skill.description}` : '',
    `Skill root: ${skill.root}`,
    `Skill entry: ${skill.entryPath}`,
    skill.allowedTools.length ? `Allowed tools: ${skill.allowedTools.join(', ')}` : '',
    skill.assets.length ? `Assets:\n${skill.assets.map((asset) => `- ${asset}`).join('\n')}` : ''
  ].filter(Boolean).join('\n\n')
}

function blockedToolsFor(skills: LoadedSkill[], allowedToolNames: string[] | undefined): string[] {
  if (!allowedToolNames) return []
  const allowed = new Set(allowedToolNames)
  return [...new Set(skills.flatMap((skill) => skill.allowedTools))]
    .filter((tool) => !allowed.has(tool))
    .sort()
}

function emptyResolution(): SkillTurnResolution {
  return {
    activeSkillIds: [],
    activations: [],
    instructions: [],
    injectedBytes: 0
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function explicitSkillMention(skill: LoadedSkill, prompt: string): string | undefined {
  const lower = prompt.toLowerCase()
  const id = skill.id.toLowerCase()
  const name = skill.name.toLowerCase()
  if (lower.includes(`$${id}`) || lower.includes(`@${id}`) || lower.includes(`/skill:${id}`)) return 'explicit:id'
  if (name && (lower.includes(`$${name}`) || lower.includes(`@${name}`))) return 'explicit:name'
  const naturalPrompt = normalizeNaturalSkillMention(prompt)
  for (const [candidate, reason] of [
    [skill.name, 'explicit:natural-name'],
    [skill.id, 'explicit:natural-id']
  ] as const) {
    const naturalCandidate = normalizeNaturalSkillMention(candidate)
    const distinctiveLength = naturalCandidate.replace(/\s/g, '').length
    if (distinctiveLength >= 6 && naturalPrompt.includes(naturalCandidate)) {
      return reason
    }
  }
  return undefined
}

function normalizeNaturalSkillMention(value: string): string {
  return value
    .toLowerCase()
    .replace(/[-_]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function safePatternMatches(pattern: string, prompt: string): boolean {
  try {
    return new RegExp(pattern, 'i').test(prompt)
  } catch {
    return false
  }
}

function inferredPromptMatch(
  skill: LoadedSkill,
  prompt: string
): { reason: string; score: number } | undefined {
  const keywords = promptKeywords(prompt)
  if (keywords.length === 0) return undefined
  const searchText = searchableSkillText(skill)
  const hits: string[] = []
  let score = 0
  for (const keyword of keywords) {
    if (!searchText.includes(keyword)) continue
    hits.push(keyword)
    score += keywordScore(keyword)
  }
  if (score < 5 || !hits.some((hit) => isDistinctiveKeyword(hit))) return undefined
  return {
    reason: `text:${hits.slice(0, 4).join(',')}`,
    score
  }
}

function searchableSkillText(skill: LoadedSkill): string {
  const entryLead = firstMarkdownParagraph(stripLeadingFrontmatter(skill.entry)) ?? ''
  return normalizeSearchText([
    skill.id,
    skill.name,
    skill.description ?? '',
    entryLead
  ].join('\n'))
}

function stripLeadingFrontmatter(content: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---/.exec(content)
  return match ? content.slice(match[0].length) : content
}

function promptKeywords(prompt: string): string[] {
  const normalized = normalizeSearchText(prompt)
  const out = new Set<string>()
  for (const match of normalized.matchAll(/[a-z0-9][a-z0-9_-]{2,}/g)) {
    addKeyword(out, match[0])
  }
  for (const match of normalized.matchAll(/\p{Script=Han}+/gu)) {
    const chars = Array.from(match[0])
    for (let size = 2; size <= Math.min(6, chars.length); size += 1) {
      for (let index = 0; index + size <= chars.length; index += 1) {
        addKeyword(out, chars.slice(index, index + size).join(''))
      }
    }
  }
  return [...out].sort((a, b) => b.length - a.length || a.localeCompare(b))
}

function addKeyword(out: Set<string>, keyword: string): void {
  const value = keyword.trim().toLowerCase()
  if (value.length < 2 || GENERIC_KEYWORDS.has(value)) return
  out.add(value)
}

function keywordScore(keyword: string): number {
  if (/^\p{Script=Han}+$/u.test(keyword)) {
    return Math.min(8, Math.max(2, keyword.length))
  }
  return Math.min(6, Math.max(2, Math.floor(keyword.length / 2)))
}

function isDistinctiveKeyword(keyword: string): boolean {
  return !GENERIC_KEYWORDS.has(keyword) && (
    keyword.length >= 3 ||
    /^\p{Script=Han}{2}$/u.test(keyword) ||
    /^[a-z0-9][a-z0-9_-]{3,}$/i.test(keyword)
  )
}

function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').toLowerCase()
}

function clipUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  let out = ''
  let bytes = 0
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, 'utf8')
    if (bytes + charBytes > maxBytes) break
    out += char
    bytes += charBytes
  }
  return out.trimEnd()
}

function fileTypesFrom(paths: readonly string[], prompt: string): Set<string> {
  const out = new Set<string>()
  for (const filePath of paths) {
    const ext = extname(filePath)
    if (ext) out.add(normalizeFileType(ext))
  }
  for (const match of prompt.matchAll(/\.[a-z0-9]+/gi)) {
    out.add(normalizeFileType(match[0] ?? ''))
  }
  return out
}

function normalizeFileType(value: string): string {
  const trimmed = value.trim().toLowerCase()
  return trimmed.startsWith('.') ? trimmed : `.${trimmed}`
}

function firstMarkdownParagraph(markdown: string): string | undefined {
  return markdown
    .split(/\n{2,}/)
    .map((block) => block.replace(/^#+\s*/, '').trim())
    .find(Boolean)
}

function readFrontmatter(content: string): { id?: string; name?: string; description?: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)
  if (!match) return { description: firstMarkdownParagraph(content) }
  const yaml = match[1] ?? ''
  return {
    id: frontmatterString(yaml, 'id'),
    name: frontmatterString(yaml, 'name'),
    description: frontmatterString(yaml, 'description') || firstMarkdownParagraph(content.slice(match[0].length))
  }
}

function frontmatterString(yaml: string, key: string): string | undefined {
  const match = new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm').exec(yaml)
  return match ? stripQuotes(match[1] ?? '').trim() || undefined : undefined
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

function slug(value: string): string {
  return value
    .trim()
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '') || 'skill'
}

function errorMessage(error: unknown): string {
  if (error instanceof z.ZodError) return error.issues.map((issue) => issue.message).join('; ')
  return error instanceof Error ? error.message : String(error)
}
