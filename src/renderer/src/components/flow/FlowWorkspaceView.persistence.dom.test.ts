// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FlowWorkspaceView, createStarterFlowInput } from './FlowWorkspaceView'
import i18n from '../../i18n'

type Connection = { source: string; sourceHandle: string; target: string; targetHandle: string }
const canvas = vi.hoisted(() => ({
  onNodesChange: undefined as ((changes: unknown[]) => void) | undefined,
  onEdgesChange: undefined as ((changes: unknown[]) => void) | undefined,
  onConnect: undefined as ((connection: Connection) => void) | undefined
}))
vi.mock('@xyflow/react', async original => ({
  ...await original<typeof import('@xyflow/react')>(),
  ReactFlow: (props: { nodes: Array<{ id: string; data: { label: string } }>; onNodesChange: (changes: unknown[]) => void; onEdgesChange: (changes: unknown[]) => void; onConnect: (connection: Connection) => void }) => {
    canvas.onNodesChange = props.onNodesChange
    canvas.onEdgesChange = props.onEdgesChange
    canvas.onConnect = props.onConnect
    return createElement('div', { 'aria-label': '流程画布' }, props.nodes.map(node => createElement('span', { key: node.id }, node.data.label)))
  }
}))

type Definition = ReturnType<typeof createStarterFlowInput> & { revision: number; createdAt: string; updatedAt: string; publishedVersionId?: string }
type Request = { path: string; method: string; body?: { expectedRevision?: number; definition?: Definition } }
let container: HTMLDivElement, root: Root, server: Definition, requests: Request[]
let rejectSave: boolean, saveBarrier: Promise<void> | undefined
const now = '2026-08-04T00:00:00.000Z'
const response = (body: unknown) => ({ ok: true, status: 200, body: JSON.stringify(body) })
async function settle(): Promise<void> { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }
async function mount(): Promise<void> {
  await act(async () => root.render(createElement(FlowWorkspaceView, { leftSidebarCollapsed: false, onToggleLeftSidebar: vi.fn(), filter: 'all' })))
  await settle()
}
function button(label: string): HTMLButtonElement {
  const value = [...container.querySelectorAll('button')].find(item => item.textContent?.trim() === label)
  expect(value, label).toBeTruthy()
  return value!
}
async function click(label: string): Promise<void> { await act(async () => button(label).click()); await settle() }
function writes(): Request[] { return requests.filter(item => item.method === 'PUT') }
function publishes(): Request[] { return requests.filter(item => item.path === '/v1/flows/publish') }

beforeEach(async () => {
  await i18n.changeLanguage('zh')
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  server = { ...createStarterFlowInput('flow-persistence'), revision: 1, createdAt: now, updatedAt: now }
  requests = []; rejectSave = false; saveBarrier = undefined
  canvas.onNodesChange = undefined; canvas.onEdgesChange = undefined; canvas.onConnect = undefined
  Object.defineProperty(window, 'workwise', { configurable: true, value: {
    runtimeRequest: vi.fn(async (path: string, method: string, body?: string) => {
      const input = body === undefined ? undefined : JSON.parse(body)
      requests.push({ path, method, body: input })
      if (method === 'GET' && path === '/v1/flows') return response({ flows: [server], registry: [
        { type: 'manual_trigger', category: 'trigger', label: 'Manual', available: true, inputs: [], outputs: [{ id: 'output', label: 'Output', type: 'json', required: false, multiple: false }] },
        { type: 'agent', category: 'intelligence', label: 'Agent', available: true, inputs: [{ id: 'input', label: 'Input', type: 'json', required: true, multiple: false }], outputs: [] }
      ] })
      if (method === 'GET' && path.endsWith('/history')) return response({ runs: [] })
      if (method === 'GET' && path === `/v1/flows/${server.id}`) return response({ flow: server })
      if (method === 'PUT' && path === `/v1/flows/${server.id}`) {
        await saveBarrier
        if (rejectSave || input.expectedRevision !== server.revision) return { ok: false, status: 409, body: JSON.stringify({ message: `Expected revision ${input.expectedRevision}, current revision is ${server.revision}` }) }
        server = { ...input.definition, revision: server.revision + 1, createdAt: now, updatedAt: now }
        return response({ flow: server })
      }
      if (method === 'POST' && path === '/v1/flows/publish') {
        server = { ...server, publishedVersionId: `flowver-${server.revision}` }
        return response({ published: true, validation: { valid: true, issues: [] } })
      }
      throw new Error(`Unexpected Runtime request: ${method} ${path}`)
    })
  } })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove(); Reflect.deleteProperty(window, 'workwise'); vi.restoreAllMocks()
})

