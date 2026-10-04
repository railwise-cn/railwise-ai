import { createHash } from 'node:crypto'

/**
 * Append-only proof records for a survey source file.
 *
 * This is intentionally a generic platform mechanism: it records immutable
 * source identity and a chain of verification events, but it contains no
 * jurisdiction-specific tolerance values or standards content. Storage and UI
 * layers may persist the records; neither may use this module to alter a raw
 * source or replace its identity.
 */

export const SURVEY_RAW_DATA_LEDGER_SCHEMA_VERSION = 1 as const

export const SURVEY_RAW_DATA_LEDGER_EVENT_KINDS = ['source-recorded', 'source-reverified'] as const
export type SurveyRawDataLedgerEventKind = (typeof SURVEY_RAW_DATA_LEDGER_EVENT_KINDS)[number]

export type SurveyRawDataLedgerActor = 'runtime' | 'human'

export type SurveyRawRecordLocator = Readonly<{
  id: string
  rawOffset: number
  rawLength: number
  rawLineNo?: number
  containerMember?: Readonly<{ path: string; sha256: string; byteOffset: number; byteLength: number; row: number }>
}>

/**
 * The minimum evidence needed to establish that a source was preserved.  It
 * deliberately carries no raw observation values: the content hash is the
 * identity, and the original stays in the attachment/source store.
 */
export type SurveyRawSourceEvidence = Readonly<{
  sha256: string
  fileSize: number
  originalPreserved: boolean
  records: readonly SurveyRawRecordLocator[]
}>

export type SurveyRawDataLedgerEntry = Readonly<{
  schemaVersion: typeof SURVEY_RAW_DATA_LEDGER_SCHEMA_VERSION
  id: string
  sequence: number
  networkId: string
  event: SurveyRawDataLedgerEventKind
  actor: SurveyRawDataLedgerActor
  occurredAt: string
  sourceSha256: string
  sourceSize: number
  rawAnchorDigest: string
  previousHash: string | null
  thisHash: string
}>

export type SurveyRawDataLedgerVerification = Readonly<{
  valid: boolean
  errors: readonly string[]
}>

export class SurveyRawSourceIntegrityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SurveyRawSourceIntegrityError'
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalRecordLocator(record: SurveyRawRecordLocator): Record<string, unknown> {
  return {
    id: record.id,
    rawOffset: record.rawOffset,
    rawLength: record.rawLength,
    ...(record.rawLineNo === undefined ? {} : { rawLineNo: record.rawLineNo }),
    ...(record.containerMember === undefined ? {} : { containerMember: record.containerMember })
  }
}

function isSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value)
}

function assertRawSourceEvidence(source: SurveyRawSourceEvidence): void {
  if (!source.originalPreserved) throw new SurveyRawSourceIntegrityError('raw source must be preserved before it can enter the integrity ledger')
  if (!isSha256(source.sha256)) throw new SurveyRawSourceIntegrityError('raw source sha256 must be a lowercase SHA-256 digest')
  if (!Number.isSafeInteger(source.fileSize) || source.fileSize < 0) throw new SurveyRawSourceIntegrityError('raw source fileSize must be a non-negative safe integer')

  const seenIds = new Set<string>()
  for (const record of source.records) {
    if (!record.id.trim()) throw new SurveyRawSourceIntegrityError('raw record locator id is required')
    if (seenIds.has(record.id)) throw new SurveyRawSourceIntegrityError(`duplicate raw record locator id: ${record.id}`)
    seenIds.add(record.id)
    if (!Number.isSafeInteger(record.rawOffset) || record.rawOffset < 0) throw new SurveyRawSourceIntegrityError(`raw record ${record.id} has an invalid offset`)
    if (!Number.isSafeInteger(record.rawLength) || record.rawLength <= 0) throw new SurveyRawSourceIntegrityError(`raw record ${record.id} has an invalid length`)
    if (record.rawOffset + record.rawLength > source.fileSize) throw new SurveyRawSourceIntegrityError(`raw record ${record.id} lies outside the preserved source`)
    if (record.rawLineNo !== undefined && (!Number.isSafeInteger(record.rawLineNo) || record.rawLineNo <= 0)) throw new SurveyRawSourceIntegrityError(`raw record ${record.id} has an invalid line number`)
    const member = record.containerMember
    if (member && (!member.path.trim() || member.path.length > 256 || member.path.startsWith('/') || member.path.includes('\\') || member.path.split('/').includes('..')
      || !isSha256(member.sha256) || !Number.isSafeInteger(member.byteOffset) || member.byteOffset < 0
      || !Number.isSafeInteger(member.byteLength) || member.byteLength <= 0 || !Number.isSafeInteger(member.byteOffset + member.byteLength)
      || !Number.isSafeInteger(member.row) || member.row <= 0)) throw new SurveyRawSourceIntegrityError(`raw record ${record.id} has an invalid container member locator`)
  }
}

