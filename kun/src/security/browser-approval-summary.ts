import { createHash } from 'node:crypto'
import { redactSecretText } from '../config/secret-redaction.js'

const HEADER = '确认浏览器操作'
const fields = ['站点', '动作', '目标', '输入内容', '输入摘要', '目标摘要', '请求摘要', '授权期限', '操作说明']
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

/** Page HTML supplies a label only. Attribute values and field contents are never copied wholesale. */
export function browserApprovalSummary(input: {
  action: 'click' | 'fill' | 'press'; origin: string; targetHtml?: string; key?: string; value?: string;
  requestHash: string; expiresAt?: string
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
    digest(value), digest(html), input.requestHash, input.expiresAt ?? '仅本次操作',
    input.expiresAt ? '仅在本任务内对同一站点、元素和输入复用授权。页面动作可能修改网站数据，执行后读取页面核验。'
      : '页面动作可能提交或修改网站数据。授权绑定本次实际目标和输入，执行后读取页面核验。']
  return [HEADER, ...fields.map((name, index) => `${name} ${JSON.stringify(redactSecretText(values[index]!))}`)].join('\n')
}

export function sanitizeBrowserApprovalSummary(value: string): string | undefined {
  const lines = value.split('\n')
  if (value.length > 400_000 || lines.length !== fields.length + 1 || lines[0] !== HEADER) return undefined
  const output = [HEADER]
  for (const [index, name] of fields.entries()) {
    const prefix = `${name} `
    if (!lines[index + 1]?.startsWith(prefix)) return undefined
    let decoded: unknown
    try { decoded = JSON.parse(lines[index + 1]!.slice(prefix.length)) } catch { return undefined }
    if (typeof decoded !== 'string') return undefined
    if (['输入摘要', '目标摘要', '请求摘要'].includes(name) && !/^[a-f0-9]{64}$/.test(decoded)) return undefined
    output.push(`${prefix}${JSON.stringify(redactSecretText(decoded))}`)
  }
  return output.join('\n')
}