describe('Flow save and publish revision ownership', () => {
  it('does not publish or retry when the optimistic-lock save fails', async () => {
    await mount(); rejectSave = true
    await click('发布')
    expect(writes()).toHaveLength(1)
    expect(writes()[0].body?.expectedRevision).toBe(1)
    expect(publishes()).toHaveLength(0)
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('此流程已在另一处更新')
    const technicalDetails = container.querySelector('details')
    expect(technicalDetails?.open).toBe(false)
    expect(technicalDetails?.textContent).toContain('Expected revision 1')
  })

  it('keeps the server revision when delayed geometry and selection callbacks arrive after save', async () => {
    await mount()
    const staleNodes = canvas.onNodesChange!, staleEdges = canvas.onEdgesChange!, staleConnect = canvas.onConnect!, nodeId = server.nodes[0].id, edge = server.edges[0]
    await click('保存')
    expect(server.revision).toBe(2)
    await act(async () => {
      staleNodes([{ id: nodeId, type: 'dimensions', dimensions: { width: 180, height: 88 } }, { id: nodeId, type: 'select', selected: true }])
      staleEdges([{ id: edge.id, type: 'select', selected: true }])
      staleConnect({ source: edge.sourceNodeId, sourceHandle: edge.sourcePortId, target: edge.targetNodeId, targetHandle: edge.targetPortId })
      staleNodes([{ id: nodeId, type: 'position', position: { x: 370, y: 120 } }])
    })
    await click('保存')
    expect(writes().map(item => item.body?.expectedRevision)).toEqual([1, 2])
    expect(server.nodes[0].position).toEqual({ x: 370, y: 120 })
    expect(server.edges).toHaveLength(1)
    expect(container.textContent).not.toContain('Expected revision')
  })

  it('reads the canonical published pointer before a later save', async () => {
    await mount(); await click('保存'); await click('发布')
    expect(writes().map(item => item.body?.expectedRevision)).toEqual([1, 2])
    expect(publishes()).toHaveLength(1)
    const published = server.publishedVersionId
    expect(published).toBe('flowver-3')
    expect(requests.at(-1)).toMatchObject({ path: `/v1/flows/${server.id}`, method: 'GET' })
    await click('保存')
    expect(writes().at(-1)?.body?.definition?.publishedVersionId).toBe(published)
    expect(writes().at(-1)?.body?.expectedRevision).toBe(3)
  })

  it('accepts only one write when Save and Publish are clicked while the first save is pending', async () => {
    await mount()
    let release = () => {}
    saveBarrier = new Promise<void>(resolve => { release = resolve })
    await act(async () => { button('保存').click(); button('保存').click(); button('发布').click() })
    expect(writes()).toHaveLength(1)
    expect(publishes()).toHaveLength(0)
    expect(button('保存').disabled).toBe(true)
    expect(button('发布').disabled).toBe(true)
    await act(async () => release()); await settle()
    expect(writes()).toHaveLength(1)
    expect(server.revision).toBe(2)
  })

  it('refreshes the canonical published pointer after enabling a task schedule', async () => {
    server = { ...server, variables: { taskSchedule: {}, enabled: false } }
    await mount(); await click('启用计划')
    expect(writes()).toHaveLength(1); expect(publishes()).toHaveLength(1)
    expect(server.variables.enabled).toBe(true)
    const published = server.publishedVersionId
    await click('保存')
    expect(writes().at(-1)?.body?.definition?.publishedVersionId).toBe(published)
    expect(writes().at(-1)?.body?.expectedRevision).toBe(2)
  })
})
