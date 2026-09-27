import { describe, expect, it } from 'vitest'
import { parseCosaNet, type CosaNetCoordinate } from './survey-cosa-net.js'

/** These inline inputs are synthetic grammar fixtures, not COSA-certified files. */
function coordinates(entries: Readonly<Record<string, readonly [number, number]>>): ReadonlyMap<string, CosaNetCoordinate> {
  return new Map(Object.entries(entries).map(([id, [x, y]]) => [id, { x, y }]))
}

describe('COSA .NET reader', () => {
  it('returns typed counter-clockwise topology with immutable UTF-8 byte anchors', () => {
    const source = 'A,B,C\r\nC,D,E\n'
    const result = parseCosaNet(source, coordinates({
      A: [0, 0], B: [5, 0], C: [0, 3], D: [1, 3], E: [0, 4]
    }))

    expect(result).toMatchObject({ state: 'valid', diagnostics: [] })
    expect(result.triangles).toMatchObject([
      { id: 'cosa-net-triangle-1', points: ['A', 'B', 'C'], signedDoubleArea: 15, orientation: 'counter-clockwise' },
      { id: 'cosa-net-triangle-2', points: ['C', 'D', 'E'], signedDoubleArea: 1, orientation: 'counter-clockwise' }
    ])
    expect(result.records).toEqual([
      expect.objectContaining({ line: 1, rawOffset: 0, rawLength: 5, rawSnippet: 'A,B,C' }),
      expect.objectContaining({ line: 2, byteOffset: 7, byteLength: 5, rawOffset: 7, rawLength: 5, rawSnippet: 'C,D,E' })
    ])
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.triangles)).toBe(true)
  })

  it('keeps a clockwise record unchanged and returns a warning with the required swap suggestion', () => {
    const result = parseCosaNet('A,C,B\n', coordinates({ A: [0, 0], B: [5, 0], C: [0, 3] }))

    expect(result).toMatchObject({ state: 'valid' })
    expect(result.triangles[0]).toMatchObject({ points: ['A', 'C', 'B'], signedDoubleArea: -15, orientation: 'clockwise' })
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'clockwise-triangle',
        severity: 'warning',
        suggestedAction: expect.stringContaining('建议交换后两点')
      })
    ])
  })

  it('returns no partial usable topology when malformed, duplicate, or coordinate-incomplete records are present', () => {
    const result = parseCosaNet([
      'A,B,C',
      'A,A,B',
      'A,B',
      'A,D,MISSING'
    ].join('\n'), coordinates({ A: [0, 0], B: [5, 0], C: [0, 3], D: [1, 3] }))

    expect(result.state).toBe('blocked')
    expect(result.triangles).toEqual([])
    expect(result.records).toHaveLength(4)
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'duplicate-point-id', severity: 'blocking', recoverable: true, recordAnchor: expect.objectContaining({ line: 2 }) }),
      expect.objectContaining({ code: 'invalid-record', severity: 'blocking', recoverable: true, recordAnchor: expect.objectContaining({ line: 3 }) }),
      expect.objectContaining({ code: 'missing-coordinate', severity: 'blocking', recoverable: true, recordAnchor: expect.objectContaining({ line: 4 }) })
    ]))
  })

  it('blocks collinear geometry and non-ASCII input with source-anchored diagnostics', () => {
    const collinear = parseCosaNet('A,B,D\n', coordinates({ A: [0, 0], B: [5, 0], D: [1, 0] }))
    expect(collinear).toMatchObject({ state: 'blocked', triangles: [] })
    expect(collinear.diagnostics).toEqual([
      expect.objectContaining({ code: 'degenerate-triangle', severity: 'blocking', recordAnchor: expect.objectContaining({ line: 1, rawSnippet: 'A,B,D' }) })
    ])

    const encoded = parseCosaNet('A,测点,C', coordinates({ A: [0, 0], C: [0, 3] }))
    expect(encoded).toMatchObject({ state: 'blocked', triangles: [] })
    expect(encoded.diagnostics[0]).toMatchObject({ code: 'invalid-encoding', severity: 'blocking', recoverable: true, recordAnchor: expect.objectContaining({ byteOffset: 2, rawSnippet: expect.stringMatching(/^hex:/) }) })
  })

  it('bounds line length, records, bytes and coordinate dimensions before building topology', () => {
    const points = coordinates({ A: [0, 0], B: [5, 0], C: [0, 3] })
    expect(parseCosaNet('A,B,C'.padEnd(16_384), points).state).toBe('valid')
    expect(parseCosaNet('A,B,C\r\n'.repeat(10_000), points).triangles).toHaveLength(10_000)
    const oversizedPoints = new Map(Array.from({ length: 10_001 }, (_, i) => [`P${i}`, { x: i, y: 0 }]))
    for (const [source, map] of [
      ['A,B,C'.padEnd(16_385), points],
      ['A,B,C\r\n'.repeat(10_001), points],
      ['A,B,C\n'.repeat(10_000) + 'A,B,C', points],
      [' '.repeat(8 * 1024 * 1024 + 1), points],
      [new Uint8Array(8 * 1024 * 1024 + 1), points],
      ['A,B,C', oversizedPoints]
    ] as const) {
      const result = parseCosaNet(source, map)
      expect(result).toMatchObject({ state: 'blocked', triangles: [] })
      expect(result.diagnostics).toHaveLength(1)
      expect(result.diagnostics[0]).toMatchObject({ code: 'resource-limit', severity: 'blocking' })
      expect(result.records).toHaveLength(1)
    }
  })
})
