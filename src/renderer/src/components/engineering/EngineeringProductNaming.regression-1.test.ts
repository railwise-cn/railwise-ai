import { describe, expect, it } from 'vitest'

// Regression: ISSUE-001 — the survey workspace mixed generic Engineering labels with the approved product name.
// Found by /qa on 2026-09-04
// Report: .gstack/qa-reports/qa-report-workwise-candidate-2026-09-04.md
describe('engineering survey product naming regression', () => {
  it('uses the approved workbench, agent, and project names in user-visible surfaces', async () => {
    const nodeFs = 'node:fs/promises'
    const { readFile } = await import(/* @vite-ignore */ nodeFs)
    const sources = await Promise.all([
      readFile(new URL('./EngineeringAiCommandCenter.tsx', import.meta.url), 'utf8'),
      readFile(new URL('./EngineeringWorkspaceView.tsx', import.meta.url), 'utf8'),
      readFile(new URL('./EngineeringSidebarContent.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../chat/Sidebar.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../../store/chat-store-thread-actions.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../locales/zh/common.json', import.meta.url), 'utf8')
    ])
    const source = sources.join('\n')
    const deprecatedNames = ['RAILWISE ' + 'SURVEYOR', '睿测' + '智算工作台']

    expect(source).toContain("t('engineeringWorkbenchTitle')")
    expect(source).toContain("t('engineeringWorkbenchSubtitle')")
    expect(source).toContain('engineeringAiTitle')
    expect(source).toContain('engineeringSession')
    expect(source).toContain('Survey AI · ${selectedProject.name}')
    expect(source).toContain("domain: 'engineering'")
    expect(source).toContain('engineeringAiAgent')
    expect(source).toContain('engineeringActionCreateProject')
    expect(source).toContain('"engineeringAiTitle": "Survey AI"')
    expect(source).toContain('"engineeringSession": "Survey AI 会话"')
    expect(source).toContain('"appName": "{{productName}}"')
    expect(source).toContain('"surveyProductName": "{{surveyName}}"')
    expect(source).toContain('"surveyProductSubtitle": "工程测量内业"')
    expect(source).toContain('"engineeringAiAgent": "测量 AI 助手"')
    expect(source).not.toContain('工程测量 AI 会话')
    expect(source).not.toContain('<h1 className="mr-auto text-[15px] font-semibold">WorkWise Survey</h1>')
    expect(source).not.toMatch(new RegExp([...deprecatedNames, '工程 AI 指挥台', '工程 Agent', '创建工程项目', '新建工程项目', '选择工程项目', '暂无工程项目'].join('|')))
  })
})
