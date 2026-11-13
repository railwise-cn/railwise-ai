import type { TaskScheduleService } from '../../services/task-schedule-service.js'
import type { CapabilityToolProvider } from './capability-registry.js'
import { defineLocalTool } from './local-tool-definition.js'

export function buildTaskScheduleToolProvider(service: () => TaskScheduleService): CapabilityToolProvider {
  return { id: 'task-schedule', kind: 'built-in', enabled: true, available: true, tools: [
    defineLocalTool({ name: 'schedule_task', description: '建立当前用户任务已要求的每日定时计划。沿用任务正文、工作区、Agent与已授权范围，支持每日多个时刻和时区。Create the requested recurring task, then call list_schedules to verify its saved times and nextRunAt.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }, policy: 'auto',
      shouldAdvertise: context => service().canCreate(context),
      execute: async (_args, context) => ({ output: { schedule: await service().create(context) } }) }),
    defineLocalTool({ name: 'list_schedules', description: '读回当前任务的已保存定时计划、每日执行时刻、时区和下一次执行时间。Read back saved recurring schedules and verify the requested daily times.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }, policy: 'auto',
      execute: async (_args, context) => ({ output: service().readback(context) }) })
  ] }
}