/**
 * Produce a stable digest for raw record anchors.  Anchor order is preserved:
 * it is part of the source record sequence and must not be silently sorted.
 */
export function rawAnchorDigest(source: SurveyRawSourceEvidence): string {
  assertRawSourceEvidence(source)
  return sha256(JSON.stringify({
    sourceSha256: source.sha256,
    sourceSize: source.fileSize,
    records: source.records.map(canonicalRecordLocator)
  }))
}

function entryPayload(entry: Omit<SurveyRawDataLedgerEntry, 'thisHash'>): string {
  return JSON.stringify({
    schemaVersion: entry.schemaVersion,
    id: entry.id,
    sequence: entry.sequence,
    networkId: entry.networkId,
    event: entry.event,
    actor: entry.actor,
    occurredAt: entry.occurredAt,
    sourceSha256: entry.sourceSha256,
    sourceSize: entry.sourceSize,
    rawAnchorDigest: entry.rawAnchorDigest,
    previousHash: entry.previousHash
  })
}

function entryHash(entry: Omit<SurveyRawDataLedgerEntry, 'thisHash'>): string {
  return sha256(entryPayload(entry))
}

function freezeEntry(entry: Omit<SurveyRawDataLedgerEntry, 'thisHash'>): SurveyRawDataLedgerEntry {
  return Object.freeze({ ...entry, thisHash: entryHash(entry) })
}

function createEntry(input: Readonly<{
  id: string
  networkId: string
  source: SurveyRawSourceEvidence
  occurredAt: string
  actor?: SurveyRawDataLedgerActor
  event: SurveyRawDataLedgerEventKind
  sequence: number
  previousHash: string | null
}>): SurveyRawDataLedgerEntry {
  if (!input.id.trim()) throw new SurveyRawSourceIntegrityError('ledger entry id is required')
  if (!input.networkId.trim()) throw new SurveyRawSourceIntegrityError('ledger networkId is required')
  if (!Number.isSafeInteger(input.sequence) || input.sequence <= 0) throw new SurveyRawSourceIntegrityError('ledger sequence must be a positive safe integer')
  if (!input.occurredAt.trim()) throw new SurveyRawSourceIntegrityError('ledger occurredAt is required')
  if (input.previousHash !== null && !isSha256(input.previousHash)) throw new SurveyRawSourceIntegrityError('ledger previousHash must be a SHA-256 digest or null')
  const digest = rawAnchorDigest(input.source)
  return freezeEntry({
    schemaVersion: SURVEY_RAW_DATA_LEDGER_SCHEMA_VERSION,
    id: input.id,
    sequence: input.sequence,
    networkId: input.networkId,
    event: input.event,
    actor: input.actor ?? 'runtime',
    occurredAt: input.occurredAt,
    sourceSha256: input.source.sha256,
    sourceSize: input.source.fileSize,
    rawAnchorDigest: digest,
    previousHash: input.previousHash
  })
}

/** Record the first immutable observation-source identity for a network. */
export function recordRawSource(input: Readonly<{
  id: string
  networkId: string
  source: SurveyRawSourceEvidence
  occurredAt: string
  actor?: SurveyRawDataLedgerActor
}>): SurveyRawDataLedgerEntry {
  return createEntry({ ...input, event: 'source-recorded', sequence: 1, previousHash: null })
}

