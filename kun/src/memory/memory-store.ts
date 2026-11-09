import { mkdir, readFile, readdir } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { MemoryCapabilityConfig } from '../contracts/capabilities.js'
import { atomicWriteFile } from '../adapters/file/atomic-write.js'
import {
  MemoryDiagnostics,
  MemoryRecord,
  type MemoryCreateRequest,
  type MemoryUpdateRequest
} from '../contracts/memory.js'

export interface MemoryStore {
  create(input: MemoryCreateRequest): Promise<MemoryRecord>
  update(id: string, patch: MemoryUpdateRequest): Promise<MemoryRecord>
  delete(id: string): Promise<MemoryRecord>
  list(filter?: { workspace?: string; project?: string; includeDeleted?: boolean }): Promise<MemoryRecord[]>
  retrieve(input: { query: string; workspace?: string; project?: string; limit: number }): Promise<MemoryRecord[]>
  diagnostics(): Promise<MemoryDiagnostics>
  setLastInjected(ids: string[]): void
}

export class FileMemoryStore implements MemoryStore {
  private lastInjectedIds: string[] = []

  constructor(
    private readonly options: {
      rootDir: string
      config: MemoryCapabilityConfig
      nowIso?: () => string
      idGenerator?: () => string
    }
  ) {}

