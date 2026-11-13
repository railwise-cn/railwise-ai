import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TaskArtifactPreviewService } from './task-artifact-preview-service'
import { taskArtifactPreviewScope } from '../../shared/task-artifact-preview'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })
async function fixture() {
  const temporary = await mkdtemp(join(tmpdir(), 'railwise-html-preview-'))
  cleanup.push(() => rm(temporary, { recursive: true, force: true }))
  const root = await realpath(temporary)
  await mkdir(join(root, 'assets'))
  const content = '<!doctype html><html lang="zh-CN"><head><link rel="stylesheet" href="assets/report.css"></head><body>合成网页<script>document.title="报告"</script></body></html>'
  const entries = [{ id: 'html', path: '报告 网页.html', content }, { id: 'css', path: 'assets/report.css', content: 'body{color:#123}' }]
  const proofs = new Map<string, Record<string, string>>()
  for (const entry of entries) {
    const path = join(root, entry.path)
    await writeFile(path, entry.content)
    proofs.set(entry.id, { taskId: 'task', artifactId: entry.id, absolutePath: path, authorizedRoot: root, executionGrantId: 'grant', turnId: 'turn', operationId: entry.id, sha256: createHash('sha256').update(entry.content).digest('hex') })
  }
  const service = new TaskArtifactPreviewService(async path => {
    if (path === '/v1/tasks/task') return { ok: true, status: 200, body: JSON.stringify({ artifacts: [...proofs.values()].map(proof => ({ id: proof.artifactId, sha256: proof.sha256, validation: 'valid' })) }) }
    const id = /^\/v1\/tasks\/task\/artifacts\/(\w+)\/proof$/.exec(path)?.[1]
    return { ok: Boolean(id && proofs.has(id)), status: id && proofs.has(id) ? 200 : 404, body: JSON.stringify(id && proofs.get(id)) }
  })
  cleanup.push(() => service.dispose())
  return { service, root, content, proofs }
}

describe('verified loopback HTML artifact preview', () => {
  it('serves the real Chinese HTML and its registered companion with isolated response policy', async () => {
    const f = await fixture()
    const preview = await f.service.open({ taskId: 'task', artifactId: 'html' })
    const response = await fetch(preview.url)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(f.content)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(response.headers.get('content-security-policy')).toContain("connect-src 'none'")
    expect(response.headers.get('content-security-policy')).toContain('sandbox allow-scripts allow-same-origin')
    expect(response.headers.get('cache-control')).toBe('no-store')
    const css = await fetch(new URL('assets/report.css', preview.url))
    expect(await css.text()).toBe('body{color:#123}')
    expect(taskArtifactPreviewScope(preview.url)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/task-preview\/[a-f0-9]{48}\/$/)
  })

  it('rejects unregistered resources, traversal, bad capability, mutation and changed files', async () => {
    const f = await fixture()
    const preview = await f.service.open({ taskId: 'task', artifactId: 'html' })
    await writeFile(join(f.root, 'private.txt'), 'private')
    expect((await fetch(new URL('private.txt', preview.url))).status).toBe(404)
    expect((await fetch(new URL('%2e%2e%2fprivate.txt', preview.url))).status).toBe(403)
    expect((await fetch(preview.url.replace(/task-preview\/[a-f0-9]{48}/, `task-preview/${'0'.repeat(48)}`))).status).toBe(410)
    expect((await fetch(preview.url, { method: 'POST', body: 'x' })).status).toBe(403)
    await writeFile(f.proofs.get('html')!.absolutePath!, 'changed')
    expect((await fetch(preview.url)).status).toBe(409)
  })

  it('serves updated companion bytes only through a newly verified snapshot', async () => {
    const f = await fixture()
    const first = await f.service.open({ taskId: 'task', artifactId: 'html' })
    const css = f.proofs.get('css')!
    const nextContent = 'body{color:#456}'
    await writeFile(css.absolutePath!, nextContent)
    css.sha256 = createHash('sha256').update(nextContent).digest('hex')
    expect((await fetch(new URL('assets/report.css', first.url))).status).toBe(409)
    const renewed = await f.service.open({ taskId: 'task', artifactId: 'html' })
    expect(renewed.url).not.toBe(first.url)
    expect(await (await fetch(renewed.url)).text()).toBe(f.content)
    const response = await fetch(new URL('assets/report.css', renewed.url))
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(nextContent)
    expect((await fetch(new URL('assets/report.css', first.url))).status).toBe(409)
  })

  it('refuses symlink replacement and a different task identity', async () => {
    const f = await fixture()
    const preview = await f.service.open({ taskId: 'task', artifactId: 'html' })
    const path = f.proofs.get('html')!.absolutePath!
    await rm(path)
    await writeFile(join(f.root, 'replacement.html'), f.content)
    await symlink(join(f.root, 'replacement.html'), path)
    expect((await fetch(preview.url)).status).toBe(409)
    await expect(f.service.open({ taskId: 'other', artifactId: 'html' })).rejects.toThrow()
    expect(taskArtifactPreviewScope('file:///tmp/report.html')).toBeNull()
    expect(taskArtifactPreviewScope(preview.url.replace('127.0.0.1', 'example.com'))).toBeNull()
  })
})
