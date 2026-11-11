import { lookup as dnsLookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import ipaddr from 'ipaddr.js'

type LookupAddress = { address: string; family: number }

export type SafeWebFetchErrorCode =
  | 'unsafe_url'
  | 'dns_blocked'
  | 'redirect_blocked'
  | 'payload_too_large'
  | 'fetch_failed'

export class SafeWebFetchError extends Error {
  constructor(readonly code: SafeWebFetchErrorCode, message: string) {
    super(message)
    this.name = 'SafeWebFetchError'
  }
}

export type SafeWebFetchPolicy = {
  allowedOrigins?: string[]
  allowDomains?: string[]
  denyDomains?: string[]
  maxBytes?: number
  maxRedirects?: number
  dnsTimeoutMs?: number
  connectTimeoutMs?: number
  totalTimeoutMs?: number
}

type TransportResponse = {
  status: number
  headers: Record<string, string | undefined>
  body: AsyncIterable<Uint8Array>
}

type SafeWebFetchDependencies = {
  lookup?: (hostname: string) => Promise<LookupAddress[]>
  transport?: (input: {
    url: URL
    address: string
    family: number
    connectTimeoutMs: number
    signal: AbortSignal
  }) => Promise<TransportResponse>
}

export type SafeWebFetchResult = {
  finalUrl: string
  status: number
  headers: Record<string, string | undefined>
  body: Buffer
  redirects: number
}

const HARD_MAX_BYTES = 5 * 1024 * 1024

export function isPublicInternetAddress(address: string): boolean {
  try {
    let parsed = ipaddr.parse(address)
    if (parsed instanceof ipaddr.IPv6 && parsed.isIPv4MappedAddress()) {
      parsed = parsed.toIPv4Address()
    }
    return parsed.range() === 'unicast'
  } catch {
    return false
  }
}

function domainMatches(hostname: string, configured: string): boolean {
  const domain = configured.trim().toLowerCase().replace(/^\./, '')
  return Boolean(domain) && (hostname === domain || hostname.endsWith(`.${domain}`))
}

export function validateSafeWebUrl(raw: string | URL, policy: SafeWebFetchPolicy): URL {
  let url: URL
  try {
    url = raw instanceof URL ? new URL(raw.href) : new URL(raw)
  } catch {
    throw new SafeWebFetchError('unsafe_url', 'URL is invalid.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SafeWebFetchError('unsafe_url', 'Only HTTP and HTTPS URLs are allowed.')
  }
  if (url.username || url.password) {
    throw new SafeWebFetchError('unsafe_url', 'URL credentials are not allowed.')
  }
  const hostname = url.hostname.toLowerCase()
  if (policy.allowedOrigins && !policy.allowedOrigins.some(value => {
    if (value === '*') return true
    try { return new URL(value).origin === url.origin } catch { return value.toLowerCase() === hostname }
  })) throw new SafeWebFetchError('redirect_blocked', 'The URL is outside the authorized network scope.')
  if ((policy.denyDomains ?? []).some((domain) => domainMatches(hostname, domain))) {
    throw new SafeWebFetchError('unsafe_url', 'The URL is blocked by policy.')
  }
  if ((policy.allowDomains?.length ?? 0) > 0 &&
    !(policy.allowDomains ?? []).some((domain) => domainMatches(hostname, domain))) {
    throw new SafeWebFetchError('unsafe_url', 'The URL is not allowed by policy.')
  }
  return url
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new SafeWebFetchError('dns_blocked', 'DNS validation timed out.')), timeoutMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function resolvePinnedAddress(
  hostname: string,
  policy: SafeWebFetchPolicy,
  dependencies: SafeWebFetchDependencies
): Promise<LookupAddress> {
  const literalFamily = isIP(hostname)
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await withTimeout(
      dependencies.lookup?.(hostname) ?? dnsLookup(hostname, { all: true, verbatim: true }),
      policy.dnsTimeoutMs ?? 3_000
    ).catch((error) => {
      if (error instanceof SafeWebFetchError) throw error
      throw new SafeWebFetchError('dns_blocked', 'DNS validation failed.')
    })
  if (addresses.length === 0 || addresses.some((entry) => !isPublicInternetAddress(entry.address))) {
    throw new SafeWebFetchError('dns_blocked', 'The resolved address is not public.')
  }
  return addresses[0]!
}

async function nativeTransport(input: {
  url: URL
  address: string
  family: number
  connectTimeoutMs: number
  signal: AbortSignal
}): Promise<TransportResponse> {
  return new Promise((resolveResponse, reject) => {
    const request = (input.url.protocol === 'https:' ? httpsRequest : httpRequest)({
      protocol: input.url.protocol,
      hostname: input.url.hostname,
      port: input.url.port || undefined,
      method: 'GET',
      path: `${input.url.pathname}${input.url.search}`,
      servername: input.url.hostname,
      headers: {
        Host: input.url.host,
        'Accept-Encoding': 'identity',
        'User-Agent': 'RailWise AI/0.2.5'
      },
      lookup: (_hostname, _options, callback) => callback(null, input.address, input.family)
    }, (response) => {
      clearTimeout(connectTimer)
      const headers: Record<string, string | undefined> = {}
      for (const [key, value] of Object.entries(response.headers)) {
        headers[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value
      }
      resolveResponse({ status: response.statusCode ?? 0, headers, body: response })
    })
    const fail = () => request.destroy(new SafeWebFetchError('fetch_failed', 'Request was cancelled.'))
    input.signal.addEventListener('abort', fail, { once: true })
    const connectTimer = setTimeout(() => {
      request.destroy(new SafeWebFetchError('fetch_failed', 'Connection timed out.'))
    }, input.connectTimeoutMs)
    request.once('error', (error) => {
      clearTimeout(connectTimer)
      input.signal.removeEventListener('abort', fail)
      reject(error instanceof SafeWebFetchError
        ? error
        : new SafeWebFetchError('fetch_failed', 'The remote request failed.'))
    })
    request.end()
  })
}

function redirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

export async function safeWebFetch(
  rawUrl: string,
  policy: SafeWebFetchPolicy = {},
  signal?: AbortSignal,
  dependencies: SafeWebFetchDependencies = {}
): Promise<SafeWebFetchResult> {
  const controller = new AbortController()
  const onAbort = () => controller.abort(signal?.reason)
  signal?.addEventListener('abort', onAbort, { once: true })
  const totalTimer = setTimeout(() => controller.abort('total timeout'), policy.totalTimeoutMs ?? 15_000)
  const maxBytes = Math.min(policy.maxBytes ?? 1024 * 1024, HARD_MAX_BYTES)
  const maxRedirects = Math.min(policy.maxRedirects ?? 5, 5)
  let current = validateSafeWebUrl(rawUrl, policy)
  let redirects = 0

  try {
    while (true) {
      if (controller.signal.aborted) throw new SafeWebFetchError('fetch_failed', 'The request timed out or was cancelled.')
      let pinned: LookupAddress
      try {
        pinned = await resolvePinnedAddress(current.hostname, policy, dependencies)
      } catch (error) {
        if (redirects > 0 && error instanceof SafeWebFetchError &&
          (error.code === 'unsafe_url' || error.code === 'dns_blocked')) {
          throw new SafeWebFetchError('redirect_blocked', 'Redirect policy blocked the request.')
        }
        throw error
      }
      const response = await (dependencies.transport ?? nativeTransport)({
        url: current,
        address: pinned.address,
        family: pinned.family,
        connectTimeoutMs: policy.connectTimeoutMs ?? 5_000,
        signal: controller.signal
      })
      if (redirectStatus(response.status)) {
        const location = response.headers.location
        if (!location || redirects >= maxRedirects) {
          throw new SafeWebFetchError('redirect_blocked', 'Redirect policy blocked the request.')
        }
        try {
          current = validateSafeWebUrl(new URL(location, current), policy)
        } catch {
          throw new SafeWebFetchError('redirect_blocked', 'Redirect policy blocked the request.')
        }
        redirects += 1
        continue
      }
      if (response.status < 200 || response.status >= 300) {
        throw new SafeWebFetchError('fetch_failed', `Remote server returned HTTP ${response.status}.`)
      }
      const encoding = response.headers['content-encoding']?.trim().toLowerCase()
      if (encoding && encoding !== 'identity') {
        throw new SafeWebFetchError('payload_too_large', 'Compressed responses are not accepted.')
      }
      const declaredLength = Number(response.headers['content-length'] ?? '')
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        throw new SafeWebFetchError('payload_too_large', 'Response exceeds the allowed size.')
      }
      const chunks: Uint8Array[] = []
      let total = 0
      for await (const chunk of response.body) {
        total += chunk.byteLength
        if (total > maxBytes) {
          controller.abort('payload too large')
          throw new SafeWebFetchError('payload_too_large', 'Response exceeds the allowed size.')
        }
        chunks.push(chunk)
      }
      return {
        finalUrl: current.href,
        status: response.status,
        headers: response.headers,
        body: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
        redirects
      }
    }
  } finally {
    clearTimeout(totalTimer)
    signal?.removeEventListener('abort', onAbort)
  }
}