  async create(input: MemoryCreateRequest): Promise<MemoryRecord> {
    if (input.kind === 'experience' && !this.options.config.experienceCandidatesEnabled) {
      throw new Error('experience candidates are disabled; enable them explicitly before recording project experience')
    }
    await mkdir(this.options.rootDir, { recursive: true })
    const now = this.now()
    const parsed = MemoryRecord.parse({
      id: this.options.idGenerator?.() ?? `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      content: input.content,
      scope: input.scope ?? 'workspace',
      workspace: input.workspace,
      project: input.project,
      sourceThreadId: input.sourceThreadId,
      sourceTurnId: input.sourceTurnId,
      tags: input.tags ?? [],
      confidence: input.confidence ?? 1,
      kind: input.kind ?? 'fact',
      admissionStatus: input.kind === 'experience' ? 'candidate' : input.admissionStatus ?? 'accepted',
      sourceTaskIds: input.sourceTaskIds ?? [],
      version: 1,
      createdAt: now,
      updatedAt: now
    })
    await this.write(parsed)
    return parsed
  }

  async update(id: string, patch: MemoryUpdateRequest): Promise<MemoryRecord> {
    const current = await this.mustGet(id)
    const now = this.now()
    const next = MemoryRecord.parse({
      ...current,
      ...(patch.content !== undefined ? { content: patch.content } : {}),
      ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
      ...(patch.confidence !== undefined ? { confidence: patch.confidence } : {}),
      ...(patch.disabled === true ? { disabledAt: current.disabledAt ?? now } : {}),
      ...(patch.disabled === false ? { disabledAt: undefined } : {}),
      ...(patch.workspace !== undefined ? { workspace: patch.workspace } : {}),
      ...(patch.project !== undefined ? { project: patch.project } : {}),
      ...(patch.admissionStatus !== undefined ? { admissionStatus: patch.admissionStatus } : {}),
      associationStatus: undefined,
      version: current.version + 1,
      updatedAt: now
    })
    await this.write(next)
    return next
  }

  async delete(id: string): Promise<MemoryRecord> {
    const current = await this.mustGet(id)
    const now = this.now()
    const next = MemoryRecord.parse({
      ...current,
      deletedAt: current.deletedAt ?? now,
      version: current.version + 1,
      updatedAt: now
    })
    await this.write(next)
    return next
  }

  async list(filter: { workspace?: string; project?: string; includeDeleted?: boolean } = {}): Promise<MemoryRecord[]> {
    const records = await this.readAll()
    return records
      .filter((record) => filter.includeDeleted || !record.deletedAt)
      .filter((record) => inScope(record, filter, false))
      .map(withAssociationStatus)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async retrieve(input: { query: string; workspace?: string; project?: string; limit: number }): Promise<MemoryRecord[]> {
    if (!this.options.config.enabled) return []
    const active = (await this.readAll())
      .filter((record) => !record.deletedAt && !record.disabledAt)
      .filter((record) => this.options.config.scopes.includes(record.scope))
      .filter((record) => record.admissionStatus === 'accepted' && inScope(record, input, true))
    return active
      .map((record) => ({ record, score: scoreMemory(record, input.query) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || b.record.updatedAt.localeCompare(a.record.updatedAt))
      .slice(0, Math.max(0, Math.min(input.limit, this.options.config.maxInjectedRecords)))
      .map((entry) => withAssociationStatus(entry.record))
  }

  async diagnostics(): Promise<MemoryDiagnostics> {
    const records = await this.readAll()
    return {
      enabled: this.options.config.enabled,
      rootDir: this.options.rootDir,
      activeCount: records.filter((record) => !record.deletedAt && !record.disabledAt).length,
      tombstoneCount: records.filter((record) => Boolean(record.deletedAt)).length,
      pendingAssociationCount: records.filter((record) => !record.deletedAt && needsAssociation(record)).length,
      candidateCount: records.filter((record) => !record.deletedAt && record.admissionStatus === 'candidate').length,
      experienceCandidatesEnabled: this.options.config.experienceCandidatesEnabled,
      lastInjectedIds: [...this.lastInjectedIds]
    }
  }

  setLastInjected(ids: string[]): void {
    this.lastInjectedIds = [...ids]
  }

  private async mustGet(id: string): Promise<MemoryRecord> {
    const record = (await this.readAll()).find((candidate) => candidate.id === id)
    if (!record) throw new Error(`memory not found: ${id}`)
    return record
  }

  private async readAll(): Promise<MemoryRecord[]> {
    await mkdir(this.options.rootDir, { recursive: true })
    const entries = await readdir(this.options.rootDir).catch(() => [])
    const records = await Promise.all(entries
      .filter((entry) => entry.endsWith('.json'))
      .map((entry) => readFile(join(this.options.rootDir, entry), 'utf8')
        .then((text) => MemoryRecord.parse(JSON.parse(text)))
        .catch(() => null)))
    return records.filter((record): record is MemoryRecord => Boolean(record))
  }

  private write(record: MemoryRecord): Promise<void> {
    return atomicWriteFile(
      join(this.options.rootDir, `${record.id}.json`),
      JSON.stringify(record, null, 2)
    )
  }

  private now(): string {
    return this.options.nowIso?.() ?? new Date().toISOString()
  }
}

function inScope(record: MemoryRecord, filter: { workspace?: string; project?: string }, recall: boolean): boolean {
  if (record.scope === 'user') return true
  if (!recall && !filter.workspace && !filter.project) return true
  if (!record.workspace || !filter.workspace || canonicalWorkspace(record.workspace) !== canonicalWorkspace(filter.workspace)) return false
  if (record.scope === 'workspace') return true
  if (!recall && !filter.project) return true
  return Boolean(record.project && filter.project && record.project === filter.project)
}

function scoreMemory(record: MemoryRecord, query: string): number {
  const words = memorySearchTokens(query)
  let score = 0
  const text = `${record.content} ${record.tags.join(' ')}`.normalize('NFKC').toLowerCase()
  for (const word of words) {
    if (text.includes(word)) score += 1
  }
  return score * record.confidence
}

function needsAssociation(record: MemoryRecord): boolean {
  return record.scope !== 'user' && (!record.workspace || (record.scope === 'project' && !record.project))
}

function withAssociationStatus(record: MemoryRecord): MemoryRecord {
  return { ...record, associationStatus: needsAssociation(record) ? 'pending_association' : 'associated' }
}

/** Canonicalize existing ancestors too, so a new directory beneath a symlink cannot evade scoping. */
export function canonicalWorkspace(path: string): string {
  const expanded = path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
  let parent = resolve(expanded)
  const suffix: string[] = []
  for (;;) {
    try {
      const canonical = join(realpathSync.native(parent), ...suffix)
      return process.platform === 'win32' ? canonical.toLowerCase() : canonical
    } catch {
      const next = dirname(parent)
      if (next === parent) return process.platform === 'win32' ? resolve(expanded).toLowerCase() : resolve(expanded)
      suffix.unshift(parent.slice(next.length).replace(/^[/\\]+/, ''))
      parent = next
    }
  }
}

/** Local Unicode segmentation with Han bigrams as a fallback for uncommon engineering terminology. */
export function memorySearchTokens(query: string): Set<string> {
  const normalized = query.normalize('NFKC').toLowerCase()
  const words = new Set(normalized.match(/[a-z0-9_]{2,}/g) ?? [])
  const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' })
  for (const segment of segmenter.segment(normalized)) {
    if (segment.isWordLike && /\p{Script=Han}/u.test(segment.segment)) words.add(segment.segment)
  }
  for (const run of normalized.match(/\p{Script=Han}+/gu) ?? []) {
    const chars = Array.from(run)
    if (chars.length === 1) words.add(run)
    for (let index = 0; index + 1 < chars.length; index += 1) words.add(chars[index]! + chars[index + 1]!)
  }
  return words
}
