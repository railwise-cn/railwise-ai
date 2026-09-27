import { readFileSync } from 'node:fs'

// Serialization only: no product imports, model computation, database or network.
const { value, sort } = JSON.parse(readFileSync(0, 'utf8'))
function canonical(input) {
  if (Array.isArray(input)) return `[${input.map(canonical).join(',')}]`
  if (input !== null && typeof input === 'object') {
    return `{${Object.keys(input).sort().map(key => `${JSON.stringify(key)}:${canonical(input[key])}`).join(',')}}`
  }
  if (typeof input === 'number' && !Number.isFinite(input)) throw new Error('Non-finite JSON number')
  return JSON.stringify(input)
}
process.stdout.write(sort ? canonical(value) : JSON.stringify(value))
