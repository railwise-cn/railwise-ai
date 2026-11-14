import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createThreadRecord } from '../domain/thread.js'
import { explicitWorkspaceWrite, workspaceWritePreflight } from './workspace-write-preflight.js'

const roots: string[] = []
const browserReportRequest = '新任务：使用 broswer-skill，帮我到 https://zfcg.czt.zj.gov.cn/ 和 https://ygcg.nbcqjy.org/home 获取最近七天与工程测量、工程监测相关的公开招标公告。允许在这两个公开站点的搜索框输入“工程测量”“工程监测”并点击搜索、翻页，不提交报名或业务表单。读取公告正文，核对标题、日期、预算、截止时间、资格条款，缺失标为待核验，说明各来源覆盖情况。生成精美可打印中文 HTML 招标简报，保存到本任务成果并自动打开右侧预览。持久创建每日两次计划，九点前和五点前交付，提前30分钟启动。此前暂停的任务保持暂停。'
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
describe('explicit workspace write admission', () => {
  it('keeps ordinary HTML generation and questions on the managed/chat paths', () => {
    for (const text of ['请生成一个漂亮的 HTML 网页报告。', '生成 report.html 并在右侧展示。', '如何保存到当前工作区？', '解释如何修改 report.html 文件。', '保存到飞书云盘', '修改 GitHub 上的 README.md 文件']) expect(explicitWorkspaceWrite(text)).toBeNull()
    expect(explicitWorkspaceWrite('请保存到 "F:\\Projects\\报告.html"。')?.target).toBe('F:\\Projects\\报告.html')
    expect(explicitWorkspaceWrite('修改当前工作区的 README.md 文件。')?.edit).toBe(true)
    expect(explicitWorkspaceWrite('修改当前工作区的 README.md 文件。')?.target).toBe('README.md')
    expect(explicitWorkspaceWrite('保存到 项目资料/report.html')?.target).toBe('项目资料/report.html')
  })
  it('recognizes task-managed output destinations without treating their prose as workspace paths', () => {
    for (const text of [browserReportRequest, '保存到本任务成果并自动打开右侧预览。',
      '将 HTML 导出至当前任务的成果目录。', '保存到任务成果，文件名为 report.html。',
      '将报告输出到本任务输出目录并展示。', '生成HTML，保存为本任务成果并打开预览。']) {
      expect(explicitWorkspaceWrite(text), text).toBeNull()
    }
  })
  it('still checks actual destinations and edits in a mixed managed-output request', () => {
    expect(explicitWorkspaceWrite('保存到本任务成果并自动打开右侧预览，再保存到 "F:\\Projects\\报告.html"。')?.target).toBe('F:\\Projects\\报告.html')
    expect(explicitWorkspaceWrite('保存到本任务成果；输出至 ../shared/report.html。')?.target).toBe('../shared/report.html')
    expect(explicitWorkspaceWrite('保存到本任务成果并自动打开右侧预览。修改当前工作区的 README.md 文件。')).toEqual({ target: 'README.md', edit: true })
    for (const text of ['保存到本任务成果目录/report.html', '保存到 "本任务成果/report.html"', '保存到工作区的本任务成果目录']) {
      expect(explicitWorkspaceWrite(text), text).not.toBeNull()
    }
  })
  it('admits the actual browser report in a read-only thread while retaining write admission for mixed requests', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'managed-artifact-preflight-')); roots.push(temporary)
    const root = await realpath(temporary)
    const thread = createThreadRecord({ id: 'readonly-report', title: 'synthetic', model: 'synthetic', workspace: root, approvalPolicy: 'on-request', sandboxMode: 'read-only' })
    const check = workspaceWritePreflight({ workspaceTrust: { get: async () => ({ canonicalRoot: root, level: 'read-only' as const, revision: 0 }) }, restriction: async () => ({}) })
    expect(await check(browserReportRequest, thread)).toBeNull()
    expect(await check(`${browserReportRequest}另将副本保存到 reports/report.html。`, thread)).toMatchObject({ errorCode: 'sandbox_read_only' })
    expect(await check(`${browserReportRequest}修改当前工作区的 README.md 文件。`, thread)).toMatchObject({ errorCode: 'sandbox_read_only' })
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
    const fileOnly = workspaceWritePreflight({ workspaceTrust, restriction: async () => ({ workspaceWriteException: true, permissionScope: { writePaths: [join(root, 'README.md')] } }) })
    expect(await fileOnly('修改当前工作区的 README.md 文件。', thread)).toBeNull()
    expect(await permitted('保存到 approved/report.html', { ...thread, sandboxMode: 'read-only' })).toMatchObject({ errorCode: 'sandbox_read_only' })
  })
})