/**
 * Append a re-verification event. A different content hash, source size, or
 * raw-anchor digest is treated as a source mutation and is never accepted as
 * a replacement for the original record.
 */
export function reverifyRawSource(input: Readonly<{
  ledger: readonly SurveyRawDataLedgerEntry[]
  id: string
  source: SurveyRawSourceEvidence
  occurredAt: string
  actor?: SurveyRawDataLedgerActor
}>): SurveyRawDataLedgerEntry {
  const verification = verifyRawSourceLedger(input.ledger)
  if (!verification.valid) throw new SurveyRawSourceIntegrityError(`cannot append to an invalid raw-source ledger: ${verification.errors.join('; ')}`)
  const initial = input.ledger[0]
  const previous = input.ledger.at(-1)
  if (!initial || !previous) throw new SurveyRawSourceIntegrityError('cannot reverify an empty raw-source ledger')
  const digest = rawAnchorDigest(input.source)
  if (input.source.sha256 !== initial.sourceSha256 || input.source.fileSize !== initial.sourceSize || digest !== initial.rawAnchorDigest) {
    throw new SurveyRawSourceIntegrityError('raw source identity changed; import it as a new source instead of replacing the recorded source')
  }
  return createEntry({
    id: input.id,
    networkId: initial.networkId,
    source: input.source,
    occurredAt: input.occurredAt,
    actor: input.actor,
    event: 'source-reverified',
    sequence: previous.sequence + 1,
    previousHash: previous.thisHash
  })
}

/** Verify a ledger received from durable storage or another process. */
export function verifyRawSourceLedger(entries: readonly SurveyRawDataLedgerEntry[]): SurveyRawDataLedgerVerification {
  const errors: string[] = []
  if (!entries.length) errors.push('raw-source ledger is empty')
  const ids = new Set<string>()
  let previous: SurveyRawDataLedgerEntry | undefined
  let initial: SurveyRawDataLedgerEntry | undefined

  for (const entry of entries) {
    if (entry.schemaVersion !== SURVEY_RAW_DATA_LEDGER_SCHEMA_VERSION) errors.push(`entry ${entry.id} has unsupported schema version`)
    if (!entry.id || ids.has(entry.id)) errors.push(`entry ${entry.id || '<missing>'} has a missing or duplicate id`)
    ids.add(entry.id)
    if (!Number.isSafeInteger(entry.sequence) || entry.sequence !== (previous?.sequence ?? 0) + 1) errors.push(`entry ${entry.id} has a non-contiguous sequence`)
    if (!entry.networkId) errors.push(`entry ${entry.id} is missing networkId`)
    if (!SURVEY_RAW_DATA_LEDGER_EVENT_KINDS.includes(entry.event)) errors.push(`entry ${entry.id} has an unsupported event`)
    if (entry.actor !== 'runtime' && entry.actor !== 'human') errors.push(`entry ${entry.id} has an unsupported actor`)
    if (!isSha256(entry.sourceSha256)) errors.push(`entry ${entry.id} has an invalid source SHA-256`)
    if (!Number.isSafeInteger(entry.sourceSize) || entry.sourceSize < 0) errors.push(`entry ${entry.id} has an invalid source size`)
    if (!isSha256(entry.rawAnchorDigest)) errors.push(`entry ${entry.id} has an invalid raw anchor digest`)
    if (entry.previousHash !== (previous?.thisHash ?? null)) errors.push(`entry ${entry.id} does not link to the previous ledger entry`)
    const { thisHash: _thisHash, ...hashable } = entry
    if (entry.thisHash !== entryHash(hashable)) errors.push(`entry ${entry.id} hash does not match its payload`)

    if (!initial) initial = entry
    else if (entry.networkId !== initial.networkId || entry.sourceSha256 !== initial.sourceSha256 || entry.sourceSize !== initial.sourceSize || entry.rawAnchorDigest !== initial.rawAnchorDigest) {
      errors.push(`entry ${entry.id} changes the recorded raw source identity`)
    }
    previous = entry
  }

  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) })
}
