import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CapabilityRegistry } from '../src/adapters/tool/capability-registry.js'
import { LocalToolHost } from '../src/adapters/tool/local-tool-host.js'
import { ExecutionGrantSchema } from '../src/contracts/permissions.js'
import {
  buildPptMasterToolProviders,
  type PptMasterExportRunner
} from '../src/adapters/tool/ppt-master-tool-provider.js'

describe('PPT Master export tool provider', () => {
  let root = ''
  let workspace = ''
  let skillRoot = ''

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'ppt-master-tool-')))
    workspace = join(root, 'workspace')
    skillRoot = join(root, 'bundled-ppt-master')
    await mkdir(join(workspace, 'deck', 'svg_output'), { recursive: true })
    await mkdir(join(skillRoot, 'scripts'), { recursive: true })
    await writeFile(join(skillRoot, 'scripts', 'svg_to_pptx.py'), '# bundled exporter\n', 'utf8')
    await writeFile(join(workspace, 'deck', 'svg_output', '01.svg'), [
      '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">',
      '<rect width="1280" height="720" fill="#0a1628"/>',
      '</svg>'
    ].join(''), 'utf8')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('only advertises for ppt-master and returns a real PPTX artifact', async () => {
    const runner = vi.fn<PptMasterExportRunner>(async ({ outputPath }) => {
      await writeFile(outputPath, 'pptx-bytes', 'utf8')
    })
    const built = buildPptMasterToolProviders({ skillRoot, runner })
    const host = new LocalToolHost({
      registry: new CapabilityRegistry(built.providers)
    })
    const baseContext = {
      threadId: 'thread_1',
      turnId: 'turn_1',
      workspace,
      approvalPolicy: 'auto' as const,
      sandboxMode: 'workspace-write' as const,
      abortSignal: new AbortController().signal,
      awaitApproval: async () => 'allow' as const
    }

    expect(await host.listTools(baseContext)).toEqual([])
    const context = { ...baseContext, activeSkillIds: ['ppt-master'] }
    expect((await host.listTools(context)).map((tool) => tool.name)).toEqual(['ppt_master_export'])

    const result = await host.execute({
      callId: 'call_1',
      toolName: 'ppt_master_export',
      arguments: {
        project_path: 'deck',
        output_path: 'deliverables/agent-guide.pptx',
        source: 'output',
        format: 'ppt169'
      }
    }, context)

    expect(result.item).toMatchObject({
      kind: 'tool_result',
      isError: false,
      output: {
        ok: true,
        format: 'pptx',
        generatedFiles: [{
          name: 'agent-guide.pptx',
          relativePath: 'deliverables/agent-guide.pptx'
        }]
      }
    })
    expect(runner).toHaveBeenCalledWith(expect.objectContaining({
      projectPath: join(workspace, 'deck'),
      outputPath: join(workspace, 'deliverables', 'agent-guide.pptx'),
      source: 'output',
      format: 'ppt169'
    }))
  })

  it('rejects non-PPTX outputs and external SVG resources', async () => {
    const runner = vi.fn<PptMasterExportRunner>(async () => undefined)
    const built = buildPptMasterToolProviders({ skillRoot, runner })
    const host = new LocalToolHost({ registry: new CapabilityRegistry(built.providers) })
    const context = {
      threadId: 'thread_1',
      turnId: 'turn_1',
      workspace,
      activeSkillIds: ['ppt-master'],
      approvalPolicy: 'auto' as const,
      sandboxMode: 'workspace-write' as const,
      abortSignal: new AbortController().signal,
      awaitApproval: async () => 'allow' as const
    }

    const htmlResult = await host.execute({
      callId: 'call_html',
      toolName: 'ppt_master_export',
      arguments: { project_path: 'deck', output_path: 'slides.html' }
    }, context)
    expect(htmlResult.item).toMatchObject({ kind: 'tool_result', isError: true })
    expect(JSON.stringify(htmlResult.item)).toContain('output_path must end in .pptx')

    await writeFile(
      join(workspace, 'deck', 'svg_output', '01.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.com/image.png"/></svg>',
      'utf8'
    )
    const unsafeResult = await host.execute({
      callId: 'call_unsafe',
      toolName: 'ppt_master_export',
      arguments: { project_path: 'deck', output_path: 'slides.pptx' }
    }, context)
    expect(unsafeResult.item).toMatchObject({ kind: 'tool_result', isError: true })
    expect(JSON.stringify(unsafeResult.item)).toContain('external resource reference')
    expect(runner).not.toHaveBeenCalled()
  })

  it('enforces the task write grant on the PPTX output path', async () => {
    const runner = vi.fn<PptMasterExportRunner>(async ({ outputPath }) => {
      await writeFile(outputPath, 'pptx-bytes', 'utf8')
    })
    const built = buildPptMasterToolProviders({ skillRoot, runner })
    const host = new LocalToolHost({ registry: new CapabilityRegistry(built.providers) })
    const context = {
      threadId: 'thread_1', turnId: 'turn_1', workspace, activeSkillIds: ['ppt-master'],
      approvalPolicy: 'auto' as const, sandboxMode: 'workspace-write' as const,
      abortSignal: new AbortController().signal, awaitApproval: async () => 'allow' as const,
      executionGrant: ExecutionGrantSchema.parse({
        id: 'grant_1', taskId: 'task_1', threadId: 'thread_1', turnId: 'turn_1', workspaceRoot: workspace,
        workspaceTrust: 'workspace-write', agentTrust: 'workspace-write', approvalPolicy: 'auto', sandboxMode: 'workspace-write',
        pathAllowlist: [join(workspace, 'deck')], readPathAllowlist: [workspace], writePathAllowlist: [join(workspace, 'deck')],
        networkAllowlist: [], connectorScopes: [], externalTargets: [], workspaceRevision: 1, agentRevision: 0,
        revision: 1, idempotencyKey: 'grant_1', issuedAt: new Date().toISOString()
      })
    }

    const denied = await host.execute({ callId: 'outside', toolName: 'ppt_master_export',
      arguments: { project_path: 'deck', output_path: 'outside.pptx' } }, context)
    expect(denied.item).toMatchObject({ kind: 'tool_result', isError: true, output: { code: 'workspace_path_blocked' } })
    expect(runner).not.toHaveBeenCalled()

    const accepted = await host.execute({ callId: 'inside', toolName: 'ppt_master_export',
      arguments: { project_path: 'deck', output_path: 'deck/result.pptx' } }, context)
    expect(accepted.item).toMatchObject({ kind: 'tool_result', isError: false, output: { ok: true,
      generatedFiles: [{ relativePath: 'deck/result.pptx', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }] } })
    expect(runner).toHaveBeenCalledTimes(1)
  })

  it('uses the portable exporter when Python is unavailable', async () => {
    const built = buildPptMasterToolProviders({
      skillRoot,
      pythonCommand: join(root, 'missing-python')
    })
    const host = new LocalToolHost({ registry: new CapabilityRegistry(built.providers) })
    const context = {
      threadId: 'thread_1',
      turnId: 'turn_1',
      workspace,
      activeSkillIds: ['ppt-master'],
      approvalPolicy: 'auto' as const,
      sandboxMode: 'workspace-write' as const,
      abortSignal: new AbortController().signal,
      awaitApproval: async () => 'allow' as const
    }

    const result = await host.execute({
      callId: 'call_portable',
      toolName: 'ppt_master_export',
      arguments: { project_path: 'deck', output_path: 'portable.pptx' }
    }, context)

    expect(result.item).toMatchObject({ kind: 'tool_result', isError: false })
    const bytes = await readFile(join(workspace, 'portable.pptx'))
    expect(bytes.subarray(0, 2).toString('ascii')).toBe('PK')
  })
})
