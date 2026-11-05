import { describe, expect, it } from 'vitest'
import { parseClawCommand } from './claw-commands'

describe('parseClawCommand', () => {
  it('recognizes local connection status commands', () => {
    expect(parseClawCommand('/status')).toEqual({ kind: 'status' })
    expect(parseClawCommand('-状态')).toEqual({ kind: 'status' })
    expect(parseClawCommand('／微信状态')).toEqual({ kind: 'status' })
  })
})

it('parses current Flash and legacy model aliases for provider-aware migration', () => {
  expect(parseClawCommand('/model flash')).toEqual({ kind: 'model', model: 'deepseek-flash' })
  expect(parseClawCommand('/model deepseek-flash')).toEqual({ kind: 'model', model: 'deepseek-flash' })
  expect(parseClawCommand('/model deepseek-v4-flash')).toEqual({ kind: 'model', model: 'deepseek-v4-flash' })
})
