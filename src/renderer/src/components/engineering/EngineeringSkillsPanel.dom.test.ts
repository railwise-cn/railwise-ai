// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import { EngineeringSkillsPanel } from './EngineeringSkillsPanel'

const request = vi.fn()
let root: Root
let container: HTMLDivElement

const response = (body: unknown, status = 200) => ({ ok: status < 400, status, body: JSON.stringify(body) })

beforeEach(async () => {
  vi.clearAllMocks()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  await i18n.changeLanguage('en')
  Object.assign(window, { workwise: { runtimeRequest: request } })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('EngineeringSkillsPanel professional presentation', () => {
  it('shows task-level capabilities without exposing packages, tools, sources or license metadata', async () => {
    request.mockImplementation(async (path: string) => path.includes('/capabilities')
      ? response({ capabilities: [{ id: 'survey-adjustment', label: 'Control network adjustment', category: 'survey', skillIds: ['rail-any-station-control-network'], toolIds: ['survey_adjustment'], available: true }] })
      : response({ skills: [{ id: 'rail-any-station-control-network', name: 'Control network adjustment', sourceRepository: 'internal-repository', commit: 'abc123def456', license: 'bundled-license', packaged: true, status: 'available' }] }))
    await act(async () => root.render(createElement(EngineeringSkillsPanel, { runtimeReady: true })))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(container.textContent).toContain('Surveying and adjustment')
    expect(container.textContent).toContain('Available')
    expect(container.textContent).not.toContain('rail-any-station-control-network')
    expect(container.textContent).not.toContain('survey_adjustment')
    expect(container.textContent).not.toContain('abc123def456')
    expect(container.textContent).not.toContain('bundled-license')
    expect(container.textContent).not.toContain('internal-repository')
    expect(container.textContent).not.toMatch(/license|skills and standards|skill sources|tools|operations count/i)
    expect(request.mock.calls.map(([path]) => path)).toEqual(['/v1/engineering/capabilities'])
  })

  it.each(['en', 'zh'])('localizes predefined capabilities and unavailable service responses in %s', async (language) => {
    await i18n.changeLanguage(language)
    const capabilities = [
      { id: 'survey-adjustment', label: '工程测量与平差', reason: 'survey runtime unavailable' },
      { id: 'third-party-monitoring', label: '地保与第三方监测', reason: 'engineering runtime unavailable' },
      { id: 'engineering-delivery', label: '测绘成果交付', reason: 'survey runtime unavailable' },
      { id: 'tender-master', label: '标书编制', reason: 'skill runtime unavailable' },
      { id: 'standards', label: '规范与知识库', reason: 'skill runtime unavailable' }
    ].map(item => ({ ...item, available: false }))
    request.mockResolvedValue(response({ capabilities }))
    await act(async () => root.render(createElement(EngineeringSkillsPanel, { runtimeReady: true })))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })

    expect([...container.querySelectorAll('h3')].map(heading => heading.textContent)).toEqual(language === 'zh'
      ? ['工程测量与平差', '地保与第三方监测', '测绘成果交付', '标书编制', '规范与知识库']
      : ['Surveying and adjustment', 'Third-party monitoring', 'Survey deliverables', 'Tender preparation', 'Standards and reference'])
    expect([...container.querySelectorAll('article p')].map(reason => reason.textContent)).toEqual([
      i18n.t('engineeringCapabilitySurveyUnavailable'), i18n.t('engineeringCapabilityMonitoringUnavailable'),
      i18n.t('engineeringCapabilitySurveyUnavailable'), i18n.t('engineeringCapabilityTemporarilyUnavailable'),
      i18n.t('engineeringCapabilityTemporarilyUnavailable')
    ])
    expect([...container.querySelectorAll('article > span')].map(status => status.textContent)).toEqual(Array(5).fill(i18n.t('engineeringRestricted')))
    expect(container.textContent).not.toMatch(/runtime|\bskill\b|survey unavailable|engineering unavailable/i)
    if (language === 'en') expect(container.textContent).not.toMatch(/[\u4e00-\u9fff]/)
    expect(request.mock.calls.map(([path]) => path)).toEqual(['/v1/engineering/capabilities'])
  })

  it.each(['en', 'zh'])('preserves professional restrictions and hides unknown failure details in %s', async (language) => {
    await i18n.changeLanguage(language)
    const professionalReason = language === 'zh'
      ? '已知高程点 BM_01 缺失，暂不能进行水准网平差。'
      : 'Leveling adjustment cannot continue without known elevation control point BM_01.'
    const networkRestriction = language === 'zh'
      ? '仅适用于平面控制网，请检查资料类型。'
      : 'Only plane control networks are supported. Check the source data type.'
    const formatRestriction = language === 'zh'
      ? 'COSA IN1 文件格式暂不支持自动转换。'
      : 'COSA IN1 format does not support automatic conversion.'
    request.mockResolvedValue(response({ capabilities: [
      { id: 'survey-adjustment', label: '工程测量与平差', available: false, reason: 'EACCES: /private/var/catalog.json\nat capability_lookup (runtime:22)' },
      { id: 'third-party-monitoring', label: '地保与第三方监测', available: false, reason: 'DatabaseError: survey_service_unavailable; contextHash=deadbeef; 15 mm' },
      { id: 'engineering-delivery', label: '测绘成果交付', available: false, reason: 'Unknown service failure' },
      { id: 'standards', label: '规范与知识库', available: false, reason: professionalReason },
      { id: 'plane-network', label: 'Plane control network', available: false, reason: networkRestriction },
      { id: 'format-conversion', label: 'COSA conversion', available: false, reason: formatRestriction }
    ] }))
    await act(async () => root.render(createElement(EngineeringSkillsPanel, { runtimeReady: true })))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })

    expect([...container.querySelectorAll('article p')].map(reason => reason.textContent)).toEqual([
      i18n.t('engineeringCapabilityTemporarilyUnavailable'), i18n.t('engineeringCapabilityTemporarilyUnavailable'),
      i18n.t('engineeringCapabilityTemporarilyUnavailable'), professionalReason, networkRestriction, formatRestriction
    ])
    expect(container.textContent).not.toMatch(/EACCES|\/private\/|catalog\.json|capability_lookup|runtime|DatabaseError|survey_service_unavailable|contextHash|deadbeef|Unknown service failure/)
  })

  it.each(['en', 'zh'])('shows a professional unavailable message when capability data is not readable in %s', async (language) => {
    await i18n.changeLanguage(language)
    request.mockImplementation(async (path: string) => path.includes('/capabilities')
      ? { ok: true, status: 200, body: '<!doctype html><html><body>service unavailable</body></html>' }
      : response({ skills: [] }))
    await act(async () => root.render(createElement(EngineeringSkillsPanel, { runtimeReady: true })))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })

    expect(container.textContent).toContain(i18n.t('engineeringSkillsUnavailable'))
    expect(container.textContent).not.toMatch(/skills catalog|技能目录|Unexpected token|not valid JSON|<!doctype html/i)
    expect(request.mock.calls.map(([path]) => path)).toEqual(['/v1/engineering/capabilities'])
  })
})
