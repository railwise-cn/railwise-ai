import { createHash } from 'node:crypto'

/** Supplied only from trusted verification receipts and their source-read epoch. */
export type WebArtifactRepairEpoch = {
  requirementHash: string
  evidenceFingerprint: string
  /** Only trusted qualifying progress for this specific validator category. */
  failureEvidenceFingerprints?: Readonly<Record<string, string>>
}

export type WebArtifactRepairAttempt = WebArtifactRepairEpoch & {
  id?: string
  turnId?: string
  /** Canonical validator categories, never HTML bytes, paths or model-chosen section IDs. */
  failureKinds: readonly string[]
  reasons: readonly string[]
}

export type WebArtifactRepairState = {
  fingerprint: string
  failureCount: number
  stalled: boolean
  reasons: string[]
}

function fingerprint(attempt: WebArtifactRepairAttempt): string {
  const kinds = [...new Set(attempt.failureKinds)].sort()
  return createHash('sha256').update(JSON.stringify({
    requirementHash: attempt.requirementHash,
    ...(attempt.failureEvidenceFingerprints ? { failureEvidenceFingerprints: Object.fromEntries(kinds.map(kind => [kind, evidenceEpoch(attempt, kind)])) }
      : { evidenceFingerprint: attempt.evidenceFingerprint }),
    failureKinds: kinds
  })).digest('hex')
}

const evidenceEpoch = (attempt: WebArtifactRepairEpoch, kind: string) => attempt.failureEvidenceFingerprints?.[kind] ?? attempt.evidenceFingerprint

/**
 * The first failed assessment permits one repair. Repeating the same semantic
 * failure without new source evidence stalls after that repair, regardless of
 * intervening publication or HTML changes. Reading state never adds an attempt.
 */
export function deriveWebArtifactRepairState(
  priorAttempts: readonly WebArtifactRepairAttempt[],
  current?: WebArtifactRepairAttempt,
  /** Query current trusted progress without inventing another failed assessment. */
  currentEpoch?: WebArtifactRepairEpoch
): WebArtifactRepairState {
  const latest = current ?? priorAttempts.at(-1)
  if (!latest) return { fingerprint: '', failureCount: 0, stalled: false, reasons: [] }
  const target = currentEpoch ? { ...latest, ...currentEpoch } : latest
  const key = fingerprint(target)
  const reasons = [...target.reasons]
  if (!target.failureKinds.length) return { fingerprint: key, failureCount: 0, stalled: false, reasons }

  const attempts = current ? [...priorAttempts, current] : priorAttempts
  // Track each remaining defect independently. Fixing a different field, or
  // reading another origin, cannot erase a still-unresolved semantic failure.
  const counts = new Map([...new Set(target.failureKinds)].map(kind => [kind, 0]))
  for (const kind of counts.keys()) {
    const seen = new Set<string>()
    for (let index = attempts.length - 1; index >= 0; index--) {
      const attempt = attempts[index]!
      if (attempt.requirementHash !== target.requirementHash || evidenceEpoch(attempt, kind) !== evidenceEpoch(target, kind)) break
      if (!attempt.failureKinds.includes(kind)) continue
      if (attempt.id !== undefined) {
        if (seen.has(attempt.id)) continue
        seen.add(attempt.id)
      }
      counts.set(kind, counts.get(kind)! + 1)
    }
  }
  const failureCount = Math.max(0, ...counts.values())
  return { fingerprint: key, failureCount, stalled: failureCount >= 2, reasons }
}
