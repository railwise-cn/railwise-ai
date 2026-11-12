import { request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { startNodeHttpServer, type NodeHttpServerHandle } from './node-http-server.js'
import { Router } from './router.js'
import { buildRouter } from './routes/index.js'
import type { ServerRuntime } from './routes/server-runtime.js'

async function withServer(router: Router, run: (server: NodeHttpServerHandle) => Promise<void>): Promise<void> {
  const server = await startNodeHttpServer({ router, host: '127.0.0.1', port: 0 })
  try { await run(server) } finally { await server.close() }
}

function send(
  port: number,
  headers: Record<string, string>,
  write: (request: ReturnType<typeof httpRequest>) => void = (request) => request.end(),
  path = '/body'
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path, method: 'POST', headers, agent: false }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => { body += chunk })
      response.on('end', () => resolve({ status: response.statusCode!, body }))
      response.on('error', reject)
    })
    request.on('error', reject)
    request.setTimeout(5_000, () => request.destroy(new Error('HTTP test request timed out')))
    write(request)
  })
}

function bodyRouter(): Router {
  const router = new Router()
  router.add('POST', '/body', async (request) => Response.json({
    hasBody: request.body !== null,
    text: await request.text()
  }))
  return router
}

describe('Node HTTP request body framing', () => {
  it.each(['lark', 'dws'] as const)('refreshes %s through the real transport with a bodyless POST', async (provider) => {
    const refresh = vi.fn(async () => ({ status: 'not_installed' }))
    const callback = provider === 'lark' ? 'refreshLark' : 'refreshDws'
    const router = buildRouter({ runtimeToken: 'transport-test-token', insecure: false, [callback]: refresh } as unknown as ServerRuntime)
    await withServer(router, async ({ port }) => {
      const response = await send(port, { authorization: 'Bearer transport-test-token', 'content-length': '0' }, undefined, `/v1/connectors/${provider}/refresh`)
      expect(response.status).toBe(200)
      expect(JSON.parse(response.body)).toEqual({ status: 'not_installed' })
      expect(refresh).toHaveBeenCalledOnce()
    })
  })

  it('preserves a null body for a POST without payload framing', async () => {
    await withServer(bodyRouter(), async ({ port }) => {
      const rawResponse = await new Promise<string>((resolve, reject) => {
        const socket = connect({ host: '127.0.0.1', port }, () => {
          socket.end('POST /body HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n')
        })
        let response = ''
        socket.setEncoding('utf8')
        socket.on('data', (chunk: string) => { response += chunk })
        socket.on('end', () => resolve(response))
        socket.on('error', reject)
        socket.setTimeout(5_000, () => socket.destroy(new Error('Raw HTTP test timed out')))
      })
      expect(rawResponse).toContain('200 OK')
      expect(rawResponse).toContain('{"hasBody":false,"text":""}')
    })
  })

  it('preserves a positive Content-Length payload', async () => {
    await withServer(bodyRouter(), async ({ port }) => {
      const payload = '{"message":"连接器"}'
      const response = await send(port, { 'content-length': String(Buffer.byteLength(payload)) }, (request) => request.end(payload))
      expect(response.status).toBe(200)
      expect(JSON.parse(response.body)).toEqual({ hasBody: true, text: payload })
    })
  })

  it.each(['', '{"message":"chunked"}'])('preserves chunked framing and content (%j)', async (payload) => {
    await withServer(bodyRouter(), async ({ port }) => {
      const response = await send(port, { 'transfer-encoding': 'chunked' }, (request) => request.end(payload))
      expect(response.status).toBe(200)
      expect(JSON.parse(response.body)).toEqual({ hasBody: true, text: payload })
    })
  })

  it('dispatches and streams the first chunk before the request finishes', async () => {
    let signalFirstChunk!: () => void
    const firstChunk = new Promise<void>((resolve) => { signalFirstChunk = resolve })
    const router = new Router()
    router.add('POST', '/body', async (request) => {
      const reader = request.body!.getReader()
      const first = await reader.read()
      expect(new TextDecoder().decode(first.value)).toBe('first')
      signalFirstChunk()
      const chunks = [first.value!]
      while (true) {
        const next = await reader.read()
        if (next.done) break
        chunks.push(next.value)
      }
      reader.releaseLock()
      return new Response(Buffer.concat(chunks).toString())
    })
    await withServer(router, async ({ port }) => {
      const response = await send(port, { 'transfer-encoding': 'chunked' }, (request) => {
        request.write('first')
        void firstChunk.then(() => request.end('second'))
      })
      expect(response).toEqual({ status: 200, body: 'firstsecond' })
    })
  })

  it.each<Record<string, string>>([{ 'content-length': '2' }, { 'transfer-encoding': 'chunked' }])('still rejects payloads at bodyless routes (%j)', async (headers) => {
    const refresh = vi.fn(async () => ({}))
    const router = buildRouter({ runtimeToken: 'transport-test-token', insecure: false, refreshDws: refresh } as unknown as ServerRuntime)
    await withServer(router, async ({ port }) => {
      const response = await send(port, { ...headers, authorization: 'Bearer transport-test-token' }, (request) => request.end('{}'), '/v1/connectors/dws/refresh')
      expect(response.status).toBe(400)
      expect(refresh).not.toHaveBeenCalled()
    })
  })
})
