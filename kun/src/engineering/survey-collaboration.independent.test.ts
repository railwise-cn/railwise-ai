import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SurveyCollaborationService } from './survey-collaboration.js'
import type { ProfessionalReportModel } from './survey-professional-report.js'

const rendered = vi.hoisted(() => ({ notes: [] as string[] }))
vi.mock('./survey-professional-report.js', async importOriginal => ({
  ...await importOriginal<typeof import('./survey-professional-report.js')>(),
  makeProfessionalDocx: async (model: ProfessionalReportModel) => {
    rendered.notes = [...model.notes]
    return Buffer.from('independent docx export')
  },
  makeProfessionalXlsx: async () => Buffer.from('independent xlsx export')
}))
vi.mock('./engineering-report-pdf.js', () => ({ makeProfessionalReportPdf: async () => Buffer.from('independent pdf export') }))

const clean: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of clean.splice(0)) await close(); rendered.notes = [] })
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'survey-collaboration-independent-'))
  const workspace = join(root, 'workspace'), outside = join(root, 'outside')
  await mkdir(workspace); await mkdir(outside)
  const model: ProfessionalReportModel = {
    title: '公开合成控制网审查稿', projectName: '独立复核用合成项目', taskType: '控制网',
    generatedAt: '2026-10-06T00:00:00Z', reviewStatus: 'unsigned', reportStatus: 'draft',
    sourceBinding: [], tables: [{ id: 'points', title: '点位成果', columns: [{ key: 'point', label: '点号' }], rows: [{ point: 'S1' }] }],
    notes: ['原成果说明'], signoff: [{ role: '复核', name: '', date: '', signature: '' }]
  }
  const bytes = Buffer.from(JSON.stringify({ model })), projection = 'professional-review.json'
  await writeFile(join(workspace, projection), bytes)
  const project = { id: 'project-independent', name: model.projectName, revision: 1, workspace }
  const manifest = { id: 'manifest-independent', projectId: project.id, outputs: [{ path: projection, sha256: sha(bytes) }] }
  const service = new SurveyCollaborationService(join(root, 'drafts.sqlite3'), {
    getProject: () => project, getManifestForProject: () => manifest, verifyDeliverable: () => ({ valid: true })
  } as any, { snapshot: () => ({ contextHash: 'sha256-independent-context' }) } as any)
  clean.push(async () => { service.close(); await rm(root, { recursive: true, force: true }) })
  const create = () => service.create(project.id, { manifestId: manifest.id, expectedProjectRevision: 1, idempotencyKey: 'independent-create-draft' })
  return { root, workspace, outside, project, service, create }
}

describe('independent Survey collaboration source and workspace review', () => {
  it('does not create any draft directory outside the selected workspace through a symlink', async () => {
    const f = await fixture()
    await mkdir(join(f.workspace, '.workwise'))
    await symlink(f.outside, join(f.workspace, '.workwise', 'survey-drafts'))
    await expect(f.create()).rejects.toThrow('integrity')
    expect(await readdir(f.outside)).toEqual([])
  })

  it('exports only the actual note bytes that were sealed for confirmation, even if a temporary edit is restored', async () => {
    const f = await fixture(), draft = await f.create()
    const saved = await readFile(join(f.workspace, draft.notesPath))
    const internal = f.service as any, original = internal.file.bind(f.service)
    let noteRead = 0
    internal.file = async (workspace: string, path: string) => {
      if (path === draft.notesPath && ++noteRead === 2) {
        await writeFile(join(workspace, path), '未经确认的临时复核结论')
        const temporary = await original(workspace, path)
        await writeFile(join(workspace, path), saved)
        return temporary
      }
      return original(workspace, path)
    }
    await expect(internal.exportDraft({ projectId: draft.projectId, draftId: draft.id, revision: draft.revision, contentHash: draft.contentHash }, 'independent-export', new AbortController().signal)).rejects.toThrow('stale')
    expect(rendered.notes).not.toContain('未经确认的临时复核结论')
  })
})
