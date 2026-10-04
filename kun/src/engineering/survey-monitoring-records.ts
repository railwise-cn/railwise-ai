import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  SurveyInitialValueChangeRequestV1, SurveyInitialValueEventV1,
  SurveySegmentComparisonRequestV1, SurveySegmentComparisonV1, SurveySegmentContinuityV1,
  SurveyObservationLayerIdentifiabilityV1,
  SurveyRawObservationCongruenceV1,
  type SurveySegmentContinuityV1 as SurveySegmentContinuity
} from '../contracts/survey-monitoring.js'
import type { SurveyProfessionalReviewV1 } from '../contracts/survey-professional.js'
import type { SurveyService } from './survey-service.js'

function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
type StoredRow = { request_hash: string; data_json: string }

export class SurveyMonitoringRecords {
  constructor(private readonly db: Database.Database, private readonly survey: SurveyService, private readonly nowIso: () => string) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS survey_initial_value_events (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, sequence INTEGER NOT NULL, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, data_json TEXT NOT NULL, UNIQUE(project_id,sequence), UNIQUE(project_id,idempotency_key));
      CREATE TABLE IF NOT EXISTS survey_segment_comparisons (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, data_json TEXT NOT NULL, UNIQUE(project_id,idempotency_key));
    `)
    for (const table of ['survey_initial_value_events', 'survey_segment_comparisons']) {
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END;
        CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END;
        CREATE TRIGGER IF NOT EXISTS ${table}_no_replace BEFORE INSERT ON ${table} WHEN EXISTS (SELECT 1 FROM ${table} WHERE id=NEW.id OR (project_id=NEW.project_id AND idempotency_key=NEW.idempotency_key)) BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END;
      `)
    }
    db.exec(`CREATE TRIGGER IF NOT EXISTS survey_initial_value_events_no_replace_sequence BEFORE INSERT ON survey_initial_value_events WHEN EXISTS (SELECT 1 FROM survey_initial_value_events WHERE project_id=NEW.project_id AND sequence=NEW.sequence) BEGIN SELECT RAISE(ABORT, 'survey_initial_value_events is append-only'); END;`)
  }

  private review(projectId: string, adjustmentId: string): SurveyProfessionalReviewV1 {
    const result = this.survey.getAdjustmentForProjectNewUse(projectId, adjustmentId)
    const review = this.survey.getProfessionalReview(adjustmentId)
    if (!result?.result || result.run.id !== adjustmentId || !review || review.projectId !== projectId
      || review.source.status !== 'bound' || review.source.integrity !== 'verified' || review.summary.validation !== 'valid'
      || !review.source.sha256 || !review.source.networkRevision) {
      throw new Error('monitoring requires a current eligible result with confirmed source metadata')
    }
    return review
  }

  listInitialValues(projectId: string): SurveyInitialValueEventV1[] {
    const rows = this.db.prepare('SELECT data_json FROM survey_initial_value_events WHERE project_id=? ORDER BY sequence').all(projectId) as { data_json: string }[]
    const events = rows.map(row => SurveyInitialValueEventV1.parse(JSON.parse(row.data_json)))
    let previous: SurveyInitialValueEventV1 | undefined
    for (const event of events) {
      const { eventHash, ...payload } = event
      if (event.projectId !== projectId || event.previousEventId !== (previous?.id ?? null)
        || event.previousHash !== (previous?.eventHash ?? null) || digest(payload) !== eventHash) throw new Error('monitoring initial value history failed integrity verification')
      previous = event
    }
    return events
  }

  changeInitialValue(projectId: string, input: unknown): SurveyInitialValueEventV1 {
    const request = SurveyInitialValueChangeRequestV1.parse(input)
    const review = this.review(projectId, request.adjustmentId)
    const requestHash = digest(request)
    return this.db.transaction(() => {
      const history = this.listInitialValues(projectId)
      const replay = this.db.prepare('SELECT request_hash,data_json FROM survey_initial_value_events WHERE project_id=? AND idempotency_key=?').get(projectId, request.idempotencyKey) as StoredRow | undefined
      if (replay) {
        const event = SurveyInitialValueEventV1.parse(JSON.parse(replay.data_json))
        if (replay.request_hash !== requestHash || event.resultHash !== review.resultHash || event.inputHash !== review.inputHash
          || event.sourceSha256 !== review.source.sha256 || !history.some(item => item.id === event.id)) throw new Error('monitoring initial value idempotency conflict')
        return event
      }
      const previous = history.at(-1)
      if (request.expectedPreviousEventId !== (previous?.id ?? null)) throw new Error('monitoring initial value history changed; refresh and confirm again')
      const payload = {
        schemaVersion: 1 as const, id: `initial_value_${randomUUID()}`, projectId,
        previousEventId: previous?.id ?? null, previousHash: previous?.eventHash ?? null,
        adjustmentId: review.runId, resultId: review.resultId, resultHash: review.resultHash, inputHash: review.inputHash,
        sourceSha256: review.source.sha256!, networkRevision: review.source.networkRevision!,
        reason: request.reason, confirmation: 'user-confirmed' as const, signoff: 'unsigned' as const, createdAt: this.nowIso()
      }
      const event = SurveyInitialValueEventV1.parse({ ...payload, eventHash: digest(payload) })
      this.db.prepare('INSERT INTO survey_initial_value_events(id,project_id,sequence,idempotency_key,request_hash,data_json) VALUES (?,?,?,?,?,?)')
        .run(event.id, projectId, history.length + 1, request.idempotencyKey, requestHash, JSON.stringify(event))
      return event
    }).immediate()
  }

  compareSegments(projectId: string, input: unknown): SurveySegmentComparisonV1 {
    const request = SurveySegmentComparisonRequestV1.parse(input)
    if (request.referenceAdjustmentId === request.currentAdjustmentId) throw new Error('segment comparison requires two different periods')
    if (new Set(request.segments.map(segment => segment.id)).size !== request.segments.length) throw new Error('duplicate segment identities')
    const reference = this.review(projectId, request.referenceAdjustmentId)
    const current = this.review(projectId, request.currentAdjustmentId)
    if (reference.algorithmVersion !== current.algorithmVersion) throw new Error('segment comparison requires the same algorithm version')
    const referenceNetwork = this.survey.getNetwork(reference.networkId)!
    const currentNetwork = this.survey.getNetwork(current.networkId)!
    if (reference.summary.networkType !== 'leveling' || current.summary.networkType !== 'leveling') throw new Error('segment comparison currently requires leveling results')
    const referenceEpoch = referenceNetwork.observationEpoch
    const currentEpoch = currentNetwork.observationEpoch
    if (!referenceEpoch || !currentEpoch || !(Date.parse(currentEpoch) > Date.parse(referenceEpoch))) throw new Error('segment comparison requires ordered valid observation epochs')
    const referenceIdentity = (review: SurveyProfessionalReviewV1) => ({
      coordinateSystem: review.reference.coordinateSystem, projection: review.reference.projection,
      ellipsoid: review.reference.ellipsoid, centralMeridian: review.reference.centralMeridian,
      verticalDatum: review.reference.verticalDatum,
      controls: [...review.reference.knownPoints].sort((a,b) => a.id.localeCompare(b.id))
    })
    if (digest(referenceIdentity(reference)) !== digest(referenceIdentity(current))) throw new Error('segment comparison requires identical datum and reference controls')
    const route = (review: SurveyProfessionalReviewV1, ids: string[], from: string, to: string) => {
      if (new Set(ids).size !== ids.length) throw new Error('segment contains duplicate observations')
      let endpoint = from, observed = 0, adjusted = 0
      const pointIds = new Set([from])
      for (const id of ids) {
        const matches = review.observations.filter(row => row.observationId === id)
        const row = matches[0]
        if (matches.length !== 1 || !row || row.type !== 'height-difference' || row.unit !== 'm'
          || row.observed === undefined || row.adjusted === undefined || !row.sourceRecordId) throw new Error(`segment observation unavailable: ${id}`)
        const direction = row.from === endpoint ? 1 : row.to === endpoint ? -1 : 0
        if (!direction) throw new Error(`segment observations are not contiguous: ${id}`)
        endpoint = direction === 1 ? row.to! : row.from!
        pointIds.add(endpoint)
        observed += direction * row.observed
        adjusted += direction * row.adjusted
      }
      if (endpoint !== to) throw new Error('segment endpoint does not match the selected route')
      return { observed, adjusted, pointIds }
    }
    const referenceControls = (network: ReturnType<SurveyService['getNetwork']>) => new Map((network?.knownPoints ?? [])
      .filter(point => (point.known || point.pointClass === 'known') && point.height !== undefined)
      .map(point => [point.id, point.height!] as const))
    const referenceControlHeights = [referenceControls(referenceNetwork), referenceControls(currentNetwork)]
    const commonReferencePointIds = new Set([...referenceControlHeights[0].keys()].filter(id => referenceControlHeights[1].has(id)))
    const hasRawRandomModel = (network: ReturnType<SurveyService['getNetwork']>): boolean => (network?.observations ?? []).length > 0 && network!.observations.every(observation => observation.sigma !== undefined || (observation.covariance !== undefined && observation.covariance.length > 0))
    const routedSegments = request.segments.map(segment => {
      const prior = route(reference, segment.referenceObservationIds, segment.from, segment.to)
      const next = route(current, segment.currentObservationIds, segment.from, segment.to)
      return { segment, prior, next }
    })
    const segments = routedSegments.map(({ segment, prior, next }) => ({ ...segment, referenceObservedMetres: prior.observed, currentObservedMetres: next.observed,
        observedChangeMetres: next.observed-prior.observed, referenceAdjustedMetres: prior.adjusted,
        currentAdjustedMetres: next.adjusted, adjustedChangeMetres: next.adjusted-prior.adjusted,
        interpretation: 'current-minus-reference-height-difference' as const, standardsConformity: 'not-evaluated' as const }))
    const connectedControls = (network: ReturnType<SurveyService['getNetwork']>, seeds: ReadonlySet<string>, controls: ReadonlyMap<string, number>): Set<string> => {
      const adjacency = new Map<string, Set<string>>()
      for (const observation of network?.observations ?? []) {
        if (!observation.from || !observation.to) continue
        const from = adjacency.get(observation.from) ?? new Set<string>(); from.add(observation.to); adjacency.set(observation.from, from)
        const to = adjacency.get(observation.to) ?? new Set<string>(); to.add(observation.from); adjacency.set(observation.to, to)
      }
      const seen = new Set(seeds)
      const queue = [...seeds]
      for (let index = 0; index < queue.length; index += 1) {
        for (const next of adjacency.get(queue[index]!) ?? []) if (!seen.has(next)) { seen.add(next); queue.push(next) }
      }
      return new Set([...controls.keys()].filter(id => seen.has(id)))
    }
    const referenceSeeds = new Set(routedSegments.flatMap(({ prior }) => [...prior.pointIds]))
    const currentSeeds = new Set(routedSegments.flatMap(({ next }) => [...next.pointIds]))
    const referenceConnectedControls = connectedControls(referenceNetwork, referenceSeeds, referenceControlHeights[0])
    const currentConnectedControls = connectedControls(currentNetwork, currentSeeds, referenceControlHeights[1])
    const connectedReferencePointIds = new Set([...commonReferencePointIds].filter(id => referenceConnectedControls.has(id) && currentConnectedControls.has(id)))
    const rawRandomModelAvailable = hasRawRandomModel(referenceNetwork) && hasRawRandomModel(currentNetwork)
    const identifiabilityReason = commonReferencePointIds.size === 0
      ? 'reference-point-insufficient' as const
      : connectedReferencePointIds.size === 0
        ? 'overall-translation-unidentifiable' as const
        : !rawRandomModelAvailable ? 'raw-random-model-unavailable' as const : undefined
    const observationIdentifiability = SurveyObservationLayerIdentifiabilityV1.parse({
      status: identifiabilityReason ? 'unavailable' : 'available',
      ...(identifiabilityReason ? { reason: identifiabilityReason } : {}),
      referencePointCount: commonReferencePointIds.size,
      connectedReferencePointCount: connectedReferencePointIds.size,
      rawRandomModel: rawRandomModelAvailable ? 'provided' : 'unavailable'
    })
    /**
     * This is intentionally a small descriptive projection rather than a
     * congruence adjustment. It clusters selected segment changes against a
     * random-model-derived tolerance, and keeps the engineering decision
     * unevaluated so a common translation cannot be reported as stability.
     */
    const lengthScaleMetres = (unit: string | undefined): number | undefined => ({ m: 1, metre: 1, metres: 1, mm: 1e-3, cm: 1e-2, km: 1e3 }[unit?.trim().toLowerCase() ?? 'm'])
    const rawSigmaMetres = (observation: { sigma?: number; sigmaUnit?: string; covariance?: number[]; unit?: string }): number | undefined => {
      const scale = lengthScaleMetres(observation.sigmaUnit ?? observation.unit)
      if (scale === undefined) return undefined
      if (observation.sigma !== undefined && Number.isFinite(observation.sigma) && observation.sigma > 0) return observation.sigma * scale
      const variance = observation.covariance?.[0]
      if (variance !== undefined && Number.isFinite(variance) && variance > 0) return Math.sqrt(variance) * scale
      return undefined
    }
    const referenceRawById = new Map((referenceNetwork?.observations ?? []).map(observation => [observation.id, observation] as const))
    const currentRawById = new Map((currentNetwork?.observations ?? []).map(observation => [observation.id, observation] as const))
    const selectedSigmas = request.segments.flatMap(segment => [
      ...segment.referenceObservationIds.map(id => rawSigmaMetres(referenceRawById.get(id) ?? {})),
      ...segment.currentObservationIds.map(id => rawSigmaMetres(currentRawById.get(id) ?? {}))
    ])
    const congruenceUnavailableReason = observationIdentifiability.status === 'unavailable'
      ? observationIdentifiability.reason
      : !selectedSigmas.every((sigma): sigma is number => sigma !== undefined)
        ? 'raw-random-model-unavailable' as const
        : request.segments.length < 2 ? 'segment-insufficient' as const : undefined
    const rawObservationCongruence = congruenceUnavailableReason
      ? SurveyRawObservationCongruenceV1.parse({
        schemaVersion: 1, method: 'raw-observation-two-epoch-congruence-trial',
        status: 'unavailable', trialOnly: true, engineeringDecision: 'not-evaluated',
        segmentCount: request.segments.length, reason: congruenceUnavailableReason
      })
      : (() => {
        // Keep the narrowed values separate so the reduction remains sound
        // across TypeScript versions that do not carry an Array.every guard
        // into a later closure.
        const sigmaValues = selectedSigmas.filter((sigma): sigma is number => sigma !== undefined)
        const sigmaTolerance = 3 * Math.sqrt(sigmaValues.reduce((sum, sigma) => sum + sigma * sigma, 0))
        // Keep a finite lower bound for very small, but valid, declared sigmas.
        const toleranceMetres = Math.max(1e-12, sigmaTolerance)
        const changes = segments.map(segment => segment.observedChangeMetres)
        const meanObservedChangeMetres = changes.reduce((sum, value) => sum + value, 0) / changes.length
        const maximumResidualMetres = Math.max(...changes.map(value => Math.abs(value - meanObservedChangeMetres)))
        if (maximumResidualMetres > toleranceMetres) return SurveyRawObservationCongruenceV1.parse({
          schemaVersion: 1, method: 'raw-observation-two-epoch-congruence-trial',
          status: 'unavailable', trialOnly: true, engineeringDecision: 'not-evaluated',
          segmentCount: changes.length, reason: 'inconsistent-segment-differences'
        })
        return SurveyRawObservationCongruenceV1.parse({
          schemaVersion: 1, method: 'raw-observation-two-epoch-congruence-trial',
          // A near-zero difference means a network-wide translation cannot be
          // separated from the observations. Any non-zero, internally
          // consistent displacement is only a descriptive common-movement
          // candidate; formal significance is intentionally unevaluated.
          status: Math.abs(meanObservedChangeMetres) <= 1e-12 ? 'overall-translation' : 'common-movement',
          trialOnly: true, engineeringDecision: 'not-evaluated', segmentCount: changes.length,
          meanObservedChangeMetres, maximumResidualMetres, toleranceMetres
        })
      })()
    const legacyInputHash = digest({ request, referenceProjectionHash: reference.projectionHash, currentProjectionHash: current.projectionHash })
    const inputHash = digest({ request, referenceProjectionHash: reference.projectionHash, currentProjectionHash: current.projectionHash, observationIdentifiability, rawObservationCongruence })
    const requestHash = digest(request)
    const replay = this.db.prepare('SELECT request_hash,data_json FROM survey_segment_comparisons WHERE project_id=? AND idempotency_key=?').get(projectId, request.idempotencyKey) as StoredRow | undefined
    if (replay) {
      const result = SurveySegmentComparisonV1.parse(JSON.parse(replay.data_json))
      if (replay.request_hash !== requestHash || result.projectId !== projectId || (result.inputHash !== inputHash && !(result.inputHash === legacyInputHash && result.observationIdentifiability === undefined && result.rawObservationCongruence === undefined))
        || result.referenceAdjustmentId !== reference.runId || result.currentAdjustmentId !== current.runId
        || result.referenceResultHash !== reference.resultHash || result.currentResultHash !== current.resultHash
        || result.referenceProjectionHash !== reference.projectionHash || result.currentProjectionHash !== current.projectionHash
        || result.referenceEpoch !== referenceEpoch || result.currentEpoch !== currentEpoch
        || digest(result.segments) !== digest(segments)) throw new Error('segment comparison idempotency conflict')
      return result
    }
    const result = SurveySegmentComparisonV1.parse({ schemaVersion: 1, id: `segment_comparison_${randomUUID()}`, projectId,
      referenceAdjustmentId: reference.runId, currentAdjustmentId: current.runId,
      referenceResultHash: reference.resultHash, currentResultHash: current.resultHash,
      referenceProjectionHash: reference.projectionHash, currentProjectionHash: current.projectionHash,
      referenceEpoch, currentEpoch, segments, observationIdentifiability, rawObservationCongruence, inputHash, createdAt: this.nowIso() })
    this.db.prepare('INSERT INTO survey_segment_comparisons(id,project_id,idempotency_key,request_hash,data_json) VALUES (?,?,?,?,?)')
      .run(result.id,projectId,request.idempotencyKey,requestHash,JSON.stringify(result))
    return result
  }

  getSegmentComparisonForNewUse(projectId: string, comparisonId: string): SurveySegmentComparisonV1 | null {
    const row = this.db.prepare('SELECT idempotency_key,request_hash,data_json FROM survey_segment_comparisons WHERE project_id=? AND id=?')
      .get(projectId, comparisonId) as (StoredRow & { idempotency_key: string }) | undefined
    if (!row) return null
    const stored = SurveySegmentComparisonV1.parse(JSON.parse(row.data_json))
    if (stored.id !== comparisonId || stored.projectId !== projectId) throw new Error('segment comparison identity mismatch')
    const request = SurveySegmentComparisonRequestV1.parse({
      referenceAdjustmentId: stored.referenceAdjustmentId, currentAdjustmentId: stored.currentAdjustmentId,
      segments: stored.segments.map(({ id, from, to, referenceObservationIds, currentObservationIds }) => ({ id, from, to, referenceObservationIds, currentObservationIds })),
      idempotencyKey: row.idempotency_key
    })
    if (digest(request) !== row.request_hash) throw new Error('segment comparison request binding mismatch')
    // This replay recomputes signed routes from strict eligible results and checks both projection hashes.
    const current = this.compareSegments(projectId, request)
    if (current.id !== comparisonId || digest(current) !== digest(stored)) throw new Error('segment comparison durable evidence mismatch')
    return current
  }

  /**
   * Rebuild a cumulative period chain without persisting or rewriting any
   * comparison. Adjacent links are mandatory so a skipped or reordered epoch
   * cannot be presented as continuous monitoring history.
   */
  getContinuousSegmentSummaryForNewUse(projectId: string, comparisonIds: readonly string[]): SurveySegmentContinuity | null {
    if (!comparisonIds.length) return null
    if (new Set(comparisonIds).size !== comparisonIds.length) throw new Error('duplicate segment comparison identities')
    const comparisons = comparisonIds.map(id => this.getSegmentComparisonForNewUse(projectId, id))
    if (comparisons.some(item => !item)) throw new Error('selected segment comparison is unavailable')
    const values = comparisons as SurveySegmentComparisonV1[]
    for (let index = 1; index < values.length; index += 1) {
      const previous = values[index - 1]!, current = values[index]!
      if (previous.currentAdjustmentId !== current.referenceAdjustmentId || !(Date.parse(current.referenceEpoch) >= Date.parse(previous.currentEpoch)) || !(Date.parse(current.currentEpoch) > Date.parse(previous.currentEpoch))) {
        throw new Error('segment comparison chain is not adjacent and chronologically ordered')
      }
    }
    const first = values[0]!, last = values.at(-1)!
    const firstSegments = first.segments.map(segment => ({ id: segment.id, from: segment.from, to: segment.to }))
    for (const comparison of values.slice(1)) {
      if (comparison.segments.length !== firstSegments.length || comparison.segments.some(segment => {
        const expected = firstSegments.find(item => item.id === segment.id)
        return !expected || expected.from !== segment.from || expected.to !== segment.to
      })) throw new Error('segment comparison chain has inconsistent segment identities')
    }
    const segments = firstSegments.map(identity => {
      const periodChanges = values.map(comparison => {
        const segment = comparison.segments.find(item => item.id === identity.id)!
        return { comparisonId: comparison.id, referenceEpoch: comparison.referenceEpoch, currentEpoch: comparison.currentEpoch,
          observedChangeMetres: segment.observedChangeMetres, adjustedChangeMetres: segment.adjustedChangeMetres }
      })
      return { ...identity,
        observedCumulativeChangeMetres: periodChanges.reduce((sum, item) => sum + item.observedChangeMetres, 0),
        adjustedCumulativeChangeMetres: periodChanges.reduce((sum, item) => sum + item.adjustedChangeMetres, 0), periodChanges }
    })
    const payloadWithoutId = { schemaVersion: 1 as const, projectId,
      comparisonIds: [...comparisonIds], firstEpoch: first.referenceEpoch, currentEpoch: last.currentEpoch, segments }
    // Keep the public identity bounded even when a valid chain contains many
    // UUID comparison records. The full ordered chain remains covered by the
    // stored comparisonIds and inputHash.
    const id = `segment_continuity_${digest(payloadWithoutId).slice(0, 32)}`
    const payload = { ...payloadWithoutId, id }
    // The projection is intentionally not persisted. Reuse the final source
    // comparison's creation timestamp so repeated reads are deterministic.
    return SurveySegmentContinuityV1.parse({ ...payload, inputHash: digest(payload), createdAt: last.createdAt })
  }
}
