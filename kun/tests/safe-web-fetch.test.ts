import { describe, expect, it } from 'vitest'
import {
  SafeWebFetchError,
  isPublicInternetAddress,
  safeWebFetch,
  validateSafeWebUrl
} from '../src/network/safe-web-fetch.js'

function body(...chunks: string[]): AsyncIterable<Uint8Array> {
  return (async function * stream() {
    for (const chunk of chunks) yield Buffer.from(chunk)
  })()
}

describe('safeWebFetch', () => {
  it('checks the task origin scope before following a public redirect', async () => {
    const seen: string[] = []
    await expect(safeWebFetch('https://example.com/start', { allowedOrigins: ['https://example.com'] }, undefined, {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      transport: async ({ url }) => { seen.push(url.origin); return { status: 302, headers: { location: 'https://other.example.com/private' }, body: body() } }
    })).rejects.toMatchObject({ code: 'redirect_blocked' })
    expect(seen).toEqual(['https://example.com'])
    expect(() => validateSafeWebUrl('http://example.com', { allowedOrigins: ['https://example.com'] })).toThrow()
  })
  it('rejects private, special, and IPv4-mapped addresses', () => {
    for (const address of [
      '127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.1.1',
      '100.64.0.1', '0.0.0.0', '224.0.0.1', '::', '::1', 'fc00::1', 'fe80::1',
      'ff00::1', '::ffff:127.0.0.1', '2001:db8::1'
    ]) expect(isPublicInternetAddress(address), address).toBe(false)
    expect(isPublicInternetAddress('8.8.8.8')).toBe(true)
    expect(isPublicInternetAddress('2606:4700:4700::1111')).toBe(true)
  })

  it('rejects credentials and gives denyDomains precedence', () => {
    expect(() => validateSafeWebUrl('https://user:pass@example.com', {})).toThrow(SafeWebFetchError)
    expect(() => validateSafeWebUrl('https://api.example.com', {
      allowDomains: ['example.com'],
      denyDomains: ['api.example.com']
    })).toThrow(/blocked/)
  })

  it('rejects DNS rebinding answers containing any private address', async () => {
    await expect(safeWebFetch('https://example.com', {}, undefined, {
      lookup: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 }
      ]
    })).rejects.toMatchObject({ code: 'dns_blocked' })
  })

  it('pins a public address and revalidates every redirect', async () => {
    const seen: string[] = []
    await expect(safeWebFetch('https://example.com/start', {}, undefined, {
      lookup: async (hostname) => hostname === 'localhost'
        ? [{ address: '127.0.0.1', family: 4 }]
        : [{ address: '93.184.216.34', family: 4 }],
      transport: async ({ url, address }) => {
        seen.push(`${url.hostname}=${address}`)
        return {
          status: 302,
          headers: { location: 'http://localhost/private' },
          body: body()
        }
      }
    })).rejects.toMatchObject({ code: 'redirect_blocked' })
    expect(seen).toEqual(['example.com=93.184.216.34'])
  })

  it('rejects declared and streamed responses over the limit', async () => {
    const lookup = async () => [{ address: '93.184.216.34', family: 4 }]
    await expect(safeWebFetch('https://example.com', { maxBytes: 4 }, undefined, {
      lookup,
      transport: async () => ({ status: 200, headers: { 'content-length': '5' }, body: body('small') })
    })).rejects.toMatchObject({ code: 'payload_too_large' })
    await expect(safeWebFetch('https://example.com', { maxBytes: 4 }, undefined, {
      lookup,
      transport: async () => ({ status: 200, headers: {}, body: body('123', '45') })
    })).rejects.toMatchObject({ code: 'payload_too_large' })
  })

  it('returns a bounded successful response', async () => {
    const result = await safeWebFetch('https://example.com/a', { maxBytes: 16 }, undefined, {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      transport: async ({ address }) => {
        expect(address).toBe('93.184.216.34')
        return { status: 200, headers: { 'content-type': 'text/plain' }, body: body('safe') }
      }
    })
    expect(result.body.toString('utf8')).toBe('safe')
  })
})
