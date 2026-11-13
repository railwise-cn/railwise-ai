import { createHash } from 'node:crypto'
import { scheduleForRequirement, type ScheduleRequirement } from '../contracts/schedule.js'
import type { BrowserScheduleAction } from '../contracts/browser-schedule-actions.js'
import { redactSecretText } from '../config/secret-redaction.js'

const HEADER = '确认浏览器操作'
const fields = ['站点', '动作', '目标', '输入内容', '输入摘要', '目标摘要', '请求摘要', '授权期限', '操作说明']
const actionScheduleFields = ['计划目的', '执行时刻', '时区', '浏览器', '账号状态', '授权版本']
const planFields = ['计划目的', '执行时刻', '时区', '读取路径', '写入路径', '站点', '网页动作', '浏览器', '账号状态', '授权期限', '操作说明', '授权版本']
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

/** Page HTML supplies a label only. Attribute values and field contents are never copied wholesale. */
export function browserApprovalSummary(input: {
  action: 'click' | 'fill' | 'press'; origin: string; targetHtml?: string; key?: string; value?: string;
  requestHash: string; expiresAt?: string; pageUrl?: string
  schedule?: { purpose: string; requirement: ScheduleRequirement; browserLabel: string; version: string }
}): string {
  const html = input.targetHtml ?? ''
  const tag = /^\s*<([a-z][\w-]*)/i.exec(html)?.[1] ?? '页面'
  const attribute = (name: string) => new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i').exec(html)?.[2] ?? ''
  const field = /^(?:input|textarea|select)$/i.test(tag)
  const label = attribute('aria-label') || attribute('placeholder') || (field ? attribute('name') || attribute('id') : html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim())
  const sensitive = /password|secret|token|api[-_]?key|验证码|密码|密钥|口令/i.test(
    [attribute('type'), attribute('name'), attribute('id'), attribute('autocomplete'), label].join(' '))
  const value = input.action === 'fill' ? input.value ?? '' : input.action === 'press' ? input.key ?? '' : ''
  const values = [input.origin, { click: '点击网页元素', fill: '填写网页输入框', press: '发送按键' }[input.action],
    `${tag}${label ? ` · ${label.slice(0, 500)}` : ''}`,
    sensitive ? `［敏感输入已隐藏，共 ${value.length} 个字符］` : value,
    digest(value), digest(html), input.requestHash, input.schedule ? '持续到计划停用或授权撤销' : input.expiresAt ?? '仅本次操作',
    input.expiresAt ? '仅在本任务内对同一站点、元素和输入复用授权。页面动作可能修改网站数据，执行后读取页面核验。'
      : '页面动作可能提交或修改网站数据。授权绑定本次实际目标和输入，执行后读取页面核验。']
  const names = [...fields]
  if (input.pageUrl) { names.push('页面摘要'); values.push(digest(input.pageUrl)) }
  if (input.schedule) {
    names.push(...actionScheduleFields)
    const execution = scheduleForRequirement(input.schedule.requirement) as { times: string[] }
    values.push(input.schedule.purpose, execution.times.join('、'), input.schedule.requirement.timezone, input.schedule.browserLabel,
      '未知；仅授权无需账号的公开查询，登录后的业务操作不在此范围。', input.schedule.version)
    values[8] = '持续授权仅覆盖这里列出的站点、真实元素和精确输入。每次周期执行重新核对范围并派生短授权，目标漂移或结果未知时停止执行。'
  }
  return [HEADER, ...names.map((name, index) => `${name} ${JSON.stringify(redactSecretText(values[index]!))}`)].join('\n')
}

export function sanitizeBrowserApprovalSummary(value: string): string | undefined {
  const lines = value.split('\n')
  const hasPageHash = lines.some(line => line.startsWith('页面摘要 '))
  const base = [...fields, ...(hasPageHash ? ['页面摘要'] : [])]
  const names = lines[0] === '确认周期浏览器权限' ? planFields : lines[0] === HEADER
    ? lines.length === base.length + 1 ? base : [...base, ...actionScheduleFields] : []
  if (value.length > 400_000 || !names.length || lines.length !== names.length + 1) return undefined
  const output = [lines[0]!]
  for (const [index, name] of names.entries()) {
    const prefix = `${name} `
    if (!lines[index + 1]?.startsWith(prefix)) return undefined
    let decoded: unknown
    try { decoded = JSON.parse(lines[index + 1]!.slice(prefix.length)) } catch { return undefined }
    if (typeof decoded !== 'string') return undefined
    if (['输入摘要', '目标摘要', '请求摘要', '页面摘要', '授权版本'].includes(name) && !/^[a-f0-9]{64}$/.test(decoded)) return undefined
    output.push(`${prefix}${JSON.stringify(redactSecretText(decoded))}`)
  }
  return output.join('\n')
}


export function browserScheduleApprovalSummary(input: {
  purpose: string; times: string[]; timezone: string; readPaths: readonly string[]; writePaths: readonly string[];
  origins: readonly string[]; browserLabel: string; actions: Array<Pick<BrowserScheduleAction, 'summary'>>; scopeHash: string
}): string {
  const actions = input.actions.map((action, index) => {
    const lines = action.summary.split('\n')
    const reviewed = ['站点', '动作', '目标', '输入内容'].map(name => {
      const prefix = `${name} `
      const value: unknown = JSON.parse(lines.find(line => line.startsWith(prefix))?.slice(prefix.length) ?? 'null')
      if (typeof value !== 'string') throw new Error('browser_schedule_review_invalid')
      return `${name} ${value}`
    })
    return `${index + 1}. ${reviewed.join('\n')}`
  }).join('\n\n')
  const values = [input.purpose, input.times.join('、'), input.timezone, input.readPaths.join('\n'), input.writePaths.join('\n'), input.origins.join('\n'),
    actions, input.browserLabel, '未知；仅包含无需账号的公开查询。', '持续到计划停用或原授权撤销',
    '每次执行核对原计划版本、浏览器与有限动作范围。元素、输入或站点变化需要重新审阅，结果未知时停止自动执行。', input.scopeHash]
  return ['确认周期浏览器权限', ...planFields.map((name, index) => `${name} ${JSON.stringify(redactSecretText(values[index]!))}`)].join('\n')
}
