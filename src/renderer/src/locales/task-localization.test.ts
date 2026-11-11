import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInstance } from 'i18next'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { TaskRunStatusSchema, TaskNodeStatusSchema, TaskArtifactSchema } from '../../../../kun/src/contracts/tasks'
import { TASK_DELIVERY_TEMPLATES } from '../../../../kun/src/delivery/templates'
import en from './en/common.json'
import zh from './zh/common.json'

function taskLabelKeys(): string[] {
  const keys = new Set<string>()
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (/\.tsx?$/.test(path) && !/\.test\./.test(path)) {
        const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
        const collect = (expression: ts.Node): void => {
          if (ts.isStringLiteral(expression) && expression.text.startsWith('task')) keys.add(expression.text)
          else if (ts.isConditionalExpression(expression)) { collect(expression.whenTrue); collect(expression.whenFalse) }
        }
        const inspect = (node: ts.Node): void => {
          if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 't' && node.arguments[0]) collect(node.arguments[0])
          ts.forEachChild(node, inspect)
        }
        inspect(source)
      }
    }
  }
  visit(fileURLToPath(new URL('../', import.meta.url)))
  for (const status of TaskRunStatusSchema.options) keys.add(`taskRunStatus_${status}`)
  for (const status of TaskNodeStatusSchema.options) keys.add(`taskNodeStatus_${status}`)
  for (const status of TaskArtifactSchema.shape.validation.options) keys.add(`taskArtifactValidation_${status}`)
  for (const filter of ['ongoing', 'attention', 'completed', 'all']) keys.add(`taskWorkspaceFilter_${filter}`)
  for (const template of TASK_DELIVERY_TEMPLATES) {
    keys.add(`taskTemplate_${template.id}`)
    keys.add(`taskTemplateDescription_${template.id}`)
  }
  // Event kinds are extensible; the component supplies a translated default.
  keys.add('taskWorkspaceStatusUpdated')
  return [...keys]
}

describe('task surface translations', () => {
  it.each(['zh', 'en'] as const)('resolves every literal and dynamic task label in %s without a fallback language', async language => {
    const instance = createInstance()
    await instance.init({ lng: language, fallbackLng: false, resources: { zh: { common: zh }, en: { common: en } }, defaultNS: 'common' })
    const keys = taskLabelKeys()
    expect(keys.length).toBeGreaterThan(80)
    for (const key of keys) {
      expect(instance.exists(key), key).toBe(true)
      const label = instance.t(key, { count: 2, completed: 1, total: 3, at: '2026-11-10 18:00', model: 'synthetic-model' })
      expect(label, key).not.toBe(key)
      expect(label.trim(), key).not.toBe('')
      expect(label, key).not.toMatch(/\{\{/)
    }
    expect(instance.t('taskEvent_future_kind', { defaultValue: instance.t('taskWorkspaceStatusUpdated') })).toBe(language === 'zh' ? '任务状态已更新' : 'Task status updated')
  })
})
