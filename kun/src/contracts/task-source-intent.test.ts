import { expect, it } from 'vitest'
import { isBrowserTask } from './browser-skill.js'
import { isLocalHtmlCreativeRequest, requiresWebSourceEvidence, legacyLocalArtifactSourceMismatch, requiredLocalHtmlFileNames } from './task-source-intent.js'

it.each([
  '创建独立 HTML 文件，用 SVG 绘制鹈鹕骑车动画，所有素材内联，打开浏览器即可查看。',
  'Build a standalone HTML SVG animation and open it in Chrome to view the result.',
  '创建 HTML 监测图表，读取本地 CSV，浏览器打开查看。',
  '设计一个 HTML 天气页面原型，使用合成数据和本地 SVG 图标。',
  '创建HTML天气图表，读取本地CSV，不需要抓取网站，打开浏览器查看。'
])('treats local creation and its viewer separately from source collection: %s', prompt => {
  expect(isLocalHtmlCreativeRequest(prompt)).toBe(true)
  expect(requiresWebSourceEvidence(prompt)).toBe(false)
  expect(isBrowserTask(prompt)).toBe(false)
})

it.each([
  '先抓取 https://example.com/data 的网页正文，再创建一个 HTML/SVG 图表。',
  'Fetch https://example.com/news then create a standalone HTML SVG infographic.',
  '使用 BrowserSkill 搜索政采云和阳光采购平台公告，生成 HTML 报告。',
  '读取网站上的最新天气，再生成 HTML 动画。'
])('retains source evidence for mixed creation and external reading: %s', prompt => {
  expect(isLocalHtmlCreativeRequest(prompt)).toBe(false)
  expect(requiresWebSourceEvidence(prompt)).toBe(true)
})

it('keeps an explicit BrowserSkill connection request while not turning local rendering into source research', () => {
  const goal = '创建一个本地 HTML SVG 动画，使用 BrowserSkill 打开浏览器查看效果。'
  expect(isBrowserTask(goal)).toBe(true)
  expect(requiresWebSourceEvidence(goal)).toBe(false)
  expect(legacyLocalArtifactSourceMismatch({ goal, acceptance: { kind: 'files', requiresWebEvidence: true, requiredSourceOrigins: [], requiredFormats: ['html'] } })).toBe(true)
  expect(legacyLocalArtifactSourceMismatch({ goal, acceptance: { kind: 'files', requiresWebEvidence: true, sourceInferenceVersion: 1, requiredFormats: ['html'] } })).toBe(false)
  expect(legacyLocalArtifactSourceMismatch({ goal, acceptance: { kind: 'files', requiresWebEvidence: true, requiredFormats: ['html', 'htm', 'pdf'] } })).toBe(false)
  expect(legacyLocalArtifactSourceMismatch({ goal: '创建 HTML，并输出独立 SVG 文件。', acceptance: { kind: 'files', requiresWebEvidence: true, requiredFormats: ['html', 'htm'] } })).toBe(false)
  expect(requiredLocalHtmlFileNames('创建HTML，文件命名为 other.html。')).toEqual(['other.html'])
  expect(requiredLocalHtmlFileNames('Create HTML and save as "reports/view.html".')).toEqual(['reports/view.html'])
})
