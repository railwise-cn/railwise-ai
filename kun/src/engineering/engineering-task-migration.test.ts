import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { EngineeringService } from './engineering-service.js'

describe('engineering task migration', () => {
  it('infers legacy classifications without rewriting the database, unit or unknown fields', async () => {
    const root = await mkdtemp(join(tmpdir(), 'railwise-task-migration-'))
    const service = new EngineeringService({ rootDir: root })
    const db = new Database(join(root, 'engineering.sqlite3'))
    try {
      for (const [monitoringType, expected] of [['deformation', 'deformation'], ['control-network', 'control-network'], ['leveling', 'leveling-network'], ['custom-settlement', undefined]]) {
        const original = service.createProject({ name: 'legacy', monitoringType, unit: 'mm', workspace: root, expectedRevision: 0, idempotencyKey: `legacy-${monitoringType}` })
        const { taskType: _taskType, ...legacy } = original
        const json = JSON.stringify(legacy)
        db.prepare('UPDATE engineering_projects SET data_json = ? WHERE id = ?').run(json, original.id)
        expect(service.getProject(original.id)).toMatchObject({ monitoringType, unit: 'mm', revision: 1 })
        expect(service.getProject(original.id)?.taskType).toBe(expected)
        expect(service.listProjects().find(p => p.id === original.id)?.taskType).toBe(expected)
        expect(db.prepare('SELECT data_json FROM engineering_projects WHERE id = ?').get(original.id)).toEqual({ data_json: json })
      }
    } finally { db.close(); service.close() }
  })

  it('creates a neutral control task, validates types and preserves legacy settings when reclassified', async () => {
    const root = await mkdtemp(join(tmpdir(), 'railwise-task-create-'))
    const service = new EngineeringService({ rootDir: root })
    try {
      const request = { name: 'task', workspace: root, expectedRevision: 0, idempotencyKey: 'create-task' }
      const project = service.createProject(request)
      expect(project.taskType).toBe('control-network')
      expect(project.monitoringType).toBe('control-network')
      expect(service.createProject(request).id).toBe(project.id)
      const updated = service.updateProject(project.id, { taskType: 'leveling-network', taskContext: { verticalDatum: '1985', measurementGrade: 'II', standard: 'GB 50026', standardVersion: '2020', standardClause: 'test-reference' }, expectedRevision: 1, idempotencyKey: 'update-task' })
      expect(updated).toMatchObject({ taskType: 'leveling-network', monitoringType: 'control-network', unit: project.unit, revision: 2 })
      expect(service.getProject(project.id)?.taskContext).toEqual(updated.taskContext)
      expect(() => service.updateProject(project.id, { taskType: 'invented', expectedRevision: 2, idempotencyKey: 'invalid-task' })).toThrow()
      expect(() => service.updateProject(project.id, { taskType: 'gnss', expectedRevision: 1, idempotencyKey: 'stale-task' })).toThrow(/revision conflict/)
    } finally { service.close() }
  })
})
