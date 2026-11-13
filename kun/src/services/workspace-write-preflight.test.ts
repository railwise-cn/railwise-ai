import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createThreadRecord } from '../domain/thread.js'
import { explicitWorkspaceWrite, workspaceWritePreflight } from './workspace-write-preflight.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
describe('explicit workspace write admission', () => {
  it('keeps ordinary HTML generation and questions on the managed/chat paths', () => {
    for (const text of ['请生成一个漂亮的 HTML 网页报告。', '生成 report.html 并在右侧展示。', '如何保存到当前工作区？', '解释如何修改 report.html 文件。']) expect(explicitWorkspaceWrite(text)).toBeNull()
    expect(explicitWorkspaceWrite('请保存到 "F:\\Projects\\报告.html"。')?.target).toBe('F:\\Projects\\报告.html')
    expect(explicitWorkspaceWrite('修改当前工作区的 README.md 文件。')?.edit).toBe(true)
  })
  it('requires the exact workspace exception and does not widen a confirmed path scope', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'workspace-preflight-')); roots.push(temporary)
    const root = await realpath(temporary)
    const thread = createThreadRecord({ id: 'thread', title: 'synthetic', model: 'synthetic', workspace: root, approvalPolicy: 'on-request', sandboxMode: 'workspace-write' })
    const workspaceTrust = { get: async () => ({ canonicalRoot: root, level: 'read-only' as const, revision: 0 }) }
    const initial = workspaceWritePreflight({ workspaceTrust, restriction: async () => ({}) })
    expect(await initial('保存到 report.html', thread)).toMatchObject({ provider: 'workspace', status: 'blocked', errorCode: 'workspace_path_blocked' })
    expect(await initial('生成 HTML 报告', thread)).toBeNull()
    const permitted = workspaceWritePreflight({ workspaceTrust, restriction: async () => ({ workspaceWriteException: true, permissionScope: { writePaths: [join(root, 'approved')] } }) })
    expect(await permitted('保存到 approved/report.html', thread)).toBeNull()
    expect(await permitted('保存到 outside/report.html', thread)).toMatchObject({ errorCode: 'workspace_path_blocked' })
    expect(await permitted('保存到 approved/report.html', { ...thread, sandboxMode: 'read-only' })).toMatchObject({ errorCode: 'sandbox_read_only' })
  })
})
