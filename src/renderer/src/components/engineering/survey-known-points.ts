export type SurveyKnownPointInput = { id: string; height: number; x?: number; y?: number }

/** Explicit metre-valued control points. Empty input makes no datum assumption. */
export function parseSurveyKnownPoints(text: string): SurveyKnownPointInput[] {
  const ids = new Set<string>()
  return text.replace(/^\uFEFF/, '').split(/\r?\n/).flatMap((line, index) => {
    const value = line.trim()
    if (!value || value.startsWith('#')) return []
    const fields = /[,;]/.test(value) ? value.split(/[,;]/).map((field) => field.trim()) : value.split(/\s+/)
    if ((fields.length !== 2 && fields.length !== 4) || !fields[0] || ids.has(fields[0]) || ids.size >= 10_000) throw new Error(String(index + 1))
    const values = fields.slice(1).map(Number)
    if (fields.slice(1).some((field) => !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(field)) || values.some((number) => !Number.isFinite(number))) throw new Error(String(index + 1))
    ids.add(fields[0])
    return [{ id: fields[0], height: values[0], ...(fields.length === 4 ? { x: values[1], y: values[2] } : {}) }]
  })
}
