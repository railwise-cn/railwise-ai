import { describe, expect, it } from 'vitest'
import { MAX_DEFORMATION_PAIRS, parseDeformationPairs, type DeformationPairDraft } from './SurveyDeformationPairsForm'

const pair: DeformationPairDraft = { rowKey: 'row-1', id: 'Section A', firstPointId: 'A', secondPointId: 'B', kind: 'tilt', distanceMode: 'horizontal', baseline: '' }

describe('deformation segment safety', () => {
  it('leaves an unspecified baseline to the established epoch calculation and excludes UI row identity', () => {
    expect(parseDeformationPairs([pair])).toEqual([{ id: 'Section A', firstPointId: 'A', secondPointId: 'B', kind: 'tilt', distanceMode: 'horizontal' }])
    expect(parseDeformationPairs([{ ...pair, baseline: '12.5' }])?.[0]).toHaveProperty('baselineM', 12.5)
  })

  it('does not carry a hidden tilt baseline into a convergence request', () => {
    expect(parseDeformationPairs([{ ...pair, kind: 'convergence', distanceMode: 'spatial', baseline: '12.5' }])?.[0]).not.toHaveProperty('baselineM')
  })

  it.each(['0', '-1', 'Infinity', 'NaN'])('rejects a non-positive or non-finite baseline %s', baseline => {
    expect(parseDeformationPairs([{ ...pair, baseline }])).toBeNull()
  })

  it('rejects ambiguous duplicate names, identical endpoints and an incompatible tilt distance', () => {
    expect(parseDeformationPairs([pair, { ...pair, rowKey: 'row-2', id: ' Section A ' }])).toBeNull()
    expect(parseDeformationPairs([{ ...pair, secondPointId: ' A ' }])).toBeNull()
    expect(parseDeformationPairs([{ ...pair, distanceMode: 'vertical' }])).toBeNull()
  })

  it('accepts the service limit but refuses an oversized segment list', () => {
    const pairs = Array.from({ length: MAX_DEFORMATION_PAIRS }, (_, index) => ({ ...pair, rowKey: String(index), id: `Segment ${index}` }))
    expect(parseDeformationPairs(pairs)).toHaveLength(MAX_DEFORMATION_PAIRS)
    expect(parseDeformationPairs([...pairs, { ...pair, id: 'overflow' }])).toBeNull()
  })
})
