import { describe, expect, it } from 'vitest'
import {
  clawMirrorPayloadSchema,
  clawImInstallPollPayloadSchema,
  designDocumentSavePayloadSchema,
  designExportPayloadSchema,
  isSafeOpenExternalUrl,
  notificationPayloadSchema,
  runtimeRequestPayloadSchema,
  scheduleTaskFromTextPayloadSchema,
  settingsPatchSchema,
  shellOpenExternalUrlSchema,
  skillListPayloadSchema,
  sseStartPayloadSchema,
  workspaceDirectoryCreatePayloadSchema,
  workspaceDirectoryTargetPayloadSchema,
  workspaceEntryDeletePayloadSchema,
  workspaceEntryRenamePayloadSchema,
  workspacePreviewPayloadSchema,
  writeExportPayloadSchema,
  writeRichClipboardPayloadSchema,
  writeInlineCompletionPayloadSchema
} from './app-ipc-schemas'
import {
  DESIGN_DOCUMENT_LIMITS,
  createDesignDocument
} from '../../shared/design-document'

describe('app-ipc-schemas', () => {
  it('restricts sampling requests to frozen declarations, stage rules and bounded pages', () => {
    const base = '/v1/engineering/projects/project_1'
    const population = { idempotencyKey: 'population-create-1', expectedProjectRevision: 1,
      productType: 'leveling', unitProductType: 'route', definitionStatement: '每条完整水准路线为一个单位成果', orderedUnitProductIds: ['A', 'B'] }
    const run = { populationId: 'population_1', idempotencyKey: 'run-create-1', stage: 'acceptance', inspectionMode: 'table-1-simple-random' }
    const accepted = [
      { path: `${base}/sampling-populations`, method: 'POST', body: JSON.stringify(population) },
      { path: `${base}/sampling-populations?limit=100&offset=10000` },
      { path: `${base}/sampling-populations/population_1` },
      { path: `${base}/sampling-populations/population_1/units?limit=100&offset=0` },
      { path: `${base}/sampling-runs`, method: 'POST', body: JSON.stringify(run) },
      { path: `${base}/sampling-runs`, method: 'POST', body: JSON.stringify({ ...run, stage: 'process', inspectionMode: 'census' }) },
      { path: `${base}/sampling-runs?limit=1&offset=0` },
      { path: `${base}/sampling-runs/run_1` },
      { path: `${base}/sampling-runs/run_1/samples?limit=100` },
      { path: `${base}/sampling-runs/run_1/verify`, method: 'POST', body: '{}' }
    ]
    for (const request of accepted) expect(runtimeRequestPayloadSchema.safeParse(request).success, request.path).toBe(true)
    const rejected = [
      ...['seed', 'actor', 'planHash', 'decision'].map(field => ({ path: `${base}/sampling-runs`, method: 'POST', body: JSON.stringify({ ...run, [field]: 'caller-controlled' }) })),
      ...['process', 'final-office'].map(stage => ({ path: `${base}/sampling-runs`, method: 'POST', body: JSON.stringify({ ...run, stage }) })),
      { path: `${base}/sampling-runs`, method: 'POST', body: JSON.stringify({ ...run, round: 2 }) },
      { path: `${base}/sampling-populations`, method: 'POST', body: JSON.stringify({ ...population, orderedUnitProductIds: ['A', 'A'] }) },
      { path: `${base}/sampling-populations`, method: 'POST', body: JSON.stringify({ ...population, definitionStatement: '\ud800' }) },
      { path: `${base}/sampling-populations`, method: 'POST', body: ' '.repeat(1024 * 1024) + JSON.stringify(population) },
      { path: `${base}/sampling-runs/run_1`, body: '{}' },
      { path: `${base}/sampling-runs/run_1?limit=1` },
      { path: `${base}/sampling-runs/run_1/verify`, method: 'POST', body: '{"decision":"passed"}' },
      { path: `${base}/sampling-runs/run_1/verify?offset=0`, method: 'POST', body: '{}' },
      { path: `${base}/sampling-runs?offset=0`, method: 'POST', body: JSON.stringify(run) },
      { path: `${base}/sampling-runs`, method: 'DELETE' },
      { path: `${base}/sampling-runs/run_1/units` },
      ...['limit=0', 'limit=101', 'limit=01', 'offset=-1', 'offset=10001', 'limit=1&limit=2', 'seed=abc'].map(query => ({ path: `${base}/sampling-runs?${query}` }))
    ]
    for (const request of rejected) expect(runtimeRequestPayloadSchema.safeParse(request).success, request.path).toBe(false)
  })

  it('accepts only bounded known PDF retry reasons', () => {
    expect(workspacePreviewPayloadSchema.parse({
      workspaceRoot: '/tmp/workspace',
      relativePath: 'scan.pdf',
      parsingMode: 'accurate',
      retryReasons: ['scanned_document', 'weak_text_layer'],
      idempotencyKey: 'preview-scan'
    }).retryReasons).toEqual(['scanned_document', 'weak_text_layer'])

    expect(() => workspacePreviewPayloadSchema.parse({
      workspaceRoot: '/tmp/workspace',
      relativePath: 'scan.pdf',
      retryReasons: ['renderer_supplied_reason'],
      idempotencyKey: 'preview-unknown'
    })).toThrow()
    expect(() => workspacePreviewPayloadSchema.parse({
      workspaceRoot: '/tmp/workspace',
      relativePath: 'scan.pdf',
      retryReasons: Array.from({ length: 33 }, () => 'scanned_document'),
      idempotencyKey: 'preview-too-many'
    })).toThrow()
  })

  it('accepts the renderer terminal notification active-thread flag', () => {
    expect(notificationPayloadSchema.parse({
      threadId: 'thread-1',
      reason: 'completed',
      activeThread: true,
      title: 'Done',
      body: 'The turn completed.'
    })).toEqual({
      threadId: 'thread-1',
      reason: 'completed',
      activeThread: true,
      title: 'Done',
      body: 'The turn completed.'
    })
  })

  it('accepts bounded local IM mirror turn metadata and rejects unknown fields', () => {
    expect(clawMirrorPayloadSchema.parse({
      threadId: ' thr_1 ',
      text: ' completed ',
      direction: 'assistant',
      turnId: ' turn_1 ',
      requestText: ' 请把 TXT 作为附件发给我 '
    })).toEqual({
      threadId: 'thr_1',
      text: 'completed',
      direction: 'assistant',
      turnId: 'turn_1',
      requestText: '请把 TXT 作为附件发给我'
    })
    expect(() => clawMirrorPayloadSchema.parse({
      threadId: 'thr_1',
      text: 'completed',
      direction: 'assistant',
      filePath: '/tmp/private.txt'
    })).toThrow()
  })

  it('rejects oversized Design documents at both save and export IPC boundaries', () => {
    const document = createDesignDocument()
    document.pages = Array.from(
      { length: DESIGN_DOCUMENT_LIMITS.pages + 1 },
      (_, index) => ({
        id: `page_${index}`,
        name: `Page ${index}`,
        width: 1280,
        height: 720,
        elements: []
      })
    )

    expect(() => designDocumentSavePayloadSchema.parse({
      workspaceRoot: '/tmp/workspace',
      document,
      activePageId: document.pages[0].id,
      expectedRevision: null
    })).toThrow(/256 pages/)
    expect(() => designExportPayloadSchema.parse({
      workspaceRoot: '/tmp/workspace',
      document
    })).toThrow(/256 pages/)
  })

  it('normalizes runtime request paths', () => {
    const payload = runtimeRequestPayloadSchema.parse({
      path: 'v1/threads?limit=1',
      method: 'GET'
    })

    expect(payload.path).toBe('/v1/threads?limit=1')
  })

  it('accepts the WorkWise Runtime runtime info endpoint', () => {
    const payload = runtimeRequestPayloadSchema.parse({
      path: '/v1/runtime/info',
      method: 'GET'
    })

    expect(payload.path).toBe('/v1/runtime/info')
  })

  it('accepts the WorkWise Runtime runtime tool diagnostics endpoint', () => {
    const payload = runtimeRequestPayloadSchema.parse({
      path: '/v1/runtime/tools',
      method: 'GET'
    })

    expect(payload.path).toBe('/v1/runtime/tools')
  })

  it('accepts the WorkWise Runtime skills endpoint', () => {
    const payload = runtimeRequestPayloadSchema.parse({
      path: '/v1/skills',
      method: 'GET'
    })

    expect(payload.path).toBe('/v1/skills')
  })

  it('accepts WorkWise Runtime attachment and memory endpoints', () => {
    expect(runtimeRequestPayloadSchema.parse({
      path: '/v1/attachments',
      method: 'POST',
      body: '{}'
    }).path).toBe('/v1/attachments')
    expect(runtimeRequestPayloadSchema.parse({
      path: '/v1/attachments/att_1/content?thread_id=thr_1',
      method: 'GET'
    }).path).toBe('/v1/attachments/att_1/content?thread_id=thr_1')
    expect(runtimeRequestPayloadSchema.parse({
      path: '/v1/memory',
      method: 'POST',
      body: '{}'
    }).path).toBe('/v1/memory')
    expect(runtimeRequestPayloadSchema.parse({
      path: '/v1/memory/mem_1',
      method: 'PATCH',
      body: '{}'
    }).path).toBe('/v1/memory/mem_1')
  })

  it('accepts skill list payloads with an optional workspace root', () => {
    expect(skillListPayloadSchema.parse({
      workspaceRoot: ' /tmp/workspace '
    })).toEqual({ workspaceRoot: '/tmp/workspace' })
    expect(skillListPayloadSchema.parse({})).toEqual({})
  })

  it('accepts WorkWise Runtime thread goal endpoints', () => {
    expect(runtimeRequestPayloadSchema.parse({
      path: '/v1/threads/thr_1/goal',
      method: 'GET'
    }).path).toBe('/v1/threads/thr_1/goal')
    expect(runtimeRequestPayloadSchema.parse({
      path: '/v1/threads/thr_1/goal',
      method: 'POST',
      body: '{}'
    }).path).toBe('/v1/threads/thr_1/goal')
    expect(runtimeRequestPayloadSchema.parse({
      path: '/v1/threads/thr_1/goal',
      method: 'DELETE'
    }).path).toBe('/v1/threads/thr_1/goal')
  })

  it('accepts the Engineering delivery and AI endpoints', () => {
    const accepted: Array<{ path: string; method: string }> = [
      { path: '/v1/engineering/projects', method: 'GET' },
      { path: '/v1/engineering/projects', method: 'POST' },
      { path: '/v1/engineering/projects/project_1', method: 'GET' },
      { path: '/v1/engineering/projects/project_1', method: 'PATCH' },
      { path: '/v1/engineering/projects/project_1/overview', method: 'GET' },
      { path: '/v1/engineering/datasets/import', method: 'POST' },
      { path: '/v1/engineering/datasets/dataset_1/validate', method: 'POST' },
      { path: '/v1/engineering/datasets/dataset_1/findings/finding_1/accept', method: 'POST' },
      { path: '/v1/engineering/analyses', method: 'POST' },
      { path: '/v1/engineering/charts', method: 'POST' },
      { path: '/v1/engineering/reports/preview', method: 'POST' },
      { path: '/v1/engineering/deliverables/finalize', method: 'POST' },
      { path: '/v1/engineering/projects/project_1/manifests/manifest_1/verify', method: 'POST' },
      { path: '/v1/engineering/projects/project_1/manifests/manifest_1/monitoring-replay', method: 'POST' },
      { path: '/v1/engineering/runs/run_1', method: 'GET' },
      { path: '/v1/engineering/runs/run_1/cancel', method: 'POST' },
      { path: '/v1/engineering/runs/run_1/resume', method: 'POST' },
      { path: '/v1/engineering/ai/context/project_1', method: 'GET' },
      { path: '/v1/engineering/ai/evidence/project_1', method: 'GET' },
      { path: '/v1/engineering/ai/watch-drafts', method: 'POST' },
      { path: '/v1/engineering/ai/plans', method: 'POST' },
      { path: '/v1/engineering/ai/plans?threadId=thread_1&projectId=project_1', method: 'GET' },
      { path: '/v1/engineering/ai/project-suggestions?threadId=thread_1&projectId=project_1', method: 'GET' },
      { path: '/v1/engineering/ai/project-suggestions/suggestion_1/decision', method: 'POST' },
      { path: '/v1/engineering/ai/plans/plan_1', method: 'GET' },
      { path: '/v1/engineering/ai/plans/plan_1/validate', method: 'POST' },
      { path: '/v1/engineering/ai/plans/plan_1/approve', method: 'POST' },
      { path: '/v1/engineering/ai/plans/plan_1/start', method: 'POST' },
      { path: '/v1/engineering/ai/plans/plan_1/cancel', method: 'POST' },
      { path: '/v1/engineering/ai/plans/plan_1/resume', method: 'POST' }
      ,{ path: '/v1/engineering/capabilities', method: 'GET' }
      ,{ path: '/v1/engineering/skills/catalog', method: 'GET' }
      ,{ path: '/v1/engineering/survey/source-groups/cosa/inspect', method: 'POST' }
      ,{ path: '/v1/engineering/survey/networks/import', method: 'POST' }
      ,{ path: '/v1/engineering/survey/networks', method: 'GET' }
      ,{ path: '/v1/engineering/survey/networks?projectId=project_1', method: 'GET' }
      ,{ path: '/v1/engineering/survey/networks/network_1/validate', method: 'POST' }
      ,{ path: '/v1/engineering/survey/networks/network_1/corrections', method: 'GET' }
      ,{ path: '/v1/engineering/survey/networks/network_1/corrections/replay', method: 'GET' }
      ,{ path: '/v1/engineering/survey/networks/network_1/corrections/replay?head=abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789', method: 'GET' }
      ,{ path: '/v1/engineering/adjustments', method: 'POST' }
      ,{ path: '/v1/engineering/adjustments?projectId=project_1', method: 'GET' }
      ,{ path: '/v1/engineering/adjustments/adjustment_1', method: 'GET' }
      ,{ path: '/v1/engineering/adjustments/adjustment_1/cancel', method: 'POST' }
      ,{ path: '/v1/engineering/adjustments/adjustment_1/resume', method: 'POST' }
      ,{ path: '/v1/engineering/adjustments/adjustment_1/preview', method: 'POST' }
      ,{ path: '/v1/engineering/deformations', method: 'POST' }
      ,{ path: '/v1/engineering/deformations?projectId=project_1', method: 'GET' }
      ,{ path: '/v1/engineering/deformations/deformation_1', method: 'GET' }
    ]
    for (const request of accepted) {
      expect(runtimeRequestPayloadSchema.parse(request).path).toBe(request.path)
    }
    expect(() => runtimeRequestPayloadSchema.parse({
      path: '/v1/engineering/projects/project_1',
      method: 'DELETE'
    })).toThrow(/runtime request path is not allowed/)
    expect(() => runtimeRequestPayloadSchema.parse({
      path: '/v1/engineering/adjustments?workspace=%2Ftmp',
      method: 'GET'
    })).toThrow(/runtime request path is not allowed/)
    expect(() => runtimeRequestPayloadSchema.parse({
      path: '/v1/engineering/adjustments?projectId=project_1&projectId=project_2',
      method: 'GET'
    })).toThrow(/runtime request path is not allowed/)
    expect(() => runtimeRequestPayloadSchema.parse({
      path: '/v1/engineering/deformations?projectId=',
      method: 'GET'
    })).toThrow(/runtime request path is not allowed/)
    expect(() => runtimeRequestPayloadSchema.parse({
      path: '/v1/engineering/ai/plans?threadId=thread_1&workspace=%2Ftmp',
      method: 'GET'
    })).toThrow(/runtime request path is not allowed/)
    expect(() => runtimeRequestPayloadSchema.parse({
      path: '/v1/engineering/ai/plans?threadId=thread_1&projectId=project_1&projectId=project_2',
      method: 'GET'
    })).toThrow(/runtime request path is not allowed/)
  })

  it('restricts monitoring replay to the manifest-scoped POST without query overrides', () => {
    const path = '/v1/engineering/projects/project_1/manifests/manifest_1/monitoring-replay'
    expect(runtimeRequestPayloadSchema.safeParse({ path, method: 'POST' }).success).toBe(true)
    for (const request of [
      { path, method: 'GET' }, { path, method: 'DELETE' },
      { path: `${path}?algorithmVersion=workwise-engineering-2`, method: 'POST' },
      { path: `${path}?projectId=other`, method: 'POST' },
      { path: '/v1/engineering/manifests/manifest_1/monitoring-replay', method: 'POST' }
    ]) expect(runtimeRequestPayloadSchema.safeParse(request).success).toBe(false)
  })

  it('allows only project-scoped read-only statistical diagnostics and the explicit download flag', () => {
    const path = '/v1/engineering/projects/project_1/adjustments/adjustment_1/statistical-diagnostics'
    expect(runtimeRequestPayloadSchema.parse({ path, method: 'GET' }).path).toBe(path)
    expect(runtimeRequestPayloadSchema.parse({ path: `${path}?download=1`, method: 'GET' }).path).toBe(`${path}?download=1`)
    for (const request of [
      { path, method: 'POST' }, { path, method: 'DELETE' },
      { path: `${path}?download=2`, method: 'GET' },
      { path: `${path}?download=1&download=1`, method: 'GET' },
      { path: `${path}?projectId=other`, method: 'GET' },
      { path: '/v1/engineering/adjustments/adjustment_1/statistical-diagnostics', method: 'GET' }
    ]) expect(runtimeRequestPayloadSchema.safeParse(request).success).toBe(false)
  })

  it('allows only scoped, explicit free leveling trial requests and bounded history reads', () => {
    const path = '/v1/engineering/projects/project_1/networks/network_1/free-leveling-trials'
    const body = { expectedRevision: 2, idempotencyKey: 'explicit-trial', constraint: 'sum-height-corrections-zero', acknowledgeDatumRelease: true, weightPolicy: 'source-or-unit-fallback' }
    for (const request of [
      { path, method: 'GET' }, { path: `${path}?limit=50&offset=20`, method: 'GET' },
      { path, method: 'POST', body: JSON.stringify(body) },
      { path: `${path}/trial_1`, method: 'GET' }, { path: `${path}/trial_1?download=1`, method: 'GET' }
    ]) expect(runtimeRequestPayloadSchema.safeParse(request).success).toBe(true)
    for (const request of [
      { path, method: 'DELETE' }, { path, method: 'POST' },
      { path, method: 'GET', body: '{}' }, { path: `${path}/trial_1`, method: 'GET', body: '{}' },
      { path: `${path}/trial_1`, method: 'POST', body: JSON.stringify(body) },
      { path: `${path}?offset=0`, method: 'POST', body: JSON.stringify(body) },
      ...['limit=0', 'limit=51', 'limit=1.5', 'offset=-1', 'offset=NaN', 'offset=100001', 'offset=9007199254740992', 'limit=1&limit=2', 'projectId=other', 'download=1'].map(query => ({ path: `${path}?${query}`, method: 'GET' })),
      { path: `${path}/trial_1?download=2`, method: 'GET' },
      { path: '/v1/engineering/survey/networks/network_1/free-leveling-trials', method: 'GET' },
      ...[{ acknowledgeDatumRelease: false }, { constraint: 'fixed' }, { weightPolicy: 'auto' }, { expectedRevision: 0 }, { projectId: 'other' }].map(change => ({ path, method: 'POST', body: JSON.stringify({ ...body, ...change }) }))
    ]) expect(runtimeRequestPayloadSchema.safeParse(request).success, JSON.stringify(request)).toBe(false)
    expect(runtimeRequestPayloadSchema.safeParse({ path: `${path}?limit=50&offset=100000`, method: 'GET' }).success).toBe(true)
    expect(runtimeRequestPayloadSchema.safeParse({ path: '/v1/threads?limit=100&offset=100001', method: 'GET' }).success).toBe(true)
  })

  it('accepts the revision-safe thread Agent selection endpoint', () => {
    expect(runtimeRequestPayloadSchema.parse({
      path: '/v1/threads/thr_1/agent',
      method: 'POST',
      body: '{}'
    }).path).toBe('/v1/threads/thr_1/agent')
  })

  it('allows scoped quality evidence requests but rejects forged outcomes, mutable plans and unbounded reads', () => {
    const base = '/v1/engineering/projects/project_1'
    const plan = { manifestId: 'manifest_1', expectedProjectRevision: 2, idempotencyKey: 'freeze-plan-1', requiredEvidence: [{ id: 'report', title: 'Retain report bytes', memberId: 'output-1' }] }
    const requests = [
      { path: `${base}/quality-plans`, method: 'POST', body: JSON.stringify(plan) },
      { path: `${base}/quality-plans?limit=50&offset=10000`, method: 'GET' },
      { path: `${base}/quality-plans/plan_1`, method: 'GET' },
      { path: `${base}/quality-evidence`, method: 'POST', body: JSON.stringify({ artifactId: 'artifact_1', memberId: 'member_1', idempotencyKey: 'retain-evidence-1' }) },
      { path: `${base}/quality-records`, method: 'POST', body: JSON.stringify({ planId: 'plan_1', idempotencyKey: 'create-record-1' }) },
      { path: `${base}/quality-records?limit=1&offset=0`, method: 'GET' },
      { path: `${base}/quality-records/record_1`, method: 'GET' },
      { path: `${base}/quality-records/record_1/checks`, method: 'POST', body: JSON.stringify({ expectedHeadHash: '0'.repeat(64), idempotencyKey: 'check-record-1', checkId: 'artifact-bytes' }) },
      { path: `${base}/quality-records/record_1/verify`, method: 'POST', body: '{}' }
    ]
    for (const request of requests) expect(runtimeRequestPayloadSchema.safeParse(request).success, request.path).toBe(true)
    for (const request of [
      { path: `${base}/quality-plans`, method: 'PATCH', body: JSON.stringify(plan) },
      { path: `${base}/quality-plans`, method: 'POST', body: JSON.stringify({ ...plan, actor: { kind: 'human', id: 'signed' } }) },
      { path: `${base}/quality-records/record_1/verify`, method: 'POST', body: '{"requiredCheckIds":[]}' },
      { path: `${base}/quality-records/record_1/checks`, method: 'POST', body: JSON.stringify({ expectedHeadHash: '0'.repeat(64), idempotencyKey: 'check-record-1', checkId: 'artifact-bytes', outcome: 'passed' }) },
      { path: `${base}/quality-records/record_1`, method: 'GET', body: '{}' },
      { path: `${base}/quality-records/record_1?limit=1`, method: 'GET' },
      { path: `${base}/quality-plans?offset=0`, method: 'POST', body: JSON.stringify(plan) },
      ...['limit=0', 'limit=51', 'limit=1.5', 'offset=-1', 'offset=10001', 'offset=NaN', 'limit=1&limit=2', 'projectId=other'].map(query => ({ path: `${base}/quality-plans?${query}`, method: 'GET' })),
      { path: '/v1/engineering/quality-plans', method: 'POST', body: JSON.stringify(plan) }
    ]) expect(runtimeRequestPayloadSchema.safeParse(request).success, request.path).toBe(false)
    expect(runtimeRequestPayloadSchema.safeParse({ path: '/v1/threads?limit=100&offset=100001', method: 'GET' }).success).toBe(true)
  })

  it('accepts the WorkWise Runtime thread review endpoint', () => {
    expect(runtimeRequestPayloadSchema.parse({
      path: '/v1/threads/thr_1/review',
      method: 'POST',
      body: '{"target":{"kind":"uncommittedChanges"}}'
    }).path).toBe('/v1/threads/thr_1/review')
  })

  it('allows only POST for the persisted UI action endpoint', () => {
    expect(runtimeRequestPayloadSchema.parse({
      path: '/v1/threads/thr_1/ui-actions',
      method: 'POST',
      body: '{"messageId":"item_1","blockId":"card","actionId":"apply","specFingerprint":"0123456789abcdef","idempotencyKey":"ui_1"}'
    }).path).toBe('/v1/threads/thr_1/ui-actions')
    expect(() => runtimeRequestPayloadSchema.parse({
      path: '/v1/threads/thr_1/ui-actions',
      method: 'GET'
    })).toThrow(/runtime request path is not allowed/)
  })

  it('allows only POST for workspace reference search endpoints', () => {
    expect(runtimeRequestPayloadSchema.parse({
      path: '/v1/threads/thr_1/workspace/references/search',
      method: 'POST',
      body: '{"query":"src","limit":20}'
    }).path).toBe('/v1/threads/thr_1/workspace/references/search')
    expect(() => runtimeRequestPayloadSchema.parse({
      path: '/v1/threads/thr_1/workspace/references/search',
      method: 'GET'
    })).toThrow(/runtime request path is not allowed/)
    expect(runtimeRequestPayloadSchema.parse({
      path: '/v1/workspace/references/search',
      method: 'POST',
      body: '{"workspaceRoot":"/tmp/workspace","query":"src","limit":20}'
    }).path).toBe('/v1/workspace/references/search')
    expect(() => runtimeRequestPayloadSchema.parse({
      path: '/v1/workspace/references/search',
      method: 'GET'
    })).toThrow(/runtime request path is not allowed/)
  })

  it('rejects runtime request paths outside the modeled WorkWise Runtime API surface', () => {
    expect(() =>
      runtimeRequestPayloadSchema.parse({
        path: '/v1/runtime/secrets',
        method: 'GET'
      })
    ).toThrow(/runtime request path is not allowed/)
  })

  it('rejects runtime request methods that do not match the modeled endpoint', () => {
    expect(() =>
      runtimeRequestPayloadSchema.parse({
        path: '/v1/usage',
        method: 'POST'
      })
    ).toThrow(/runtime request path is not allowed/)
  })

  it('accepts a valid settings patch for kun and write settings', () => {
    const payload = settingsPatchSchema.parse({
      theme: 'dark',
      agents: {
        kun: {
          port: 9000,
          model: 'deepseek-chat',
          tokenEconomy: {
            enabled: true,
            compressToolResults: false,
            historyHygiene: {
              maxToolResultTokens: 4000
            }
          }
        }
      },
      write: {
        inlineCompletion: {
          model: 'deepseek-v4-pro',
          maxTokens: 128
        }
      }
    })

    expect(payload.agents?.kun?.port).toBe(9000)
    expect(payload.agents?.kun?.tokenEconomy?.enabled).toBe(true)
    expect(payload.agents?.kun?.tokenEconomy?.historyHygiene?.maxToolResultTokens).toBe(4000)
    expect(payload.write?.inlineCompletion?.model).toBe('deepseek-v4-pro')
  })

  it('validates nested terminal notification patches', () => {
    expect(settingsPatchSchema.parse({
      notifications: {
        turnTerminal: {
          enabled: true,
          kinds: ['completed', 'error', 'waiting_approval'],
          suppressActiveThread: true,
          include: ['project-*'],
          exclude: ['*secret*']
        }
      }
    }).notifications?.turnTerminal).toEqual({
      enabled: true,
      kinds: ['completed', 'error', 'waiting_approval'],
      suppressActiveThread: true,
      include: ['project-*'],
      exclude: ['*secret*']
    })

    expect(() => settingsPatchSchema.parse({
      notifications: { turnTerminal: { kinds: ['unsupported'] } }
    })).toThrow()
    expect(() => settingsPatchSchema.parse({
      notifications: { turnTerminal: { include: Array.from({ length: 101 }, (_, index) => `thread-${index}`) } }
    })).toThrow()
    expect(() => settingsPatchSchema.parse({
      notifications: { turnTerminal: { enabled: true, legacyMode: true } }
    })).toThrow(/Unrecognized key/)
  })

  it('accepts schedule settings patches and task payloads', () => {
    const payload = settingsPatchSchema.parse({
      schedule: {
        enabled: true,
        keepAwake: true,
        defaultWorkspaceRoot: '/tmp/schedule',
        model: 'deepseek-v4-flash',
        mode: 'plan',
        promptPrefix: 'Use the project checklist.',
        skills: {
          defaultNames: ['review'],
          extraDirs: ['/tmp/skills']
        },
        internal: {
          port: 9788,
          secret: 'secret'
        },
        tasks: [{
          id: 'task-1',
          title: 'Daily review',
          enabled: true,
          prompt: 'Review the repo',
          workspaceRoot: '/tmp/schedule',
          model: 'auto',
          reasoningEffort: 'high',
          mode: 'agent',
          schedule: {
            kind: 'daily',
            everyMinutes: 60,
            timeOfDay: '09:30',
            atTime: ''
          },
          lastStatus: 'idle'
        }]
      }
    })

    expect(payload.schedule?.internal?.port).toBe(9788)
    expect(payload.schedule?.tasks?.[0]?.schedule?.kind).toBe('daily')
    expect(payload.schedule?.tasks?.[0]?.reasoningEffort).toBe('high')

    const fromText = scheduleTaskFromTextPayloadSchema.parse({
      text: 'Remind me tomorrow morning to ship the review',
      workspaceRoot: '/tmp/schedule',
      modelHint: 'deepseek-v4-pro',
      mode: 'agent'
    })

    expect(fromText.workspaceRoot).toBe('/tmp/schedule')
    expect(fromText.modelHint).toBe('deepseek-v4-pro')
  })

  it('strips legacy settings keys before validating settings patches', () => {
    const payload = settingsPatchSchema.parse({
      locale: 'zh',
      reasonix: { model: 'legacy-reasoner' },
      quickChat: { enabled: true },
      agents: {
        kun: {
          port: 9001
        },
        reasonix: {
          model: 'legacy-reasoner'
        },
        quickChat: {
          enabled: true
        }
      }
    })

    expect(payload.locale).toBe('zh')
    expect(payload.agents?.kun?.port).toBe(9001)
    expect('reasonix' in payload).toBe(false)
    expect('quickChat' in payload).toBe(false)
    expect('reasonix' in (payload.agents ?? {})).toBe(false)
    expect('quickChat' in (payload.agents ?? {})).toBe(false)
  })

  it('accepts persisted secure IM credential references in full settings snapshots', () => {
    const payload = settingsPatchSchema.parse({
      claw: {
        channels: [{
          id: 'channel-1',
          provider: 'weixin',
          label: 'weixin agent',
          enabled: true,
          model: 'auto',
          threadId: '',
          workspaceRoot: '',
          agentProfile: {
            name: 'weixin agent',
            description: '',
            identity: '',
            personality: '',
            userContext: '',
            replyRules: ''
          },
          platformCredential: {
            kind: 'weixin',
            accountId: 'wx-account',
            createdAt: '2026-06-10T00:00:00.000Z'
          },
          credentialRef: {
            id: 'credential-ref-1',
            storage: 'keychain',
            createdAt: '2026-06-10T00:00:00.000Z'
          },
          conversations: [],
          welcomeSentAt: '2026-06-10T00:00:00.000Z',
          createdAt: '2026-06-10T00:00:00.000Z',
          updatedAt: '2026-06-10T00:00:00.000Z'
        }]
      }
    })

    expect(payload.claw?.channels?.[0]?.welcomeSentAt).toBe('2026-06-10T00:00:00.000Z')
    expect(payload.claw?.channels?.[0]?.credentialRef).toEqual({
      id: 'credential-ref-1',
      storage: 'keychain',
      createdAt: '2026-06-10T00:00:00.000Z'
    })
  })

  it('rejects unsupported IM credential reference storage', () => {
    expect(() => settingsPatchSchema.parse({
      claw: {
        channels: [{
          id: 'channel-1',
          provider: 'weixin',
          credentialRef: {
            id: 'credential-ref-1',
            storage: 'plaintext',
            createdAt: '2026-06-10T00:00:00.000Z'
          }
        }]
      }
    })).toThrow()
  })

  it('accepts partial provider profiles in settings patches', () => {
    const payload = settingsPatchSchema.parse({
      provider: {
        apiKey: 'sk-updated',
        providers: [{
          id: 'deepseek',
          apiKey: 'sk-updated',
          endpointFormat: 'responses'
        }]
      }
    })

    expect(payload.provider?.apiKey).toBe('sk-updated')
    expect(payload.provider?.providers?.[0]).toEqual({
      id: 'deepseek',
      apiKey: 'sk-updated',
      endpointFormat: 'responses'
    })
  })

  it('accepts partial keyboard shortcut binding maps in settings patches', () => {
    const payload = settingsPatchSchema.parse({
      keyboardShortcuts: {
        bindings: {
          settings: ['Ctrl+,']
        }
      }
    })

    expect(payload.keyboardShortcuts?.bindings?.settings).toEqual(['Ctrl+,'])
  })

  it('rejects unknown settings patch fields', () => {
    expect(() =>
      settingsPatchSchema.parse({
        agents: {
          kun: {
            mysteryFlag: true
          }
        }
      })
    ).toThrow(/Unrecognized key/)
  })

  it('rejects unknown schedule patch fields', () => {
    expect(() =>
      settingsPatchSchema.parse({
        schedule: {
          tasks: [{
            id: 'task-1',
            prompt: 'Run',
            schedule: { kind: 'manual' },
            legacyClawOnlyField: true
          }]
        }
      })
    ).toThrow(/Unrecognized key/)
  })

  it('allows only safe external URL protocols', () => {
    expect(isSafeOpenExternalUrl('https://deepseek.com')).toBe(true)
    expect(isSafeOpenExternalUrl('http://127.0.0.1:5173')).toBe(true)
    expect(isSafeOpenExternalUrl('mailto:zhongxingyuemail@gmail.com')).toBe(true)
    expect(isSafeOpenExternalUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeOpenExternalUrl('file:///tmp/test')).toBe(false)
    expect(() => shellOpenExternalUrlSchema.parse('javascript:alert(1)')).toThrow(
      /Only http, https, and mailto URLs are allowed/
    )
  })

  it('rejects invalid SSE payloads', () => {
    expect(() =>
      sseStartPayloadSchema.parse({
        threadId: 'thread-1',
        sinceSeq: -1
      })
    ).toThrow()
  })

  it('accepts long Feishu install device codes', () => {
    const deviceCode = 'x'.repeat(2_048)
    const payload = clawImInstallPollPayloadSchema.parse({
      provider: 'feishu',
      deviceCode
    })

    expect(payload.deviceCode).toBe(deviceCode)
  })

  it('accepts workspace directory payloads without a child path', () => {
    const payload = workspaceDirectoryTargetPayloadSchema.parse({
      workspaceRoot: '/tmp/workspace'
    })

    expect(payload.workspaceRoot).toBe('/tmp/workspace')
    expect(payload.path).toBeUndefined()
  })

  it('accepts workspace directory create payloads', () => {
    const payload = workspaceDirectoryCreatePayloadSchema.parse({
      workspaceRoot: '/tmp/workspace',
      path: 'notes'
    })

    expect(payload.path).toBe('notes')
  })

  it('accepts workspace rename payloads', () => {
    const payload = workspaceEntryRenamePayloadSchema.parse({
      workspaceRoot: '/tmp/workspace',
      path: '/tmp/workspace/draft.md',
      newName: 'final.md'
    })

    expect(payload.newName).toBe('final.md')
  })

  it('accepts workspace delete payloads', () => {
    const payload = workspaceEntryDeletePayloadSchema.parse({
      workspaceRoot: '/tmp/workspace',
      path: '/tmp/workspace/draft.md'
    })

    expect(payload.path).toBe('/tmp/workspace/draft.md')
  })

  it('accepts structured inline completion payloads', () => {
    const payload = writeInlineCompletionPayloadSchema.parse({
      prefix: '## Heading\n\nSome intro',
      suffix: '',
      mode: 'edit',
      workspaceRoot: '/tmp/workspace',
      currentFilePath: '/tmp/workspace/notes.md',
      cursor: {
        line: 3,
        column: 10
      },
      context: {
        language: 'markdown',
        currentLinePrefix: 'Some intro',
        currentLineSuffix: '',
        previousLine: '',
        previousNonEmptyLine: '## Heading',
        nextLine: '',
        indentation: '',
        signals: {
          list: false,
          quote: false,
          heading: false,
          table: false,
          atLineEnd: true,
          endsWithSentencePunctuation: false,
          previousLineEndsWithSentencePunctuation: false,
          prefersNewLineCompletion: false,
          paragraphBreakOpportunity: false
        }
      },
      policy: {
        name: 'precision-inline-v2',
        instruction: 'Return only the inserted text.',
        acceptanceCriteria: ['Keep it short.'],
        rejectionCriteria: ['Do not ramble.']
      },
      preview: {
        local: 'Some intro',
        documentTail: '## Heading Some intro'
      },
      editCandidate: {
        kind: 'paragraph',
        from: 12,
        to: 22,
        startLine: 3,
        startColumn: 1,
        endLine: 3,
        endColumn: 10,
        original: 'Some intro',
        selectedText: 'Some'
      },
      recentEdits: [{
        source: 'user',
        ageMs: 1_200,
        filePath: '/tmp/workspace/notes.md',
        from: 12,
        to: 16,
        deletedText: 'Old',
        insertedText: 'Some',
        beforeContext: '',
        afterContext: ' intro'
      }],
      model: 'deepseek-v4-pro'
    })

    expect(payload.model).toBe('deepseek-v4-pro')
    expect(payload.mode).toBe('edit')
    expect(payload.workspaceRoot).toBe('/tmp/workspace')
    expect(payload.cursor.line).toBe(3)
    expect(payload.editCandidate?.kind).toBe('paragraph')
    expect(payload.recentEdits?.[0].insertedText).toBe('Some')
  })

  it('accepts write export payloads', () => {
    const payload = writeExportPayloadSchema.parse({
      path: '/tmp/workspace/draft.md',
      workspaceRoot: '/tmp/workspace',
      format: 'docx',
      content: '# Draft'
    })

    expect(payload.path).toBe('/tmp/workspace/draft.md')
    expect(payload.format).toBe('docx')
    expect(payload.content).toBe('# Draft')
  })

  it('accepts write rich clipboard payloads', () => {
    const payload = writeRichClipboardPayloadSchema.parse({
      path: '/tmp/workspace/draft.md',
      workspaceRoot: '/tmp/workspace',
      content: '# Draft'
    })

    expect(payload.path).toBe('/tmp/workspace/draft.md')
    expect(payload.content).toBe('# Draft')
  })
})
