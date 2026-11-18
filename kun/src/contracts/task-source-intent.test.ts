import { expect, it } from 'vitest'
import { browserTaskOrigins, isBrowserTask } from './browser-skill.js'
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

it('uses the public site as a source for the reported ordinary Video Shotcraft request', () => {
  const prompt = '使用Video ShotCraft技能，帮我做一个视频，介绍一下宁波睿威工程技术有限公司，相关信息你可去官网上查找。 www.railwise.cn'
  expect(requiresWebSourceEvidence(prompt)).toBe(true)
  expect(isBrowserTask(prompt)).toBe(false)
  expect(browserTaskOrigins(prompt)).toEqual([])
  expect(browserTaskOrigins(prompt, { includeBareWww: true })).toEqual(['https://www.railwise.cn'])
})

it('keeps explicit URL behavior and excludes host lookalikes from bare source targets', () => {
  const privateSource = new URL('https://www.private.test/')
  privateSource.username = 'fixture-user'
  privateSource.password = 'fixture-password'
  const prompt = `查阅 https://example.test/docs、 user@www.mail.test ${privateSource} ftp://www.ftp.test https://www.full.test/?redirect="www.other.test" （WWW.RAILWISE.CN）。`
  expect(browserTaskOrigins(prompt)).toEqual(['https://example.test', 'https://www.full.test'])
  expect(browserTaskOrigins(prompt, { includeBareWww: true })).toEqual(['https://example.test', 'https://www.full.test', 'https://www.railwise.cn'])
  expect(requiresWebSourceEvidence('查找 www.railwise.cn 的公开信息。')).toBe(true)
  expect(requiresWebSourceEvidence('制作本地 HTML 动画，不要去官网上查找资料。 www.railwise.cn')).toBe(false)
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

it.each([
  '读取我已订阅的大单网每天更新的招标列表 https://feed.example.test/#/subscribe/bidding，筛选工程测量、测绘、监测，汇总HTML。',
  '读取订阅列表 https://feed.example.test/，只整理列表摘要，不需要打开公告正文。',
  'Summarize the subscribed feed https://feed.example.test/ into an HTML digest.'
])('chooses a feed basis only for an explicit user subscription summary: %s', async prompt => {
  const { asksForObservedFeedSummary } = await import('./task-source-intent.js')
  expect(asksForObservedFeedSummary(prompt)).toBe(true)
  expect(requiresWebSourceEvidence(prompt)).toBe(true)
})

it.each([
  '读取招标列表 https://feed.example.test/ 并逐条打开公告正文，汇总HTML。',
  '读取已订阅招标列表 https://feed.example.test/ 并核验官方原文，汇总HTML。',
  '创建本地HTML模拟订阅列表，不需要联网读取网页。',
  '读取 https://gov.example.test/ 的招标公告正文，汇总HTML。'
])('does not lower primary or local contracts merely for list/summary words: %s', async prompt => {
  const { asksForObservedFeedSummary } = await import('./task-source-intent.js')
  expect(asksForObservedFeedSummary(prompt)).toBe(false)
})
