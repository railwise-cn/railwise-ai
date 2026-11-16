import { createHash } from 'node:crypto'

/** Supplied only from trusted verification receipts and their source-read epoch. */
export type WebArtifactRepairAttempt = {
  id?: string
  requirementHash: string
  evidenceFingerprint: string
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
  return createHash('sha256').update(JSON.stringify({
    requirementHash: attempt.requirementHash,
    evidenceFingerprint: attempt.evidenceFingerprint,
    failureKinds: [...new Set(attempt.failureKinds)].sort()
  })).digest('hex')
}

/**
 * The first failed assessment permits one repair. Repeating the same semantic
 * failure without new source evidence stalls after that repair, regardless of
 * intervening publication or HTML changes. Reading state never adds an attempt.
 */
export function deriveWebArtifactRepairState(
  priorAttempts: readonly WebArtifactRepairAttempt[],
  current?: WebArtifactRepairAttempt
): WebArtifactRepairState {
  const target = current ?? priorAttempts.at(-1)
  if (!target) return { fingerprint: '', failureCount: 0, stalled: false, reasons: [] }
  const key = fingerprint(target)
  const reasons = [...target.reasons]
  if (!target.failureKinds.length) return { fingerprint: key, failureCount: 0, stalled: false, reasons }

  const attempts = current ? [...priorAttempts, current] : priorAttempts
  // An evidence/requirement transition begins a new epoch, including a later
  // return to previously seen bytes. Old counters must not cross that boundary.
  let epochStart = attempts.length - 1
  while (epochStart > 0) {
    const previous = attempts[epochStart - 1]!
    if (previous.requirementHash !== target.requirementHash || previous.evidenceFingerprint !== target.evidenceFingerprint) break
    epochStart--
  }

  // Track each remaining defect independently. Fixing a different field, or
  // adding another error, cannot erase a still-unresolved semantic failure.
  const counts = new Map([...new Set(target.failureKinds)].map(kind => [kind, 0]))
  const seen = new Map<string, Set<string>>()
  for (let index = epochStart; index < attempts.length; index++) {
    const attempt = attempts[index]!
    for (const kind of new Set(attempt.failureKinds)) {
      if (!counts.has(kind)) continue
      if (attempt.id !== undefined) {
        const receipts = seen.get(kind) ?? new Set<string>()
        if (receipts.has(attempt.id)) continue
        receipts.add(attempt.id)
        seen.set(kind, receipts)
      }
      counts.set(kind, counts.get(kind)! + 1)
    }
  }
  const failureCount = Math.max(0, ...counts.values())
  return { fingerprint: key, failureCount, stalled: failureCount >= 2, reasons }
}
